/**
 * The daily recap: one email a day saying what myna said, and what it is
 * about to say.
 *
 * This replaced mirroring the queue into a calendar. An event per queued
 * post is technically accurate and practically unreadable: a week of drip
 * pacing buries the appointments you actually have to keep. A recap is the
 * same information at the cadence a person can act on — once, in the
 * morning, in a place that is already a list of things to read.
 *
 * Everything that decides what the mail says is a pure function of history,
 * the queue and a clock, so the wording can be tested without a mailbox.
 * Only `sendRecap` touches the outside world.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HistoryEntry } from "../store/history.ts";
import { listHistory } from "../store/history.ts";
import type { QueuedPost } from "../store/queue.ts";
import { listQueue } from "../store/queue.ts";
import { listHandoffs, type Handoff } from "../store/handoffs.ts";
import { readJson, writeJson } from "../util/json.ts";
import { RECAP_FILE } from "../util/paths.ts";

export interface RecapSettings {
  /** Off until somebody turns it on: unasked-for recurring mail is rude. */
  enabled: boolean;
  /** Where it goes. One address, or a comma list, as `mail send --to` takes. */
  to: string;
  /** Local time of day to send, "HH:MM". The daemon is what actually sends it. */
  at: string;
  /** The command that sends mail. Anything taking `send --to --subject --file`. */
  command: string;
}

export const DEFAULT_RECAP: RecapSettings = { enabled: false, to: "", at: "08:00", command: "mail" };

/** How long a send has to have been ago before another one is allowed. */
export const RECAP_GUARD_MS = 20 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export interface RecapAccountRow {
  /** The account, e.g. "bluesky:chovy" — one row per account, not per network. */
  accountId: string;
  network: string;
  sent: number;
  failed: number;
}

export interface RecapFailure {
  accountId: string;
  at: string;
  error: string;
  text: string;
}

export interface RecapUpcoming {
  id: string;
  at: string;
  target: string;
  text: string;
}

/** A card still waiting on a person: where, what, and the link to do it. */
export interface RecapHandoff {
  id: string;
  place: string;
  title: string;
  /** The card on mynaposter.com, when it was published there. */
  url?: string;
  createdAt: string;
}

export interface Recap {
  /** The end of the backward window: the moment the recap describes. */
  now: string;
  /** How far back it looked, in ms. */
  windowMs: number;
  sent: number;
  failed: number;
  /** Accounts posted to in the window, busiest first. */
  accounts: RecapAccountRow[];
  failures: RecapFailure[];
  /** What goes out in the next window, soonest first. */
  upcoming: RecapUpcoming[];
  /** Everything still pending, however far out. */
  pending: number;
  /** When the next pending post is due, if there is one. */
  nextAt?: string;
  /** When the last pending post is due: how far the queue reaches. */
  lastAt?: string;
  /** Hand-offs not yet marked done, newest first. */
  handoffs?: RecapHandoff[];
}

const oneLine = (text: string, limit = 72): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export interface RecapInput {
  now?: Date;
  windowMs?: number;
  history?: HistoryEntry[];
  queue?: QueuedPost[];
  handoffs?: Handoff[];
}

/**
 * What happened, and what is about to. The window runs backwards from `now`
 * for the recap of the past and forwards for the recap of the future, so a
 * daily mail covers the day either side of itself with no gap and no overlap.
 */
export function buildRecap(input: RecapInput = {}): Recap {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? DAY_MS;
  const history = input.history ?? listHistory();
  const queue = input.queue ?? listQueue();
  const handoffs = (input.handoffs ?? listHandoffs()).filter((card) => !card.doneAt);

  const from = now.getTime() - windowMs;
  const until = now.getTime() + windowMs;

  const rows = new Map<string, RecapAccountRow>();
  const failures: RecapFailure[] = [];
  let sent = 0;
  let failed = 0;

  for (const entry of history) {
    const at = new Date(entry.at).getTime();
    // A history file can hold anything; a NaN date must not become a row.
    if (!Number.isFinite(at) || at < from || at > now.getTime()) continue;
    const row = rows.get(entry.accountId) ?? { accountId: entry.accountId, network: entry.network, sent: 0, failed: 0 };
    if (entry.ok) {
      row.sent += 1;
      sent += 1;
    } else {
      row.failed += 1;
      failed += 1;
      failures.push({
        accountId: entry.accountId,
        at: entry.at,
        // An adapter that shells out records whatever the tool printed, and
        // that can be a whole usage screen. A recap is a list, not a log.
        error: entry.error ? oneLine(entry.error, 100) : "no reason recorded",
        text: oneLine(entry.text),
      });
    }
    rows.set(entry.accountId, row);
  }

  // Busiest first, because the point of the mail is where the volume went;
  // ties by name so two quiet accounts do not swap places every morning.
  const accounts = [...rows.values()].sort(
    (a, b) => b.sent + b.failed - (a.sent + a.failed) || a.accountId.localeCompare(b.accountId),
  );

  const pending = queue.filter((post) => post.status === "pending");
  const dated = pending
    .map((post) => ({ post, at: new Date(post.scheduledFor).getTime() }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);

  const upcoming: RecapUpcoming[] = dated
    .filter((entry) => entry.at <= until)
    .map(({ post }) => ({
      id: post.id,
      at: post.scheduledFor,
      target: post.targets[0] ?? "?",
      text: oneLine(post.repostOf ? `repost ${post.repostOf}` : post.text),
    }));

  return {
    now: now.toISOString(),
    windowMs,
    sent,
    failed,
    accounts,
    failures: failures.sort((a, b) => a.at.localeCompare(b.at)),
    upcoming,
    pending: pending.length,
    nextAt: dated[0]?.post.scheduledFor,
    lastAt: dated.at(-1)?.post.scheduledFor,
    handoffs: handoffs.map((card) => ({ id: card.id, place: card.place, title: card.title, ...(card.cloudUrl ? { url: card.cloudUrl } : {}), createdAt: card.createdAt })),
  };
}

const clock = (iso: string, tz?: string): string =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });

const day = (iso: string, tz?: string): string =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });

export function recapSubject(recap: Recap, tz?: string): string {
  const parts = [`${recap.sent} sent`];
  if (recap.failed) parts.push(`${recap.failed} failed`);
  parts.push(`${recap.upcoming.length} coming up`);
  if (recap.handoffs?.length) parts.push(`${recap.handoffs.length} waiting on you`);
  return `myna — ${day(recap.now, tz)}: ${parts.join(", ")}`;
}

/**
 * How many failures and how many upcoming posts get spelled out. The counts
 * above them are always exact; this only bounds the mail, because a bad
 * night can fail on every account and a deep queue can book thirty posts.
 */
const LIST_LIMIT = 12;

/**
 * Plain text on purpose. This is read in a terminal mail client as often as
 * a webmail one, and a column of numbers survives both.
 */
export function renderRecapText(recap: Recap, tz?: string): string {
  const lines: string[] = [];
  const hours = Math.round(recap.windowMs / 3_600_000);
  lines.push(`myna — ${day(recap.now, tz)}`, "");

  if (!recap.sent && !recap.failed) {
    lines.push(`Nothing went out in the last ${hours} hours.`);
  } else {
    lines.push(`Sent in the last ${hours} hours: ${recap.sent}${recap.failed ? `, ${recap.failed} failed` : ""}`);
    const width = Math.max(...recap.accounts.map((row) => row.accountId.length));
    for (const row of recap.accounts) {
      lines.push(
        `  ${row.accountId.padEnd(width)}  ${String(row.sent).padStart(3)}` + (row.failed ? `   ${row.failed} failed` : ""),
      );
    }
  }
  lines.push("");

  if (recap.failures.length) {
    lines.push("Failed");
    for (const failure of recap.failures.slice(0, LIST_LIMIT)) {
      lines.push(`  ${clock(failure.at, tz)}  ${failure.accountId}  ${failure.error}`);
      lines.push(`    ${failure.text}`);
    }
    if (recap.failures.length > LIST_LIMIT) lines.push(`  …and ${recap.failures.length - LIST_LIMIT} more; see myna history`);
    lines.push("");
  }

  if (recap.upcoming.length) {
    lines.push(`Next ${hours} hours: ${recap.upcoming.length}`);
    for (const post of recap.upcoming.slice(0, LIST_LIMIT)) {
      lines.push(`  ${clock(post.at, tz).padEnd(13)}  ${post.target}`);
      lines.push(`    ${post.text}`);
    }
    if (recap.upcoming.length > LIST_LIMIT) lines.push(`  …and ${recap.upcoming.length - LIST_LIMIT} more; see myna queue`);
  } else {
    lines.push(`Nothing booked for the next ${hours} hours.`);
  }
  lines.push("");

  // What only a person can finish: a Reddit comment, an HN submission. The
  // link is the card itself, so the mail is enough to do it from a phone.
  if (recap.handoffs?.length) {
    lines.push(`Waiting on you: ${recap.handoffs.length}`);
    for (const card of recap.handoffs.slice(0, LIST_LIMIT)) {
      lines.push(`  ${card.place}  ${card.title}`);
      lines.push(`    ${card.url ?? `myna handoff show ${card.id}`}`);
    }
    if (recap.handoffs.length > LIST_LIMIT) lines.push(`  …and ${recap.handoffs.length - LIST_LIMIT} more; see myna handoff`);
    lines.push("");
  }

  // The queue depth matters more than any single entry: it is the number
  // that says whether a post added today goes out today or next week.
  lines.push(
    recap.pending
      ? `Queue: ${recap.pending} pending, next ${clock(recap.nextAt!, tz)}, last ${clock(recap.lastAt!, tz)}`
      : "Queue: empty.",
  );
  lines.push("", "myna recap        this, on demand", "myna recap off    stop these");
  return lines.join("\n");
}

interface RecapState {
  lastSentAt?: string;
}

export const loadRecapState = (): RecapState => readJson<RecapState>(RECAP_FILE, {});
export const saveRecapState = (state: RecapState): void => writeJson(RECAP_FILE, state);

/**
 * Is a recap due? Sending is a scheduled thing that must survive a daemon
 * restart, so "due" is a question about the clock and the last send rather
 * than about how long this process has been up.
 */
export function recapDue(settings: RecapSettings, now: Date, lastSentAt?: string): boolean {
  if (!settings.enabled || !settings.to) return false;
  const [hour, minute] = settings.at.split(":").map(Number);
  if (!Number.isFinite(hour)) return false;
  const target = new Date(now);
  target.setHours(hour, Number.isFinite(minute) ? minute : 0, 0, 0);
  if (now < target) return false;
  if (!lastSentAt) return true;
  const last = new Date(lastSentAt).getTime();
  if (!Number.isFinite(last)) return true;
  // Two guards, and both are needed. The elapsed one stops a restart loop
  // sending all morning; the calendar-day one stops a recap at 08:00 today
  // being followed by one at 04:01 tomorrow just because 20h had passed.
  return now.getTime() - last >= RECAP_GUARD_MS && new Date(last).toDateString() !== now.toDateString();
}

const run = promisify(execFile);

export interface SendRecapResult {
  sent: boolean;
  subject: string;
  body: string;
  error?: string;
}

/**
 * Hand the recap to a mail command. The body goes through a file rather than
 * an argument: a day of post text is longer than a comfortable argv, and it
 * keeps the text out of the process list.
 */
export async function sendRecap(settings: RecapSettings, recap: Recap, tz?: string): Promise<SendRecapResult> {
  const subject = recapSubject(recap, tz);
  const body = renderRecapText(recap, tz);
  if (!settings.to) {
    return { sent: false, subject, body, error: "no address; set one with: myna recap on --to you@example.com" };
  }

  const dir = mkdtempSync(join(tmpdir(), "myna-recap-"));
  const file = join(dir, "recap.txt");
  try {
    writeFileSync(file, body, { mode: 0o600 });
    await run(settings.command, ["send", "--to", settings.to, "--subject", subject, "--file", file]);
    return { sent: true, subject, body };
  } catch (error) {
    const message = (error as Error).message;
    return {
      sent: false,
      subject,
      body,
      error: /ENOENT/.test(message) ? `${settings.command} is not on PATH, so the recap could not be sent.` : message,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface RecapTurn {
  /** Why nothing was sent, when nothing was. */
  idle?: string;
  result?: SendRecapResult;
}

/**
 * One turn: send today's recap if it is due and not yet sent.
 *
 * `myna recap --send` goes through here too, with `force`. Sending by hand
 * and sending on schedule have to share the stamp, or a recap asked for at
 * noon is followed by an identical one from the daemon ten minutes later.
 */
export async function runRecap(
  settings: RecapSettings,
  options: { now?: Date; force?: boolean; windowMs?: number } = {},
): Promise<RecapTurn> {
  const now = options.now ?? new Date();
  const state = loadRecapState();
  if (!options.force && !recapDue(settings, now, state.lastSentAt)) return { idle: "not due" };

  const recap = buildRecap({ now, windowMs: options.windowMs });
  const result = await sendRecap(settings, recap);
  // Stamp only on success, so a mail outage retries on the next tick rather
  // than costing the day's recap entirely.
  if (result.sent) saveRecapState({ lastSentAt: now.toISOString() });
  return { result };
}
