// The decisions the content script makes that are not about the DOM.
//
// engine.js scores a post. This decides what the feed layer does around that:
// which pages count, what goes in the hidden-post log and what stays out, what the
// learner records, which remembered verdicts to drop, and when the feed is
// broken rather than slow.
//
// Same rules as engine.js — no DOM, no chrome.*, no mutable module state. It
// exists because content.js could not be tested at all: it touches chrome.* and
// document at parse time, so it cannot be required, and every assertion about
// it was a regex over its own source text. Sixty-three deliberate breakages were
// run against that suite before this module existed and thirty survived,
// including onFeedPage() rewritten to always return true.
//
// Loaded as a content script after engine.js and before content.js, and via
// require() from the tests. See DEVELOPING.md.

var CleanSlateRuntime = (() => {
  const normalise = (value) => (value || "").toLowerCase().replace(/\s+/g, " ").trim();

  // ---------- which pages count ----------

  // The home feed and nothing beneath it. A prefix match also admitted
  // /feed/hashtag/, /feed/following/ and single-post permalinks at
  // /feed/update/urn:li:activity:…, where posts were scored, decorated and
  // eligible for the hidden-post log — against a privacy policy that says nothing is
  // stored away from the home feed.
  const trimSlashes = (path) => String(path || "").replace(/\/+$/, "");

  function matchesFeedPath(pathname, feedPaths) {
    const here = trimSlashes(pathname);
    return (feedPaths || []).some((path) => trimSlashes(path) === here);
  }

  // ---------- settings ----------

  // The two nested objects have to be merged a level down or a stored settings
  // object written by an older version loses whichever keys it never had.
  // Counters written before the post-level action was renamed sat under
  // `folded`. This is the path an upgrade actually takes: sanitizeSettings runs
  // on import only, so carrying it there and nowhere else reset every upgrading
  // user's popup to zero and left the old number sitting beside it as a key
  // nothing reads. The legacy field is dropped once it has been carried, so it
  // does not linger in storage forever.
  function mergeStoredStats(defaults, stored) {
    const { folded, ...rest } = stored || {};
    const merged = { ...defaults, ...rest };
    if (folded !== undefined && rest.hidden === undefined) merged.hidden = folded;
    return merged;
  }

  function mergeSettings(defaults, saved) {
    const from = saved || {};
    return {
      ...defaults,
      ...from,
      thresholdByMode: { ...defaults.thresholdByMode, ...(from.thresholdByMode || {}) },
      stats: mergeStoredStats(defaults.stats, from.stats)
    };
  }

  function bumpStat(stats, field) {
    return { ...stats, [field]: (Number(stats && stats[field]) || 0) + 1 };
  }

  // One write for a whole processing pass. Bumping each counter on its own wrote
  // the entire settings object once per scored post, so a feed of fifty posts
  // was fifty full writes plus fifty storage events echoing back.
  function bumpStats(stats, counts) {
    const next = { ...stats };
    for (const [field, by] of Object.entries(counts || {})) {
      const amount = Number(by) || 0;
      if (amount > 0) next[field] = (Number(next[field]) || 0) + amount;
    }
    return next;
  }

  // ---------- author marks ----------
  // A stamp is what makes a judgement fade, so only the negative actions stamp.
  // "Never miss" promises permanence in its own copy.

  const stampAuthor = (marks, author, now) => ({ ...marks, [normalise(author)]: now });

  function unstampAuthor(marks, author) {
    const next = { ...marks };
    delete next[normalise(author)];
    return next;
  }

  // ---------- the learner ----------

  const SEEN_CAP = 400;
  const VOCAB_CAP = 4000;

  const emptyModel = () => ({ pos: {}, neg: {}, posDocs: 0, negDocs: 0, seen: {} });

  // Returns a new model, or null when there is nothing to record. The guard is
  // what stops a second press on the same post counting twice — the review
  // page's accuracy figure and the ±18 bound both depend on it.
  function trainModel(model, key, label, tokens) {
    if (!model || model.seen[key] === label) return null;

    const seen = { ...model.seen, [key]: label };
    const seenKeys = Object.keys(seen);
    if (seenKeys.length > SEEN_CAP) delete seen[seenKeys[0]];

    const bag = { ...(label === "pos" ? model.pos : model.neg) };
    for (const token of tokens) bag[token] = (bag[token] || 0) + 1;

    // Keep the vocabulary bounded: drop singletons once a bag gets large.
    if (Object.keys(bag).length > VOCAB_CAP) {
      for (const token of Object.keys(bag)) if (bag[token] <= 1) delete bag[token];
    }

    const next = { ...model, seen };
    if (label === "pos") { next.pos = bag; next.posDocs = model.posDocs + 1; }
    else { next.neg = bag; next.negDocs = model.negDocs + 1; }
    return next;
  }

  // Reverses trainModel exactly, so an undone judgement leaves nothing behind.
  // Without it, undo would restore the list and keep teaching the opposite.
  function untrainModel(model, key, label, tokens) {
    if (!model || model.seen[key] !== label) return null;

    const seen = { ...model.seen };
    delete seen[key];

    const bag = { ...(label === "pos" ? model.pos : model.neg) };
    for (const token of tokens) {
      if (!bag[token]) continue;
      if (--bag[token] <= 0) delete bag[token];
    }

    const next = { ...model, seen };
    if (label === "pos") { next.pos = bag; next.posDocs = Math.max(0, model.posDocs - 1); }
    else { next.neg = bag; next.negDocs = Math.max(0, model.negDocs - 1); }
    return next;
  }

  // ---------- the hidden-post log ----------

  const HIDDEN_LOG_CAP = 200;
  const HIDDEN_TEXT = 600;
  const HIDDEN_SNIPPET = 140;

  // Why a post was hidden, in one line.
  //
  // This used to take the largest factor by magnitude, which can be a POSITIVE
  // one — so a post was hidden with "Your interest: developer tools" printed on
  // it. The arithmetic: 50, minus 12 for a reshare, minus 10 for formatting,
  // minus 8 for a distant connection, plus 16 for matching an interest. The
  // biggest single number was the one thing arguing to keep it.
  //
  // A product whose whole claim is that it explains itself has to name something
  // the reader could act on. When the outcome was to hide, that is a reason it
  // scored DOWN.
  function hideReason(result) {
    const reasons = (result && result.reasons) || [];
    const against = reasons.filter((r) => r.delta < 0);
    const strongest = (against.length ? against : reasons)
      .slice()
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    return (strongest && strongest.label) || "Below your relevance threshold";
  }

  // The shape PRIVACY.md describes. Both slice lengths and the cap are stated
  // there and in privacy.html, and a test measures what 200 of these weigh.
  function hiddenLogEntry(post, result, now) {
    return {
      key: post.key,
      author: post.author,
      snippet: post.text.slice(0, HIDDEN_SNIPPET),
      text: post.text.slice(0, HIDDEN_TEXT),
      score: result.score,
      reason: hideReason(result),
      ts: now
    };
  }

  // Returns a new log, or null when the entry does not belong in it.
  //
  // `suppressed` holds the posts that were on screen when the user deleted the
  // log. Emptying the array was not enough on its own: deleting everything also
  // removes the settings key, and that path re-decides every visible post as new
  // and logs each hidden post again, so the log refilled from the feed within a frame.
  function appendHidden(log, entry, { cap = HIDDEN_LOG_CAP, suppressed = null } = {}) {
    if (suppressed && suppressed.has(entry.key)) return null;
    if (log.some((existing) => existing.key === entry.key)) return null;

    const next = [...log, entry];
    while (next.length > cap) next.shift();
    return next;
  }

  // ---------- remembered verdicts ----------

  const MAX_DECISIONS = 600;

  // Which keys to forget, and which to detach from their node. A verdict whose
  // post has left the page keeps the node alive otherwise, and a Map that never
  // sheds anything holds every post of a long scroll.
  //
  // Anything still on screen is kept whatever its age: evicting a visible post
  // would have it re-extracted from a node the extension has already decorated,
  // and its own UI text then reads as the post.
  function planDecisionPrune(keysInOrder, liveKeys, max = MAX_DECISIONS) {
    const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
    const detach = keysInOrder.filter((key) => !live.has(key));

    const evict = [];
    let excess = keysInOrder.length - max;
    for (const key of keysInOrder) {
      if (excess <= 0) break;
      if (live.has(key)) continue;
      evict.push(key);
      excess--;
    }
    return { detach, evict };
  }

  // ---------- labels ----------

  function toolbarLabel(result) {
    if (result.priority) return "Priority · never miss";
    if (result.outcome === "keep") return result.score >= 70 ? "Strong match" : "Worth a look";
    return `Maybe · ${result.score}/100`;
  }

  // The label a muted author writes into the log, and the one it wrote before
  // the post-level action was renamed from "fold" to "hide". Matched on the
  // stem: a judgement part-way through its decay appends " · fading" to
  // either, and an entry logged under the old name is still the only copy the
  // reader has of what was hidden before they upgraded.
  const MUTE_REASONS = ["Author you muted", "Author you hide"];
  const isMuteReason = (reason) =>
    MUTE_REASONS.some((stem) => typeof reason === "string" && reason.startsWith(stem));

  const breakdownText = (result) => result.reasons
    .map((r) => `${r.delta > 0 ? "+" : ""}${r.delta} ${r.label}`).join(" · ") || "No single reason stood out";

  // Must agree with how decide() reads the same list, or the star lights up for
  // a post it cannot switch off. It used an exact, case-sensitive comparison on
  // the raw author while scoring used normalised whole-word matching, so a
  // stored "Jane Doe" against an author rendered "Jane Doe, PhD" — or the same
  // name in different case — showed as pinned and refused to unpin. help.html
  // promises the button toggles.
  const isPriorityAuthor = (allowedAuthors, author, matches) =>
    (allowedAuthors || []).some((entry) => matches(normalise(author), normalise(entry)));

  // ---------- is the feed broken, or just slow ----------

  const HEALTH_GRACE_MS = 15000;

  // A slow feed and a dead selector look identical for the first few seconds,
  // so the banner waits for the path to settle and for the page to have real
  // text on it. Loosening either turns a bad connection into a false alarm.
  function healthVerdict(state) {
    const {
      onFeed, enabled, mode, postCount, mainTextLength,
      pathSettledFor, now, snoozedUntil, graceMs = HEALTH_GRACE_MS
    } = state;

    if (!onFeed || !enabled || mode === "raw") return "idle";
    if (postCount > 0) return "healthy";
    if (pathSettledFor <= graceMs) return "waiting";
    if (mainTextLength <= 2000) return "waiting";
    if (now <= snoozedUntil) return "snoozed";
    return "broken";
  }

  // ---------- panels ----------

  const isDismissKey = (key) => key === "Escape";

  // ---------- the diagnostic report ----------

  // Structure only. No page path — on a permalink that is urn:li:activity:<id>,
  // a resolvable post identifier — no attribute values, and no page text beyond
  // its length. The banner tells the user this is page structure only as they
  // paste it into a public issue.
  function diagnosticsPayload(input) {
    return {
      cleanSlateVersion: input.version,
      when: input.when,
      detection: `${input.detectionVersion} (${input.detectionLocale})`,
      locale: input.locale,
      readyState: input.readyState,
      mainTextLength: input.mainTextLength,
      selectorHits: { ...input.selectorHits },
      attributeNamesSeen: [...input.attributeNames].sort().slice(0, 80),
      state: { ...input.state }
    };
  }

  return {
    SEEN_CAP,
    VOCAB_CAP,
    HIDDEN_LOG_CAP,
    HIDDEN_TEXT,
    HIDDEN_SNIPPET,
    MAX_DECISIONS,
    HEALTH_GRACE_MS,
    emptyModel,
    matchesFeedPath,
    mergeSettings,
    mergeStoredStats,
    bumpStat,
    bumpStats,
    stampAuthor,
    unstampAuthor,
    trainModel,
    untrainModel,
    hideReason,
    hiddenLogEntry,
    appendHidden,
    planDecisionPrune,
    toolbarLabel,
    MUTE_REASONS,
    isMuteReason,
    breakdownText,
    isPriorityAuthor,
    healthVerdict,
    isDismissKey,
    diagnosticsPayload
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CleanSlateRuntime;
