# Bundled typefaces

The design system specifies **Jost**, **Newsreader** and **JetBrains Mono**.
Clean Slate makes zero network calls, so they are self-hosted here rather than
fetched. A CDN is not an alternative, because a CDN *is* the network call, made
from inside `linkedin.com`, from a page the user never asked us to phone home from.

`../fonts.css` declares the `@font-face` rules and explains the subsetting.

## What is here

| File | Family | Subset | Axes | Size |
| --- | --- | --- | --- | --- |
| `jost-latin.woff2` | Jost | latin | `wght` 300–700 | 26 KB |
| `jost-latin-ext.woff2` | Jost | latin-ext | `wght` 300–700 | 17 KB |
| `newsreader-latin.woff2` | Newsreader | latin | `wght` 300–700 | 57 KB |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | latin | `wght` 400–700 | 31 KB |

~131 KB in total. Jost gets latin-ext because it renders author names, which on
LinkedIn routinely carry diacritics outside basic latin; the other two render
our own English copy and figures.

## Licensing

All three are under the **SIL Open Font License 1.1**. The full text and the
copyright notice for each family sit beside the binaries:

- `OFL-Jost.txt`, Copyright 2020 The Jost Project Authors
- `OFL-Newsreader.txt`, Copyright 2020 The Newsreader Project Authors
- `OFL-JetBrainsMono.txt`, Copyright 2020 The JetBrains Mono Project Authors

The OFL permits bundling and redistribution with software under any licence,
including the GPL-3.0 that covers Clean Slate's own code. The fonts remain OFL;
the code remains GPL. Two OFL conditions bind anyone editing these files: a
modified face may not be distributed under the reserved family name, and font
files may not be sold on their own.

## Re-cutting these files

They came from the Google Fonts CDN's own woff2 subsets, the same binaries the
hosted service serves, saved rather than linked. To refresh them, ask the CSS
API for each family with a browser user-agent (so it answers with woff2), take
the `url(...)` from the `/* latin */` and `/* latin-ext */` blocks, and download
those:

```sh
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Jost:wght@300..700&display=swap'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Newsreader:wght@300..700&display=swap'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700&display=swap'
```

The licence texts come from the upstream Google Fonts repository
(`google/fonts/ofl/<family>/OFL.txt`).

Two things to keep true when refreshing:

1. **Copy the `unicode-range` values across too.** They are what makes a glyph
   the subset does not contain fall through to the fallback stack instead of
   rendering as tofu.
2. **Nothing may reference `fonts.googleapis.com` or `fonts.gstatic.com` at
   runtime.** `test/fonts.test.js` fails the build if a stylesheet does.
