/**
 * `myna upvote`: find other people posting about what you post about, and amplify them.
 *
 *   myna upvote                      the queue: whose post, why it matched, what myna will do
 *   myna upvote on | off             let the daemon scan and act on its own
 *   myna upvote scan                 search now and queue what is worth amplifying
 *   myna upvote send [--limit N] [--dry-run] [--network reddit]
 *   myna upvote topics               what myna thinks you are about, and what it searches for
 *   myna upvote skip <id>            drop one before it goes
 *   myna upvote edit <id> "text"     change a drafted reply before it goes
 *   myna upvote set <key> <value>
 *   myna upvote log [--limit N]      what was cast
 *
 * Nothing is cast in the same breath it is found. A scan queues; a send works
 * through what is due, one per account per gap, inside the daily cap.
 */
import {
  DEFAULT_UPVOTE,
  clearUpvotes,
  listAccounts,
  listUpvotes,
  loadSettings,
  manualOnly,
  queriesFor,
  runUpvotes,
  saveSettings,
  scanUpvotes,
  topicIndex,
  listHistory,
  updateUpvote,
  writerAvailable,
  getNetwork,
  type UpvoteSettings,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");

const num = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** One queued action, as a person reads it. */
function show(item: ReturnType<typeof listUpvotes>[number]): void {
  const what = item.action === "reply" ? "reply + vote" : item.action === "repost" ? "share + vote" : "vote";
  out(`  ${item.id}  ${when(item.dueAt)}  ${item.accountId}  ${what}  ${item.handle}  (${item.score})`);
  if (item.matched.length) out(`      matched: ${item.matched.join(", ")}`);
  out(`      their post: ${item.postText.replace(/\s+/g, " ").slice(0, 110)}`);
  if (item.postUrl) out(`      ${item.postUrl}`);
  if (item.reply) out(`      reply: ${item.reply.replace(/\s+/g, " ")}`);
}

export async function runUpvote(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();

  switch (sub ?? "status") {
    case "status": {
      const items = listUpvotes();
      const pending = items.filter((item) => item.status === "pending");
      const able = listAccounts().filter((account) => {
        const network = getNetwork(account.network);
        return Boolean(network?.caps.search && (network?.caps.upvote || network?.caps.repost));
      });
      const manual = manualOnly(settings.upvote);
      out(
        `The upvoter is ${settings.upvote.enabled ? "on: the daemon searches every 30 minutes and casts what is due" : "off (myna upvote on)"}.`,
      );
      out(`  ${able.length} account${able.length === 1 ? "" : "s"} can find and cast: ${able.map((account) => account.id).join(", ") || "none"}`);
      if (manual.size) out(`  manual only: ${[...manual].join(", ")} — queued but never cast without myna upvote send --network <id>`);
      const writer = writerAvailable();
      out(`  writer: ${writer.ok ? "ready" : `not available (${writer.reason}); no link is ever dropped without it`}`);
      out(
        `  limits: ${settings.upvote.maxPerDay}/day per account, ${settings.upvote.gapMinutes} min apart, ` +
          `one per author per ${settings.upvote.cooldownDays} days`,
      );
      out(
        `  match: at least ${settings.upvote.minScore} to vote, ${settings.upvote.linkMinScore} to carry a link; ` +
          `posts newer than ${settings.upvote.maxAgeHours}h`,
      );
      out(
        `  mix: ${Math.round(settings.upvote.repostRatio * 100)}% also shared, ` +
          `${Math.round(settings.upvote.linkRatio * 100)}% also replied to with a link (at most ${settings.upvote.linkPerDay}/day)`,
      );
      out("");
      if (!pending.length) {
        out("Nothing queued. myna upvote scan searches now.");
        return 0;
      }
      out(`${pending.length} queued:`);
      for (const item of pending.sort((a, b) => a.dueAt.localeCompare(b.dueAt))) show(item);
      return 0;
    }

    case "on":
    case "off": {
      settings.upvote.enabled = sub === "on";
      saveSettings(settings);
      out(
        sub === "on"
          ? "The upvoter is on. The daemon searches every 30 minutes and casts what is due, inside the caps."
          : "The upvoter is off. Nothing queued will be cast.",
      );
      return 0;
    }

    case "topics": {
      const index = topicIndex(listHistory(), { days: settings.upvote.topicDays });
      if (!index.topics.length) {
        out(`Nothing posted in the last ${settings.upvote.topicDays} days, so myna has no idea what you are about yet.`);
        return 0;
      }
      out(`What you have been about, from ${settings.upvote.topicDays} days of your own posts:`);
      for (const topic of index.topics.slice(0, 20)) {
        out(`  ${topic.weight.toFixed(2).padStart(6)}  ${topic.term}${topic.posts > 1 ? `  (${topic.posts} posts)` : ""}`);
      }
      out("");
      out("Searched for, strongest first:");
      for (const query of queriesFor(index, settings.upvote.queriesPerScan)) out(`  ${query}`);
      return 0;
    }

    case "scan": {
      const result = await scanUpvotes({ log: (line) => out(line) });
      for (const line of result.skipped) out(`  ${line}`);
      if (result.queries.length) out(`Searched: ${result.queries.join(", ")}`);
      out(`Read ${result.read} posts, queued ${result.queued.length}.`);
      for (const item of result.queued) show(item);
      return 0;
    }

    case "send":
    case "run": {
      const networks = String(flags.network ?? flags.networks ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await runUpvotes({
        log: (line) => out(line),
        limit: flags.limit ? num(flags.limit, 0) : undefined,
        dryRun: Boolean(flags["dry-run"] ?? flags.dryRun),
        ...(networks.length ? { networks } : {}),
      });
      for (const line of [...new Set(result.held)]) out(`  held: ${line}`);
      out(`${result.done.length} cast${flags["dry-run"] || flags.dryRun ? " (rehearsal, nothing sent)" : ""}.`);
      return 0;
    }

    case "skip": {
      const id = rest[0];
      if (!id) {
        out("Which one? myna upvote skip <id>");
        return 1;
      }
      const item = updateUpvote(id, { status: "skipped", reason: "skipped by hand" });
      out(item ? `Dropped ${id}.` : `No queued action called ${id}.`);
      return item ? 0 : 1;
    }

    case "edit": {
      const [id, ...words] = rest;
      const text = words.join(" ").trim();
      if (!id || !text) {
        out('Which one, and what should it say? myna upvote edit <id> "…"');
        return 1;
      }
      const item = updateUpvote(id, { reply: text, drafted: "template", action: "reply" });
      out(item ? `Changed the reply on ${id}.` : `No queued action called ${id}.`);
      return item ? 0 : 1;
    }

    case "clear": {
      clearUpvotes();
      out("Cleared the queue, everything seen, and every author cooldown.");
      return 0;
    }

    case "log": {
      const limit = num(flags.limit, 20);
      const done = listUpvotes()
        .filter((item) => item.status !== "pending")
        .slice(-limit);
      if (!done.length) {
        out("Nothing cast yet.");
        return 0;
      }
      for (const item of done) {
        const mark = item.status === "done" ? "ok" : item.status;
        out(
          `  ${when(item.doneAt ?? item.createdAt)}  ${mark.padEnd(7)}  ${item.accountId}  ${item.action}  ${item.handle}` +
            `${item.result?.already ? " (already)" : ""}`,
        );
        if (item.error) out(`      ${item.error}`);
        if (item.reason) out(`      ${item.reason}`);
        if (item.link) out(`      dropped: ${item.link}`);
      }
      return 0;
    }

    case "set": {
      const [key, ...values] = rest;
      const value = values.join(" ").trim();
      if (!key || !value) {
        out(`myna upvote set <key> <value>. Keys: ${Object.keys(DEFAULT_UPVOTE).join(", ")}`);
        return 1;
      }
      if (!(key in DEFAULT_UPVOTE)) {
        out(`No such setting: ${key}. Keys: ${Object.keys(DEFAULT_UPVOTE).join(", ")}`);
        return 1;
      }
      const current = DEFAULT_UPVOTE[key as keyof UpvoteSettings];
      const parsed =
        typeof current === "number"
          ? num(value, Number.NaN)
          : typeof current === "boolean"
            ? value === "true" || value === "on" || value === "yes"
            : value;
      if (typeof current === "number" && !Number.isFinite(parsed as number)) {
        out(`${key} is a number.`);
        return 1;
      }
      (settings.upvote as unknown as Record<string, unknown>)[key] = parsed;
      saveSettings(settings);
      out(`${key} is now ${String(parsed)}.`);
      return 0;
    }

    default: {
      out(`No such thing as myna upvote ${sub}. Try: status, on, off, scan, send, topics, skip, edit, set, log, clear`);
      return 1;
    }
  }
}
