/**
 * `myna engage`: follow-ups for the people who engaged with your posts.
 *
 *   myna engage                      the queue: who, what they did, the drafted reply, follow or not
 *   myna engage on | off             let the daemon scan and send
 *   myna engage scan                 read notifications now, draft replies, queue them
 *   myna engage send [--limit N] [--dry-run]
 *   myna engage skip <id>            drop one before it goes
 *   myna engage edit <id> "text"     change the reply before it goes
 *   myna engage set <key> <value>
 *   myna engage log [--limit N]      what went out
 *
 * Nothing is sent in the same breath it was noticed. A scan queues; a send
 * works through what is due, one per account per gap, inside the daily cap.
 */
import {
  DEFAULT_ENGAGE,
  listAccounts,
  listFollowUps,
  loadSettings,
  saveSettings,
  scanEngagement,
  sendFollowUps,
  updateFollowUp,
  writerAvailable,
  type EngageSettings,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");

export async function runEngage(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();

  switch (sub ?? "status") {
    case "status": {
      const items = listFollowUps();
      const pending = items.filter((item) => item.status === "pending");
      const able = listAccounts().filter((account) => {
        const network = account.network;
        return ["bluesky", "mastodon", "misskey", "pixelfed"].includes(network);
      });
      out(`Follow-ups are ${settings.engage.enabled ? "on: the daemon scans every 15 minutes and sends what is due" : "off (myna engage on)"}.`);
      out(`  ${able.length} account${able.length === 1 ? "" : "s"} can read notifications: ${able.map((account) => account.id).join(", ") || "none"}`);
      const writer = writerAvailable();
      out(`  writer: ${writer.ok ? "ready" : `not available (${writer.reason}); replies fall back to a plain thank-you`}`);
      out(`  limits: ${settings.engage.maxPerDay}/day per account, ${settings.engage.gapMinutes} min apart, one per person per ${settings.engage.cooldownDays} days`);
      out(`  follow back ${settings.engage.followBack ? "on" : "off"}, reply to mentions ${settings.engage.replyToMentions ? "on" : "off"}, thank reposts ${settings.engage.thankReposts ? "on" : "off"}, follow likers ${settings.engage.followLikers ? "on" : "off"}`);
      out("");
      if (!pending.length) {
        out("Nothing queued. myna engage scan reads notifications now.");
        return 0;
      }
      out(`${pending.length} queued:`);
      for (const item of pending.sort((a, b) => a.dueAt.localeCompare(b.dueAt))) {
        out(`  ${item.id}  ${when(item.dueAt)}  ${item.accountId}  ${item.kind} from ${item.handle}${item.follow ? "  +follow" : ""}`);
        if (item.theirText) out(`      they said: ${item.theirText.replace(/\s+/g, " ").slice(0, 100)}`);
        if (item.reply) out(`      reply${item.drafted === "template" ? " (template)" : ""}: ${item.reply}`);
      }
      out("");
      out("myna engage send sends what is due; skip <id> drops one; edit <id> \"...\" changes a reply.");
      return 0;
    }

    case "on":
    case "off": {
      settings.engage = { ...settings.engage, enabled: sub === "on" };
      saveSettings(settings);
      out(sub === "on" ? "On. myna run scans every 15 minutes and sends what is due every 5." : "Off. The queue is kept; nothing more is sent.");
      if (sub === "on" && !writerAvailable().ok) out(`The writer is not available (${writerAvailable().reason}), so replies are a plain thank-you until it is.`);
      return 0;
    }

    case "scan": {
      const result = await scanEngagement({ log: (line) => out(line) });
      out(`Read ${result.read} notification${result.read === 1 ? "" : "s"}, queued ${result.queued.length}.`);
      for (const line of result.skipped) out(`  skipped ${line}`);
      if (result.queued.length) out("myna engage shows them; myna engage send sends what is due.");
      return 0;
    }

    case "send": {
      const result = await sendFollowUps({
        log: (line) => out(line),
        dryRun: Boolean(flags.dryRun),
        ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
      });
      out(`${flags.dryRun ? "Would send" : "Sent"} ${result.sent.length}.`);
      for (const line of result.held) out(`  held ${line}`);
      return 0;
    }

    case "skip": {
      const id = rest[0];
      if (!id) throw new Error("Usage: myna engage skip <id>");
      const item = updateFollowUp(id, { status: "skipped" });
      if (!item) throw new Error(`No follow-up ${id}.`);
      out(`Skipped ${id} (${item.kind} from ${item.handle}).`);
      return 0;
    }

    case "edit": {
      const [id, ...words] = rest;
      const text = words.join(" ").trim();
      if (!id || !text) throw new Error('Usage: myna engage edit <id> "the reply"');
      const item = updateFollowUp(id, { reply: text, drafted: undefined });
      if (!item) throw new Error(`No follow-up ${id}.`);
      out(`Reply for ${id} is now: ${text}`);
      return 0;
    }

    case "set": {
      const [key, ...valueParts] = rest;
      const raw = valueParts.join(" ");
      if (!key || !(key in DEFAULT_ENGAGE) || key === "enabled") {
        throw new Error(`Usage: myna engage set <${Object.keys(DEFAULT_ENGAGE).filter((name) => name !== "enabled").join("|")}> <value>`);
      }
      const field = key as keyof EngageSettings;
      const current = settings.engage[field];
      let value: string | number | boolean;
      if (typeof current === "boolean") {
        if (!/^(on|off|true|false|yes|no|1|0)$/i.test(raw)) throw new Error(`${key} is on or off.`);
        value = /^(on|true|yes|1)$/i.test(raw);
      } else if (typeof current === "number") {
        value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${key} is a number, 0 or more.`);
      } else value = raw;
      settings.engage = { ...settings.engage, [field]: value } as EngageSettings;
      saveSettings(settings);
      out(`engage.${key} = ${String(value)}`);
      return 0;
    }

    case "log": {
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 30;
      const done = listFollowUps()
        .filter((item) => item.status !== "pending")
        .sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt))
        .slice(0, limit);
      if (!done.length) {
        out("Nothing sent yet.");
        return 0;
      }
      for (const item of done) {
        const what = [
          item.result?.replyUrl ?? (item.result?.replyId ? "replied" : ""),
          item.result?.followed ? "followed" : item.result?.alreadyFollowed ? "already following" : "",
        ]
          .filter(Boolean)
          .join(", ");
        out(`${when(item.sentAt ?? item.createdAt)}  ${item.status.padEnd(7)}  ${item.accountId}  ${item.kind} from ${item.handle}  ${what}${item.error ? `  ${item.error}` : ""}`);
      }
      return 0;
    }

    default:
      throw new Error(`Unknown: myna engage ${sub}. Try status, on, off, scan, send, skip, edit, set or log.`);
  }
}
