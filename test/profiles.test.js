// Interest profiles, and the Digest reading mode.
//
// Profiles are overlays rather than a new container: the DEFAULT profile is the
// top-level settings themselves. That is what let profiles arrive with no
// migration and no change to the preferences page's existing editors, and it is
// the property most worth pinning down — a future refactor that moves the
// default's interests into settings.profiles would silently orphan everyone's
// existing settings.

const test = require("node:test");
const assert = require("node:assert/strict");

const { engine, shippedDetection, settings, emptyModel } = require("./helpers.js");

const det = shippedDetection();

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

const profile = (overrides = {}) => ({
  id: "p1",
  name: "Community brain",
  interests: ["mutual aid"],
  mutedPhrases: ["hiring"],
  ...overrides
});

const reasonFor = (result, pattern) => result.reasons.find((r) => pattern.test(r.label));

// ---------- resolution ----------

test("no active profile means the top-level settings are the profile", () => {
  const resolved = engine.resolveProfile(settings());
  assert.equal(resolved.id, null);
  assert.equal(resolved.name, "Default");
  assert.deepEqual(resolved.interests, engine.SETTINGS_DEFAULTS.interests);
  assert.deepEqual(resolved.mutedPhrases, engine.SETTINGS_DEFAULTS.mutedPhrases);
});

test("an activeProfile that no longer exists falls back to the default", () => {
  // Deleting a profile from another window, or restoring an older export.
  // Falling back beats scoring against an empty interest list and hiding
  // everything the user cares about.
  const resolved = engine.resolveProfile(settings({ activeProfile: "deleted", profiles: [] }));
  assert.equal(resolved.name, "Default");
  assert.deepEqual(resolved.interests, engine.SETTINGS_DEFAULTS.interests);
});

test("an active profile replaces the topics and muted phrases", () => {
  const resolved = engine.resolveProfile(settings({ activeProfile: "p1", profiles: [profile()] }));
  assert.deepEqual(resolved.interests, ["mutual aid"]);
  assert.deepEqual(resolved.mutedPhrases, ["hiring"]);
});

// ---------- scoring through a profile ----------

test("the default profile's interests stop applying once another is active", () => {
  const s = settings({ activeProfile: "p1", profiles: [profile()] });
  const result = engine.decide(post({ text: "Notes on developer tools and what they cost to run, at length." }), s, det, emptyModel());
  assert.equal(reasonFor(result, /Your interest/), undefined,
    "a Default-profile interest matched while another profile was active");
});

test("the active profile's own interests and muted phrases apply", () => {
  const s = settings({ activeProfile: "p1", profiles: [profile()] });

  const lifted = engine.decide(post({ text: "A long write-up on mutual aid networks and how they actually organise." }), s, det, emptyModel());
  assert.equal(reasonFor(lifted, /Your interest: mutual aid/).delta, 16);

  const sunk = engine.decide(post({ text: "We are hiring across every team, apply now, long post about it." }), s, det, emptyModel());
  assert.equal(reasonFor(sunk, /Muted phrase/).delta, -24);
});

test("the verdict names the profile that produced it", () => {
  // The reasons explain a post; this explains which set of rules was in force.
  assert.equal(engine.decide(post(), settings(), det, emptyModel()).profile, "Default");
  const s = settings({ activeProfile: "p1", profiles: [profile()] });
  assert.equal(engine.decide(post(), s, det, emptyModel()).profile, "Community brain");
});

test("people, not topics, stay shared across profiles", () => {
  // "Never miss Jane" is a fact about Jane. Scoping it per profile would mean
  // silently missing her posts whenever you were in the other brain.
  const s = settings({
    activeProfile: "p1",
    profiles: [profile()],
    allowedAuthors: ["Sam Example"]
  });
  assert.equal(engine.decide(post(), s, det, emptyModel()).priority, true);
});

// ---------- thresholds ----------

test("a profile's threshold tunes Discover", () => {
  const strict = settings({ mode: "discover", activeProfile: "p1", profiles: [profile({ threshold: 75 })] });
  const loose = settings({ mode: "discover", activeProfile: "p1", profiles: [profile({ threshold: 20 })] });
  assert.equal(engine.resolveProfile(strict).threshold, 75);
  assert.equal(engine.resolveProfile(loose).threshold, 20);
});

test("a profile cannot loosen Focus or Digest", () => {
  // Focus and Digest are absolute strengths you reach for deliberately. If a
  // profile could redefine them, the same button would mean different things in
  // different profiles, which is the one thing a mode must not do.
  for (const mode of ["focus", "digest"]) {
    const s = settings({ mode, activeProfile: "p1", profiles: [profile({ threshold: 20 })] });
    assert.equal(engine.resolveProfile(s).threshold, engine.SETTINGS_DEFAULTS.thresholdByMode[mode],
      `profile threshold leaked into ${mode}`);
  }
});

test("a profile with no threshold of its own uses the mode's", () => {
  const s = settings({ mode: "discover", activeProfile: "p1", profiles: [profile()] });
  assert.equal(engine.resolveProfile(s).threshold, engine.SETTINGS_DEFAULTS.thresholdByMode.discover);
});

test("a threshold of zero is a threshold, not a missing value", () => {
  // `|| 45` read a legitimate 0 as unset and quietly substituted the default,
  // so a mode configured to keep everything hidden almost half the feed instead.
  const s = settings({ mode: "digest", thresholdByMode: { focus: 70, discover: 45, digest: 0 } });
  assert.equal(engine.resolveProfile(s).threshold, 0);

  // And a genuinely absent threshold still falls back. Built by hand rather than
  // through settings(), which merges the defaults back in and would hide this.
  assert.equal(engine.resolveProfile({ mode: "digest", thresholdByMode: { focus: 70 } }).threshold, 45);
  assert.equal(engine.resolveProfile({ mode: "digest" }).threshold, 45);
});

// ---------- digest ----------

test("digest is strictly binary — nothing is left half-dimmed", () => {
  // A briefing is a list of things worth reading. A dimmed post is neither in
  // it nor out of it, so the "maybe" band does not exist in this mode.
  const cutoff = engine.SETTINGS_DEFAULTS.thresholdByMode.digest;
  const s = settings({ mode: "digest" });

  // Sweep across the cutoff by stacking interest matches (+16 each) onto a
  // baseline post, so the assertion covers both sides of it rather than one
  // hand-picked score.
  const topics = engine.SETTINGS_DEFAULTS.interests;
  for (let matched = 0; matched <= topics.length; matched++) {
    const text = `A perfectly ordinary update, long enough to score. ${topics.slice(0, matched).join(", ")}`;
    const result = engine.decide(post({ text }), s, det, emptyModel());
    assert.notEqual(result.outcome, "dim", `digest dimmed a post at ${result.score}/100`);
    assert.equal(result.outcome, result.score >= cutoff ? "keep" : "hide");
  }
});

test("digest hides what discover would merely dim", () => {
  const p = post({ text: "A middling update, nothing matched, long enough to be scored at all." });
  const discover = engine.decide(p, settings({ mode: "discover" }), det, emptyModel());
  const digest = engine.decide(p, settings({ mode: "digest" }), det, emptyModel());

  assert.equal(discover.outcome, "dim", "the baseline post no longer lands in Discover's maybe band — pick another");
  assert.equal(digest.outcome, "hide");
  assert.equal(discover.score, digest.score, "the mode must change the verdict, not the score");
});

test("digest still never hides a never-miss author", () => {
  const s = settings({ mode: "digest", allowedAuthors: ["Sam Example"] });
  const result = engine.decide(post({ isPoll: true, isBroetry: true }), s, det, emptyModel());
  assert.equal(result.outcome, "keep");
});

test("raw still overrides every mode-specific rule", () => {
  const s = settings({ mode: "raw", blockedAuthors: ["Sam Example"] });
  assert.equal(engine.decide(post(), s, det, emptyModel()).outcome, "keep");
});
