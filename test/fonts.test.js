// The bundled typefaces, and the promise they are allowed to exist under.
//
// Clean Slate makes zero network calls. That guarantee used to be checked in
// JavaScript only (config.test.js), which left CSS as a hole a reviewer had to
// cover by eye — and CSS is exactly where a webfont sneaks in, because
// `@import url(https://fonts.googleapis.com/...)` looks like styling rather
// than a request. Bundling the faces closes that gap only if nothing quietly
// re-points at a CDN later, so the check moves here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { EXTENSION_DIR } = require("./helpers.js");

const FONT_DIR = path.join(EXTENSION_DIR, "fonts");
const SHEETS = ["fonts.css", "content.css", "popup.css", "options.css"];
const PAGES = ["popup.html", "options.html"];

const read = (file) => fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
const manifest = () => JSON.parse(read("manifest.json"));

/** The extension-relative paths fonts.css points at, prefix stripped. */
const declaredFaces = () => [...read("fonts.css").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
  .map((m) => m[1].replace(EXTENSION_ID_PREFIX, ""));

// Chrome substitutes the extension's own id here. See the note in fonts.css for
// why the URLs cannot be relative.
const EXTENSION_ID_PREFIX = "chrome-extension://__MSG_@@extension_id__/";

// ---------- the guarantee ----------

test("no stylesheet fetches anything from the network", () => {
  // The one rule that makes bundling worth doing. Any absolute http(s) url() or
  // @import in a stylesheet is a request from inside linkedin.com.
  const offenders = [];
  for (const file of SHEETS) {
    for (const [index, line] of read(file).split("\n").entries()) {
      if (/url\(\s*["']?https?:/i.test(line) || /@import\s+(url\()?\s*["']?https?:/i.test(line)) {
        offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `stylesheet makes a network request:\n${offenders.join("\n")}`);
});

test("nothing references a font CDN at runtime", () => {
  // fonts/README.md documents how to re-cut the subsets and necessarily names
  // the CDN, so documentation is exempt and shipped code is not.
  const offenders = [];
  for (const file of [...SHEETS, ...PAGES, "manifest.json"]) {
    if (/fonts\.(googleapis|gstatic)\.com/.test(read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    `these ship with the extension and name a font CDN: ${offenders.join(", ")}`);
});

// ---------- what is bundled ----------

test("every face fonts.css declares is actually in the package", () => {
  const declared = declaredFaces();
  assert.ok(declared.length >= 3, "fonts.css declares fewer faces than there are families");
  for (const file of declared) {
    assert.ok(fs.existsSync(path.join(EXTENSION_DIR, file)), `fonts.css points at missing file: ${file}`);
  }
});

test("the font URLs are absolute, or the page answers instead of the extension", () => {
  // The bug this exists to stop, found on a real feed and invisible everywhere
  // else: a relative url() in a stylesheet injected by a content script resolves
  // against THE PAGE. Shipped that way, Chrome asked LinkedIn for
  // /feed/fonts/jost-latin.woff2, got its SPA HTML back with a 200, failed to
  // parse it as a font, and fell through to the fallback stacks in silence.
  //
  const source = read("fonts.css");
  const urls = [...source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  assert.ok(urls.length, "fonts.css declares no faces at all");
  for (const url of urls) {
    assert.ok(url.startsWith(EXTENSION_ID_PREFIX),
      `"${url}" is not an absolute extension URL — it will resolve against whatever page ` +
      `the content script is running on`);
  }

  // The substitution only happens when i18n is switched on.
  assert.equal(manifest().default_locale, "en",
    "manifest.json has no default_locale, so __MSG_@@extension_id__ is never substituted");
  assert.ok(fs.existsSync(path.join(EXTENSION_DIR, "_locales", "en", "messages.json")),
    "default_locale is declared but _locales/en/messages.json is missing, which fails to load the extension");
  assert.doesNotThrow(() => JSON.parse(read(path.join("_locales", "en", "messages.json"))),
    "_locales/en/messages.json is not valid JSON");
});

test("every bundled file is a real woff2 and is referenced", () => {
  const declared = new Set(declaredFaces().map((file) => path.basename(file)));

  const binaries = fs.readdirSync(FONT_DIR).filter((name) => name.endsWith(".woff2"));
  assert.ok(binaries.length, "no fonts are bundled, but fonts.css exists");

  for (const name of binaries) {
    // wOF2 — a truncated or half-downloaded file is otherwise silently invisible.
    const magic = fs.readFileSync(path.join(FONT_DIR, name)).subarray(0, 4).toString("latin1");
    assert.equal(magic, "wOF2", `fonts/${name} is not a woff2 file`);
    assert.ok(declared.has(name), `fonts/${name} ships but no @font-face uses it — dead weight`);
  }
});

test("the bundled faces stay small enough to be worth bundling", () => {
  // Not an arbitrary number: the decision to bundle was taken against a
  // 200–400KB estimate, and latin-only variable subsets came in far under it.
  // If a future re-cut ships whole families or every static weight, that is a
  // different decision and should be made deliberately, not discovered in a
  // store review.
  const total = fs.readdirSync(FONT_DIR)
    .filter((name) => name.endsWith(".woff2"))
    .reduce((sum, name) => sum + fs.statSync(path.join(FONT_DIR, name)).size, 0);
  assert.ok(total < 200 * 1024,
    `bundled fonts total ${Math.round(total / 1024)}KB — over the 200KB the bundling decision assumed`);
});

test("every bundled family carries its licence", () => {
  // OFL 1.1 requires the licence and its copyright notice travel with the files.
  const licences = fs.readdirSync(FONT_DIR).filter((name) => /^OFL-.*\.txt$/.test(name));
  assert.ok(licences.length, "no OFL text ships beside the fonts");

  const families = new Set([...read("fonts.css").matchAll(/font-family:\s*["']?([^;"']+)["']?\s*;/g)]
    .map((m) => m[1].trim().replace(/\s+/g, "")));
  for (const family of families) {
    assert.ok(licences.some((name) => name.toLowerCase().includes(family.toLowerCase())),
      `fonts.css declares ${family} but fonts/ has no OFL-${family}.txt`);
  }
  for (const name of licences) {
    const text = fs.readFileSync(path.join(FONT_DIR, name), "utf8");
    assert.match(text, /SIL Open Font License, Version 1\.1/, `fonts/${name} is not an OFL text`);
    assert.match(text, /^Copyright/m, `fonts/${name} carries no copyright notice`);
  }
});

// ---------- wiring ----------

test("the fonts are web-accessible, or LinkedIn's page cannot load them", () => {
  // A content script's CSS resolves url() against the extension origin, and MV3
  // blocks that origin's resources unless they are declared. Undeclared, the
  // faces silently never render and everything falls back — the exact failure
  // this whole change exists to remove, and invisible unless you look.
  const resources = manifest().web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(resources.some((pattern) => /^fonts\/.*woff2$/.test(pattern)),
    "manifest.json does not expose fonts/*.woff2 to the page");
});

test("the fonts are web-accessible to LinkedIn specifically", () => {
  // The check above reads entry.resources and never entry.matches. Pointing
  // matches at https://example.invalid/* left the suite green while Chrome
  // refused every font request on the real feed.
  const entry = manifest().web_accessible_resources
    .find((e) => e.resources.some((r) => /^fonts\/.*woff2$/.test(r)));
  assert.ok(entry, "no web-accessible resource entry exposes the fonts");
  assert.deepEqual(entry.matches, ["https://www.linkedin.com/*"],
    "the fonts are exposed to the wrong origin, so the page cannot load them");
});

test("every bundled family is actually named by a stack that uses it", () => {
  // The fallback test counts comma-separated entries and never checks what the
  // first one is. Deleting "Jost," from --cs-sans left the suite green while all
  // three faces fell through to system stacks and the subsets shipped as dead
  // weight — the same shape as the bug that hid broken fonts for weeks.
  const declared = [...read("fonts.css").matchAll(/font-family:\s*([^;]+);/g)]
    .map(([, value]) => value.trim().replace(/^["']|["']$/g, ""));
  assert.ok(declared.length >= 3, "fonts.css no longer declares three families");

  for (const file of ["content.css", "popup.css", "options.css"]) {
    const source = read(file);
    for (const family of declared) {
      assert.ok(source.includes(family),
        `${file} never names ${family}, so the bundled face is never asked for`);
    }
  }
});

test("fonts.css loads before the sheet that uses the families", () => {
  const css = manifest().content_scripts[0].css;
  assert.ok(css.includes("fonts.css"), "the content script never loads fonts.css");
  assert.ok(css.indexOf("fonts.css") < css.indexOf("content.css"),
    "fonts.css must be listed before content.css");

  for (const page of PAGES) {
    const html = read(page);
    const own = page.replace(".html", ".css");
    assert.ok(html.includes('href="fonts.css"'), `${page} does not link fonts.css`);
    assert.ok(html.indexOf('href="fonts.css"') < html.indexOf(`href="${own}"`),
      `${page} links fonts.css after ${own}`);
  }
});

test("the stacks that use these families still declare a fallback", () => {
  // The bundled subsets are latin/latin-ext. Anything outside them — a CJK
  // author name, an emoji in a heading — falls through per glyph, and only if
  // the stack still has somewhere to fall.
  for (const file of ["content.css", "popup.css", "options.css"]) {
    const source = read(file);
    for (const token of ["sans", "serif", "mono"]) {
      const match = source.match(new RegExp(`--(?:cs-)?${token}\\s*:([^;]+);`));
      assert.ok(match, `${file} no longer defines a --${token} stack`);
      assert.ok(match[1].split(",").length >= 2,
        `${file}: --${token} is a single family with no fallback: ${match[1].trim()}`);
    }
  }
});
