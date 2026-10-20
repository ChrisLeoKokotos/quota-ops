// Generate a deterministic multi-resolution Windows ICO from pure Node.js.
// Avoid depending on graphics tools, external icon packs, or native modules.
// The existing small icon.ico remains unchanged and continues serving the tray.
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";

const SIZES = [16, 32, 48, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
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

function roundedSquareDistance(x, y, extent, radius) {
  const qx = Math.abs(x) - (extent - radius);
  const qy = Math.abs(y) - (extent - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    + Math.min(Math.max(qx, qy), 0) - radius;
}

function sample(x, y) {
  // Transparent outside a dark rounded square; high contrast QuotaOps "Q".
  const inside = roundedSquareDistance(x, y, 0.92, 0.19) <= 0;
  if (!inside) return [0, 0, 0, 0];

  const nx = x + 0.03;
  const ny = y + 0.045;
  const d = Math.hypot(nx, ny);
  const ring = d >= 0.33 && d <= 0.56;
  // Q's diagonal tail, joined to the lower-right arc.
  const tailStart = { x: 0.23, y: 0.23 };
  const tailEnd = { x: 0.59, y: 0.61 };
  const vx = tailEnd.x - tailStart.x;
  const vy = tailEnd.y - tailStart.y;
  const t = Math.min(1, Math.max(0,
    ((x - tailStart.x) * vx + (y - tailStart.y) * vy) / (vx * vx + vy * vy),
  ));
  const tail = Math.hypot(
    x - (tailStart.x + t * vx),
    y - (tailStart.y + t * vy),
  ) < 0.112;

  if (ring || tail) return [255, 121, 88, 255];
  return [17, 23, 34, 255];
}

function renderPng(size) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  const samples = [0.25, 0.75];
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    for (let x = 0; x < size; x++) {
      const rgba = [0, 0, 0, 0];
      for (const dy of samples) {
        for (const dx of samples) {
          const sx = ((x + dx) / size) * 2 - 1;
          const sy = ((y + dy) / size) * 2 - 1;
          const color = sample(sx, sy);
          for (let c = 0; c < 4; c++) rgba[c] += color[c] / 4;
        }
      }
      const pixel = row + 1 + x * 4;
      for (let c = 0; c < 4; c++) raw[pixel + c] = Math.round(rgba[c]);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8-bit per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createInstallerIconBuffer() {
  const pngs = SIZES.map(renderPng);
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const entry = 6 + i * 16;
    header[entry] = SIZES[i] === 256 ? 0 : SIZES[i];
    header[entry + 1] = SIZES[i] === 256 ? 0 : SIZES[i];
    header.writeUInt16LE(1, entry + 4); // 1 plane
    header.writeUInt16LE(32, entry + 6); // RGBA 32-bit
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

export async function generateInstallerIcon(filePath) {
  const icon = createInstallerIconBuffer();
  await writeFile(filePath, icon);
  return icon.length;
}
