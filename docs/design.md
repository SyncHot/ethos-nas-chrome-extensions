# Browser extension — Spec & AI Handoff

A Manifest V3 Chromium extension that lets the browser hand links, magnets, `.torrent`
files and its own downloads to the EthOS NAS **Download Manager**. It exists because link
aggregators (downTURK and similar) only expose the real file URL after a landing page or
a redirect chain, which the NAS cannot crawl. Verified against the code on **2026-11-17**.

This repository is the browser-extension companion of the EthOS NAS core
(`github.com/SyncHot/ethos-nas`). It has no build step and no Python/Node runtime at
runtime; it talks to the core only through the public `/api/downloads/*` API.

## File map

| What | Where |
|---|---|
| MV3 manifest (permissions, service worker, popup, options, content script) | `manifest.json` |
| Service worker — menus, capture, API client, message router | `src/background.js` |
| Page link collector + click interception | `src/content.js` |
| Settings defaults, URL normalisation, link classification | `src/lib/shared.js` |
| Popup (add / page links / recent) | `src/popup.{html,js,css}` |
| Options (connection, defaults, capture) | `src/options.{html,js,css}` |
| Icons + generator | `icons/icon{16,32,48,128}.png`, `scripts/make-icons.py` |
| Distribution zip | `package.py` → `dist/` (gitignored) |
| User/install guide | `README.md` |
| Static guard | `tests/test_extension.py` |
| Browser smoke test | `tests/ui-smoke.js` (Puppeteer, `npm run test:ui`) |
| Backend contract (other repo) | `SyncHot/ethos-nas`: `backend/routers/downloads.py`, `docs/download-station.md` |

No backend code changed for this feature. The extension is a plain API client of the
existing downloads router.

## Data model

`chrome.storage.local` → key `settings`:

```
{ nasUrl, apiKey, username,
  category, folder,
  interceptDownloads, interceptMode: "files"|"all",
  interceptMagnet, interceptFileLinks,
  extensions: ["torrent","rar",…],
  notify: true,
  history: [{ts, url, name, ok, error}]   # newest first, capped at 25 }
```

`chrome.storage.local` → key `nasConfig` (category cache, written by the worker after
every successful `GET /api/downloads/config`):

```
{ ok: true, categories: [{name, save_path}], downloadDir, provider, fetchedAt }
```

- `categories` mirrors the Download Manager list (same normalisation: unique names,
  cap 50). The popup renders it cache-first and re-fetches on open; the options page
  re-fetches on focus and through the ↻ button next to the picker. A failed fetch
  returns the cache with `stale: true` instead of an empty list.
- A default `category` missing from a **fresh** list is cleared; while the list is
  cached/stale it stays visible and flagged "no longer on the NAS".
- `apiKey` is the per-user `ethos_…` key from `users.json` (same key the Android apps use).
  The password entered on the options page is only used for `POST /api/auth/login` and is
  never stored.
- Defaults live in `DEFAULT_SETTINGS` (`src/lib/shared.js`); `chrome.storage.onChanged`
  keeps the worker and the content script in sync.

Link classes (`classifyLink`): `magnet`, `torrent`, `filehost` (domain list
`HOSTER_DOMAINS`), `file` (extension in `extensions`), `page`, `other`. Capture and the
page-links list share this single classifier.

## API

All requests carry `Authorization: Bearer <apiKey>` and are made from the service worker
(host permissions ⇒ no CORS preflight, no `ETHOS_CORS_ORIGINS` change).

| Method | Path | Auth | Use |
|---|---|---|---|
| POST | `/api/downloads/tasks` | user | magnet, direct file, file-host link |
| POST | `/api/downloads/tasks/torrent?folder=` | user | multipart `files` — `.torrent` fetched by the extension |
| GET | `/api/downloads/config` | user | categories, `download_dir`, `debrid.provider` |
| GET | `/api/downloads/summary` | user | connection test (`active`, `total`) |
| POST | `/api/auth/login` | public | username/password → JWT |
| GET | `/api/auth/api-key` | user (JWT) | JWT → long-lived API key |

`.torrent` URLs are **not** posted to `/tasks`: the extension fetches the bytes
(`credentials: "include"`), checks the bencode header (`d…announce`) and uploads them to
`/tasks/torrent`, which parses the torrent server-side and creates a debrid task.

## Extension wiring

- **Context menus** (rebuilt on install/startup/worker start): *Send link*, *Send this page
  URL*, *Send file links on this page*. The last one collects anchors, filters with
  `classifyLink`, and queues every match.
- **Download capture** (`chrome.downloads.onDeterminingFilename`): when enabled and the
  resolved `finalUrl` matches (`interceptMode: "files"` → torrent/filehost/file, `"all"` →
  any http(s) download), the download is cancelled and the URL queued. URLs on the NAS
  origin are never intercepted.
- **Content script**: collects anchors on request (`collectLinks`) and optionally swallows
  clicks on `magnet:` links / direct file links, forwarding them to the worker.
- **Messaging** (`chrome.runtime.onMessage`): `send`, `collect`, `test`, `login`, `config`,
  `state`, `notify`, `openOptions`. All replies are `{ok, …}`; failures use
  `{ok: false, error}` with the backend `detail` string when available.
- **Badge + notifications**: green/red count after a send, `chrome.notifications` toast
  unless `notify` is off.
- **Keyboard**: `Alt+Shift+E` sends the active tab URL.

## Decisions & constraints

- **Service-worker-only networking.** Content scripts and popup pages never call the NAS;
  this keeps the API key out of page contexts and avoids CORS entirely.
- **No cookies / Referer forwarding.** Forwarding them would persist browser session
  secrets into `downloads_tasks.json`, which the logging and state rules forbid. Links
  behind a browser session therefore need a debrid provider.
- **File hosts are AllDebrid-only** in the current backend (`_is_file_host` +
  `provider == "alldebrid"`). The popup/options warn instead of silently saving HTML.
- **Cancel + erase** on capture so the local downloads shelf does not keep a failed entry.
- **Broad host permissions** (`http://*/*`, `https://*/*`) are required for the
  page-links collector and cross-origin capture on any site; `activeTab` alone cannot
  read anchors after a reload.
- **No remote code** — MV3 CSP-safe: no inline scripts, no CDN, no `eval`.

## Status

- [x] Manifest V3 + icons + packaging script
- [x] Service worker: context menus, capture, API client, message router, notifications
- [x] Popup: add link, page-links picker, category/folder, recent history, status pill
- [x] Categories mirror the Download Manager: cache-first render, refresh button, stale-default cleanup (1.0.2)
- [x] Category is a send default (1.0.3): a pick in the popup is saved immediately, so
      right-click sends and captured downloads use it; `.torrent` uploads forward it as
      `?category=` instead of dropping it
- [x] Options: URL, password sign-in → API key, key paste/forget, defaults, capture toggles
- [x] Content script: anchor collection + magnet/file-link click interception
- [x] Static guard test (`tests/test_extension.py`, CI)
- [x] Puppeteer smoke test for popup + options (`tests/ui-smoke.js`)
- [ ] Manual browser pass on a real downTURK page (needs a logged-in NAS + AllDebrid)
- [ ] Chrome Web Store packaging/review

## Known gaps / next steps

- Cookie/Referer forwarding for session-bound hosts would need a deliberate secret-handling
  design (ephemeral, never persisted) — not implemented.
- File-host routing for Real-Debrid/TorBox would be a core change in
  `backend/routers/downloads.py`; the extension already sends the right URL.
- No notification-center integration on the NAS side yet: sends are visible in the Download
  Manager task list, but the extension only reports via browser notifications.
- The popup shows the last 25 sends from `chrome.storage`; it does not poll live task
  progress (the Download Manager window is the place for that).
