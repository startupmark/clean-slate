// Builds the two zips the project ships, from extension/ as it stands.
//
// They are not interchangeable. The stores want manifest.json at the root of the
// archive; Load unpacked wants a folder to point at, so the other wraps
// everything in clean-slate/. Handing someone the wrong one fails in a way that
// looks like the extension is broken.
//
// Uses the tar.exe that ships with Windows and zip elsewhere, so there is
// no dependency. Run with `npm run package`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const version = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;

const OUT = process.argv[2] || path.join(ROOT, "dist");
fs.mkdirSync(OUT, { recursive: true });

// Anything here would be shipped to every user, so the list is explicit rather
// than an exclude list: a new file has to be named to travel.
const SHIP = [
  "manifest.json", "detection.json",
  "engine.js", "runtime.js", "content.js", "background.js",
  "popup.html", "popup.css", "popup.js",
  "options.html", "options.css", "options.js",
  "review.html", "review.js",
  "help.html", "privacy.html",
  "content.css", "fonts.css",
  "README.md",
  "fonts", "icons", "_locales"
];

// Two files the zip has to carry that live at the repository root rather than in
// extension/. GPL-3.0 asks for the licence text to travel with the work, and a
// zip is a distribution. Explicit for the same reason SHIP is: nothing else at
// the root gets in without being named here.
const SHIP_ROOT = ["LICENSE", "PRIVACY.md"];

const missing = [
  ...SHIP.filter((f) => !fs.existsSync(path.join(EXT, f))).map((f) => `extension/${f}`),
  ...SHIP_ROOT.filter((f) => !fs.existsSync(path.join(ROOT, f)))
];
if (missing.length) throw new Error(`missing from the package: ${missing.join(", ")}`);

// Anything in extension/ that is not on the list is a decision someone has to
// make, not something to quietly drop.
const unlisted = fs.readdirSync(EXT).filter((f) => !SHIP.includes(f));
if (unlisted.length) throw new Error(`extension/ has files not in the ship list: ${unlisted.join(", ")}`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "clean-slate-pkg-"));
const flat = path.join(stage, "flat");
const wrapped = path.join(stage, "wrapped", "clean-slate");
for (const dir of [flat, wrapped]) fs.mkdirSync(dir, { recursive: true });
for (const item of SHIP) {
  fs.cpSync(path.join(EXT, item), path.join(flat, item), { recursive: true });
  fs.cpSync(path.join(EXT, item), path.join(wrapped, item), { recursive: true });
}
for (const item of SHIP_ROOT) {
  fs.cpSync(path.join(ROOT, item), path.join(flat, item));
  fs.cpSync(path.join(ROOT, item), path.join(wrapped, item));
}

// Windows uses the bsdtar that ships in System32, not Compress-Archive: Windows
// PowerShell 5.1 writes entry names with backslashes, which unzip on macOS and
// Linux as flat files named "clean-slate\background.js" rather than a folder.
// The full path matters because a Git Bash PATH puts GNU tar first, and GNU tar
// cannot write a zip.
const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

const zip = (from, to) => {
  fs.rmSync(to, { force: true });
  if (os.platform() === "win32") {
    execFileSync(winTar, ["-a", "-cf", to, ...fs.readdirSync(from)], { cwd: from, stdio: "pipe" });
  } else {
    execFileSync("zip", ["-qr", to, "."], { cwd: from, stdio: "pipe" });
  }
};

// The zip format requires forward slashes. Checked on the built file, so a tool
// that gets it wrong fails the build instead of shipping. Names are read from the
// central directory rather than through a lister, because Windows tar -tf
// rewrites backslashes to slashes and reports a broken zip as clean.
const entries = (file) => {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${path.basename(file)} is not a zip`);
  const names = [];
  for (let at = buf.readUInt32LE(eocd + 16), n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const nameLength = buf.readUInt16LE(at + 28);
    names.push(buf.toString("utf8", at + 46, at + 46 + nameLength));
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return names;
};
const assertPortable = (file) => {
  const bad = entries(file).filter((name) => name.includes("\\"));
  if (bad.length) throw new Error(`${path.basename(file)} has backslash entry names: ${bad.slice(0, 3).join(", ")}`);
};

const store = path.join(OUT, `clean-slate-${version}-store.zip`);
const unpacked = path.join(OUT, `clean-slate-${version}.zip`);
zip(flat, store);                       // manifest.json at the root, for the stores
zip(path.join(stage, "wrapped"), unpacked); // wrapped in clean-slate/, for Load unpacked
for (const file of [store, unpacked]) assertPortable(file);

fs.rmSync(stage, { recursive: true, force: true });

for (const file of [store, unpacked]) {
  console.log(`  ${path.basename(file)}  ${Math.round(fs.statSync(file).size / 1024)}KB`);
}
console.log(`\nBuilt from extension/ at version ${version}, written to ${OUT}.`);
