// Scoring rules. Fixtures pin the end-to-end verdict; the unit tests below pin
// the promises the UI makes to the user — above all that "never miss" means
// never hidden, whatever else matched.

const test = require("node:test");
const assert = require("node:assert/strict");

const { engine, shippedDetection, settings, emptyModel, loadFixtures } = require("./helpers.js");

const det = shippedDetection();

/** A plain, unremarkable post; override the fields a test is about. */
const post = (overrides = {}) => ({
  key: "k_FeedType_x",
  text: "A perfectly ordinary update about nothing in particular, long enough to score.",
  author: "Sam Example",
  degree: null,
  hasSocialContext: false,
  isSponsored: false,
  isModule: false,
  isPoll: false,
  isBroetry: false,
  emojiCount: 0,
  ...overrides
});

const score = (p, s = settings()) => engine.decide(p, s, det, emptyModel());

// ---------- fixtures end-to-end ----------

for (const fixture of loadFixtures()) {
  if (fixture.expected.extracts === false) continue;
  if (!("outcome" in fixture.expected)) continue;

  test(`verdict: ${fixture.name}`, () => {
    const extracted = engine.extractPost(fixture.expected.key, fixture.text, det);
    const result = score(extracted);

    assert.equal(result.outcome, fixture.expected.outcome,
      `expected ${fixture.expected.outcome}, got ${result.outcome} at ${result.score}/100 ` +
      `(${result.reasons.map((r) => `${r.delta > 0 ? "+" : ""}${r.delta} ${r.label}`).join("; ")})`);

    // Score bands, not exact scores: tuning a signal should not break fixtures,
    // but flipping a post across a band should.
    if ("minScore" in fixture.expected) assert.ok(result.score >= fixture.expected.minScore, `score ${result.score} below band`);
    if ("maxScore" in fixture.expected) assert.ok(result.score <= fixture.expected.maxScore, `score ${result.score} above band`);

    assert.ok(result.reasons.length > 0, "every verdict must be explainable");
  });
}

// ---------- the promises the UI makes ----------

test("a never-miss author is never hidden, whatever else matched", () => {
  const bad = post({
    author: "Priya Raman",
    text: "Agree? Thoughts? Repost if you think so too. Work anniversary vibes.",
    isPoll: true,
    isBroetry: true,
    isSponsored: true,
    emojiCount: 40,
    degree: "3rd"
  });
  const result = score(bad, settings({ allowedAuthors: ["Priya Raman"] }));
  assert.equal(result.outcome, "keep");
  assert.equal(result.priority, true);
});

test("never-miss matches on a substring of the author line", () => {
  const result = score(post({ author: "Dr. Priya Raman, PhD" }), settings({ allowedAuthors: ["priya raman"] }));
  assert.equal(result.priority, true);
});

test("a blocked author hides and loses priority even if also allowed", () => {
  const result = score(post({ author: "Sam Example" }),
    settings({ allowedAuthors: ["Sam Example"], blockedAuthors: ["Sam Example"] }));
  assert.equal(result.priority, false);
  assert.equal(result.outcome, "hide");
});

test("raw mode keeps everything", () => {
  const result = score(post({ isSponsored: true, isPoll: true }), settings({ mode: "raw" }));
  assert.equal(result.outcome, "keep");
});

test("disabled keeps everything", () => {
  const result = score(post({ isSponsored: true }), settings({ enabled: false }));
  assert.equal(result.outcome, "keep");
});

test("structural filtering off spares promoted posts and modules", () => {
  const s = settings({ structuralFiltering: false });
  const promoted = score(post({ isSponsored: true }), s);
  assert.ok(!promoted.reasons.some((r) => r.label === "Promoted content"));
  assert.notEqual(promoted.outcome, "hide");
});

test("focus mode is strictly stricter than discover mode", () => {
  const interesting = post({ text: "A note about developer tools that is long enough to score properly." });
  assert.equal(score(interesting, settings({ mode: "discover" })).outcome, "keep");
  assert.equal(score(interesting, settings({ mode: "focus" })).outcome, "dim");

  const ordinary = post();
  assert.equal(score(ordinary, settings({ mode: "discover" })).outcome, "dim");
  assert.equal(score(ordinary, settings({ mode: "focus" })).outcome, "hide");
});

test("the score is clamped to 0..100", () => {
  const floor = score(post({ isSponsored: true, isModule: true, isPoll: true, isBroetry: true, emojiCount: 40 }));
  assert.equal(floor.score, 0);

  const ceiling = score(post({ text: "AI infrastructure developer tools startups technical writing, up 40% in 3 days." }),
    settings({ allowedAuthors: ["Sam Example"], interests: Array(20).fill("ordinary") }));
  assert.ok(ceiling.score <= 100);
});

test("thresholds define keep / dim / hide as contiguous bands", () => {
  const s = settings({ mode: "discover" }); // cutoff 45, keep at 60
  const at = (target) => {
    // Drive the score to `target` with a synthetic interest list.
    const result = engine.decide(post({ text: "neutral body text long enough to be scored by the engine." }),
      { ...s, thresholdByMode: { ...s.thresholdByMode, discover: target } }, det, emptyModel());
    return result;
  };
  // Base post scores 58 (50 + 8 "from someone you follow").
  assert.equal(at(60).outcome, "hide");  // below cutoff
  assert.equal(at(50).outcome, "dim");   // cutoff <= score < cutoff + 15
  assert.equal(at(43).outcome, "keep");  // score >= cutoff + 15
});

test("muted phrases and interests both fire, and reasons are ordered by weight", () => {
  const result = score(post({ text: "Thrilled to announce our new developer tools launch, a genuinely long line." }));
  const labels = result.reasons.map((r) => r.label);
  assert.ok(labels.some((l) => l.includes("Muted phrase")));
  assert.ok(labels.some((l) => l.includes("Your interest")));
  const magnitudes = result.reasons.map((r) => Math.abs(r.delta));
  assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
});

test("blank list entries are ignored rather than matching every post", () => {
  // A whitespace-only entry normalises to "", and "".includes("") is true, so an
  // unguarded blank would mute the entire feed — or make every author a
  // never-miss, which is worse because it silently disables all filtering.
  const clean = score(post(), settings({ interests: [], mutedPhrases: [], allowedAuthors: [], blockedAuthors: [] }));
  const blanks = ["", "   ", "\t", "\n"];
  const withBlanks = score(post(), settings({ interests: blanks, mutedPhrases: blanks, allowedAuthors: blanks, blockedAuthors: blanks }));

  assert.equal(withBlanks.score, clean.score);
  assert.equal(withBlanks.priority, false, "a blank never-miss entry made an ordinary author priority");
  assert.equal(withBlanks.reasons.length, clean.reasons.length);
});

test("social context suppresses the follow bonus rather than stacking with it", () => {
  const reasons = score(post({ hasSocialContext: true })).reasons.map((r) => r.label);
  assert.ok(reasons.includes("In your feed because someone reacted to it"));
  assert.ok(!reasons.includes("From someone you follow"));
});

// ---------- who a people-list entry actually matches ----------

test("a people-list entry matches whole words, not fragments", () => {
  const matches = engine.nameMatches;
  // The case that has to keep working: the same person, rendered with a suffix.
  assert.ok(matches("jane doe, phd", "jane doe"));
  assert.ok(matches("jane doe", "jane doe"));
  // The case that was wrong: a short entry swallowing unrelated people.
  assert.ok(!matches("danielle okafor", "dan"), '"Dan" matched "Danielle Okafor"');
  assert.ok(!matches("constructors ltd", "constructor"));
  // A blank entry must match nothing at all; "".includes("") is true.
  assert.ok(!matches("anyone at all", ""));
});

test("an author whose name collides with Object.prototype is still blocked", () => {
  // marks[needle] walked the prototype chain, so "constructor" returned a
  // function, authorStrength did arithmetic on it, and the NaN failed `> 0` —
  // the block silently never applied. "Constructor" is a real company name.
  const now = Date.UTC(2026, 7, 26);
  for (const name of ["Constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const strength = engine.listStrength([name], engine.normalise(name), {}, now, 30);
    assert.equal(strength, 1, `a block on "${name}" did not apply`);
  }
});

test("a decayed entry still reports its own strength, not a prototype's", () => {
  const now = Date.UTC(2026, 7, 26);
  const halfway = now - 15 * 24 * 60 * 60 * 1000;
  const strength = engine.listStrength(["constructor"], "constructor", { constructor: halfway }, now, 30);
  assert.ok(strength > 0.4 && strength < 0.6, `expected about half strength, got ${strength}`);
});

test("blocking a short name does not hide an unrelated person", () => {
  // The bug was in listStrength, not just in the matcher: plain containment meant
  // a hidden "Dan" hidden every "Danielle", and a never-miss "Li" force-kept
  // anyone whose name contained those letters.
  const now = Date.UTC(2026, 7, 26);
  assert.equal(engine.listStrength(["Dan"], "danielle okafor", {}, now, 30), 0,
    'blocking "Dan" still matches "Danielle Okafor"');
  assert.equal(engine.listStrength(["Li"], "olivia hartley", {}, now, 30), 0,
    'a never-miss "Li" still matches "Olivia Hartley"');

  // And the person actually named still matches.
  assert.equal(engine.listStrength(["Dan"], "dan okafor", {}, now, 30), 1);
  assert.equal(engine.listStrength(["Sam Ortega"], "sam ortega", {}, now, 30), 1);
});
