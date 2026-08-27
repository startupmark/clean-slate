// Shared test scaffolding. No dependencies — Node's built-in test runner only.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const engine = require("../extension/engine.js");

const EXTENSION_DIR = path.join(__dirname, "..", "extension");
const FIXTURE_DIR = path.join(__dirname, "fixtures");

/** detection.json as the extension actually ships it, compiled for English. */
function shippedDetection(lang = "en") {
  const raw = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "detection.json"), "utf8"));
  return engine.compileDetection(raw, lang);
}

/** A settings object: the shipped defaults, with per-test overrides applied. */
function settings(overrides = {}) {
  return {
    ...structuredClone(engine.SETTINGS_DEFAULTS),
    ...overrides,
    thresholdByMode: {
      ...engine.SETTINGS_DEFAULTS.thresholdByMode,
      ...(overrides.thresholdByMode || {})
    }
  };
}

/** An untrained learner — the state a fresh install is in. */
const emptyModel = () => ({ pos: {}, neg: {}, posDocs: 0, negDocs: 0, seen: {} });

/**
 * Train a model the way content.js does: one document per label, counting each
 * distinct token once. Kept in step with train() in content.js by
 * learner.test.js, which asserts the two produce the same counts.
 */
function trainedModel(positives = [], negatives = []) {
  const model = emptyModel();
  const feed = (texts, bag, docsKey) => {
    for (const text of texts) {
      for (const token of engine.tokenize(text)) bag[token] = (bag[token] || 0) + 1;
      model[docsKey]++;
    }
  };
  feed(positives, model.pos, "posDocs");
  feed(negatives, model.neg, "negDocs");
  return model;
}

/**
 * Fixtures are sanitized innerText snapshots of single feed posts — the text a
 * post renders, not its markup.
 *
 * Why text and not HTML: extractPost works from node.innerText, and innerText is
 * one of the few DOM properties jsdom does not implement, so an HTML fixture
 * could not drive it without hand-rolling a layout-aware DOM. Text snapshots
 * also sanitize trivially (there is no markup left to leak identifiers through)
 * and stay readable in review. The cost is real and worth stating: these
 * fixtures cannot catch a *selector* break, only a *parsing* break. Selector
 * breakage is what the in-page breakage banner exists to surface.
 *
 * Format — `#` front-matter of expected values, then `---`, then the snapshot:
 *
 *   # key: expanded-urn_FeedType_ugcPost
 *   # author: Priya Raman
 *   # outcome: keep
 *   ---
 *   Feed post
 *   Priya Raman
 *   ...
 *
 * Only the fields a fixture declares are asserted, so each fixture stays about
 * the one thing it is pinning down.
 */
function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((name) => {
      // Normalise line endings on the way in. .gitattributes pins these files to
      // LF, but a clone that predates it — or an editor that saves CRLF — would
      // otherwise break the divider search below and take the whole suite with
      // it, on Windows only, while CI stayed green.
      const source = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/\r\n/g, "\n");
      const divider = source.indexOf("\n---\n");
      if (divider === -1) throw new Error(`fixture ${name} has no --- divider`);

      const expected = {};
      for (const line of source.slice(0, divider).split("\n")) {
        const match = line.match(/^#\s*([A-Za-z]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const [, field, rawValue] = match;
        const value = rawValue.trim();
        expected[field] =
          value === "true" ? true
          : value === "false" ? false
          : value === "null" ? null
          : /^-?\d+$/.test(value) ? Number(value)
          : value;
      }
      if (!expected.key) throw new Error(`fixture ${name} declares no key`);

      return { name, expected, text: source.slice(divider + 5) };
    });
}

/**
 * Pull a top-level object literal out of a source file and evaluate it in
 * isolation. Used to compare the copies of the settings defaults that live in
 * background.js and options.js, neither of which can load engine.js today.
 * If the declaration is reshaped so this stops matching, the test fails — which
 * is the correct outcome, because the copies can no longer be checked.
 */
function objectLiteralFrom(file, declaration) {
  const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`${file}: could not find \`${declaration}\``);

  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  let inString = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") inString = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error(`${file}: unbalanced braces after \`${declaration}\``);

  // Round-tripped through JSON: the literal is evaluated in a separate context,
  // so its objects would otherwise fail a strict deep-equal on prototype
  // identity.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${source.slice(open, end)})`)));
}

module.exports = {
  engine,
  EXTENSION_DIR,
  shippedDetection,
  settings,
  emptyModel,
  trainedModel,
  loadFixtures,
  objectLiteralFrom
};
