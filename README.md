# EthOS NAS Downloader — browser extension

A Manifest V3 Chromium extension (Chrome, Edge, Brave, Vivaldi) that sends links,
magnets, `.torrent` files and intercepted browser downloads to the **EthOS NAS Download
Manager**.

It is built for pages that only reveal the real file URL after a few redirects or a
countdown (downTURK, link protectors, file-host landing pages): right-click → **Send file
links on this page**, or let the extension take over the browser download once the final
URL appears.

Opening the popup with a copied download link in the clipboard fills the URL field
automatically (**Use the clipboard** in the options, on by default) — copy a link on any
page, click the toolbar icon, hit *Send to NAS*.

This is the browser-extension companion of the EthOS NAS core
([`SyncHot/ethos-nas`](https://github.com/SyncHot/ethos-nas)). It only uses the public
`/api/downloads/*` API, so it works against any EthOS NAS version that has the Download
Manager.

```
.
├── manifest.json          MV3 manifest (permissions: contextMenus, storage, downloads,
│                          notifications, activeTab, scripting, clipboardRead; host: http/https)
├── src/
│   ├── background.js      service worker: API calls, context menus, download capture
│   ├── content.js         collects anchors, intercepts magnet/file-link clicks
│   ├── lib/shared.js      settings defaults + link classification (imported)
│   ├── popup.html/.js/.css
│   └── options.html/.js/.css
├── icons/icon{16,32,48,128}.png
├── scripts/make-icons.py  regenerates the icons (no Pillow needed)
├── package.py             builds dist/ethos-nas-downloader-<version>.zip
├── tests/
│   ├── test_extension.py  static guard (manifest, files, icons, CSP, no secrets)
│   └── ui-smoke.js        Puppeteer pass over the popup + options pages
└── docs/design.md         architecture / handoff notes
```

No build step: the files are loaded as-is. No remote code, no analytics.

## Install

1. Build the zip (or use the folder directly):

   ```bash
   python3 package.py
   ```

2. On the machine that runs the browser, unpack
   `dist/ethos-nas-downloader-<version>.zip`.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick
   the unpacked folder.

The options page opens on first install.

## Configure

1. **NAS URL** — e.g. `http://192.168.50.215:9000`.
2. Either **sign in** with your NAS (Linux/PAM) username and password — the extension
   exchanges the session for your long-lived API key and never stores the password — or
   paste a key from **NAS → Settings → Security → API key**.
3. **Test connection** should report the number of tasks.
4. Optional: pick a default category and folder.

### Categories

The category dropdown is a live mirror of **Download Manager → Settings → Categories**
(`GET /api/downloads/config`). Every popup open re-reads the NAS list, the options tab
refreshes it when it regains focus, and the ↻ button next to the picker forces a reload —
so categories you add, rename or remove in the Download Manager show up without
reinstalling the extension. The list is cached in `chrome.storage.local` (key
`nasConfig`), so it still renders while the NAS is unreachable, and a default category
that no longer exists on the NAS is cleared instead of being silently ignored.

Picking a category (or editing the folder) in the popup saves it as the **send default**
immediately — a right-click *Send link to EthOS NAS*, an intercepted link or a captured
browser download happens with no popup open, so it uses the stored choice. `.torrent`
uploads carry the category too. An explicit folder always wins over a category, exactly
like in the Download Manager.

The API key is sent as `Authorization: Bearer …`; it is the same per-user key the Android
apps use, and it is never put in a URL.

## Use

| Action | How |
|---|---|
| Send a link | Right-click a link → **Send link to EthOS NAS** |
| Send the current page | Right-click the page → **Send this page URL**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Parse an index page | Right-click the page → **Send file links on this page** — every file-host link (downTURK, RapidGator, …) is queued |
| Pick links manually | Toolbar popup → **Page links** tab → tick the rows → **Send selected** |
| Paste a URL / magnet | Toolbar popup → **Add link** |
| Take over a download | Options → **Take over browser downloads** — the browser download is cancelled and the resolved URL is queued |

Captured download URLs are the *final* URLs after redirects, which is exactly what a
file-host page produces after its countdown.

### What the extension calls

| Endpoint | Use |
|---|---|
| `POST /api/downloads/tasks` | everything except `.torrent` URLs |
| `POST /api/downloads/tasks/torrent?folder=` | `.torrent` URLs — the extension fetches the file, the NAS parses it into a magnet |
| `GET /api/downloads/config` | categories, download dir, debrid provider |
| `GET /api/downloads/summary` | connection test |
| `POST /api/auth/login`, `GET /api/auth/api-key` | sign-in → API key exchange |

All requests run in the service worker. With `host_permissions` for `http(s)://*/*` an
extension worker is not subject to CORS, so no `ETHOS_CORS_ORIGINS` change is needed.

## Requirements and limits

- **Magnets and `.torrent` files need a debrid provider** (AllDebrid, Real-Debrid or
  TorBox) configured in the NAS download settings. The core engine has no BitTorrent
  client.
- **File-host links (`rapidgator.net`, `mediafire.com`, …) are routed through debrid
  only when the provider is AllDebrid** — that is the current backend behaviour
  (`_is_file_host` in `backend/routers/downloads.py`). With another provider the NAS
  saves the host's HTML page. The popup warns about this while you type the link.
- The NAS does **not** receive the browser's cookies or `Referer` yet. Links that only
  work inside a logged-in browser session will fail on the NAS; use a debrid provider
  for those hosts.
- The NAS must be reachable from the browser (same LAN or VPN). `http://` is fine even
  when the current page is `https://` — extension requests are not mixed content.
- The browser download is cancelled locally, so Chrome may briefly show a failed entry in
  the downloads shelf.

## Development

- After editing, `chrome://extensions` → **Reload**; the service worker console is under
  **Inspect views: service worker**.
- Static guard: `python3 tests/test_extension.py` (stdlib only, also runs in CI).
- Browser pass over the popup/options pages:

  ```bash
  npm install
  CHROME_PATH=/usr/bin/chromium npm run test:ui
  ```

- Icons: `python3 scripts/make-icons.py`.
- Architecture/handoff notes: [`docs/design.md`](docs/design.md).
