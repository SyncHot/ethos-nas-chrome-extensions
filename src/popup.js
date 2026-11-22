import {
  DEFAULT_SETTINGS,
  categoryLabel,
  classifyLink,
  fileNameFromUrl,
  hostOf,
  kindLabel,
  normCategoryList,
} from "./lib/shared.js";

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let config = { categories: [], provider: "", downloadDir: "", stale: false, fetchedAt: 0 };
let links = [];
let activeTab = null;
let busy = false;

const KIND_TEXT = {
  magnet: "Magnet link",
  torrent: ".torrent file",
  filehost: "File-host link",
  file: "Direct file",
  page: "Web page",
  other: "Unsupported link",
};

// Clipboard content is only used when it looks like something we can download.
const CLIPBOARD_KINDS = new Set(["magnet", "torrent", "filehost", "file"]);

function show(el, visible) {
  el.classList.toggle("hidden", !visible);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function configured() {
  return Boolean(settings.nasUrl && settings.apiKey);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  show($("panel-add"), name === "add");
  show($("panel-links"), name === "links");
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    switchTab(tab.dataset.tab);
    if (tab.dataset.tab === "links" && !links.length) void scanPage();
  });
}

// ── Add panel ────────────────────────────────────────────────────────────────

function updateKind() {
  const value = $("url").value.trim();
  const kindEl = $("kind");
  if (!value) {
    kindEl.textContent = "Paste a link from any page";
    refreshSendState();
    return;
  }

  const kind = classifyLink(value, settings);
  const label = KIND_TEXT[kind] || "Link";
  kindEl.textContent = "";

  const strong = document.createElement("strong");
  strong.textContent = label;
  kindEl.append(strong);

  const filename = fileNameFromUrl(value);
  if (filename && kind !== "page") kindEl.append(` · ${filename}`);

  // Provider hints: magnets and file-host links cannot be fetched anonymously.
  if (kind === "magnet" && !config.provider) {
    kindEl.append(" — magnets need a debrid provider on the NAS");
  } else if (kind === "filehost" && config.provider !== "alldebrid") {
    kindEl.append(
      config.provider
        ? ` — ${config.provider} can only take magnets; hosts like this need AllDebrid`
        : " — file hosts need AllDebrid configured on the NAS",
    );
  }

  refreshSendState();
}

function refreshSendState() {
  const hasUrl = Boolean($("url").value.trim());
  $("send").disabled = busy || !hasUrl || !configured();
}

/**
 * Prefill the URL field from the clipboard (JDownloader-style clipboard watch).
 *
 * Chrome only lets the popup read the clipboard with the `clipboardRead`
 * permission; a denied permission or a non-download clipboard is not an error,
 * the user just types/pastes manually.
 */
async function fillFromClipboard() {
  if (settings.clipboardAuto === false) return false;
  if ($("url").value.trim()) return false;
  if (!navigator.clipboard?.readText) return false;
  let text = "";
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    return false; // no permission or empty clipboard — nothing to fill
  }
  if (!text || text.length > 8192) return false;
  const candidate = text.split(/\s+/)[0];
  if (!CLIPBOARD_KINDS.has(classifyLink(candidate, settings))) return false;
  $("url").value = candidate;
  show($("clipboard-note"), true);
  return true;
}

$("url").addEventListener("input", () => {
  show($("clipboard-note"), false);
  updateKind();
});
$("url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void sendFromForm();
  }
});

function showResult(ok, title, detail = "") {
  const box = $("result");
  box.textContent = "";
  box.classList.remove("hidden", "ok", "err");
  box.classList.add(ok ? "ok" : "err");
  box.append(document.createTextNode(title));
  if (detail) {
    const div = document.createElement("div");
    div.className = "detail";
    div.textContent = detail;
    box.append(div);
  }
}

async function sendFromForm() {
  const url = $("url").value.trim();
  if (!url || busy) return;
  await doSend([url]);
  $("url").select();
  updateKind();
}

$("send").addEventListener("click", () => void sendFromForm());

async function doSend(urls) {
  if (!urls.length || busy) return;
  busy = true;
  refreshSendState();
  $("send-links").disabled = true;
  show($("result"), false);

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "send",
      urls,
      options: { category: $("category").value, folder: $("folder").value },
    });
  } catch (error) {
    response = { ok: false, error: error?.message || String(error) };
  }

  busy = false;
  refreshSendState();

  if (!response?.ok) {
    showResult(false, response?.error || "The extension could not reach the NAS.");
    return;
  }

  const results = response.results || [];
  const ok = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  const detail = failed.length
    ? failed.map((entry) => `${fileNameFromUrl(entry.url) || entry.url}\n${entry.error}`).join("\n")
    : "";

  showResult(
    failed.length === 0,
    ok ? `Queued ${ok} download${ok === 1 ? "" : "s"}.` : "Nothing was queued.",
    detail,
  );

  // Successful rows in the page-links panel no longer need to stay ticked.
  for (const input of document.querySelectorAll("#link-list input[type=checkbox]")) {
    const match = results.find((result) => result.ok && result.url === input.dataset.url);
    if (match) input.checked = false;
  }
  updateLinksButton();

  await loadSettings();
  renderHistory();
}

// ── Recent sends ─────────────────────────────────────────────────────────────

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function renderHistory() {
  const list = $("history");
  list.textContent = "";
  const entries = (settings.history || []).slice(0, 6);

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing sent yet.";
    list.append(li);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.title = entry.error ? `${entry.url}\n${entry.error}` : entry.url;

    const state = document.createElement("span");
    state.className = `state ${entry.ok ? "ok" : "err"}`;
    state.textContent = entry.ok ? "✓" : "✗";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name || hostOf(entry.url) || entry.url;

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relativeTime(entry.ts);

    li.append(state, name, when);
    li.addEventListener("click", () => {
      $("url").value = entry.url;
      switchTab("add");
      updateKind();
    });
    list.append(li);
  }
}

$("clear-history").addEventListener("click", () => {
  void (async () => {
    const stored = await chrome.storage.local.get("settings");
    const next = { ...DEFAULT_SETTINGS, ...(stored.settings || {}), history: [] };
    await chrome.storage.local.set({ settings: next });
    settings = next;
    renderHistory();
  })();
});

// ── Page links ───────────────────────────────────────────────────────────────

async function scanPage() {
  const empty = $("links-empty");
  show(empty, false);
  $("link-list").textContent = "";

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "collect", tabId: activeTab?.id });
  } catch (error) {
    response = { ok: false, error: error?.message || String(error) };
  }

  if (!response?.ok) {
    empty.textContent = response?.error || "Could not read links from this page.";
    show(empty, true);
    links = [];
    updateLinksButton();
    return;
  }

  const seen = new Set();
  links = (response.links || [])
    .filter((link) => link && /^https?:|^magnet:/i.test(link.url))
    .filter((link) => (seen.has(link.url) ? false : seen.add(link.url)))
    .map((link) => ({ ...link, kind: classifyLink(link.url, settings) }));

  renderLinks();
}

function renderLinks() {
  const list = $("link-list");
  list.textContent = "";
  const showAll = $("show-all").checked;
  const fileLinks = links.filter((link) => link.kind !== "page" && link.kind !== "other");
  const visible = showAll ? links : fileLinks;

  const badge = $("links-count");
  badge.textContent = String(fileLinks.length);
  show(badge, fileLinks.length > 0);

  show($("links-empty"), visible.length === 0);
  if (!visible.length) {
    $("links-empty").textContent = showAll
      ? "No links found on this page."
      : "No file links found. Tick “Show all links” to see every link.";
  }

  for (const link of visible) {
    const li = document.createElement("li");
    if (link.kind === "page" || link.kind === "other") li.classList.add("is-page");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.url = link.url;
    input.checked = link.kind !== "page" && link.kind !== "other";
    input.addEventListener("change", updateLinksButton);

    const body = document.createElement("div");
    body.className = "link-body";

    const name = document.createElement("span");
    name.className = "link-name";
    const filename = fileNameFromUrl(link.url);
    name.textContent = link.text || filename || link.url;
    name.title = link.url;

    const meta = document.createElement("span");
    meta.className = "link-meta";
    meta.textContent = [hostOf(link.url), filename && link.text ? filename : ""].filter(Boolean).join(" · ")
      || link.url;

    body.append(name, meta);

    const tag = document.createElement("span");
    tag.className = `tag ${link.kind}`;
    tag.textContent = kindLabel(link.kind, link.url);

    li.append(input, body, tag);
    list.append(li);
  }

  updateLinksButton();
}

function selectedUrls() {
  return [...document.querySelectorAll("#link-list input[type=checkbox]:checked")].map(
    (input) => input.dataset.url,
  );
}

function updateLinksButton() {
  const count = selectedUrls().length;
  const button = $("send-links");
  button.textContent = count ? `Send selected (${count})` : "Send selected";
  button.disabled = busy || !count || !configured();
}

$("show-all").addEventListener("change", renderLinks);
$("scan").addEventListener("click", () => void scanPage());
$("send-links").addEventListener("click", () => void doSend(selectedUrls()));

// ── Connection + boot ────────────────────────────────────────────────────────

async function checkStatus() {
  const pill = $("status");
  pill.className = "pill";
  pill.textContent = "checking…";
  pill.title = "";

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "test" });
  } catch (error) {
    response = { ok: false, error: error?.message || String(error) };
  }

  if (response?.ok) {
    pill.className = "pill online";
    pill.textContent = "online";
    const summary = response.summary || {};
    const active = Number(summary.active || 0);
    pill.title = active ? `${active} active download${active === 1 ? "" : "s"}` : "Connected";
  } else {
    pill.className = "pill offline";
    pill.textContent = "offline";
    pill.title = response?.error || "Cannot reach the NAS";
  }
}

async function loadConfig() {
  if (!configured()) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "config" });
  } catch (error) {
    response = { ok: false, stale: true, error: error?.message || String(error) };
  }
  await applyConfig(response);
  renderCategories();
  renderFooter();
}

/** Render the last cached categories immediately, before the network call. */
async function loadCachedConfig() {
  const stored = await chrome.storage.local.get("nasConfig");
  if (!stored?.nasConfig) return;
  config = {
    categories: normCategoryList(stored.nasConfig.categories),
    provider: stored.nasConfig.provider || "",
    downloadDir: stored.nasConfig.downloadDir || "",
    stale: false,
    fetchedAt: Number(stored.nasConfig.fetchedAt || 0),
  };
  renderCategories();
  renderFooter();
}

async function applyConfig(response) {
  if (!response || typeof response !== "object") return;
  config = {
    categories: normCategoryList(response.categories),
    provider: response.provider || "",
    downloadDir: response.downloadDir || "",
    stale: response.ok === false && response.stale !== false,
    fetchedAt: Number(response.fetchedAt || 0),
  };

  // A fresh list is authoritative: when the default category was renamed or
  // removed in the Download Manager, drop it instead of letting the NAS
  // silently fall back to the download folder on every send.
  const wanted = String(settings.category || "").trim().toLowerCase();
  if (response.ok === true && wanted) {
    const exists = config.categories.some((entry) => entry.name.toLowerCase() === wanted);
    if (!exists) await persistCategory("");
  }
}

/** Store the default category without dropping other settings keys. */
async function persistCategory(name) {
  const stored = await chrome.storage.local.get("settings");
  const next = { ...DEFAULT_SETTINGS, ...(stored.settings || {}), category: name };
  await chrome.storage.local.set({ settings: next });
  settings = next;
}

function renderCategories() {
  const select = $("category");
  select.textContent = "";

  const option = (value, label) => {
    const element = document.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  };

  select.append(option("", "Default (NAS download folder)"));
  const seen = new Set([""]);
  for (const entry of config.categories) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    select.append(option(entry.name, categoryLabel(entry)));
  }
  // While the list is cached, a default that is no longer on the NAS stays
  // visible (flagged) — it is only dropped once a fresh config proves it gone.
  const fallback = String(settings.category || "").toLowerCase();
  if (fallback && !seen.has(fallback)) {
    select.append(option(settings.category, `${settings.category} — no longer on the NAS`));
  }
  select.value = settings.category || "";
  renderCategoryNote();
}

function renderCategoryNote() {
  const note = $("category-note");
  note.textContent = "";
  note.classList.remove("warn");
  if (!configured()) {
    note.textContent = "Connect the extension to load the Download Manager categories.";
    return;
  }
  if (config.stale) {
    note.classList.add("warn");
    note.textContent = config.fetchedAt
      ? `Showing cached categories (refreshed ${relativeTime(config.fetchedAt)}) — NAS unreachable.`
      : "Could not load categories from the NAS.";
    return;
  }
  if (!config.fetchedAt) {
    note.textContent = "Loading categories from the Download Manager…";
    return;
  }
  const count = config.categories.length;
  note.textContent = count
    ? `${count} categor${count === 1 ? "y" : "ies"} from the Download Manager.`
    : "No categories on the NAS — add them in Download Manager → Settings.";
}

async function refreshCategories() {
  const button = $("refresh-categories");
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("busy");
  try {
    await loadConfig();
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}

$("refresh-categories").addEventListener("click", () => void refreshCategories());

function renderFooter() {
  const note = $("footer-note");
  note.textContent = "";
  if (!configured()) {
    note.textContent = "Not configured — open the extension settings.";
    return;
  }
  note.textContent = settings.nasUrl;
  if (config.provider) {
    const provider = document.createElement("span");
    provider.textContent = ` · ${config.provider}`;
    note.append(provider);
  }
}

async function boot() {
  await loadSettings();

  show($("setup"), !configured());
  $("setup-btn").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  $("open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());

  $("folder").value = settings.folder || "";

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = activeTab?.url || "";
  if (tabUrl) {
    const kind = classifyLink(tabUrl, settings);
    if (kind !== "page" && kind !== "other") $("url").value = tabUrl;
  }
  await fillFromClipboard();

  renderCategories();
  updateKind();
  renderHistory();
  renderFooter();

  // Show the last known Download Manager categories immediately, then refresh
  // them from the NAS so additions/renames show up without reinstalling.
  await loadCachedConfig();
  await loadConfig();
  updateKind();
  refreshSendState();

  await checkStatus();
}

void boot().catch((error) => {
  showResult(false, `Popup failed to start: ${error?.message || error}`);
});
