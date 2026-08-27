// The claims a stranger can check, and the deletions they depend on.
//
// Everything here guards something that was found untrue in the pre-launch
// review: a privacy page promising a deletion that did not happen, a page gate
// that admitted more pages than the policy described, a confirm dialog that
// understated what it destroyed, a debug flag that shipped on.
//
// These are source pins, not behavioural tests. content.js, options.js and the
// workflows are not requireable, so what follows asserts over their text. That
// is weaker than it looks and it is temporary: the behavioural
// suite arrives when the pure logic is extracted. A pin still catches the one
// thing that matters here, which is somebody quietly removing the fix.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { EXTENSION_DIR } = require("./helpers.js");
const runtime = require("../extension/runtime.js");

const REPO_ROOT = path.join(EXTENSION_DIR, "..");
const read = (file) => fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
const readRoot = (file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8");

// ---------- the blocker: deletion has to reach the feed tab ----------

test("deleting the model or the hidden-post log empties this tab's copy of them", () => {
  // Both are loaded once at boot and held for the life of the tab. Without a
  // listener for their removal, the next hidden post writes the whole pre-deletion log
  // back to disk — author names and 600 characters of each post — and the
  // deletion the privacy page promises silently does not happen.
  const source = read("content.js");

  const listener = source.slice(source.indexOf("chrome.storage.onChanged.addListener"));
  assert.ok(
    /changes\[MODEL_KEY\][\s\S]{0,120}newValue === undefined/.test(listener),
    "the storage listener no longer resets the in-memory model when the key is removed"
  );
  assert.ok(
    /changes\[LOG_KEY\][\s\S]{0,120}newValue === undefined/.test(listener),
    "the storage listener no longer resets the in-memory log when the key is removed"
  );

  // The reset has to run before the early return that only cares about settings.
  const modelAt = listener.indexOf("changes[MODEL_KEY]");
  const bailAt = listener.indexOf("if (!changes[KEY]) return;");
  assert.ok(bailAt > -1, "the settings early return moved; re-check the ordering below it");
  assert.ok(modelAt < bailAt, "the deletion reset now sits below the settings early return, so it never runs");
});

test("deleting the hidden-post log does not immediately refill it from the visible feed", () => {
  // Emptying the array is not enough. Deleting everything also removes the
  // settings key, and that path calls resetAll() — clearing the remembered
  // verdicts — then re-decides every post still on screen as new and logs each
  // log it again. Caught on a real feed: after a delete, every surviving entry was
  // a post still rendered, and the only one that stayed gone had scrolled away.
  const post = { key: "on-screen", author: "A", text: "some hidden post text" };
  const result = { score: 12, reasons: [{ delta: -40, label: "Promoted content" }] };
  const entry = runtime.hiddenLogEntry(post, result, 1000);

  // A normal hidden post: it lands.
  assert.equal(runtime.appendHidden([], entry).length, 1);

  // Same post, after the user deleted the log while it was on screen.
  const suppressed = new Set(["on-screen"]);
  assert.equal(runtime.appendHidden([], entry, { suppressed }), null,
    "a post on screen at deletion was logged straight back");

  // A post that was NOT on screen is unaffected.
  const other = runtime.hiddenLogEntry({ ...post, key: "elsewhere" }, result, 1000);
  assert.equal(runtime.appendHidden([], other, { suppressed }).length, 1);

  // And the dedupe still holds independently of suppression.
  assert.equal(runtime.appendHidden([entry], entry), null, "the same post was logged twice");
});

test("both delete controls remove the keys the privacy page names", () => {
  // Matches the key list rather than the call, so routing writes through a
  // guarded helper does not read as the deletion disappearing.
  const source = read("options.js");
  for (const key of ["cleanSlateModel", "cleanSlateFoldLog"]) {
    assert.ok(
      new RegExp(`\\(\\[[^\\]]*${key}`).test(source),
      `a delete control no longer removes ${key}`
    );
  }
});

// ---------- the page gate ----------

test("the feed gate matches the home feed exactly, not everything beneath it", () => {
  // A prefix match also admitted these, where posts were scored, decorated and
  // eligible for the hidden-post log — against a policy saying nothing is stored away
  // from the home feed. Confirmed live on a real permalink before the fix.
  const paths = ["/feed"];
  const admits = (pathname) => runtime.matchesFeedPath(pathname, paths);

  for (const home of ["/feed", "/feed/"]) {
    assert.ok(admits(home), `the home feed itself is no longer matched: ${home}`);
  }
  for (const elsewhere of [
    "/feed/hashtag/leadership/",
    "/feed/following/",
    "/feed/news/",
    "/feed/update/urn:li:activity:7498081285039501312/",
    "/messaging/thread/123/",
    "/jobs/",
    "/in/someone/",
    "/feedback"
  ]) {
    assert.ok(!admits(elsewhere), `the feed gate admits ${elsewhere}`);
  }
});

test("the welcome card is guarded by the feed gate, not by its call sites", () => {
  // It is consumed once per install. Mounting it on /jobs or a permalink spent
  // the only introduction the product has on a page it does not describe. There
  // are two call sites, which is why the guard belongs inside the function.
  const source = read("content.js");
  const fn = source.slice(source.indexOf("function showWelcome"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.ok(/if \(!onFeedPage\(\)\) return;/.test(body), "showWelcome no longer checks it is on the feed");
});

// ---------- what leaves the machine when a user files a bug ----------

test("the diagnostic report carries no page path and no attribute values", () => {
  // The banner tells the user this is page structure only, as they paste it
  // into a public issue. On a permalink, location.pathname is the activity URN.
  const source = read("content.js");
  const fn = source.slice(source.indexOf("function buildDiagnostics"));
  const body = fn.slice(0, fn.indexOf("\n  }"));

  assert.ok(!/location\.pathname/.test(body), "the diagnostic report is emitting the page path again");
  assert.ok(/attr\.name/.test(body), "the diagnostic no longer collects attribute names");
  assert.ok(!/attr\.value/.test(body), "the diagnostic is collecting attribute VALUES");
  assert.ok(!/innerText/.test(body.replace(/mainTextLength[\s\S]{0,80}?length/, "")),
    "the diagnostic is reading page text beyond its length");
  assert.ok(/det\.version/.test(body),
    "the diagnostic omits the detection version, so a report made after a failed load looks identical to a good one");
});

test("debug logging ships off", () => {
  // When it was on, every scored post wrote an author name and 60 characters of
  // that post's text to the console of a page LinkedIn's own scripts run on.
  const source = read("content.js");
  assert.ok(/let debug = false;/.test(source), "debug logging is shipping enabled again");
});

// ---------- confirms that name what they destroy ----------

test("every destructive confirm names everything it takes", () => {
  const source = read("options.js");
  const confirmOf = (id) => {
    const at = source.indexOf(`$("#${id}")`);
    assert.ok(at > -1, `the #${id} control disappeared`);
    const text = source.slice(at, at + 700).match(/confirm\("([^"]+)"\)/);
    assert.ok(text, `the #${id} control no longer confirms before destroying anything`);
    return text[1].toLowerCase();
  };

  // Deletes the model and the hidden-post log as well as preferences and counters.
  const all = confirmOf("reset");
  for (const word of ["learn", "hidden"]) {
    assert.ok(all.includes(word), `the delete-all confirm does not mention "${word}"`);
  }

  // Also deletes the hidden-post log, which is not learning and is the review page's
  // only source of data.
  assert.ok(confirmOf("reset-model").includes("hidden"),
    "the forget-everything confirm does not say it also clears the log of hidden posts");

  // Used to promise "nothing else is affected" while zeroing five more counters.
  assert.ok(!confirmOf("reset-counters").includes("nothing else is affected"),
    "the reset-counters confirm claims nothing else is affected, and that is not true");
});

test("the fading control does not promise that never-miss people fade", () => {
  // They do not fade. markAuthor is called only on the two negative paths, and
  // both help.html and the paragraph under the slider already said so.
  const html = read("options.html");
  const label = html.match(/<label class="range-label" for="author-decay">([^<]*)</);
  assert.ok(label, "the decay slider label moved");
  assert.ok(!/never-miss/i.test(label[1]), `the decay label still claims never-miss people fade: "${label[1].trim()}"`);
});

// ---------- claims a reader can check ----------

test("the stated hidden-post log size matches what 200 capped entries actually weigh", () => {
  // Built from the shipped shaping function at the shipped cap, so the figure in
  // both privacy documents is checked against what the code produces rather than
  // against a number copied out of it.
  const post = {
    key: "expanded" + "x".repeat(40) + "FeedType_MAIN_FEED_RELEVANCE",
    author: "Firstname Lastname-Hyphenated",
    text: "x".repeat(runtime.HIDDEN_TEXT)
  };
  const result = { score: 42, reasons: [{ delta: -20, label: "Below your relevance threshold" }] };

  let log = [];
  for (let i = 0; i < runtime.HIDDEN_LOG_CAP; i++) {
    log = runtime.appendHidden(log, runtime.hiddenLogEntry({ ...post, key: post.key + i }, result, 1756000000000 + i));
  }
  const kb = new TextEncoder().encode(JSON.stringify(log)).length / 1024;

  for (const [name, text] of [["PRIVACY.md", readRoot("PRIVACY.md")], ["privacy.html", read("privacy.html")]]) {
    // The number, not the sentence around it.
    const stated = text.match(/(\d+)\s*KB/);
    assert.ok(stated, `${name} no longer states a size for the hidden-post log`);
    assert.ok(Number(stated[1]) >= kb,
      `${name} says ${stated[1]}KB; ${runtime.HIDDEN_LOG_CAP} worst-case entries measure ${kb.toFixed(1)}KB`);
  }
});

test("both privacy documents stop short of claiming kept posts leave no trace", () => {
  // Starring a kept post, or "More like this", tokenizes its full text into the
  // learned model. "Post content that was not hidden" is never stored was false.
  for (const [name, text] of [["PRIVACY.md", readRoot("PRIVACY.md")], ["privacy.html", read("privacy.html")]]) {
    assert.ok(!/^\s*(<li>)?Post content that was not (hidden|hidden)/im.test(text),
      `${name} still claims post content that was not hidden is never stored`);
    assert.ok(/learned model/i.test(text) && /word/i.test(text),
      `${name} does not explain that judging a kept post adds its words to the model`);
  }
});

// ---------- the repository, once it is public ----------

test("every GitHub action is pinned to a commit, not a moving tag", () => {
  // cla.yml runs on pull_request_target with a write-scoped token and triggers
  // from any stranger's fork, so a mutable tag there is the one that matters.
  const dir = path.join(REPO_ROOT, ".github", "workflows");
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    // Anchored: "statuses: write" in a permissions block ends in "uses: write".
    for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      const version = ref.split("@")[1];
      assert.ok(/^[0-9a-f]{40}$/.test(version),
        `${file} pins ${ref} to a moving reference; use the commit SHA with a version comment`);
    }
  }
});

test("the CLA gate accepts the comment CONTRIBUTING asks contributors to post", () => {
  // CONTRIBUTING quotes the line as a blockquote and says "containing". An
  // equality check meant a contributor who copied it with its "> " marker
  // followed the documentation and was skipped, with no bot response.
  const workflow = readRoot(path.join(".github", "workflows", "cla.yml"));
  const sentence = workflow.match(/custom-pr-sign-comment:\s*'([^']+)'/);
  assert.ok(sentence, "the CLA sign sentence moved");

  assert.ok(workflow.includes(`contains(github.event.comment.body, '${sentence[1]}')`),
    "the CLA job gates on an exact whole-comment match again");
  assert.ok(readRoot("CONTRIBUTING.md").includes(sentence[1]),
    "CONTRIBUTING no longer quotes the sentence the workflow accepts");
});

test("the dependency gate covers every channel a dependency could arrive through", () => {
  const workflow = readRoot(path.join(".github", "workflows", "test.yml"));
  for (const channel of ["yarn.lock", "pnpm-lock.yaml", "optionalDependencies", "peerDependencies"]) {
    assert.ok(workflow.includes(channel), `the dependency gate does not check ${channel}`);
  }
});

test("the signing key and packed builds cannot be committed", () => {
  // Chrome's "Pack extension" drops both in the repo root, and commits here are
  // broad.
  const ignore = readRoot(".gitignore");
  for (const pattern of ["*.pem", "*.crx"]) {
    assert.ok(ignore.includes(pattern), `.gitignore does not cover ${pattern}`);
  }
});

test("the packaged extension carries its licence and disclaims affiliation", () => {
  // extension/ is the directory that gets zipped for the store. It shipped with
  // no GPL notice and no copyright line, and the disclaimer existed only in the
  // root README, which is not packaged.
  const readme = read("README.md");
  assert.ok(/GNU General Public License/.test(readme), "the packaged directory has no licence notice");
  assert.ok(/Copyright \(C\) \d{4}/.test(readme), "the packaged directory has no copyright line");

  for (const [name, text] of [["extension/README.md", readme], ["help.html", read("help.html")]]) {
    assert.ok(/not affiliated with/i.test(text), `${name} does not disclaim affiliation with LinkedIn`);
  }
});

test("every document says the same thing about the licence", () => {
  // The CLA is the authority: it promises contributors the project is released
  // under GPL-3.0 and stays available under it. That is version 3 specifically,
  // so the SPDX identifier is GPL-3.0-only and the notice in the packaged
  // directory must not grant "or any later version" — which the stock GNU
  // wording does, and which would hand out a licence the CLA never promised.
  assert.equal(JSON.parse(readRoot("package.json")).license, "GPL-3.0-only",
    "package.json disagrees with the version the CLA promises");

  const notice = read("README.md");
  assert.ok(!/any later version/i.test(notice),
    "the packaged licence notice grants 'or any later version', which is wider than the CLA");

  for (const [name, text] of [["CLA.md", readRoot("CLA.md")], ["README.md", readRoot("README.md")]]) {
    assert.ok(/GPL-3\.0/.test(text) && !/GPL-3\.0-or-later/.test(text),
      `${name} no longer states the licence as GPL-3.0`);
  }
});

test("no GitHub template links relatively from a page that is not a file path", () => {
  // An issue form and a PR template are rendered outside the repository tree, so
  // ../CLA.md and ../../blob/main/… resolve to nothing.
  const dir = path.join(REPO_ROOT, ".github");
  const walk = (at) => fs.readdirSync(at, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(at, e.name)) : [path.join(at, e.name)]);

  for (const file of walk(dir).filter((f) => /\.(md|yml)$/.test(f))) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/\]\(\.\.\//.test(text),
      `${path.relative(REPO_ROOT, file)} links relatively; use the full https URL`);
  }
});

test("the bug report offers every reading mode the product has", () => {
  const modes = Object.keys(require("../extension/engine.js").SETTINGS_DEFAULTS.thresholdByMode);
  const form = readRoot(path.join(".github", "ISSUE_TEMPLATE", "bug_report.yml"));
  for (const mode of modes) {
    const label = mode[0].toUpperCase() + mode.slice(1);
    assert.ok(form.includes(`"${label}"`), `the bug report's mode list omits ${label}`);
  }
});

test("a refused storage write is visible on the preferences page", () => {
  // Storage can reject — quota, a closing profile. Every write here was bare, so
  // a failure surfaced nowhere: the page said "Saved locally." and nothing had
  // been saved. Storage is the only thing this product has.
  const source = read("options.js");

  assert.match(source, /async function write\(/, "the guarded writer is gone");
  assert.match(source, /async function wipe\(/, "the guarded remover is gone");
  for (const helper of ["write", "wipe"]) {
    const body = source.slice(source.indexOf(`function ${helper}(`), source.indexOf(`function ${helper}(`) + 400);
    assert.match(body, /catch/, `${helper}() no longer catches a rejected write`);
    assert.match(body, /#saved/, `${helper}() catches the failure and says nothing about it`);
  }

  // No write may bypass them. The two inside the helpers are the exception.
  const direct = source.split(/\r?\n/)
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /chrome\.storage\.local\.(set|remove)\(/.test(line))
    .filter(([n]) => n > 15); // the helpers themselves sit at the top of the file
  assert.deepEqual(direct.map(([n]) => n), [],
    `these lines write to storage without reporting a failure: ${direct.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`);
});

test("Raw mode leaves no trace on LinkedIn's own nodes", () => {
  // The dim tooltip was set with no else branch and never cleared, so a stale
  // "maybe useful (44/100)" survived re-scoring and Raw mode — which promises
  // the feed exactly as it was.
  const source = read("content.js");
  const strip = source.slice(source.indexOf("function stripDecoration"));
  assert.ok(/removeAttribute\("title"\)/.test(strip.slice(0, 500)),
    "stripDecoration leaves the Clean Slate tooltip on the post");

  const decorate = source.slice(source.indexOf("function applyDecoration"));
  assert.ok(/else if[\s\S]{0,120}removeAttribute\("title"\)/.test(decorate.slice(0, 1200)),
    "the dim tooltip is set without ever being cleared");
});

test("a dismissible panel is closed, never just removed", () => {
  // makeDismissible attaches a capture-phase keydown listener to the document.
  // Reopening the review pane and clearing the breakage banner both called
  // .remove(), which detaches the panel and leaves the listener attached — one
  // per reopen, for the life of the tab.
  const source = read("content.js");
  assert.match(source, /function dismissPanel\(/, "the teardown helper is gone");
  assert.match(source, /panel\.__csClose = close;/, "makeDismissible no longer exposes its close()");

  for (const panel of ["cs-review", "cs-breakage"]) {
    // Plain string search: a regex here has been mangled by escaping twice
    // already, and this only ever needs to find one literal call shape.
    assert.ok(!source.includes(`querySelector(".${panel}")?.remove()`),
      `.${panel} is being removed instead of closed, leaking its keydown listener`);
  }
});

// ---------- the images the repository ships ----------

// The mockups in assets/sources are hand-built copies of the markup content.js
// produces, which is the whole reason they can lie. They have twice: the README
// image showed four card actions when the shipped card had five, and it went on
// saying "Fold" and "Hide this author" after both were renamed. Nothing noticed
// either time.
//
// So every control label in the mockup has to exist in the code that renders the
// real one. This does not prove the layout matches, only the words, which is
// where both drifts actually showed up.
test("every control in the screenshot mockup exists in the product", () => {
  const mockup = readRoot("assets/sources/feed.html");
  const rendered = read("content.js") + read("runtime.js");

  const decode = (text) => text
    .replace(/&#9733;/g, "★")
    .replace(/&middot;/g, "·")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .trim();

  const labels = [...mockup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => decode(m[1]));

  // The verdict lines are not buttons, and both of them drifted.
  const toplines = [
    ...mockup.matchAll(/class="cs-card__topline">\s*<span>([^<]+)<\/span>/g),
    ...mockup.matchAll(/class="cs-digest__topline">([^<]+)</g)
  ].map((m) => decode(m[1]));

  // A regex that silently matches nothing would pass every assertion below.
  assert.ok(labels.length >= 9, `only found ${labels.length} buttons in the mockup; the markup shape changed`);
  assert.equal(toplines.length, 2, "the mockup no longer has both verdict lines");

  for (const label of [...labels, ...toplines]) {
    assert.ok(rendered.includes(`"${label}"`),
      `the mockup shows "${label}", which content.js and runtime.js never render`);
  }
});

// The store rejects a promo tile or a screenshot at the wrong size, and it says
// so at upload rather than while anyone is looking at the file. `npm run shots`
// writes these; this catches one committed by hand.
test("the shipped images are exactly the sizes the store accepts", () => {
  const sizes = {
    "screenshot.png": [2400, 1620],
    "store-1280x800.png": [1280, 800],
    "promo-440x280.png": [440, 280],
    "promo-1400x560.png": [1400, 560],
    "store-logo-300x300.png": [300, 300]
  };

  for (const [name, [width, height]] of Object.entries(sizes)) {
    const png = fs.readFileSync(path.join(REPO_ROOT, "assets", name));
    assert.equal(png.readUInt32BE(0), 0x89504e47, `${name} is not a PNG`);
    assert.equal(png.readUInt32BE(16), width, `${name} is ${png.readUInt32BE(16)} wide, not ${width}`);
    assert.equal(png.readUInt32BE(20), height, `${name} is ${png.readUInt32BE(20)} tall, not ${height}`);

    // Colour type 6 is RGBA. The store refuses an alpha channel on promo tiles.
    assert.notEqual(png[25], 6, `${name} carries an alpha channel, which the store rejects`);
  }
});

// ---------- what a stranger meets ----------

test("the popup fits in the window Chrome gives it", () => {
  // Chrome caps an extension popup at 600px. It was 901px, so review, reveal,
  // pause, help, privacy and Preferences all sat below a cut most people never
  // scroll past — everything a person opens the popup TO DO.
  //
  // This models the layout from the real stylesheet, which is a model and not a
  // rendering. The first version of it silently omitted the two .label rows that
  // are in the markup, so it was measuring a popup that did not exist and
  // happened to land near the right answer. The fix that matters is not a better
  // formula, it is the completeness check at the bottom: every top-level child of
  // <main> must be accounted for, so markup the model does not know about fails
  // rather than disappearing.
  //
  // Anchor, measured in Chrome at 320px with Jost loaded: 581px.
  const css = read("popup.css");
  const html = read("popup.html");

  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  const num = (selector, prop, fallback = 0) => {
    const m = rule(selector).match(new RegExp(prop + ":\\s*([\\d.]+)px"));
    return m ? Number(m[1]) : fallback;
  };
  const minH = (selector) => num(selector, "min-height", 34);
  const label = () => num(".label", "font-size", 12) + 7; // text plus its margin

  // Keyed by the class or id the element carries in popup.html.
  const heightOf = {
    masthead: () => Math.max(30, num(".masthead h1", "font-size", 21) * 1.05 + 20),
    "page-status": () => num(".status", "padding", 9) * 2 + 2 + num(".status", "font-size", 13) * 1.4,
    "mode-group-block": () => label() + minH(".mode-group button") * 2 + num(".mode-group", "gap", 5)
      + 7 + num(".help", "font-size", 13) * 1.4,
    actions: () => minH(".secondary") * 3 + num(".actions", "gap", 6) * 2,
    "profile-block": () => label() + minH("#profile"),
    counts: () => num(".counts strong", "font-size", 23) * 1.15 + num(".counts span", "font-size", 12) * 1.4,
    footlinks: () => num(".footlinks", "font-size", 13) * 1.45,
    preferences: () => minH(".preferences"),
    "learned-nudge": () => minH(".nudge")
  };

  // The top-level children of <main>, in document order.
  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  const children = [...main.matchAll(/^      <(\w+)([^>]*)>/gm)].map(([, tag, attrs]) => {
    const cls = (attrs.match(/class="([^"]+)"/) || [, ""])[1].split(/\s+/);
    const id = (attrs.match(/id="([^"]+)"/) || [, ""])[1];
    if (cls.includes("masthead")) return "masthead";
    if (id === "page-status") return "page-status";
    if (id === "learned-nudge") return "learned-nudge";
    if (cls.includes("actions")) return "actions";
    if (cls.includes("counts")) return "counts";
    if (cls.includes("footlinks")) return "footlinks";
    if (id === "preferences") return "preferences";
    if (cls.includes("group")) return main.includes("mode-group") && main.indexOf("mode-group") < main.indexOf('id="profile"')
      && main.slice(0, main.indexOf(attrs)).includes('id="profile"') ? "profile-block" : null;
    return null;
  });

  // Two .group blocks, told apart by what they contain.
  const groups = [...main.matchAll(/<div class="group">([\s\S]*?)<\/div>\s*(?=<)/g)];
  const resolved = [];
  let groupIndex = 0;
  for (const name of children) {
    if (name !== null) { resolved.push(name); continue; }
    const inner = groups[groupIndex++]?.[1] || "";
    resolved.push(inner.includes("mode-group") ? "mode-group-block" : "profile-block");
  }

  // Completeness: anything in the markup the model cannot measure is a failure,
  // not a silent omission.
  for (const name of resolved) {
    assert.ok(heightOf[name], `popup.html has a top-level element the height model does not know about: ${name}`);
  }
  assert.ok(resolved.includes("masthead") && resolved.includes("actions") && resolved.includes("preferences"),
    "the popup markup no longer parses into the parts this test measures");

  const pad = num("main", "padding", 18);
  const gap = num("main", "gap", 14);
  // The nudge ships hidden and replaces the status line when it appears, so the
  // worst case swaps one for the other rather than stacking them.
  const visible = resolved.filter((name) => name !== "learned-nudge");
  const total = visible.reduce((sum, name) => sum + heightOf[name](), 0)
    + gap * (visible.length - 1) + pad * 2;
  const worst = total - heightOf["page-status"]() + heightOf["learned-nudge"]();

  // The model runs about 2% under what Chrome actually renders — checked at
  // 320px with Jost loaded, where it laid out to 581px against a modelled 569.
  // Under-estimating is the unsafe direction for a cap, so the assertion leaves
  // room for the modelling error rather than pretending there is none.
  const MODEL_ERROR = 1.05;
  assert.ok(worst * MODEL_ERROR <= 600,
    `the popup lays out to ${Math.round(worst)}px with the nudge showing, ` +
    `${Math.round(worst * MODEL_ERROR)}px allowing for model error; Chrome caps it at 600px`);

  // And the actions must come before the counters, not after.
  assert.ok(resolved.indexOf("actions") < resolved.indexOf("counts"),
    "the counters are above the actions again");
  assert.ok(resolved.indexOf("preferences") > resolved.indexOf("actions"),
    "the popup order changed; re-check what falls below 600px");
});

test("the popup's feed-only actions say so instead of failing silently", () => {
  const source = read("popup.js");
  assert.match(source, /reveal\.disabled = !onLinkedIn/,
    "Reveal is live off a LinkedIn tab, where it does nothing at all");
  assert.match(source, /reveal\.title = onLinkedIn/, "the disabled control does not say why");
  // Review works everywhere now, so it must NOT be disabled.
  assert.ok(!/\$\("#review"\)\.disabled/.test(source),
    "Review is being disabled; it is its own page and works from any tab");
});

test("the privacy page and the policy agree on when they were written", () => {
  // A privacy page with no date gives a reader no way to tell whether it
  // describes the build they installed.
  const md = readRoot("PRIVACY.md").match(/Last updated: ([\d-]+)/);
  const html = read("privacy.html").match(/Last updated: ([\d-]+)/);
  assert.ok(md, "PRIVACY.md no longer carries a date");
  assert.ok(html, "privacy.html carries no date");
  assert.equal(html[1], md[1], `privacy.html says ${html[1]} and PRIVACY.md says ${md[1]}`);
});

test("every class the shipped pages use is styled", () => {
  // class="help" was used twenty-five times across three pages with no rule
  // anywhere, so all of those paragraphs fell back to the browser's default.
  const css = read("options.css") + read("popup.css");
  for (const file of ["help.html", "privacy.html", "options.html", "review.html", "popup.html"]) {
    const html = read(file);
    const classes = new Set([...html.matchAll(/class="([^"]+)"/g)]
      .flatMap(([, value]) => value.split(/\s+/))
      .filter(Boolean));
    for (const name of classes) {
      assert.ok(css.includes("." + name),
        `${file} uses class="${name}", which no stylesheet defines`);
    }
  }
});

test("help explains the things that had no explanation anywhere", () => {
  const help = read("help.html");
  for (const [topic, pattern] of [
    ["where the sidebar went", /sidebar/i],
    ["pausing", /Pause on LinkedIn/],
    ["export and import", /Import/],
    ["that the feed buttons need a hover", /touchscreen/i]
  ]) {
    assert.match(help, pattern, `help.html never explains ${topic}`);
  }
});

test("the breakage banner offers a route that needs no GitHub account", () => {
  // It linked the issue form and nothing else, and a Chrome Web Store user has
  // no reason to have a GitHub account.
  const source = read("content.js");
  const banner = source.slice(source.indexOf("function showBreakageBanner"));
  assert.match(banner.slice(0, 2000), /mailto:/, "the banner offers only a GitHub issue");
  assert.ok(readRoot("SECURITY.md").includes("cs-oss@triberoi.com"),
    "the address the banner uses is not the one the project publishes");
});

test("the welcome card says only what is true", () => {
  // It is the first thing a new user reads, and it described one rail when the
  // defaults hide two, and offered no route to changing the topics it names.
  const source = read("content.js");
  const engine = require("../extension/engine.js");
  const card = source.slice(source.indexOf("defaults.textContent"), source.indexOf("defaults.textContent") + 500);

  // Both rails are hidden by default, so the card cannot mention only one.
  assert.equal(engine.SETTINGS_DEFAULTS.hideRightRail, true);
  assert.equal(engine.SETTINGS_DEFAULTS.hideLeftRailExtras, true);
  assert.match(card, /right-hand rail and some left sidebar/,
    "the card names one rail while the defaults hide two");

  // And it has to say where the topics can be changed.
  assert.match(card, /Preferences/, "the card names the starting topics with no route to changing them");
});

test("every page carries the mark", () => {
  // The space it sits in used to hold "CLEAN SLATE / HELP" above a heading that
  // said Help.
  for (const page of ["help.html", "privacy.html", "options.html", "review.html"]) {
    const html = read(page);
    assert.match(html, /class="page-mark"/, `${page} has no logo`);
    assert.ok(!/class="eyebrow">Clean Slate \//.test(html),
      `${page} still has the "Clean Slate / …" eyebrow above its heading`);
  }
  assert.ok(read("options.css").includes(".page-mark"), "the mark is unstyled");
});

test("the controls on a page are big enough to hit", () => {
  // The buttons had no min-height at all, so each was as tall as a 13px line
  // box and sat 8px from the field beside it. Save was the only one with real
  // geometry; everything else was smaller for no reason.
  const css = read("options.css");
  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  const minHeight = (selector) => {
    const m = rule(selector).match(/min-height:\s*(\d+)px/);
    return m ? Number(m[1]) : 0;
  };

  for (const selector of [".add-row button,.data-actions button", ".add-row input", ".add-row select", ".save"]) {
    assert.ok(minHeight(selector) >= 40,
      `${selector} is ${minHeight(selector) || "un"}sized; a control needs a real target height`);
  }

  // And the rows need air between themselves and the text above.
  for (const selector of [".add-row", ".data-actions"]) {
    const m = rule(selector).match(/margin-top:\s*(\d+)px/);
    assert.ok(m && Number(m[1]) >= 16, `${selector} sits too close to the text above it`);
  }
});

// GPL-3.0 asks for the licence text to travel with the work, and a zip handed to
// someone is a distribution. LICENSE lives at the repository root rather than in
// extension/, so it only travels if the packager is told about it by name.
test("the zips carry the licence text", () => {
  const packager = readRoot(path.join("tools", "package.mjs"));
  const list = packager.match(/const SHIP_ROOT = \[([^\]]*)\]/);
  assert.ok(list, "package.mjs no longer names any root files to ship");
  assert.ok(/"LICENSE"/.test(list[1]), "the packaged zips would ship GPL-3.0 code with no licence text");
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "LICENSE")), "LICENSE is missing from the repository root");
});

// package.json drives npm; manifest.json drives the browser and names both zips.
// They drifted apart silently the first time a release was cut, and the version
// a user reports is the manifest's.
test("the packaged version and the project version agree", () => {
  const manifest = JSON.parse(read("manifest.json")).version;
  const pkg = JSON.parse(readRoot("package.json")).version;
  assert.equal(pkg, manifest, "package.json and manifest.json disagree about the version");
});

