#!/usr/bin/env node
/**
 * Browser smoke test for the popup and options pages.
 *
 * Copies the extension to a temp directory, stubs `chrome.*` (storage, runtime,
 * tabs), serves it over HTTP and drives both pages with Puppeteer. Catches
 * runtime errors that the static guard cannot see (missing elements, broken
 * imports, bad message handling).
 *
 *   npm install
 *   CHROME_PATH=/usr/bin/chromium npm run test:ui
 *
 * `CHROME_PATH` is optional — without it Puppeteer uses its own download.
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const REPO = path.resolve(__dirname, "..");
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), "ethos-ext-smoke-"));
const SKIP_TOP = new Set(["dist", "node_modules", ".git", "tests", "docs", "scripts"]);

const STUB = `
(() => {
  const store = {
    settings: {
      nasUrl: "http://127.0.0.1:9000",
      apiKey: "ethos_test_key",
      username: "marcin",
      category: "movies",
      folder: "",
      interceptDownloads: false,
      interceptMode: "files",
      interceptMagnet: true,
      interceptFileLinks: false,
      extensions: ["torrent", "rar", "zip", "7z", "iso"],
      notify: true,
      history: [
        { ts: Date.now() - 60000, url: "https://rapidgator.net/file/x/a.rar.html", name: "a.rar", ok: true, error: "" },
      ],
    },
  };
  window.__store = store;
  if (window.__settingsOverride) Object.assign(store.settings, window.__settingsOverride);
  window.__sent = [];
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: "1.0.0" }),
      getURL: (p) => "chrome-extension://stub/" + p,
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} },
      sendMessage: (msg) => {
        window.__sent.push(msg);
        if (msg.type === "test") return Promise.resolve({ ok: true, summary: { active: 0, total: 3 } });
        if (msg.type === "config") return Promise.resolve(window.__configResponse || {
          ok: true,
          categories: [
            { name: "movies", save_path: "/mnt/media/movies" },
            { name: "tv", save_path: "" },
          ],
          provider: "alldebrid", downloadDir: "/mnt/downloads", fetchedAt: Date.now(),
        });
        if (msg.type === "send") return Promise.resolve({
          ok: true,
          results: msg.urls.map((url) => ({ url, ok: true, task: { name: "file.rar" } })),
        });
        if (msg.type === "collect") return Promise.resolve({
          ok: true,
          links: [
            { url: "https://rapidgator.net/file/9b3/x.part01.rar.html", text: "PART 1", download: false },
            { url: "https://example.com/about", text: "About", download: false },
            { url: "magnet:?xt=urn:btih:abc&dn=test", text: "Magnet", download: false },
          ],
        });
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: {
        get: (keys) => {
          if (typeof keys === "string") return Promise.resolve({ [keys]: store[keys] });
          if (Array.isArray(keys)) {
            const out = {};
            for (const key of keys) if (key in store) out[key] = store[key];
            return Promise.resolve(out);
          }
          return Promise.resolve({ ...store });
        },
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://downturk.net/4303197-claude.html" }]),
      sendMessage: () => Promise.resolve([]),
      create: () => {},
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };
  // Clipboard auto-fill: deterministic content, no browser permission prompt.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => window.__clipboard ?? "https://rapidgator.net/file/7/clip.zip" },
  });
})();
`;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

const failures = [];

function check(name, ok, detail = "") {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failures.push(name);
}

function prepareCopy() {
  fs.cpSync(REPO, DEST, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(REPO, source);
      if (!rel) return true;
      return !SKIP_TOP.has(rel.split(path.sep)[0]);
    },
  });
  fs.writeFileSync(path.join(DEST, "stub.js"), STUB);
  for (const file of ["src/popup.html", "src/options.html"]) {
    const target = path.join(DEST, file);
    const html = fs.readFileSync(target, "utf8").replace("</head>", '  <script src="../stub.js"></script>\n</head>');
    fs.writeFileSync(target, html);
  }
}

function startServer() {
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url || "/").split("?")[0]);
    const file = path.join(DEST, urlPath);
    if (!file.startsWith(DEST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function run(base) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // ── Popup ──────────────────────────────────────────────────────────────
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("404")) errors.push(msg.text());
    });

    await page.goto(`${base}/src/popup.html`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "online");

    check("popup: no page errors", errors.length === 0, errors.join("; "));
    check("popup: setup banner hidden when configured",
      await page.$eval("#setup", (el) => el.classList.contains("hidden")));
    check("popup: categories loaded",
      await page.$$eval("#category option", (options) => options.map((o) => o.value).includes("movies")));
    check("popup: category label shows the destination path",
      await page.$$eval("#category option", (options) => {
        const movie = options.find((option) => option.value === "movies");
        return Boolean(movie && movie.textContent.includes("/mnt/media/movies"));
      }));
    check("popup: category note names the Download Manager",
      (await page.$eval("#category-note", (el) => el.textContent)).includes("Download Manager"));
    await page.$eval(".advanced", (el) => { el.open = true; });
    await page.click("#refresh-categories");
    await page.waitForFunction(() => window.__sent.filter((m) => m.type === "config").length >= 2);
    check("popup: refresh button re-reads categories", true);

    // A picker change must persist: right-click sends and captured downloads
    // have no popup open and can only use the stored defaults.
    await page.select("#category", "tv");
    await page.waitForFunction(() => window.__store.settings.category === "tv");
    check("popup: category choice is saved as the send default",
      await page.evaluate(() => window.__store.settings.category === "tv"));
    check("popup: category note explains the saved default",
      (await page.$eval("#category-note", (el) => el.textContent)).includes("right-click"));
    await page.$eval("#folder", (el) => {
      el.value = "archive";
      el.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(() => window.__store.settings.folder === "archive");
    check("popup: folder is saved as the send default",
      await page.evaluate(() => window.__store.settings.folder === "archive"));
    check("popup: folder-overrides-category warning shown",
      (await page.$eval("#category-note", (el) => el.textContent)).includes("overrides"));
    await page.select("#category", "movies");
    await page.$eval("#folder", (el) => {
      el.value = "";
      el.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(() => window.__store.settings.folder === "");
    check("popup: history rendered", (await page.$$("#history li")).length === 1);
    check("popup: footer shows NAS URL",
      (await page.$eval("#footer-note", (el) => el.textContent)).includes("127.0.0.1:9000"));

    check("popup: clipboard link prefilled",
      (await page.$eval("#url", (el) => el.value)) === "https://rapidgator.net/file/7/clip.zip");
    check("popup: clipboard note shown",
      !(await page.$eval("#clipboard-note", (el) => el.classList.contains("hidden"))));

    await page.$eval("#url", (el) => { el.value = "magnet:?xt=urn:btih:abc&dn=x"; el.dispatchEvent(new Event("input")); });
    check("popup: magnet classified", (await page.$eval("#kind", (el) => el.textContent)).includes("Magnet link"));

    await page.$eval("#url", (el) => { el.value = "https://rapidgator.net/file/9b3/x.part01.rar.html"; el.dispatchEvent(new Event("input")); });
    check("popup: file host classified", (await page.$eval("#kind", (el) => el.textContent)).includes("File-host link"));

    await page.$eval("#url", (el) => { el.value = "https://example.com/file.zip"; el.dispatchEvent(new Event("input")); });
    check("popup: send enabled", !(await page.$eval("#send", (el) => el.disabled)));
    await page.click("#send");
    await page.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("Queued"));
    check("popup: send result ok", await page.$eval("#result", (el) => el.classList.contains("ok")));
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === "send"));
    check("popup: send message carries URL",
      sent.length === 1 && sent[0].urls[0] === "https://example.com/file.zip", JSON.stringify(sent));
    check("popup: send message carries the category default",
      sent.length === 1 && sent[0].options?.category === "movies", JSON.stringify(sent));

    await page.click('.tab[data-tab="links"]');
    await page.waitForFunction(() => document.querySelectorAll("#link-list li").length > 0);
    const rows = await page.$$eval("#link-list li", (items) => items.length);
    check("popup: page-links list filters to file links", rows === 2, String(rows));
    check("popup: link badge", (await page.$eval("#links-count", (el) => el.textContent)) === "2");
    await page.click("#send-links");
    await page.waitForFunction(() => window.__sent.filter((m) => m.type === "send").length >= 2);
    const bulk = await page.evaluate(() => window.__sent.filter((m) => m.type === "send").at(-1));
    check("popup: bulk send includes host + magnet",
      bulk.urls.length === 2 && bulk.urls.some((url) => url.startsWith("magnet:")), JSON.stringify(bulk));
    check("popup: still no page errors", errors.length === 0, errors.join("; "));

    // A default category removed in the Download Manager must not survive.
    const pruned = await browser.newPage();
    await pruned.evaluateOnNewDocument(() => { window.__settingsOverride = { category: "gone" }; });
    await pruned.goto(`${base}/src/popup.html`, { waitUntil: "networkidle0" });
    await pruned.waitForFunction(() => document.querySelector("#status")?.textContent === "online");
    await pruned.waitForFunction(() => window.__store.settings.category === "");
    check("popup: stale default category cleared",
      await pruned.evaluate(() => window.__store.settings.category === ""));
    check("popup: stale default no longer offered",
      await pruned.$$eval("#category option", (list) => !list.some((option) => option.value === "gone")));

    // When the config call fails, the cached Download Manager list is shown.
    const offline = await browser.newPage();
    await offline.evaluateOnNewDocument(() => {
      window.__configResponse = {
        ok: false, stale: true, error: "offline",
        categories: [{ name: "archive", save_path: "/mnt/archive" }],
        provider: "alldebrid", downloadDir: "/mnt/downloads", fetchedAt: Date.now() - 120000,
      };
    });
    await offline.goto(`${base}/src/popup.html`, { waitUntil: "networkidle0" });
    await offline.waitForFunction(() => document.querySelector("#status")?.textContent === "online");
    check("popup: cached categories kept when the NAS is unreachable",
      await offline.$$eval("#category option", (list) => list.some((option) => option.value === "archive")));
    check("popup: stale category note warns",
      (await offline.$eval("#category-note", (el) => el.textContent)).toLowerCase().includes("cached"));

    // ── Options ────────────────────────────────────────────────────────────
    const options = await browser.newPage();
    const optionErrors = [];
    options.on("pageerror", (error) => optionErrors.push(error.message));
    options.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("404")) optionErrors.push(msg.text());
    });
    await options.goto(`${base}/src/options.html`, { waitUntil: "networkidle0" });
    await options.waitForFunction(() => document.querySelector("#nas-url")?.value);

    check("options: no page errors", optionErrors.length === 0, optionErrors.join("; "));
    check("options: NAS URL loaded",
      (await options.$eval("#nas-url", (el) => el.value)) === "http://127.0.0.1:9000");
    check("options: username loaded", (await options.$eval("#username", (el) => el.value)) === "marcin");
    check("options: categories loaded",
      await options.$$eval("#category option", (list) => list.map((o) => o.value).includes("tv")));
    check("options: category label shows the destination path",
      await options.$$eval("#category option", (list) => {
        const movie = list.find((option) => option.value === "movies");
        return Boolean(movie && movie.textContent.includes("/mnt/media/movies"));
      }));
    await options.click("#refresh-categories");
    await options.waitForFunction(() => window.__sent.filter((m) => m.type === "config").length >= 2);
    check("options: refresh button re-reads categories", true);
    check("options: version shown",
      (await options.$eval("#version", (el) => el.textContent)).includes("v1.0.0"));

    await options.click("#test");
    await options.waitForFunction(() => document.querySelector("#test-status")?.textContent.includes("Connected"));
    check("options: test connection", true);

    await options.click("#intercept-downloads");
    await options.click("#save");
    await options.waitForFunction(() => window.__store.settings.interceptDownloads === true);
    const saved = await options.evaluate(() => window.__store.settings);
    check("options: save persists capture flag", saved.interceptDownloads === true);
    check("options: save keeps the key", saved.apiKey === "ethos_test_key");
    check("options: save keeps category", saved.category === "movies");
  } finally {
    await browser.close();
  }
}

(async () => {
  let server;
  try {
    prepareCopy();
    server = await startServer();
    await run(`http://127.0.0.1:${server.address().port}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    fs.rmSync(DEST, { recursive: true, force: true });
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nSmoke test passed.");
})();
