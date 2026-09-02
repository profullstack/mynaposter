/**
 * The myna TUI.
 *
 * A command bar at the bottom, a screen above it, and modal dialogs over both.
 * Everything is reachable by typing a slash command, so the keybindings are a
 * shortcut rather than the only way in.
 */
import { createApp, type App, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import {
  listAccounts,
  loadSettings,
  needsPassphrase,
  startScheduler,
  unlock,
  type Account,
} from "@profullstack/myna-core";
import { createState, selectedAccounts, toast, SCREENS, type Screen, type State } from "./state.ts";
import { completions, runCommand } from "./commands.ts";
import { cancelLogin, submitLogin } from "./login.ts";
import {
  accountsScreen,
  composeScreen,
  feedScreen,
  helpScreen,
  historyScreen,
  networksScreen,
  queueScreen,
} from "./screens/index.ts";

const TOAST_MS = 6000;

export async function runTui(options: { theme?: string } = {}): Promise<void> {
  if (needsPassphrase()) {
    unlock(await promptPassphrase());
  }

  const settings = loadSettings();
  let accounts: Account[] = [];
  try {
    accounts = listAccounts();
  } catch (error) {
    console.error(`Could not open the vault: ${(error as Error).message}`);
    process.exit(1);
  }

  const state = createState(accounts);
  const app = await createApp({
    theme: (options.theme ?? settings.theme) as never,
    title: "myna",
    // "q" must reach the compose box, so Ctrl+C is the only quit key.
    quitKeys: ["ctrl+c"],
    focusNavigation: false,
  });

  const redraw = () => app.redraw();
  const stopScheduler = startScheduler(30_000, (runs) => {
    const sent = runs.filter((run) => run.results.some((result) => result.ok)).length;
    if (sent) {
      toast(state, `Scheduler sent ${sent} queued post${sent === 1 ? "" : "s"}`, "success");
      app.invalidate();
    }
  });

  app.on("key", (event) => {
    void handleKey(app, state, event, redraw).catch((error: Error) => {
      state.busy = "";
      toast(state, error.message, "error");
      app.invalidate();
    });
  });

  app.render(({ ui, theme, height }) => {
    ui.column({ size: "1fr" }, (root) => {
      root.row({ size: 1 }, (header) => {
        header.tabs({
          tabs: [...SCREENS],
          active: SCREENS.indexOf(state.screen),
          size: "fill",
        });
        const targets = selectedAccounts(state);
        header.badge({
          text: state.accounts.length
            ? state.targets.size
              ? `${targets.length} selected`
              : `all ${targets.length}`
            : "no accounts",
          color: state.accounts.length ? theme.success : theme.warning,
          size: 18,
        });
      });

      root.spacer(1);

      switch (state.screen) {
        case "compose":
          composeScreen(root, state, theme);
          break;
        case "accounts":
          accountsScreen(root, state, theme);
          break;
        case "queue":
          queueScreen(root, state, theme);
          break;
        case "history":
          historyScreen(root, state, theme);
          break;
        case "feed":
          feedScreen(root, state, theme);
          break;
        case "networks":
          networksScreen(root, state, theme);
          break;
        case "help":
          helpScreen(root, state, theme);
          break;
      }

      root.spacer(1);
      root.panel({ size: 3, title: state.mode === "command" ? "Command" : "Command (Esc to focus)" }, (box) => {
        box.textInput({
          value: state.command.value,
          cursor: state.command.cursor,
          focused: state.mode === "command",
          placeholder: "/help    /login bluesky    /link <url>    /post",
          size: 1,
        });
      });

      const toastAlive = state.toast && Date.now() - state.toast.at < TOAST_MS;
      root.statusBar({
        size: 1,
        items: [
          { label: "myna", color: theme.primary },
          state.busy
            ? { label: state.busy, color: theme.warning }
            : toastAlive
              ? {
                  label: state.toast!.text,
                  color:
                    state.toast!.kind === "error"
                      ? theme.danger
                      : state.toast!.kind === "success"
                        ? theme.success
                        : theme.muted,
                }
              : { label: hint(state), color: theme.muted },
          { key: "accounts", label: String(state.accounts.length) },
        ],
      });
    });

    if (state.mode === "login" && state.login) drawLogin(ui, state, theme, height);
    if (state.mode === "targets") drawTargets(ui, state, theme);
  });

  try {
    await app.start();
  } finally {
    stopScheduler();
  }
}

function hint(state: State): string {
  if (state.mode === "compose") return "Ctrl+S posts    Esc back to the command bar";
  if (state.mode === "targets") return "Space toggles    Enter confirms    Esc cancels";
  if (!state.accounts.length) return "No accounts yet, try /login bluesky";
  return "/ for commands    Enter to edit the post    Ctrl+S to send";
}

function drawLogin(ui: Container, state: State, theme: Theme, height: number): void {
  const flow = state.login!;
  const rows = flow.fields.length * 2 + flow.log.length + 9;

  ui.modal(
    {
      title: `Connect ${flow.network.name}`,
      width: 76,
      height: Math.min(rows, Math.max(12, height - 4)),
    },
    (panel) => {
      if (flow.network.auth.note) {
        for (const line of wrapText(flow.network.auth.note, 70)) panel.label(line, { size: 1 });
        panel.spacer(1);
      }

      flow.fields.forEach((field, index) => {
        const spec = flow.network.auth.fields[index];
        panel.textInput({
          value: field.value,
          cursor: field.cursor,
          focused: index === flow.active && !flow.busy,
          label: `${field.label}${spec?.optional ? "" : " *"}`,
          password: field.options.secret,
          placeholder: field.options.placeholder,
          size: 1,
        });
        if (field.options.help && index === flow.active) panel.label(`  ${field.options.help}`, { size: 1 });
      });

      if (flow.log.length) {
        panel.spacer(1);
        panel.divider({ label: "progress" });
        for (const line of flow.log.slice(-4)) {
          for (const wrapped of wrapText(line, 70)) panel.label(wrapped, { size: 1 });
        }
      }

      if (flow.error) {
        panel.spacer(1);
        for (const line of wrapText(flow.error, 70)) panel.text(line, { size: 1, fg: theme.danger });
      }

      panel.spacer(1);
      panel.label(flow.busy ? "Working..." : "Tab next field    Enter connect    Esc cancel", { size: 1 });
    },
  );
}

function drawTargets(ui: Container, state: State, theme: Theme): void {
  ui.modal({ title: "Post to", width: 60, height: Math.min(state.accounts.length + 7, 24) }, (panel) => {
    state.accounts.forEach((account, index) => {
      panel.checkbox({
        label: account.id,
        checked: state.targets.size === 0 || state.targets.has(account.id),
        focused: index === state.targetCursor,
        color: theme.success,
        size: 1,
      });
    });
    panel.spacer(1);
    panel.label("Space toggles    a selects every account    Enter confirms", { size: 1 });
  });
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (`${current} ${word}`.trim().length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function handleKey(app: App, state: State, event: KeyEvent, redraw: () => void): Promise<void> {
  if (state.quit) {
    app.quit();
    return;
  }

  if (state.mode === "login") return handleLoginKey(state, event, redraw);
  if (state.mode === "targets") return handleTargetsKey(state, event);

  if (state.mode === "compose") {
    if (event.name === "escape") {
      state.mode = "command";
      return;
    }
    if (event.ctrl && event.name === "s") {
      await runCommand(state, "/post", redraw);
      return;
    }
    if (event.ctrl && event.name === "t") {
      state.mode = "targets";
      return;
    }
    state.compose.handle(event);
    return;
  }

  if (event.name === "escape") {
    state.command.clear();
    return;
  }
  if (event.ctrl && event.name === "s") {
    await runCommand(state, "/post", redraw);
    return;
  }
  if (event.name === "enter") {
    const line = state.command.value.trim();
    if (!line) {
      state.mode = "compose";
      state.screen = "compose";
      return;
    }
    state.command.clear();
    state.history.push(line);
    state.historyIndex = state.history.length;
    await runCommand(state, line, redraw);
    if (state.quit) app.quit();
    return;
  }
  if (event.name === "tab") {
    const matches = completions(state.command.value);
    if (matches.length === 1) state.command.set(`/${matches[0]} `);
    else if (matches.length > 1) toast(state, matches.map((name) => `/${name}`).join("  "), "info");
    return;
  }
  if (event.name === "up") {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      state.command.set(state.history[state.historyIndex] ?? "");
    }
    return;
  }
  if (event.name === "down") {
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      state.command.set(state.history[state.historyIndex] ?? "");
    } else {
      state.historyIndex = state.history.length;
      state.command.clear();
    }
    return;
  }

  // Number keys switch screens, but only when the bar is empty, otherwise
  // they belong to whatever is being typed.
  if (!state.command.value && /^[1-9]$/.test(event.name)) {
    const screen = SCREENS[Number(event.name) - 1];
    if (screen) {
      state.screen = screen as Screen;
      return;
    }
  }

  state.command.handle(event);
}

async function handleLoginKey(state: State, event: KeyEvent, redraw: () => void): Promise<void> {
  const flow = state.login!;
  if (flow.busy) return;

  if (event.name === "escape") {
    cancelLogin(state);
    return;
  }
  if (event.name === "tab" || (event.name === "down" && !event.ctrl)) {
    flow.active = (flow.active + (event.shift ? -1 : 1) + flow.fields.length) % flow.fields.length;
    return;
  }
  if (event.name === "up") {
    flow.active = (flow.active - 1 + flow.fields.length) % flow.fields.length;
    return;
  }
  if (event.name === "enter") {
    // Enter moves on until the last field, then submits, the shape people expect.
    if (flow.active < flow.fields.length - 1) {
      flow.active++;
      return;
    }
    await submitLogin(state, redraw);
    return;
  }
  flow.fields[flow.active]?.handle(event);
}

function handleTargetsKey(state: State, event: KeyEvent): void {
  if (event.name === "escape") {
    state.mode = "command";
    return;
  }
  if (event.name === "up") {
    state.targetCursor = Math.max(0, state.targetCursor - 1);
    return;
  }
  if (event.name === "down") {
    state.targetCursor = Math.min(state.accounts.length - 1, state.targetCursor + 1);
    return;
  }
  if (event.name === "a") {
    state.targets.clear();
    toast(state, `Posting to all ${state.accounts.length} accounts`, "success");
    return;
  }
  if (event.name === "space") {
    const account = state.accounts[state.targetCursor];
    if (!account) return;
    // An empty set means "everything", so the first toggle has to materialise it.
    if (!state.targets.size) {
      state.targets = new Set(state.accounts.map((entry) => entry.id));
    }
    if (state.targets.has(account.id)) state.targets.delete(account.id);
    else state.targets.add(account.id);
    return;
  }
  if (event.name === "enter") {
    if (state.targets.size === state.accounts.length) state.targets.clear();
    state.mode = "command";
    const count = selectedAccounts(state).length;
    toast(state, `Posting to ${state.targets.size ? `${count} selected` : `all ${count}`}`, "success");
  }
}

/** Read the vault passphrase without echoing it. */
function promptPassphrase(): Promise<string> {
  const ENTER = ["\r", "\n"];
  const INTERRUPT = String.fromCharCode(3);
  const BACKSPACE = [String.fromCharCode(127), String.fromCharCode(8)];

  return new Promise((resolve) => {
    process.stdout.write("Vault passphrase: ");
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    let value = "";
    const onData = (chunk: Buffer) => {
      const char = chunk.toString("utf8");
      if (ENTER.includes(char)) {
        stdin.off("data", onData);
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === INTERRUPT) {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (BACKSPACE.includes(char)) {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on("data", onData);
  });
}
