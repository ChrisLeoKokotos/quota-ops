import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cropToContent,
  decodePng,
  encodeIco,
  encodePng,
  generateBrandingAssets,
  resize,
} from "../desktop/branding/generate-icons.mjs";

const repo = new URL("..", import.meta.url);

/** Parses an ICO directory without trusting the generator that wrote it. */
function readIcoFrames(buffer: Buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, "ICO reserved field must be 0");
  assert.equal(buffer.readUInt16LE(2), 1, "type must be 1 (icon, not cursor)");

  const count = buffer.readUInt16LE(4);
  const frames = [];

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const declared = buffer[entry] === 0 ? 256 : buffer[entry];
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    const data = buffer.subarray(offset, offset + length);
    const isPng = data.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    frames.push({
      declared,
      bitsPerPixel: buffer.readUInt16LE(entry + 6),
      length,
      isPng,
      actualWidth: isPng ? data.readUInt32BE(16) : 0,
      actualHeight: isPng ? data.readUInt32BE(20) : 0,
      data,
    });
  }

  return frames;
}

test("the application icon carries the sizes Windows asks for", async () => {
  const frames = readIcoFrames(
    await readFile(new URL("desktop/branding/quotaops-icon.ico", repo)),
  );
  const sizes = frames.map((frame) => frame.declared);

  for (const required of [16, 32, 48, 256]) {
    assert.equal(sizes.includes(required), true, `missing the ${required}px frame`);
  }
});

test("every frame's declared size matches its actual image", async () => {
  // A directory entry that lies about its size is the classic way an ICO
  // renders as a blank square: Windows picks a frame by the declared value.
  for (const name of ["quotaops-icon.ico", "quotaops-tray.ico"]) {
    const frames = readIcoFrames(await readFile(new URL(`desktop/branding/${name}`, repo)));

    for (const frame of frames) {
      assert.equal(frame.isPng, true, `${name}: frame ${frame.declared} is not a PNG`);
      assert.equal(frame.bitsPerPixel, 32, `${name}: frame ${frame.declared} is not 32bpp`);
      assert.equal(
        frame.actualWidth,
        frame.declared,
        `${name}: frame declares ${frame.declared} but the image is ${frame.actualWidth}`,
      );
      assert.equal(frame.actualHeight, frame.declared);
      assert.equal(frame.length > 0, true, `${name}: frame ${frame.declared} is empty`);
    }
  }
});

test("the 256px frame declares 0, which is how Windows encodes 256", async () => {
  const buffer = await readFile(new URL("desktop/branding/quotaops-icon.ico", repo));
  const count = buffer.readUInt16LE(4);
  const large = [];

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (buffer[entry] === 0) large.push(index);
  }

  assert.equal(large.length, 1, "exactly one frame should use the 256 encoding");
});

test("the icons come from the approved logo, not the synthetic placeholder", async () => {
  // The earlier build drew a flat rounded square with two colours. The real
  // logo is a photographic-style gradient, so a colour count far above a
  // handful is the signal that the right source was used.
  const frames = readIcoFrames(
    await readFile(new URL("desktop/branding/quotaops-icon.ico", repo)),
  );
  const large = frames.find((frame) => frame.declared === 256);
  assert.notEqual(large, undefined);

  const { rgba, width, height } = decodePng(large!.data);
  const colours = new Set<string>();
  let opaque = 0;

  for (let i = 0; i < width * height; i += 1) {
    const alpha = rgba[i * 4 + 3] ?? 0;
    if (alpha > 8) {
      opaque += 1;
      colours.add(`${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]}`);
    }
  }

  assert.equal(
    colours.size > 500,
    true,
    `expected a gradient-rich logo, saw only ${colours.size} distinct colours`,
  );
  assert.equal(opaque > 0, true, "the icon is fully transparent");
  assert.equal(
    opaque < width * height,
    true,
    "the icon has no transparent background at all",
  );
});

test("transparency survives the resize without a dark halo", async () => {
  // Averaging straight RGBA bleeds the colour of fully transparent pixels
  // into the edge. Premultiplied averaging avoids it; this pins the result.
  const size = 64;
  const source = Buffer.alloc(size * size * 4);

  // A white opaque disc on transparent black: the classic halo trigger.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const inside = Math.hypot(x - size / 2, y - size / 2) < size / 3;
      if (inside) {
        source[index] = 255;
        source[index + 1] = 255;
        source[index + 2] = 255;
        source[index + 3] = 255;
      }
    }
  }

  const small = resize(source, size, size, 16, 16);
  let darkEdge = 0;

  for (let i = 0; i < 16 * 16; i += 1) {
    const alpha = small[i * 4 + 3] ?? 0;
    // A partly transparent edge pixel should still be white, not grey.
    if (alpha > 16 && alpha < 240 && (small[i * 4] ?? 0) < 200) darkEdge += 1;
  }

  assert.equal(darkEdge, 0, `${darkEdge} edge pixel(s) darkened by alpha bleed`);
});

test("the tray icon is cropped tighter than the application icon", async () => {
  // At 16x16 the logo's transparent margin costs legibility, so the tray
  // build crops to the artwork. If both were identical the crop silently
  // stopped working.
  const coverage = async (name: string) => {
    const frames = readIcoFrames(await readFile(new URL(`desktop/branding/${name}`, repo)));
    const frame = frames.find((item) => item.declared === 48);
    assert.notEqual(frame, undefined, `${name} has no 48px frame`);

    const { rgba, width, height } = decodePng(frame!.data);
    let opaque = 0;
    for (let i = 0; i < width * height; i += 1) {
      if ((rgba[i * 4 + 3] ?? 0) > 8) opaque += 1;
    }
    return opaque / (width * height);
  };

  const app = await coverage("quotaops-icon.ico");
  const tray = await coverage("quotaops-tray.ico");

  assert.equal(
    tray > app,
    true,
    `the tray icon should fill more of its frame: tray ${tray.toFixed(3)} vs app ${app.toFixed(3)}`,
  );
});

test("cropping keeps the image square so the aspect ratio survives", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);

  // A wide opaque band, off-centre.
  for (let y = 10; y < 18; y += 1) {
    for (let x = 4; x < 36; x += 1) {
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }

  const cropped = cropToContent(rgba, width, height);

  assert.equal(cropped.width, cropped.height, "the crop must stay square");
  assert.equal(cropped.width, 32, "the crop should match the wider dimension");
});

test("a fully transparent image is returned unchanged rather than collapsing", () => {
  const rgba = Buffer.alloc(8 * 8 * 4);
  const cropped = cropToContent(rgba, 8, 8);

  assert.equal(cropped.width, 8);
  assert.equal(cropped.height, 8);
});

test("the PNG decoder round-trips what the encoder writes", () => {
  const width = 7;
  const height = 5;
  const original = Buffer.alloc(width * height * 4);
  for (let i = 0; i < original.length; i += 1) original[i] = (i * 37) % 256;

  const decoded = decodePng(encodePng(original, width, height));

  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(decoded.rgba, original);
});

test("the decoder refuses formats it cannot read rather than guessing", () => {
  assert.throws(() => decodePng(Buffer.alloc(32)), /not a PNG/);

  // A 16-bit PNG would decode to wrong pixels if waved through.
  const png = encodePng(Buffer.alloc(4), 1, 1);
  const tampered = Buffer.from(png);
  tampered[24] = 16; // bit depth
  assert.throws(() => decodePng(tampered), /unsupported bit depth/);
});

test("generation is deterministic and leaves the source logo untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-branding-"));
  const logo = new URL("logo.png", repo);
  const before = createHash("sha256").update(await readFile(logo)).digest("hex");

  try {
    const first = await generateBrandingAssets({ outputDir: directory });
    const second = await generateBrandingAssets({ outputDir: directory });

    assert.deepEqual(
      first.assets.map((asset: { sha256: string }) => asset.sha256),
      second.assets.map((asset: { sha256: string }) => asset.sha256),
      "two runs produced different bytes",
    );

    const after = createHash("sha256").update(await readFile(logo)).digest("hex");
    assert.equal(after, before, "the source logo was modified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the committed assets match what the generator produces now", async () => {
  // Catches a hand-edited asset, or a committed file left behind after the
  // generator changed.
  const directory = await mkdtemp(join(tmpdir(), "quotaops-branding-"));

  try {
    const result = await generateBrandingAssets({ outputDir: directory });

    for (const asset of result.assets) {
      const committed = await readFile(new URL(`desktop/branding/${asset.name}`, repo));
      assert.equal(
        createHash("sha256").update(committed).digest("hex"),
        asset.sha256,
        `${asset.name} differs from generator output; re-run the generator`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no credential or user path is packaged into an icon", async () => {
  for (const name of ["quotaops-icon.png", "quotaops-icon.ico", "quotaops-tray.ico"]) {
    const data = await readFile(new URL(`desktop/branding/${name}`, repo));
    const text = data.toString("latin1");

    for (const forbidden of ["C:\\Users", "collector.token", "Bearer", ".quotaops"]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `${name} contains ${forbidden}`,
      );
    }
  }
});

test("an ICO directory entry points at real data", () => {
  const frame = { size: 16, data: encodePng(Buffer.alloc(16 * 16 * 4), 16, 16) };
  const ico = encodeIco([frame]);

  const offset = ico.readUInt32LE(6 + 12);
  const length = ico.readUInt32LE(6 + 8);

  assert.equal(offset, 6 + 16, "the first frame must follow the directory");
  assert.equal(length, frame.data.length);
  assert.deepEqual(ico.subarray(offset, offset + length), frame.data);
});

test("the executable icon limitation stays visible in the build output", async () => {
  // The installer, uninstaller, window and tray are branded; QuotaOps.exe is
  // not, because `signAndEditExecutable: false` skips resource editing and
  // enabling it fails extracting winCodeSign's macOS dylib symlinks without
  // administrator rights. Measured: the packaged executable's icon is
  // byte-identical to stock electron.exe.
  //
  // This pins the warning so the gap cannot quietly become "done".
  const script = await readFile(new URL("desktop/build-installer.mjs", repo), "utf8");

  assert.match(script, /QuotaOps\.exe does NOT/);
  assert.match(script, /winCodeSign/);
  assert.match(script, /shortcuts/i);
});

test("the shipped app resolves its icons from the packaged layout first", async () => {
  // electron-builder flattens the app directory, so a packaged build finds
  // the icons beside main.js. Checking only the repository path would pass in
  // development and ship an unbranded window.
  const main = await readFile(new URL("desktop/electron-ipc/main.js", repo), "utf8");

  assert.match(main, /function brandingAsset/);
  assert.match(main, /path\.join\(__dirname, name\)/);
  assert.match(main, /quotaops-icon\.ico/);
  assert.match(main, /quotaops-tray\.ico/);
  // The window icon drives the taskbar button; without it both fall back.
  assert.match(main, /icon: APP_ICON/);
});
