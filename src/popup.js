import {
  DEFAULT_SETTINGS,
  classifyLink,
  fileNameFromUrl,
  hostOf,
  kindLabel,
} from "./lib/shared.js";

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let config = { categories: [], provider: "", downloadDir: "" };
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

$("url").addEventListener("input", updateKind);
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
  try {
    const response = await chrome.runtime.sendMessage({ type: "config" });
    if (response?.ok) {
      config = {
        categories: response.categories || [],
        provider: response.provider || "",
        downloadDir: response.downloadDir || "",
      };
    }
  } catch {
    // Offline — the popup still works with the stored defaults.
  }
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
  for (const name of config.categories) {
    if (seen.has(name)) continue;
    seen.add(name);
    select.append(option(name, name));
  }
  if (settings.category && !seen.has(settings.category)) {
    select.append(option(settings.category, settings.category));
  }
  select.value = settings.category || "";
}

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

  renderCategories();
  updateKind();
  renderHistory();
  renderFooter();

  await loadConfig();
  renderCategories();
  renderFooter();
  updateKind();
  refreshSendState();

  await checkStatus();
}

void boot().catch((error) => {
  showResult(false, `Popup failed to start: ${error?.message || error}`);
});
