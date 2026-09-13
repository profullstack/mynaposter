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
  runAfterSchedule,
  runAfterCancel,
  type HookOutcome,
  getNetwork,
  getDirectory,
  listDirectories,
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
  postPaced,
  runEvergreen,
  buildRecap,
  renderRecapText,
  runRecap,
  loadRecapState,
  DEFAULT_EVERGREEN,
  getAccount,
  removeAccount,
  removeQueued,
  renderInfographic,
  requireNetwork,
  resolveTargets,
  saveAccount,
  saveSettings,
  startDaemon,
  runDaemonOnce,
  checkForUpdate,
  selfUpdate,
  daemonHint,
  isNewer,
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
  followAllFollowing,
  followsListRef,
  graphStatus,
  readGraph,
  clearGraph,
  listPlugins,
  findPluginCommand,
  pluginContext,
  pluginsDir,
  resolvePluginEntry,
  configDir,
  ensureAccountSkill,
  ensureNetworkSkill,
  defaultTypeFor,
  type Account,
  type InfographicStyle,
} from "@profullstack/myna-core";
import { spawnSync } from "node:child_process";
import { ask, askSecret, confirm, readStdin } from "./prompt.ts";
import { out, table } from "./io.ts";
import { runDirectory } from "./directory.ts";
import { runSkill } from "./skill.ts";
import { runProfile, runReshareCommand } from "./reshare.ts";
import { runAtproto } from "./atproto.ts";
import { runEngage } from "./engage.ts";
import { runDid } from "./did.ts";
import { runContacts, runEmail, runSms, runSmtp } from "./outreach.ts";
import { parseWhen, describeWhen, parseDuration } from "../tui/when.ts";
import { loginValuesFromArgs } from "../login-args.ts";

/** A duration in ms, or the fallback's, or undefined when neither reads. */
function parseDurationOr(value: string, fallback: string): number | undefined {
  return parseDuration(value) ?? (fallback ? parseDuration(fallback) : undefined);
}
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

    // Boolean flags take no value. `--now`, `--off` and `--no-open` are as
    // much switches as `--json`; without them here the parser eats the next
    // argument, so `myna post all "hi" --now` died asking for a value.
    const BOOLS = new Set([
      "json", "yes", "thread", "dryRun", "noThread", "force", "now", "off", "on", "noOpen", "front", "skipQueue", "send", "check", "noAi", "allowDuplicate",
      // follow, followers, graph expand and outreachgraph push
      "outreachgraph", "followers", "allFollowing", "allFollowers", "both",
    ]);
    if (BOOLS.has(name)) {
      flags[name === "noThread" ? "thread" : name] = name !== "noThread";
      continue;
    }
    // `--type` takes a value on `post` and stands alone on `skill show <slug>
    // --type`, so it is a switch when nothing follows it.
    if (name === "type" && inlineValue === undefined && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) {
      flags.type = true;
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
  "now", "gap", "drip", "repost", "every", "cooldown", "off", "on", "port", "open", "noOpen",
  "days", "send", "command", "check", "version", "allowDuplicate", "from", "type",
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

/**
 * `--now` and `--allow-duplicate` ride on the queue entry as extras, so the
 * daemon honours them when the entry's turn comes.
 */
function markExtra(extra: Record<string, string> | undefined, flags: Flags): Record<string, string> | undefined {
  const marks: Record<string, string> = {};
  if (flags.now) marks.now = "true";
  if (flags.allowDuplicate) marks.allowDuplicate = "true";
  if (!Object.keys(marks).length) return extra;
  return { ...extra, ...marks };
}

// `out` and `table` live in ./io.ts so that a command in its own file can
// print identically without importing this module back.

/** One line per plugin that reacted to a post, a schedule or a cancel. */
function printHooks(hooks: HookOutcome[]): void {
  for (const hook of hooks) {
    if (hook.error) out(`FAIL  ${hook.plugin}  ${hook.error}`);
    else if (hook.line) out(`ok    ${hook.plugin}  ${hook.line}`);
  }
}

async function ensureUnlocked(): Promise<void> {
  if (needsPassphrase()) unlock(await askSecret("Vault passphrase"));
}

/**
 * "saasrow is not a network" is true and useless on its own.
 *
 * A directory is deliberately not in the network registry — that separation is
 * what keeps one out of `--to all` — but somebody who has read about SaaSRow
 * will reach for `myna login saasrow` and `myna networks` first, and both of
 * those are a dead end unless they say where the thing actually lives.
 */
function directoryHint(id: string): string | undefined {
  const directory = getDirectory(id);
  if (!directory) return undefined;
  return (
    `${directory.name} is a directory, not a network: it lists the product itself rather than posting about it.\n` +
    `Connect it with:  myna directory login ${directory.id}\n` +
    `Then submit with: myna directory ${directory.id} <url>`
  );
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
function accountsWith(spec: string, cap: "follow" | "following" | "followers"): Account[] {
  const accounts = resolveTargets(spec).filter((account) => getNetwork(account.network)?.[cap]);
  if (!accounts.length) {
    throw new Error(
      `No connected account matching "${spec}" can ${cap === "follow" ? "follow" : cap === "followers" ? "read a followers list" : "read a following list"}. ` +
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
      if (!network) throw new Error(directoryHint(id) ?? `Unknown network "${id}". Run: myna networks`);
      await ensureUnlocked();

      const given = loginValuesFromArgs(network, positional.slice(1), flags);
      const interactive = Boolean(process.stdin.isTTY);

      out(`Connecting ${network.name}.`);
      if (network.auth.note) out(`\n${network.auth.note}`);
      if (network.auth.docsUrl) out(`Get the values here: ${network.auth.docsUrl}`);
      out("");

      const values: Record<string, string> = {};
      for (const field of network.auth.fields) {
        // A value on the command line answers the question, so do not ask it
        // again. This is what makes `myna login tsbb https://bbs.hqtui.com/
        // --forum app-showcase` a single non-interactive command.
        const supplied = given[field.key];
        if (supplied) {
          values[field.key] = supplied;
          out(`  ${field.label}: ${field.secret ? "•".repeat(8) : supplied}`);
          continue;
        }
        if (!interactive) {
          // Nothing can be typed, so a missing required field has to say which
          // flag would have filled it rather than hang on a prompt nobody sees.
          if (!field.optional) {
            throw new Error(
              `${network.id} needs ${field.label} and stdin is not a terminal. ` +
                `Pass it: myna login ${network.id} --${field.key} <value>`,
            );
          }
          values[field.key] = field.default ?? "";
          continue;
        }
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
        // Only offer to ask when there is somebody to answer. An adapter that
        // asks a follow-up question mid-login (tsbb picks its forums that way)
        // must not stall a scripted login on a prompt nothing will ever type.
        ask: interactive ? (prompt) => ask(`  ${prompt}`) : undefined,
      });

      const account: Account = {
        ...partial,
        id: `${network.id}:${partial.handle}`,
        network: network.id,
        addedAt: new Date().toISOString(),
      };
      saveAccount(account);
      out(`\nConnected ${account.id}`);
      // The rules for this account, written once so they can be read and
      // edited. An existing file is never touched.
      try {
        ensureNetworkSkill(network.id);
        const skill = ensureAccountSkill(account);
        out(`${skill.written ? "Wrote" : "Skill at"} ${skill.path}`);
      } catch (error) {
        out(`Could not write the skill file: ${(error as Error).message}`);
      }
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

    case "update": {
      // No vault here on purpose: replacing a binary has nothing to do with
      // credentials, and asking for a passphrase to run an update is a good way
      // to make people skip updates.
      if (flags.check) {
        const check = await checkForUpdate();
        if (flags.json) {
          out(JSON.stringify(check, null, 2));
          return check.newer ? 1 : 0;
        }
        out(
          check.newer
            ? `myna ${check.latest} is out. You are on ${check.current}.\n${check.url}\n\nInstall it:  myna update`
            : `myna ${check.current} is the latest.`,
        );
        // A check is a question, and "yes there is an update" is the answer a
        // script wants to branch on.
        return check.newer ? 1 : 0;
      }

      const result = await selfUpdate({
        version: typeof flags.version === "string" ? flags.version : undefined,
        force: Boolean(flags.force),
        report: (line) => out(`  ${line}`),
      });
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      if (!result.installed) {
        out(result.reason ?? `Nothing to do. You are on ${result.current}.`);
        return 0;
      }
      // "Updated" would be a lie about `--version 0.13.1`, which is a
      // deliberate downgrade and worth naming as one.
      const verb = isNewer(result.latest, result.current) ? "Updated" : "Installed";
      out(`\n${verb} myna ${result.current} → ${result.latest}`);
      out(result.url);
      const hint = daemonHint();
      if (hint) out(`\n${hint}`);
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
      // Directories are not networks and never appear above. Say so here, or
      // the only way to find out is to run `myna login saasrow` and be told no.
      const directories = listDirectories();
      if (directories.length) {
        out("");
        out(
          `Directories are separate, because a listing is the product rather than a post: ` +
            `${directories.map((entry) => entry.id).join(", ")}. Run: myna directory`,
        );
      }
      return 0;
    }

    case "directory":
    case "dir": {
      await ensureUnlocked();
      return await runDirectory(positional, flags);
    }

    case "skill":
    case "skills": {
      await ensureUnlocked();
      return await runSkill(positional, flags);
    }

    case "profile": {
      await ensureUnlocked();
      return await runProfile(positional, flags);
    }

    case "reshare": {
      await ensureUnlocked();
      return await runReshareCommand(positional, flags);
    }

    case "atproto":
    case "at": {
      return await runAtproto(positional, flags);
    }

    case "engage":
    case "followup":
    case "followups": {
      await ensureUnlocked();
      return await runEngage(positional, flags);
    }

    case "did": {
      await ensureUnlocked();
      return await runDid(positional, flags, { openUrl: openBrowser });
    }

    case "smtp": {
      await ensureUnlocked();
      return await runSmtp(positional, flags);
    }

    case "sms": {
      await ensureUnlocked();
      return await runSms(positional, flags);
    }

    case "contacts":
    case "contact": {
      await ensureUnlocked();
      return await runContacts(positional, flags);
    }

    case "email":
    case "mail": {
      await ensureUnlocked();
      return await runEmail(positional, flags);
    }

    case "post": {
      await ensureUnlocked();
      const { accounts, text } = await resolvePostArgs(positional, flags);
      // `--at` is myna's own flag for `schedule`; on a post it is handed to the
      // network, since a calendar entry needs a time.
      const extra = flags.at ? { ...extraFrom(flags), at: flags.at } : extraFrom(flags);

      if (flags.dryRun) {
        out(`Would post to ${accounts.length} account${accounts.length === 1 ? "" : "s"} as a ${typeof flags.type === "string" ? flags.type : defaultTypeFor(accounts)}:`);
        for (const account of accounts) out(`  ${account.id}`);
        if (extra) out(`with ${Object.entries(extra).map(([key, value]) => `--${key} ${value}`).join(" ")}`);
        out(`\n${text}`);
        return 0;
      }

      // Paced: the first free account goes now, the rest are queued along
      // the drip and past each network's gap. --now sends everything at once.
      const paced = await postPaced(accounts, {
        text,
        title: flags.title,
        media: flags.media?.length ? loadAllMedia(flags.media) : undefined,
        thread: flags.thread ?? settings.threadByDefault,
        signature: settings.signature || undefined,
        extra: markExtra(extra, flags),
        allowDuplicate: Boolean(flags.allowDuplicate),
        type: typeof flags.type === "string" ? flags.type : undefined,
      }, { force: Boolean(flags.now), front: Boolean(flags.front || flags.skipQueue), mediaPaths: flags.media });
      const results = paced.results;

      if (flags.json) {
        out(JSON.stringify({
          results: results.map((result) => ({
            account: result.account.id,
            ok: result.ok,
            url: result.posts[0]?.url,
            id: result.posts[0]?.id,
            error: result.error,
          })),
          queued: paced.queued.map((entry) => ({ id: entry.id, account: entry.targets[0], at: entry.scheduledFor })),
          skipped: paced.skipped.map((entry) => ({ account: entry.account.id, reason: entry.reason })),
          reflowed: paced.reflowed.map((move) => ({ id: move.id, from: new Date(move.from).toISOString(), to: new Date(move.to).toISOString() })),
          hooks: [...results.hooks, ...paced.scheduleHooks],
        }, null, 2));
      } else {
        for (const result of results) {
          out(result.ok ? `ok    ${result.account.id}  ${result.posts[0]?.url ?? result.posts[0]?.id ?? ""}` : `FAIL  ${result.account.id}  ${result.error}`);
        }
        for (const entry of paced.queued) {
          const reason = paced.plan.later.find((t) => t.account.id === entry.targets[0])?.reason;
          out(`queue ${entry.targets[0]}  ${describeWhen(new Date(entry.scheduledFor))}${reason ? `  (${reason})` : ""}  [${entry.id}]`);
        }
        for (const entry of paced.skipped) out(`skip  ${entry.account.id}  ${entry.reason}`);
        // Being pushed back is not a failure, but it happened to someone
        // else's post, so it is never silent.
        for (const move of paced.reflowed) {
          out(`moved ${move.id}  ${describeWhen(new Date(move.from))} -> ${describeWhen(new Date(move.to))}  (made room for --front)`);
        }
        // What plugins did with the post once it was out: an ad, a note.
        printHooks([...results.hooks, ...paced.scheduleHooks]);
        const line = [results.length ? summarize(results) : "nothing sent yet"];
        if (paced.queued.length) line.push(`${paced.queued.length} queued for the daemon (myna queue)`);
        if (paced.skipped.length) line.push(`${paced.skipped.length} skipped as a repeat`);
        out(`\n${line.join(" — ")}`);
        if (paced.queued.length && !flags.now) {
          const window = flags.front || flags.skipQueue ? settings.pacing.minGap : settings.pacing.drip;
          out(`Pacing: one post per network per ${settings.pacing.minGap}, spread over ${window}.`);
          // --front is the answer to a long queue; --now is the answer to the
          // gates. Offering only --now is what makes people reach for it.
          if (!flags.front && !flags.skipQueue) out(`Pass --front to take the next free slot ahead of the queue, or --now to send everything at once.`);
        }
      }
      return results.every((result) => result.ok) ? 0 : 1;
    }

    case "pace": {
      // myna pace                     show the pacing rules
      // myna pace --gap 4h --drip 48h --repost 7d
      const next = { ...settings.pacing };
      let changed = false;
      for (const key of ["gap", "drip", "repost"] as const) {
        const value = flags[key];
        if (typeof value !== "string") continue;
        if (parseDurationOr(value, "") === undefined) throw new Error(`--${key} wants a duration like 4h, 48h or 7d, not "${value}".`);
        const field = key === "gap" ? "minGap" : key === "repost" ? "repostGap" : "drip";
        next[field] = value;
        changed = true;
      }
      if (changed) saveSettings({ ...settings, pacing: next });
      out(`gap     ${next.minGap}   least time between two posts on the same network`);
      out(`drip    ${next.drip}  a post to several accounts is spread over this window`);
      out(`repost  ${next.repostGap}   the same text to the same account waits this long`);
      if (!changed) {
        out("\nChange one: myna pace --gap 4h --drip 48h --repost 7d.");
        out("Jump the queue but keep the gaps: myna post --front. Skip the gates outright: myna post --now.");
      }
      return 0;
    }

    case "evergreen": {
      // myna evergreen <blog account> [--to all] [--every 7d] [--cooldown 30d] [--ad true|false]
      // myna evergreen --off
      // myna evergreen                 status, and one turn now if due
      await ensureUnlocked();
      const cfg = { ...settings.evergreen };
      let changed = false;
      if (flags.off) { cfg.enabled = false; changed = true; }
      if (positional[0]) {
        const account = getAccount(positional[0]);
        if (!account) throw new Error(`${positional[0]} is not a connected account. Run: myna accounts`);
        if (!getNetwork(account.network)?.timeline) throw new Error(`${account.network} cannot list its own pages, so there is nothing to re-post.`);
        cfg.from = account.id;
        cfg.enabled = true;
        changed = true;
      }
      if (typeof flags.to === "string") { cfg.to = flags.to; changed = true; }
      if (typeof flags.every === "string") { if (parseDurationOr(flags.every, "") === undefined) throw new Error("--every wants a duration like 7d."); cfg.every = flags.every; changed = true; }
      if (typeof flags.cooldown === "string") { if (parseDurationOr(flags.cooldown, "") === undefined) throw new Error("--cooldown wants a duration like 30d."); cfg.cooldown = flags.cooldown; changed = true; }
      if (typeof flags.ad === "string") { cfg.ad = flags.ad !== "false"; changed = true; }
      if (changed) saveSettings({ ...settings, evergreen: cfg });
      out(`evergreen  ${cfg.enabled ? "on" : "off"}${cfg.from ? `  from ${cfg.from}` : ""}  every ${cfg.every}  to ${cfg.to}  ad ${cfg.ad ? "on" : "off"}  cooldown ${cfg.cooldown}`);
      if (!cfg.enabled) {
        out("Turn it on with: myna evergreen <blog account>   e.g. myna evergreen htmlblog:dev.profullstack.com/~anthony/blog");
        return 0;
      }
      const turn = await runEvergreen({ log: out });
      if (turn.idle) out(turn.idle);
      else if (turn.page && turn.outcome) {
        out(`picked ${turn.page.url}`);
        for (const entry of turn.outcome.queued) out(`queue ${entry.targets[0]}  ${describeWhen(new Date(entry.scheduledFor))}  [${entry.id}]`);
        for (const result of turn.outcome.results) out(result.ok ? `ok    ${result.account.id}  ${result.posts[0]?.url ?? ""}` : `FAIL  ${result.account.id}  ${result.error}`);
      }
      out("The daemon (myna run) keeps this going; see myna queue.");
      return 0;
    }

    case "recap": {
      // myna recap                     print the last 24 hours and the next
      // myna recap --days 2            a wider window, both ways
      // myna recap --send              send it now, whether or not it is due
      // myna recap on --to me@x.com [--at 08:00]
      // myna recap off
      //
      // Deliberately no vault: the recap reads history and the queue, both
      // plain JSON, so it works from cron with nobody there to type a
      // passphrase. That is the whole point of a morning email.
      const cfg = { ...settings.recap };
      const action = positional[0];
      let changed = false;

      if (action === "on" || action === "off") {
        cfg.enabled = action === "on";
        changed = true;
      }
      if (typeof flags.to === "string") { cfg.to = flags.to; changed = true; }
      if (typeof flags.at === "string") {
        if (!/^\d{1,2}:\d{2}$/.test(flags.at)) throw new Error("--at wants a time of day like 08:00.");
        cfg.at = flags.at;
        changed = true;
      }
      if (typeof flags.command === "string") { cfg.command = flags.command; changed = true; }
      if (cfg.enabled && !cfg.to) throw new Error("Where to? Try: myna recap on --to you@example.com");
      if (changed) saveSettings({ ...settings, recap: cfg });

      if (action === "status" || action === "on" || action === "off") {
        const state = loadRecapState();
        out(`recap  ${cfg.enabled ? "on" : "off"}${cfg.to ? `  to ${cfg.to}` : ""}  at ${cfg.at}  via ${cfg.command}`);
        out(state.lastSentAt ? `last sent ${describeWhen(new Date(state.lastSentAt))}` : "never sent");
        if (cfg.enabled) out("The daemon (myna run) sends it; myna recap --send sends one now.");
        return 0;
      }

      const days = Number(flags.days ?? 1);
      if (!Number.isFinite(days) || days <= 0) throw new Error("--days wants a positive number.");
      const recap = buildRecap({ windowMs: days * 24 * 3_600_000 });

      if (flags.json) {
        out(JSON.stringify(recap, null, 2));
        return 0;
      }

      if (flags.send) {
        // Through runRecap rather than sendRecap, so a hand-sent recap stamps
        // the day and the daemon does not follow it with an identical one.
        const turn = await runRecap(cfg, { force: true, windowMs: days * 24 * 3_600_000 });
        const result = turn.result!;
        out(result.sent ? `Sent "${result.subject}" to ${cfg.to}.` : `Not sent: ${result.error}`);
        return result.sent ? 0 : 1;
      }

      out(renderRecapText(recap));
      return 0;
    }

    case "schedule": {
      await ensureUnlocked();
      const when = flags.at ?? positional[0];
      if (!when) throw new Error('When? Try: myna schedule "in 2h" "the post"');
      const { at, rest } = parseWhen(flags.at ? `${flags.at} ${positional.join(" ")}` : positional.join(" "));
      const text = rest.trim() || (await readStdin());
      if (!text) throw new Error("Nothing to schedule.");
      const accounts = resolveTargets(flags.to ?? settings.defaultTargets);

      // Scheduled posts are paced from their own time: the first account at
      // `at`, the rest dripped after it, each past its network's gap.
      const paced = await postPaced(accounts, {
        text,
        title: flags.title,
        thread: flags.thread ?? settings.threadByDefault,
        extra: markExtra(extraFrom(flags), flags),
        allowDuplicate: Boolean(flags.allowDuplicate),
        type: typeof flags.type === "string" ? flags.type : undefined,
      }, { from: Math.max(at.getTime(), Date.now() + 1), force: Boolean(flags.now), mediaPaths: flags.media });
      for (const entry of paced.queued) {
        out(`Queued ${entry.id} for ${describeWhen(new Date(entry.scheduledFor))} to ${entry.targets[0]}`);
      }
      for (const entry of paced.skipped) out(`skip  ${entry.account.id}  ${entry.reason}`);
      // What plugins did with the entries: a calendar event, a reminder.
      printHooks(paced.scheduleHooks);
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
          type: post.type ?? "",
          text: post.text.replace(/\s+/g, " ").slice(0, 50),
        })),
        [
          { key: "id", title: "ID" },
          { key: "when", title: "WHEN" },
          { key: "status", title: "STATUS" },
          { key: "to", title: "TO" },
          { key: "type", title: "TYPE" },
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
      printHooks(await runAfterCancel(id));
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
          skill: entry.skill ?? "",
          type: entry.type ?? "",
          detail: (entry.error ?? entry.url ?? entry.text).replace(/\s+/g, " ").slice(0, 60),
        })),
        [
          { key: "ok", title: "" },
          { key: "when", title: "WHEN" },
          { key: "account", title: "ACCOUNT" },
          { key: "skill", title: "SKILL" },
          { key: "type", title: "TYPE" },
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
      if (!accountId || !ref) throw new Error("Usage: myna repost <account> <post url or id> [--at <when>]");
      const account = listAccounts().find((entry) => entry.id === accountId);
      if (!account) throw new Error(`No account "${accountId}"`);
      const network = requireNetwork(account.network);
      if (!network.repost) throw new Error(`${network.name} has no repost API.`);

      // `--at` queues it instead. Two accounts sharing each other's posts
      // want a delay between them, or both timelines show the same thing at
      // the same minute and neither reaches anybody the other did not.
      if (typeof flags.at === "string") {
        const { at } = parseWhen(flags.at);
        const entry = enqueue({
          scheduledFor: at.toISOString(),
          targets: [account.id],
          // What the queue prints. The send reads repostOf and composes nothing.
          text: `repost ${ref}`,
          repostOf: ref,
        });
        out(`Queued repost ${entry.id} from ${accountId} for ${describeWhen(at)}`);
        printHooks(await runAfterSchedule(entry));
        return 0;
      }

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
      if (!settings.graph.enabled) out("The follow graph is off. Turn it on with: myna graph on");
      const stop = startDaemon({
        tickMs: Number(flags.interval ?? 30) * 1000,
        log,
        // The daemon knows what it registered; printing a second list here
        // meant every new job was invisible until somebody updated the line.
        onReady: (ids) => out(`Daemon running: ${ids.join(", ")}. Ctrl+C to stop.`),
      });
      // The daemon's own timer is unref'd so a host that embeds it can exit
      // freely; here the process *is* the daemon, and with no TTY on stdin
      // (systemd, a container) nothing else keeps the event loop alive. Hold
      // a referenced timer until a signal says stop.
      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => {}, 60_000);
        const quit = (signal: string) => {
          log(`${signal}, stopping`);
          stop();
          clearInterval(keepAlive);
          resolve();
        };
        process.once("SIGINT", () => quit("SIGINT"));
        process.once("SIGTERM", () => quit("SIGTERM"));
      });
      return 0;
    }

    case "follow": {
      // myna follow <account|network> <handle...>
      // myna follow <account> https://bsky.app/profile/x/follows   everyone x follows
      await ensureUnlocked();
      const [spec, ...handles] = positional;
      if (!spec || !handles.length) throw new Error("Usage: myna follow <account or network> <handle> [more handles]");
      const accounts = accountsWith(spec, "follow");
      let failed = 0;

      // A pasted "follows" or "followers" page, or --all-following /
      // --all-followers: copy their list, on the graph's pace. Four hundred
      // people become a few an hour, not a burst. --outreachgraph hands each
      // person to OutreachGraph as well (the plugin's afterFollow reads it).
      const wantFollowers = Boolean(flags.allFollowers || flags.followers);
      const lists = handles.filter((handle) => followsListRef(handle).all || flags.allFollowing || wantFollowers);
      if (lists.length) {
        for (const account of accounts) {
          for (const ref of lists) {
            const direction = followsListRef(ref).direction ?? (wantFollowers ? "followers" : "following");
            const result = await followAllFollowing({
              account,
              ref,
              direction,
              limit: numberFlag(flags, "limit", 25),
              dryRun: Boolean(flags.dryRun),
              ignoreBudget: Boolean(flags.force),
              hookFlags: flags,
              log: (line) => out(`  ${line}`),
            });
            const ok = result.followed.filter((record) => record.ok).length;
            failed += result.followed.length - ok;
            out(
              `${account.id}  ${followsListRef(ref).profile} ${direction === "followers" ? "is followed by" : "follows"} ${result.read}: ` +
                `${flags.dryRun ? "would follow" : "followed"} ${ok}, skipped ${result.skipped.length}${result.remaining ? `, ${result.remaining} left for next time (run it again)` : ""}`,
            );
          }
        }
        if (lists.length === handles.length) return failed ? 1 : 0;
        handles.splice(0, handles.length, ...handles.filter((handle) => !lists.includes(handle)));
      }
      for (const account of accounts) {
        for (const handle of handles) {
          const record = await followOne(account, handle, handle, { source: "manual", flags, log: (line) => out(`  ${line}`) });
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

    case "followers": {
      // myna followers <account|network> [handle] — who follows them, or who follows you.
      await ensureUnlocked();
      const [spec, handle] = positional;
      if (!spec) throw new Error("Usage: myna followers <account or network> [handle] [--limit N]");
      const account = accountsWith(spec, "followers")[0];
      const network = requireNetwork(account.network);
      const limit = numberFlag(flags, "limit", 50);
      const profiles = await network.followers!(account, handle ?? account.handle, limit);
      if (flags.json) {
        out(JSON.stringify(profiles, null, 2));
        return 0;
      }
      out(`${handle ?? account.handle} is followed by ${profiles.length}${profiles.length >= limit ? "+" : ""} on ${network.name}:`);
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
          out(`reads       ${settings.graph.expand}${settings.graph.expand !== "following" ? ` (a follower counts ${settings.graph.followerWeight} of a follow)` : ""}`);
          out(`outreachgraph ${settings.graph.outreachgraph ? "every follow is handed over for assessment" : "off  (myna config graph.outreachgraph true)"}`);
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
            direction: flags.both ? "both" : flags.followers ? "followers" : undefined,
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
            hookFlags: flags,
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
      // Settings that are absent until set, so `in` cannot vouch for them.
      const OPTIONAL_NUMBERS = new Set(["blog.maxPerDay"]);
      if (!(leaf in target) && !OPTIONAL_NUMBERS.has(key)) throw new Error(`No setting "${key}"`);
      if (!value) {
        out(String(target[leaf]));
        return 0;
      }
      const current = target[leaf];
      target[leaf] =
        typeof current === "number" || OPTIONAL_NUMBERS.has(key) ? Number(value) : typeof current === "boolean" ? value === "true" : value;
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
