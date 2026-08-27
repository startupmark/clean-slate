## What this changes

<!-- One or two sentences. One fix or one signal per PR. -->

## How it was tested

<!--
`npm test` covers scoring, the learner, extraction and config, and needs nothing installed.
Say so if it passes, and add anything you checked by hand.

If you changed a SELECTOR in detection.json, the tests cannot catch that: fixtures are text
snapshots, so they check parsing, never selectors. Load `extension/` unpacked at
chrome://extensions and confirm posts are still detected on a real feed.
-->

- [ ] `npm test` passes
- [ ] Loaded unpacked and checked a real feed (required for any selector change)

## CLA

A bot will ask you to agree to the [Clean Slate CLA](https://github.com/startupmark/clean-slate/blob/main/CLA.md) on your first pull request,
by posting a comment here. There is nothing to do in advance, and nothing to tick in this
template, because the bot can only see comments, not checkboxes.
