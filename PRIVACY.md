# Privacy policy

**Clean Slate collects nothing and sends nothing.** There is no server, no
account, no analytics and no network request of any kind. Everything below
happens inside your browser profile.

Last updated: 2026-08-26.

## What is stored, and where

All of it lives in local extension storage on your machine
(`chrome.storage.local`). None of it is transmitted.

| What | Why | Limit |
| --- | --- | --- |
| Your preferences: topics, muted phrases, people lists, profiles, reading mode, thresholds | To score posts | No cap |
| Counters: how many posts were checked, hidden, dimmed | The numbers in the popup | No cap |
| A word model trained on your feedback | To learn what you keep and what you hide | 4,000 words per side; 400 recent posts remembered by id |
| **A log of hidden posts:** author name, the score, the reason, and up to 600 characters of the post's text | To fill the review page and to retrain from your verdicts | 200 most recent, then the oldest is dropped |

Clean Slate keeps the text of posts it hid, including the author's name, so
the review page can show you what was hidden and learn from your verdict. That is
other people's writing sitting on your disk, up to about 190KB at the cap. It
never leaves your machine, and deleting it is one click.

## What is never stored

The text of posts that were not hidden. Your LinkedIn credentials or session.
Anything from a page other than the LinkedIn home feed. Any identifier for you.

One thing worth being exact about: judging a post you kept, by starring it or
choosing "More like this", adds that post's words to the learned model. That is a
count per word, not the post, and the words sit alongside every other word you
have judged. You can see the whole list, and clear it, in Preferences.

## The diagnostic report

When Clean Slate cannot read the feed, it offers a one-click diagnostic to attach
to a bug report. That report contains structure counts and HTML attribute
*names* only, never post content, never author names, never attribute values.
Nothing is sent anywhere. It is copied to your clipboard for you to paste, and
you can read it before you do.

## Deleting everything

Preferences, then **Your data**, then **Delete all Clean Slate data**. That
removes the preferences, the counters, the learned model and the log of hidden posts.
Removing the extension deletes the same storage.

To clear only what it learned, use **Forget everything learned** in the same
section, which also clears the log of hidden posts.

## Permissions

- **`storage`** keeps the above on your machine.
- **`https://www.linkedin.com/*`** is the only site the extension runs on. It
  reads the text of the feed page you are already looking at, in your own
  session, and changes how that page is displayed to you.

There is no `tabs` permission and no access to browsing history, other sites, or
any other tab.

## Changes

This file is versioned in the repository, so any change to it is visible in the
commit history.

## Contact

cs-oss@triberoi.com
