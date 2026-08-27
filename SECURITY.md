# Security policy

## Reporting a vulnerability

Please report privately rather than opening a public issue.

Email **cs-oss@triberoi.com**, or use GitHub's
[private vulnerability reporting](https://github.com/startupmark/clean-slate/security/advisories/new),
the **Report a vulnerability** button on the Security tab. Reports there are
visible only to the maintainer until a fix is published.

Include what you were doing, what happened, and the extension version from
`chrome://extensions`. A proof of concept helps but is not required.

Expect an acknowledgement within a few days. This is a small project maintained
part-time, and there is no bounty programme.

## What counts

Clean Slate has a small attack surface: no server, no account, no network calls.
The interesting cases are mostly about the guarantees below being untrue. Reports
along these lines are especially welcome:

- **Anything that leaves the machine.** A request of any kind from the extension,
  or a way to make it emit one.
- **Data escaping local storage.** Preferences, counters and the learned model
  are meant never to leave the browser profile.
- **Post content leaking into a diagnostic.** The breakage report is designed to
  carry structure counts and attribute *names* only. If you can get post text, an
  author name or an attribute *value* into it, that is a bug worth reporting.
- **Injection through feed content.** Everything Clean Slate renders comes from a
  page an attacker may control. Post text reaching the DOM as markup rather than
  as text would be a real finding.
- **Privilege issues in the extension surfaces:** the popup, the preferences page
  or the service worker doing something a web page can trigger.

## Out of scope

- LinkedIn's own site and infrastructure. Report those to LinkedIn.
- The extension not filtering correctly, or filtering something you wanted. That
  is a bug, so please open a normal issue.
- Findings that require an already-compromised browser profile or a malicious
  extension with equal or greater permissions.

See [PRIVACY.md](PRIVACY.md) for what the extension stores and where.

## Supported versions

The most recent release only. This project has no long-term support branches.
