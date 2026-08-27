# Clean Slate browser extension

Dependency-free Chrome/Edge Manifest V3 extension. It runs only on the LinkedIn
desktop home feed and reads only page text already rendered in your browser.

## Install it locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `extension` folder.
5. Open `https://www.linkedin.com/feed/` and use the Clean Slate toolbar icon.

The first visit shows a local-only welcome card. **Set my interests**, or the
popup's **Preferences**, changes the defaults.

After editing source, reload the extension *and* refresh the LinkedIn tab. Chrome
injects content scripts on navigation, so an open tab keeps the old copy. A
manifest change needs a full remove-and-reload rather than the reload button.

## If nothing happens

1. Refresh the LinkedIn tab once.
2. Open the popup while on `https://www.linkedin.com/feed/`.
3. `Connected · N feed items found` means it is running. `0 feed items found`
   means the page markup has changed and Clean Slate has left the feed untouched.
   Feed subroutes work; other LinkedIn pages are not filtered.
4. Use the **Errors** button on the Clean Slate card in `chrome://extensions`.

## Reading modes

- **Focus** hides anything below a high relevance threshold.
- **Discover** hides obvious noise and dims borderline posts.
- **Digest** keeps only the strongest posts. The rest collapse behind one summary
  card that expands in a click.
- **Raw** leaves the page untouched.

Hidden posts are never deleted. Each has a **Show post** action.

## Feedback

★, **Hide**, **Mute**, **Show post**, **More like this**, **Less like this** and
**Never miss this author** all update local lists *and* train an on-device
classifier. What it has learned is inspectable on the preferences page.

**Mute** fades over `authorDecayDays` (30 by default, 0 disables). Names typed on the preferences page never fade.

## Limits

- LinkedIn can change its markup at any time. Selectors and text patterns live in
  `detection.json`, and a breakage banner with a sanitized diagnostic appears if
  the feed renders but nothing is detected.
- English-only text patterns. `detection.json` carries a locale table.
- Counters are local lifetime aggregates. There is no server and no analytics.

## Licence and affiliation

Clean Slate is free software under the GNU General Public License, version 3.
The full text is in [`LICENSE`](../LICENSE) at the root of the repository.

    Clean Slate, a local filter that lets you decide what stays in your feed.
    Copyright (C) 2026 Mark Birch.

    This program is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License, version 3, as published
    by the Free Software Foundation.

    This program is distributed in the hope that it will be useful, but
    WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License
    for more details.

    You should have received a copy of the GNU General Public License along
    with this program. If not, see <https://www.gnu.org/licenses/>.

The bundled typefaces are licensed separately under the SIL Open Font License
1.1. Their licence texts sit beside the font files in [`fonts/`](fonts/).

Clean Slate is not affiliated with, endorsed by or sponsored by LinkedIn.
LinkedIn is a trademark of LinkedIn Corporation. The name is used here only to
describe what the extension works on.
