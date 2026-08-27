const $ = (selector) => document.querySelector(selector);
let settings;
// Whether the tab behind the popup is a LinkedIn tab. Set during initialise(),
// read by render() to disable what cannot work anywhere else.
let onLinkedIn = false;
// Whether anything on the feed behind the popup is currently revealed, so the
// button can offer the way back rather than repeating the way in.
let feedRevealed = false;

// One line each, at 320px. Chrome caps the popup at 600px and this is the only
// text in it that changes height: a second line here is what put a scrollbar on
// Discover and Digest while Focus and Raw looked fine.
const modeCopy = {
  focus: "Keeps only the strongest matches to your topics.",
  discover: "Keeps strong matches. Hides obvious noise.",
  digest: "Shows the day's best posts.",
  raw: "Leaves the LinkedIn feed exactly as it is."
};

// New judgements required before the popup points at the inspector.
const NUDGE_AFTER = 10;

async function getSettings() {
  return chrome.runtime.sendMessage({ type: "clean-slate:get-settings" });
}
async function update(patch) {
  settings = await chrome.runtime.sendMessage({ type: "clean-slate:update-settings", patch });
  await refreshTab();
  render();
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function refreshTab(message = { type: "clean-slate:refresh" }) {
  const tab = await activeTab();
  if (tab?.id && tab.url?.startsWith("https://www.linkedin.com/")) {
    try { await chrome.tabs.sendMessage(tab.id, message); } catch (_) { /* page has not injected yet */ }
  }
}
function renderProfiles() {
  // The default profile is the top-level settings, not a row in profiles.
  const select = $("#profile");
  select.replaceChildren();
  const options = [{ id: "", name: "Default" },
    ...(settings.profiles || []).map((profile) => ({ id: profile.id, name: profile.name }))];
  for (const { id, name } of options) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    select.append(option);
  }
  select.value = settings.activeProfile || "";
}

function render() {
  $("#checked").textContent = settings.stats?.checked || 0;
  $("#hidden").textContent = settings.stats?.hidden || 0;
  $("#dimmed").textContent = settings.stats?.dimmed || 0;
  $("#mode-copy").textContent = modeCopy[settings.mode];
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === settings.mode;
    button.classList.toggle("active", active);
    // Which mode is on was conveyed by colour alone, so the only way to find out
    // was to press one and watch the feed re-filter.
    button.setAttribute("aria-pressed", String(active));
  });
  $("#toggle").textContent = settings.enabled ? "Pause on LinkedIn" : "Resume on LinkedIn";
  renderProfiles();

  // Reveal only does anything on a LinkedIn tab. It used to look live from
  // everywhere and fail in silence, and so did Review — the hidden-post log had exactly
  // one viewer in the whole product, inside the content script.
  const reveal = $("#reveal");
  reveal.disabled = !onLinkedIn;
  reveal.textContent = feedRevealed ? "Hide them again on this page" : "Show hidden posts on this page";
  reveal.title = onLinkedIn ? "" : "Open a LinkedIn tab to show hidden posts there.";
}

// Reads the model directly: the popup needs two counts and writes nothing.
async function renderNudge() {
  const model = (await chrome.storage.local.get("cleanSlateModel")).cleanSlateModel;
  const total = (model?.posDocs || 0) + (model?.negDocs || 0);
  const fresh = total - (settings.stats?.learnedAcknowledged || 0);
  const nudge = $("#learned-nudge");
  nudge.hidden = fresh < NUDGE_AFTER;
  if (!nudge.hidden) {
    nudge.textContent = `Your filter learned from ${fresh} new judgements. Review them →`;
  }
  // One notice at a time. Stacked, the two of them pushed the popup past the
  // 600px Chrome allows it, and the page status is the less useful of the two at
  // the moment there is something new to look at.
  $("#page-status").hidden = !nudge.hidden;
}
// "de" means nothing to the person reading it. Intl carries the names already,
// so no table ships; if it cannot resolve a tag, the tag itself is still better
// than nothing.
function languageName(tag) {
  try {
    return new Intl.DisplayNames([navigator.language, "en"], { type: "language" }).of(tag) || tag;
  } catch (_) {
    return tag;
  }
}

async function initialise() {
  settings = await getSettings();
  const tab = await activeTab();
  onLinkedIn = Boolean(tab?.url?.startsWith("https://www.linkedin.com/"));
  if (!tab?.url?.startsWith("https://www.linkedin.com/feed")) {
    $("#page-status").textContent = "Open the LinkedIn home feed to start cleaning.";
  } else {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "clean-slate:ping" });
      feedRevealed = Boolean(response?.revealed);
      const found = `${response?.feedItems} feed item${response?.feedItems === 1 ? "" : "s"} found`;
      $("#page-status").textContent = response?.supported
        ? (response.localeFallback
          // A feed in a language we carry no patterns for still scores posts,
          // but the rules that read words — promoted, polls, engagement bait —
          // match nothing, and the extension looked simply worse rather than
          // limited. It knew all along; it said so as "de→en" in a diagnostic
          // string. Say it in a sentence instead.
          ? `Connected · ${found}. This feed is in ${languageName(response.localeFallback)}, and Clean Slate reads English feeds only, so promoted posts and some signals will slip through.`
          // The detection version and locale used to sit in this sentence. It
          // is a diagnostic, and it wrapped the box to a second line in a popup
          // Chrome caps at 600px. It moves to the title below rather than going
          // away: telling whether detection.json loaded or the built-in
          // fallback is live is the whole point of it.
          : `Connected · ${found}.`)
        : "Connected, but this LinkedIn view is not supported yet.";
      $("#page-status").title = response?.strategy ? `Scored via ${response.strategy}.` : "";
    } catch (_) {
      $("#page-status").textContent = "Reload this LinkedIn page to start Clean Slate.";
    }
  }
  render();
  await renderNudge();
}
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => update({ mode: button.dataset.mode })));
$("#profile").addEventListener("change", (event) => update({ activeProfile: event.target.value || null }));
// Straight to the section, not the top of an eight-section page. openOptionsPage
// cannot carry a fragment, so this opens the URL itself.
$("#learned-nudge").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#learned") });
  window.close();
});
$("#toggle").addEventListener("click", () => update({ enabled: !settings.enabled }));
$("#reveal").addEventListener("click", async () => {
  await refreshTab({ type: feedRevealed ? "clean-slate:rehide-all" : "clean-slate:reveal-all" });
  feedRevealed = !feedRevealed;
  render();
});
// Its own page now, so it opens from any tab.
$("#review").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
  window.close();
});
$("#preferences").addEventListener("click", () => chrome.runtime.openOptionsPage());
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

initialise();
