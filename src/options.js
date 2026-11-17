import { DEFAULT_SETTINGS, normalizeNasUrl } from "./lib/shared.js";

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let config = { categories: [], provider: "", downloadDir: "" };

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

function renderConfigHint() {
  const hint = $("config-hint");
  hint.textContent = "";
  if (!config.downloadDir) {
    hint.textContent = "Categories are read from the NAS download settings.";
    return;
  }
  hint.append(`Download folder on the NAS: ${config.downloadDir}`);
  if (config.provider) {
    hint.append(` · debrid provider: ${config.provider}`);
    if (config.provider !== "alldebrid") {
      hint.append(" (file-host links need AllDebrid)");
    }
  } else {
    hint.append(" · no debrid provider (magnets and file hosts will not download)");
  }
}

function fillForm() {
  $("nas-url").value = settings.nasUrl || "";
  $("username").value = settings.username || "";
  $("folder").value = settings.folder || "";
  $("extensions").value = (settings.extensions || DEFAULT_SETTINGS.extensions).join(", ");
  $("intercept-downloads").checked = !!settings.interceptDownloads;
  $("intercept-magnet").checked = !!settings.interceptMagnet;
  $("intercept-file-links").checked = !!settings.interceptFileLinks;
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
  try {
    const response = await chrome.runtime.sendMessage({ type: "config" });
    if (!response?.ok) return;
    config = {
      categories: response.categories || [],
      provider: response.provider || "",
      downloadDir: response.downloadDir || "",
    };
    renderCategories();
    renderConfigHint();
  } catch {
    // Offline / not configured yet — keep the stored values.
  }
}

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
  fillForm();
  $("version").textContent = `EthOS NAS Downloader v${chrome.runtime.getManifest().version}`;
  await loadConfig();
  fillForm();
})();
