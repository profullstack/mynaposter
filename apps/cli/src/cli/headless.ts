/**
 * The scriptable CLI.
 *
 *   myna login facebook
 *   myna post all "shipping today"
 *   echo "shipping today" | myna post bluesky,mastodon
 *
 * Every subcommand mirrors a TUI slash command, so what you learn in one works
 * in the other. Output is plain text so it pipes; --json gives machine output.
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NETWORKS,
  applyBundle,
  authSummary,
  collect,
  describeBundle,
  openBundle,
  seal,
  availableRasterizers,
  draft,
  enqueue,
  getNetwork,
  infographicCopy,
  infographicHtml,
  listAccounts,
  listHistory,
  listQueue,
  loadAllMedia,
  loadSettings,
  needsPassphrase,
  openBrowser,
  postToAll,
  removeAccount,
  removeQueued,
  renderInfographic,
  requireNetwork,
  resolveTargets,
  saveAccount,
  saveSettings,
  startDaemon,
  runDaemonOnce,
  summarize,
  unlock,
  writerAvailable,
  cloud,
  listEngagement,
  refreshEngagement,
  byNetwork,
  totals,
  topPosts,
  addSeeds,
  removeSeed,
  expandSeeds,
  rankCandidates,
  skipCandidate,
  followBudget,
  followNext,
  followOne,
  graphStatus,
  readGraph,
  clearGraph,
  listPlugins,
  findPluginCommand,
  pluginContext,
  pluginsDir,
  resolvePluginEntry,
  configDir,
  type Account,
  type InfographicStyle,
} from "@profullstack/myna-core";
import { spawnSync } from "node:child_process";
import { ask, askSecret, confirm, readStdin } from "./prompt.ts";
import { parseWhen, describeWhen } from "../tui/when.ts";
import { preparePlugins } from "../plugins.ts";

export interface Flags {
  to?: string;
  title?: string;
  media?: string[];
  json?: boolean;
  yes?: boolean;
  style?: string;
  at?: string;
  thread?: boolean;
  dryRun?: boolean;
  [key: string]: unknown;
}

/** Split `--flag value` and `--bool` out of the positional arguments. */
export function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split("=");
    const name = rawName.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

    if (name === "json" || name === "yes" || name === "thread" || name === "dryRun" || name === "noThread" || name === "force") {
      flags[name === "noThread" ? "thread" : name] = name !== "noThread";
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`--${rawName} needs a value`);
    if (name === "media") (flags.media ??= []).push(value);
    else flags[name] = value;
  }

  return { positional, flags };
}

/** The flags myna itself reads. Anything else belongs to a network. */
const OWN_FLAGS = new Set([
  "to", "title", "media", "json", "yes", "style", "at", "thread", "dryRun", "limit", "output",
  "keepSvg", "server", "overwrite", "settings", "once", "interval", "refresh", "theme", "force", "weight", "source", "network",
]);

/**
 * `--video`, `--subreddit`, `--privacy`: the per-network options each adapter
 * reads out of `extra`. Every flag myna does not recognise is passed through,
 * so an adapter can document a flag without the CLI having to know it exists.
 */
export function extraFrom(flags: Flags): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!OWN_FLAGS.has(key) && typeof value === "string") extra[key] = value;
  }
  return Object.keys(extra).length ? extra : undefined;
}

const out = (line = "") => process.stdout.write(`${line}\n`);

function table(rows: Record<string, string>[], columns: { key: string; title: string }[]): void {
  if (!rows.length) return;
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(row[column.key] ?? "").length)),
  );
  out(columns.map((column, i) => column.title.padEnd(widths[i])).join("  "));
  out(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    out(columns.map((column, i) => String(row[column.key] ?? "").padEnd(widths[i])).join("  "));
  }
}

async function ensureUnlocked(): Promise<void> {
  if (needsPassphrase()) unlock(await askSecret("Vault passphrase"));
}

/**
 * Work out targets and text from `myna post [target] [text]`.
 * "all", a network name and an account id are all valid first positionals, so
 * `myna post all` with piped stdin does what it looks like it does.
 */
async function resolvePostArgs(positional: string[], flags: Flags): Promise<{ accounts: Account[]; text: string }> {
  const words = [...positional];

  const looksLikeTarget = (word: string): boolean =>
    word === "all" ||
    word === "*" ||
    Boolean(getNetwork(word)) ||
    listAccounts().some((account) => account.id === word || account.handle === word);

  // Work out what is a target and what is text before touching stdin, because
  // reading stdin when the text is already on the command line means waiting on
  // a pipe that, outside a terminal, may never close. That hung `myna post` in
  // cron and CI with no output and no clue why.
  let targetSpec = flags.to;
  let needStdin: boolean;

  if (targetSpec) {
    // --to settled the target, so every positional is text.
    needStdin = words.length === 0;
  } else if (words.length === 0) {
    needStdin = true;
  } else if (words.length === 1 && looksLikeTarget(words[0])) {
    // `myna post all` on its own: the one word is the target and the text is
    // being piped in. A bare word that is not a target is the text itself.
    targetSpec = words.shift();
    needStdin = true;
  } else {
    if (looksLikeTarget(words[0])) targetSpec = words.shift();
    needStdin = words.length === 0;
  }

  const piped = needStdin ? await readStdin() : "";
  const text = words.join(" ").trim() || piped;
  if (!text) throw new Error('Nothing to post. Pass the text, or pipe it: echo "hi" | myna post all');

  const accounts = resolveTargets(targetSpec ?? loadSettings().defaultTargets);
  if (!accounts.length) throw new Error("No accounts connected. Run: myna login bluesky");
  return { accounts, text };
}

/** Accounts that can do `cap`, from a target spec, with a message naming the ones that cannot. */
function accountsWith(spec: string, cap: "follow" | "following"): Account[] {
  const accounts = resolveTargets(spec).filter((account) => getNetwork(account.network)?.[cap]);
  if (!accounts.length) {
    throw new Error(
      `No connected account matching "${spec}" can ${cap === "follow" ? "follow" : "read a following list"}. ` +
        `Networks that can: ${NETWORKS.filter((network) => network.caps.follow).map((network) => network.id).join(", ")}.`,
    );
  }
  return accounts;
}

const numberFlag = (flags: Flags, key: string, fallback: number): number => {
  const raw = flags[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} needs a number`);
  return value;
};

export async function runHeadless(command: string, argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv);
  const settings = loadSettings();
  await preparePlugins();

  switch (command) {
    case "login": {
      const id = positional[0];
      if (!id) throw new Error("Which network? Run: myna networks");
      const network = getNetwork(id);
      if (!network) throw new Error(`Unknown network "${id}". Run: myna networks`);
      await ensureUnlocked();

      out(`Connecting ${network.name}.`);
      if (network.auth.note) out(`\n${network.auth.note}\n`);

      const values: Record<string, string> = {};
      for (const field of network.auth.fields) {
        const label = field.optional ? `${field.label} (optional)` : field.label;
        if (field.help) out(`  ${field.help}`);
        values[field.key] = field.secret ? await askSecret(label) : await ask(label, field.default ?? "");
      }

      const partial = await network.login(values, {
        report: (message) => out(`  ${message}`),
        openUrl: async (url) => {
          out(`  ${url}`);
          await openBrowser(url);
        },
        ask: (prompt) => ask(`  ${prompt}`),
      });

      const account: Account = {
        ...partial,
        id: `${network.id}:${partial.handle}`,
        network: network.id,
        addedAt: new Date().toISOString(),
      };
      saveAccount(account);
      out(`\nConnected ${account.id}`);
      return 0;
    }

    case "logout": {
      await ensureUnlocked();
      const id = positional[0];
      if (!id) throw new Error("Which account? Run: myna accounts");
      const matches = listAccounts().filter((account) => account.id === id || account.network === id);
      if (!matches.length) throw new Error(`No account matches "${id}"`);
      for (const account of matches) removeAccount(account.id);
      out(`Disconnected ${matches.map((account) => account.id).join(", ")}`);
      return 0;
    }

    case "accounts": {
      await ensureUnlocked();
      const accounts = listAccounts();
      if (flags.json) {
        out(JSON.stringify(accounts.map(({ creds, ...rest }) => rest), null, 2));
        return 0;
      }
      if (!accounts.length) {
        out("No accounts connected. Run: myna login bluesky");
        return 0;
      }
      table(
        accounts.map((account) => ({
          id: account.id,
          name: account.displayName ?? "",
          network: requireNetwork(account.network).name,
        })),
        [
          { key: "id", title: "ACCOUNT" },
          { key: "name", title: "NAME" },
          { key: "network", title: "NETWORK" },
        ],
      );
      return 0;
    }

    case "networks": {
      if (flags.json) {
        out(JSON.stringify(NETWORKS.map((network) => ({
          id: network.id,
          name: network.name,
          category: network.category,
          auth: network.auth.kind,
          charLimit: network.caps.charLimit,
        })), null, 2));
        return 0;
      }
      table(
        NETWORKS.map((network) => ({
          id: network.id,
          name: network.name,
          login: authSummary(network),
          chars: network.caps.charLimit ? String(network.caps.charLimit) : "-",
          notes: network.blurb,
        })),
        [
          { key: "id", title: "COMMAND" },
          { key: "name", title: "NETWORK" },
          { key: "login", title: "LOGIN" },
          { key: "chars", title: "CHARS" },
          { key: "notes", title: "NOTES" },
        ],
      );
      return 0;
    }

    case "post": {
      await ensureUnlocked();
      const { accounts, text } = await resolvePostArgs(positional, flags);
      const extra = extraFrom(flags);

      if (flags.dryRun) {
        out(`Would post to ${accounts.length} account${accounts.length === 1 ? "" : "s"}:`);
        for (const account of accounts) out(`  ${account.id}`);
        if (extra) out(`with ${Object.entries(extra).map(([key, value]) => `--${key} ${value}`).join(" ")}`);
        out(`\n${text}`);
        return 0;
      }

      const results = await postToAll(accounts, {
        text,
        title: flags.title,
        media: flags.media?.length ? loadAllMedia(flags.media) : undefined,
        thread: flags.thread ?? settings.threadByDefault,
        signature: settings.signature || undefined,
        extra,
      });

      if (flags.json) {
        out(JSON.stringify(
          results.map((result) => ({
            account: result.account.id,
            ok: result.ok,
            url: result.posts[0]?.url,
            id: result.posts[0]?.id,
            error: result.error,
          })),
          null,
          2,
        ));
      } else {
        for (const result of results) {
          out(result.ok ? `ok    ${result.account.id}  ${result.posts[0]?.url ?? result.posts[0]?.id ?? ""}` : `FAIL  ${result.account.id}  ${result.error}`);
        }
        out(`\n${summarize(results)}`);
      }
      return results.every((result) => result.ok) ? 0 : 1;
    }

    case "schedule": {
      await ensureUnlocked();
      const when = flags.at ?? positional[0];
      if (!when) throw new Error('When? Try: myna schedule "in 2h" "the post"');
      const { at, rest } = parseWhen(flags.at ? `${flags.at} ${positional.join(" ")}` : positional.join(" "));
      const text = rest.trim() || (await readStdin());
      if (!text) throw new Error("Nothing to schedule.");
      const accounts = resolveTargets(flags.to ?? settings.defaultTargets);

      const entry = enqueue({
        scheduledFor: at.toISOString(),
        targets: accounts.map((account) => account.id),
        text,
        title: flags.title,
        mediaPaths: flags.media,
        extra: extraFrom(flags),
        thread: flags.thread ?? settings.threadByDefault,
      });
      out(`Queued ${entry.id} for ${describeWhen(at)} to ${accounts.length} account${accounts.length === 1 ? "" : "s"}`);
      return 0;
    }

    case "queue": {
      const posts = listQueue();
      if (flags.json) {
        out(JSON.stringify(posts, null, 2));
        return 0;
      }
      if (!posts.length) {
        out("Nothing scheduled.");
        return 0;
      }
      table(
        posts.map((post) => ({
          id: post.id,
          when: new Date(post.scheduledFor).toLocaleString(),
          status: post.status,
          to: post.targets.length === 1 ? post.targets[0] : `${post.targets.length} accounts`,
          text: post.text.replace(/\s+/g, " ").slice(0, 50),
        })),
        [
          { key: "id", title: "ID" },
          { key: "when", title: "WHEN" },
          { key: "status", title: "STATUS" },
          { key: "to", title: "TO" },
          { key: "text", title: "POST" },
        ],
      );
      return 0;
    }

    case "cancel": {
      const id = positional[0];
      if (!id) throw new Error("Which one? Run: myna queue");
      if (!removeQueued(id)) throw new Error(`No queued post "${id}"`);
      out(`Cancelled ${id}`);
      return 0;
    }

    case "history": {
      const entries = listHistory().slice(0, Number(flags.limit ?? 50));
      if (flags.json) {
        out(JSON.stringify(entries, null, 2));
        return 0;
      }
      table(
        entries.map((entry) => ({
          ok: entry.ok ? "ok" : "FAIL",
          when: new Date(entry.at).toLocaleString(),
          account: entry.accountId,
          detail: (entry.error ?? entry.url ?? entry.text).replace(/\s+/g, " ").slice(0, 60),
        })),
        [
          { key: "ok", title: "" },
          { key: "when", title: "WHEN" },
          { key: "account", title: "ACCOUNT" },
          { key: "detail", title: "DETAIL" },
        ],
      );
      return 0;
    }

    case "draft":
    case "write": {
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);
      const prompt = positional.join(" ") || (await readStdin());
      if (!prompt) throw new Error("Draft what?");
      const drafts = await draft({ prompt, networks: flags.to ? [...new Set(resolveTargets(flags.to).map((a) => a.network))] : [] });
      if (flags.json) {
        out(JSON.stringify(drafts, null, 2));
        return 0;
      }
      for (const entry of drafts) {
        if (entry.network) out(`--- ${entry.network} ---`);
        out(entry.text);
        if (entry.hashtags.length) out(entry.hashtags.join(" "));
        out();
      }
      return 0;
    }

    case "link": {
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);
      const url = positional[0];
      if (!url) throw new Error("Which link?");
      const networks = flags.to ? [...new Set(resolveTargets(flags.to).map((account) => account.network))] : [];
      const drafts = await draft({ url, networks });
      if (flags.json) {
        out(JSON.stringify(drafts, null, 2));
        return 0;
      }
      for (const entry of drafts) {
        if (entry.network) out(`--- ${entry.network} ---`);
        out(entry.hashtags.length ? `${entry.text}\n\n${entry.hashtags.join(" ")}` : entry.text);
        out();
      }
      return 0;
    }

    case "infographic": {
      const check = writerAvailable();
      if (!check.ok) throw new Error(check.reason!);
      if (!availableRasterizers().length) {
        throw new Error("No image renderer found. Install Chrome/Chromium, rsvg-convert, ImageMagick or Inkscape, or set CHROME_PATH.");
      }
      const input = positional.join(" ");
      const style = (flags.style ?? "svg") as InfographicStyle;
      const copy = await infographicCopy(/^https?:\/\//.test(input) ? { url: input } : { prompt: input });
      const html = style === "html" ? await infographicHtml(copy, 1200, 1200) : undefined;
      const result = await renderInfographic(copy, style, {}, html);

      const path = (flags.output as string) ?? join(mkdtempSync(join(tmpdir(), "myna-graphic-")), "infographic.png");
      writeFileSync(path, result.png);
      if (result.svg && flags.keepSvg) writeFileSync(path.replace(/\.png$/, ".svg"), result.svg);

      if (flags.json) {
        out(JSON.stringify({ path, copy }, null, 2));
        return 0;
      }
      out(`Wrote ${path}`);
      out(`\n${copy.caption}${copy.hashtags.length ? `\n\n${copy.hashtags.join(" ")}` : ""}`);
      out(`\nPost it with:  myna post ${flags.to ?? "all"} --media ${path} "${copy.caption.replace(/"/g, "'")}"`);
      return 0;
    }

    case "feed": {
      await ensureUnlocked();
      const accounts = resolveTargets(positional[0] ?? flags.to ?? settings.defaultTargets);
      const account = accounts.find((entry) => requireNetwork(entry.network).timeline);
      if (!account) throw new Error("None of those accounts can read a timeline.");
      const items = (await requireNetwork(account.network).timeline!(account, Number(flags.limit ?? 20))) ?? [];
      if (flags.json) {
        out(JSON.stringify(items, null, 2));
        return 0;
      }
      for (const item of items) {
        out(`${item.handle || item.author}  ${new Date(item.createdAt).toLocaleString()}`);
        out(item.text.replace(/\n/g, "\n  "));
        if (item.url) out(item.url);
        out();
      }
      return 0;
    }

    case "search": {
      // Find something to reply to: `myna search youtube "terminal social media"`.
      // Each result's id is what --video (or the network's equivalent) takes.
      await ensureUnlocked();
      const words = [...positional];
      let spec = flags.to;
      if (!spec && words.length > 1 && (getNetwork(words[0]) || listAccounts().some((account) => account.id === words[0]))) {
        spec = words.shift();
      }
      const query = words.join(" ").trim();
      if (!query) throw new Error('Search for what? Try: myna search youtube "terminal social media"');

      const account = resolveTargets(spec ?? settings.defaultTargets).find((entry) => requireNetwork(entry.network).search);
      if (!account) throw new Error("None of those accounts can search. Try: myna search youtube <query>");
      const items = await requireNetwork(account.network).search!(account, query, Number(flags.limit ?? 10));

      if (flags.json) {
        out(JSON.stringify({ account: account.id, items }, null, 2));
        return 0;
      }
      if (!items.length) {
        out(`Nothing on ${account.id} matches "${query}".`);
        return 0;
      }
      for (const item of items) {
        out(`${item.id}  ${item.handle || item.author}  ${new Date(item.createdAt).toLocaleDateString()}`);
        out(`  ${item.text.split("\n")[0]}`);
        if (item.url) out(`  ${item.url}`);
        out();
      }
      if (account.network === "youtube") out(`Comment on one with:  myna post ${account.id} "your comment" --video <id>`);
      return 0;
    }

    case "delete": {
      await ensureUnlocked();
      const [accountId, postId] = positional;
      if (!accountId || !postId) throw new Error("Usage: myna delete <account> <post id>");
      const account = listAccounts().find((entry) => entry.id === accountId);
      if (!account) throw new Error(`No account "${accountId}"`);
      const network = requireNetwork(account.network);
      if (!network.remove) throw new Error(`${network.name} has no delete API.`);
      await network.remove(account, postId);
      out(`Deleted ${postId} on ${accountId}`);
      return 0;
    }

    case "repost": {
      // Share someone else's post from one of your accounts: a retweet, a
      // boost, a Bluesky repost. Takes the URL as copied from the network.
      await ensureUnlocked();
      const [accountId, ref] = positional;
      if (!accountId || !ref) throw new Error("Usage: myna repost <account> <post url or id>");
      const account = listAccounts().find((entry) => entry.id === accountId);
      if (!account) throw new Error(`No account "${accountId}"`);
      const network = requireNetwork(account.network);
      if (!network.repost) throw new Error(`${network.name} has no repost API.`);
      const result = await network.repost(account, ref);
      out(`Reposted from ${accountId}${result.url ? `  ${result.url}` : ""}`);
      return 0;
    }

    case "run": {
      // The daemon, for a systemd unit or a container: due posts, the follow
      // graph when it is on, and every plugin's tasks and seed providers.
      await ensureUnlocked();
      const log = (line: string) => out(`${new Date().toISOString()}  ${line}`);
      if (flags.once) {
        const lines = await runDaemonOnce({ log });
        if (!lines.length) out("Nothing was due.");
        return 0;
      }
      const jobs = settings.graph.enabled ? "posts, follow graph" : "posts";
      const extras = listPlugins().filter((entry) => entry.plugin?.tasks?.length || entry.plugin?.seeds?.length).map((entry) => entry.plugin!.id);
      out(`Daemon running: ${[jobs, ...extras].join(", ")}. Ctrl+C to stop.`);
      if (!settings.graph.enabled) out("The follow graph is off. Turn it on with: myna graph on");
      startDaemon({ tickMs: Number(flags.interval ?? 30) * 1000, log });
      await new Promise(() => {});
      return 0;
    }

    case "follow": {
      // myna follow <account|network> <handle...>
      await ensureUnlocked();
      const [spec, ...handles] = positional;
      if (!spec || !handles.length) throw new Error("Usage: myna follow <account or network> <handle> [more handles]");
      const accounts = accountsWith(spec, "follow");
      let failed = 0;
      for (const account of accounts) {
        for (const handle of handles) {
          const record = await followOne(account, handle);
          if (record.ok) out(`${account.id}  followed ${handle}`);
          else {
            failed++;
            out(`${account.id}  could not follow ${handle}: ${record.error}`);
          }
        }
      }
      return failed ? 1 : 0;
    }

    case "following": {
      // myna following <account|network> [handle] — who they follow, or who you follow.
      await ensureUnlocked();
      const [spec, handle] = positional;
      if (!spec) throw new Error("Usage: myna following <account or network> [handle] [--limit N]");
      const account = accountsWith(spec, "following")[0];
      const network = requireNetwork(account.network);
      const limit = numberFlag(flags, "limit", 50);
      const profiles = await network.following!(account, handle ?? account.handle, limit);
      if (flags.json) {
        out(JSON.stringify(profiles, null, 2));
        return 0;
      }
      out(`${handle ?? account.handle} follows ${profiles.length}${profiles.length >= limit ? "+" : ""} on ${network.name}:`);
      for (const profile of profiles) {
        out(`  ${profile.handle.padEnd(36)} ${profile.displayName ?? ""}${profile.followers !== undefined ? `  (${profile.followers} followers)` : ""}`);
      }
      return 0;
    }

    case "graph": {
      const [sub = "status", ...rest] = positional;
      switch (sub) {
        case "status": {
          const status = graphStatus();
          out(`enabled     ${settings.graph.enabled ? "yes" : "no  (myna graph on)"}`);
          out(`seeds       ${status.seeds} (${status.seedsExpanded} read)`);
          out(`candidates  ${status.candidates} (${status.ready} ready to follow)`);
          out(`followed    ${status.followed}${status.failed ? ` (${status.failed} failed)` : ""}${status.lastFollowAt ? `, last ${status.lastFollowAt}` : ""}`);
          out(`limits      ${settings.graph.followsPerHour}/hour, ${settings.graph.followsPerDay}/day per account, ${settings.graph.minSeeds}+ seeds, networks: ${settings.graph.networks}`);
          try {
            for (const account of listAccounts().filter((account) => getNetwork(account.network)?.follow)) {
              out(`  ${account.id.padEnd(40)} budget ${followBudget(account.id, settings)} more this hour`);
            }
          } catch {
            /* locked vault: the numbers above are still useful */
          }
          return 0;
        }
        case "on":
        case "off": {
          settings.graph.enabled = sub === "on";
          saveSettings(settings);
          out(`Follow graph ${sub}. ${sub === "on" ? "It runs inside `myna run`." : ""}`.trim());
          return 0;
        }
        case "seeds": {
          const graph = readGraph();
          if (flags.json) {
            out(JSON.stringify(graph.seeds, null, 2));
            return 0;
          }
          if (!graph.seeds.length) {
            out("No seeds. Add one with: myna graph seed bluesky alice.bsky.social");
            return 0;
          }
          table(
            graph.seeds.map((seed) => ({
              network: seed.network,
              handle: seed.handle,
              weight: String(seed.weight),
              source: seed.source,
              read: seed.error ? `failed: ${seed.error.slice(0, 40)}` : seed.expandedAt ? seed.expandedAt.slice(0, 16) : "not yet",
            })),
            [
              { key: "network", title: "Network" },
              { key: "handle", title: "Handle" },
              { key: "weight", title: "Weight" },
              { key: "source", title: "Source" },
              { key: "read", title: "Read" },
            ],
          );
          return 0;
        }
        case "seed": {
          const [network, ...handles] = rest;
          if (!network || !handles.length) throw new Error("Usage: myna graph seed <network> <handle> [more handles] [--weight N]");
          requireNetwork(network);
          const weight = numberFlag(flags, "weight", 1);
          const result = addSeeds(handles.map((handle) => ({ network, handle, weight, source: String(flags.source ?? "manual") })));
          out(`${result.added} seed${result.added === 1 ? "" : "s"} added, ${result.updated} updated.`);
          return 0;
        }
        case "unseed": {
          const [network, handle] = rest;
          if (!network || !handle) throw new Error("Usage: myna graph unseed <network> <handle>");
          out(removeSeed(network, handle) ? `Removed ${handle}.` : `${handle} was not a seed.`);
          return 0;
        }
        case "expand": {
          await ensureUnlocked();
          const only = rest.length >= 2 ? [{ network: rest[0], handle: rest[1] }] : undefined;
          const result = await expandSeeds({
            only,
            perSeed: flags.limit !== undefined ? numberFlag(flags, "limit", settings.graph.perSeed) : undefined,
            staleMs: flags.force ? 0 : undefined,
            log: (line) => out(`  ${line}`),
          });
          out(`Read ${result.expanded} seed${result.expanded === 1 ? "" : "s"}, ${result.discovered} new candidate${result.discovered === 1 ? "" : "s"}.`);
          for (const failure of result.failed) out(`  ${failure.seed.network}:${failure.seed.handle} failed: ${failure.error}`);
          for (const seed of result.unreadable) out(`  ${seed.network}:${seed.handle} skipped: no connected ${seed.network} account can read a following list`);
          if (!result.expanded && !result.failed.length && !result.unreadable.length) out("  Every seed was read recently. Use --force to read them again.");
          return 0;
        }
        case "candidates": {
          const ranked = rankCandidates({ network: flags.network as string | undefined, fresh: !flags.force });
          const limit = numberFlag(flags, "limit", 30);
          if (flags.json) {
            out(JSON.stringify(ranked.slice(0, limit), null, 2));
            return 0;
          }
          if (!ranked.length) {
            out("No candidates yet. Add seeds, then: myna graph expand");
            return 0;
          }
          out(`${ranked.length} ready to follow, best first:`);
          for (const candidate of ranked.slice(0, limit)) {
            out(
              `  ${String(candidate.score).padStart(5)}  ${candidate.seeds}${candidate.via.includes("seed") ? "*" : " "}  ` +
                `${candidate.network}:${candidate.handle}`.padEnd(48) +
                ` ${candidate.displayName ?? ""}${candidate.followers !== undefined ? `  (${candidate.followers})` : ""}`,
            );
          }
          out("  score  seeds (* is a seed itself)  who");
          return 0;
        }
        case "skip": {
          const [network, handle] = rest;
          if (!network || !handle) throw new Error("Usage: myna graph skip <network> <handle>");
          out(skipCandidate(network, handle) ? `Will never follow ${handle}.` : `${handle} is not a candidate.`);
          return 0;
        }
        case "follow": {
          await ensureUnlocked();
          const limit = numberFlag(flags, "limit", 5);
          const sent = await followNext({
            limit,
            dryRun: flags.dryRun,
            ignoreBudget: Boolean(flags.force),
            networks: flags.network ? [String(flags.network)] : undefined,
            log: (line) => out(`  ${line}`),
          });
          const ok = sent.filter((record) => record.ok).length;
          if (!sent.length) out("Nothing followed: no candidates within budget. See: myna graph status");
          else out(`${flags.dryRun ? "Would follow" : "Followed"} ${ok} of ${sent.length}.`);
          return 0;
        }
        case "clear": {
          if (!flags.yes && !(await confirm("Forget every seed, candidate and the follow ledger?"))) return 1;
          clearGraph();
          out("Graph cleared.");
          return 0;
        }
        default:
          throw new Error(`Unknown graph command "${sub}". Try: status, on, off, seeds, seed, unseed, expand, candidates, skip, follow, clear`);
      }
    }

    case "plugins": {
      const [sub = "list", spec] = positional;
      switch (sub) {
        case "list": {
          const entries = listPlugins();
          if (flags.json) {
            out(JSON.stringify(entries.map((entry) => ({ ...entry, plugin: entry.plugin && { ...entry.plugin, networks: entry.plugin.networks?.map((n) => n.id) } })), null, 2));
            return 0;
          }
          if (!entries.length) out("No plugins loaded.");
          for (const entry of entries) {
            if (!entry.plugin) {
              out(`${entry.origin}  FAILED: ${entry.error}`);
              continue;
            }
            const plugin = entry.plugin;
            const parts = [
              plugin.networks?.length ? `networks: ${plugin.networks.map((network) => network.id).join(", ")}` : "",
              plugin.commands?.length ? `commands: ${plugin.commands.map((command) => command.name).join(", ")}` : "",
              plugin.tasks?.length ? `tasks: ${plugin.tasks.length}` : "",
              plugin.seeds?.length ? `seed sources: ${plugin.seeds.length}` : "",
            ].filter(Boolean);
            out(`${plugin.id} ${plugin.version ?? ""}  ${plugin.name}  [${entry.origin}]`);
            if (plugin.description) out(`  ${plugin.description}`);
            if (parts.length) out(`  ${parts.join("; ")}`);
            for (const command of plugin.commands ?? []) for (const usage of command.usage ?? []) out(`    myna ${usage}`);
          }
          out(`\nInstall more: myna plugins add <package or path>   (into ${pluginsDir()})`);
          return 0;
        }
        case "add": {
          if (!spec) throw new Error("Usage: myna plugins add <npm package or path>");
          const isPath = /^(\.|\/|~|[A-Za-z]:)/.test(spec) || existsSync(spec);
          let record: string;
          if (isPath) {
            if (!resolvePluginEntry(spec)) throw new Error(`${spec} has no entry module (package.json main, index.ts or index.js).`);
            record = resolve(spec);
          } else {
            // A package name. npm and bun both install into a directory of
            // our choosing; whichever is on this machine will do.
            const name = spec.replace(/@[^/@]+$/, "");
            if (!resolvePluginEntry(name)) {
              const dir = pluginsDir();
              const tool = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0 ? "npm" : "bun";
              out(`Installing ${spec} with ${tool} into ${dir}...`);
              mkdirSync(dir, { recursive: true });
              if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{ "name": "myna-plugins", "private": true }\n');
              const args = tool === "npm" ? ["install", "--prefix", dir, "--no-fund", "--no-audit", spec] : ["add", "--cwd", dir, spec];
              const result = spawnSync(tool, args, { encoding: "utf8", cwd: dir });
              if (result.status !== 0) throw new Error(`${tool} failed: ${(result.stderr || result.stdout).trim().slice(-400)}`);
              if (!resolvePluginEntry(name)) throw new Error(`Installed, but ${name} has no entry module (package.json main, or index.js).`);
            }
            record = name;
          }
          if (!settings.plugins.includes(record)) {
            settings.plugins.push(record);
            saveSettings(settings);
          }
          out(`Added ${record}. Run \`myna plugins\` to see what it brought.`);
          return 0;
        }
        case "remove": {
          if (!spec) throw new Error("Usage: myna plugins remove <package, path or id>");
          const before = settings.plugins.length;
          const target = listPlugins().find((entry) => entry.plugin?.id === spec)?.origin ?? spec;
          settings.plugins = settings.plugins.filter((entry) => entry !== spec && entry !== target);
          if (settings.plugins.length === before) {
            if (target === "bundled") throw new Error(`${spec} is built into myna and cannot be removed.`);
            throw new Error(`No plugin "${spec}" is configured. Installed packages under ${pluginsDir()} load on their own; uninstall with npm there.`);
          }
          saveSettings(settings);
          out(`Removed ${spec}.`);
          return 0;
        }
        default:
          throw new Error(`Unknown plugins command "${sub}". Try: list, add, remove`);
      }
    }

    case "config": {
      const [key, ...rest] = positional;
      if (!key) {
        out(JSON.stringify(settings, null, 2));
        return 0;
      }
      const value = rest.join(" ");
      const store = settings as unknown as Record<string, unknown>;
      const path = key.split(".");
      let target = store;
      for (const part of path.slice(0, -1)) {
        if (typeof target[part] !== "object" || target[part] === null) throw new Error(`No setting group "${part}"`);
        target = target[part] as Record<string, unknown>;
      }
      const leaf = path[path.length - 1];
      if (!(leaf in target)) throw new Error(`No setting "${key}"`);
      if (!value) {
        out(String(target[leaf]));
        return 0;
      }
      const current = target[leaf];
      target[leaf] = typeof current === "number" ? Number(value) : typeof current === "boolean" ? value === "true" : value;
      saveSettings(store as never);
      out(`${key} = ${target[leaf]}`);
      return 0;
    }

    case "save": {
      await ensureUnlocked();
      const path = positional[0] ?? `myna-${new Date().toISOString().slice(0, 10)}.myna`;
      const payload = collect();
      if (!payload.accounts.length) throw new Error("Nothing to save: no accounts are connected.");

      out("This file will contain a live token for every connected account.");
      out("Anyone who has it and the passphrase can post as you.");
      out("");
      const passphrase =
        process.env.MYNA_BUNDLE_PASSPHRASE ?? (await askSecret("Passphrase for this bundle"));
      if (!process.env.MYNA_BUNDLE_PASSPHRASE) {
        const again = await askSecret("Again");
        if (again !== passphrase) throw new Error("Those did not match.");
      }

      writeFileSync(path, `${JSON.stringify(seal(payload, passphrase), null, 2)}\n`, { mode: 0o600 });
      out("");
      out(`Wrote ${path} (mode 600)`);
      out(`  ${payload.accounts.length} accounts, ${payload.queue.length} queued`);
      out("");
      out(`Load it elsewhere with:  myna load ${path}`);
      return 0;
    }

    case "load": {
      await ensureUnlocked();
      const path = positional[0];
      if (!path) throw new Error("Which file? Usage: myna load <bundle.myna>");
      if (!existsSync(path)) throw new Error(`No such file: ${path}`);

      const file = JSON.parse(readFileSync(path, "utf8"));
      out(describeBundle(file));
      out("");

      const passphrase =
        process.env.MYNA_BUNDLE_PASSPHRASE ?? (await askSecret("Passphrase"));
      const payload = openBundle(file, passphrase);

      // Show the effect before causing it, since this writes credentials.
      const preview = applyBundle(payload, { overwrite: Boolean(flags.overwrite), settings: Boolean(flags.settings), dryRun: true });
      out(`  add ${preview.accountsAdded.length} account(s)${preview.accountsAdded.length ? `: ${preview.accountsAdded.join(", ")}` : ""}`);
      if (preview.accountsReplaced.length) out(`  replace ${preview.accountsReplaced.length}: ${preview.accountsReplaced.join(", ")}`);
      if (preview.accountsKept.length) out(`  keep ${preview.accountsKept.length} already here (use --overwrite to replace): ${preview.accountsKept.join(", ")}`);
      out(`  queue ${preview.queueAdded} scheduled post(s)`);
      if (preview.settingsApplied) out("  take the bundle's settings");

      if (flags.dryRun) return 0;
      if (!flags.yes && !(await confirm("\nApply this?"))) {
        out("Nothing changed.");
        return 0;
      }

      const result = applyBundle(payload, { overwrite: Boolean(flags.overwrite), settings: Boolean(flags.settings) });
      out("");
      out(`Added ${result.accountsAdded.length}, replaced ${result.accountsReplaced.length}, kept ${result.accountsKept.length}, queued ${result.queueAdded}.`);
      return 0;
    }

    case "cloud": {
      const sub = positional[0] ?? "status";
      const server = flags.server as string | undefined;

      switch (sub) {
        case "signup":
        case "login": {
          const email = positional[1] ?? (await ask("Email"));
          const password = await askSecret("Password");
          if (sub === "signup") {
            const again = await askSecret("Again");
            if (again !== password) throw new Error("Those did not match.");
          }
          const created = sub === "signup"
            ? await cloud.signup(email, password, server)
            : await cloud.login(email, password, server);
          out(`Signed in as ${created.email} on ${created.server}`);
          out("");
          out("Backups are encrypted here before they are uploaded, with a passphrase");
          out("that never leaves this machine. Push one with:  myna cloud push");
          return 0;
        }

        case "logout":
          await cloud.logout();
          out("Signed out. The local vault is untouched.");
          return 0;

        case "push": {
          await ensureUnlocked();
          const payload = collect();
          if (!payload.accounts.length) throw new Error("Nothing to back up: no accounts are connected.");

          const passphrase =
            process.env.MYNA_BUNDLE_PASSPHRASE ?? (await askSecret("Passphrase to encrypt this backup"));
          if (!process.env.MYNA_BUNDLE_PASSPHRASE) {
            const again = await askSecret("Again");
            if (again !== passphrase) throw new Error("Those did not match.");
          }

          const saved = await cloud.push(seal(payload, passphrase));
          out(`Pushed ${(saved.bytes / 1024).toFixed(1)} KB — ${payload.accounts.length} accounts, ${payload.queue.length} queued.`);
          out("The server holds ciphertext it cannot read.");
          return 0;
        }

        case "pull": {
          await ensureUnlocked();
          const file = await cloud.pull();
          out(describeBundle(file));
          out("");
          const passphrase = process.env.MYNA_BUNDLE_PASSPHRASE ?? (await askSecret("Passphrase"));
          const payload = openBundle(file, passphrase);

          const preview = applyBundle(payload, { overwrite: Boolean(flags.overwrite), dryRun: true });
          out(`  add ${preview.accountsAdded.length}${preview.accountsAdded.length ? `: ${preview.accountsAdded.join(", ")}` : ""}`);
          if (preview.accountsKept.length) out(`  keep ${preview.accountsKept.length} already here (--overwrite to replace)`);
          out(`  queue ${preview.queueAdded}`);

          if (flags.dryRun) return 0;
          if (!flags.yes && !(await confirm("\nApply this?"))) {
            out("Nothing changed.");
            return 0;
          }
          const result = applyBundle(payload, { overwrite: Boolean(flags.overwrite) });
          out(`Added ${result.accountsAdded.length}, kept ${result.accountsKept.length}, queued ${result.queueAdded}.`);
          return 0;
        }

        case "forget":
          if (!flags.yes && !(await confirm("Delete the stored backup from the server?"))) return 0;
          out(await cloud.forget() ? "Deleted." : "There was nothing stored.");
          return 0;

        case "status": {
          const current = cloud.session();
          if (!current) {
            out("Not signed in. Cloud backup is optional; myna works fully without it.");
            out("");
            out("  myna cloud signup <email>");
            out("  myna cloud login <email>");
            return 0;
          }
          const remote = await cloud.status();
          out(`${remote.email} on ${current.server}`);
          if (remote.backup) {
            const meta = remote.backup.meta;
            out(`  backup: ${(remote.backup.bytes / 1024).toFixed(1)} KB, updated ${new Date(remote.backup.updatedAt).toLocaleString()}`);
            if (meta) out(`  contents: ${meta.accounts} accounts, ${meta.queue} queued, saved by ${meta.savedBy}`);
          } else {
            out("  no backup stored yet — myna cloud push");
          }
          return 0;
        }

        default:
          throw new Error(`Unknown: myna cloud ${sub}. Try signup, login, logout, push, pull, status or forget.`);
      }
    }

    case "stats": {
      await ensureUnlocked();
      const history = listHistory();

      if (flags.refresh !== undefined || positional[0] === "refresh") {
        const result = await refreshEngagement({ limit: Number(flags.limit ?? 25) });
        out(`Measured ${result.updated} of ${result.checked} posts.`);
        if (result.skipped.length) out(`  ${result.skipped.join(", ")} report no engagement.`);
        for (const error of result.errors.slice(0, 5)) out(`  ${error}`);
      }

      const engagement = listEngagement();
      const summary = totals(history, engagement);

      if (flags.json) {
        out(JSON.stringify({ totals: summary, networks: byNetwork(history, engagement), top: topPosts(history, engagement, 10) }, null, 2));
        return 0;
      }

      if (!history.length) {
        out("Nothing posted yet, so there is nothing to measure.");
        return 0;
      }

      out(`${summary.sent} sent, ${summary.failed} failed across ${summary.networks} network(s)` +
        (summary.rate === null ? "" : ` — ${Math.round(summary.rate * 100)}% delivered`));
      out(summary.measured
        ? `${summary.likes} likes, ${summary.reposts} reposts, ${summary.replies} replies over ${summary.measured} measured post(s)`
        : "No engagement measured yet. Run: myna stats refresh");
      out("");

      table(
        byNetwork(history, engagement).map((row) => ({
          network: row.network,
          sent: String(row.sent),
          failed: String(row.failed),
          rate: row.rate === null ? "-" : `${Math.round(row.rate * 100)}%`,
          likes: String(row.likes),
          reposts: String(row.reposts),
        })),
        [
          { key: "network", title: "NETWORK" },
          { key: "sent", title: "SENT" },
          { key: "failed", title: "FAILED" },
          { key: "rate", title: "RATE" },
          { key: "likes", title: "LIKES" },
          { key: "reposts", title: "REPOSTS" },
        ],
      );

      const best = topPosts(history, engagement, 5);
      if (best.length) {
        out("");
        out("Best posts:");
        for (const post of best) {
          out(`  ${String(post.total).padStart(5)}  ${post.accountId}  ${post.text.replace(/\s+/g, " ").slice(0, 50)}`);
        }
      }
      return 0;
    }

    case "doctor": {
      out(`config      ${configDir()}`);
      out(`networks    ${NETWORKS.length}`);
      const plugins = listPlugins();
      out(`plugins     ${plugins.filter((entry) => entry.plugin).map((entry) => entry.plugin!.id).join(", ") || "none"}${plugins.some((entry) => entry.error) ? ` (${plugins.filter((entry) => entry.error).length} failed to load; see myna plugins)` : ""}`);
      out(`graph       ${settings.graph.enabled ? "on" : "off"}, ${graphStatus().seeds} seeds`);
      let accountCount = "locked";
      try {
        accountCount = String(listAccounts().length);
      } catch {
        /* vault needs a passphrase */
      }
      out(`accounts    ${accountCount}`);
      out(`ai          ${settings.ai.provider} / ${settings.ai.model} ${writerAvailable().ok ? "(ready)" : `(${writerAvailable().reason})`}`);
      out(`rasterizer  ${availableRasterizers().join(", ") || "none found"}`);
      return 0;
    }

    default: {
      const found = findPluginCommand(command);
      if (!found) throw new Error(`Unknown command "${command}". Run: myna help`);
      // A plugin command may need the vault (its secrets live there) and a
      // person to ask; both come through the context rather than imports.
      await ensureUnlocked();
      const ctx = pluginContext(found.plugin, {
        out,
        ask: (prompt, options) => (options?.secret ? askSecret(prompt) : ask(prompt)),
        flags,
      });
      const code = await found.command.run(positional, ctx);
      return typeof code === "number" ? code : 0;
    }
  }
}
