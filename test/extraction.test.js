// Parsing a post out of its rendered text. This is the layer that breaks when
// LinkedIn reshapes the feed, so every fixture here is a shape we have seen.

const test = require("node:test");
const assert = require("node:assert/strict");

const { engine, shippedDetection, loadFixtures } = require("./helpers.js");

const det = shippedDetection();
const fixtures = loadFixtures();

test("there are fixtures to run", () => {
  assert.ok(fixtures.length >= 8, `expected a real fixture set, found ${fixtures.length}`);
});

for (const fixture of fixtures) {
  test(`extract: ${fixture.name}`, () => {
    const post = engine.extractPost(fixture.expected.key, fixture.text, det);

    if (fixture.expected.extracts === false) {
      assert.equal(post, null, "fixture is marked as too thin to score, but it extracted");
      return;
    }

    assert.ok(post, "fixture did not extract");
    assert.equal(post.key, fixture.expected.key);

    for (const field of ["author", "degree", "hasSocialContext", "isSponsored",
                         "isModule", "isPoll", "isBroetry", "emojiCount"]) {
      if (field in fixture.expected) {
        assert.equal(post[field], fixture.expected[field], `${field} mismatch`);
      }
    }

    // The body text always survives extraction, and the accessibility label
    // never does.
    assert.ok(post.text.length >= 35);
    assert.ok(!/^feed post/i.test(post.text), "leading accessibility label leaked into text");
  });
}

test("a node with no componentkey is not a post", () => {
  assert.equal(engine.extractPost(null, "Feed post\nSomebody\nA reasonably long line of body text here.", det), null);
  assert.equal(engine.extractPost("", "Feed post\nSomebody\nA reasonably long line of body text here.", det), null);
});

test("empty and whitespace-only text extract nothing", () => {
  assert.equal(engine.extractPost("k_FeedType_x", "", det), null);
  assert.equal(engine.extractPost("k_FeedType_x", "   \n\n  \n", det), null);
});

test("author falls back rather than showing a wall of text", () => {
  const wall = "x".repeat(200);
  const post = engine.extractPost("k_FeedType_x", `Feed post\n${wall}\nSome body text that is comfortably long enough to score.`, det);
  assert.equal(post.author, "A LinkedIn post");
});

test("stacked social-context banners are all skipped", () => {
  const text = [
    "Feed post",
    "Dana Whitfield likes this",
    "Followed by Ravi Menon",
    "Real Author",
    "Head of Platform • 1st",
    "A body that is long enough to be scored by the engine at all."
  ].join("\n");
  const post = engine.extractPost("k_FeedType_x", text, det);
  assert.equal(post.author, "Real Author");
  assert.equal(post.hasSocialContext, true);
});

test("text without the accessibility label still parses", () => {
  // Not every locale or rendering path emits "Feed post" first.
  const text = "Rosa Klein\nSRE • 1st\nA body that is long enough to be scored by the engine at all.";
  const post = engine.extractPost("k_FeedType_x", text, det);
  assert.equal(post.author, "Rosa Klein");
  assert.equal(post.degree, "1st");
});

// ---------- labels in the header, not words in the body ----------
//
// Both of these hidden ordinary posts for every user, with structural filtering
// on by default, and both were reproduced against this engine before the fix.

test("a post about being promoted is not an advert", () => {
  // "Promoted" was searched for across the first six lines joined together. A
  // post's body starts on line four or five, so the body was inside the window.
  const text = [
    "Feed post",
    "Dana Reyes",
    "Director of Engineering at Harborline • 1st",
    "3h",
    "After four years on the platform team I have been promoted to Director of Engineering. Thank you to everyone who backed me along the way.",
    "Like", "Comment"
  ].join("\n");

  const post = engine.extractPost("k_FeedType_x", text, det);
  assert.equal(post.author, "Dana Reyes");
  assert.equal(post.isSponsored, false, "an ordinary post was classified as an advert");
});

test("a short line in the body is not mistaken for the advert label", () => {
  // Two things keep this right: the marker has to be a short standalone line,
  // AND the search has to stay in the header. Either alone lets something
  // through — a body that opens with a short exclamation looks exactly like the
  // label if the window reaches it.
  const text = [
    "Feed post",
    "Dana Reyes",
    "Director of Engineering at Harborline • 1st",
    "3h",
    "Promoted!",
    "Four years on the platform team and the title finally caught up with the work. Thank you all.",
    "Like", "Comment"
  ].join("\n");

  const post = engine.extractPost("k_FeedType_x", text, det);
  assert.equal(post.isSponsored, false,
    "a short body line was read as the advert label, because the search reached past the header");
});

test("a real advert is still an advert", () => {
  // LinkedIn renders the marker as its own short line, which is the thing being
  // detected. Both shapes occur: with and without a follower count.
  const withoutCount = ["Feed post", "Northwind Analytics", "Promoted", "Ship your first dashboard in an afternoon, with governance built in."].join("\n");
  assert.equal(engine.extractPost("k_FeedType_a", withoutCount, det).isSponsored, true);

  const withCount = ["Feed post", "J.P. Morgan Asset Management", "694,720 followers", "Promoted", "In alternatives, the best opportunities are not visible to everyone."].join("\n");
  assert.equal(engine.extractPost("k_FeedType_b", withCount, det).isSponsored, true,
    "a sponsored post with a follower count above the label was missed");
});

test("a games job title does not make every post a feed module", () => {
  // The modules pattern includes the bare word "games" and was tested against
  // the first 250 characters of `text`, which begins with the author line and
  // their headline. Anyone headlined "Senior Producer, Games" had every post
  // hidden permanently, at -70, with the reason "Feed module you chose to filter".
  const text = [
    "Feed post",
    "Marco Silva",
    "Senior Producer, Games at Northwind Studios • 2nd",
    "5h",
    "We shipped our co-op mode this week after eighteen months. The team held the scope line and it made all the difference.",
    "Like", "Comment"
  ].join("\n");

  const post = engine.extractPost("k_FeedType_x", text, det);
  assert.equal(post.author, "Marco Silva");
  assert.equal(post.isModule, false, "a person's job title turned their post into a feed module");
});

test("a post that merely mentions LinkedIn News is not a feed module", () => {
  const text = [
    "Feed post",
    "Ana Duarte",
    "Reporter • 1st",
    "2h",
    "LinkedIn news coverage of the layoffs missed the part that actually matters, which is what happens to the contractors.",
    "Like"
  ].join("\n");
  assert.equal(engine.extractPost("k_FeedType_x", text, det).isModule, false);
});

test("a real feed module is still a feed module", () => {
  // A module's name lands in the author slot, which is what identifies it.
  for (const name of ["People you may know", "LinkedIn News", "Games", "Add to your feed"]) {
    const text = ["Feed post", name, "Suggestions picked for you based on what you follow and who you know."].join("\n");
    const post = engine.extractPost("k_FeedType_m", text, det);
    assert.equal(post.isModule, true, `the "${name}" module is no longer detected`);
  }
});
