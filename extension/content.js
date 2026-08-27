// Content script for the LinkedIn home feed: DOM, storage and messaging around
// the pure core in engine.js.
//
// Two rules the feed markup imposes, both easy to break:
//   - Identify posts by role + componentkey. Class names are hashed.
//   - NEVER insert a sibling into the React-managed list. Add one child inside
//     the post container and a class on the container; CSS hides the rest.
//
// See DEVELOPING.md.

(() => {
  const KEY = "cleanSlateSettings";
  const DEBUG_PREFIX = "[CleanSlate]";
  // engine.js is loaded first by the manifest, so this is defined.

  const {
    DETECTION_DEFAULTS, SETTINGS_DEFAULTS,
    compileDetection, normalise, tokenize, pruneDecayedAuthors,
    extractPost: extractPostText, decide, nameMatches, UNKNOWN_AUTHOR
  } = CleanSlateEngine;

  // runtime.js is loaded between engine.js and this file. Everything here that
  // is a decision rather than a DOM operation lives there, where it can be
  // tested — this file cannot be required, so anything left in it is only ever
  // asserted by regex over its own source.
  const {
    MAX_DECISIONS, HEALTH_GRACE_MS,
    emptyModel, matchesFeedPath, mergeSettings, bumpStats, stampAuthor, unstampAuthor,
    trainModel, untrainModel, hideReason, hiddenLogEntry, appendHidden, planDecisionPrune,
    toolbarLabel, breakdownText, isPriorityAuthor: isPriorityIn,
    healthVerdict, isDismissKey, diagnosticsPayload
  } = CleanSlateRuntime;

  const docLang = () => document.documentElement.lang || navigator.language || "en";

  // The probe is what lets engine.js reject a malformed selector without
  // referencing a DOM itself. A bad one in detection.json used to throw inside
  // querySelectorAll before the observer was attached, so the extension did
  // nothing and the breakage banner never fired either.
  const selectorProbe = (value) => document.querySelector(value);

  let det = compileDetection(DETECTION_DEFAULTS, docLang(), selectorProbe);

  async function loadDetection() {
    try {
      const response = await fetch(chrome.runtime.getURL("detection.json"));
      det = compileDetection(await response.json(), docLang(), selectorProbe);
    } catch (error) {
      log("detection.json failed to load; using built-in patterns.", error);
    }
  }

  const DEFAULTS = SETTINGS_DEFAULTS;

  let settings = null;
  // postKey -> { post, result, revealed } — survives React remounts of the node.
  const decisions = new Map();
  // Ships off. When it was on, every scored post wrote an author name and 60
  // characters of that post's text to the console of a page LinkedIn's own
  // scripts run on. Flip it locally while working; do not commit it true.
  let debug = false;

  const log = (...args) => { if (debug) console.log(DEBUG_PREFIX, ...args); };
  const unique = (items) => [...new Set(items.filter(Boolean))];

  // Every write goes through this. Storage can fail — quota, a closing profile —
  // and a bare set() turns that into an unhandled rejection that loses the write
  // with no trace.
  const persist = (items) => chrome.storage.local.set(items)
    .catch((error) => log("storage write failed; this action was not saved.", error));

  // ---------- settings ----------

  async function loadSettings() {
    const saved = (await chrome.storage.local.get(KEY))[KEY] || {};
    settings = mergeSettings(DEFAULTS, saved);
    return settings;
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    if (patch.stats) settings.stats = { ...settings.stats, ...patch.stats };
    await persist({ [KEY]: settings });
  }

  // Counters are written as a delta applied to whatever is in storage at the
  // moment of the write, never as an absolute carried in memory. Two feed tabs
  // each holding their own total overwrote each other: the numbers went
  // backwards, and a tab left open pinned them to its own tally for as long as
  // it lived. Reading at write time makes concurrent tabs additive.
  //
  // Serialised, because two passes in the same tab would otherwise read the same
  // value and the second would drop the first.
  let statsQueue = Promise.resolve();

  function addStats(delta) {
    statsQueue = statsQueue.then(async () => {
      const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
      settings = { ...settings, stats: bumpStats(mergeSettings(DEFAULTS, stored).stats, delta) };
      await persist({ [KEY]: settings });
    }).catch((error) => log("counter write failed; the count was not saved.", error));
    return statsQueue;
  }

  const incrementStat = (field) => addStats({ [field]: 1 });

  // ---------- author decay ----------
  // A stamp is what makes a judgement fade. Only the NEGATIVE actions stamp:
  // "Never miss" and "Always show author" promise permanence in their own copy.
  const markAuthor = (author) => stampAuthor(settings.authorMarks, author, Date.now());

  const withoutMark = (author) => unstampAuthor(settings.authorMarks, author);

  // Drops fully faded entries. Writes nothing when there is nothing to drop.
  async function pruneAuthors() {
    const pruned = pruneDecayedAuthors(settings, Date.now());
    if (!pruned) return;
    const { expired, ...patch } = pruned;
    log(`author judgements expired after ${settings.authorDecayDays} days:`, expired.join(", "));
    await saveSettings(patch);
  }

  // ---------- learned model ----------
  // Every explicit action is a label. Local only; nudges scores within ±18 so
  // the rules keep dominating.

  const MODEL_KEY = "cleanSlateModel";
  let model = null;

  async function loadModel() {
    const saved = (await chrome.storage.local.get(MODEL_KEY))[MODEL_KEY] || {};
    model = { ...emptyModel(), ...saved };
  }

  function train(post, label) { // label: "pos" | "neg"
    const next = trainModel(model, post.key, label, tokenize(post.text));
    if (!next) return; // already judged this post the same way
    model = next;
    persist({ [MODEL_KEY]: model });
    log(`trained ${label}:`, post.author, `(${model.posDocs}+ / ${model.negDocs}−)`);
  }

  // Reverses train(), so an undone judgement leaves nothing behind. Without
  // this, undo would restore the list but keep teaching the model the opposite.
  function untrain(post, label) {
    const next = untrainModel(model, post.key, label, tokenize(post.text));
    if (!next) return; // nothing recorded under this label
    model = next;
    persist({ [MODEL_KEY]: model });
  }

  // ---------- hidden-post log (backs the review page) ----------

  // The storage key predates the rename of the post-level action from "fold"
  // to "hide". Left alone: nobody sees it, and renaming it needs a migration
  // that can only lose somebody their log.
  const LOG_KEY = "cleanSlateFoldLog";
  let hiddenLog = [];
  // Post keys that were on screen when the user deleted the log. See the
  // storage listener for why emptying the array alone put them straight back.
  const suppressLogFor = new Set();

  async function loadHiddenLog() {
    hiddenLog = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
  }

  function logHidden(post, result) {
    const next = appendHidden(hiddenLog, hiddenLogEntry(post, result, Date.now()), { suppressed: suppressLogFor });
    if (!next) return; // already logged, or deleted while this post was on screen
    hiddenLog = next;
    persist({ [LOG_KEY]: hiddenLog });
  }

  // ---------- detection ----------

  // The home feed only, and nothing beneath it. A startsWith match also caught
  // /feed/hashtag/, /feed/following/ and single-post permalinks at
  // /feed/update/urn:li:activity:…, where the extension scored posts, decorated
  // them and was eligible to write them to the hidden-post log — while PRIVACY.md says
  // nothing is stored away from the home feed. Confirmed on a real permalink.
  const onFeedPage = () => matchesFeedPath(location.pathname, det.feedPaths);

  function findPostNodes() {
    return [...document.querySelectorAll(det.post)];
  }

  function postKeyOf(node) {
    return node.getAttribute("componentkey");
  }

  // Thin wrapper around the pure extractor in engine.js.
  // All of this extension's UI lives INSIDE the post container, so by the time a
  // post is decorated its own toolbar and hidden-post card are part of node.innerText.
  // Reading that back gives an author of "Strong match" for a kept post, and for
  // a hidden one an author of "HIDDEN · LOW RELEVANCE" with isSponsored
  // true, because the card's reason line contains the word "Promoted".
  // Verified against the shipped engine on a real feed.
  //
  // Extraction is memoised and pruning skips anything on screen, so this is not
  // reachable on the ordinary path today. That protection is a side effect of
  // two unrelated decisions rather than a rule, and the failure is silent and
  // self-reinforcing: once hidden, the reason confirms it forever, and Mute
  // would write the extension's own label into the author list. So strip first.
  const DECORATION = ".cs-card, .cs-toolbar, .cs-digest, .cs-breakdown";

  function extractPostNode(node) {
    // The ordinary path is a post nobody has touched, and it costs one read.
    // Only a node this extension has already written to needs the detour.
    let text = node.innerText || "";
    if (node.querySelector(DECORATION)) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll(DECORATION).forEach((el) => el.remove());
      // innerText needs layout, and a detached clone has none. Mount it out of
      // view, read, remove.
      clone.style.cssText = "position:absolute;left:-99999px;top:0;width:600px";
      document.body.appendChild(clone);
      text = clone.innerText || "";
      clone.remove();
    }

    const post = extractPostText(postKeyOf(node), text, det);
    if (!post) return post;
    post.node = node;

    // Where LinkedIn rendered a permalink, keep it. The review page could not
    // show you the post it hid, because nothing ever captured a way back — a
    // page built to tell you what you missed, that could not let you read it.
    // Structure only: an href LinkedIn already put on the page.
    const link = node.querySelector("a[href*='/feed/update/']");
    if (link && link.href) post.url = link.href.split("?")[0];

    return post;
  }

  // ---------- decoration (all UI lives INSIDE the post container) ----------

  function makeButton(label, className, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `cs-button ${className || ""}`.trim();
    el.textContent = label;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return el;
  }

  function reveal(entry) {
    entry.revealed = true;
    incrementStat("revealed");
    train(entry.post, "pos");
    if (entry.post.node) applyDecoration(entry.post.node, entry);
  }

  // "More like this" teaches the model and changes no list. It used to be the
  // same code path as "Always show author" — a soft-sounding button that pinned
  // an author permanently, while the harsher "Less like this" decayed after a
  // month. The labels now match what happens.
  // The extractor falls back to a single placeholder when no line looks like a
  // name, and it is the same string for every such post. Writing it into a
  // people list would judge all of them at once, and match nothing a user would
  // recognise. Nothing that edits a list may accept it.
  const namesAPerson = (author) => Boolean(author) && author !== UNKNOWN_AUTHOR;

  function recordFeedback(entry, kind) {
    const patch = {};
    const who = entry.post.author;

    if (kind === "more") {
      train(entry.post, "pos");
      offerUndo(`Learning that you want more like this.`, async () => {
        untrain(entry.post, "pos");
      });
    }
    // The two paths below write a name into a people list, so neither may run
    // on the placeholder. "More like this" is unaffected: it teaches the model
    // from the post's words and touches no list.
    if (kind === "always" && namesAPerson(who)) {
      patch.allowedAuthors = unique([...settings.allowedAuthors, who]);
      train(entry.post, "pos");
      offerUndo(`${who} will always be shown.`, async () => {
        untrain(entry.post, "pos");
        await saveSettings({ allowedAuthors: settings.allowedAuthors.filter((name) => name !== who) });
      });
    }
    // Model-only, and the mirror of "More like this" — which is what its label
    // and its position beside that button both say it is.
    //
    // It used to be byte-for-byte the same write as Mute: blockedAuthors, a
    // decay stamp and a negative label worth -100. Two buttons of visibly
    // different strength did the same thing, the softer of the two sat next to a
    // genuinely soft twin, and the toast said "Fewer posts from Dana Reyes" and
    // never said the author had been silenced. Acting on a person is what Mute
    // is for, and it is now the only control that does it.
    if (kind === "less") {
      train(entry.post, "neg");
      offerUndo(`Learning that you want fewer like this.`, async () => {
        untrain(entry.post, "neg");
      });
    }
    // Only the approving verdicts open the post. "Less like this" used to land
    // here too, so judging a post you had just hidden put it back on screen —
    // the button that means "less of this" was the one thing that showed it to
    // you again.
    if (kind !== "less") entry.revealed = true;
    addStats({ feedback: 1 });
    saveSettings(patch).then(() => processAll());
  }

  // Post-level "hide this and learn" — the toolbar's thumbs-down.
  function hideNow(entry) {
    const before = entry.result;
    train(entry.post, "neg");
    entry.revealed = false;
    entry.result = {
      ...entry.result,
      outcome: "hide",
      priority: false,
      reasons: [{ delta: -1, label: "You hid it" }, ...entry.result.reasons]
    };
    incrementStat("feedback");
    if (entry.post.node) applyDecoration(entry.post.node, entry);
    // Hide was the one feed action that said nothing. The post collapsed, and
    // neither what it had done nor how to take it back was ever stated, while
    // Mute beside it announced itself and offered an undo. Two buttons that look
    // equally final and explain themselves unequally read as the same button, so
    // the toast names the scope of each.
    offerUndo("Post hidden. Mute hides everything its author writes.", async () => {
      untrain(entry.post, "neg");
      entry.result = before;
      entry.revealed = true;
      if (entry.post.node) applyDecoration(entry.post.node, entry);
    });
  }

  // ---------- undo ----------
  // Muting someone from the feed used to be one-way: the only route back was
  // finding their name in Preferences. Anything that edits a people list now
  // offers to reverse itself, list, decay stamp and training together.
  const UNDO_MS = 9000;

  function offerUndo(message, revert) {
    document.querySelector(".cs-toast")?.remove();

    const toast = document.createElement("aside");
    toast.className = "cs-toast";
    toast.setAttribute("role", "status");

    const text = document.createElement("p");
    text.className = "cs-toast__text";
    text.textContent = message;

    const actions = document.createElement("div");
    actions.className = "cs-toast__actions";
    actions.append(
      makeButton("Undo", "cs-button--primary", async () => {
        clearTimeout(timer);
        toast.remove();
        await revert();
        processAll();
      }),
      makeButton("Dismiss", "", () => { clearTimeout(timer); toast.remove(); })
    );

    toast.append(text, actions);
    document.body.append(toast);
    const timer = setTimeout(() => toast.remove(), UNDO_MS);
  }

  // ---------- floating panels ----------
  // Each of these covers the page at the top of the stacking order. Without a
  // keyboard route in and out, a keyboard user cannot reach the close button and
  // cannot dismiss what is covering the feed.
  function makeDismissible(panel, { restoreFocus = true } = {}) {
    const previous = restoreFocus ? document.activeElement : null;

    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      panel.remove();
      if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus();
    };

    function onKey(event) {
      if (!isDismissKey(event.key) || !panel.isConnected) return;
      event.stopPropagation();
      close();
    }

    document.addEventListener("keydown", onKey, true);
    // Focus the panel itself rather than its first control: a screen reader then
    // announces the panel's label before its contents.
    panel.tabIndex = -1;
    requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    // Hung on the element so anything holding only the node can still tear it
    // down properly. Reopening the review pane, and removing the breakage
    // banner, both called .remove() directly — which detaches the panel and
    // leaves this document-level capture listener attached, one per reopen for
    // the life of the tab.
    panel.__csClose = close;
    return close;
  }

  // Use this instead of .remove() on anything makeDismissible built.
  function dismissPanel(selector) {
    const panel = document.querySelector(selector);
    if (!panel) return;
    if (typeof panel.__csClose === "function") panel.__csClose();
    else panel.remove();
  }

  function buildHiddenCard(entry) {
    const { post, result } = entry;
    const card = document.createElement("section");
    card.className = "cs-card";
    card.setAttribute("aria-label", "Clean Slate hidden post");

    const topline = document.createElement("div");
    topline.className = "cs-card__topline";
    const toplineLabel = document.createElement("span");
    toplineLabel.textContent = "Hidden · low relevance";
    const toplineScore = document.createElement("span");
    toplineScore.className = "cs-card__score";
    toplineScore.textContent = `${result.score}/100`;
    topline.append(toplineLabel, toplineScore);

    const authorEl = document.createElement("div");
    authorEl.className = "cs-card__author";
    authorEl.textContent = post.author;

    const summaryEl = document.createElement("p");
    summaryEl.className = "cs-card__summary";
    summaryEl.textContent = post.text.slice(0, 150);

    const reasonEl = document.createElement("p");
    reasonEl.className = "cs-card__reason";
    reasonEl.textContent = hideReason(result);

    // The score breakdown existed only on posts that were KEPT, because the
    // toolbar it lives on is built only when a post is not hidden. So the one
    // route to the arithmetic on a hidden post was "Show post" — which shows
    // it, teaches the model you wanted it, and moves a counter. Finding out why
    // something was hidden meant destroying the decision you were asking about.
    const why = makeButton("Why?", "cs-card__why", () => toggleCardBreakdown(card, entry, why));
    why.setAttribute("aria-expanded", "false");

    const actions = document.createElement("div");
    actions.className = "cs-card__actions";
    actions.append(
      makeButton("Show post", "cs-button--primary", () => reveal(entry)),
      why,
      makeButton("More like this", "", () => recordFeedback(entry, "more")),
      makeButton("Less like this", "", () => recordFeedback(entry, "less")),
      makeButton("Mute this author", "", () => muteAuthor(entry))
    );

    card.append(topline, authorEl, summaryEl, reasonEl, actions);
    return card;
  }

  // Same arithmetic the toolbar shows, on the card, without revealing anything.
  function toggleCardBreakdown(card, entry, trigger) {
    const existing = card.querySelector(":scope > .cs-breakdown");
    if (existing) {
      existing.remove();
      trigger.setAttribute("aria-expanded", "false");
      return;
    }
    card.append(buildBreakdown(entry.result));
    trigger.setAttribute("aria-expanded", "true");
  }

  // ---------- digest mode ----------
  // Hidden posts collapse to nothing and the first of them hosts one summary
  // card, which doubles as the expander.
  let digestExpanded = false;

  const digestMode = () => settings.enabled && settings.mode === "digest" && !digestExpanded;

  function buildDigestCard() {
    const card = document.createElement("section");
    card.className = "cs-digest";
    card.setAttribute("aria-label", "Clean Slate digest summary");

    const topline = document.createElement("div");
    topline.className = "cs-digest__topline";
    topline.textContent = "Digest";

    const count = document.createElement("p");
    count.className = "cs-digest__count";

    const actions = document.createElement("div");
    actions.className = "cs-digest__actions";
    // "Show them" had no counterpart, so expanding a digest was one-way until
    // the page reloaded. The label follows the state.
    actions.append(makeButton(digestExpanded ? "Hide them again" : "Show them", "cs-button--primary", () => {
      digestExpanded = !digestExpanded;
      processAll();
    }));

    card.append(topline, count, actions);
    return card;
  }

  function applyDigest(nodes) {
    const digest = digestMode();
    let host = null;
    let hidden = 0;

    for (const node of nodes) {
      const entry = decisions.get(postKeyOf(node));
      const isHidden = entry && entry.result.outcome === "hide" && !entry.revealed;
      if (!digest || !isHidden) {
        node.classList.remove("cs-collapsed");
        continue;
      }
      hidden++;
      // toggle(), not add(): the host changes as posts mount and unmount, and a
      // previously collapsed node must not stay hidden once it becomes the host.
      node.classList.toggle("cs-collapsed", Boolean(host));
      if (!host) host = node;
    }

    // The host moves, so a summary anywhere else is stale.
    for (const card of document.querySelectorAll(".cs-digest")) {
      if (card.parentElement !== host) card.remove();
    }
    if (!host) return;

    const existing = host.querySelector(":scope > .cs-digest");
    const card = existing || buildDigestCard();
    card.querySelector(".cs-digest__count").textContent =
      `${hidden} post${hidden === 1 ? "" : "s"} hidden in today's digest.`;
    if (!existing) host.prepend(card);
  }

  // Idempotent: the MutationObserver re-invokes this after React re-renders.
  function applyDecoration(node, entry) {
    const wantHide = entry.result.outcome === "hide" && !entry.revealed;
    const wantDim = entry.result.outcome === "dim" && !entry.revealed;
    // In digest mode a hidden post gets no card; applyDigest() adds the summary.
    const wantCard = wantHide && !digestMode();

    node.classList.toggle("cs-hidden-post", wantHide);
    node.classList.toggle("cs-dimmed", wantDim);

    const existingCard = node.querySelector(":scope > .cs-card");
    if (wantCard && !existingCard) node.prepend(buildHiddenCard(entry));
    if (!wantCard && existingCard) existingCard.remove();

    // Set AND cleared. With no else branch this survived re-scoring and Raw
    // mode, so a post could carry a stale "maybe useful (44/100)" tooltip on
    // LinkedIn's own node while Raw mode promised the feed exactly as it was.
    if (wantDim) node.title = `Clean Slate: maybe useful (${entry.result.score}/100)`;
    else if (node.title.startsWith("Clean Slate:")) node.removeAttribute("title");

    // Toolbar (score label + author feedback) on every visible post.
    const existingBar = node.querySelector(":scope > .cs-toolbar");
    const wantBar = !wantHide && settings.enabled && settings.mode !== "raw";
    if (wantBar && !existingBar) node.prepend(buildToolbar(entry));
    else if (!wantBar && existingBar) existingBar.remove();
    else if (existingBar) updateToolbar(existingBar, entry);
  }

  // breakdownText, toolbarLabel and isPriorityAuthor come from runtime.js.

  // The same arithmetic the tooltip carried, as real content: reachable by
  // keyboard, readable on touch, and selectable.
  // Shared by the toolbar on a kept post and the card on a hidden one. The card
  // had no route to this at all, which is the gap it now closes.
  function buildBreakdown(result) {
    const panel = document.createElement("div");
    panel.className = "cs-breakdown";

    const head = document.createElement("p");
    head.className = "cs-breakdown__head";
    head.textContent = `${result.score}/100 · scored under ${result.profile}`;
    panel.append(head);

    const list = document.createElement("ul");
    list.className = "cs-breakdown__list";
    for (const reason of result.reasons) {
      const item = document.createElement("li");
      const delta = document.createElement("span");
      delta.className = "cs-breakdown__delta";
      delta.textContent = `${reason.delta > 0 ? "+" : ""}${reason.delta}`;
      const text = document.createElement("span");
      text.textContent = reason.label;
      item.append(delta, text);
      list.append(item);
    }
    if (!result.reasons.length) {
      const item = document.createElement("li");
      item.textContent = "Nothing matched either way; it scored the baseline.";
      list.append(item);
    }
    panel.append(list);
    return panel;
  }

  function toggleBreakdown(bar, entry) {
    const existing = bar.querySelector(":scope > .cs-breakdown");
    const label = bar.querySelector(".cs-indicator");
    if (existing) {
      existing.remove();
      label.setAttribute("aria-expanded", "false");
      return;
    }
    bar.append(buildBreakdown(entry.result));
    label.setAttribute("aria-expanded", "true");
  }

  // nameMatches comes from engine.js so the star and the score read the list
  // the same way.
  const isPriorityAuthor = (author) => isPriorityIn(settings.allowedAuthors, author, nameMatches);

  function buildToolbar(entry) {
    const bar = document.createElement("div");
    bar.className = "cs-toolbar";

    // A button, not a span: the breakdown used to live in a title attribute,
    // which keyboard and touch users cannot reach at all — while "we show you the
    // reason for every decision" is the whole promise.
    const label = document.createElement("button");
    label.type = "button";
    label.className = "cs-indicator";
    label.setAttribute("aria-expanded", "false");
    label.title = breakdownText(entry.result);
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleBreakdown(bar, entry);
    });

    const actions = document.createElement("div");
    actions.className = "cs-toolbar__actions";

    const star = document.createElement("button");
    star.type = "button";
    star.className = "cs-iconbtn cs-toolbar__star";
    star.textContent = "★";
    // A screen reader announces a button by its contents, so this was announced
    // as "star" and the title was ignored. The pinned state was the active class
    // alone, which left the accessibility tree identical either way.
    star.setAttribute("aria-label", "Never miss this author");
    star.title = "Never miss this author";
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNeverMiss(entry);
    });

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "cs-iconbtn";
    hide.textContent = "Hide";
    hide.title = "Hide this post and teach the filter";
    hide.addEventListener("click", (event) => {
      event.stopPropagation();
      hideNow(entry);
    });

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "cs-iconbtn";
    mute.textContent = "Mute";
    mute.title = "Mute this author: hide every post they write";
    mute.addEventListener("click", (event) => {
      event.stopPropagation();
      muteAuthor(entry);
    });

    actions.append(star, hide, mute);
    bar.append(label, actions);
    updateToolbar(bar, entry);
    return bar;
  }

  function updateToolbar(bar, entry) {
    const indicator = bar.querySelector(".cs-indicator");
    indicator.textContent = toolbarLabel(entry.result);
    indicator.title = breakdownText(entry.result);
    // A "maybe" takes the quiet dot: the one non-signal dot in the system.
    indicator.classList.toggle("cs-indicator--maybe",
      !entry.result.priority && entry.result.outcome !== "keep");
    const star = bar.querySelector(".cs-toolbar__star");
    const pinned = isPriorityAuthor(entry.post.author);
    star.classList.toggle("cs-iconbtn--active", pinned);
    star.setAttribute("aria-pressed", String(pinned)); // conveyed by colour alone before
  }

  function toggleNeverMiss(entry) {
    const name = entry.post.author;
    if (!namesAPerson(name)) return;
    const adding = !isPriorityAuthor(name);
    if (adding) train(entry.post, "pos");
    const allowed = adding
      ? unique([...settings.allowedAuthors, name])
      : settings.allowedAuthors.filter((existing) => existing !== name);
    // The storage change listener re-scores and re-decorates everything.
    saveSettings({
      allowedAuthors: allowed
    });
    addStats({ feedback: 1 });
  }

  function muteAuthor(entry) {
    const who = entry.post.author;
    // Nothing to mute by name. Hide this one post instead of judging every
    // unattributable post at once.
    if (!namesAPerson(who)) return hideNow(entry);
    train(entry.post, "neg");
    saveSettings({
      blockedAuthors: unique([...settings.blockedAuthors, who]),
      authorMarks: markAuthor(who)
    });
    addStats({ feedback: 1 });
    offerUndo(`Muted ${who}.`, async () => {
      untrain(entry.post, "neg");
      await saveSettings({
        blockedAuthors: settings.blockedAuthors.filter((name) => name !== who),
        authorMarks: withoutMark(who)
      });
    });
  }

  // ---------- rails ----------
  // The rails have no stable class names, so they are identified geometrically:
  // <aside> inside <main>, either side of the feed column. Right rail hides
  // whole; left rail keeps its first box (the profile) and hides the rest.
  // Classification is measured once per rail and remembered on the element, so
  // the common pass does no layout at all. This runs on every mutation burst,
  // and getBoundingClientRect forces layout: measuring here was the most
  // expensive thing in the loop.
  function applyRails(nodes) {
    const active = settings.enabled && settings.mode !== "raw";
    const asides = [...document.querySelectorAll("main aside")];
    if (!asides.length) return;

    const unclassified = asides.filter((aside) =>
      !aside.classList.contains("cs-right-rail") && !aside.classList.contains("cs-left-rail"));

    if (unclassified.length) {
      const feedColumn = nodes[0]?.closest("[role='list']") || document.querySelector(det.feedColumn);
      if (!feedColumn) return;
      const feedBox = feedColumn.getBoundingClientRect();
      for (const aside of unclassified) {
        const box = aside.getBoundingClientRect();
        if (box.width <= 0) continue; // not laid out yet; try again next pass
        if (box.left >= feedBox.right - 8) aside.classList.add("cs-right-rail");
        else if (box.right <= feedBox.left + 8) aside.classList.add("cs-left-rail");
      }
    }

    for (const aside of asides) {
      if (aside.classList.contains("cs-right-rail")) {
        aside.classList.toggle("cs-rail-hidden", active && settings.hideRightRail);
      } else if (aside.classList.contains("cs-left-rail")) {
        let level = aside, depth = 0;
        while (level.childElementCount === 1 && depth < 10) { level = level.children[0]; depth++; }
        const hide = active && settings.hideLeftRailExtras;
        // Which box is the profile box is a question of content, not position.
        // Keeping index 0 assumed LinkedIn never reorders the rail; the day it
        // does, cleanup hides your own profile and keeps the promotion. The
        // profile box is the one linking to a member profile, which no promo box
        // does and which holds in every language. Position stays as the fallback
        // so a markup change that drops the link cannot hide the whole rail.
        const boxes = [...level.children];
        const keep = Math.max(0, boxes.findIndex((el) => el.querySelector("a[href*='/in/']")));
        boxes.forEach((el, index) => el.classList.toggle("cs-box-hidden", hide && index !== keep));
      }
    }
  }

  // A paused extension and a broken one look identical from the feed: nothing is
  // filtered either way. help.html tells people to diagnose a break, and the
  // first thing it has to rule out is the switch they flipped and forgot. Small,
  // fixed, and out of the way — it is a status, not a notice.
  function showPausedMark(label) {
    let mark = document.querySelector(".cs-paused");
    if (!mark) {
      mark = document.createElement("div");
      mark.className = "cs-paused";
      mark.setAttribute("role", "status");
      document.body.append(mark);
    }
    mark.textContent = `Clean Slate · ${label}`;
  }

  // ---------- processing loop ----------

  function processAll() {
    if (!settings) return;

    if (!onFeedPage()) {
      // Navigating away inside the SPA. There is nothing to process, but the
      // verdicts still hold nodes React has thrown away, and pruning used to sit
      // below this return — so leaving the feed froze the Map holding up to 600
      // detached post subtrees until the next visit.
      pruneDecisions([]);
      return;
    }

    const nodes = findPostNodes();
    applyRails(nodes);

    if (settings.mode === "raw" || !settings.enabled) {
      nodes.forEach((node) => stripDecoration(node));
      showPausedMark(settings.enabled ? "Raw mode" : "Paused");
      return;
    }
    document.querySelector(".cs-paused")?.remove();

    // Reads first, then writes. Interleaving them forced a full-document layout
    // per new post — innerText needs layout, and decorating the previous post
    // had just invalidated it. A re-score of 300 posts after a preference change
    // was 300 forced layouts inside one animation frame.
    const pending = [];
    const counted = { checked: 0, hidden: 0, dimmed: 0 };

    for (const node of nodes) {
      const key = postKeyOf(node);
      let entry = decisions.get(key);

      if (!entry) {
        const post = extractPostNode(node);
        if (!post) continue;
        entry = { post, result: decide(post, settings, det, model, Date.now()), revealed: false };
        decisions.set(key, entry);
        counted.checked++;
        if (entry.result.outcome === "hide") { counted.hidden++; logHidden(post, entry.result); }
        if (entry.result.outcome === "dim") counted.dimmed++;
        log(`scored ${entry.result.score}/100 → ${entry.result.outcome}:`,
          post.author, "—", post.text.slice(0, 60));
      } else {
        entry.post.node = node; // node may be a fresh mount of the same post
      }

      pending.push([node, entry]);
    }

    for (const [node, entry] of pending) applyDecoration(node, entry);

    // One write for the whole pass. Bumping each counter separately wrote the
    // entire settings object once per scored post.
    if (counted.checked) addStats(counted);

    // After every post has a verdict: the summary counts what it hid.
    applyDigest(nodes);
    pruneDecisions(nodes);
  }

  // decisions is keyed by componentkey so a verdict survives React remounting a
  // post. Two things follow, and neither is optional on an infinite feed:
  // it must not grow without limit, and it must not hold a node React has thrown
  // away — that keeps detached DOM alive for the life of the tab.

  function pruneDecisions(nodes) {
    // Map iterates in insertion order, so runtime.js sees oldest-first.
    const { detach, evict } = planDecisionPrune([...decisions.keys()], nodes.map(postKeyOf));
    for (const key of detach) {
      const entry = decisions.get(key);
      if (entry && entry.post.node) entry.post.node = null;
    }
    for (const key of evict) decisions.delete(key);
  }

  function stripDecoration(node) {
    node.classList.remove("cs-hidden-post", "cs-dimmed", "cs-collapsed");
    // Raw mode says the feed exactly as it was, so the tooltip goes too.
    if (node.title && node.title.startsWith("Clean Slate:")) node.removeAttribute("title");
    node.querySelectorAll(":scope > .cs-card, :scope > .cs-toolbar, :scope > .cs-digest")
      .forEach((el) => el.remove());
  }

  function resetAll({ keepRevealed = false } = {}) {
    if (keepRevealed) {
      decisions.forEach((entry) => { entry.revealed = true; });
    } else {
      decisions.clear();
    }
    findPostNodes().forEach((node) => stripDecoration(node));
  }

  // ---------- review pane (every verdict is also a training label) ----------

  // ---------- breakage self-check ----------
  // Rendered content but zero posts detected, sustained, means the DOM changed.
  // The diagnostic report must stay sanitized: structure counts and attribute
  // NAMES only — never post content, author names, or attribute values.

  const SNOOZE_KEY = "cleanSlateBreakageSnooze";
  const ISSUE_URL = "https://github.com/startupmark/clean-slate/issues/new?template=feed-not-filtered.yml";
  let breakageSnoozedUntil = 0;
  let pathSince = { path: location.pathname, t: Date.now() };

  async function loadSnooze() {
    breakageSnoozedUntil = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY] || 0;
  }

  function buildDiagnostics() {
    const count = (selector) => document.querySelectorAll(selector).length;
    const attrNames = new Set();
    for (const el of [...document.querySelectorAll("main *")].slice(0, 500)) {
      for (const attr of el.attributes) attrNames.add(attr.name);
    }
    // Shaped by runtime.js, which is where the "names, never values" rule is
    // stated and tested. This function's only job is to gather the counts.
    return diagnosticsPayload({
      version: chrome.runtime.getManifest().version,
      when: new Date().toISOString(),
      detectionVersion: det.version,
      detectionLocale: det.locale,
      locale: document.documentElement.lang || navigator.language,
      readyState: document.readyState,
      mainTextLength: document.querySelector("main")?.innerText.length ?? 0,
      selectorHits: {
        postSelector: count(det.post),
        mainRoleList: count("main div[role='list']"),
        mainRoleListitem: count("main div[role='listitem']"),
        componentkeyAny: count("main [componentkey]"),
        componentkeyFeedType: count("main [componentkey*='FeedType']"),
        mainAsides: count("main aside"),
        mainArticles: count("main article"),
        legacyFeedUpdate: count("div.feed-shared-update-v2")
      },
      attributeNames: attrNames,
      state: { enabled: settings?.enabled, mode: settings?.mode, decisions: decisions.size }
    });
  }

  function showBreakageBanner() {
    if (document.querySelector(".cs-breakage")) return;
    let dismissBanner = () => {};
    const el = document.createElement("aside");
    el.className = "cs-breakage";
    el.setAttribute("role", "status");

    const eyebrow = document.createElement("div");
    eyebrow.className = "cs-welcome__eyebrow";
    eyebrow.textContent = "Clean Slate";
    const heading = document.createElement("h2");
    heading.textContent = "Can't read this feed version.";
    const body = document.createElement("p");
    body.textContent = "LinkedIn has probably changed its markup, so nothing is being filtered. " +
      "Copy the diagnostic report, then open the report form and paste it in. It carries page structure only, no post content.";

    const actions = document.createElement("div");
    actions.className = "cs-welcome__actions";
    const copyBtn = makeButton("Copy diagnostic report", "cs-button--primary", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(buildDiagnostics(), null, 2));
        copyBtn.textContent = "Copied ✓";
      } catch (error) {
        log("clipboard write failed", error);
        copyBtn.textContent = "Copy failed. See console.";
        console.log(DEBUG_PREFIX, "diagnostic report:\n", JSON.stringify(buildDiagnostics(), null, 2));
      }
    });
    // The banner used to tell people to file a bug report and link nothing.
    const report = document.createElement("a");
    report.className = "cs-button";
    report.textContent = "Open the report form";
    report.href = ISSUE_URL;
    report.target = "_blank";
    report.rel = "noreferrer noopener";

    // Filing on GitHub needs a GitHub account, which a Chrome Web Store user has
    // no reason to have. This is the route for everyone else.
    const email = document.createElement("a");
    email.className = "cs-button";
    email.textContent = "Email it instead";
    email.href = "mailto:cs-oss@triberoi.com?subject=" +
      encodeURIComponent(`Clean Slate ${chrome.runtime.getManifest().version}: feed not filtered`);

    actions.append(
      copyBtn,
      report,
      makeButton("Dismiss for a day", "", () => {
        breakageSnoozedUntil = Date.now() + 24 * 60 * 60 * 1000;
        persist({ [SNOOZE_KEY]: breakageSnoozedUntil });
        dismissBanner();
      })
    );

    el.append(eyebrow, heading, body, actions);
    document.body.append(el);
    dismissBanner = makeDismissible(el, { restoreFocus: false });
    log("breakage banner shown; diagnostics:", buildDiagnostics().selectorHits);
  }

  function healthCheck() {
    if (location.pathname !== pathSince.path) {
      pathSince = { path: location.pathname, t: Date.now() };
      return;
    }
    if (!settings) return;

    const verdict = healthVerdict({
      onFeed: onFeedPage(),
      enabled: settings.enabled,
      mode: settings.mode,
      postCount: findPostNodes().length,
      mainTextLength: document.querySelector("main")?.innerText.length ?? 0,
      pathSettledFor: Date.now() - pathSince.t,
      now: Date.now(),
      snoozedUntil: breakageSnoozedUntil
    });

    if (verdict === "healthy") dismissPanel(".cs-breakage");
    if (verdict === "broken") showBreakageBanner();
  }

  // ---------- onboarding ----------

  // Once per install. Every exit path marks onboarding complete.
  function showWelcome() {
    // Feed only. The card is consumed once per install, so mounting it on
    // /jobs, /messaging, a profile or a permalink spent the single introduction
    // on a page it does not describe — and took focus and swallowed Escape
    // there too. Guarded here rather than at the call sites: there are two.
    if (!onFeedPage()) return;
    if (settings.onboardingComplete || document.querySelector(".cs-welcome")) return;
    const el = document.createElement("aside");
    el.className = "cs-welcome";

    let close = () => el.remove();
    const dismiss = async () => {
      close();
      await saveSettings({ onboardingComplete: true });
      processAll();
    };

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "cs-welcome__close";
    closeButton.setAttribute("aria-label", "Dismiss");
    closeButton.textContent = "✕";
    closeButton.addEventListener("click", dismiss);

    const eyebrow = document.createElement("div");
    eyebrow.className = "cs-welcome__eyebrow";
    eyebrow.textContent = "Clean Slate";
    const heading = document.createElement("h2");
    heading.textContent = "You decide what stays in your feed.";
    const body = document.createElement("p");
    body.textContent = "We only change what you see on this page. " +
      "Click the Clean Slate button in your browser toolbar to change settings.";

    // Two things this never said, both of which a new user notices in the first
    // minute. The sidebars vanish immediately and nothing anywhere mentioned it,
    // and "Use defaults" adopted four topics belonging to somebody else without
    // naming one of them.
    const defaults = document.createElement("p");
    defaults.className = "cs-welcome__defaults";
    defaults.textContent =
      "The right-hand rail and some left sidebar extras are hidden. " +
      `Starting topics are ${DEFAULTS.interests.slice(0, -1).join(", ")} and ${DEFAULTS.interests.at(-1)}. ` +
      "Change all of this in Preferences.";

    const actions = document.createElement("div");
    actions.className = "cs-welcome__actions";
    actions.append(
      makeButton("Set my interests", "cs-button--primary", () => {
        dismiss();
        chrome.runtime.sendMessage({ type: "clean-slate:open-options" });
      }),
      makeButton("Start with those", "", dismiss)
    );

    el.append(closeButton, eyebrow, heading, body, defaults, actions);
    document.body.append(el);
    close = makeDismissible(el);
  }

  // ---------- messaging ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "clean-slate:ping") {
      sendResponse({
        running: true,
        supported: onFeedPage(),
        feedItems: findPostNodes().length,
        strategy: `detection ${det.version} (${det.locale})`,
        // compileDetection records the fall back to English as "de→en". Only
        // this side knows the feed's language; the popup has to be told, or the
        // extension quietly does less and says so in a notation nobody reads.
        localeFallback: det.locale.includes("→") ? det.locale.split("→")[0] : null,
        mode: settings?.mode || "discover"
      });
      return;
    }
    if (message.type === "clean-slate:refresh") {
      resetAll();
      loadSettings().then(() => { processAll(); showWelcome(); });
    }
    if (message.type === "clean-slate:reveal-all") {
      // Must re-process here. resetAll() strips the feed, and leaving the
      // rebuild to the observer means an unrendered tab never gets it back.
      resetAll({ keepRevealed: true });
      processAll();
    }
    // The way back. Revealing everything was one-way until a page reload, and
    // nothing on screen said the feed was currently revealed.
    if (message.type === "clean-slate:rehide-all") {
      resetAll();
      processAll();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // The model and the hidden-post log are loaded once at boot and held in memory for
    // the life of the tab. Deleting them from the preferences page used to leave
    // this copy untouched, so the next hidden post wrote the whole pre-deletion log
    // back to disk — author names and 600 characters of each post — within a
    // frame. Preferences is reached from the popup while on the feed, so a feed
    // tab is open in the ordinary case. PRIVACY.md and privacy.html both promise
    // that control removes them.
    if (changes[MODEL_KEY] && changes[MODEL_KEY].newValue === undefined) {
      model = { pos: {}, neg: {}, posDocs: 0, negDocs: 0, seen: {} };
    }
    if (changes[LOG_KEY] && changes[LOG_KEY].newValue === undefined) {
      hiddenLog = [];
      // Emptying the array is not enough on its own. Deleting everything also
      // removes the settings key, and that path calls resetAll() — which clears
      // `decisions` — then processAll(), which re-decides every post still on
      // screen as though it were new and logs each one again. The log refilled
      // from the visible feed within a frame, so a user who deleted their data
      // reopened the review pane and found the same authors looking back.
      // Verified on a real feed: every surviving entry was a post still
      // rendered, and the one that had scrolled out of view was the only one
      // that stayed gone.
      //
      // These posts are exactly the ones the user asked to forget, so they stay
      // out of the log for the life of this tab. A genuine remount gets a fresh
      // componentkey and logs normally.
      for (const node of findPostNodes()) suppressLogFor.add(postKeyOf(node));
    }

    if (!changes[KEY]) return;
    const { stats: oldStats, ...oldPrefs } = changes[KEY].oldValue || {};
    const { stats: newStats, ...newPrefs } = changes[KEY].newValue || {};
    const incoming = changes[KEY].newValue;
    settings = incoming
      // Counters are taken from the event, not defended. This tab's own
      // increments are already in storage by the time an echo arrives, because
      // addStats reads and adds at write time rather than writing a total it has
      // been carrying. Keeping them here instead is what made a second feed tab
      // overwrite the first.
      ? { ...DEFAULTS, ...incoming, stats: { ...DEFAULTS.stats, ...newStats } }
      // No newValue = the key was removed. The one case where counters go back
      // to zero, so it must not go through the merge.
      : { ...DEFAULTS, stats: { ...DEFAULTS.stats } };
    // Stats-only writes (our own counters) must not trigger a re-process loop.
    if (JSON.stringify(oldPrefs) === JSON.stringify(newPrefs)) return;
    // An expanded digest is transient, not a preference.
    digestExpanded = false;
    resetAll();
    processAll();
  });

  // ---------- boot ----------

  async function start() {
    await Promise.all([loadDetection(), loadSettings(), loadModel(), loadHiddenLog(), loadSnooze()]);
    await pruneAuthors();
    setInterval(healthCheck, 10000);
    log("started.", onFeedPage()
      ? `Feed page detected, ${findPostNodes().length} posts visible.`
      : "Not on the feed page; idle until navigation.");

    showWelcome();
    processAll();

    // One observer covers new posts, React re-renders and SPA navigation,
    // coalesced to one pass per frame.
    //
    // The setTimeout is NOT optional: an unrendered tab never grants an
    // animation frame, so rAF alone leaves the latch stuck and swallows every
    // later mutation.
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      let ran = false;
      const run = () => {
        if (ran) return;
        ran = true;
        scheduled = false;
        processAll();
      };
      requestAnimationFrame(run);
      setTimeout(run, 250);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  // Report the browser's colour scheme so the service worker can pick the matching
  // icon cut; the toolbar has no theme API of its own.
  function reportColorScheme() {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const send = () => chrome.runtime.sendMessage({ type: "clean-slate:color-scheme", dark: query.matches })
      .catch(() => { /* service worker asleep; it restores from storage */ });
    send();
    query.addEventListener("change", send);
  }
  reportColorScheme();

  start();
})();
