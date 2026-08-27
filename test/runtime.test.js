// Behavioural tests for runtime.js — the decisions the content script makes.
//
// These exist because of a measurement. Before runtime.js, sixty-three
// deliberate breakages were introduced into content.js and thirty survived the
// whole suite, including onFeedPage() rewritten to always return true, Escape
// no longer closing anything, the hidden-post log losing its dedupe, and the verdict
// cache losing its bound. None of that was catchable: content.js touches
// chrome.* and document at parse time, so it cannot be required, and every
// assertion about it was a regex over its own source.
//
// Anything asserted here runs the shipped code against real inputs. Where a test
// below reads source text instead, that is a gap, not a style.

const test = require("node:test");
const assert = require("node:assert/strict");

const runtime = require("../extension/runtime.js");

// Every cap below drives a loop. Assert the value is sane BEFORE looping to it,
// or a mutation that raises a cap hangs the suite instead of failing it — which
// is worse than no test at all, because CI stalls rather than reports. Found by
// the mutation sweep: SEEN_CAP raised to 4e9 turned a two-second run into an
// unbounded one.
const boundedBy = (name, value, ceiling) => {
  assert.equal(typeof value, "number", `${name} is not a number`);
  assert.ok(value > 0 && value <= ceiling,
    `${name} is ${value}, outside the sane range (0, ${ceiling}]. A cap this size is not a cap.`);
  return value;
};

test("the caps are all small enough to mean something", () => {
  boundedBy("SEEN_CAP", runtime.SEEN_CAP, 5000);
  boundedBy("VOCAB_CAP", runtime.VOCAB_CAP, 50000);
  boundedBy("HIDDEN_LOG_CAP", runtime.HIDDEN_LOG_CAP, 2000);
  boundedBy("MAX_DECISIONS", runtime.MAX_DECISIONS, 5000);
  boundedBy("HIDDEN_TEXT", runtime.HIDDEN_TEXT, 2000);
  boundedBy("HIDDEN_SNIPPET", runtime.HIDDEN_SNIPPET, runtime.HIDDEN_TEXT);
  boundedBy("HEALTH_GRACE_MS", runtime.HEALTH_GRACE_MS, 120000);
});

// ---------- which pages count ----------

test("only the home feed counts as the feed", () => {
  const paths = ["/feed"];
  const admits = (p) => runtime.matchesFeedPath(p, paths);

  assert.ok(admits("/feed"));
  assert.ok(admits("/feed/"), "a trailing slash is the same page");
  assert.ok(admits("/feed///"), "browsers do produce repeated slashes");

  // Everything below the feed handles posts the policy says are never stored.
  assert.ok(!admits("/feed/hashtag/leadership/"));
  assert.ok(!admits("/feed/following/"));
  assert.ok(!admits("/feed/update/urn:li:activity:7498081285039501312/"));
  // And a path that merely starts with the same letters.
  assert.ok(!admits("/feedback"));
  assert.ok(!admits("/feeds"));
});

test("the feed gate cannot be talked into matching everything", () => {
  assert.ok(!runtime.matchesFeedPath("/jobs/", []), "an empty path list matched something");
  assert.ok(!runtime.matchesFeedPath("", ["/feed"]));
  assert.ok(!runtime.matchesFeedPath(undefined, ["/feed"]));
});

// ---------- settings ----------

test("loading settings fills in nested defaults a stored object never had", () => {
  const defaults = {
    enabled: true, mode: "discover",
    thresholdByMode: { focus: 70, discover: 45, digest: 68 },
    stats: { checked: 0, hidden: 0, dimmed: 0 }
  };
  // What an older version's stored settings look like: missing whole keys.
  const merged = runtime.mergeSettings(defaults, { mode: "focus", thresholdByMode: { focus: 80 }, stats: { checked: 12 } });

  assert.equal(merged.mode, "focus", "the stored value did not win");
  assert.equal(merged.thresholdByMode.focus, 80, "the stored threshold did not win");
  assert.equal(merged.thresholdByMode.discover, 45, "a threshold the stored object lacked was dropped");
  assert.equal(merged.stats.checked, 12);
  assert.equal(merged.stats.dimmed, 0, "a counter the stored object lacked was dropped");
  assert.equal(merged.enabled, true);
});

test("merging settings does not mutate the defaults", () => {
  const defaults = { thresholdByMode: { discover: 45 }, stats: { checked: 0 } };
  runtime.mergeSettings(defaults, { thresholdByMode: { discover: 99 }, stats: { checked: 5 } });
  assert.equal(defaults.thresholdByMode.discover, 45, "the defaults object was written through");
  assert.equal(defaults.stats.checked, 0);
});

test("a counter goes up by exactly one", () => {
  // Setting this to a constant survived the old suite, so the popup's numbers
  // could have frozen without a test noticing.
  assert.equal(runtime.bumpStat({ hidden: 4 }, "hidden").hidden, 5);
  assert.equal(runtime.bumpStat({}, "hidden").hidden, 1, "a counter that did not exist yet");
  assert.equal(runtime.bumpStat({ hidden: "nonsense" }, "hidden").hidden, 1, "a corrupt counter did not reset");

  const before = { hidden: 4, checked: 9 };
  const after = runtime.bumpStat(before, "hidden");
  assert.equal(before.hidden, 4, "the counters were mutated in place");
  assert.equal(after.checked, 9, "bumping one counter dropped another");
});

// ---------- author marks ----------

test("only the stamped author fades, and names are matched loosely", () => {
  const marks = runtime.stampAuthor({}, "  Jane   DOE ", 1000);
  assert.deepEqual(marks, { "jane doe": 1000 }, "the stamp is not normalised");

  const withTwo = runtime.stampAuthor(marks, "Sam Ortega", 2000);
  assert.deepEqual(runtime.unstampAuthor(withTwo, "JANE DOE"), { "sam ortega": 2000 });
  assert.deepEqual(runtime.unstampAuthor(withTwo, "nobody"), withTwo, "removing an absent name changed something");
});

// ---------- the learner ----------

test("the same verdict twice teaches nothing the second time", () => {
  // train() losing this guard survived the old suite. The review page's accuracy
  // figure and the +/-18 bound both rest on it.
  const first = runtime.trainModel(runtime.emptyModel(), "post-1", "pos", ["hiring", "pipeline"]);
  assert.equal(first.posDocs, 1);
  assert.equal(runtime.trainModel(first, "post-1", "pos", ["hiring", "pipeline"]), null,
    "the same post was counted twice under the same label");
});

test("changing your mind about a post is recorded", () => {
  const pos = runtime.trainModel(runtime.emptyModel(), "post-1", "pos", ["hiring"]);
  const neg = runtime.trainModel(pos, "post-1", "neg", ["hiring"]);
  assert.ok(neg, "a post could not be judged the other way");
  assert.equal(neg.seen["post-1"], "neg");
  assert.equal(neg.negDocs, 1);
});

test("training counts every occurrence of a token", () => {
  const model = runtime.trainModel(runtime.emptyModel(), "k", "pos", ["hiring", "hiring", "pipeline"]);
  assert.equal(model.pos.hiring, 2);
  assert.equal(model.pos.pipeline, 1);
  assert.equal(model.neg.hiring, undefined, "training one bag wrote into the other");
});

test("the remembered-posts list is bounded", () => {
  // Deleting this cap survived the old suite, and it is what stops the model
  // growing for the life of the install.
  let model = runtime.emptyModel();
  for (let i = 0; i < boundedBy("SEEN_CAP", runtime.SEEN_CAP, 5000) + 25; i++) {
    model = runtime.trainModel(model, "post-" + i, "pos", ["token" + i]);
  }
  assert.ok(Object.keys(model.seen).length <= runtime.SEEN_CAP,
    `seen grew to ${Object.keys(model.seen).length}, past the ${runtime.SEEN_CAP} cap`);
  assert.equal(model.seen["post-0"], undefined, "the oldest remembered post was kept");
  assert.equal(model.seen["post-" + (runtime.SEEN_CAP + 24)], "pos", "the newest was dropped instead");
});

test("the vocabulary is bounded, and drops singletons rather than common words", () => {
  let model = runtime.emptyModel();
  // One document carrying a huge vocabulary of one-off words, plus a word that
  // recurs often enough to be worth keeping.
  const common = ["signal"];
  for (let i = 0; i < 12; i++) model = runtime.trainModel(model, "common-" + i, "pos", common);

  const flood = Array.from({ length: boundedBy("VOCAB_CAP", runtime.VOCAB_CAP, 50000) + 100 }, (_, i) => "oneoff" + i);
  model = runtime.trainModel(model, "flood", "pos", flood);

  assert.ok(Object.keys(model.pos).length <= runtime.VOCAB_CAP + 1,
    `the vocabulary grew to ${Object.keys(model.pos).length}`);
  assert.equal(model.pos.signal, 12, "a word seen twelve times was pruned as a singleton");
  assert.equal(model.pos.oneoff0, undefined, "a singleton survived the prune");
});

test("a document count cannot be driven negative", () => {
  // Reachable from a model that disagrees with itself: an imported file, or one
  // written while a second tab was mid-update, can carry a judged post with the
  // counts already at zero. A negative document count feeds straight into
  // tokenWeight's logarithms and poisons every score after it.
  const inconsistent = { ...runtime.emptyModel(), seen: { "post-1": "pos" }, posDocs: 0 };
  const after = runtime.untrainModel(inconsistent, "post-1", "pos", ["hiring"]);

  assert.ok(after, "untrain refused to clean up an inconsistent model");
  assert.equal(after.posDocs, 0, `posDocs went to ${after.posDocs}`);
  assert.ok(after.posDocs >= 0);

  const negSide = { ...runtime.emptyModel(), seen: { "post-2": "neg" }, negDocs: 0 };
  assert.equal(runtime.untrainModel(negSide, "post-2", "neg", ["hiring"]).negDocs, 0);
});

test("training returns a new model rather than editing the old one", () => {
  const before = runtime.emptyModel();
  runtime.trainModel(before, "k", "pos", ["hiring"]);
  assert.deepEqual(before, runtime.emptyModel(), "the model was mutated in place");
});

// ---------- the hidden-post log ----------

test("a post is logged once, however many times it is scored", () => {
  // Losing the dedupe survived the old suite. An infinite feed re-scores the
  // same post whenever React remounts it.
  const post = { key: "k1", author: "A", text: "text" };
  const result = { score: 10, reasons: [{ delta: -30, label: "Promoted content" }] };
  const entry = runtime.hiddenLogEntry(post, result, 1);

  const log = runtime.appendHidden([], entry);
  assert.equal(log.length, 1);
  assert.equal(runtime.appendHidden(log, entry), null, "the same post was logged twice");
});

test("the hidden-post log keeps the newest and drops the oldest", () => {
  let log = [];
  for (let i = 0; i < boundedBy("HIDDEN_LOG_CAP", runtime.HIDDEN_LOG_CAP, 2000) + 30; i++) {
    log = runtime.appendHidden(log, runtime.hiddenLogEntry(
      { key: "k" + i, author: "A", text: "t" }, { score: 1, reasons: [] }, i));
  }
  assert.equal(log.length, runtime.HIDDEN_LOG_CAP);
  assert.equal(log.at(-1).key, "k" + (runtime.HIDDEN_LOG_CAP + 29), "the newest entry is missing");
  assert.equal(log[0].key, "k30", "the cap dropped the wrong end");
});

test("a log entry stores exactly what the privacy policy describes", () => {
  const post = { key: "k", author: "Jane Doe", text: "x".repeat(2000) };
  const entry = runtime.hiddenLogEntry(post, { score: 33, reasons: [{ delta: -12, label: "Muted phrase" }] }, 7);

  assert.equal(entry.text.length, runtime.HIDDEN_TEXT);
  assert.equal(entry.snippet.length, runtime.HIDDEN_SNIPPET);
  assert.equal(entry.author, "Jane Doe");
  assert.equal(entry.reason, "Muted phrase");
  assert.equal(entry.ts, 7);
  assert.deepEqual(Object.keys(entry).sort(),
    ["author", "key", "reason", "score", "snippet", "text", "ts"],
    "the hidden-post log gained or lost a field; PRIVACY.md lists what it holds");
});

test("a hidden post with no reasons still says something", () => {
  const entry = runtime.hiddenLogEntry({ key: "k", author: "A", text: "t" }, { score: 40, reasons: [] }, 0);
  assert.equal(entry.reason, "Below your relevance threshold");
});

test("posts on screen when the log was deleted stay out of it", () => {
  const suppressed = new Set(["was-on-screen"]);
  const make = (key) => runtime.hiddenLogEntry({ key, author: "A", text: "t" }, { score: 1, reasons: [] }, 0);

  assert.equal(runtime.appendHidden([], make("was-on-screen"), { suppressed }), null);
  assert.equal(runtime.appendHidden([], make("scrolled-away"), { suppressed }).length, 1);
});

// ---------- remembered verdicts ----------

test("verdicts for posts that left the page are detached from their nodes", () => {
  // Holding the node keeps detached DOM alive for the life of the tab.
  const { detach } = runtime.planDecisionPrune(["a", "b", "c"], ["b"]);
  assert.deepEqual(detach.sort(), ["a", "c"]);
});

test("the verdict cache is bounded, and never evicts a post still on screen", () => {
  // MAX_DECISIONS raised to 6e9 survived the old suite, as did losing the
  // still-on-screen guard. Evicting a visible post would have it re-extracted
  // from a node the extension has already decorated, and its own UI text then
  // reads as the post — verified against the shipped engine on a real feed.
  const keys = Array.from({ length: boundedBy("MAX_DECISIONS", runtime.MAX_DECISIONS, 5000) + 40 }, (_, i) => "k" + i);
  const live = new Set(["k0", "k1", "k2"]); // oldest three, still rendered

  const { evict } = runtime.planDecisionPrune(keys, live);
  assert.equal(evict.length, 40, `evicted ${evict.length}, expected to fall back to the cap`);
  for (const key of live) {
    assert.ok(!evict.includes(key), `${key} was evicted while still on screen`);
  }
  assert.equal(evict[0], "k3", "eviction did not start from the oldest off-screen verdict");
});

test("nothing is evicted below the cap", () => {
  const keys = Array.from({ length: 10 }, (_, i) => "k" + i);
  assert.deepEqual(runtime.planDecisionPrune(keys, []).evict, []);
});

// ---------- labels ----------

test("the toolbar says which of the four things happened", () => {
  assert.equal(runtime.toolbarLabel({ priority: true, outcome: "keep", score: 12 }), "Priority · never miss",
    "a never-miss author lost their label");
  assert.equal(runtime.toolbarLabel({ outcome: "keep", score: 82 }), "Strong match");
  assert.equal(runtime.toolbarLabel({ outcome: "keep", score: 70 }), "Strong match", "the boundary moved");
  assert.equal(runtime.toolbarLabel({ outcome: "keep", score: 69 }), "Worth a look");
  assert.equal(runtime.toolbarLabel({ outcome: "dim", score: 44 }), "Maybe · 44/100");
});

test("the breakdown shows the arithmetic with its signs", () => {
  const text = runtime.breakdownText({ reasons: [
    { delta: 16, label: "Your interest: developer tools" },
    { delta: -12, label: "In your feed because someone reacted to it" }
  ] });
  assert.equal(text, "+16 Your interest: developer tools · -12 In your feed because someone reacted to it");
  assert.equal(runtime.breakdownText({ reasons: [] }), "No single reason stood out");
});

test("the mute reason is recognised however it was written", () => {
  // The review page uses this to decide whether to offer an unmute, which is the
  // only control that can lift a -100 people-list rule.
  assert.ok(runtime.isMuteReason("Author you muted"));

  // A judgement part-way through its decay carries a suffix.
  assert.ok(runtime.isMuteReason("Author you muted · fading"),
    "a fading mute stops offering the unmute, on the entries most likely to need it");

  // Logs written before the post-level action was renamed from "fold" to "hide"
  // carry the old label, and they are the only copy anyone has of what was
  // hidden before they upgraded.
  assert.ok(runtime.isMuteReason("Author you hide"),
    "entries logged before the rename lose their unmute button");
  assert.ok(runtime.isMuteReason("Author you hide · fading"));

  // Any other reason is a score a verdict can actually argue with.
  assert.ok(!runtime.isMuteReason("Muted phrase: “agree?”"));
  assert.ok(!runtime.isMuteReason("Below your relevance threshold"));
  assert.ok(!runtime.isMuteReason(undefined));
});

test("the star reads the list the same way the score does", () => {
  // It used an exact, case-sensitive comparison on the raw author while decide()
  // used normalised whole-word matching. A stored "Jane Doe" against an author
  // rendered "Jane Doe, PhD" showed as pinned and refused to unpin, while
  // help.html promised the button toggles. Both now go through nameMatches.
  const { nameMatches } = require("../extension/engine.js");
  const starred = (list, author) => runtime.isPriorityAuthor(list, author, nameMatches);

  assert.ok(starred(["Jane Doe"], "Jane Doe"));
  assert.ok(starred(["Jane Doe"], "Jane Doe, PhD"), "the same person with a suffix is not recognised");
  assert.ok(starred(["jane doe"], "JANE DOE"), "case alone breaks the toggle");

  assert.ok(!starred([], "Jane Doe"));
  assert.ok(!starred(undefined, "Jane Doe"), "a missing list threw or matched");
  assert.ok(!starred(["Dan"], "Danielle Okafor"), "a short entry matched an unrelated person");
});

// ---------- broken, or just slow ----------

const health = (over) => runtime.healthVerdict({
  onFeed: true, enabled: true, mode: "discover",
  postCount: 0, mainTextLength: 5000,
  pathSettledFor: 20000, now: 100000, snoozedUntil: 0,
  ...over
});

test("a feed with posts on it is healthy", () => {
  assert.equal(health({ postCount: 12 }), "healthy");
});

test("the banner waits for the page to settle", () => {
  // HEALTH_GRACE_MS set to 0 survived the old suite. The grace period is the
  // only thing separating a broken selector from a slow connection.
  assert.equal(health({ pathSettledFor: 0 }), "waiting");
  assert.equal(health({ pathSettledFor: runtime.HEALTH_GRACE_MS }), "waiting", "the boundary is inclusive");
  assert.equal(health({ pathSettledFor: runtime.HEALTH_GRACE_MS + 1 }), "broken");
});

test("the banner waits for the page to have real text on it", () => {
  assert.equal(health({ mainTextLength: 0 }), "waiting");
  assert.equal(health({ mainTextLength: 2000 }), "waiting");
  assert.equal(health({ mainTextLength: 2001 }), "broken");
});

test("a snooze is honoured", () => {
  // Ignoring the snooze survived the old suite, which would put a dismissed
  // banner back every ten seconds.
  assert.equal(health({ snoozedUntil: 200000 }), "snoozed");
  assert.equal(health({ snoozedUntil: 100000 }), "snoozed", "the boundary lets it through");
  assert.equal(health({ snoozedUntil: 99999 }), "broken");
});

test("the check stays quiet where the extension is not working", () => {
  assert.equal(health({ onFeed: false }), "idle");
  assert.equal(health({ enabled: false }), "idle");
  assert.equal(health({ mode: "raw" }), "idle");
});

// ---------- panels ----------

test("Escape closes a panel, and nothing else does", () => {
  // "Escape" changed to "Esc" survived the old suite, which stops Escape closing
  // the review pane, the breakage banner and the welcome card.
  assert.ok(runtime.isDismissKey("Escape"));
  for (const key of ["Esc", "escape", "Enter", " ", "Backspace", ""]) {
    assert.ok(!runtime.isDismissKey(key), `${JSON.stringify(key)} closed a panel`);
  }
});

// ---------- the diagnostic report ----------

test("the diagnostic report carries structure and never content", () => {
  // The banner tells the user this is page structure only as they paste it into
  // a public GitHub issue.
  const payload = runtime.diagnosticsPayload({
    version: "0.5.0",
    when: "2026-08-25T00:00:00.000Z",
    detectionVersion: "2026-08-22",
    detectionLocale: "en",
    locale: "en",
    readyState: "complete",
    mainTextLength: 51234,
    selectorHits: { postSelector: 0, mainRoleList: 1 },
    attributeNames: new Set(["data-urn", "aria-label", "componentkey"]),
    state: { enabled: true, mode: "discover", decisions: 12 }
  });

  const serialised = JSON.stringify(payload);
  assert.ok(!/urn:li:activity/.test(serialised), "an activity id reached the report");
  assert.ok(!("path" in payload), "the page path is back in the report");
  assert.deepEqual(payload.attributeNamesSeen, ["aria-label", "componentkey", "data-urn"],
    "attribute names are no longer sorted, or values crept in");
  assert.equal(payload.detection, "2026-08-22 (en)",
    "the detection version is missing, so a report made after a failed load looks like a good one");
  assert.equal(payload.mainTextLength, 51234, "the report should carry the length, never the text");
});

test("the diagnostic report bounds how many attribute names it sends", () => {
  const many = new Set(Array.from({ length: 300 }, (_, i) => "attr-" + String(i).padStart(3, "0")));
  const payload = runtime.diagnosticsPayload({
    version: "0.5.0", when: "", detectionVersion: "v", detectionLocale: "en", locale: "en",
    readyState: "complete", mainTextLength: 0, selectorHits: {}, attributeNames: many, state: {}
  });
  assert.equal(payload.attributeNamesSeen.length, 80);
});

// ---------- counters, and who owns them ----------

const engine = require("../extension/engine.js");

test("a reset stamp cannot be dated into the future", () => {
  // A future stamp would win against every later reset for as long as it stood.
  const now = Date.UTC(2026, 7, 26);
  const clean = engine.sanitizeSettings({ statsResetAt: now + 1e9 }, now);
  assert.equal(clean.statsResetAt, 0, "a future-dated reset survived import");

  const past = engine.sanitizeSettings({ statsResetAt: now - 1000 }, now);
  assert.equal(past.statsResetAt, now - 1000, "a real reset stamp was dropped on import");
});

test("a whole pass of scoring is one counter write", () => {
  // Each counter was bumped on its own, and every bump wrote the entire settings
  // object — so a feed of fifty posts was fifty full writes and fifty storage
  // events echoing back. Nothing covered these three counters at all: the only
  // wiring test names reviewGood and reviewBad.
  const before = { checked: 10, hidden: 4, dimmed: 2, revealed: 7 };
  const after = runtime.bumpStats(before, { checked: 13, hidden: 6, dimmed: 3 });

  assert.equal(after.checked, 23);
  assert.equal(after.hidden, 10);
  assert.equal(after.dimmed, 5);
  assert.equal(after.revealed, 7, "a counter this pass did not touch was changed");
  assert.equal(before.checked, 10, "the counters were mutated in place");
});

test("counting nothing changes nothing", () => {
  const before = { checked: 10, hidden: 4 };
  assert.deepEqual(runtime.bumpStats(before, { checked: 0, hidden: 0 }), before);
  assert.deepEqual(runtime.bumpStats(before, {}), before);
  assert.deepEqual(runtime.bumpStats(before, undefined), before);
  // A negative or nonsense count must never run a counter backwards.
  assert.deepEqual(runtime.bumpStats(before, { checked: -5, hidden: "many" }), before);

  // And a numeric string has to be coerced, not concatenated: without the
  // Number() the comparison still passes and "10" + "5" becomes "105".
  const coerced = runtime.bumpStats({ checked: 10 }, { checked: "5" });
  assert.equal(coerced.checked, 15, `a numeric string produced ${JSON.stringify(coerced.checked)}`);
  assert.equal(typeof coerced.checked, "number", "a counter stopped being a number");
});
