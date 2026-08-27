// Configuration invariants. None of this is clever; all of it is the kind of
// drift that ships silently and is then hard to explain — a fallback that no
// longer matches the file it falls back from, a defaults object that gained a
// field in one of its three copies, a manifest that forgot to load the engine.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { engine, EXTENSION_DIR, objectLiteralFrom } = require("./helpers.js");
const runtime = require("../extension/runtime.js");

const read = (file) => fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
const readJson = (file) => JSON.parse(read(file));

// ---------- detection.json ----------

test("detection.json is valid JSON with the shape the engine expects", () => {
  const raw = readJson("detection.json");
  assert.equal(typeof raw.version, "string");
  assert.ok(raw.version.length, "detection.json must carry a version — the popup shows it");
  assert.ok(raw.selectors.post && raw.selectors.feedColumn);
  assert.ok(Array.isArray(raw.feedPaths) && raw.feedPaths.length);
  assert.ok(raw.locales.en, "en is the fallback locale and must always exist");
});

test("the built-in fallback matches detection.json exactly", () => {
  // content.js compiles DETECTION_DEFAULTS at startup and only replaces it once
  // detection.json has loaded. If they drift, behaviour differs for the first
  // frames of every page load — and permanently if the fetch ever fails.
  const shipped = readJson("detection.json");
  const builtIn = engine.DETECTION_DEFAULTS;

  assert.deepEqual(shipped.selectors, builtIn.selectors);
  assert.deepEqual(shipped.feedPaths, builtIn.feedPaths);
  assert.deepEqual(Object.keys(shipped.locales).sort(), Object.keys(builtIn.locales).sort());
  for (const code of Object.keys(shipped.locales)) {
    assert.deepEqual(shipped.locales[code], builtIn.locales[code], `locale "${code}" drifted`);
  }
  // The version differs on purpose: "built-in" is how the popup tells you the
  // fallback is in use rather than the file.
  assert.equal(builtIn.version, "built-in");
  assert.notEqual(shipped.version, "built-in");
});

test("every locale pattern compiles as a regex", () => {
  const raw = readJson("detection.json");
  for (const [code, locale] of Object.entries(raw.locales)) {
    for (const [field, source] of Object.entries(locale)) {
      assert.doesNotThrow(() => new RegExp(source, "i"), `${code}.${field} is not a valid regex`);
    }
  }
});

test("every locale defines every pattern the engine reads", () => {
  const raw = readJson("detection.json");
  const required = Object.keys(raw.locales.en);
  for (const [code, locale] of Object.entries(raw.locales)) {
    assert.deepEqual(Object.keys(locale).sort(), required.sort(), `locale "${code}" has a different field set`);
  }
});

test("an unknown locale falls back to English and says so", () => {
  const raw = readJson("detection.json");
  assert.equal(engine.compileDetection(raw, "en-GB").locale, "en");
  assert.equal(engine.compileDetection(raw, "de-DE").locale, "de→en");
  assert.equal(engine.compileDetection(raw, "").locale, "en");
  assert.equal(engine.compileDetection(raw, undefined).locale, "en");
});

test("the compiled detection exposes the version the popup reports", () => {
  const raw = readJson("detection.json");
  assert.equal(engine.compileDetection(raw, "en").version, raw.version);
});

// ---------- settings defaults ----------

test("the three copies of the settings defaults are identical", () => {
  // engine.js is the source of truth; background.js and options.js carry copies
  // because neither can load it today. Deduplicating them is a real change with
  // its own risk; asserting they match costs nothing and catches the drift.
  const background = objectLiteralFrom("background.js", "const DEFAULT_SETTINGS =");
  const options = objectLiteralFrom("options.js", "const DEFAULTS =");

  assert.deepEqual(background, engine.SETTINGS_DEFAULTS, "background.js defaults drifted from engine.js");
  assert.deepEqual(options, engine.SETTINGS_DEFAULTS, "options.js defaults drifted from engine.js");
});

test("the default mode has a threshold defined for it", () => {
  const d = engine.SETTINGS_DEFAULTS;
  assert.ok(d.mode in d.thresholdByMode || d.mode === "raw");
});

test("every stats counter starts at zero", () => {
  for (const [field, value] of Object.entries(engine.SETTINGS_DEFAULTS.stats)) {
    assert.equal(value, 0, `stats.${field} does not start at zero`);
  }
});

// ---------- counters ----------

// A counter write is a delta applied to whatever is in storage at the moment of
// the write, never a total carried in memory. This is that rule, composed from
// the two pure functions the content script uses.
const writeCounters = (stored, delta) =>
  runtime.bumpStats(runtime.mergeSettings(engine.SETTINGS_DEFAULTS, { stats: stored }).stats, delta);

test("two feed tabs add up instead of overwriting each other", () => {
  // Each tab used to keep its own total and write it whole, so a second tab's
  // work vanished and a tab left open pinned the numbers to its own tally for as
  // long as it lived. Seen on a real install: 52 checked became 12.
  let storage = { checked: 52, hidden: 25 };
  storage = writeCounters(storage, { checked: 13, hidden: 6 });
  assert.equal(storage.checked, 65);

  // The other tab writes later. It must add to what is there, not replace it.
  storage = writeCounters(storage, { checked: 1 });
  assert.equal(storage.checked, 66, "a tab wrote its own total over another tab's work");
  assert.equal(storage.hidden, 31);
});

test("counters deleted while a tab is scoring do not come back", () => {
  // "Delete all Clean Slate data" removes the key. A write that lands after it
  // reads storage rather than a total it was carrying, so it writes its own
  // delta onto nothing instead of restoring the old numbers. This is what the
  // old ownership rule was protecting, and reading at write time gets it for
  // free.
  const afterDeletion = writeCounters(undefined, { checked: 2, hidden: 1 });
  assert.equal(afterDeletion.checked, 2);
  assert.equal(afterDeletion.hidden, 1);
  assert.equal(afterDeletion.feedback, 0);
});

test("a reset from the preferences page sticks", () => {
  // Preferences zeroes the counters. The feed tab takes them from the event now
  // rather than defending its own, so the next scored post adds to zero instead
  // of writing the old totals straight back.
  const zeroed = { ...engine.SETTINGS_DEFAULTS.stats };
  assert.equal(writeCounters(zeroed, { checked: 3 }).checked, 3);
});

test("a counter added to the defaults later needs no change here", () => {
  const merged = writeCounters({ checked: 1 }, { checked: 2 });
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(engine.SETTINGS_DEFAULTS.stats).sort());
  assert.equal(merged.checked, 3);
});

test("the feed tab takes counters from the event rather than defending its own", () => {
  const source = read("content.js");
  assert.match(source, /stats: \{ \.\.\.DEFAULTS\.stats, \.\.\.newStats \}/,
    "the storage listener no longer takes the incoming counters");
  assert.ok(!/mergeStats/.test(source), "content.js still defends its own counters");
  // The write path has to read storage, or it is carrying a total again.
  const body = source.slice(source.indexOf("function addStats"), source.indexOf("const incrementStat"));
  assert.match(body, /chrome\.storage\.local\.get\(KEY\)/, "addStats no longer reads storage before adding");
  // Reading storage is not enough: the read has to be what the delta is added
  // to. Leaving the read in place and adding to settings.stats anyway is the
  // original bug, and it looks identical from one line away.
  assert.match(body, /bumpStats\(mergeSettings\(DEFAULTS, stored\)\.stats, delta\)/,
    "addStats adds its delta to something other than what it just read");
  assert.ok(!/bumpStats\(settings\.stats/.test(body),
    "addStats is carrying a total in memory again, and two tabs will fight over the count");
});

test("a counter written before the rename is carried across, not zeroed", () => {
  // The post-level action used to be called "fold", and the counter with it.
  // Anyone upgrading has a stored `folded` and no `hidden`, and dropping it
  // would reset the popup's numbers on the version that renames the button.
  const now = Date.now();
  const carried = engine.sanitizeSettings({ stats: { checked: 90, folded: 41 } }, now);
  assert.equal(carried.stats.hidden, 41);
  assert.equal(carried.stats.checked, 90);

  // A settings object that already has the new field keeps it, whatever a
  // leftover `folded` says.
  assert.equal(engine.sanitizeSettings({ stats: { hidden: 7, folded: 41 } }, now).stats.hidden, 7);

  // Neither field present is zero rather than NaN.
  assert.equal(engine.sanitizeSettings({ stats: { checked: 3 } }, now).stats.hidden, 0);
});

test("an upgrade carries the old counter on the path an upgrade actually takes", () => {
  // The first version of this fix lived in sanitizeSettings and nowhere else,
  // which runs on import only. Every upgrading user goes through mergeSettings
  // instead, so the popup reset to zero and the old number stayed in storage
  // under a key nothing reads. The test above passed the whole time, because it
  // called the function the fix was in rather than the one the product calls.
  // Found by reading the counters out of a real install.
  const merged = runtime.mergeSettings(engine.SETTINGS_DEFAULTS, { stats: { checked: 52, folded: 25, dimmed: 3 } });
  assert.equal(merged.stats.hidden, 25);
  assert.equal(merged.stats.checked, 52);
  assert.ok(!("folded" in merged.stats), "the legacy counter stays in storage for ever");

  // Someone already counting under the new name keeps it.
  assert.equal(runtime.mergeSettings(engine.SETTINGS_DEFAULTS, { stats: { hidden: 7, folded: 25 } }).stats.hidden, 7);

  // A fresh install is untouched.
  assert.equal(runtime.mergeSettings(engine.SETTINGS_DEFAULTS, {}).stats.hidden, 0);
});

test("the service worker carries the old counter too, since it cannot load runtime.js", () => {
  // background.js keeps its own copy of the merge, and the popup reads through
  // it. Anyone who upgrades and opens the popup before visiting a feed would
  // otherwise be told they had hidden nothing.
  const source = read("background.js");
  assert.match(source, /const \{ folded, \.\.\.stats \} = saved\.stats/,
    "background.js no longer separates a pre-rename counter");
  assert.match(source, /stats\.hidden = folded/,
    "background.js does not move the old count across");
});

// ---------- importing settings ----------

test("a hostile or hand-edited export cannot corrupt state", () => {
  // An exported file comes back as untrusted input. Everything must be rebuilt
  // from the defaults, so an import can add nothing and break nothing.
  const now = Date.UTC(2026, 7, 25);
  const clean = engine.sanitizeSettings({
    interests: ["ok", 42, "   ", { evil: true }, "ok"],
    authorDecayDays: 99999,
    thresholdByMode: { discover: -5, focus: "x", digest: 200 },
    mode: "wat",
    activeProfile: "does-not-exist",
    profiles: [{ id: "p1", name: "A".repeat(200), interests: ["x"], threshold: 1e9 }, { junk: true }],
    authorMarks: { "Sam": now + 1e9, "Real Person": 1000, "": 5 },
    stats: { checked: -3, hidden: "many" },
    __proto__: { polluted: true },
    unknownKey: "dropped"
  }, now);

  assert.deepEqual(clean.interests, ["ok"], "non-strings and blanks survived");
  assert.equal(clean.authorDecayDays, 365, "decay was not clamped");
  assert.equal(clean.thresholdByMode.discover, 0);
  assert.equal(clean.thresholdByMode.focus, 70, "a non-number threshold did not fall back");
  assert.equal(clean.mode, "discover", "an unknown mode was accepted");
  assert.equal(clean.activeProfile, null, "activeProfile pointed at a profile that does not exist");
  assert.equal(clean.profiles.length, 1, "a malformed profile survived");
  assert.equal(clean.profiles[0].name.length, 60, "profile name was not bounded");
  assert.ok(!("sam" in clean.authorMarks), "a future-dated mark survived, and would never decay");
  assert.ok("real person" in clean.authorMarks, "a valid mark was dropped");
  assert.equal(clean.stats.checked, 0, "a negative counter survived");
  assert.ok(!("unknownKey" in clean), "an unknown key was copied through");
  assert.ok(!("polluted" in clean), "prototype pollution reached the result");
});

test("a file that is not settings at all is rejected outright", () => {
  for (const junk of [null, undefined, "a string", 42, [], true]) {
    assert.equal(engine.sanitizeSettings(junk, Date.now()), null, `${JSON.stringify(junk)} was accepted`);
  }
});

test("a clean round trip through export and import changes nothing", () => {
  // The whole point of the pair: what comes out must go back in unchanged.
  const now = Date.UTC(2026, 7, 25);
  const original = {
    ...structuredClone(engine.SETTINGS_DEFAULTS),
    onboardingComplete: true,
    interests: ["AI infrastructure", "developer tools"],
    blockedAuthors: ["Someone"],
    authorMarks: { someone: now - 86400000 },
    profiles: [{ id: "p1", name: "Community brain", interests: ["mutual aid"], mutedPhrases: [], threshold: 40 }],
    activeProfile: "p1"
  };
  const roundTripped = engine.sanitizeSettings(JSON.parse(JSON.stringify(original)), now);
  assert.deepEqual(roundTripped, original, "a valid export did not survive its own import");
});

test("import is reachable, and validates before it writes", () => {
  // Export without import is a dead end: the file could only be reapplied by
  // hand-editing storage.
  const html = read("options.html");
  assert.ok(/id="import"/.test(html), "options.html has no import control");
  assert.ok(/id="import-file"/.test(html), "options.html has no file input");
  assert.ok(html.indexOf('src="engine.js"') < html.indexOf('src="options.js"'),
    "options.html must load engine.js first — the import path uses its validator");

  const source = read("options.js");
  assert.match(source, /sanitizeSettings\(/, "import does not validate the file");
  assert.ok(source.indexOf("sanitizeSettings(") < source.indexOf("{[KEY]:clean}"),
    "import writes before it validates");
  assert.match(source, /confirm\(/, "import replaces everything without asking");

  // Everything above is source ordering, which is not the same as the guard
  // working. Deleting the null check at the write site survived all of it:
  // importing a file containing [] or 42 wrote {cleanSlateSettings: null} and
  // destroyed the user's whole configuration. So run the validator itself.
  for (const junk of [[], 42, "text", null, true]) {
    assert.equal(engine.sanitizeSettings(junk, Date.now()), null,
      `${JSON.stringify(junk)} was accepted as a settings file`);
  }
  assert.match(source, /if\s*\(\s*!\s*clean\s*\)/,
    "options.js writes the validator's result without checking it rejected the file");
});

test("the privacy policy ships inside the extension, not only in the repo", () => {
  // Nobody who installs this reads the repository.
  const privacy = read("privacy.html");
  assert.match(read("options.html"), /href="privacy\.html"/, "preferences does not link the policy");
  for (const fact of ["600", "200", "4,000", "cs-oss@triberoi.com"]) {
    assert.ok(privacy.includes(fact), `privacy.html does not mention ${fact}`);
  }
  // The claim, not one phrasing of it. Pinning a sentence means every copy edit
  // breaks a test that is not about copy.
  assert.match(privacy, /no network request|never leaves|not (sent|transmitted)|stays inside your browser/i,
    "privacy.html no longer states that nothing leaves the machine");
});

// ---------- manifest ----------

test("the one-line description fits the store and says the same thing twice", () => {
  // Chrome hard-rejects a summary over 132 characters at upload, and the store
  // listing reuses this exact sentence. Finding that out at submission costs a
  // round trip through review.
  const description = readJson("manifest.json").description;
  assert.ok(description.length <= 132,
    `the description is ${description.length} characters; the store takes 132`);

  // Two files hold this sentence and nothing makes them agree. They had already
  // drifted once: the manifest was rewritten and the locale copy kept the old
  // wording for a release.
  const localised = readJson("_locales/en/messages.json").extensionDescription.message;
  assert.equal(localised, description,
    "manifest.json and _locales/en/messages.json disagree about what Clean Slate is");
});

test("the manifest loads the pure modules before content.js", () => {
  const scripts = readJson("manifest.json").content_scripts[0].js;
  assert.deepEqual(scripts, ["engine.js", "runtime.js", "content.js"],
    "engine.js and runtime.js must load first — content.js destructures both at parse time");
});

test("the content script runs on the LinkedIn feed and nowhere else", () => {
  // Asserted nowhere before this. Mutating matches to ["https://*/*"] left the
  // suite green while the script read and scored the DOM of every https site,
  // because the permissions test only ever looked at host_permissions.
  const manifest = readJson("manifest.json");
  const script = manifest.content_scripts[0];

  assert.deepEqual(script.matches, ["https://www.linkedin.com/*"],
    "the content script's match list changed");
  assert.equal(script.run_at, "document_idle", "the injection point changed");
  assert.deepEqual(manifest.host_permissions, script.matches,
    "host_permissions and the content script disagree about where this runs");

  // The gate inside the script narrows this to the home feed. The manifest stays
  // site-wide because LinkedIn is a single-page app: a user who lands on /jobs
  // and navigates to the feed would otherwise never get an injection at all.
  assert.ok(!runtime.matchesFeedPath("/jobs/", readJson("detection.json").feedPaths),
    "the in-script gate no longer narrows what the manifest allows");
});

test("the manifest ships every file the extension references", () => {
  const manifest = readJson("manifest.json");
  const declared = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    manifest.background.service_worker,
    manifest.options_page,
    manifest.action.default_popup,
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources)
  ];
  for (const file of declared) {
    // web_accessible_resources may be patterns ("fonts/*.woff2"). A pattern that
    // matches nothing is the same bug as a missing file — the resource is not
    // reachable — so resolve it rather than skipping it.
    if (file.includes("*")) {
      const dir = path.join(EXTENSION_DIR, path.dirname(file));
      const [prefix, suffix] = path.basename(file).split("*");
      const matches = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
        : [];
      assert.ok(matches.length, `manifest pattern matches no file: ${file}`);
      continue;
    }
    assert.ok(fs.existsSync(path.join(EXTENSION_DIR, file)), `manifest references missing file: ${file}`);
  }
});

test("the extension ships the icons Chrome and the store require", () => {
  // Without these Chrome shows a generic puzzle piece, and the Web Store rejects
  // a submission with no 128px icon. They are rasterised from the design
  // system's own mark; 16 uses its purpose-built small cut.
  const manifest = readJson("manifest.json");
  const REQUIRED = ["16", "32", "48", "128"];
  for (const size of REQUIRED) {
    assert.ok(manifest.icons[size], `manifest declares no ${size}px icon`);
  }
  for (const size of ["16", "32", "48"]) {
    assert.ok(manifest.action.default_icon[size], `the toolbar has no ${size}px icon`);
  }

  // Declared is not the same as present, and the wrong size is worse than none:
  // Chrome scales silently rather than complaining.
  const checkPng = (file, size) => {
    const bytes = fs.readFileSync(path.join(EXTENSION_DIR, file));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${file} is not a PNG`);
    assert.equal(bytes.readUInt32BE(16), Number(size), `${file} is not ${size}px wide`);
    assert.equal(bytes.readUInt32BE(20), Number(size), `${file} is not ${size}px tall`);
  };
  for (const [size, file] of Object.entries(manifest.icons)) checkPng(file, size);

  // Every toolbar icon needs its dark counterpart, or setIcon fails at runtime
  // with no visible symptom beyond the icon not changing.
  for (const [size, file] of Object.entries(manifest.action.default_icon)) {
    checkPng(file.replace(/\.png$/, "-dark.png"), size);
  }
});

test("the toolbar icon follows the browser's colour scheme", () => {
  // The mark's baseline is ink, which disappears on a dark toolbar. Chrome has
  // no theming for extension icons, so the surfaces that can see
  // prefers-color-scheme report it and the service worker swaps the cut.
  const background = read("background.js");
  assert.match(background, /chrome\.action\.setIcon/, "the service worker never sets the icon");
  assert.match(background, /clean-slate:color-scheme/, "the service worker ignores scheme reports");
  assert.match(background, /onStartup/,
    "the icon is not restored on service-worker restart, so it reverts to the light cut");

  for (const file of ["popup.js", "content.js"]) {
    assert.match(read(file), /prefers-color-scheme: dark/, `${file} never reads the colour scheme`);
    assert.match(read(file), /clean-slate:color-scheme/, `${file} never reports the colour scheme`);
  }
});

test("detection.json is web-accessible, or the fetch in content.js cannot see it", () => {
  const manifest = readJson("manifest.json");
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(resources.includes("detection.json"));
});

test("the hidden-post log's disclosure matches what it actually stores", () => {
  // The extension keeps other people's post text on disk. If the cap or the
  // slice length changes, the privacy policy stops being true — and that is the
  // one claim a sceptical reader will check.
  // Measured against what the shipping code produces, not against its source.
  const post = { key: "k", author: "A", text: "x".repeat(5000) };
  const entry = runtime.hiddenLogEntry(post, { score: 10, reasons: [] }, 0);
  assert.equal(entry.text.length, runtime.HIDDEN_TEXT, "the stored slice no longer matches the stated length");

  let log = [];
  for (let i = 0; i < runtime.HIDDEN_LOG_CAP + 50; i++) {
    log = runtime.appendHidden(log, runtime.hiddenLogEntry({ ...post, key: "k" + i }, { score: 10, reasons: [] }, i));
  }
  assert.equal(log.length, runtime.HIDDEN_LOG_CAP, "the hidden-post log no longer caps where the policy says it does");
  assert.equal(log[0].key, "k50", "the cap drops the newest rather than the oldest");

  const privacy = fs.readFileSync(path.join(EXTENSION_DIR, "..", "PRIVACY.md"), "utf8");
  assert.ok(privacy.includes(String(runtime.HIDDEN_TEXT)), "PRIVACY.md does not mention the stored slice length");
  assert.ok(privacy.includes(String(runtime.HIDDEN_LOG_CAP)), "PRIVACY.md does not mention the entry cap");

  const readme = fs.readFileSync(path.join(EXTENSION_DIR, "..", "README.md"), "utf8");
  assert.ok(/PRIVACY\.md/.test(readme), "README does not point at the privacy policy");
});

test("the extension asks for no more permissions than it uses", () => {
  const manifest = readJson("manifest.json");
  // activeTab is absent: host_permissions already exposes tab.url
  // and allows tabs.sendMessage for linkedin.com, which is all the popup needs.
  assert.deepEqual(manifest.permissions.sort(), ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.linkedin.com/*"]);
});

test("no source file makes a network call", () => {
  // The zero-network-calls guarantee is stated in README and CONTRIBUTING as
  // grounds for declining a PR. Crude but sufficient: the only fetch allowed is
  // the extension reading its own bundled detection.json via
  // chrome.runtime.getURL.
  const offenders = [];
  for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith(".js"))) {
    const source = read(file);
    for (const [index, line] of source.split("\n").entries()) {
      if (/\bfetch\s*\(/.test(line) && !line.includes("chrome.runtime.getURL")) {
        offenders.push(`${file}:${index + 1} ${line.trim()}`);
      }
      if (/XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource/.test(line)) {
        offenders.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `network call in extension source:\n${offenders.join("\n")}`);
});

test("no shipped page can reach the network either", () => {
  // The scan above reads only *.js, so every HTML file was exempt. Verified by
  // mutation before this existed: a tracking pixel in help.html, a Google Fonts
  // stylesheet in privacy.html and a remote script in popup.html all left the
  // suite green. MV3's default CSP blocks the script, but not img-src or
  // style-src, so the pixel and the stylesheet genuinely fetch.
  //
  // Links a user clicks are fine — they open a tab, they do not load a subresource.
  const ALLOWED = [
    "https://github.com/startupmark/clean-slate",
    "https://www.gnu.org/licenses/",
    "https://www.linkedin.com/",
    "https://scripts.sil.org/OFL",
    "http://www.w3.org/2000/svg"
  ];
  const offenders = [];
  for (const file of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith(".html"))) {
    for (const [index, line] of read(file).split(/\r?\n/).entries()) {
      for (const [url] of line.matchAll(/https?:\/\/[^"'\s)>]+/g)) {
        if (ALLOWED.some((prefix) => url.startsWith(prefix))) continue;
        offenders.push(`${file}:${index + 1} ${url}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a shipped page reaches the network: ${offenders.join(" | ")}`);
});

test("the fixtures stay LF, on every platform", () => {
  // core.autocrlf=true is the Git for Windows default, so a fresh clone there
  // rewrites these files to CRLF. loadFixtures splits on a literal LF-dashes-LF
  // divider, which then matches nothing, and every extraction and scoring test
  // fails at once — on Windows only, while Linux CI stays green and reports the
  // tree is fine. .gitattributes is what stops the rewrite; the readers
  // normalise anyway, because a clone made before .gitattributes existed keeps
  // its CRLF until those files are next checked out.
  const root = path.join(EXTENSION_DIR, "..");
  const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /test\/fixtures\/\*\.txt\s+text\s+eol=lf/,
    ".gitattributes no longer pins the fixtures to LF");

  const fixtures = path.join(root, "test", "fixtures");
  const offenders = fs.readdirSync(fixtures)
    .filter((name) => name.endsWith(".txt"))
    .filter((name) => fs.readFileSync(path.join(fixtures, name), "utf8").includes("\r"));
  assert.deepEqual(offenders, [],
    "these fixtures contain CR. On a clone older than .gitattributes, checking them " +
    "out again picks up the new rule");

  // The reader copes regardless, so a CRLF checkout degrades to nothing.
  const helpers = fs.readFileSync(path.join(root, "test", "helpers.js"), "utf8");
  assert.ok(helpers.includes('replace(/\\r\\n/g, "\\n")'),
    "test/helpers.js reads the fixtures without normalising line endings");
});

test("engine.js stays pure — no DOM, no chrome.*, no storage", () => {
  // The whole test suite depends on this file being callable outside a browser.
  const source = read("engine.js")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["chrome.", "document.", "window.", "localStorage", "fetch("]) {
    assert.ok(!source.includes(forbidden), `engine.js references ${forbidden} and is no longer pure`);
  }
});

test("the two places that carry a version agree", () => {
  // The name of this test used to promise a comparison it never made: it
  // checked the format and nothing else, so the manifest and package.json could
  // drift apart silently. A release touches both by hand.
  const manifest = readJson("manifest.json");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "the manifest version is not a semver triple");

  const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "..", "package.json"), "utf8"));
  assert.equal(pkg.version, manifest.version,
    `package.json says ${pkg.version} and the manifest says ${manifest.version}`);
});

test("an oversized import is bounded before it reaches storage", () => {
  // Measured before the caps: 100,000 interests plus a two-million-character
  // phrase and 50,000 profiles came to 7.3MB against a 10MB quota, about 34ms
  // per decide() call, and a preferences page that tried to render 150,000 chip
  // elements. Nothing about that file is invalid, only enormous.
  const hostile = {
    interests: Array.from({ length: 100000 }, (_, i) => `topic ${i}`),
    mutedPhrases: ["x".repeat(2000000)],
    profiles: Array.from({ length: 50000 }, (_, i) => ({
      id: `p${i}`, name: "n".repeat(500), interests: ["a"], mutedPhrases: [], threshold: 50
    })),
    authorMarks: Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`person ${i}`, 1]))
  };

  const clean = engine.sanitizeSettings(hostile, Date.now());
  const kb = new TextEncoder().encode(JSON.stringify(clean)).length / 1024;

  assert.ok(kb < 200, `an import sanitised to ${kb.toFixed(0)}KB; the quota is 10MB and the page has to render it`);
  assert.ok(clean.interests.length <= 500, `${clean.interests.length} interests survived`);
  assert.ok(clean.profiles.length <= 50, `${clean.profiles.length} profiles survived`);
  assert.ok(Object.keys(clean.authorMarks).length <= 2000, "the author marks are unbounded");
  assert.ok(Math.max(0, ...clean.mutedPhrases.map((p) => p.length)) <= 200, "a single entry is unbounded");

  // A real configuration is nowhere near any of this.
  const ordinary = engine.sanitizeSettings({
    interests: ["AI infrastructure", "developer tools"],
    mutedPhrases: ["thrilled to announce"]
  }, Date.now());
  assert.deepEqual(ordinary.interests, ["AI infrastructure", "developer tools"]);
});

test("a broken selector in detection.json falls back instead of killing the script", () => {
  // Every regex went through a compile that throws and is caught. The CSS
  // selectors were copied through unchecked, so a typo threw inside
  // querySelectorAll before the MutationObserver was attached: the extension did
  // nothing at all, and the breakage banner never fired because the health check
  // never ran either. A silent total failure from a one-character edit to a data
  // file that exists to be edited.
  const raw = readJson("detection.json");

  // engine.js may not touch a DOM, so the caller injects the probe. content.js
  // passes document.querySelector; this stands in for it.
  const probe = (value) => {
    if (/\[[^\]]*$/.test(value) || /^\s*$/.test(value)) {
      throw new SyntaxError(`'${value}' is not a valid selector`);
    }
    return null;
  };

  const broken = { ...raw, selectors: { post: "main div[role='listitem'", feedColumn: "main div[role='list']" } };
  const det = engine.compileDetection(broken, "en", probe);
  assert.equal(det.post, engine.DETECTION_DEFAULTS.selectors.post,
    "a malformed selector was passed through to querySelectorAll");
  assert.equal(det.feedColumn, "main div[role='list']", "a valid selector beside a broken one was discarded");

  // A missing selector falls back too.
  assert.equal(engine.compileDetection({ ...raw, selectors: {} }, "en", probe).post,
    engine.DETECTION_DEFAULTS.selectors.post);

  // The shipped file is accepted unchanged, with and without a probe.
  assert.equal(engine.compileDetection(raw, "en", probe).post, raw.selectors.post);
  assert.equal(engine.compileDetection(raw, "en").post, raw.selectors.post);
});

test("an export carries what a restore needs, and nothing it should not", () => {
  // Export was sold as a backup and as the way to move to a new machine, and
  // carried neither the learned model nor the hidden-post log. Restoring gave back a
  // filter with posDocs 0 and negDocs 0 — one that contributes nothing until
  // eight more judgements — with nothing anywhere saying so.
  const source = read("options.js");

  const exporter = source.slice(source.indexOf('$("#export")'), source.indexOf('$("#import")'));
  assert.ok(exporter.includes("MODEL_KEY"), "export no longer carries the learned model");
  assert.ok(!exporter.includes("cleanSlateFoldLog"),
    "export carries the hidden-post log, which is other people's writing");

  // And the import side has to accept it back.
  assert.ok(source.includes("sanitizeModel("), "import cannot read a model back");
});

test("a learned model survives export and import unchanged", () => {
  const model = {
    pos: { kubernetes: 4, operators: 2 },
    neg: { funnel: 3 },
    posDocs: 6,
    negDocs: 3,
    seen: { "post-1": "pos", "post-2": "neg" }
  };
  const roundTripped = engine.sanitizeModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual({ ...roundTripped, pos: { ...roundTripped.pos }, neg: { ...roundTripped.neg }, seen: { ...roundTripped.seen } },
    model, "a valid model did not survive its own import");
});

test("a hostile model file cannot corrupt the filter or fill the quota", () => {
  const hostile = {
    pos: Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`token${i}`, 1])),
    neg: { "": 5, valid: -3, huge: 1e12, ["x".repeat(500)]: 2 },
    posDocs: -5,
    negDocs: "many",
    seen: Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`k${i}`, i % 2 ? "pos" : "bogus"]))
  };
  const clean = engine.sanitizeModel(hostile);

  assert.ok(Object.keys(clean.pos).length <= 4000, `${Object.keys(clean.pos).length} tokens survived`);
  assert.ok(Object.keys(clean.seen).length <= 400, "the remembered-posts list is unbounded on import");
  assert.equal(clean.posDocs, 0, "a negative document count survived");
  assert.equal(clean.negDocs, 0, "a non-numeric document count survived");
  assert.ok(!("" in clean.neg), "a blank token survived");
  assert.ok(!("valid" in clean.neg), "a negative count survived");
  for (const label of Object.values(clean.seen)) {
    assert.ok(label === "pos" || label === "neg", `"${label}" is not a verdict`);
  }

  // And anything that is not a model at all is refused outright.
  for (const junk of [null, undefined, "text", 42, [], true]) {
    assert.equal(engine.sanitizeModel(junk), null, `${JSON.stringify(junk)} was accepted as a model`);
  }
});
