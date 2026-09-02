/**
 * Slash commands.
 *
 * The command bar is the primary interface — `/login facebook`, `/post`,
 * `/schedule tomorrow 9am`. Everything the TUI can do has a command, so the
 * whole app is reachable without learning a single keybinding.
 */
import {
  NETWORKS,
  authSummary,
  getNetwork,
  listAccounts,
  removeAccount,
  requireNetwork,
  resolveTargets,
  loadSettings,
  saveSettings,
  listQueue,
  enqueue,
  removeQueued,
  listHistory,
  postToAll,
  summarize,
  loadAllMedia,
  draft,
  revise,
  infographicCopy,
  infographicHtml,
  writerAvailable,
  renderInfographic,
  availableRasterizers,
  collect,
  seal,
  openBundle,
  applyBundle,
  describeBundle,
  refreshEngagement,
  type InfographicStyle,
} from "@profullstack/myna-core";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { selectedAccounts, toast, type State, SCREENS, type Screen } from "./state.ts";
import { Field } from "./field.ts";
import { startLogin } from "./login.ts";
import { parseWhen, describeWhen } from "./when.ts";

export interface Command {
  name: string;
  args?: string;
  help: string;
  run(state: State, args: string, redraw: () => void): void | Promise<void>;
}

/** `~` is what people type for a path they are about to scp somewhere. */
function expand(path: string): string {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

const requireTargets = (state: State) => {
  const accounts = selectedAccounts(state);
  if (!accounts.length) throw new Error("No accounts connected. Try /login bluesky");
  return accounts;
};

export const COMMANDS: Command[] = [
  {
    name: "help",
    help: "Show every command",
    run(state) {
      state.screen = "help";
    },
  },
  {
    name: "login",
    args: "<network>",
    help: "Connect an account. Prompts for whatever that network accepts",
    async run(state, args, redraw) {
      const id = args.trim().split(/\s+/)[0];
      if (!id) throw new Error("Which network? Try /networks to see them all.");
      const network = getNetwork(id);
      if (!network) {
        throw new Error(`Unknown network "${id}". /networks lists all ${NETWORKS.length}.`);
      }
      startLogin(state, network, redraw);
    },
  },
  {
    name: "logout",
    args: "<account>",
    help: "Disconnect an account and wipe its credentials",
    run(state, args) {
      const id = args.trim();
      if (!id) throw new Error("Which account? /accounts lists them.");
      const matches = state.accounts.filter((account) => account.id === id || account.network === id);
      if (!matches.length) throw new Error(`No account matches "${id}".`);
      for (const account of matches) {
        removeAccount(account.id);
        state.targets.delete(account.id);
      }
      state.accounts = listAccounts();
      toast(state, `Disconnected ${matches.map((account) => account.id).join(", ")}`, "success");
    },
  },
  {
    name: "accounts",
    help: "List connected accounts",
    run(state) {
      state.accounts = listAccounts();
      state.screen = "accounts";
    },
  },
  {
    name: "networks",
    help: "List every supported network and how it logs in",
    run(state) {
      state.screen = "networks";
    },
  },
  {
    name: "to",
    args: "<network|account|all>",
    help: "Choose where posts go. Comma separated, or 'all'",
    run(state, args) {
      const spec = args.trim();
      if (!spec || spec === "all" || spec === "*") {
        state.targets.clear();
        toast(state, `Posting to all ${state.accounts.length} accounts`, "success");
        return;
      }
      const accounts = resolveTargets(spec);
      state.targets = new Set(accounts.map((account) => account.id));
      toast(state, `Posting to ${accounts.map((account) => account.id).join(", ")}`, "success");
    },
  },
  {
    name: "all",
    help: "Post to every connected account",
    run(state) {
      state.targets.clear();
      toast(state, `Posting to all ${state.accounts.length} accounts`, "success");
    },
  },
  {
    name: "targets",
    help: "Pick targets from a checklist",
    run(state) {
      if (!state.accounts.length) throw new Error("No accounts connected. Try /login bluesky");
      state.mode = "targets";
      state.targetCursor = 0;
    },
  },
  {
    name: "compose",
    args: "[text]",
    help: "Edit the post. Ctrl+S posts it",
    run(state, args) {
      state.screen = "compose";
      if (args.trim()) state.compose.set(args);
      state.mode = "compose";
    },
  },
  {
    name: "post",
    args: "[text]",
    help: "Post now, to the current targets",
    async run(state, args, redraw) {
      const text = args.trim() || state.compose.value.trim();
      if (!text) throw new Error("Nothing to post. Type something in the compose box first.");
      const accounts = requireTargets(state);
      const settings = loadSettings();

      state.busy = `Posting to ${accounts.length} account${accounts.length === 1 ? "" : "s"}…`;
      redraw();
      try {
        const results = await postToAll(accounts, {
          text,
          title: state.title.value || undefined,
          media: state.media.length ? loadAllMedia(state.media) : undefined,
          thread: settings.threadByDefault,
          signature: settings.signature || undefined,
        });
        const failed = results.filter((result) => !result.ok);
        toast(state, summarize(results), failed.length ? "error" : "success");
        if (!failed.length) {
          state.compose.clear();
          state.title.clear();
          state.media = [];
          state.draftSource = "";
        }
        state.screen = "history";
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "draft",
    args: "<what to write about>",
    help: "Have the AI writer draft a post",
    async run(state, args, redraw) {
      const prompt = args.trim();
      if (!prompt) throw new Error("Draft what? Try /draft a release note for myna 0.1");
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);

      state.busy = "Writing…";
      redraw();
      try {
        const drafts = await draft({ prompt });
        if (!drafts.length) throw new Error("The writer returned nothing.");
        state.compose.set(drafts[0].text);
        state.draftSource = "written by AI, edit before posting";
        state.screen = "compose";
        state.mode = "compose";
        toast(state, "Draft ready — edit it, then Ctrl+S to post", "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "link",
    args: "<url>",
    help: "Read a link and write a post about it, with hashtags",
    async run(state, args, redraw) {
      const url = args.trim().split(/\s+/)[0];
      if (!url) throw new Error("Which link? Try /link https://example.com/post");
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);

      state.busy = `Reading ${url}…`;
      redraw();
      try {
        const accounts = selectedAccounts(state);
        // Tailor per network when the targets span more than one.
        const networks = [...new Set(accounts.map((account) => account.network))];
        const drafts = await draft({ url, networks: networks.length > 1 ? networks : [] });
        if (!drafts.length) throw new Error("The writer returned nothing.");

        const primary = drafts[0];
        const withTags = primary.hashtags.length
          ? `${primary.text}\n\n${primary.hashtags.join(" ")}`
          : primary.text;
        state.compose.set(withTags);
        state.draftSource =
          drafts.length > 1
            ? `written from the link; ${drafts.length} per-network variants, showing ${primary.network || "the first"}`
            : "written from the link, edit before posting";
        state.screen = "compose";
        state.mode = "compose";
        toast(state, "Draft ready from the link", "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "rewrite",
    args: "<instruction>",
    help: "Rewrite the current draft: shorter, warmer, different angle",
    async run(state, args, redraw) {
      const instruction = args.trim();
      if (!instruction) throw new Error("Rewrite how? Try /rewrite make it shorter");
      if (!state.compose.value.trim()) throw new Error("Nothing to rewrite yet.");
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);

      state.busy = "Rewriting…";
      redraw();
      try {
        state.compose.set(await revise(state.compose.value, instruction));
        toast(state, "Rewritten", "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "infographic",
    args: "[url or topic]",
    help: "Build an infographic and attach it to the post",
    async run(state, args, redraw) {
      const input = args.trim();
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);
      if (!availableRasterizers().length) {
        throw new Error(
          "No image renderer found. Install Chrome/Chromium, rsvg-convert, ImageMagick or Inkscape, or set CHROME_PATH.",
        );
      }

      const settings = loadSettings();
      const style = (settings.infographic as { style?: InfographicStyle }).style ?? "svg";
      const isUrl = /^https?:\/\//.test(input);

      state.busy = "Choosing the copy…";
      redraw();
      try {
        const copy = await infographicCopy(isUrl ? { url: input } : { prompt: input || state.compose.value });

        state.busy = "Rendering…";
        redraw();
        const html = style === "html" ? await infographicHtml(copy, 1200, 1200) : undefined;
        const result = await renderInfographic(copy, style, {}, html);

        const dir = mkdtempSync(join(tmpdir(), "myna-graphic-"));
        const path = join(dir, "infographic.png");
        writeFileSync(path, result.png);

        state.media = [path];
        if (copy.caption && !state.compose.value.trim()) {
          const tags = copy.hashtags.length ? `\n\n${copy.hashtags.join(" ")}` : "";
          state.compose.set(`${copy.caption}${tags}`);
        }
        state.draftSource = `infographic rendered to ${path}`;
        state.screen = "compose";
        toast(state, "Infographic attached — Ctrl+S to post", "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "media",
    args: "<path>",
    help: "Attach an image or video to the next post",
    run(state, args) {
      const path = args.trim();
      if (!path) {
        state.media = [];
        toast(state, "Attachments cleared", "success");
        return;
      }
      loadAllMedia([path]); // throws with a readable message if it is not usable
      state.media.push(path);
      toast(state, `Attached ${path}`, "success");
    },
  },
  {
    name: "title",
    args: "<text>",
    help: "Set the title Reddit, Lemmy and blogs require",
    run(state, args) {
      state.title.set(args.trim());
      toast(state, args.trim() ? `Title set` : "Title cleared", "success");
    },
  },
  {
    name: "schedule",
    args: "<when> [text]",
    help: "Queue a post: 'in 2h', 'tomorrow 9am', '2026-09-05 14:00'",
    run(state, args) {
      const trimmed = args.trim();
      if (!trimmed) throw new Error("When? Try /schedule tomorrow 9am");
      const { at, rest } = parseWhen(trimmed);
      const text = rest.trim() || state.compose.value.trim();
      if (!text) throw new Error("Nothing to schedule. Write the post first.");
      const accounts = requireTargets(state);

      const entry = enqueue({
        scheduledFor: at.toISOString(),
        targets: accounts.map((account) => account.id),
        text,
        title: state.title.value || undefined,
        mediaPaths: state.media.length ? [...state.media] : undefined,
        thread: loadSettings().threadByDefault,
      });
      state.compose.clear();
      state.media = [];
      state.screen = "queue";
      toast(state, `Queued ${entry.id} for ${describeWhen(at)}`, "success");
    },
  },
  {
    name: "queue",
    help: "Show scheduled posts",
    run(state) {
      state.screen = "queue";
      state.listCursor = 0;
    },
  },
  {
    name: "cancel",
    args: "<id>",
    help: "Remove a scheduled post",
    run(state, args) {
      const id = args.trim();
      if (!id) throw new Error("Which one? /queue shows the ids.");
      if (!removeQueued(id)) throw new Error(`No queued post with id "${id}".`);
      toast(state, `Cancelled ${id}`, "success");
    },
  },
  {
    name: "history",
    help: "Show what was posted, and what failed",
    run(state) {
      state.screen = "history";
      state.listCursor = 0;
    },
  },
  {
    name: "feed",
    args: "[network]",
    help: "Read the home timeline of an account",
    async run(state, args, redraw) {
      const spec = args.trim();
      const accounts = spec ? resolveTargets(spec) : selectedAccounts(state);
      const account = accounts.find((entry) => requireNetwork(entry.network).timeline);
      if (!account) throw new Error("None of those accounts can read a timeline.");

      state.busy = `Loading ${account.id}…`;
      state.screen = "feed";
      redraw();
      try {
        state.feed = (await requireNetwork(account.network).timeline!(account, 40)) ?? [];
        state.feedSource = account.id;
        state.feedCursor = 0;
        toast(state, `${state.feed.length} posts from ${account.id}`, "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "notifications",
    args: "[network]",
    help: "Read mentions and replies",
    async run(state, args, redraw) {
      const spec = args.trim();
      const accounts = spec ? resolveTargets(spec) : selectedAccounts(state);
      const account = accounts.find((entry) => requireNetwork(entry.network).notifications);
      if (!account) throw new Error("None of those accounts can read notifications.");

      state.busy = `Loading ${account.id}…`;
      state.screen = "feed";
      redraw();
      try {
        state.feed = (await requireNetwork(account.network).notifications!(account, 40)) ?? [];
        state.feedSource = `${account.id} notifications`;
        state.feedCursor = 0;
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "delete",
    args: "<account> <post id>",
    help: "Delete a post you made",
    async run(state, args, redraw) {
      const [accountId, postId] = args.trim().split(/\s+/);
      if (!accountId || !postId) throw new Error("Usage: /delete <account> <post id>");
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (!account) throw new Error(`No account "${accountId}".`);
      const network = requireNetwork(account.network);
      if (!network.remove) throw new Error(`${network.name} has no delete API.`);

      state.busy = "Deleting…";
      redraw();
      try {
        await network.remove(account, postId);
        toast(state, `Deleted ${postId} on ${accountId}`, "success");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "set",
    args: "<key> <value>",
    help: "Change a setting, e.g. /set ai.provider ollama",
    run(state, args) {
      const [key, ...rest] = args.trim().split(/\s+/);
      const value = rest.join(" ");
      if (!key) throw new Error("Usage: /set <key> <value>. Keys: ai.provider, ai.model, ai.voice, ai.maxHashtags, signature, threadByDefault, theme, infographic.accent, infographic.style");

      const settings = loadSettings() as unknown as Record<string, unknown>;
      const path = key.split(".");
      let target = settings;
      for (const part of path.slice(0, -1)) {
        if (typeof target[part] !== "object" || target[part] === null) throw new Error(`No setting group "${part}".`);
        target = target[part] as Record<string, unknown>;
      }
      const leaf = path[path.length - 1];
      if (!(leaf in target)) throw new Error(`No setting "${key}".`);

      const current = target[leaf];
      target[leaf] =
        typeof current === "number" ? Number(value) : typeof current === "boolean" ? value === "true" : value;
      saveSettings(settings as never);
      toast(state, `${key} = ${target[leaf]}`, "success");
    },
  },
  {
    name: "clear",
    help: "Empty the compose box and its attachments",
    run(state) {
      state.compose.clear();
      state.title.clear();
      state.media = [];
      state.draftSource = "";
      toast(state, "Cleared", "success");
    },
  },
  {
    name: "stats",
    args: "[count]",
    help: "Fetch engagement for recent posts, then show performance",
    async run(state, args, redraw) {
      const limit = Number(args.trim()) || 25;
      state.screen = "performance";
      state.busy = `Asking the networks about ${limit} recent posts...`;
      redraw();
      try {
        const result = await refreshEngagement({ limit });
        const parts = [`measured ${result.updated}/${result.checked}`];
        if (result.skipped.length) parts.push(`${result.skipped.join(", ")} report none`);
        if (result.errors.length) parts.push(`${result.errors.length} failed`);
        toast(state, parts.join("  ·  "), result.updated ? "success" : "info");
      } finally {
        state.busy = "";
      }
    },
  },
  {
    name: "performance",
    help: "Show post performance",
    run(state) {
      state.screen = "performance";
    },
  },
  {
    name: "save",
    args: "[path]",
    help: "Write an encrypted bundle of accounts, queue and settings",
    run(state, args, redraw) {
      const payload = collect();
      if (!payload.accounts.length) throw new Error("Nothing to save: no accounts are connected.");

      const path = expand(args.trim() || `myna-${new Date().toISOString().slice(0, 10)}.myna`);

      state.prompt = {
        title: "Save a bundle",
        note:
          `${payload.accounts.length} accounts and ${payload.queue.length} queued posts to ${path}. ` +
          "This file will hold a live token for every connected account, so it is encrypted with " +
          "a passphrase you choose here. Anyone with both can post as you.",
        fields: [
          new Field("passphrase", "Passphrase", { secret: true, help: "At least 8 characters." }),
          new Field("again", "Again", { secret: true }),
        ],
        active: 0,
        busy: false,
        log: [],
        submit(values) {
          if (values.passphrase !== values.again) throw new Error("Those did not match.");
          writeFileSync(path, `${JSON.stringify(seal(payload, values.passphrase), null, 2)}\n`, { mode: 0o600 });
          state.prompt = undefined;
          state.mode = "command";
          toast(state, `Wrote ${path} — ${payload.accounts.length} accounts, mode 600`, "success");
        },
      };
      state.mode = "prompt";
      redraw();
    },
  },
  {
    name: "load",
    args: "<path>",
    help: "Merge a bundle from another machine into this one",
    run(state, args, redraw) {
      const path = expand(args.trim());
      if (!path) throw new Error("Which file? Try /load ~/myna.myna");
      if (!existsSync(path)) throw new Error(`No such file: ${path}`);

      const file = JSON.parse(readFileSync(path, "utf8"));

      state.prompt = {
        title: "Load a bundle",
        note: `${describeBundle(file)}. Accounts already connected here are kept, not replaced.`,
        fields: [new Field("passphrase", "Passphrase", { secret: true })],
        active: 0,
        busy: false,
        log: [],
        submit(values) {
          const payload = openBundle(file, values.passphrase);
          const result = applyBundle(payload);
          state.accounts = listAccounts();
          state.prompt = undefined;
          state.mode = "command";
          state.screen = "accounts";
          toast(
            state,
            `Added ${result.accountsAdded.length}, kept ${result.accountsKept.length}, queued ${result.queueAdded}`,
            "success",
          );
        },
      };
      state.mode = "prompt";
      redraw();
    },
  },
  {
    name: "quit",
    help: "Leave myna",
    run(state) {
      state.quit = true;
    },
  },
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
const ALIASES: Record<string, string> = {
  q: "quit",
  exit: "quit",
  "?": "help",
  h: "help",
  p: "post",
  n: "networks",
  a: "accounts",
  ai: "draft",
  write: "draft",
  url: "link",
  info: "infographic",
  graphic: "infographic",
  attach: "media",
  rm: "cancel",
  notifs: "notifications",
  perf: "performance",
  analytics: "performance",
  mentions: "notifications",
};

export function findCommand(name: string): Command | undefined {
  const key = name.toLowerCase();
  return BY_NAME.get(key) ?? BY_NAME.get(ALIASES[key] ?? "");
}

/** Names offered by tab completion and the palette. */
export function completions(prefix: string): string[] {
  const clean = prefix.replace(/^\//, "").toLowerCase();
  return COMMANDS.map((command) => command.name)
    .concat(Object.keys(ALIASES))
    .filter((name) => name.startsWith(clean))
    .sort();
}

/** Parse and run one line from the command bar. */
export async function runCommand(state: State, line: string, redraw: () => void): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Anything not starting with a slash is treated as the post itself.
  if (!trimmed.startsWith("/")) {
    state.compose.set(trimmed);
    state.screen = "compose";
    toast(state, "Put in the compose box — Ctrl+S to post", "info");
    return;
  }

  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = findCommand(name);
  if (!command) {
    const near = completions(name).slice(0, 3);
    throw new Error(`No command /${name}.${near.length ? ` Did you mean ${near.map((entry) => `/${entry}`).join(", ")}?` : " Try /help."}`);
  }
  await command.run(state, rest.join(" "), redraw);
}

/** For the /networks screen. */
export function networkRows(): { id: string; name: string; auth: string; limit: string; blurb: string }[] {
  return NETWORKS.map((network) => ({
    id: network.id,
    name: network.name,
    auth: authSummary(network),
    limit: network.caps.charLimit ? String(network.caps.charLimit) : "—",
    blurb: network.blurb,
  }));
}

export { listQueue, listHistory, SCREENS, type Screen };
