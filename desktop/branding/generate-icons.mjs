// Generate the Windows branding assets from the approved QuotaOps logo.
//
// Pure Node: `zlib` is the only dependency. The repository pins four
// production packages and sets `ignore-scripts=true` in `.npmrc`, so pulling
// in a native image library for a build step would widen the supply chain
// for no functional gain.
//
// The source of truth is `logo.png` in the repository root. It is read, never
// written. Everything under `desktop/branding/` is derived and reproducible:
// running this twice produces byte-identical output.
//
//   node desktop/branding/generate-icons.mjs

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Sizes Windows actually asks for: Explorer, taskbar, dialogs, tiles. */
const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** The tray draws at 16 and scales from there on high-DPI displays. */
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48];

// --- PNG decoding -----------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const kind = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  kind.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([kind, data])), 8 + data.length);
  return result;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a non-interlaced 8-bit PNG to straight RGBA.
 *
 * Only the colour types the source actually uses are supported, and anything
 * else throws rather than silently producing wrong pixels: a branding asset
 * that is quietly mangled is worse than a build that stops.
 */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }

  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (!header) throw new Error("PNG has no IHDR");
  if (header.interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${header.bitDepth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);
  if (header.colorType === 3 && !palette) throw new Error("palette PNG has no PLTE");

  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Each row is prefixed with its filter type.
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const source = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const target = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? target[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      const value = source[x];

      switch (filter) {
        case 0: target[x] = value; break;
        case 1: target[x] = (value + left) & 0xff; break;
        case 2: target[x] = (value + up) & 0xff; break;
        case 3: target[x] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: target[x] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
    }
  }

  // Expand whatever colour type the file used into straight RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels;
    const target = i * 4;

    if (header.colorType === 6) {
      pixels.copy(rgba, target, source, source + 4);
    } else if (header.colorType === 2) {
      pixels.copy(rgba, target, source, source + 3);
      rgba[target + 3] = 255;
    } else if (header.colorType === 0) {
      rgba.fill(pixels[source], target, target + 3);
      rgba[target + 3] = 255;
    } else if (header.colorType === 4) {
      rgba.fill(pixels[source], target, target + 3);
      rgba[target + 3] = pixels[source + 1];
    } else {
      const index = pixels[source];
      palette.copy(rgba, target, index * 3, index * 3 + 3);
      rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }

  return { width, height, rgba };
}

// --- resampling -------------------------------------------------------------

/**
 * Area-average downscale, done in premultiplied alpha.
 *
 * Averaging straight RGBA bleeds the colour of fully transparent pixels into
 * the edges, which shows up as a dark halo around a logo with a transparent
 * background. Premultiplying first and dividing back out afterwards avoids
 * that.
 */
function resize(source, sourceWidth, sourceHeight, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * scaleY));

    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < Math.min(y1, sourceHeight); sy += 1) {
        for (let sx = x0; sx < Math.min(x1, sourceWidth); sx += 1) {
          const index = (sy * sourceWidth + sx) * 4;
          const alpha = source[index + 3] / 255;
          r += source[index] * alpha;
          g += source[index + 1] * alpha;
          b += source[index + 2] * alpha;
          a += source[index + 3];
          count += 1;
        }
      }

      const target = (y * width + x) * 4;
      const averageAlpha = a / count;
      const unpremultiply = averageAlpha === 0 ? 0 : 255 / averageAlpha;

      out[target] = Math.min(255, Math.round((r / count) * unpremultiply));
      out[target + 1] = Math.min(255, Math.round((g / count) * unpremultiply));
      out[target + 2] = Math.min(255, Math.round((b / count) * unpremultiply));
      out[target + 3] = Math.round(averageAlpha);
    }
  }

  return out;
}

/**
 * Crops to the visible artwork.
 *
 * At 16x16 every pixel counts, and a logo exported with transparent margin
 * spends several of them on nothing. Cropping to the opaque bounding box
 * keeps the design intact while giving the mark more room — which is a
 * different thing from drawing a simplified glyph.
 */
function cropToContent(rgba, width, height, alphaThreshold = 8) {
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > alphaThreshold) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (right < 0) return { rgba, width, height };

  // Keep it square so the aspect ratio survives the later resize.
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const side = Math.max(cropWidth, cropHeight);
  const originX = Math.round(left - (side - cropWidth) / 2);
  const originY = Math.round(top - (side - cropHeight) / 2);

  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const sx = originX + x;
      const sy = originY + y;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      rgba.copy(out, (y * side + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
    }
  }

  return { rgba: out, width: side, height: side };
}

// --- encoding ---------------------------------------------------------------

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none, so output stays deterministic
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Windows reads 0 in the size byte as 256; anything larger has no encoding. */
function encodeIco(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(frames.length, 4);

  let offset = directory.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    directory[entry] = frame.size >= 256 ? 0 : frame.size;
    directory[entry + 1] = frame.size >= 256 ? 0 : frame.size;
    directory[entry + 2] = 0; // palette colours
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(frame.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([directory, ...frames.map((frame) => frame.data)]);
}

// --- generation -------------------------------------------------------------

export async function generateBrandingAssets({ sourcePath, outputDir } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "..", "..");
  const source = sourcePath ?? join(repo, "logo.png");
  const target = outputDir ?? here;

  const original = decodePng(await readFile(source));
  const cropped = cropToContent(original.rgba, original.width, original.height);

  await mkdir(target, { recursive: true });

  const frame = (sizes, image) =>
    sizes.map((size) => ({
      size,
      data: encodePng(
        resize(image.rgba, image.width, image.height, size, size),
        size,
        size,
      ),
    }));

  // The app icon keeps the original framing, including its margin, because
  // that is how the logo was approved.
  const appFrames = frame(APP_ICON_SIZES, original);
  // The tray icon is cropped: at 16x16 the margin costs legibility.
  const trayFrames = frame(TRAY_ICON_SIZES, cropped);

  const pngSize = 256;
  const appPng = encodePng(
    resize(original.rgba, original.width, original.height, pngSize, pngSize),
    pngSize,
    pngSize,
  );
  const appIco = encodeIco(appFrames);
  const trayIco = encodeIco(trayFrames);

  const written = [
    ["quotaops-icon.png", appPng],
    ["quotaops-icon.ico", appIco],
    ["quotaops-tray.ico", trayIco],
  ];

  for (const [name, data] of written) {
    await writeFile(join(target, name), data);
  }

  return {
    source: {
      path: source,
      width: original.width,
      height: original.height,
      sha256: createHash("sha256").update(await readFile(source)).digest("hex"),
    },
    assets: written.map(([name, data]) => ({
      name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    })),
    appIconSizes: APP_ICON_SIZES,
    trayIconSizes: TRAY_ICON_SIZES,
  };
}

export { cropToContent, decodePng, encodeIco, encodePng, resize };

// `file://${argv[1]}` never matches on Windows: argv carries a drive-letter
// path while import.meta.url has three slashes. Compare resolved URLs.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = await generateBrandingAssets();
  process.stdout.write(
    `[branding] source ${result.source.width}x${result.source.height} ` +
      `sha256:${result.source.sha256.slice(0, 12)}\n`,
  );
  for (const asset of result.assets) {
    process.stdout.write(
      `[branding] ${asset.name.padEnd(22)} ${String(asset.bytes).padStart(7)} bytes  ` +
        `sha256:${asset.sha256.slice(0, 12)}\n`,
    );
  }
}
