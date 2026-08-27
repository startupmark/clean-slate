// Author-list time decay.
//
// The behaviour this exists to guarantee: a judgement you made from the feed in
// one irritated moment is not a life sentence. "Less like this" and "Hide" write
// the author into blockedAuthors AND stamp the moment; the stamp is what fades.
//
// The asymmetry is deliberate and is the thing most likely to be "fixed" by
// mistake later: a name TYPED on the preferences page carries no stamp and never
// fades, because deciding to hide someone in a settings screen is a standing
// preference rather than a reaction to one post.

const test = require("node:test");
const assert = require("node:assert/strict");

const { engine, shippedDetection, settings, emptyModel } = require("./helpers.js");

const det = shippedDetection();
const DAY = engine.DAY_MS;

// A fixed "now", so these tests say the same thing in a year as they do today.
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
const daysAgo = (days) => NOW - days * DAY;

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

const reasonFor = (result, pattern) => result.reasons.find((r) => pattern.test(r.label));

// ---------- the curve ----------

test("an unmarked entry never fades", () => {
  // Typed on the preferences page: no mark, full strength forever.
  assert.equal(engine.authorStrength(undefined, NOW, 30), 1);
  assert.equal(engine.authorStrength(null, NOW, 30), 1);
});

test("a fresh mark is at full strength and an expired one at none", () => {
  assert.equal(engine.authorStrength(NOW, NOW, 30), 1);
  assert.equal(engine.authorStrength(daysAgo(30), NOW, 30), 0);
  assert.equal(engine.authorStrength(daysAgo(400), NOW, 30), 0);
});

test("strength falls linearly across the window", () => {
  const near = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
  near(engine.authorStrength(daysAgo(15), NOW, 30), 0.5);
  near(engine.authorStrength(daysAgo(24), NOW, 30), 0.2);
  near(engine.authorStrength(daysAgo(3), NOW, 30), 0.9);
});

test("a decay window of zero switches fading off", () => {
  // The preferences page offers 0 as "never". It must mean never, not instantly.
  assert.equal(engine.authorStrength(daysAgo(400), NOW, 0), 1);
});

test("a mark in the future does not go above full strength", () => {
  // Clock skew, or settings restored from a machine in another timezone.
  assert.equal(engine.authorStrength(NOW + 5 * DAY, NOW, 30), 1);
});

test("without a clock, nothing decays", () => {
  // decide() is called with `now` omitted in some tests and in any future caller
  // that has no clock. Failing towards "no decay" keeps the user's lists intact.
  assert.equal(engine.authorStrength(daysAgo(400), undefined, 30), 1);
});

// ---------- matching a list ----------

test("the strongest matching entry wins", () => {
  const marks = { "sam example": daysAgo(29), "sam": daysAgo(3) };
  const strength = engine.listStrength(["Sam Example", "Sam"], "sam example", marks, NOW, 30);
  assert.ok(strength > 0.8, `expected the fresh entry to win, got ${strength}`);
});

test("a blank list entry matches nothing", () => {
  // The bug that once disabled all hiding: "  " is truthy, normalises to "",
  // and every string contains "".
  assert.equal(engine.listStrength(["   "], "sam example", {}, NOW, 30), 0);
  assert.equal(engine.listStrength([""], "sam example", {}, NOW, 30), 0);
});

test("a fully faded entry is indistinguishable from not being listed", () => {
  const marks = { "sam example": daysAgo(31) };
  assert.equal(engine.listStrength(["Sam Example"], "sam example", marks, NOW, 30), 0);
  assert.equal(engine.listStrength([], "sam example", {}, NOW, 30), 0);
});

// ---------- what the user sees ----------

test("a fresh hide still hides the post outright", () => {
  const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": NOW } });
  const result = engine.decide(post(), s, det, emptyModel(), NOW);
  assert.equal(result.outcome, "hide");
  assert.equal(reasonFor(result, /Author you muted/).delta, -100);
});

test("a half-faded hide pulls the post down by half as much, and says so", () => {
  const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": daysAgo(15) } });
  const result = engine.decide(post(), s, det, emptyModel(), NOW);
  const reason = reasonFor(result, /Author you muted/);
  assert.equal(reason.delta, -50);
  assert.match(reason.label, /fading/,
    "a faded verdict must explain itself, or the same author scoring differently looks like a bug");
});

test("a judgement made moments ago does not call itself fading", () => {
  // Found by walking the app: hide an author, and the hidden-post card immediately read
  // "Author you hide · fading" next to a full −100. Strength was 0.99997, which
  // is < 1 but rounds to the same delta, so the word was describing nothing.
  const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": NOW - 60 * 1000 } });
  const reason = reasonFor(engine.decide(post(), s, det, emptyModel(), NOW), /Author you muted/);
  assert.equal(reason.delta, -100);
  assert.equal(reason.label, "Author you muted", "a one-minute-old judgement is not fading");
});

test("the fading label appears exactly when the delta shrinks", () => {
  // The contract: the word and the number agree. Sweep the whole window and
  // assert they never disagree in either direction.
  for (let day = 0; day <= 30; day++) {
    const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": daysAgo(day) } });
    const reason = reasonFor(engine.decide(post(), s, det, emptyModel(), NOW), /Author you muted/);
    if (!reason) {
      assert.equal(day, 30, `the entry vanished at day ${day}, before it expired`);
      continue;
    }
    const shrunk = reason.delta > -100;
    assert.equal(/fading/.test(reason.label), shrunk,
      `day ${day}: label "${reason.label}" disagrees with delta ${reason.delta}`);
  }
});

test("an expired hide stops affecting the score at all", () => {
  const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": daysAgo(31) } });
  const faded = engine.decide(post(), s, det, emptyModel(), NOW);
  const never = engine.decide(post(), settings(), det, emptyModel(), NOW);
  assert.equal(reasonFor(faded, /Author you muted/), undefined);
  assert.equal(faded.score, never.score);
});

test("a hide typed on the preferences page never expires", () => {
  // Same list, same age of grudge — but no mark, so it holds.
  const s = settings({ blockedAuthors: ["Sam Example"], authorMarks: {} });
  const result = engine.decide(post(), s, det, emptyModel(), NOW + 400 * DAY);
  assert.equal(result.outcome, "hide");
  assert.equal(reasonFor(result, /Author you muted/).label, "Author you muted");
});

test("a faded never-miss still counts as priority while any of it remains", () => {
  // Half a never-miss is still a never-miss: the promise the badge makes is
  // binary, so it holds until the entry is gone entirely.
  const s = settings({ allowedAuthors: ["Sam Example"], authorMarks: { "sam example": daysAgo(29) } });
  const result = engine.decide(post({ isPoll: true, isBroetry: true }), s, det, emptyModel(), NOW);
  assert.equal(result.priority, true);
  assert.equal(result.outcome, "keep");
});

// ---------- pruning ----------

test("nothing to prune returns null, so no pointless storage write happens", () => {
  const fresh = settings({ blockedAuthors: ["Sam Example"], authorMarks: { "sam example": NOW } });
  assert.equal(engine.pruneDecayedAuthors(fresh, NOW), null);
  assert.equal(engine.pruneDecayedAuthors(settings(), NOW), null);
});

test("pruning drops the expired entry from the list and from the marks", () => {
  const s = settings({
    blockedAuthors: ["Sam Example", "Still Fresh"],
    allowedAuthors: ["Old Favourite"],
    authorMarks: { "sam example": daysAgo(31), "still fresh": daysAgo(2), "old favourite": daysAgo(90) }
  });
  const pruned = engine.pruneDecayedAuthors(s, NOW);

  assert.deepEqual(pruned.blockedAuthors, ["Still Fresh"]);
  assert.deepEqual(pruned.allowedAuthors, []);
  assert.deepEqual(Object.keys(pruned.authorMarks).sort(), ["still fresh"]);
  assert.deepEqual(pruned.expired.sort(), ["old favourite", "sam example"]);
});

test("pruning leaves unmarked entries alone", () => {
  const s = settings({
    blockedAuthors: ["Typed By Hand", "Judged In Anger"],
    authorMarks: { "judged in anger": daysAgo(31) }
  });
  const pruned = engine.pruneDecayedAuthors(s, NOW);
  assert.deepEqual(pruned.blockedAuthors, ["Typed By Hand"]);
});

test("pruning does nothing when fading is switched off", () => {
  const s = settings({
    blockedAuthors: ["Sam Example"],
    authorMarks: { "sam example": daysAgo(400) },
    authorDecayDays: 0
  });
  assert.equal(engine.pruneDecayedAuthors(s, NOW), null);
});
