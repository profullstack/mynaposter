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

handle("networks:list", () =>
  core.NETWORKS.map((network) => ({
    id: network.id,
    name: network.name,
    category: network.category,
    blurb: network.blurb,
    auth: { kind: network.auth.kind, note: network.auth.note, fields: network.auth.fields },
    caps: network.caps,
  })),
);

handle("accounts:list", () => core.listAccounts().map(publicAccount));

handle("accounts:login", async (networkId, values) => {
  const network = core.requireNetwork(networkId);
  const partial = await network.login(values, {
    report: (message) => window?.webContents.send("login:progress", message),
    openUrl: async (url) => {
      window?.webContents.send("login:progress", url);
      await shell.openExternal(url);
    },
  });
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
