import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

// These limits apply BEFORE JSON.parse, even when a line has no newline.
export const MAX_JSONL_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_JSONL_RECORDS_PER_FILE = 250_000;
const READ_CHUNK_BYTES = 64 * 1024;

export interface BoundedJsonlOptions {
  /**
   * Checked between chunks and between records so a caller can stop a scan
   * that has exhausted a time or aggregation budget. Returning true aborts
   * the file and reports it as incomplete.
   */
  shouldStop?: () => boolean;
}

/**
 * Read only bounded JSONL records. Callbacks receive parsed objects, never raw
 * file contents; parse failures and I/O errors are intentionally not logged.
 * A rejected file returns false so the caller can label results partial.
 */
export async function readBoundedJsonl(
  path: string,
  onRecord: (record: Record<string, unknown>) => void,
  options: BoundedJsonlOptions = {},
): Promise<boolean> {
  const shouldStop = options.shouldStop;
  let handle: FileHandle | null = null;
  try {
    if (shouldStop?.()) return false;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_JSONL_FILE_BYTES) return false;

    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: READ_CHUNK_BYTES,
    });
    let pieces: Buffer[] = [];
    let lineBytes = 0;
    let fileBytes = 0;
    let linesSeen = 0;

    const finishLine = (): boolean => {
      linesSeen += 1;
      if (linesSeen > MAX_JSONL_RECORDS_PER_FILE) return false;
      if (shouldStop?.()) return false;

      if (lineBytes > 0) {
        const line = Buffer.concat(pieces, lineBytes).toString("utf8").trim();
        if (line) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              onRecord(parsed as Record<string, unknown>);
            }
          } catch {
            // Malformed/incomplete records must never appear in diagnostics.
          }
        }
      }
      pieces = [];
      lineBytes = 0;
      return true;
    };

    try {
      for await (const chunk of stream) {
        if (shouldStop?.()) return false;
        fileBytes += chunk.length;
        if (fileBytes > MAX_JSONL_FILE_BYTES) return false;

        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          const length = end - offset;
          if (lineBytes + length > MAX_JSONL_LINE_BYTES) return false;
          if (length > 0) pieces.push(chunk.subarray(offset, end));
          lineBytes += length;

          if (newline === -1) break;
          if (!finishLine()) return false;
          offset = newline + 1;
        }
      }
      return lineBytes === 0 || finishLine();
    } finally {
      stream.destroy();
    }
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface JsonlIncrementOptions {
  /** Byte offset of a line start to resume from (0 = whole file). */
  startOffset?: number;
  /** Lines longer than this are skipped (not buffered), not fatal. */
  maxLineBytes?: number;
  shouldStop?: () => boolean;
  /** Receives at most the first 64 KiB of each skipped oversized line. */
  onOversizedLine?: (head: string) => void;
}

export interface JsonlIncrementResult {
  /** True when the file was read to its end without an error or a stop. */
  ok: boolean;
  /** Offset just after the last newline-terminated line that was processed. */
  endOffset: number;
  bytesRead: number;
}

const OVERSIZED_HEAD_BYTES = 64 * 1024;

/**
 * Incremental, bounded JSONL reading for large append-only histories.
 *
 * Unlike readBoundedJsonl, an oversized line (for example a pasted image) is
 * skipped instead of rejecting the whole file, without buffering more than
 * `maxLineBytes`; the caller decides from its head whether that matters.
 * Reading can resume at `endOffset` next time, so an appended session file is
 * not parsed again from the start. A final line without a newline is parsed
 * but not counted in `endOffset` (the writer may still be appending it).
 */
export async function readJsonlIncrement(
  path: string,
  onRecord: (record: Record<string, unknown>) => void,
  options: JsonlIncrementOptions = {},
): Promise<JsonlIncrementResult> {
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  const start = Math.max(0, options.startOffset ?? 0);
  let handle: FileHandle | null = null;
  let endOffset = start;
  let bytesRead = 0;
  try {
    if (options.shouldStop?.()) return { ok: false, endOffset, bytesRead };
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { ok: false, endOffset, bytesRead };
    if (start > metadata.size) return { ok: false, endOffset: start, bytesRead };
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: READ_CHUNK_BYTES, start });
    let pieces: Buffer[] = [];
    let lineBytes = 0;
    let skipping = false;
    let head = "";

    const emit = (): void => {
      if (skipping) {
        options.onOversizedLine?.(head);
      } else if (lineBytes > 0) {
        const line = Buffer.concat(pieces, lineBytes).toString("utf8").trim();
        if (line) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              onRecord(parsed as Record<string, unknown>);
            }
          } catch {
            // Malformed or incomplete records never appear in diagnostics.
          }
        }
      }
      pieces = [];
      lineBytes = 0;
      skipping = false;
      head = "";
    };

    try {
      for await (const chunk of stream) {
        if (options.shouldStop?.()) return { ok: false, endOffset, bytesRead };
        const buffer = chunk as Buffer;
        bytesRead += buffer.length;
        let offset = 0;
        while (offset < buffer.length) {
          const newline = buffer.indexOf(10, offset);
          const end = newline === -1 ? buffer.length : newline;
          const length = end - offset;
          if (!skipping && lineBytes + length > maxLineBytes) {
            // Keep only a bounded head for classification, drop the rest.
            head = Buffer.concat([...pieces, buffer.subarray(offset, end)])
              .subarray(0, OVERSIZED_HEAD_BYTES).toString("utf8");
            pieces = [];
            skipping = true;
          } else if (!skipping && length > 0) {
            pieces.push(buffer.subarray(offset, end));
          }
          lineBytes += length;
          if (newline === -1) break;
          emit();
          offset = newline + 1;
          endOffset = start + bytesRead - buffer.length + offset;
          if (options.shouldStop?.()) return { ok: false, endOffset, bytesRead };
        }
      }
      // Trailing line without newline: parse it, but resume before it.
      if (lineBytes > 0 && !skipping) emit();
      return { ok: true, endOffset, bytesRead };
    } finally {
      stream.destroy();
    }
  } catch {
    return { ok: false, endOffset, bytesRead };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
