const DEFAULT_SETTINGS = {
  onboardingComplete: false, enabled: true, mode: "discover",
  thresholdByMode: { focus: 70, discover: 45, digest: 68 },
  interests: ["AI infrastructure","developer tools","startups"],
  mutedPhrases: ["thrilled to announce","agree?","work anniversary"],
  allowedAuthors: [], blockedAuthors: [], authorMarks: {}, authorDecayDays: 30, statsResetAt: 0,
  profiles: [], activeProfile: null,
  structuralFiltering: true, hideRightRail: true, hideLeftRailExtras: true,
  stats: { checked: 0, hidden: 0, dimmed: 0, revealed: 0, feedback: 0, reviewGood: 0, reviewBad: 0, learnedAcknowledged: 0 }
};

async function getSettings() {
  const stored = await chrome.storage.local.get("cleanSlateSettings");
  const saved = stored.cleanSlateSettings || {};
  // Carries a counter written before the post-level action was renamed, the same
  // way mergeSettings does in runtime.js, which this worker cannot load. Without
  // it the popup reads zero for anyone who opens it before visiting a feed.
  const { folded, ...stats } = saved.stats || {};
  if (folded !== undefined && stats.hidden === undefined) stats.hidden = folded;
  return { ...DEFAULT_SETTINGS, ...saved,
    thresholdByMode: { ...DEFAULT_SETTINGS.thresholdByMode, ...(saved.thresholdByMode || {}) },
    stats: { ...DEFAULT_SETTINGS.stats, ...stats } };
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("cleanSlateSettings");
  if (!stored.cleanSlateSettings) await chrome.storage.local.set({ cleanSlateSettings: DEFAULT_SETTINGS });
});

// ---- toolbar icon ----
// Chrome does not theme extension icons, and the mark's baseline is ink, which
// disappears on a dark toolbar. The pages that CAN see prefers-color-scheme (the
// popup, and the content script on the feed) report it here. The last value is
// stored so the icon is right on service-worker restart, before anything reports.
const SCHEME_KEY = "cleanSlateIconScheme";

const iconPaths = (dark) => {
  const cut = dark ? "-dark" : "";
  return { 16: `icons/icon-16${cut}.png`, 32: `icons/icon-32${cut}.png`, 48: `icons/icon-48${cut}.png` };
};

async function applyIcon(dark) {
  try { await chrome.action.setIcon({ path: iconPaths(dark) }); } catch (_) { /* no action in some contexts */ }
}

// A page that can see prefers-color-scheme may report it while this read is
// still in flight. The read then landed last and re-applied the stale cut, so
// the icon was wrong until the next LinkedIn load or popup open. A report always
// wins over a restore, whichever finishes first.
let reported = false;

async function restoreIcon() {
  const stored = (await chrome.storage.local.get(SCHEME_KEY))[SCHEME_KEY];
  if (reported) return;
  await applyIcon(stored === "dark");
}
restoreIcon();
chrome.runtime.onStartup.addListener(() => { reported = false; return restoreIcon(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "clean-slate:get-settings") { getSettings().then(sendResponse); return true; }
  if (message.type === "clean-slate:update-settings") {
    getSettings().then((settings) => {
      const next = { ...settings, ...message.patch };
      if (message.patch?.stats) next.stats = { ...settings.stats, ...message.patch.stats };
      return chrome.storage.local.set({ cleanSlateSettings: next }).then(() => next);
    }).then(sendResponse);
    return true;
  }
  if (message.type === "clean-slate:open-options") chrome.runtime.openOptionsPage();
  if (message.type === "clean-slate:color-scheme") {
    const dark = Boolean(message.dark);
    reported = true; // beats an in-flight restore, which would re-apply the old cut
    chrome.storage.local.set({ [SCHEME_KEY]: dark ? "dark" : "light" });
    applyIcon(dark);
  }
});
