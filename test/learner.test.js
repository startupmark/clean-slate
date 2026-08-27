// The on-device naive Bayes learner. The properties that matter are less about
// accuracy than about restraint: it stays silent until it has seen enough, it
// can never outvote the rules, and it never leaves the device (nothing here can
// — the module has no I/O at all, which is the point of keeping it pure).

const test = require("node:test");
const assert = require("node:assert/strict");

const { engine, shippedDetection, settings, emptyModel, trainedModel } = require("./helpers.js");

const det = shippedDetection();
const { MIN_DOCS, MAX_NUDGE, MIN_INFORMATIVE_WEIGHT } = engine;

const ML = ["machine learning pipelines and evaluation harnesses", "evaluation harnesses for machine learning"];
const NOISE = ["hustle grindset motivation monday", "grindset hustle culture motivation"];

/** N documents of the same flavour, kept textually distinct. */
const docs = (base, n) => Array.from({ length: n }, (_, i) => `${base} number ${i}`);

// ---------- tokenizer ----------

test("tokenize lowercases, dedupes, and drops stopwords", () => {
  const tokens = engine.tokenize("The Pipeline and the pipeline AND The PIPELINE");
  assert.deepEqual(tokens, ["pipeline"]);
});

test("tokenize strips URLs so links do not become vocabulary", () => {
  assert.deepEqual(engine.tokenize("read https://example.com/some/deep/path now"), ["read"]);
});

test("tokenize drops tokens that are too short or too long", () => {
  const tokens = engine.tokenize(`ab abc ${"x".repeat(25)} ${"y".repeat(24)}`);
  assert.ok(tokens.includes("abc"));
  assert.ok(!tokens.includes("ab"));
  assert.ok(!tokens.includes("x".repeat(25)));
  assert.ok(tokens.includes("y".repeat(24)));
});

test("tokenize handles empty and null input", () => {
  assert.deepEqual(engine.tokenize(""), []);
  assert.deepEqual(engine.tokenize(null), []);
  assert.deepEqual(engine.tokenize(undefined), []);
});

// ---------- restraint ----------

test("the learner is silent below the judgement minimum", () => {
  const model = trainedModel(docs("machine learning pipelines", MIN_DOCS - 1), []);
  assert.equal(engine.learnedSignal(model, "machine learning pipelines number 0"), null);
});

test("the learner speaks once the judgement minimum is reached", () => {
  const model = trainedModel(docs("machine learning pipelines", MIN_DOCS), []);
  const signal = engine.learnedSignal(model, "machine learning pipelines number 0");
  assert.ok(signal, "expected a signal at the threshold");
  assert.ok(signal.delta > 0);
});

test("a missing or empty model produces no signal", () => {
  assert.equal(engine.learnedSignal(null, "anything at all"), null);
  assert.equal(engine.learnedSignal(emptyModel(), "anything at all"), null);
});

test("the nudge is bounded so rules keep dominating", () => {
  // This used to assert MAX_NUDGE against itself: it imported the constant and
  // checked the delta stayed within it, so raising 18 to 100 passed and the
  // stated invariant — that the rules keep dominating the learner — was held up
  // by a comment. The bound is written out here on purpose. If it is ever
  // changed deliberately, this line is the one that should make you stop.
  const BOUND = 18;
  assert.equal(MAX_NUDGE, BOUND,
    `the learner's bound moved from ${BOUND} to ${MAX_NUDGE}. A rule is worth up to 100, ` +
    "so this decides whether feedback can overturn one. Change it on purpose or not at all.");

  // Wildly lopsided training: every token points one way.
  const model = trainedModel(docs("alpha beta gamma delta epsilon zeta eta theta", 60), docs("unrelated", 4));
  const signal = engine.learnedSignal(model, "alpha beta gamma delta epsilon zeta eta theta");
  assert.ok(signal);
  assert.ok(Math.abs(signal.delta) <= BOUND, `nudge ${signal.delta} exceeded ±${BOUND}`);

  const negative = engine.learnedSignal(trainedModel(docs("unrelated", 4), docs("alpha beta gamma delta epsilon zeta eta theta", 60)),
    "alpha beta gamma delta epsilon zeta eta theta");
  assert.ok(Math.abs(negative.delta) <= BOUND);
  assert.ok(negative.delta < 0);

  // The bound has to be small enough that it cannot flip a rule on its own. The
  // heaviest rules are ±100, and a hidden post sits below a threshold of at most 75.
  assert.ok(BOUND * 2 < 75, "the learner can now swing a post across any threshold by itself");
});

test("the learner cannot rescue a promoted post or hide a never-miss author", () => {
  const lovesEverything = trainedModel(docs("quarterly", 60), []);
  const promoted = engine.decide(
    { key: "k", text: "quarterly quarterly quarterly, a promoted message of respectable length.", author: "Acme",
      degree: null, hasSocialContext: false, isSponsored: true, isModule: false, isPoll: false, isBroetry: false, emojiCount: 0 },
    settings(), det, lovesEverything);
  assert.equal(promoted.outcome, "hide");

  const hatesEverything = trainedModel([], docs("quarterly", 60));
  const priority = engine.decide(
    { key: "k", text: "quarterly quarterly quarterly, an ordinary message of respectable length.", author: "Priya Raman",
      degree: null, hasSocialContext: false, isSponsored: false, isModule: false, isPoll: false, isBroetry: false, emojiCount: 0 },
    settings({ allowedAuthors: ["Priya Raman"] }), det, hatesEverything);
  assert.equal(priority.outcome, "keep");
});

// ---------- direction ----------

test("the learner separates flavours it has been taught", () => {
  const model = trainedModel(docs(ML[0], 6).concat(docs(ML[1], 6)), docs(NOISE[0], 6).concat(docs(NOISE[1], 6)));
  const liked = engine.learnedSignal(model, "a post about machine learning evaluation harnesses");
  const disliked = engine.learnedSignal(model, "a post about hustle grindset motivation");
  assert.ok(liked && liked.delta > 0, "expected a positive nudge on the taught-positive flavour");
  assert.ok(disliked && disliked.delta < 0, "expected a negative nudge on the taught-negative flavour");
});

test("the signal names the words it acted on, so the UI can explain itself", () => {
  const model = trainedModel(docs("machine learning pipelines", MIN_DOCS + 4), docs("hustle grindset", 4));
  const signal = engine.learnedSignal(model, "machine learning pipelines number 0");
  assert.match(signal.label, /^Learned from your feedback \(/);
  assert.ok(signal.label.split(",").length <= 3, "at most three words are named");
});

test("text with no informative words produces no signal", () => {
  const model = trainedModel(docs("machine learning pipelines", MIN_DOCS), []);
  assert.equal(engine.learnedSignal(model, "the and or but if then"), null);
});

// ---------- weights ----------

test("tokenWeight is symmetric: swapping the bags flips the sign", () => {
  const model = trainedModel(docs("pipeline", 10), docs("hustle", 6));
  const flipped = { pos: model.neg, neg: model.pos, posDocs: model.negDocs, negDocs: model.posDocs, seen: {} };
  assert.ok(Math.abs(engine.tokenWeight(model, "pipeline") + engine.tokenWeight(flipped, "pipeline")) < 1e-9);
});

test("an unseen token carries almost no weight in a balanced model", () => {
  const model = trainedModel(docs("pipeline", 10), docs("hustle", 10));
  assert.ok(Math.abs(engine.tokenWeight(model, "neverseenbefore")) < MIN_INFORMATIVE_WEIGHT);
});

test("the options-page inspector uses the same weight formula as the engine", () => {
  // options.js carries its own copy (it cannot load engine.js today). If the two
  // drift, the words the inspector shows stop matching the words that scored.
  const { objectLiteralFrom, EXTENSION_DIR } = require("./helpers.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(EXTENSION_DIR, "options.js"), "utf8");

  const match = source.match(/function tokenWeightIn\(model,\s*token\)\s*\{\s*return ([^}]+)\}/);
  assert.ok(match, "options.js no longer declares tokenWeightIn — update this test or re-point the inspector at engine.js");

  const copy = new Function("model", "token", `return ${match[1].replace(/^return\s*/, "")}`);
  const model = trainedModel(docs("pipeline", 10), docs("hustle", 6));
  for (const token of ["pipeline", "hustle", "neverseenbefore"]) {
    assert.ok(Math.abs(copy(model, token) - engine.tokenWeight(model, token)) < 1e-12,
      `tokenWeight drifted for "${token}"`);
  }
  // Reference the import so the linter-free setup still shows intent.
  assert.ok(typeof objectLiteralFrom === "function");
});

test("the inspector's visibility threshold matches the engine's", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(require("./helpers.js").EXTENSION_DIR, "options.js"), "utf8");
  const match = source.match(/Math\.abs\(x\.w\)>([\d.]+)/);
  assert.ok(match, "options.js no longer filters learned words by weight");
  assert.equal(Number(match[1]), MIN_INFORMATIVE_WEIGHT,
    "the inspector and the scorer disagree about which words are informative");
});

test("the inspector waits for the same number of judgements as the scorer", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(require("./helpers.js").EXTENSION_DIR, "options.js"), "utf8");
  const match = source.match(/if\(total<(\d+)\)return;/);
  assert.ok(match, "options.js no longer gates the inspector on a judgement count");
  assert.equal(Number(match[1]), MIN_DOCS,
    "the inspector and the scorer disagree about when the learner is ready");
});

test("the learner does not vote with words it has never seen", () => {
  // tokenWeight is non-zero for an unseen word whenever the two document counts
  // differ, because the smoothing terms alone are lopsided. A post sharing no
  // words at all with anything the user judged still took the full nudge, and
  // the reason named words they had never judged. Ten kept against six hidden
  // produced -13; ten against nothing produced the full -18.
  const model = trainedModel(docs("kubernetes operators platform", 10), docs("recruiting funnel", 6));
  const unrelated = "sourdough starter hydration schedule and oven temperature";

  assert.equal(engine.learnedSignal(model, unrelated), null,
    "the learner scored a post with no words in common with anything judged");

  // A post that does share evidence still gets a signal.
  const related = engine.learnedSignal(model, "kubernetes operators in production");
  assert.ok(related && related.delta > 0, "the learner stopped responding to words it has seen");
});

test("the reason names only words the model has actually seen", () => {
  const model = trainedModel(docs("kubernetes operators platform", 10), docs("recruiting funnel", 6));
  const signal = engine.learnedSignal(model, "kubernetes operators and sourdough hydration");
  assert.ok(signal);
  for (const unseen of ["sourdough", "hydration"]) {
    assert.ok(!signal.label.includes(unseen), `the reason cites "${unseen}", which was never judged`);
  }
});
