// Colour contrast, computed rather than asserted by eye.
//
// The extension paints over someone else's page in two themes, so a palette
// regression is invisible in the theme you happen to be looking at. These tests
// do the WCAG arithmetic on the tokens as they are actually declared, in every
// palette block of all three stylesheets.
//
// The rule this file exists to hold: --quiet is NOT a text tier. It is the
// lowest rung of the ramp and it fails AA in light mode (2.78:1 on paper).
// There is no darker value that fixes it — clearing 4.5:1 lands ~1.11:1 from
// --slate, i.e. the rung stops being distinguishable at all. So quiet is
// restricted to non-text (today: the "maybe" dot), and receding TEXT uses
// --slate. A `color:var(--quiet)` is the regression; this catches it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { EXTENSION_DIR } = require("./helpers.js");

const SHEETS = ["content.css", "popup.css", "options.css"];
const read = (file) => fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------- WCAG 2.1 relative luminance ----------

function channels(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every palette block in a stylesheet, as { name -> hex } maps.
 *
 * A palette block is any rule that defines --paper: there is one per theme
 * (light :root, LinkedIn's explicit dark attribute, the prefers-color-scheme
 * fallback), and finding them by content rather than by selector means a new
 * theme block is covered the day it is added instead of being silently skipped.
 */
function palettes(file) {
  const css = stripComments(read(file));
  const found = [];
  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, selector, body] = rule;
    if (!/--(cs-)?paper\s*:/.test(body)) continue;
    const tokens = {};
    for (const decl of body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*(?:;|$)/g)) {
      tokens[decl[1].replace(/^cs-/, "")] = decl[2];
    }
    found.push({ selector: selector.trim().split("\n").pop().trim(), tokens });
  }
  return found;
}

// ---------- the ramp ----------

// Everything the stylesheets are allowed to paint text with, against every
// ground they can sit on. 4.5:1 is the AA floor for body text; the extension's
// small labels (11px) are body text by any reading, so nothing gets the 3:1
// large-text allowance.
const TEXT_TOKENS = ["ink", "ink-soft", "slate"];
const GROUNDS = ["paper", "surface"];
const AA = 4.5;

test("every palette block declares the ramp the stylesheets use", () => {
  for (const file of SHEETS) {
    const blocks = palettes(file);
    assert.ok(blocks.length >= 2, `${file} declares ${blocks.length} palette block(s) — light and dark are both required`);
    for (const { selector, tokens } of blocks) {
      for (const name of [...TEXT_TOKENS, ...GROUNDS]) {
        assert.ok(tokens[name], `${file} "${selector}" does not define --${name}`);
      }
    }
  }
});

test("every text token clears AA on every ground, in every theme", () => {
  const failures = [];
  for (const file of SHEETS) {
    for (const { selector, tokens } of palettes(file)) {
      for (const name of TEXT_TOKENS) {
        for (const ground of GROUNDS) {
          const ratio = contrast(tokens[name], tokens[ground]);
          if (ratio < AA) {
            failures.push(`${file} "${selector}": --${name} ${tokens[name]} on --${ground} ` +
              `${tokens[ground]} is ${ratio.toFixed(2)}:1 (needs ${AA}:1)`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], `contrast below AA:\n${failures.join("\n")}`);
});

test("nothing dims text with opacity", () => {
  // Opacity composites the HOST page's text against its background, so it
  // destroys contrast we do not control and cannot measure from tokens. At .58,
  // LinkedIn body text falls to 4.32:1 and its secondary text to 2.43:1. No
  // value below .9 clears AA, and .9 does not read as dimmed — the mechanism is
  // wrong, not the number. Drain colour instead, and let the verdict label carry
  // the meaning.
  //
  // Our own surfaces are exempt: we control both sides of that contrast.
  // Only content.css: it is the sheet injected over LinkedIn's page. popup.css
  // and options.css style our own surfaces, where both sides of the contrast are
  // ours and the ratio tests above already cover them.
  const OURS = /cs-(card|review|welcome|breakage|digest|toolbar|indicator|iconbtn|button)/;
  const offenders = [];
  for (const file of ["content.css"]) {
    const css = stripComments(read(file));
    for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const [, selector, body] = rule;
      const match = body.match(/(?:^|[;\s])opacity\s*:\s*([\d.]+)/);
      if (!match) continue;
      const value = Number(match[1]);
      const name = selector.trim().split("\n").pop().trim();
      if (value < 0.9 && !OURS.test(name)) {
        offenders.push(`${file}: "${name}" sets opacity ${value}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these fade text whose contrast we do not control:\n${offenders.join("\n")}`);
});

test("quiet never carries text", () => {
  // The whole point of the tier's restriction. Anything that sets a text colour
  // to quiet is the bug, whatever the property is spelled as.
  const offenders = [];
  for (const file of SHEETS) {
    const css = stripComments(read(file));
    for (const [index, line] of css.split("\n").entries()) {
      if (/(^|[^-\w])color\s*:\s*var\(\s*--(cs-)?quiet\s*\)/.test(line)) {
        offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "--quiet fails AA in light mode and may only be used for non-text " +
    `(see the note at the top of this file):\n${offenders.join("\n")}`);
});

test("quiet is still distinct from slate, or it should be deleted", () => {
  // The tier only earns its place if it reads as a step below slate. If a future
  // palette edit collapses the two, remove the token rather than keep a rung
  // that no longer exists.
  for (const file of SHEETS) {
    for (const { selector, tokens } of palettes(file)) {
      if (!tokens.quiet) continue;
      const ratio = contrast(tokens.quiet, tokens.slate);
      assert.ok(ratio > 1.2,
        `${file} "${selector}": --quiet ${tokens.quiet} is only ${ratio.toFixed(2)}:1 from ` +
        `--slate ${tokens.slate} — the tier no longer exists, so delete it`);
    }
  }
});

test("the maybe dot is the only thing quiet paints", () => {
  // Documented so the restriction reads as a decision rather than an accident.
  const css = stripComments(read("content.css"));
  const uses = [...css.matchAll(/([^{}]*)\{[^{}]*var\(--cs-quiet\)[^{}]*\}/g)]
    .map((m) => m[1].trim().split("\n").pop().trim())
    .filter((selector) => !selector.includes(":root") && !selector.includes("data-color-scheme"));
  assert.deepEqual(uses, [".cs-indicator--maybe::before"],
    "quiet is painting something new — it may only be used for non-text");
});
