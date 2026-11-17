// EthOS NAS Downloader — content script (classic script, no imports).
//
// Two jobs:
//   1. collect every http(s)/magnet anchor on the page for the popup and the
//      "Send file links on this page" context menu;
//   2. optionally swallow clicks on magnet links / direct file links and send
//      them to the NAS instead of handing them to the browser.

(() => {
  if (window.__ethosNasDownloaderLoaded) return;
  window.__ethosNasDownloaderLoaded = true;

  const FILE_EXTENSIONS = new Set([
    "torrent", "rar", "zip", "7z", "tar", "gz", "iso", "img", "mkv", "mp4",
    "avi", "mov", "flac", "mp3", "pdf", "epub", "exe", "msi", "dmg", "apk",
  ]);
  const MAX_LINKS = 1000;

  function collectLinks() {
    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll("a[href], area[href]")) {
      let href = "";
      try {
        href = anchor.href || "";
      } catch {
        continue;
      }
      if (!/^(https?|magnet):/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({
        url: href,
        text: (anchor.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
        download: anchor.hasAttribute("download"),
      });
      if (links.length >= MAX_LINKS) break;
    }
    return links;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "collectLinks") {
      sendResponse(collectLinks());
    }
    return false;
  });

  // ── Click interception ─────────────────────────────────────────────────────
  // Settings live in chrome.storage; keep a local copy in sync.
  const defaults = { interceptMagnet: true, interceptFileLinks: false };
  let settings = { ...defaults };

  try {
    chrome.storage.local.get("settings").then((stored) => {
      settings = { ...defaults, ...(stored.settings || {}) };
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) {
        settings = { ...defaults, ...(changes.settings.newValue || {}) };
      }
    });
  } catch {
    // Storage is unavailable in a sandboxed frame — keep the defaults.
  }

  function looksLikeFileLink(href) {
    try {
      const name = new URL(href).pathname.split("/").pop() || "";
      const dot = name.lastIndexOf(".");
      if (dot <= 0) return false;
      return FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
    } catch {
      return false;
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor) return;

      let href = "";
      try {
        href = anchor.href || "";
      } catch {
        return;
      }

      const isMagnet = /^magnet:\?/i.test(href);
      const isFile = settings.interceptFileLinks
        && /^https?:\/\//i.test(href)
        && (anchor.hasAttribute("download") || looksLikeFileLink(href));

      if (isMagnet ? !settings.interceptMagnet : !isFile) return;

      event.preventDefault();
      event.stopPropagation();

      const name = anchor.getAttribute("download") || "";
      chrome.runtime
        .sendMessage({ type: "send", urls: [href], options: name ? { name } : {} })
        .then((response) => {
          if (!response?.ok) {
            chrome.runtime.sendMessage({
              type: "notify",
              title: "EthOS NAS: send failed",
              message: response?.error || "The extension could not reach the NAS.",
            });
            return;
          }
          const failed = (response.results || []).find((result) => !result.ok);
          if (failed) {
            chrome.runtime.sendMessage({
              type: "notify",
              title: "EthOS NAS: send failed",
              message: failed.error || "The NAS rejected the link.",
            });
          }
        })
        .catch(() => {
          // Worker went away (extension reloaded) — let the browser handle
          // the click rather than swallowing it silently.
          window.location.href = href;
        });
    },
    true,
  );
})();
