// EthOS NAS Downloader — service worker.
//
// All network calls happen here (extension service workers with host
// permissions are not subject to CORS), and the popup/options/content script
// talk to this worker through chrome.runtime messages.

import {
  DEFAULT_SETTINGS,
  classifyLink,
  fileNameFromUrl,
  isNasUrl,
  normCategoryList,
  normalizeNasUrl,
} from "./lib/shared.js";

let settings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

// Loaded once at worker start; senders await this so a fresh worker does not
// race the first message. Listeners are registered synchronously below.
const settingsReady = chrome.storage.local
  .get("settings")
  .then((stored) => {
    settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  })
  .catch(() => {})
  .finally(() => {
    settingsLoaded = true;
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  }
});

async function getSettings() {
  await settingsReady;
  return settings;
}

// ── Context menus ────────────────────────────────────────────────────────────

function createMenu(props) {
  chrome.contextMenus.create(props, () => {
    // "Cannot create item with duplicate id" is expected when the worker
    // restarts and removeAll has not finished yet — nothing to do.
    void chrome.runtime.lastError;
  });
}

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    createMenu({
      id: "ethos-send-link",
      title: "Send link to EthOS NAS",
      contexts: ["link"],
    });
    createMenu({
      id: "ethos-send-page",
      title: "Send this page URL to EthOS NAS",
      contexts: ["page"],
    });
    createMenu({
      id: "ethos-send-links",
      title: "Send file links on this page to EthOS NAS",
      contexts: ["page"],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  buildMenus();
  if (details.reason === "install") {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(buildMenus);

// Rebuild on every worker start (menus survive, but removeAll keeps this
// idempotent and picks up title changes).
buildMenus();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenu(info, tab);
});

async function handleContextMenu(info, tab) {
  try {
    if (info.menuItemId === "ethos-send-link") {
      if (!info.linkUrl) return;
      const results = await sendMany([info.linkUrl], {});
      notifySendResult(results);
      return;
    }

    if (info.menuItemId === "ethos-send-page") {
      const url = info.pageUrl || tab?.url;
      if (!url) return;
      const results = await sendMany([url], {});
      notifySendResult(results);
      return;
    }

    if (info.menuItemId === "ethos-send-links") {
      const current = await getSettings();
      const links = await collectLinks(tab);
      const urls = links
        .map((link) => link.url)
        .filter((url) => {
          const kind = classifyLink(url, current);
          return kind === "magnet" || kind === "torrent" || kind === "filehost" || kind === "file";
        });
      if (!urls.length) {
        notify("No file links found", "Nothing on this page looks like a downloadable file.");
        return;
      }
      const results = await sendMany(urls, {});
      notifySendResult(results);
    }
  } catch (error) {
    notify("EthOS NAS", error?.message || String(error));
  }
}

// ── Page links ───────────────────────────────────────────────────────────────

async function collectLinks(tab) {
  if (!tab?.id) return [];
  try {
    return (await chrome.tabs.sendMessage(tab.id, { type: "collectLinks" })) || [];
  } catch {
    // The page was loaded before the extension was installed/reloaded —
    // inject the collector once and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
      return (await chrome.tabs.sendMessage(tab.id, { type: "collectLinks" })) || [];
    } catch {
      return [];
    }
  }
}

// ── Download interception ────────────────────────────────────────────────────

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.finalUrl || item.url || "";

  const decide = () => {
    if (!shouldIntercept(url)) {
      try {
        suggest();
      } catch {
        // The download was cancelled elsewhere — nothing to do.
      }
      return;
    }

    // Cancel one tick later than suggest() so the browser never writes the
    // file locally, then push the resolved (post-redirect) URL to the NAS.
    try {
      suggest();
    } catch {
      // ignore
    }
    chrome.downloads.cancel(item.id, () => {
      void chrome.runtime.lastError;
      chrome.downloads.erase({ id: item.id }, () => void chrome.runtime.lastError);
    });

    const name = String(item.filename || "").split(/[\\/]/).pop() || fileNameFromUrl(url);
    sendMany([url], { name })
      .then((results) => notifySendResult(results))
      .catch((error) => notify("EthOS NAS failed", error?.message || String(error)));
  };

  if (settingsLoaded) {
    decide();
    return;
  }

  // A fresh service worker starts with DEFAULT_SETTINGS (capture off). Wait
  // for the stored settings, otherwise the download that woke the worker would
  // slip through.
  settingsReady.then(decide, decide);
  return true; // async listener: Chrome waits for suggest()
});

function shouldIntercept(url) {
  if (!settings.interceptDownloads) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (!settings.apiKey || !settings.nasUrl) return false;
  if (isNasUrl(url, settings.nasUrl)) return false; // files served by the NAS itself
  if (settings.interceptMode === "all") return true;
  const kind = classifyLink(url, settings);
  return kind === "torrent" || kind === "filehost" || kind === "file";
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const current = await getSettings();
  if (!current.nasUrl) throw new Error("Set the NAS URL in the extension options first.");
  if (!current.apiKey) throw new Error("Add your EthOS API key in the extension options first.");

  let response;
  try {
    response = await fetch(current.nasUrl + path, {
      method,
      headers: { Authorization: `Bearer ${current.apiKey}`, ...headers },
      body,
    });
  } catch (error) {
    throw new Error(`Cannot reach the NAS at ${current.nasUrl} (${error?.message || error})`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    let detail = data && typeof data === "object" ? data.detail : data;
    if (Array.isArray(detail)) {
      detail = detail.map((entry) => entry?.msg || JSON.stringify(entry)).join("; ");
    }
    throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
  }
  return data;
}

async function postTask(payload) {
  return api("/api/downloads/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function postTorrent(url, { name, folder }) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Could not fetch the .torrent (HTTP ${response.status})`);

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("The .torrent is larger than 10 MiB");
  const head = new TextDecoder("latin1").decode(
    new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)),
  );
  if (!head.startsWith("d") || !head.includes("announce")) {
    throw new Error("The link did not return a valid .torrent file");
  }

  const form = new FormData();
  const filename = name || fileNameFromUrl(url) || "upload.torrent";
  form.append("files", new Blob([buffer], { type: "application/x-bittorrent" }), filename);
  const query = folder ? `?folder=${encodeURIComponent(folder)}` : "";
  return api(`/api/downloads/tasks/torrent${query}`, { method: "POST", body: form });
}

async function sendOne(url, options = {}) {
  const current = await getSettings();
  const category = String(options.category ?? current.category ?? "").trim();
  const folder = String(options.folder ?? current.folder ?? "").trim();
  const name = String(options.name ?? "").trim();

  if (/^magnet:\?/i.test(url)) {
    return postTask({ url, category: category || undefined, folder: folder || undefined, name: name || undefined });
  }

  const kind = classifyLink(url, current);
  if (kind === "torrent") {
    // Fetch the .torrent here so the NAS never has to guess whether the URL
    // points at a torrent or at the file itself.
    return postTorrent(url, { name: name || fileNameFromUrl(url), folder });
  }

  return postTask({ url, category: category || undefined, folder: folder || undefined, name: name || undefined });
}

/** Send a list of URLs sequentially; returns one result per URL. */
async function sendMany(urls, options = {}) {
  await settingsReady;
  const unique = [...new Set((urls || []).map((url) => String(url || "").trim()).filter(Boolean))];
  const results = [];
  for (const url of unique) {
    try {
      const task = await sendOne(url, options);
      results.push({ url, ok: true, task });
    } catch (error) {
      results.push({ url, ok: false, error: error?.message || String(error) });
    }
  }
  await recordHistory(results, options);
  setBadge(results);
  return results;
}

async function recordHistory(results, options) {
  if (!results.length) return;
  const stored = await chrome.storage.local.get("settings");
  const current = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  const entries = results.map((result) => ({
    ts: Date.now(),
    url: result.url,
    name: result.task?.name || options.name || fileNameFromUrl(result.url),
    ok: !!result.ok,
    error: result.error || "",
  }));
  current.history = [...entries, ...(current.history || [])].slice(0, 25);
  settings = current;
  await chrome.storage.local.set({ settings: current });
}

function setBadge(results) {
  const ok = results.filter((result) => result.ok).length;
  chrome.action.setBadgeBackgroundColor({ color: ok === results.length ? "#16a34a" : "#dc2626" });
  chrome.action.setBadgeText({ text: String(ok) });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

function notify(title, message) {
  if (!settings.notify) return;
  chrome.notifications.create(
    { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message },
    () => void chrome.runtime.lastError,
  );
}

function notifySendResult(results) {
  if (!results.length) return;
  const ok = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  if (!failed.length) {
    notify("Sent to EthOS NAS", ok === 1 ? "Download queued." : `${ok} downloads queued.`);
    return;
  }
  const first = failed[0].error || "unknown error";
  notify(
    ok ? `Queued ${ok}, failed ${failed.length}` : "EthOS NAS: send failed",
    failed.length === 1 ? first : `${first} (+${failed.length - 1} more)`,
  );
}

// ── Connection helpers (options page) ────────────────────────────────────────

async function testConnection() {
  try {
    const summary = await api("/api/downloads/summary");
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function login(username, password) {
  const current = await getSettings();
  const base = normalizeNasUrl(current.nasUrl);
  if (!base) return { ok: false, error: "Set the NAS URL first." };
  if (!username || !password) return { ok: false, error: "Username and password are required." };

  let response;
  try {
    response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (error) {
    return { ok: false, error: `Cannot reach the NAS (${error?.message || error})` };
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: data?.detail || `Login failed (HTTP ${response.status})` };
  }

  // Exchange the short-lived JWT for the long-lived per-user API key so the
  // extension keeps working after the JWT expires.
  let keyResponse;
  try {
    keyResponse = await fetch(`${base}/api/auth/api-key`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
  } catch (error) {
    return { ok: false, error: `Cannot reach the NAS (${error?.message || error})` };
  }
  const keyData = await keyResponse.json().catch(() => null);
  if (!keyResponse.ok || !keyData?.api_key) {
    return { ok: false, error: keyData?.detail || "Could not read the API key" };
  }

  const stored = await chrome.storage.local.get("settings");
  const next = {
    ...DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    nasUrl: base,
    username: keyData.username || username,
    apiKey: keyData.api_key,
  };
  settings = next;
  await chrome.storage.local.set({ settings: next });
  return { ok: true, username: next.username };
}

async function getConfig() {
  try {
    const config = await api("/api/downloads/config");
    const result = {
      ok: true,
      categories: normCategoryList(config?.categories),
      downloadDir: config?.download_dir || "",
      provider: config?.debrid?.provider || "",
      fetchedAt: Date.now(),
    };
    // Keep the last good answer so the popup can render the Download Manager's
    // categories instantly (and while the NAS is unreachable).
    await chrome.storage.local.set({ nasConfig: result });
    return result;
  } catch (error) {
    const stored = await chrome.storage.local.get("nasConfig");
    const cached = stored?.nasConfig || {};
    return {
      ok: false,
      error: error?.message || String(error),
      stale: true,
      categories: normCategoryList(cached.categories),
      downloadDir: cached.downloadDir || "",
      provider: cached.provider || "",
      fetchedAt: Number(cached.fetchedAt || 0),
    };
  }
}

// ── Keyboard shortcut ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    if (command !== "send-current-tab") return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || !/^https?:|^magnet:/i.test(tab.url)) {
        notify("Nothing to send", "The active tab has no downloadable URL.");
        return;
      }
      const results = await sendMany([tab.url], {});
      notifySendResult(results);
    } catch (error) {
      notify("EthOS NAS", error?.message || String(error));
    }
  })();
});

// ── Messages from popup / options / content script ───────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "send":
        return { ok: true, results: await sendMany(message.urls || [], message.options || {}) };
      case "collect": {
        const tab = message.tabId ? { id: message.tabId } : sender.tab;
        return { ok: true, links: await collectLinks(tab) };
      }
      case "test":
        return await testConnection();
      case "login":
        return await login(message.username, message.password);
      case "config":
        return await getConfig();
      case "notify":
        notify(message.title || "EthOS NAS", message.message || "");
        return { ok: true };
      case "openOptions":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "state": {
        const current = await getSettings();
        return {
          ok: true,
          settings: {
            nasUrl: current.nasUrl,
            username: current.username,
            hasKey: !!current.apiKey,
            category: current.category,
            folder: current.folder,
            interceptDownloads: current.interceptDownloads,
            history: current.history || [],
          },
        };
      }
      default:
        return { ok: false, error: "Unknown message type" };
    }
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true; // keep the message channel open for the async reply
});
