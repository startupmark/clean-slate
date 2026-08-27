// The review page.
//
// This used to be a panel injected into LinkedIn's own DOM by the content
// script, which had four consequences and none of them were intended:
//
//   - It could only be opened from a LinkedIn tab. Both popup buttons that
//     reached it were silent no-ops anywhere else, and the hidden-post log had exactly
//     one viewer in the whole product.
//   - It forgot every verdict the moment you switched range, because it rebuilt
//     itself from the log on each call and the judged state lived only in the
//     DOM. Yesterday's forty judged rows came back unmarked.
//   - At 400% zoom it collapsed to zero height with no way to scroll it.
//   - It put up to 200 hidden posts — other people's names and text — into a page
//     LinkedIn's own JavaScript runs on, which sits badly beside "nothing leaves
//     this browser".
//
// As its own extension page it is reachable from anywhere, keeps its state, and
// is nothing to do with LinkedIn's DOM.

const KEY = "cleanSlateSettings";
const MODEL_KEY = "cleanSlateModel";
const LOG_KEY = "cleanSlateFoldLog";

const { SETTINGS_DEFAULTS, tokenize } = CleanSlateEngine;
const { emptyModel, trainModel, isMuteReason } = CleanSlateRuntime;

const $ = (selector) => document.querySelector(selector);

const DAY = 24 * 60 * 60 * 1000;
const RANGES = {
  today: { label: "Today", since: () => new Date().setHours(0, 0, 0, 0) },
  week: { label: "7 days", since: () => Date.now() - 7 * DAY },
  all: { label: "Everything", since: () => 0 }
};

let range = "today";
let settings = { ...SETTINGS_DEFAULTS };
let model = emptyModel();
let log = [];

async function write(items, failure) {
  try { await chrome.storage.local.set(items); return true; }
  catch (_) { $("#scoreline").textContent = failure || "Could not save. Your browser refused the write."; return false; }
}

async function load() {
  const stored = await chrome.storage.local.get([KEY, MODEL_KEY, LOG_KEY]);
  settings = { ...SETTINGS_DEFAULTS, ...(stored[KEY] || {}) };
  model = { ...emptyModel(), ...(stored[MODEL_KEY] || {}) };
  log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  render();
}

// A verdict is recorded on the entry itself, so it survives a range switch, a
// reload and a new session. The state to do this always existed — model.seen —
// but nothing read it back.
async function judge(entry, verdict) {
  const label = verdict === "good" ? "neg" : "pos";
  const next = trainModel(model, entry.key, label, tokenize(`${entry.author} ${entry.text || entry.snippet}`));

  // Only count a judgement that actually taught something. The counters used to
  // move on every press, so re-reading the same row drifted the one number the
  // help page describes as how often you agreed.
  const learned = Boolean(next);
  if (learned) model = next;

  log = log.map((row) => (row.key === entry.key ? { ...row, judged: verdict } : row));

  const stats = { ...settings.stats };
  if (learned) {
    const field = verdict === "good" ? "reviewGood" : "reviewBad";
    stats[field] = (Number(stats[field]) || 0) + 1;
  }
  settings = { ...settings, stats };

  const writes = { [LOG_KEY]: log, [KEY]: settings };
  if (learned) writes[MODEL_KEY] = model;
  await write(writes);
  render();
}

// A post hidden by the muted-people list cannot be argued with by judging: the
// list is worth -100 and a verdict is worth at most 18, so no number of presses
// lifts it. The row offers the only thing that would work. isMuteReason lives in
// runtime.js, where it can be tested against real strings rather than pinned by
// a regex over this file.

async function unblock(author) {
  const keep = (settings.blockedAuthors || []).filter((name) => name !== author);
  const marks = { ...(settings.authorMarks || {}) };
  delete marks[author.toLowerCase().replace(/\s+/g, " ").trim()];
  settings = { ...settings, blockedAuthors: keep, authorMarks: marks };
  await write({ [KEY]: settings });
  render();
}

function button(label, className, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  if (className) el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function row(entry) {
  const article = document.createElement("article");
  article.className = "review-row" + (entry.judged ? " review-row--done" : "");

  const meta = document.createElement("div");
  meta.className = "review-row__meta";
  const author = document.createElement("strong");
  author.textContent = entry.author;
  const score = document.createElement("span");
  score.className = "review-row__score";
  score.textContent = `${entry.score}/100`;
  meta.append(author, score);

  const reason = document.createElement("p");
  reason.className = "review-row__reason";
  reason.textContent = entry.reason;

  const snippet = document.createElement("p");
  snippet.className = "review-row__snippet";
  snippet.textContent = entry.text || entry.snippet;

  article.append(meta, reason, snippet);

  // Captured at extraction when LinkedIn rendered one. Older entries predate it,
  // so the link only appears when there is somewhere real to go.
  if (entry.url) {
    const link = document.createElement("p");
    const anchor = document.createElement("a");
    anchor.href = entry.url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = "Open this post on LinkedIn";
    link.append(anchor);
    article.append(link);
  }

  const actions = document.createElement("div");
  actions.className = "add-row";

  if (entry.judged) {
    const done = document.createElement("p");
    done.className = "review-row__verdict";
    done.textContent = entry.judged === "good" ? "Good call." : "You would have kept this.";
    actions.append(done);
    actions.append(button("Change my mind", "", () => judge(entry, entry.judged === "good" ? "bad" : "good")));
  } else {
    // Both verdicts stay plain. A filled button reads as the one to press, which
    // would bias the number the two of them produce.
    actions.append(button("Good call", "", () => judge(entry, "good")));
    actions.append(button("Shouldn't have", "", () => judge(entry, "bad")));
  }

  if (isMuteReason(entry.reason) && (settings.blockedAuthors || []).includes(entry.author)) {
    actions.append(button(`Unmute ${entry.author}`, "danger", () => unblock(entry.author)));
  }

  article.append(actions);
  return article;
}

function render() {
  const since = RANGES[range].since();
  const entries = log.filter((entry) => entry.ts >= since).reverse();

  $("#range-title").textContent = `${RANGES[range].label} (${entries.length})`;
  for (const control of document.querySelectorAll("[data-range]")) {
    const active = control.dataset.range === range;
    control.classList.toggle("primary", active);
    // The selected range was conveyed by colour alone.
    control.setAttribute("aria-pressed", String(active));
  }

  const good = Number(settings.stats?.reviewGood) || 0;
  const bad = Number(settings.stats?.reviewBad) || 0;
  $("#scoreline").textContent = good + bad > 0
    ? `${Math.round((good / (good + bad)) * 100)}% of these you agreed with · ${good + bad} judged, ${bad} you would have kept.`
    : "";

  const rows = $("#rows");
  rows.replaceChildren(...entries.map(row));

  const empty = $("#empty");
  empty.hidden = entries.length > 0;
  if (!entries.length) {
    // "The log keeps the last 0 hidden posts" was the first thing a new user read here.
    empty.textContent = log.length
      ? `Nothing hidden ${range === "today" ? "today" : "in this range"}. There are ${log.length} further back. Try Everything.`
      : "Nothing hidden yet. Every hidden post shows up here, with the reason it was given.";
  }
}

for (const control of document.querySelectorAll("[data-range]")) {
  control.addEventListener("click", () => { range = control.dataset.range; render(); });
}

// Another surface may delete the log or the model while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[LOG_KEY] || changes[MODEL_KEY] || changes[KEY]) load();
});

load();
