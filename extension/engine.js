// Pure logic core: scoring, extraction, the learner. No DOM, no chrome.*, no
// mutable module state — anything that touches the page or storage goes in
// content.js. Loaded both as a content script (before content.js) and via
// require() from the tests. See DEVELOPING.md.

var CleanSlateEngine = (() => {
  // ---------- detection config ----------
  // Fallback for detection.json. Must stay identical to it; a test asserts this.

  const DETECTION_DEFAULTS = {
    version: "built-in",
    selectors: {
      post: "main div[componentkey*='FeedType']:has(> div[role='listitem'])",
      feedColumn: "main div[role='list']"
    },
    feedPaths: ["/feed"],
    locales: {
      en: {
        feedPostLabel: "^feed post",
        socialContext: "(likes this|loves this|celebrates this|supports this|finds this (insightful|funny)|commented|reposted this|follows? this (page|hashtag)|^followed by\\b)",
        sponsored: "^(promoted|sponsored)( by .+)?$",
        modules: "\\b(people you may know|suggested for you|recommended for you|linkedin news|games|add to your feed)\\b",
        degree: "•\\s*(1st|2nd|3rd)",
        poll: "\\bsee results\\b",
        bait: "\\b(agree\\?|thoughts\\?|repost if|comment below|like if|follow me for|i.ll dm you)\\b",
        uiLine: "^(like|comment|repost|send|share|follow|connect|…?\\s?more|see more|see translation|\\d[\\d,.]*|•.*|visit my website)$"
      }
    }
  };

  // Duplicated in background.js and options.js, which cannot load this file.
  // A test asserts the three copies stay identical.
  const SETTINGS_DEFAULTS = {
    onboardingComplete: false,
    enabled: true,
    mode: "discover", // focus | discover | digest | raw
    thresholdByMode: { focus: 70, discover: 45, digest: 68 },
    interests: ["AI infrastructure", "developer tools", "startups"],
    mutedPhrases: ["thrilled to announce", "agree?", "work anniversary"],
    allowedAuthors: [],
    blockedAuthors: [],
    // When an author was added FROM THE FEED, by normalised name. Entries typed
    // on the preferences page are unmarked and never fade.
    authorMarks: {},
    authorDecayDays: 30,
    // Bumped when the preferences page zeroes the counters. The feed tab owns
    // its counters, so a reset needs a signal it cannot mistake for a stale echo.
    statsResetAt: 0,
    // The default profile IS the top-level fields above; activeProfile === null
    // means it is live.
    profiles: [],
    activeProfile: null,
    structuralFiltering: true,
    hideRightRail: true,
    hideLeftRailExtras: true,
    stats: {
      checked: 0, hidden: 0, dimmed: 0, revealed: 0, feedback: 0,
      reviewGood: 0, reviewBad: 0,
      // Judgement count when the inspector was last opened; the popup nudges on
      // the gap between this and the current total.
      learnedAcknowledged: 0
    }
  };

  // `lang` is passed in so this stays callable without a DOM.
  function compileDetection(raw, lang, probe) {
    const code = (lang || "en").split("-")[0].toLowerCase();
    const loc = raw.locales[code] || raw.locales.en;
    const rx = (source) => new RegExp(source, "i");

    // Every regex goes through rx(), which throws on a bad pattern and is caught
    // by the caller. The CSS selectors were copied through unchecked, so a typo
    // in detection.json threw inside querySelectorAll before the observer was
    // even attached: the extension did nothing at all, and the breakage banner
    // never fired because the health check never ran. Validating here means a
    // bad selector falls back to the built-in one, which is the same outcome as
    // a failed fetch.
    // Only a DOM can say whether a CSS selector parses, and this file may not
    // touch one — that purity is what lets the tests run at all. So the caller
    // injects a probe: content.js passes document.querySelector, the tests pass
    // a stand-in, and with no probe the value is taken as given.
    const selector = (value, fallback) => {
      if (typeof value !== "string" || !value.trim()) return fallback;
      if (typeof probe !== "function") return value;
      try {
        probe(value);
        return value;
      } catch (_) {
        return fallback;
      }
    };

    return {
      version: raw.version,
      locale: raw.locales[code] ? code : `${code}→en`,
      post: selector(raw.selectors.post, DETECTION_DEFAULTS.selectors.post),
      feedColumn: selector(raw.selectors.feedColumn, DETECTION_DEFAULTS.selectors.feedColumn),
      feedPaths: raw.feedPaths,
      feedPostLabel: rx(loc.feedPostLabel),
      socialContext: rx(loc.socialContext),
      sponsored: rx(loc.sponsored),
      modules: rx(loc.modules),
      degree: rx(loc.degree),
      poll: rx(loc.poll),
      bait: rx(loc.bait),
      uiLine: rx(loc.uiLine)
    };
  }

  const normalise = (value) => (value || "").toLowerCase().replace(/\s+/g, " ").trim();

  // ---------- learned model (naive Bayes over your feedback) ----------

  const STOPWORDS = new Set(("the a an and or but if then else when at by for with about into over after under " +
    "again once here there all any both each few more most other some such only own same so than too very can " +
    "will just should now this that these those i im ive my me you your we our us they their he she it its is " +
    "are was were be been being have has had do does did not no nor of in on to from as what which who whom how why").split(" "));

  function tokenize(text) {
    return [...new Set((text || "")
      .toLowerCase()
      .replace(/https?:\S+/g, " ")
      .split(/[^a-z']+/)
      .map((token) => token.replace(/'/g, ""))
      .filter((token) => token.length >= 3 && token.length <= 24 && !STOPWORDS.has(token)))];
  }

  // Per-token log-likelihood ratio of pos vs neg rates, smoothed.
  function tokenWeight(model, token) {
    return Math.log(((model.pos[token] || 0) + 0.5) / (model.posDocs + 1))
         - Math.log(((model.neg[token] || 0) + 0.5) / (model.negDocs + 1));
  }

  // The two knobs to turn if the learner over-hides: minimum judgements before
  // it speaks, and minimum |weight| for a token to count as informative.
  const MIN_DOCS = 8;
  const MIN_INFORMATIVE_WEIGHT = 0.35;
  const MAX_NUDGE = 18; // rules must keep dominating the learner

  function learnedSignal(model, text) {
    if (!model || model.posDocs + model.negDocs < MIN_DOCS) return null;
    const informative = tokenize(text)
      // The token has to have been seen. tokenWeight is non-zero for a word the
      // model has never met whenever the two document counts differ, because the
      // smoothing terms alone are lopsided — so a post sharing no words at all
      // with anything the user judged still took the full nudge, captioned with
      // words they never judged. Ten kept against six hidden produced -13; ten
      // against nothing produced the full -18.
      .filter((token) => (model.pos[token] || 0) + (model.neg[token] || 0) > 0)
      .map((token) => ({ token, w: tokenWeight(model, token) }))
      .filter((x) => Math.abs(x.w) > MIN_INFORMATIVE_WEIGHT);
    if (!informative.length) return null;
    const sum = informative.reduce((acc, x) => acc + x.w, 0);
    const delta = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, Math.round(sum * 4)));
    if (!delta) return null;
    const top = informative
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 3).map((x) => x.token);
    return { delta, label: `Learned from your feedback (${top.join(", ")})` };
  }

  // What `author` becomes when no line looks like a name. It is a placeholder,
  // not a person, and the same one for every post that takes it — so writing it
  // into a people list would silently judge every unattributable post at once.
  // Anything that adds an author to a list checks for it.
  const UNKNOWN_AUTHOR = "A LinkedIn post";

  // The learned model, coming back from an exported file. Same reasoning as
  // sanitizeSettings: untrusted by the time it returns, so it is rebuilt rather
  // than trusted, and bounded so one file cannot fill the quota.
  //
  // It belongs in an export because a restore without it hands back a filter
  // that has forgotten everything and contributes nothing until eight more
  // judgements — while the button that produced the file is described as the way
  // to move to a new machine.
  function sanitizeModel(raw) {
    if (!isPlainObject(raw)) return null;

    const bag = (value) => {
      const out = Object.create(null);
      if (!isPlainObject(value)) return out;
      let kept = 0;
      for (const [token, count] of Object.entries(value)) {
        if (kept >= VOCAB_LIMIT) break;
        if (typeof token !== "string" || !token || token.length > 24) continue;
        const n = Number(count);
        if (!Number.isFinite(n) || n <= 0) continue;
        out[token] = Math.min(1e6, Math.round(n));
        kept++;
      }
      return out;
    };

    const seen = Object.create(null);
    if (isPlainObject(raw.seen)) {
      let kept = 0;
      for (const [key, label] of Object.entries(raw.seen)) {
        if (kept >= SEEN_LIMIT) break;
        if (typeof key !== "string" || (label !== "pos" && label !== "neg")) continue;
        seen[key.slice(0, 200)] = label;
        kept++;
      }
    }

    return {
      pos: bag(raw.pos),
      neg: bag(raw.neg),
      posDocs: boundedNumber(raw.posDocs, 0, 1e6, 0),
      negDocs: boundedNumber(raw.negDocs, 0, 1e6, 0),
      seen
    };
  }

  const VOCAB_LIMIT = 4000;
  const SEEN_LIMIT = 400;

  // ---------- post extraction ----------
  // Works from rendered text, not markup, so the fixtures can be innerText
  // snapshots. Post text runs: "Feed post", author, degree, body.

  function extractPost(key, rawText, det) {
    if (!key) return null;

    const lines = (rawText || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    // Drop the leading accessibility label if present (any locale keeps it first;
    // we only special-case English, everything else just stays in the text).
    const startIndex = det.feedPostLabel.test(lines[0]) ? 1 : 0;

    // Skip the social-context banner ("X likes this", "Followed by Y",
    // "Z commented", "W reposted this") that precedes the real author line.
    let authorIndex = startIndex;
    while (authorIndex < lines.length - 1 && det.socialContext.test(lines[authorIndex])) authorIndex++;

    const author = lines[authorIndex] && lines[authorIndex].length < 120
      ? lines[authorIndex]
      : UNKNOWN_AUTHOR;

    const text = lines.slice(startIndex).join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 35) return null;

    // Connection degree appears in the post header as "• 1st" / "• 2nd" / "• 3rd".
    const degree = (lines.slice(0, authorIndex + 4).join(" ").match(det.degree) || [])[1] || null;

    // Body lines, minus LinkedIn UI chrome, for formatting heuristics.
    const bodyLines = lines.slice(authorIndex + 2).filter((line) => !det.uiLine.test(line));
    const shortLines = bodyLines.filter((line) => line.length < 60);

    return {
      key,
      text,
      author,
      degree,
      hasSocialContext: authorIndex > startIndex,
      // Both of these are LABELS in the post header, not words that happen to
      // appear near the top. Testing a positional window over joined text meant
      // the body was inside it, because a post's body starts two or three lines
      // after the author.
      //
      // The label is its own line in the post header, and the safety comes from
      // the pattern rather than from the window. It used to be a loose
      // \b(promoted|sponsored)\b guarded by a narrow window and a 24-character
      // cap, which hid "I have been promoted to Director of Engineering" at
      // 0/100 for every user until the window was pulled in — and the window
      // then missed the real shapes. Three exist:
      //   author, "Promoted"                                  (a company page)
      //   author, follower count, "Promoted"                  (a followed page)
      //   author, degree, headline, "Promoted by <brand>"      (a person, paid for)
      // The last is four lines in, so a window that stops at three cannot see it.
      // Anchoring the pattern to a line that IS the label — "Promoted",
      // "Sponsored", "Promoted by <brand>" and nothing else — is what makes the
      // wider window safe: "Just got promoted!" no longer matches at any width.
      isSponsored: lines.slice(startIndex, authorIndex + 5)
        .some((line) => line.length <= 60 && det.sponsored.test(line)),
      // A feed module's name lands in the author slot. Testing the first 250
      // characters of the body meant anyone headlined "Senior Producer, Games"
      // had every post they ever wrote hidden permanently as a feed module,
      // because the headline is part of `text`.
      isModule: det.modules.test(author),
      isPoll: det.poll.test(text),
      isBroetry: bodyLines.length >= 12 && shortLines.length / bodyLines.length > 0.85,
      emojiCount: (text.match(/\p{Extended_Pictographic}/gu) || []).length
    };
  }

  // ---------- importing settings ----------
  // An exported file is untrusted input by the time it comes back: hand-edited,
  // from an older version, or simply not ours. Build the result from the
  // defaults and copy across only known keys of the right type, so an import can
  // add nothing and corrupt nothing. Unknown keys are dropped.

  const isPlainObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  // Caps on an imported file. Without them one file could carry 100,000
  // interests and a two-million-character phrase: measured at 7.3MB against a
  // 10MB quota, about 34ms per decide() call, and a preferences page that then
  // tried to render 150,000 chip elements. Generous enough that no real
  // configuration touches them.
  const MAX_LIST_ENTRIES = 500;
  const MAX_ENTRY_LENGTH = 200;
  const MAX_PROFILES = 50;
  const MAX_AUTHOR_MARKS = 2000;

  const stringList = (value) => Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim().slice(0, MAX_ENTRY_LENGTH)).filter(Boolean))]
        .slice(0, MAX_LIST_ENTRIES)
    : [];

  const boundedNumber = (value, min, max, fallback) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback;

  // `now` is passed in to keep this pure. Omitting it keeps every mark, which is
  // the safe direction: it decays normally rather than being discarded.
  function sanitizeSettings(raw, now) {
    const defaults = SETTINGS_DEFAULTS;
    if (!isPlainObject(raw)) return null;

    const thresholds = { ...defaults.thresholdByMode };
    if (isPlainObject(raw.thresholdByMode)) {
      for (const mode of Object.keys(thresholds)) {
        thresholds[mode] = boundedNumber(raw.thresholdByMode[mode], 0, 100, thresholds[mode]);
      }
    }

    // Counters written before the post-level action was renamed sat under
    // `folded`. Carried across so an upgrade does not zero the popup.
    const stats = { ...defaults.stats };
    if (isPlainObject(raw.stats) && raw.stats.hidden === undefined) {
      raw = { ...raw, stats: { ...raw.stats, hidden: raw.stats.folded } };
    }
    if (isPlainObject(raw.stats)) {
      for (const field of Object.keys(stats)) {
        stats[field] = boundedNumber(raw.stats[field], 0, Number.MAX_SAFE_INTEGER, stats[field]);
      }
    }

    // Marks are name -> timestamp. A mark in the future would never decay, so
    // anything ahead of the clock is dropped rather than trusted.
    const marks = {};
    if (isPlainObject(raw.authorMarks)) {
      for (const [name, when] of Object.entries(raw.authorMarks)) {
        if (Object.keys(marks).length >= MAX_AUTHOR_MARKS) break;
        if (typeof name !== "string" || !name.trim()) continue;
        if (typeof when !== "number" || !Number.isFinite(when) || when <= 0) continue;
        if (now && when > now) continue;
        marks[normalise(name)] = when;
      }
    }

    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.slice(0, MAX_PROFILES).filter(isPlainObject)
          .filter((profile) => typeof profile.id === "string" && typeof profile.name === "string")
          .map((profile) => ({
            id: profile.id.slice(0, MAX_ENTRY_LENGTH),
            name: profile.name.slice(0, 60),
            interests: stringList(profile.interests),
            mutedPhrases: stringList(profile.mutedPhrases),
            threshold: boundedNumber(profile.threshold, 0, 100, defaults.thresholdByMode.discover)
          }))
      : [];

    const active = typeof raw.activeProfile === "string"
      && profiles.some((profile) => profile.id === raw.activeProfile)
      ? raw.activeProfile
      : null;

    const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

    return {
      onboardingComplete: bool(raw.onboardingComplete, true),
      enabled: bool(raw.enabled, defaults.enabled),
      mode: Object.keys(thresholds).includes(raw.mode) || raw.mode === "raw" ? raw.mode : defaults.mode,
      thresholdByMode: thresholds,
      interests: stringList(raw.interests),
      mutedPhrases: stringList(raw.mutedPhrases),
      allowedAuthors: stringList(raw.allowedAuthors),
      blockedAuthors: stringList(raw.blockedAuthors),
      authorMarks: marks,
      authorDecayDays: boundedNumber(raw.authorDecayDays, 0, 365, defaults.authorDecayDays),
      // Carried through so an export round-trips. Discarded rather than clamped
      // when dated in the future, for the same reason a future-dated author mark
      // is: clamping to `now` would turn a hostile file into a counter reset on
      // whatever feed tab happens to be open, and a stamp that never arrives is
      // the safer failure.
      statsResetAt: (() => {
        const value = boundedNumber(raw.statsResetAt, 0, Number.MAX_SAFE_INTEGER, defaults.statsResetAt);
        return value > now ? defaults.statsResetAt : value;
      })(),
      profiles,
      activeProfile: active,
      structuralFiltering: bool(raw.structuralFiltering, defaults.structuralFiltering),
      hideRightRail: bool(raw.hideRightRail, defaults.hideRightRail),
      hideLeftRailExtras: bool(raw.hideLeftRailExtras, defaults.hideLeftRailExtras),
      stats
    };
  }

  // ---------- author decay ----------
  // Marked entries fade linearly to nothing over authorDecayDays, then
  // pruneDecayedAuthors drops them. Unmarked entries never fade.

  const DAY_MS = 24 * 60 * 60 * 1000;

  function authorStrength(mark, now, decayDays) {
    if (!mark || !now || !decayDays) return 1;
    const days = (now - mark) / DAY_MS;
    if (days <= 0) return 1;
    if (days >= decayDays) return 0;
    return 1 - days / decayDays;
  }

  /** Match strength after decay; 0 means expired, same as not being listed. */
  // Whole words on both sides. Plain containment meant a short entry matched
  // people it had nothing to do with — "Dan" force-kept "Danielle Okafor" and
  // every "Dan" in a headline — while still allowing the case that has to work,
  // where a stored "Jane Doe" is the same person as "Jane Doe, PhD".
  function nameMatches(haystack, needle) {
    if (!needle) return false; // a blank entry would otherwise match everything
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : haystack[at - 1];
      const after = haystack[at + needle.length] || "";
      const isWordChar = (ch) => /[a-z0-9]/.test(ch);
      if (!isWordChar(before) && !isWordChar(after)) return true;
      from = at + 1;
    }
  }

  // Own properties only. `marks[needle]` walked the prototype chain, so an
  // author normalising to "constructor" returned Object.prototype.constructor,
  // authorStrength did arithmetic on a function, and the result was NaN — which
  // fails `> 0`, so the block silently never applied. "Constructor" is a real
  // company name.
  const ownMark = (marks, needle) =>
    Object.prototype.hasOwnProperty.call(marks || {}, needle) ? marks[needle] : undefined;

  function listStrength(list, haystack, marks, now, decayDays) {
    let strength = 0;
    for (const entry of list || []) {
      const needle = normalise(entry);
      if (!nameMatches(haystack, needle)) continue;
      strength = Math.max(strength, authorStrength(ownMark(marks, needle), now, decayDays));
    }
    return strength;
  }

  /** Fully decayed entries, or null when there is nothing to drop. */
  function pruneDecayedAuthors(settings, now) {
    const marks = settings.authorMarks || {};
    const decayDays = settings.authorDecayDays;
    if (!now || !decayDays) return null;

    const expired = Object.keys(marks).filter((name) => authorStrength(marks[name], now, decayDays) === 0);
    if (!expired.length) return null;

    const gone = new Set(expired);
    const keep = (list) => (list || []).filter((entry) => !gone.has(normalise(entry)));
    const nextMarks = { ...marks };
    for (const name of expired) delete nextMarks[name];

    return {
      allowedAuthors: keep(settings.allowedAuthors),
      blockedAuthors: keep(settings.blockedAuthors),
      authorMarks: nextMarks,
      expired
    };
  }

  // ---------- interest profiles ----------
  // Overlays on the top-level settings, which are themselves the default
  // profile. A profile's threshold applies to Discover only — Focus and Digest
  // must mean the same thing in every profile.

  function resolveProfile(settings) {
    // ?? not ||: a threshold of 0 is legitimate and || would read it as unset.
    const modeCutoff = (settings.thresholdByMode || {})[settings.mode] ?? 45;
    const active = (settings.profiles || []).find((profile) => profile.id === settings.activeProfile);
    if (!active) {
      return {
        id: null,
        name: "Default",
        interests: settings.interests || [],
        mutedPhrases: settings.mutedPhrases || [],
        threshold: modeCutoff
      };
    }
    return {
      id: active.id,
      name: active.name,
      interests: active.interests || [],
      mutedPhrases: active.mutedPhrases || [],
      threshold: settings.mode === "discover" && typeof active.threshold === "number"
        ? active.threshold
        : modeCutoff
    };
  }

  // ---------- scoring ----------

  // `now` is passed in to keep this pure. Omitting it means no decay.
  function decide(post, settings, det, model, now) {
    const text = normalise(post.text);
    const author = normalise(post.author);
    const profile = resolveProfile(settings);
    const reasons = [];
    let score = 50;
    const add = (delta, label) => { score += delta; reasons.push({ delta, label }); };

    if (settings.structuralFiltering && post.isSponsored) add(-100, "Promoted content");
    if (settings.structuralFiltering && post.isModule) add(-70, "Feed module you chose to filter");

    // Guard the NORMALISED needle, not the raw entry: a blank entry would match
    // every post. listStrength() guards the author lists the same way.
    for (const phrase of profile.mutedPhrases) {
      const needle = normalise(phrase);
      if (needle && text.includes(needle)) add(-24, `Muted phrase: “${phrase}”`);
    }
    for (const topic of profile.interests) {
      const needle = normalise(topic);
      if (needle && text.includes(needle)) add(16, `Your interest: ${topic}`);
    }

    // Author verdicts fade; a faded entry contributes proportionally less.
    const marks = settings.authorMarks;
    const decayDays = settings.authorDecayDays;

    // Label off the DELTA, not the raw strength: `strength < 1` marks a
    // minute-old judgement as fading beside an unchanged number.
    const faded = (full, strength, label) => {
      const delta = Math.round(full * strength);
      return { delta, label: Math.abs(delta) < Math.abs(full) ? `${label} · fading` : label };
    };

    let priority = false;
    const allowed = listStrength(settings.allowedAuthors, author, marks, now, decayDays);
    if (allowed > 0) {
      const { delta, label } = faded(50, allowed, "Person you never miss");
      add(delta, label);
      priority = true;
    }
    const blocked = listStrength(settings.blockedAuthors, author, marks, now, decayDays);
    if (blocked > 0) {
      const { delta, label } = faded(-100, blocked, "Author you muted");
      add(delta, label);
      priority = false;
    }

    // Why is this post in the feed at all?
    if (post.hasSocialContext) add(-12, "In your feed because someone reacted to it");
    else if (!post.isSponsored && !post.isModule) add(8, "From someone you follow");
    if (post.degree === "1st") add(10, "1st-degree connection");
    if (post.degree === "3rd") add(-8, "3rd-degree connection");

    // Format signals.
    if (post.isPoll) add(-20, "Poll");
    if (post.isBroetry) add(-10, "Engagement-bait formatting");
    if (post.emojiCount > 10) add(-6, "Heavy emoji use");
    if (det.bait.test(post.text)) {
      add(-16, "Engagement-bait language");
    }
    if (/\b\d+(%|x| hours| days|ms|k)\b/i.test(post.text)) add(5, "Specific detail");
    if (post.text.length > 1000) add(4, "Long-form analysis");

    const learned = learnedSignal(model, post.text);
    if (learned) add(learned.delta, learned.label);

    score = Math.max(0, Math.min(100, score));
    const cutoff = profile.threshold;
    // Digest is binary: no "maybe" band.
    let outcome =
      settings.mode === "raw" || !settings.enabled ? "keep"
      : settings.mode === "digest" ? (score >= cutoff ? "keep" : "hide")
      : score >= cutoff + 15 ? "keep"
      : score >= cutoff ? "dim"
      : "hide";
    if (priority) outcome = "keep"; // "never miss" means never hide, whatever else matched

    return {
      score,
      outcome,
      priority,
      profile: profile.name,
      reasons: reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    };
  }

  return {
    DETECTION_DEFAULTS,
    SETTINGS_DEFAULTS,
    MIN_DOCS,
    MIN_INFORMATIVE_WEIGHT,
    MAX_NUDGE,
    DAY_MS,
    compileDetection,
    normalise,
    sanitizeSettings,
    sanitizeModel,
    authorStrength,
    listStrength,
    nameMatches,
    UNKNOWN_AUTHOR,
    pruneDecayedAuthors,
    resolveProfile,
    STOPWORDS,
    tokenize,
    tokenWeight,
    learnedSignal,
    extractPost,
    decide
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CleanSlateEngine;
