# Developing Clean Slate

Background for anyone changing the code. Comments in the source stay minimal and
mechanical; the reasoning lives here.

For how to install and run the extension, see [`extension/README.md`](extension/README.md).
For the contribution rules, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Architecture

| File | Role |
| --- | --- |
| `extension/engine.js` | Pure logic: scoring, extraction, the learner, decay, profiles. No DOM, no `chrome.*`, no mutable module state. |
| `extension/runtime.js` | Pure logic for the feed layer: which pages count, what goes in the hidden-post log, what the learner records, which verdicts to forget, broken versus slow. |
| `extension/content.js` | The shell around both: DOM, storage, messaging, rendering. |
| `extension/background.js` | Service worker. Brokers settings for the popup. |
| `extension/popup.js`, `extension/options.js` | Toolbar popup and preferences page. |
| `extension/review.js` | The review page. Its own extension page, not an injected panel. |

`engine.js` and `runtime.js` are pure functions of their arguments, which is the
only reason the test suite can exercise real logic in Node without a browser.
Anything that touches the page or storage belongs in `content.js`. New logic that
can be written pure goes in one of the other two.

They are separate because `engine.js` answers "what is this post worth" and
`runtime.js` answers "what does the feed layer do about it". Keeping them apart
means the scoring tests never need a hidden-post log and the log tests never need a
score.

`runtime.js` exists because of a measurement. Sixty-three deliberate breakages
were introduced into `content.js` and thirty survived the entire suite, including
`onFeedPage()` rewritten to always return true. None of it was catchable:
`content.js` touches `chrome.*` and `document` at parse time, so it cannot be
`require()`d, and every assertion about it was a regex over its own source text.
A regex over source asserts the mechanism you thought of, not the outcome a user
gets. Where a pin is unavoidable, say so in the test.

A green suite is a claim, not a proof. The log-deletion bug was fixed,
pinned, passed a thirteen-mutation sweep, and was still wrong in the product,
because a different code path refilled the log within a frame. Only a real feed
found it.

Both pure modules load two ways and must keep working in both: as content scripts
listed before `content.js` in the manifest (content scripts share one
isolated-world global, so the top-level `var` is visible), and via `require()`
from the tests, where the `module.exports` tail applies. The manifest order is
`engine.js`, `runtime.js`, `content.js`, and a test asserts it.

The settings shape is duplicated three times, in `engine.js`, `background.js` and
`options.js`, because neither of the latter two can import the first. A test
asserts the three stay identical, so drift fails CI rather than shipping.
Deduplicating them is a real change with its own risk; the assertion is cheap.

### Detection is data, not code

Everything LinkedIn-specific that can break lives in `extension/detection.json`:
DOM selectors and per-locale text patterns. `engine.js` carries an identical
built-in copy as the fallback if the file fails to load, and a test asserts
parity. A markup change or a new locale is therefore a data edit, so the most
likely kind of breakage is also the cheapest to fix.

Posts are identified by `role` plus `componentkey`. Class names are hashed and
unstable. `componentkey` is stable per post, which is what lets decisions survive
React unmounting and remounting a post during virtualised scrolling.

### The review page is not part of the feed

It was a panel the content script injected into LinkedIn's DOM, with
four consequences:

- It could only open from a LinkedIn tab, so both popup buttons that reached it
  were silent no-ops anywhere else.
- It forgot every verdict on a range switch, because it rebuilt itself from the
  log on each call and the judged state lived only in the DOM.
- At 400% zoom it collapsed to zero height, fixed-positioned, with no page scroll
  to recover it.
- It put up to 200 hidden posts, other people's names and up to 600 characters of their
  writing, into a page LinkedIn's own JavaScript runs on.

Anything that shows a user their own stored data belongs on an extension page,
not inside the site being filtered.

### Never insert a sibling into the feed list

React owns that list and reconciliation will fight you. Every Clean Slate surface
is one child inside a post container, plus a class on the container; CSS hides
the container's original children. A `MutationObserver` re-applies the
decorations when React wipes them.

## Traps

Each of these shipped, or nearly shipped, and each is the reason a one-line
warning exists in the source.

**Font URLs must be absolute.** A relative `url()` in a stylesheet injected by a
content script resolves against the page, not the extension. Chrome requested
`https://www.linkedin.com/feed/fonts/jost-latin.woff2`, LinkedIn answered `200`
with its SPA HTML fallback, the decode failed, and every face fell back in
silence. Use `chrome-extension://__MSG_@@extension_id__/...`, Chrome's
substitution for the extension's own id inside a CSS file. It requires
`default_locale` in `manifest.json` and `_locales/en/messages.json`; removing
either breaks the fonts silently.

**Keep the font rules in a manifest-injected stylesheet.** That CSS is exempt
from the host page's Content-Security-Policy. A `<style>` element injected by
`content.js` is not, and LinkedIn's policy is
`default-src 'none'; ... font-src data: * 'self' *.licdn.com`, whose `*` does not
cover the `chrome-extension:` scheme.

**Anything a browser resolves cannot be verified locally.** The font bug is the
general case. The suite checked that the files existed and were referenced; it
could not check where a reference points once a browser resolves it. URLs, CSP
and extension origins have to be checked with the extension loaded on a real
page.

**A coalescing latch needs a guaranteed release.** The `MutationObserver`
coalesces bursts into one pass per animation frame behind a `scheduled` flag. The
flag is set before the frame is requested, and a tab that is not being rendered
is never granted one, so the flag stuck and every later mutation was swallowed
for the life of the page. There is now a `setTimeout` alongside
`requestAnimationFrame`; whichever fires first runs the pass and releases the
latch. The timer is not optional.

**Anything that strips the feed must rebuild it.** `resetAll()` removes every
card, toolbar and verdict label. A message handler that calls it must call
`processAll()` itself rather than relying on the observer, for the reason above.

**Counters are deltas, never totals.** `content.js` reads the stored counters at
the moment it writes and adds what the pass counted, rather than writing a total
it has been carrying. `addStats()` serialises those writes, because two passes in
the same tab would otherwise read the same value and the second would drop the
first. The storage listener takes the event's counters as they are.

This replaced an ownership rule, where the feed tab kept its own counters against
every incoming write. That rule was aimed at a real problem — a tab's own write
echoing back with pre-burst numbers and losing the burst — and it solved it, but
it could not tell that echo from another tab's real work. A second feed tab's
counts were discarded, and a tab left open pinned the numbers to its own tally
for as long as it lived. Observed on a real install: 52 checked became 12. This
was documented here as "the last write wins rather than the two summing", which
understated it.

Reading at write time gets the rest for free. "Delete all Clean Slate data"
removes the key, so a write landing afterwards reads nothing and writes only its
own delta instead of restoring the old totals. "Reset counters" writes zeros and
the next scored post adds to zero. Neither needs a signal to distinguish it from
an echo. `statsResetAt` is still written by the preferences page and still
validated, but nothing reads it now.

Do not change this to `Math.max`, and do not reintroduce a total held in memory.
Max cannot tell a stale echo from a deliberate reset. A memory-held total is the
bug above.

**Blank list entries match everything.** A whitespace-only entry in interests,
muted phrases or either author list is truthy, normalises to `""`, and every
string contains `""`. Unguarded, one blank entry silently matched every post in
the feed. Guard the normalised needle, never the raw entry. `listStrength()` does
the same for the author lists.

**The digest host is not stable.** In digest mode every hidden post collapses
except the first, which hosts the summary card. The host changes as posts mount,
unmount and change verdict, so the collapse class must be `toggle`d, not `add`ed.
Adding it left a node that had been collapsed earlier still hidden once it became
the host, taking the summary with it.

**Fixtures must stay LF.** `loadFixtures` splits on a literal LF-dashes-LF
divider. `core.autocrlf=true` is the Git for Windows default, so a fresh clone
there rewrote the fixtures to CRLF and every extraction and scoring test failed
on Windows only, while Linux CI stayed green. `.gitattributes` pins them; the
reader normalises anyway.

## Scoring

Every post starts at 50. Rules add or subtract, each carrying a label so the UI
can explain the verdict. The learner may nudge the total by at most 18 points
either way, so explicit rules always dominate.

The final band depends on the mode: `keep`, `dim` or `hide`. Digest is binary,
because a briefing is a list of things worth reading and a half-dimmed post is
neither in nor out.

`decide()` takes `now` as an argument rather than reading the clock, which keeps
it pure and lets the decay tests pin a date. Omitting it means no decay.

### Author decay

A judgement made from the feed is stamped with the moment it was made, and fades
linearly to nothing over `authorDecayDays` before being pruned.

Only the negative actions stamp. "Never miss this author" and "Always show
author" promise permanence in their own copy, and a name typed on the preferences
page is a standing preference rather than a reaction to one post. The engine
handles both lists symmetrically, so enabling positive decay later is a one-line
change.

The "fading" label keys off the delta, not the raw strength. A judgement made a
minute into a 30-day window is at 0.99997 strength, which rounds to the same
number it started at. Labelling that "fading" beside an unchanged value reads as
a bug.

### Interest profiles

Profiles are overlays, not a new container: the default profile is the top-level
settings. Nothing needed migrating when profiles arrived, and the preferences
page still edits the default directly. An `activeProfile` pointing at a deleted
profile falls back to the default rather than scoring against an empty interest
list and hiding everything.

Only topics and muted phrases are profile-scoped. People, page cleanup and the
learned model are shared, because "never miss this person" is a fact about that
person rather than about which profile is active.

A profile's threshold applies to Discover only. Focus and Digest are absolute
strengths, and a mode button that means different things in different profiles is
worse than no profiles at all.

### The learner

A naive Bayes classifier over your own feedback, trained by every explicit
action, entirely on-device. It stays silent until it has enough judgements, and
its vocabulary is bounded. The two knobs, both in `engine.js`, if it over-hides
in daily use: the minimum number of judgements before it speaks, and the minimum
token weight that counts as informative.

## Design system

The visual system is maintained outside this repository; `content.css` carries
its rules in a header comment. The ones most easily broken:

- One accent. Signal marks a decision the extension made or an action you can
  take, and nothing else.
- Clay is rare. Destructive actions and detection breakage only, never for
  "hidden", which is a normal reversible outcome.
- `--cs-quiet` may not carry text. It is 2.78:1 on paper, and there is no darker
  value that both clears 4.5:1 and stays distinguishable from `--cs-slate`.
  Receding text uses slate; quiet is for non-text only.
- Borders do the work shadows would. One elevation level, for floating panels.

Contrast is not checked by eye. `test/contrast.test.js` computes WCAG ratios from
the tokens as declared, in every palette block of all three stylesheets.

## Testing

`npm test` runs Node's built-in runner. No dependencies, nothing to install.

Fixtures are sanitized `innerText` snapshots of single posts, not HTML.
`extractPost` works from `node.innerText`, and jsdom does not implement
`innerText`, so HTML fixtures could not drive it. The cost is worth stating:
these fixtures catch a parsing break, never a selector break. Selector breakage
is what the in-page breakage banner exists to surface.

Beyond the engine, the suite covers wiring that only shows up when you click
something, such as a renamed element id, a message nobody handles, or a class the
CSS never styles, plus configuration invariants and colour contrast.

Three things the tests cannot do: resolve a URL the way a browser would, catch a
selector that no longer matches LinkedIn's live markup, and tell you whether a
page's CSP interferes with anything. All three need the extension loaded on a
real feed.

## Images

Every image the repository ships is rendered from `assets/sources` by
`npm run shots`. It drives the Chrome already on the machine, so there is no
dependency and no browser download; set `CHROME` to point at a different binary.

```
npm run shots
```

It writes the README screenshot at 2x, the 1280x800 store screenshot, and both
promo tiles, then checks each file came out the size it is supposed to be. The
store only tells you an image is the wrong size at upload.

`feed.html` takes its shot size and scale from the query string, and `promo.html`
takes its size the same way, so the README image and the store image share one
copy of the mockup rather than two that can disagree.

**The mockups can lie, and have.** They are hand-built copies of the markup
`content.js` produces. The README image once showed four actions on a card that
ships five, and it went on saying "Fold" and "Hide this author" for a release
after both were renamed. A test now pins every control label in the mockup
against the source that renders the real one, so the next drift fails the suite
rather than shipping. It pins the words, not the layout. If you change what a
card looks like rather than what it says, the mockup still needs a look.

Rendering the real extension instead would end the problem, and does not work
today: Chrome disabled `--load-extension`, and `Extensions.loadUnpacked` over the
DevTools protocol loads the extension without injecting the content script.
Chrome for Testing would do it, at the cost of a dependency and a browser
download.

## Packaging

```
npm run package
```

Builds both zips into `dist/` from `extension/` as it stands, at whatever version
`manifest.json` carries. Pass a directory to write somewhere else.

The two are not interchangeable, and handing someone the wrong one fails in a way
that looks like the extension is broken. `clean-slate-<version>-store.zip` has
`manifest.json` at the root, which is what the stores require.
`clean-slate-<version>.zip` wraps everything in a `clean-slate/` folder, because
Load unpacked wants a folder to point at.

The file list in `tools/package.mjs` is explicit rather than an exclude list: a
new file in `extension/` has to be named there to travel, and one that is not
listed fails the build rather than being quietly dropped.

## Working on this repository

`main` is protected and the rule applies to everyone, maintainer included:

- Changes land through a pull request. Direct pushes are rejected.
- The `test` check must pass, and the branch must be up to date with `main`.
- Linear history: squash or rebase, no merge commits.
- Conversations must be resolved before merging.
- No approval is required, since the project has one maintainer. The point is
  that everything is proposed, checked and visible, not that someone signs off.

CLA signatures live on the `cla-signatures` branch, not `main`. The bot commits
them with `GITHUB_TOKEN`, which is not exempt from branch protection, so writing
to a protected `main` would fail and lose a contributor's signature. That branch
is unprotected and holds nothing else. Granting the bot a bypass on `main` was
the alternative, and a worse one, because it would let any workflow push there.

## Privacy constraints

These are product guarantees, and a pull request that breaks one is declined
regardless of what it adds.

- **Zero network calls.** No fetch, no webfont link, no CDN, no beacon. The only
  permitted `fetch` is the extension reading its own bundled `detection.json` via
  `chrome.runtime.getURL`. `test/config.test.js` covers scripts and
  `test/fonts.test.js` covers stylesheets.
- **No automation and no scraping.** Display filtering only.
- **Nothing leaves the machine.** Preferences, counters and the learned model
  live in local extension storage.
- **The breakage diagnostic stays sanitized.** Structure counts and attribute
  names only. Never post content, author names or attribute values.
