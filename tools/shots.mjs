// Renders every image the repository ships, from the HTML sources in
// assets/sources, using the Chrome already on this machine.
//
// No dependency and no browser download. Chrome's own --screenshot writes the
// viewport at exactly --window-size, so the store images come out the size the
// store demands rather than whatever a hand-cropped screenshot happened to be.
//
// Set CHROME to override the binary. Run with `npm run shots`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = path.join(ROOT, "assets", "sources");
const OUT = path.join(ROOT, "assets");

// scale is the CSS transform inside the page; dpr is the device pixel ratio, so
// the README image is rendered at 2x for a screen that can show it.
const SHOTS = [
  {
    name: "screenshot.png",
    page: "feed.html", query: "w=1200&h=810&scale=1",
    width: 1200, height: 810, dpr: 2
  },
  {
    // The Chrome Web Store takes 1280x800 or 640x400. Nothing else. The shot is
    // scaled to fill the frame rather than sit in the middle of it: stores
    // display it at roughly 525px wide, and every pixel spent on margin is a
    // control label the reader cannot make out.
    name: "store-1280x800.png",
    page: "feed.html", query: "w=1280&h=800&scale=1.07",
    width: 1280, height: 800, dpr: 1
  },
  {
    name: "promo-440x280.png",
    page: "promo.html", query: "size=small",
    width: 440, height: 280, dpr: 1
  },
  {
    // Edge requires a store logo at exactly this size. Chrome uses the 128px
    // icon from the package instead and has no equivalent field.
    name: "store-logo-300x300.png",
    page: "promo.html", query: "size=logo",
    width: 300, height: 300, dpr: 1
  },
  {
    name: "promo-1400x560.png",
    page: "promo.html", query: "size=marquee",
    width: 1400, height: 560, dpr: 1
  }
];

const CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
};

function findChrome() {
  if (process.env.CHROME) {
    if (!fs.existsSync(process.env.CHROME)) throw new Error(`CHROME is set to ${process.env.CHROME}, which does not exist`);
    return process.env.CHROME;
  }
  const found = (CANDIDATES[os.platform()] || []).find((p) => fs.existsSync(p));
  if (found) return found;
  throw new Error("No Chrome or Edge found. Set CHROME to the browser binary.");
}

// PNG header: an 8-byte signature, then IHDR with width, height and colour type.
// Colour type 6 is RGBA, 2 is RGB.
function readHeader(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] };
}

// The store rejects an alpha channel outright, and Chrome writes RGBA. Rewriting
// the pixels here keeps the whole pipeline dependency-free: node:zlib already
// does the only hard part.
function stripAlpha(file) {
  const buf = fs.readFileSync(file);
  const chunks = [];
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type !== "IEND") chunks.push({ type, data });
    at += length + 12;
  }
  if (!ihdr) throw new Error(`${file} has no IHDR`);
  if (ihdr[9] !== 6) return false; // already free of an alpha channel

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Each row is one filter byte then the pixels. Chrome writes filter 0, and
  // anything else would need the full reconstruction, so refuse rather than
  // silently produce a corrupt image.
  const inStride = 1 + width * 4;
  const outStride = 1 + width * 3;
  const out = Buffer.alloc(height * outStride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * inStride];
    if (filter !== 0) throw new Error(`${file} row ${y} uses PNG filter ${filter}; this only handles unfiltered rows`);
    out[y * outStride] = 0;
    for (let x = 0; x < width; x++) {
      const from = y * inStride + 1 + x * 4;
      const to = y * outStride + 1 + x * 3;
      out[to] = raw[from];
      out[to + 1] = raw[from + 1];
      out[to + 2] = raw[from + 2];
    }
  }

  ihdr[9] = 2; // RGB
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
    return Buffer.concat([head, data, tail]);
  };

  fs.writeFileSync(file, Buffer.concat([
    buf.subarray(0, 8),
    chunk("IHDR", ihdr),
    ...chunks.map((c) => chunk(c.type, c.data)),
    chunk("IDAT", zlib.deflateSync(out, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]));
  return true;
}

const chrome = findChrome();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clean-slate-shots-"));
console.log(`Rendering with ${chrome}\n`);

let failed = 0;
for (const shot of SHOTS) {
  const out = path.join(OUT, shot.name);
  const url = `${pathToFileURL(path.join(SOURCES, shot.page)).href}?${shot.query}`;
  execFileSync(chrome, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    // Without this the page is composited onto transparency and every margin
    // arrives with an alpha of zero.
    "--default-background-color=ffffffff",
    `--force-device-scale-factor=${shot.dpr}`,
    `--window-size=${shot.width},${shot.height}`,
    `--user-data-dir=${profile}`,
    `--screenshot=${out}`,
    url
  ], { stdio: "pipe" });

  const stripped = stripAlpha(out);
  const header = readHeader(out);
  const want = { width: shot.width * shot.dpr, height: shot.height * shot.dpr };

  // The point of the script. A hand-taken screenshot was the wrong size more
  // than once, and the store only says so at upload.
  if (header.width !== want.width || header.height !== want.height) {
    console.error(`  FAIL ${shot.name}: ${header.width}x${header.height}, expected ${want.width}x${want.height}`);
    failed++;
    continue;
  }
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`  ${shot.name}  ${header.width}x${header.height}  ${kb}KB${stripped ? "  (alpha removed)" : ""}`);
}

fs.rmSync(profile, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nAll images written to assets/.");
