// Shared settings + link classification for the EthOS NAS Downloader extension.
// Imported by the service worker, the popup and the options page. The content
// script is a classic script (it cannot import modules) and only collects raw
// anchors — every classification decision happens here.

/** Defaults written to chrome.storage.local under the `settings` key. */
export const DEFAULT_SETTINGS = {
  // Connection
  nasUrl: "",
  apiKey: "",
  username: "",

  // Defaults applied to every send
  category: "",
  folder: "",

  // Capture behaviour
  interceptDownloads: false,
  interceptMode: "files", // "files" = only file-ish downloads, "all" = every http(s) download
  interceptMagnet: true,
  interceptFileLinks: false,
  clipboardAuto: true, // prefill the popup from a link copied to the clipboard
  extensions: [
    "torrent", "rar", "zip", "7z", "tar", "gz", "iso", "img", "mkv", "mp4",
    "avi", "mov", "flac", "mp3", "pdf", "epub", "exe", "msi", "dmg", "apk",
  ],
  notify: true,

  // Recent sends (newest first, capped)
  history: [],
};

/**
 * File-hosting domains. Links from these need a premium/debrid account; the
 * NAS routes them through AllDebrid when that provider is configured.
 */
export const HOSTER_DOMAINS = [
  "rapidgator.net", "rapidgator.asia", "mediafire.com", "mega.nz", "mega.co.nz",
  "1fichier.com", "uptobox.com", "turbobit.net", "uploadcloud.pro", "krakenfiles.com",
  "pixeldrain.com", "gofile.io", "filer.net", "depositfiles.com", "filefactory.com",
  "uloz.to", "send.cm", "ddownload.com", "nitroflare.com", "uploadgig.com",
  "clicknupload.click", "clicknupload.org", "mixdrop.co", "mixdrop.to",
  "1cloudfile.com", "doodstream.com", "vidhide.com", "filesfly.com", "k2s.cc",
  "tezfiles.com", "filespace.com", "uploady.io", "fboom.me", "hitfile.net",
  "uploaded.net", "oboom.com", "easybytez.com", "wdupload.com", "fileshark.pl",
  "uploadfile.pl", "prefiles.com", "filedot.to", "hexupload.net",
];

/** Normalise what the user typed into the options page into a base URL. */
export function normalizeNasUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "http://" + value;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    return url.origin + path;
  } catch {
    return "";
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Normalise the category list from `GET /api/downloads/config`.
 *
 * The endpoint returns `[{name, save_path}]`; older builds returned plain
 * strings, so both shapes are accepted. Names are deduped case-insensitively
 * and capped exactly like the NAS does (`download_config.norm_categories`), so
 * the popup shows the same list the Download Manager does.
 */
export function normCategoryList(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const source = typeof item === "string" ? { name: item } : item;
    const name = String(source?.name || "").trim().slice(0, 64);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, save_path: String(source?.save_path || "").trim().slice(0, 4096) });
    if (out.length >= 50) break;
  }
  return out;
}

/** Label used in the category pickers: "movies — /mnt/media/movies". */
export function categoryLabel(entry) {
  const name = String(entry?.name || "");
  const savePath = String(entry?.save_path || "");
  return savePath ? `${name} — ${savePath}` : name;
}

/** Lower-case file extension without the dot, or "" when there is none. */
export function extensionOf(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  const name = pathname.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Filename hinted by the URL (decoded, without query string). */
export function fileNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return name.replace(/[\\/]/g, "_").slice(0, 255);
  } catch {
    return "";
  }
}

export function isHosterUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return HOSTER_DOMAINS.some((domain) => host === domain || host.endsWith("." + domain));
}

/**
 * Classify a URL for the UI and for download interception.
 * Returns "magnet" | "torrent" | "filehost" | "file" | "page" | "other".
 */
export function classifyLink(url, settings = DEFAULT_SETTINGS) {
  const value = String(url || "");
  if (/^magnet:\?/i.test(value)) return "magnet";
  if (!/^https?:\/\//i.test(value)) return "other";
  const ext = extensionOf(value);
  if (ext === "torrent") return "torrent";
  if (isHosterUrl(value)) return "filehost";
  const extensions = Array.isArray(settings.extensions) && settings.extensions.length
    ? settings.extensions
    : DEFAULT_SETTINGS.extensions;
  if (ext && extensions.includes(ext)) return "file";
  return "page";
}

/** Human label used by the popup/link list. */
export function kindLabel(kind, url) {
  switch (kind) {
    case "magnet": return "Magnet";
    case "torrent": return "Torrent";
    case "filehost": return hostOf(url) || "File host";
    case "file": return (extensionOf(url) || "file").toUpperCase();
    case "page": return "Page";
    default: return "Link";
  }
}

export function isNasUrl(url, nasUrl) {
  const base = normalizeNasUrl(nasUrl);
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function formatBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}
