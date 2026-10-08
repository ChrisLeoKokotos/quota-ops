import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

// These limits apply BEFORE JSON.parse, even when a line has no newline.
export const MAX_JSONL_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_JSONL_RECORDS_PER_FILE = 250_000;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read only bounded JSONL records. Callbacks receive parsed objects, never raw
 * file contents; parse failures and I/O errors are intentionally not logged.
 * A rejected file returns false so the caller can label results partial.
 */
export async function readBoundedJsonl(
  path: string,
  onRecord: (record: Record<string, unknown>) => void,
): Promise<boolean> {
  let handle: FileHandle | null = null;
  try {
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
