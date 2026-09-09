/**
 * The myna desktop app.
 *
 * The window is a thin shell over the same core the CLI uses, so an account
 * connected here works in the terminal and the other way round. All of the
 * network and credential work happens in the main process; the renderer gets
 * a narrow, typed IPC surface and no Node access at all.
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { join } = require("node:path");
const { writeFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

// Built from packages/core by `bun run build:core`.
const core = require("./core.cjs");

let window = null;
let stopScheduler = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b1020",
    title: "myna",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.loadFile(join(__dirname, "..", "renderer", "index.html"));

  // Anything that is not this app opens in the real browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();

  stopScheduler = core.startScheduler(30_000, (runs) => {
    for (const run of runs) {
      window?.webContents.send("scheduler:ran", {
        id: run.post.id,
        summary: core.summarize(run.results),
      });
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopScheduler?.();
  if (process.platform !== "darwin") app.quit();
});

/** Wrap a handler so the renderer always gets {ok, value} or {ok:false, error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

// Credentials never cross the IPC boundary.
const publicAccount = ({ creds, ...rest }) => rest;

/**
 * Ask the person a question in the middle of a sign-in.
 *
 * Some sign-ins are a conversation rather than a form: a directory mails a
 * one-time code, a device flow waits for a browser. The adapter calls `ask`,
 * which shows a prompt in the window and resolves when it comes back. A
 * question with no window to show it in fails rather than hanging forever.
 */
let nextAskId = 1;
const pendingAsks = new Map();

function askRenderer(prompt) {
  return new Promise((resolve, reject) => {
    if (!window) {
      reject(new Error("There is no window to ask in."));
      return;
    }
    const id = nextAskId++;
    pendingAsks.set(id, { resolve, reject });
    window.webContents.send("login:ask", { id, prompt });
  });
}

ipcMain.on("login:answer", (_event, { id, value, cancelled }) => {
  const pending = pendingAsks.get(id);
  if (!pending) return;
  pendingAsks.delete(id);
  if (cancelled) pending.reject(new Error("Cancelled."));
  else pending.resolve(String(value ?? ""));
});

/** The login context every adapter gets, network or directory alike. */
const loginContext = () => ({
  report: (message) => window?.webContents.send("login:progress", message),
  openUrl: async (url) => {
    window?.webContents.send("login:progress", url);
    await shell.openExternal(url);
  },
  ask: askRenderer,
});

handle("networks:list", () =>
  core.NETWORKS.map((network) => ({
    id: network.id,
    name: network.name,
    category: network.category,
    blurb: network.blurb,
    auth: { kind: network.auth.kind, note: network.auth.note, docsUrl: network.auth.docsUrl, fields: network.auth.fields },
    caps: network.caps,
  })),
);

handle("accounts:list", () => core.listAccounts().map(publicAccount));

handle("accounts:login", async (networkId, values) => {
  const network = core.requireNetwork(networkId);
  const partial = await network.login(values, loginContext());
  const account = {
    ...partial,
    id: `${network.id}:${partial.handle}`,
    network: network.id,
    addedAt: new Date().toISOString(),
  };
  core.saveAccount(account);
  return publicAccount(account);
});

handle("accounts:logout", (id) => core.removeAccount(id));

/* ------------------------------------------------------------- directories */

handle("directories:list", () =>
  core.directoryStatus().map(({ directory, account }) => ({
    id: directory.id,
    name: directory.name,
    blurb: directory.blurb,
    homepage: directory.homepage,
    caps: directory.caps,
    auth: { note: directory.auth.note, docsUrl: directory.auth.docsUrl, fields: directory.auth.fields },
    connected: Boolean(account),
    handle: account?.handle ?? null,
  })),
);

handle("directories:login", async (directoryId, values) => {
  const account = await core.loginDirectory(directoryId, values, loginContext());
  return { directory: account.directory, handle: account.handle };
});

handle("directories:logout", (directoryId) => core.logoutDirectory(directoryId));

// Preview and submit are separate calls on purpose: a listing is public and is
// read by whoever reviews it, so the window shows it before anything is sent.
handle("directories:preview", async (directoryId, url) => {
  const built = await core.buildListing(core.requireDirectory(directoryId), url);
  return { listing: built.listing, describedBy: built.source };
});

handle("directories:submit", async (directoryId, listing) => {
  const result = await core.submitListing(directoryId, listing);
  return result.listing;
});

handle("directories:listings", async (directoryId) => {
  const ids = directoryId
    ? [core.requireDirectory(directoryId).id]
    : core.directoryStatus().filter((row) => row.account).map((row) => row.directory.id);
  const listings = [];
  for (const id of ids) {
    const directory = core.requireDirectory(id);
    for (const listing of await directory.listings(core.requireDirectoryAccount(id))) {
      listings.push({ directory: id, ...listing });
    }
  }
  return listings;
});

handle("directories:remove", async (directoryId, listingId) => {
  const directory = core.requireDirectory(directoryId);
  if (!directory.remove) throw new Error(`${directory.name} does not allow withdrawing a listing.`);
  await directory.remove(core.requireDirectoryAccount(directoryId), listingId);
  return true;
});

handle("post:send", async ({ text, title, targets, mediaPaths, thread }) => {
  const accounts = targets?.length
    ? core.listAccounts().filter((account) => targets.includes(account.id))
    : core.listAccounts();
  const results = await core.postToAll(accounts, {
    text,
    title: title || undefined,
    media: mediaPaths?.length ? core.loadAllMedia(mediaPaths) : undefined,
    thread: thread ?? core.loadSettings().threadByDefault,
    signature: core.loadSettings().signature || undefined,
  });
  return results.map((result) => ({
    account: result.account.id,
    ok: result.ok,
    url: result.posts[0]?.url,
    error: result.error,
  }));
});

handle("post:preview", ({ text, targets }) => {
  const accounts = targets?.length
    ? core.listAccounts().filter((account) => targets.includes(account.id))
    : core.listAccounts();
  return accounts.map((account) => {
    const parts = text ? core.tailor(account.network, { text, thread: true }) : [];
    return {
      account: account.id,
      network: account.network,
      used: text ? core.charsFor(account.network, parts[0] ?? "") : 0,
      limit: core.requireNetwork(account.network).caps.charLimit,
      parts: parts.length,
    };
  });
});

handle("queue:list", () => core.listQueue());
handle("queue:add", ({ text, title, targets, at, mediaPaths }) =>
  core.enqueue({
    scheduledFor: new Date(at).toISOString(),
    targets: targets?.length ? targets : core.listAccounts().map((account) => account.id),
    text,
    title: title || undefined,
    mediaPaths,
    thread: core.loadSettings().threadByDefault,
  }),
);
handle("queue:remove", (id) => core.removeQueued(id));

handle("history:list", () => core.listHistory().slice(0, 200));

handle("settings:get", () => core.loadSettings());
handle("settings:set", (settings) => {
  core.saveSettings(settings);
  return core.loadSettings();
});

handle("ai:available", () => core.writerAvailable());
handle("ai:draft", ({ prompt, url, networks }) => core.draft({ prompt, url, networks }));
handle("ai:revise", ({ text, instruction, network }) => core.revise(text, instruction, network));

handle("ai:infographic", async ({ input, style }) => {
  const copy = await core.infographicCopy(/^https?:\/\//.test(input) ? { url: input } : { prompt: input });
  const html = style === "html" ? await core.infographicHtml(copy, 1200, 1200) : undefined;
  const result = await core.renderInfographic(copy, style ?? "svg", {}, html);
  const path = join(mkdtempSync(join(tmpdir(), "myna-graphic-")), "infographic.png");
  writeFileSync(path, result.png);
  // The renderer cannot read the filesystem, so hand it a data URL to show.
  return {
    path,
    copy,
    dataUrl: `data:image/png;base64,${Buffer.from(result.png).toString("base64")}`,
  };
});

handle("media:pick", async () => {
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Media", extensions: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

handle("doctor", () => ({
  configDir: core.configDir(),
  networks: core.NETWORKS.length,
  rasterizers: core.availableRasterizers(),
  ai: core.writerAvailable(),
  settings: core.loadSettings(),
}));

handle("shell:open", (url) => shell.openExternal(url));
