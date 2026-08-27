// Wiring between the extension's four surfaces: popup, options page, content
// script, service worker.
//
// These are the failures that a unit test of the scoring engine can never catch
// and that only show up when you click the thing — a button whose id was renamed
// in the HTML, a message type nobody listens for, a class the CSS never styles.
// They are cheap to check statically, so they are checked here rather than being
// carried as manual-verification debt.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { engine, EXTENSION_DIR, shippedDetection } = require("./helpers.js");
const runtime = require("../extension/runtime.js");

const read = (file) => fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");

/** Every `$("#id")` / getElementById("id") a script reaches for. */
function idsUsedBy(file) {
  const source = read(file);
  const ids = new Set();
  for (const match of source.matchAll(/\$\(\s*["'`]#([A-Za-z0-9_-]+)["'`]\s*\)/g)) ids.add(match[1]);
  for (const match of source.matchAll(/getElementById\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)) ids.add(match[1]);
  return [...ids];
}

/** Every `id="..."` a document declares. */
function idsDeclaredBy(file) {
  return new Set([...read(file).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every "clean-slate:*" message literal in a file. */
function messagesIn(file) {
  return new Set([...read(file).matchAll(/["'`](clean-slate:[a-z-]+)["'`]/g)].map((m) => m[1]));
}

// ---------- popup ----------

test("every element the popup script reaches for exists in popup.html", () => {
  const declared = idsDeclaredBy("popup.html");
  for (const id of idsUsedBy("popup.js")) {
    assert.ok(declared.has(id), `popup.js uses #${id}, which popup.html does not declare`);
  }
});

test("the popup's mode buttons cover exactly the modes the engine scores", () => {
  const buttons = [...read("popup.html").matchAll(/data-mode="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons.sort(), ["digest", "discover", "focus", "raw"]);

  // Every mode needs copy in the popup, or selecting it blanks the help line.
  const copy = read("popup.js").match(/const modeCopy = \{([\s\S]*?)\};/);
  assert.ok(copy, "popup.js no longer declares modeCopy");
  for (const mode of buttons) {
    assert.ok(new RegExp(`\\b${mode}\\s*:`).test(copy[1]), `modeCopy has no entry for "${mode}"`);
  }

  // Every non-raw mode needs a threshold, or decide() silently falls back to 45.
  for (const mode of buttons.filter((m) => m !== "raw")) {
    assert.ok(mode in engine.SETTINGS_DEFAULTS.thresholdByMode, `mode "${mode}" has no default threshold`);
  }
});

test("the page-cleanup toggles live in preferences, and something reads them", () => {
  // They were in the popup as well, which is 110px of a 600px cap spent on
  // checkboxes that are settings rather than actions. Preferences already had
  // them, so the popup copy was duplication, not a second route.
  const options = read("options.html");
  const readers = { hideLeftRailExtras: "content.js", hideRightRail: "content.js", structuralFiltering: "engine.js" };
  for (const [field, reader] of Object.entries(readers)) {
    assert.ok(field in engine.SETTINGS_DEFAULTS, `${field} is not a known setting`);
    assert.ok(read("options.js").includes(field), `options.js never writes ${field}`);
    assert.ok(read(reader).includes(field), `${reader} never reads ${field}, so the toggle would do nothing`);
  }
  assert.ok(/id="right-rail"/.test(options) && /id="left-rail"/.test(options),
    "preferences no longer offers the cleanup toggles, so nothing does");
  assert.ok(!read("popup.html").includes("rail-toggle"),
    "the popup carries the cleanup toggles again; it has 600px and they are settings");
});

// ---------- options page ----------

test("every element the options script reaches for exists in options.html", () => {
  const declared = idsDeclaredBy("options.html");
  for (const id of idsUsedBy("options.js")) {
    assert.ok(declared.has(id), `options.js uses #${id}, which options.html does not declare`);
  }
});

test("the learning section the options page renders into exists", () => {
  // A missing id here throws at load time and takes the whole preferences page
  // with it, because these are wired up at the top level of options.js.
  const declared = idsDeclaredBy("options.html");
  for (const id of ["learned-summary", "learned-pos", "learned-neg", "reset-model"]) {
    assert.ok(declared.has(id), `options.html is missing #${id}`);
  }
});

test("the options page still labels judgements the way the docs describe", () => {
  assert.match(read("options.js"), /Learned from \$\{total\} judgement/,
    "the learning summary copy changed — update the docs that quote it");
});

test("the options chip lists cover every list-shaped setting", () => {
  const source = read("options.js");
  for (const field of ["interests", "mutedPhrases", "allowedAuthors", "blockedAuthors"]) {
    assert.ok(Array.isArray(engine.SETTINGS_DEFAULTS[field]), `${field} is not a list setting`);
    assert.ok(source.includes(`chips("${field}")`), `options.js never renders chips for ${field}`);
  }
});

// ---------- messaging ----------

test("every message the popup sends is handled somewhere", () => {
  const handled = new Set([...messagesIn("content.js"), ...messagesIn("background.js")]);
  for (const message of messagesIn("popup.js")) {
    assert.ok(handled.has(message), `popup.js sends ${message}, which nothing handles`);
  }
});

test("the content script handles every message that drives its UI", () => {
  const handled = messagesIn("content.js");
  for (const message of ["clean-slate:ping", "clean-slate:refresh", "clean-slate:reveal-all"]) {
    assert.ok(handled.has(message), `content.js no longer handles ${message}`);
  }
  // clean-slate:review is absent: the review page is its own extension page
  // now, so the popup opens a URL instead of messaging a tab.
  assert.ok(!handled.has("clean-slate:review"),
    "the review page is being injected into LinkedIn's DOM again");
});

test("reveal-all puts the feed back itself", () => {
  // The bug this pins down: "Reveal hidden posts" called resetAll() and stopped.
  // resetAll() strips every card, toolbar and verdict label off the feed, and
  // restoring them was left to the MutationObserver, which defers its work to an
  // animation frame. A tab that is not being rendered never grants one, so the
  // feed stayed stripped of every Clean Slate control until a reload.
  //
  // Both message handlers that strip the feed must put it back without help.
  const source = read("content.js");
  const handlers = [...source.matchAll(/message\.type === "(clean-slate:(?:refresh|reveal-all))"\)\s*\{([\s\S]*?)\n    \}/g)];
  assert.equal(handlers.length, 2, "expected a refresh handler and a reveal-all handler");
  for (const [, message, body] of handlers) {
    assert.ok(/\bresetAll\(/.test(body), `${message} no longer resets — this test is checking the wrong thing`);
    assert.ok(/\bprocessAll\(/.test(body),
      `${message} strips the feed but never re-processes it, so nothing comes back until a reload`);
  }
});

test("the observer's coalescing latch cannot stick", () => {
  // Same failure, one level down. The latch is set before the work is scheduled,
  // so whatever releases it must be guaranteed to run — an animation frame is
  // not, in a tab that is not being rendered. A stuck latch swallows every
  // mutation for the rest of the page's life, which means React can wipe our
  // decorations and nothing ever puts them back.
  const source = read("content.js");
  const scheduler = source.match(/const schedule = \(\) => \{[\s\S]*?\n    \};/);
  assert.ok(scheduler, "content.js no longer has a schedule() for the MutationObserver");
  assert.ok(/requestAnimationFrame\(/.test(scheduler[0]), "the scheduler no longer coalesces to a frame");
  assert.ok(/setTimeout\(/.test(scheduler[0]),
    "requestAnimationFrame is the only thing that can release the latch — a hidden tab never grants a frame");
  assert.ok(/scheduled = false/.test(scheduler[0]), "the latch is never released");
});

test("the review page is reachable from the popup, and from any tab", () => {
  // It used to be a panel injected by the content script, so both popup buttons
  // that reached it were silent no-ops anywhere except a LinkedIn tab — and the
  // hidden-post log had exactly one viewer in the whole product.
  assert.ok(idsDeclaredBy("popup.html").has("review"), "popup.html has no #review button");
  assert.match(read("popup.js"), /\$\("#review"\)\.addEventListener[\s\S]{0,200}review\.html/,
    "the #review button no longer opens the review page");

  const manifest = JSON.parse(read("manifest.json"));
  const declared = [
    manifest.options_page,
    manifest.action.default_popup,
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources)
  ];
  assert.ok(fs.existsSync(path.join(EXTENSION_DIR, "review.html")), "review.html does not exist");
  assert.ok(fs.existsSync(path.join(EXTENSION_DIR, "review.js")), "review.js does not exist");
  assert.ok(declared.length > 0, "the manifest declares nothing");
});

test("both review verdicts are counted, and only when they teach something", () => {
  // The counters used to move on every press while train() early-returned on a
  // repeat, so re-reading the same row drifted the one number help.html
  // describes as how often you agreed.
  const source = read("review.js");
  for (const counter of ["reviewGood", "reviewBad"]) {
    assert.ok(source.includes(counter), `review.js never touches ${counter}`);
    assert.ok(counter in engine.SETTINGS_DEFAULTS.stats, `${counter} is not a declared stat`);
  }
  assert.match(source, /const learned = Boolean\(next\);/,
    "review.js no longer checks whether the verdict actually taught anything");
  assert.match(source, /if \(learned\) \{[\s\S]{0,200}reviewGood/,
    "the counters move whether or not the model learned");
});

test("neither review verdict is the primary button", () => {
  // A filled button reads as the one to press, which would bias the number the
  // two verdicts produce. Both stay plain.
  const source = read("review.js");
  const verdicts = source.slice(source.indexOf('button("Good call"'), source.indexOf('button("Good call"') + 300);
  assert.ok(verdicts.includes('button("Good call", ""'), '"Good call" gained a style class');
  assert.ok(verdicts.includes(`button("Shouldn't have", ""`), '"Shouldn\'t have" gained a style class');
  // The page still uses "danger" elsewhere, so this is a deliberate exception.
  assert.ok(source.includes('"danger"'), "the danger style vanished entirely");
});

test("the content script takes counters from the event rather than defending its own", () => {
  // It used to keep its own feed counters against every incoming write, which
  // meant a second feed tab's work was discarded and a long-lived tab pinned the
  // numbers to its own tally. Writes are deltas read from storage now, so the
  // event is the truth.
  const source = read("content.js");
  const at = source.indexOf("chrome.storage.onChanged.addListener");
  const listener = at > -1 ? source.slice(at, at + 4000) : null;
  assert.ok(listener, "content.js no longer listens for storage changes");
  assert.match(listener, /stats: \{ \.\.\.DEFAULTS\.stats, \.\.\.newStats \}/,
    "the listener defends its own counters again, which discards another tab's work");
  // Deleting all data must still reset them, and that path has no newValue.
  assert.match(listener, /\.\.\.DEFAULTS, stats: \{ \.\.\.DEFAULTS\.stats \}/,
    "there is no path back to zero for the key being removed");
});

test("the review page reports hide precision without calling it a keep rate", () => {
  // It only ever sees hidden posts, so it cannot measure a keep rate. Saying
  // otherwise would overstate what the number is.
  const source = read("review.js");
  assert.ok(source.includes("of these you agreed with"), "the scoreline copy changed");
  assert.ok(source.includes("you would have kept"), "the scoreline no longer reports the miss count");
  assert.ok(!/keep rate/i.test(source), "the scoreline calls itself a keep rate");
});

// ---------- profiles, decay, digest, nudge ----------

test("the profile picker is wired end to end", () => {
  // The popup switches profiles; the preferences page edits them. Both go
  // through settings.activeProfile, and engine.js is the only thing that turns
  // that into a verdict.
  assert.ok(idsDeclaredBy("popup.html").has("profile"), "popup.html has no profile picker");
  assert.match(read("popup.js"), /\$\("#profile"\)\.addEventListener[\s\S]{0,160}activeProfile/,
    "the popup's profile picker no longer writes activeProfile");

  for (const id of ["profile-select", "profile-name", "profile-add", "profile-rename", "profile-delete"]) {
    assert.ok(idsDeclaredBy("options.html").has(id), `options.html is missing #${id}`);
  }
  assert.ok("profiles" in engine.SETTINGS_DEFAULTS && "activeProfile" in engine.SETTINGS_DEFAULTS,
    "the settings shape no longer carries profiles");
});

test("only the topic lists are profile-scoped", () => {
  // People, page cleanup and the learned model are shared: "never
  // miss Jane" is a fact about Jane, not about which brain is reading. If this
  // list grows, the popup copy and the preferences page copy both need updating.
  const owned = read("options.js").match(/const PROFILE_OWNED\s*=\s*\[([^\]]*)\]/);
  assert.ok(owned, "options.js no longer declares PROFILE_OWNED");
  const keys = [...owned[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["interests", "mutedPhrases"]);
});

test("the decay control is wired to the setting the engine reads", () => {
  assert.ok(idsDeclaredBy("options.html").has("author-decay"), "options.html has no decay control");
  assert.ok(read("options.js").includes("authorDecayDays"), "options.js never writes authorDecayDays");
  assert.ok("authorDecayDays" in engine.SETTINGS_DEFAULTS && "authorMarks" in engine.SETTINGS_DEFAULTS,
    "the settings shape no longer carries the decay fields");
});

test("only Mute stamps an author, and it is the only control that blocks one", () => {
  // The asymmetry is the feature. Mute is a reaction to one author and fades;
  // "Never miss" promises the opposite in its own copy, so stamping it would
  // break that promise.
  //
  // "Less like this" used to be here too, writing blockedAuthors and a stamp —
  // byte for byte what Mute does, under a label of visibly different strength,
  // sitting beside a model-only "More like this" that implied symmetry. It is
  // model-only now, so muting an author has exactly one control.
  const source = read("content.js");
  assert.ok(source.includes("markAuthor"), "content.js no longer stamps authors at all");

  const bodyOf = (fn) => {
    const body = source.match(new RegExp(`function ${fn}\\(entry\\)[\\s\\S]*?\\n  \\}`));
    assert.ok(body, `content.js no longer has ${fn}()`);
    return body[0];
  };

  assert.match(bodyOf("muteAuthor"), /markAuthor\(/, "Mute no longer stamps, so its judgement never fades");
  assert.match(bodyOf("muteAuthor"), /blockedAuthors/, "Mute no longer blocks the author");
  assert.ok(!/markAuthor\(/.test(bodyOf("toggleNeverMiss")),
    "Never miss stamps an author, so it will fade despite promising it will not");

  const feedback = source.match(/function recordFeedback[\s\S]*?\n  \}/)[0];
  const less = feedback.slice(feedback.indexOf('kind === "less"'));
  assert.ok(!/blockedAuthors|markAuthor/.test(less.slice(0, 500)),
    '"Less like this" edits a people list again; it is the mirror of "More like this"');
});

test("digest mode renders one summary rather than a card per post", () => {
  // The whole point of the mode: a briefing is a few posts plus one line
  // standing in for the rest, not thirty cards.
  const source = read("content.js");
  const css = read("content.css");

  assert.ok(source.includes("digestMode"), "content.js no longer knows about digest mode");
  assert.match(source, /const wantCard = wantHide && !digestMode\(\)/,
    "digest mode no longer suppresses the per-post hidden card");
  assert.ok(source.includes("applyDigest("), "nothing builds the digest summary");
  assert.ok("digest" in engine.SETTINGS_DEFAULTS.thresholdByMode, "digest has no threshold");

  // The collapsed posts must actually take no space, and the summary must
  // survive the rule that hides a hidden post's children.
  assert.match(css, /\.cs-collapsed \{[^}]*display:none/, ".cs-collapsed does not hide anything");
  assert.match(css, /\.cs-hidden-post > \*:not\(\.cs-card\):not\(\.cs-digest\)/,
    "the hide rule would hide the digest summary along with the post");
});

test("the digest host is explicitly un-collapsed each pass", () => {
  // Found by walking the app. The host changes as posts mount and unmount, and
  // add() never took the class back off, so a node that had been collapsed on an
  // earlier pass stayed display:none once it became the host — carrying the
  // summary down with it. The feed then showed the kept posts and NOTHING saying
  // a dozen others had been hidden, which is the one thing digest mode exists to
  // say. toggle() is the fix, and the whole fix.
  const source = read("content.js");
  const fn = source.match(/function applyDigest[\s\S]*?\n  \}/);
  assert.ok(fn, "content.js no longer has applyDigest()");
  assert.match(fn[0], /classList\.toggle\("cs-collapsed"/,
    "applyDigest sets cs-collapsed without a matching path that clears it on the host");
  assert.ok(!/classList\.add\("cs-collapsed"/.test(fn[0]),
    "a bare add() leaves the class on a node that later becomes the host");
});

test("promoting a learned word writes that word and nothing else", () => {
  // The + beside a learned word is the one control that writes without waiting
  // for Save. It used to store the whole in-memory settings object, so clicking
  // it also committed every other unsaved edit on the page — an abandoned
  // rename, or a profile deletion the user had not decided on.
  const source = read("options.js");
  const promote = source.match(/async function promoteWord[\s\S]*?\n\}/);
  assert.ok(promote, "options.js no longer has promoteWord()");
  assert.match(promote[0], /await chrome\.storage\.local\.get\(KEY\)/,
    "promoteWord writes without first reading what is actually stored");
  assert.ok(!/set\(\{\[KEY\]:settings\}\)/.test(promote[0]),
    "promoteWord still writes the whole in-memory settings object");

  // And the chips are wired to it rather than to their own inline writer.
  assert.match(source, /learnedChip\(posEl,t,w,\(\)=>promoteWord\("interests",t\)/);
  assert.match(source, /learnedChip\(negEl,t,w,\(\)=>promoteWord\("mutedPhrases",t\)/);

  // Each chip also offers to forget just that word. Wiping the whole model was
  // the only way to remove one before.
  assert.match(source, /async function forgetWord/, "options.js cannot forget a single word");
  assert.match(source, /learnedChip\([a-z]+El,t,w,[^;]*forgetWord\(t\)\)/,
    "the chips are not wired to forgetWord");
});

test("the learned-words nudge has something to count and somewhere to go", () => {
  // The inspector existed before this and nothing pointed at it. The counter is
  // what stops the nudge repeating forever once you have looked.
  assert.ok("learnedAcknowledged" in engine.SETTINGS_DEFAULTS.stats,
    "there is no acknowledgement counter, so the nudge cannot ever stop");
  assert.ok(idsDeclaredBy("popup.html").has("learned-nudge"), "popup.html has no nudge element");

  const popup = read("popup.js");
  assert.ok(popup.includes("learnedAcknowledged"), "the popup never reads the acknowledgement counter");

  // To the SECTION, not the top of an eight-section page. openOptionsPage cannot
  // carry a fragment, which is why this opens the URL itself.
  assert.match(popup, /\$\("#learned-nudge"\)\.addEventListener[\s\S]{0,220}options\.html#learned/,
    "the nudge no longer lands on the section it is nudging you towards");
  assert.ok(read("options.html").includes('id="learned"'),
    "options.html has no #learned anchor, so the nudge lands at the top of the page");

  assert.match(read("options.js"), /learnedAcknowledged:\s*total/,
    "the preferences page never marks the learned words as seen, so the nudge never clears");
});

test("the service worker answers the settings messages the popup depends on", () => {
  const handled = messagesIn("background.js");
  assert.ok(handled.has("clean-slate:get-settings"));
  assert.ok(handled.has("clean-slate:update-settings"));
});

// ---------- the popup status line ----------

test("the popup reports which detection config is live", () => {
  // This line is how you tell, at a glance, whether detection.json loaded or the
  // built-in fallback is in use. Its shape is a contract between the two files.
  assert.match(read("content.js"), /strategy: `detection \$\{det\.version\} \(\$\{det\.locale\}\)`/,
    "the strategy string changed shape");
  // It rides on the status line's title rather than in its text: the sentence
  // wrapped to a second line, and the popup has 600px to spend.
  assert.match(read("popup.js"), /title = response\?\.strategy \? `[^`]*\$\{response\.strategy\}/,
    "the popup no longer reports the strategy string anywhere");

  const det = shippedDetection("en");
  assert.equal(`detection ${det.version} (${det.locale})`, `detection ${det.version} (en)`);
  assert.notEqual(det.version, "built-in", "shipped detection.json must not report itself as the fallback");

  // And the fallback identifies itself, so a failed fetch is visible in the popup.
  const fallback = engine.compileDetection(engine.DETECTION_DEFAULTS, "en");
  assert.equal(`detection ${fallback.version} (${fallback.locale})`, "detection built-in (en)");
});

// ---------- feed actions say what they do, and can be taken back ----------

test("every hidden-card action is a different action", () => {
  // "More like this" and "Always show author" used to be the same code path, so
  // a soft-sounding button pinned an author permanently. That was fixed, and the
  // same fault reappeared one button along: "Less like this" and "Mute" were
  // byte-for-byte identical writes under labels of visibly different strength.
  const source = read("content.js");
  const feedback = source.match(/function recordFeedback[\s\S]*?\n  \}/)[0];

  const more = feedback.slice(feedback.indexOf('kind === "more"'), feedback.indexOf('kind === "always"'));
  assert.ok(!/allowedAuthors|blockedAuthors/.test(more),
    '"More like this" still edits a people list; it should teach the model only');
  assert.match(more, /train\(entry\.post, "pos"\)/, '"More like this" no longer teaches anything');

  const less = feedback.slice(feedback.indexOf('kind === "less"'));
  assert.ok(!/allowedAuthors|blockedAuthors/.test(less.slice(0, 500)),
    '"Less like this" edits a people list again, which makes it Mute under a gentler label');
  assert.match(less, /train\(entry\.post, "neg"\)/, '"Less like this" no longer teaches anything');

  const always = feedback.slice(feedback.indexOf('kind === "always"'), feedback.indexOf('kind === "less"'));
  assert.match(always, /allowedAuthors/, '"Never miss this author" no longer pins the author');

  // And the card offers Mute directly, so the destructive action is named.
  assert.match(source, /makeButton\("Mute this author"/,
    "the hidden-post card has no way to mute an author under a label that says so");
});

test("anything that edits a people list offers to undo itself", () => {
  // Mute was one-way from the feed: the only route back was finding the name in
  // Preferences. Undo must reverse the list, the decay stamp and the training.
  const source = read("content.js");
  assert.match(source, /function offerUndo/, "there is no undo affordance");
  assert.match(source, /function untrain/, "undo cannot reverse what it taught the model");

  for (const fn of ["muteAuthor"]) {
    const body = source.match(new RegExp(`function ${fn}\\(entry\\)[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /offerUndo\(/, `${fn} does not offer an undo`);
  }
  const feedback = source.match(/function recordFeedback[\s\S]*?\n  \}/)[0];
  assert.equal((feedback.match(/offerUndo\(/g) || []).length, 3,
    "each feedback action should offer its own undo");

  // Undo must clear the stamp too, or the entry stays half-removed.
  assert.match(source, /withoutMark\(/, "undo leaves the decay stamp behind");
});

test("untrain reverses exactly what train recorded", () => {
  // Reversing the list but not the model would leave it still learning the
  // opposite of what the user just took back. Run for real, not read.
  const tokens = ["hiring", "pipeline", "hiring"];
  const before = runtime.emptyModel();

  const trained = runtime.trainModel(before, "post-1", "neg", tokens);
  assert.equal(trained.negDocs, 1);
  assert.equal(trained.seen["post-1"], "neg");

  const reversed = runtime.untrainModel(trained, "post-1", "neg", tokens);
  assert.deepEqual(reversed, before, "untrain left something behind");
  assert.equal(reversed.seen["post-1"], undefined, "the post is still marked as seen");

  // Reversing something never recorded is a no-op, not a negative count.
  assert.equal(runtime.untrainModel(before, "never-judged", "neg", tokens), null);
  assert.equal(runtime.untrainModel(trained, "post-1", "pos", tokens), null,
    "untrain reversed a label that was never applied");
});

// ---------- dead ends ----------

test("the breakage banner links somewhere", () => {
  // It told people to file a bug report and linked nothing, leaving them with a
  // clipboard full of JSON and nowhere to put it.
  const source = read("content.js");
  const url = source.match(/const ISSUE_URL = "([^"]+)"/);
  assert.ok(url, "content.js has no issue URL");
  assert.match(url[1], /^https:\/\/github\.com\//, "the report link is not a GitHub URL");

  const template = url[1].match(/template=([\w.-]+)/);
  assert.ok(template, "the report link does not point at an issue template");
  assert.ok(fs.existsSync(path.join(EXTENSION_DIR, "..", ".github", "ISSUE_TEMPLATE", template[1])),
    `the report link names ${template[1]}, which does not exist`);
});

test("the review page can reach more than today", () => {
  // The log holds 200 hides and the pane showed only today's, so almost all of
  // its own evidence was unreachable — and it was empty every morning.
  const source = read("review.js");
  assert.match(source, /const RANGES = \{/, "the review page has no range control");
  for (const range of ["today", "week", "all"]) {
    assert.ok(new RegExp(`${range}:`).test(source), `the review page has no "${range}" range`);
  }
  assert.ok(read("review.html").includes('data-range="all"'), "the range control is not in the markup");

  // A verdict has to survive a range switch. It lived only in the DOM, so
  // switching Today to 7 days brought yesterday's judged rows back unmarked.
  assert.match(source, /judged: verdict/, "a verdict is no longer recorded on the entry");
  assert.match(source, /entry\.judged/, "the page never reads back what was already judged");

  // And the empty state must not count at a reader who has nothing yet: "the log
  // keeps the last 0 hidden posts" was the first thing a new user saw here. The
  // branch with no interpolation in it is the one an empty log takes.
  assert.match(source, /: "Nothing hidden yet\.[^"]*";/,
    "the empty-log copy interpolates a count again, or no longer has a branch of its own");
});

test("a single learned word can be forgotten", () => {
  const source = read("options.js");
  assert.match(source, /async function forgetWord/, "there is no way to forget one word");
  assert.match(source, /delete model\.pos\[token\];delete model\.neg\[token\]/,
    "forgetWord does not remove the token from both sides");
  assert.match(read("options.html"), /id="reset-model"/, "the wipe-everything control disappeared");
});

test("counters can be reset without deleting everything else", () => {
  assert.match(read("options.html"), /id="reset-counters"/, "there is no counter reset");
  const handler = read("options.js").match(/#reset-counters"\)\.addEventListener[\s\S]*?\n\}\);/)[0];
  assert.ok(!/remove\(/.test(handler), "resetting counters deletes stored keys");
  assert.match(handler, /learnedAcknowledged/,
    "resetting counters loses the acknowledgement, so the popup nudges again");
});

// ---------- the extension explains itself ----------

test("help is reachable from both surfaces", () => {
  // The privacy link shipped as inline body copy in the last section of a long
  // page, and nothing else pointed anywhere. Nobody found it.
  for (const [file, what] of [["popup.html", "popup"], ["options.html", "preferences"]]) {
    const html = read(file);
    assert.match(html, /href="help\.html"/, `the ${what} has no route to help`);
    assert.match(html, /href="privacy\.html"/, `the ${what} has no route to the privacy page`);
  }
  const help = read("help.html");
  for (const topic of ["Focus", "Discover", "Digest", "Raw", "Never miss", "fade", "profile"]) {
    assert.ok(new RegExp(topic, "i").test(help), `help.html never explains ${topic}`);
  }
});

test("the score breakdown does not depend on hover", () => {
  // It lived in a title attribute, so keyboard and touch users could not read
  // the reason for any decision — the product's central promise.
  const source = read("content.js");
  assert.match(source, /label = document\.createElement\("button"\)/,
    "the verdict label is not focusable");
  assert.match(source, /aria-expanded/, "the breakdown has no expanded state");
  assert.match(source, /function toggleBreakdown/, "there is no inline breakdown");
  assert.ok(read("content.css").includes(".cs-breakdown"), "the breakdown is unstyled");
});

test("the profile that produced a verdict is shown, not just recorded", () => {
  // decide() has always returned it and nothing read it. The breakdown builder
  // takes a result rather than an entry now, because the hidden-post card needs it too.
  assert.match(read("content.js"), /scored under \$\{result\.profile\}/,
    "result.profile is still dead data");
});

test("the score breakdown is reachable on a hidden post", () => {
  // It was built only on the toolbar, and the toolbar exists only when a post is
  // NOT hidden. So the single route to the arithmetic on a hidden post was
  // "Show post" — which shows it, teaches the model you wanted it, and moves a
  // counter. Finding out why something was hidden meant destroying the decision
  // you were asking about, on the product whose central claim is that it
  // explains itself.
  const source = read("content.js");
  assert.match(source, /function buildBreakdown\(result\)/,
    "the breakdown is not factored out, so only one surface can show it");

  const card = source.match(/function buildHiddenCard[\s\S]*?\n  \}/)[0];
  assert.match(card, /makeButton\("Why\?"/, "the hidden-post card offers no route to the arithmetic");
  assert.match(card, /aria-expanded/, "the hidden-post card's breakdown has no expanded state");

  // And it must not go through reveal(), which is what made this a trap.
  const toggle = source.match(/function toggleCardBreakdown[\s\S]*?\n  \}/)[0];
  assert.ok(!/reveal\(/.test(toggle), "opening the breakdown reveals the post, which teaches the model");
  assert.ok(!/incrementStat/.test(toggle), "opening the breakdown moves a counter");
});

test("people chips say where they came from and how long they have", () => {
  const source = read("options.js");
  assert.match(source, /function decayNote/, "chips carry no decay context");
  assert.match(source, /never fades/, "a typed entry is not distinguished from a judged one");
  assert.match(source, /fades in /, "a fading entry does not say how long it has left");
  assert.match(source, /pin/, "a fading entry cannot be pinned");
});

// ---------- styling ----------

test("every cs- class the content script applies is styled", () => {
  // An unstyled cs-hidden-post is an invisible no-op: the post stays fully visible and
  // the extension looks broken with no error anywhere.
  const source = read("content.js");
  const css = read("content.css");

  // Marker classes are hooks, not styles, and are exempt by name so that a
  // genuinely unstyled class still fails:
  //   cs-left-rail      remembers which <aside> was the left rail once it has
  //                     been measured, because a hidden rail has no geometry
  //                     left to re-measure on the next pass.
  //   cs-toolbar__star  is a querySelector hook for the ★ button; its styling
  //                     comes from cs-iconbtn / cs-iconbtn--active.
  const MARKERS = new Set(["cs-left-rail", "cs-right-rail", "cs-toolbar__star"]);

  const applied = new Set();
  for (const match of source.matchAll(/classList\.(?:add|toggle)\(\s*["'`](cs-[a-z-]+)["'`]/g)) applied.add(match[1]);
  for (const match of source.matchAll(/className\s*=\s*["'`]([^"'`]*cs-[^"'`]*)["'`]/g)) {
    for (const cls of match[1].split(/\s+/)) if (cls.startsWith("cs-")) applied.add(cls);
  }

  for (const cls of applied) {
    if (MARKERS.has(cls)) continue;
    assert.ok(css.includes(`.${cls}`), `content.js applies .${cls} but content.css never styles it`);
  }
});

test("the extension's dark palette keys off LinkedIn's own theme attribute", () => {
  const css = read("content.css");
  assert.ok(css.includes('body[data-color-scheme="dark"]'),
    "content.css no longer follows LinkedIn's explicit dark setting");
  assert.ok(css.includes("prefers-color-scheme:dark") || css.includes("prefers-color-scheme: dark"),
    "content.css has no OS-level dark fallback");
  assert.ok(css.includes('body:not([data-color-scheme="light"])'),
    "the OS fallback must not override an explicit light setting");
});

test("the popup and options pages both define a dark palette", () => {
  for (const file of ["popup.css", "options.css"]) {
    assert.ok(read(file).replace(/\s/g, "").includes("prefers-color-scheme:dark"),
      `${file} has no dark palette`);
  }
});

test("no colour is left hard-coded outside the token blocks", () => {
  // Dark mode works by swapping tokens; a literal hex in a rule body ignores the
  // swap and is exactly how a light-mode artefact survives into a dark feed.
  const offenders = [];
  for (const file of ["content.css", "popup.css", "options.css"]) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/\{([^{}]*)\}/g)) {
      // Strip the custom-property DEFINITIONS (`--x: #hex;`) and look at what is
      // left. Skipping any rule that merely mentions a token would let a literal
      // hex hide in a rule that also uses var() — which is exactly how a
      // hard-coded white slipped into the breakage button once.
      const body = rule[1].replace(/--[\w-]+\s*:[^;]*;?/g, "");
      for (const colour of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file}: ${colour[0]} in "${rule[1].trim().slice(0, 60)}…"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `hard-coded colours outside the token blocks:\n${offenders.join("\n")}`);
});

// ---------- the review page ----------

test("every element the review script reaches for exists in review.html", () => {
  const declared = idsDeclaredBy("review.html");
  for (const id of idsUsedBy("review.js")) {
    assert.ok(declared.has(id), `review.js uses #${id}, which review.html does not declare`);
  }
});

test("the review page reads its own data and writes it back safely", () => {
  const source = read("review.js");
  for (const key of ["cleanSlateSettings", "cleanSlateModel", "cleanSlateFoldLog"]) {
    assert.ok(source.includes(key), `review.js never touches ${key}`);
  }
  // Same rule as the preferences page: a refused write has to be visible.
  assert.match(source, /async function write\(/, "review.js writes without a guard");
  assert.ok(!/chrome\.storage\.local\.set\(/.test(source.replace(/async function write\([\s\S]*?\n\}/, "")),
    "review.js writes to storage outside its guarded writer");

  // Another surface can delete the log while this page is open.
  assert.match(source, /chrome\.storage\.onChanged\.addListener/,
    "the review page does not notice its data being deleted elsewhere");
});

test("a post hidden by a people list offers the only thing that would undo it", () => {
  // The row printed "Author you muted" and offered a verdict worth at most 18
  // against a -100 rule, so no number of presses could ever lift it.
  const source = read("review.js");
  assert.match(source, /isMuteReason\(entry\.reason\)/,
    "the review page no longer recognises a post hidden by the mute list");
  assert.match(source, /async function unblock\(/, "there is no way to unmute an author from here");
  assert.match(source, /blockedAuthors/, "unblock does not touch the mute list");
  assert.match(source, /authorMarks/, "unblock leaves the decay stamp behind");

  // And the reason string has to be the one the engine actually produces.
  const engineSource = read("engine.js");
  assert.ok(engineSource.includes('"Author you muted"'),
    "engine.js no longer produces the reason review.js matches on");
});

test("a log entry can point back at the post it hid", () => {
  // The page could not show you what it hid, because nothing captured a way
  // back to it.
  assert.match(read("content.js"), /a\[href\*='\/feed\/update\/'\]/,
    "content.js no longer captures the post permalink");
  assert.match(read("review.js"), /entry\.url/, "the review page never offers a link to the post");

  // Optional, so entries written before this still render.
  const runtime = require("../extension/runtime.js");
  const entry = runtime.hiddenLogEntry({ key: "k", author: "A", text: "some text here" }, { score: 1, reasons: [] }, 0);
  assert.ok(!("url" in entry), "a post with no permalink still writes a url field");
});

test("the feed says which of its two silent states it is in", () => {
  // Paused and broken look identical from the feed: nothing is filtered either
  // way, and help.html tells people to diagnose a break.
  const source = read("content.js");
  assert.match(source, /function showPausedMark/, "there is no paused indicator");
  assert.match(source, /showPausedMark\(settings\.enabled \? "Raw mode" : "Paused"\)/,
    "the indicator does not distinguish Raw mode from paused");
  assert.ok(read("content.css").includes(".cs-paused"), "the paused indicator is unstyled");
});

test("a runaway people list can be emptied without deleting everything", () => {
  const html = read("options.html");
  for (const list of ["allowedAuthors", "blockedAuthors"]) {
    assert.ok(html.includes(`data-clear="${list}"`), `${list} has no way to be emptied`);
  }
  assert.match(read("options.js"), /\[data-clear\]/, "the clear controls are not wired");
});

test("preferences says which of its writes wait for Save", () => {
  // Import, the resets and "Forget everything learned" happen immediately;
  // everything else waits. Nothing distinguished them, and the profile-delete
  // confirm reads as final while closing the tab undoes it.
  const source = read("options.js");
  assert.match(source, /function markDirty/, "the page has no unsaved-changes state");
  assert.ok(idsDeclaredBy("options.html").has("pending"), "options.html has no unsaved-changes notice");
  // Matches the intent, not the wording: pinning a sentence means every copy
  // edit breaks a test that is not about copy.
  const at = source.indexOf('$("#profile-delete").addEventListener');
  assert.ok(at > -1, "the profile-delete handler moved");
  const deleteConfirm = source.slice(at, at + 400);
  assert.match(deleteConfirm, /when you save/i,
    "the profile-delete confirm no longer says it waits for Save, while closing the tab still undoes it");
});

test("the welcome card names the real defaults rather than its own copy of them", () => {
  // The card tells a new user which topics it is about to score their feed
  // against. If it carries its own list, that list drifts from the one actually
  // in use and the first thing the product says is wrong.
  const source = read("content.js");
  const card = source.slice(source.indexOf("defaults.textContent"), source.indexOf("defaults.textContent") + 400);

  assert.match(card, /DEFAULTS\.interests/,
    "the welcome card hardcodes the starting topics instead of reading them");
  for (const topic of engine.SETTINGS_DEFAULTS.interests) {
    assert.ok(!card.includes(topic),
      `the welcome card has "${topic}" written into it, so it will not follow a change to the defaults`);
  }
});

// Judging a post you have already hidden must not put it back on screen. The
// reveal at the end of recordFeedback used to be unconditional, so "Less like
// this" — the one verdict that means you want it gone — was the control that
// undid the hide.
test("a negative verdict does not reveal the post it was passed on", () => {
  const flat = read("content.js").replace(/\s+/g, " ");
  assert.ok(/if \(kind !== "less"\) entry\.revealed = true;/.test(flat),
    'recordFeedback reveals the post for every verdict again, including "less"');
});

// The left rail keeps one box and hides the promotions around it. Which box to
// keep has to be decided by what the box contains, because a positional keep
// hides the user's own profile the day LinkedIn reorders the rail.
test("left-rail cleanup keeps the profile box by what it links to, not by position", () => {
  const flat = read("content.js").replace(/\s+/g, " ");
  assert.ok(!/\[\.\.\.level\.children\]\.slice\(1\)/.test(flat),
    "left-rail cleanup is keeping whichever box happens to be first again");
  assert.ok(/findIndex.{0,80}a\[href\*='\/in\/'\]/.test(flat),
    "nothing identifies the profile box by its member-profile link");
});

// Hide and Mute do different things — one post versus every post an author
// writes — and Hide used to be the silent one, which is what made them read as
// the same control.
test("hiding a post says what it did and offers the way back", () => {
  const source = read("content.js");
  const fn = source.slice(source.indexOf("function hideNow"), source.indexOf("// ---------- undo ----------"));
  assert.ok(/offerUndo\(/.test(fn), "hiding a post is silent again, and cannot be undone from the feed");
  assert.ok(/untrain\(/.test(fn), "undoing a hide leaves the model still trained against the post");
});

// renderNudge hides the status line to make room for the nudge. The status rule
// sets a display, which outranks the UA sheet's [hidden] { display: none }, so
// the hide did nothing and both notices rendered past the 600px Chrome allows.
test("the status line can actually be hidden", () => {
  const css = read("popup.css").replace(/\s+/g, " ");
  assert.ok(/\.status\[hidden\] \{ display:none; \}/.test(css),
    "a display on .status is overriding [hidden] again, so the nudge cannot take its place");
  assert.ok(css.indexOf(".status[hidden]") < css.indexOf(".status { display"),
    ".status[hidden] must not be outranked by the rule that follows it");
});

