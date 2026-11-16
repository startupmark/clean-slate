# Changelog

Clean Slate updates by hand: you download a zip, replace the folder, and press reload. So every entry here leads with whether that is worth doing, and **Update if** says who should bother.

Watch this repository (Watch → Custom → Releases) to hear about a new one.

## 1.0.0 — 2026-11-16

**Update if** you'd rather install from the Chrome Web Store or Edge Add-ons. If you're on 0.1.2, you don't need this release: it changes nothing in how Clean Slate works.

The version jumps to 1.0.0 because the Chrome Web Store already holds an earlier build numbered 0.5.0 and only accepts a higher number.

## 0.1.2 — 2026-11-15

**Update if** you want Clean Slate to tell you the next time your feed moves to an address it doesn't know. Nothing is broken on 0.1.1 today; if you are still on 0.1.0, update, because 0.1.0 no longer works on the home feed.

### Added

- **A banner when your feed is at an address Clean Slate doesn't recognise.** When the home feed moved to `/feed/foryou/`, Clean Slate stopped filtering and said only that the view was not supported. Now, if a page under `/feed/` shows posts but is on neither the home-feed list nor the list of feeds left alone on purpose, a banner says nothing is being filtered and offers the diagnostic report. The popup says the same.
- **The report names the feed view** in that case, such as `foryou`, and only if it is a plain word. Nothing else from the address is included. The privacy policy says so.

### Fixed

- **The breakage banner clears when you leave the page.** It used to follow you to the next page for up to ten seconds.

## 0.1.1 — 2026-11-14

**Update if** Clean Slate stopped hiding posts and the popup says "Connected, but this LinkedIn view is not supported yet." That is everyone on 0.1.0.

### Fixed

- **Works on the home feed again.** LinkedIn moved the home feed from `/feed/` to `/feed/foryou/`, and Clean Slate only ran on the old address. It now runs on both. Other feeds under `/feed/`, such as Following, hashtags and single posts, are still left alone.

## 0.1.0 — 2026-08-27

The first release.

Scores every post on the LinkedIn home feed against rules you set, hides the ones that fall short behind a card naming the reason, and learns from every judgement you make. Four reading modes, a never-miss list, author muting that fades over a month, interest profiles, a review page for auditing what it hid, and page cleanup for the rails.

Everything runs locally. No server, no account, no analytics, and no network request of any kind — the typefaces are bundled rather than fetched, and a test fails the build if a request appears in code or in CSS.

### Known limits

- **English-language feeds only.** The rules that read words match English ones, so on a feed in another language adverts, polls and engagement bait come through. The toolbar popup says so when it lands on such a feed.
- **The feed's markup changes often.** When that breaks detection, Clean Slate stops and says so rather than guessing, and offers a sanitized diagnostic to report.
- **It cannot update itself.** An extension loaded from a folder never auto-updates, and this one makes no network calls, so it has no way to tell you a release exists. Watch the repository and GitHub will.
