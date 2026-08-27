# Changelog

Clean Slate updates by hand: you download a zip, replace the folder, and press reload. So every entry here leads with whether that is worth doing, and **Update if** says who should bother.

Watch this repository (Watch → Custom → Releases) to hear about a new one.

## 0.1.0 — 2026-08-27

The first release.

Scores every post on the LinkedIn home feed against rules you set, hides the ones that fall short behind a card naming the reason, and learns from every judgement you make. Four reading modes, a never-miss list, author muting that fades over a month, interest profiles, a review page for auditing what it hid, and page cleanup for the rails.

Everything runs locally. No server, no account, no analytics, and no network request of any kind — the typefaces are bundled rather than fetched, and a test fails the build if a request appears in code or in CSS.

### Known limits

- **English-language feeds only.** The rules that read words match English ones, so on a feed in another language adverts, polls and engagement bait come through. The toolbar popup says so when it lands on such a feed.
- **The feed's markup changes often.** When that breaks detection, Clean Slate stops and says so rather than guessing, and offers a sanitized diagnostic to report.
- **It cannot update itself.** An extension loaded from a folder never auto-updates, and this one makes no network calls, so it has no way to tell you a release exists. Watch the repository and GitHub will.
