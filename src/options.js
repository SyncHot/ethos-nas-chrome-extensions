import {
  DEFAULT_SETTINGS,
  categoryLabel,
  normCategoryList,
  normalizeNasUrl,
} from "./lib/shared.js";

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let config = { categories: [], provider: "", downloadDir: "", stale: false, fetchedAt: 0 };

function setStatus(el, kind, text) {
  el.className = `status ${kind || ""}`.trim();
  el.textContent = text || "";
}

async function readSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settings;
}

/** Merge a patch into the stored settings without dropping unknown fields. */
async function persist(patch) {
  const stored = await chrome.storage.local.get("settings");
  const next = { ...DEFAULT_SETTINGS, ...(stored.settings || {}), ...patch };
  await chrome.storage.local.set({ settings: next });
  settings = next;
  return next;
}

function parseExtensions(value) {
  return [...new Set(
    String(value || "")
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().replace(/^\.+/, "").toLowerCase())
      .filter((entry) => /^[a-z0-9]{1,12}$/.test(entry)),
  )];
}

function renderKeyHint() {
  const hint = $("key-hint");
  hint.textContent = "";
  if (settings.apiKey) {
    const owner = settings.username ? ` for ${settings.username}` : "";
    hint.append(`A key${owner} is stored (…${settings.apiKey.slice(-4)}). Leave the field empty to keep it.`);
  } else {
    hint.append("Copy it from ");
    const em = document.createElement("em");
    em.textContent = "NAS → Settings → Security → API key";
    hint.append(em);
    hint.append(".");
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
  for (const entry of config.categories) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    select.append(option(entry.name, categoryLabel(entry)));
  }
  // Cached data may predate a rename/removal on the NAS — keep the saved
  // default visible (flagged) until a fresh config confirms it is gone.
  const fallback = String(settings.category || "").toLowerCase();
  if (fallback && !seen.has(fallback)) {
    select.append(option(settings.category, `${settings.category} — no longer on the NAS`));
  }
  select.value = settings.category || "";
}

function renderConfigHint() {
  const hint = $("config-hint");
  hint.textContent = "";
  if (!settings.apiKey) {
    hint.textContent = "Categories are read from the NAS Download Manager once an API key is stored.";
    return;
  }
  if (config.stale) {
    const when = config.fetchedAt ? ` (refreshed ${relativeTime(config.fetchedAt)})` : "";
    hint.append(`Categories cached${when} — the NAS is unreachable.`);
    hint.append(" They refresh automatically when the NAS is back.");
    return;
  }
  const count = config.categories.length;
  if (config.fetchedAt) {
    hint.append(
      count
        ? `${count} categor${count === 1 ? "y" : "ies"} from the NAS Download Manager (refresh ↻).`
        : "No categories on the NAS — add them in Download Manager → Settings.",
    );
  } else {
    hint.append("Loading categories from the NAS Download Manager…");
  }
  if (!config.downloadDir) return;
  hint.append(` Default folder: ${config.downloadDir}`);
  if (config.provider) {
    hint.append(` · debrid provider: ${config.provider}`);
    if (config.provider !== "alldebrid") {
      hint.append(" (file-host links need AllDebrid)");
    }
  } else {
    hint.append(" · no debrid provider (magnets and file hosts will not download)");
  }
}

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function fillForm() {
  $("nas-url").value = settings.nasUrl || "";
  $("username").value = settings.username || "";
  $("folder").value = settings.folder || "";
  $("extensions").value = (settings.extensions || DEFAULT_SETTINGS.extensions).join(", ");
  $("intercept-downloads").checked = !!settings.interceptDownloads;
  $("intercept-magnet").checked = !!settings.interceptMagnet;
  $("intercept-file-links").checked = !!settings.interceptFileLinks;
  $("clipboard-auto").checked = settings.clipboardAuto !== false;
  $("notify").checked = !!settings.notify;

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === (settings.interceptMode || "files");
  }
  $("mode-group").classList.toggle("disabled", !settings.interceptDownloads);

  renderCategories();
  renderKeyHint();
  renderConfigHint();
}

function currentNasUrl() {
  return normalizeNasUrl($("nas-url").value);
}

async function loadConfig() {
  if (!settings.apiKey) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "config" });
  } catch (error) {
    response = { ok: false, stale: true, error: error?.message || String(error) };
  }
  await applyConfig(response);
  renderCategories();
  renderConfigHint();
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
  renderConfigHint();
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

  // The NAS list is authoritative: when the default category was renamed or
  // removed in the Download Manager, forget it instead of sending it on every
  // download (the NAS would ignore it and use the download folder anyway).
  const wanted = String(settings.category || "").trim();
  if (response.ok === true && wanted) {
    const exists = config.categories.some(
      (entry) => entry.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!exists) {
      await persist({ category: "" });
      setStatus($("save-status"), "warn", `Category "${wanted}" no longer exists on the NAS — cleared.`);
    }
  }
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

// The options page lives in a normal tab for a long time: re-read the list when
// the user comes back from the Download Manager, so renames/additions show up
// without a page reload.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && settings.apiKey) void loadConfig();
});

// ── Connection ───────────────────────────────────────────────────────────────

$("test").addEventListener("click", () => {
  void (async () => {
    const base = currentNasUrl();
    if (!base) {
      setStatus($("test-status"), "err", "Enter the NAS URL first.");
      return;
    }
    await persist({ nasUrl: base });
    setStatus($("test-status"), "", "Testing…");

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "test" });
    } catch (error) {
      response = { ok: false, error: error?.message || String(error) };
    }

    if (!response?.ok) {
      setStatus($("test-status"), "err", response?.error || "Connection failed.");
      return;
    }
    const summary = response.summary || {};
    const active = Number(summary.active || 0);
    const total = Number(summary.total || 0);
    setStatus(
      $("test-status"),
      "ok",
      `Connected — ${active} active, ${total} task${total === 1 ? "" : "s"}.`,
    );
    await loadConfig();
  })();
});

$("open-nas").addEventListener("click", () => {
  const base = currentNasUrl() || settings.nasUrl;
  if (base) chrome.tabs.create({ url: base });
});

$("signin").addEventListener("click", () => {
  void (async () => {
    const base = currentNasUrl();
    const username = $("username").value.trim();
    const password = $("password").value;

    if (!base) {
      setStatus($("signin-status"), "err", "Enter the NAS URL first.");
      return;
    }
    if (!username || !password) {
      setStatus($("signin-status"), "err", "Username and password are required.");
      return;
    }

    await persist({ nasUrl: base });
    setStatus($("signin-status"), "", "Signing in…");

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "login", username, password });
    } catch (error) {
      response = { ok: false, error: error?.message || String(error) };
    }

    $("password").value = "";
    if (!response?.ok) {
      setStatus($("signin-status"), "err", response?.error || "Sign-in failed.");
      return;
    }

    await readSettings();
    $("api-key").value = "";
    $("username").value = settings.username || username;
    renderKeyHint();
    setStatus($("signin-status"), "ok", `Signed in as ${settings.username}. API key stored.`);
    await loadConfig();
  })();
});

$("clear-key").addEventListener("click", () => {
  void (async () => {
    await persist({ apiKey: "" });
    $("api-key").value = "";
    renderKeyHint();
    setStatus($("test-status"), "warn", "Stored API key removed.");
  })();
});

// ── Capture ──────────────────────────────────────────────────────────────────

$("intercept-downloads").addEventListener("change", (event) => {
  $("mode-group").classList.toggle("disabled", !event.target.checked);
});

// ── Save ─────────────────────────────────────────────────────────────────────

$("save").addEventListener("click", () => {
  void (async () => {
    const base = currentNasUrl();
    const typedKey = $("api-key").value.trim();

    if ($("nas-url").value.trim() && !base) {
      setStatus($("save-status"), "err", "That NAS URL is not valid.");
      return;
    }
    if (!base) {
      setStatus($("save-status"), "err", "NAS URL is required.");
      return;
    }
    if (typedKey && !/^ethos_\S+$/i.test(typedKey)) {
      setStatus($("save-status"), "err", "An EthOS API key starts with ethos_.");
      return;
    }

    const mode = document.querySelector('input[name="mode"]:checked')?.value || "files";
    const patch = {
      nasUrl: base,
      username: $("username").value.trim(),
      folder: $("folder").value.trim(),
      category: $("category").value || "",
      extensions: parseExtensions($("extensions").value),
      interceptDownloads: $("intercept-downloads").checked,
      interceptMode: mode,
      interceptMagnet: $("intercept-magnet").checked,
      interceptFileLinks: $("intercept-file-links").checked,
      clipboardAuto: $("clipboard-auto").checked,
      notify: $("notify").checked,
    };
    if (typedKey) patch.apiKey = typedKey;
    if (!patch.extensions.length) patch.extensions = [...DEFAULT_SETTINGS.extensions];

    await persist(patch);
    $("api-key").value = "";
    $("nas-url").value = base;
    $("extensions").value = patch.extensions.join(", ");
    fillForm();
    setStatus($("save-status"), "ok", "Saved.");
    setTimeout(() => setStatus($("save-status"), "", ""), 3000);

    await loadConfig();
  })();
});

// ── Boot ─────────────────────────────────────────────────────────────────────

void (async () => {
  await readSettings();
  await loadCachedConfig();
  fillForm();
  $("version").textContent = `EthOS NAS Downloader v${chrome.runtime.getManifest().version}`;
  await loadConfig();
  fillForm();
})();
