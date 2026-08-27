# Contributing to Clean Slate

The most useful contributions are the ones that keep the extension working as LinkedIn's markup changes, and locale tables that extend it beyond English feeds.

## Before your first pull request: the CLA

This project uses a Contributor License Agreement ([CLA.md](CLA.md)). In plain terms:

- The project is and stays GPL-3.0 for everyone.
- By contributing, you additionally license your contribution to the maintainer in a way that permits offering the project under other terms, including a future commercial license.

To agree, **post a comment on your pull request** containing exactly this line:

> I have read and agree to the Clean Slate CLA.

It must be a comment, not the pull request description. A bot watches for it and records your agreement in [`signatures/version1/cla.json`](../../blob/cla-signatures/signatures/version1/cla.json) on the `cla-signatures` branch, and it can only see comments. It asks you for this automatically on your first pull request, so there is nothing to remember in advance. You agree once, not per pull request.

Pull requests without it cannot be merged. If the check seems stuck after you have commented, comment `recheck`.

## What makes a good contribution

- **DOM breakage fixes.** If the feed stops being filtered, the console (F12) logs under `[CleanSlate]` show what detection found. An issue with those logs is valuable. A pull request adjusting detection is better.
- **Locale support.** Several signals key off English strings. Adding your language's equivalents ("Promoted", "likes this", connection-degree markers) extends the extension to your feed.
- **Scoring signals.** Every rule produces a human-readable reason shown to the user. A signal that cannot explain itself does not ship.
- One fix or one signal per pull request.

## Ground rules

- **No network calls.** The extension makes zero requests and that is a hard guarantee. Any pull request adding one is declined regardless of purpose. This covers stylesheets as well as scripts: a webfont `@import`, a CDN `url()` or a tracking pixel in CSS is the same request by another route. The typefaces are bundled in `extension/fonts/` for this reason. See `extension/fonts.css`.
- **No automation of LinkedIn actions** (liking, following, messaging, connecting). Display filtering only.
- **No new dependencies or build steps** without prior discussion in an issue.
- Match the existing code style: vanilla JS, no framework, readable over clever.

## Dependency policy

The shipped extension has zero dependencies and no build step. What is in `extension/` is exactly what runs in your browser, with no bundler between the source and the artifact. That is a property of a privacy tool, and it is not up for trade.

The test suite holds the same line. It runs on Node's built-in test runner, so `package.json` declares no dependencies and there is no lockfile and no `node_modules`. CI fails if any of the three appear. If a change genuinely needs a dependency, open an issue first and make the case.

## How the code is organised

- `extension/engine.js` is the pure core: scoring, the naive Bayes learner, post extraction, detection defaults. No DOM, no `chrome.*`, no mutable state. This is what the tests exercise.
- `extension/content.js` is the shell around it: DOM decoration, storage, messaging, the MutationObserver.
- `extension/detection.json` holds everything LinkedIn-specific that can break: selectors and per-locale text patterns. Fixing DOM churn or adding a language should be a change to this file, not to code.

New logic belongs in `engine.js` if it can be written as a pure function, because that is the half that can be tested.

## Testing a change

```
npm test
```

The tests need nothing installed. They cover post extraction against text fixtures, the scoring rules, author decay, profiles and the reading modes, the learner's bounds, colour contrast computed from the tokens themselves, and configuration invariants.

They do not cover whether the CSS selectors still match LinkedIn's live markup. Fixtures are sanitized `innerText` snapshots, so they catch a *parsing* break but never a *selector* break. That is what the in-page breakage banner is for, and it means a selector change always needs the manual pass:

1. Load `extension/` unpacked at `chrome://extensions` (Developer mode, then Load unpacked).
2. Open the LinkedIn home feed and check the `[CleanSlate]` console logs.
3. Confirm posts are detected, scored and hidden or dimmed as expected, and that the popup and preferences pages still work.

Background on the architecture and the traps that have already bitten is in [DEVELOPING.md](DEVELOPING.md).

### Adding a fixture

Drop a `.txt` file in `test/fixtures/`. Everything before the `---` line is `#` front-matter naming the expected values. Everything after is the post's `innerText`. Only the fields you declare are asserted, so a fixture stays about the one thing it pins down. **Sanitize before committing:** invented names, rewritten body, no real people and no real post content.

## Contact

Security reports and conduct concerns: **cs-oss@triberoi.com** (see [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)). Everything else belongs in an issue or a pull request, in the open.
