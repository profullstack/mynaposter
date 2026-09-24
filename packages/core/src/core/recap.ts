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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HistoryEntry } from "../store/history.ts";
import { listHistory } from "../store/history.ts";
import type { QueuedPost } from "../store/queue.ts";
import { listQueue } from "../store/queue.ts";
import { listHandoffs, type Handoff } from "../store/handoffs.ts";
import { readJson, writeJson } from "../util/json.ts";
import * as R from "./report-email.ts";
import { RECAP_FILE } from "../util/paths.ts";

export interface RecapSettings {
  /**
   * On by default since 0.33.0: the recap is the one place a person sees what
   * a queue of hundreds of posts actually did. `myna recap off` turns it off
   * and that choice sticks.
   */
  enabled: boolean;
  /**
   * Where it goes. One address, or a comma list, as `mail send --to` takes.
   * Empty means the profile email, then the myna cloud login's.
   */
  to: string;
  /** Local time of day to send, "HH:MM". The daemon is what actually sends it. */
  at: string;
  /** The command that sends mail. Anything taking `send --to --subject --file`. */
  command: string;
  /**
   * Which default the stored values were written under. Absent means a file
   * from before 0.33.0, when `enabled: false` was the default being saved back
   * rather than anybody's choice; `resolveRecapSettings` reads it that way.
   */
  v?: number;
}

export const RECAP_SETTINGS_VERSION = 2;
export const DEFAULT_RECAP: RecapSettings = { enabled: true, to: "", at: "08:00", command: "mail", v: RECAP_SETTINGS_VERSION };

/**
 * Stored recap settings, read under today's default.
 *
 * Every settings save writes the whole file, so before 0.33.0 an install that
 * never touched the recap still has `enabled: false` in it. That was the old
 * default, not a decision, and it must not keep the nightly summary off. The
 * one legacy shape that WAS a decision is off with an address: `recap on`
 * refused to run without one, so an address means somebody turned it on and
 * later ran `recap off`.
 */
export function resolveRecapSettings(stored: Partial<RecapSettings> | undefined): RecapSettings {
  const merged = { ...DEFAULT_RECAP, ...stored };
  if (!stored || (stored.v ?? 1) >= RECAP_SETTINGS_VERSION) return { ...merged, v: RECAP_SETTINGS_VERSION };
  const optedOut = stored.enabled === false && Boolean(stored.to);
  return { ...merged, enabled: !optedOut, v: RECAP_SETTINGS_VERSION };
}

/** The address a recap goes to: the setting, else the profile email, else the cloud login. */
export function recapAddress(settings: RecapSettings, fallbacks: { profile?: string; cloud?: string } = {}): { to: string; source: "recap.to" | "profile" | "cloud" | "none" } {
  if (settings.to.trim()) return { to: settings.to.trim(), source: "recap.to" };
  if (fallbacks.profile?.trim()) return { to: fallbacks.profile.trim(), source: "profile" };
  if (fallbacks.cloud?.trim()) return { to: fallbacks.cloud.trim(), source: "cloud" };
  return { to: "", source: "none" };
}

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
  /** The same four numbers one window earlier, for the deltas on the tiles. */
  prev?: RecapPrev;
  /** The last seven windows, oldest first; the last one is this recap's. */
  days?: RecapDay[];
  /** One row per network, busiest first, with its own seven-window strip. */
  channels?: RecapChannel[];
}

export interface RecapPrev {
  sent: number;
  failed: number;
  /** What was booked for the window that just ended, as it stood when it began. */
  upcoming: number;
  handoffs: number;
  pending: number;
}

export interface RecapDay {
  /** The end of the window. */
  end: string;
  sent: number;
  failed: number;
}

export interface RecapChannel {
  network: string;
  accounts: string[];
  sent: number;
  prevSent: number;
  failed: number;
  /** Sent per window, oldest first, the same seven windows as `days`. */
  strip: number[];
  /** Booked for the next window. */
  upcoming: number;
  /** Everything pending on this network. */
  pending: number;
}

/** How many windows the chart and the strips cover. */
export const RECAP_DAYS = 7;

const networkOf = (target: string): string => target.split(":")[0] || target;
const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);

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
  const allHandoffs = input.handoffs ?? listHandoffs();
  const handoffs = allHandoffs.filter((card) => !card.doneAt);

  const from = now.getTime() - windowMs;
  const until = now.getTime() + windowMs;
  const chartFrom = now.getTime() - RECAP_DAYS * windowMs;

  const rows = new Map<string, RecapAccountRow>();
  const failures: RecapFailure[] = [];
  let sent = 0;
  let failed = 0;

  // Seven windows back to back, ending now, so the last bar is exactly the
  // "sent" tile and the one before it is what the tile's delta compares to.
  const days: RecapDay[] = Array.from({ length: RECAP_DAYS }, (_, i) => ({
    end: new Date(now.getTime() - (RECAP_DAYS - 1 - i) * windowMs).toISOString(),
    sent: 0,
    failed: 0,
  }));
  const channels = new Map<string, RecapChannel & { accountSet: Set<string> }>();
  const channel = (network: string) => {
    let row = channels.get(network);
    if (!row) {
      row = { network, accounts: [], accountSet: new Set(), sent: 0, prevSent: 0, failed: 0, strip: Array(RECAP_DAYS).fill(0), upcoming: 0, pending: 0 };
      channels.set(network, row);
    }
    return row;
  };

  for (const entry of history) {
    const at = new Date(entry.at).getTime();
    // A history file can hold anything; a NaN date must not become a row.
    if (!Number.isFinite(at) || at < chartFrom || at > now.getTime()) continue;
    // Windows close at their start: an entry exactly `windowMs` old belongs to
    // the current one, as it always has for the "sent" count.
    const back = Math.max(0, Math.ceil((now.getTime() - at) / windowMs) - 1);
    const slot = RECAP_DAYS - 1 - Math.min(RECAP_DAYS - 1, back);
    const net = channel(entry.network || networkOf(entry.accountId));
    net.accountSet.add(entry.accountId);
    if (entry.ok) {
      days[slot]!.sent += 1;
      net.strip[slot]! += 1;
      if (slot === RECAP_DAYS - 2) net.prevSent += 1;
    } else {
      days[slot]!.failed += 1;
    }
    if (at < from) continue;
    if (!entry.ok) net.failed += 1;
    else net.sent += 1;
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

  for (const { post, at } of dated) {
    const net = channel(networkOf(post.targets[0] ?? "?"));
    net.pending += 1;
    if (at <= until) net.upcoming += 1;
  }

  // The tiles compare with the window before. Sent and hand-offs are exact
  // from their own timestamps. The queue keeps no log of itself, so the other
  // two are rebuilt: what was booked for the window that just ended is what
  // was tried in it plus what is still overdue from it, and the queue as it
  // stood then is what had been added by then and had not yet gone out.
  const prevDay = days[RECAP_DAYS - 2]!;
  const nowMs = now.getTime();
  const overdue = dated.filter((entry) => entry.at > from && entry.at <= nowMs).length;
  const createdBefore = (post: QueuedPost) => {
    const created = new Date(post.createdAt).getTime();
    return !Number.isFinite(created) || created <= from;
  };
  const prev: RecapPrev = {
    sent: prevDay.sent,
    failed: prevDay.failed,
    upcoming: sent + failed + overdue,
    handoffs: allHandoffs.filter((card) => {
      const created = new Date(card.createdAt).getTime();
      const done = card.doneAt ? new Date(card.doneAt).getTime() : Infinity;
      return created <= from && done > from;
    }).length,
    pending: queue.filter((post) => {
      if (!createdBefore(post)) return false;
      if (post.status === "pending") return true;
      // Went out (or was tried) after the window opened: it was still queued then.
      const due = new Date(post.scheduledFor).getTime();
      return (post.status === "sent" || post.status === "failed" || post.status === "sending") && due > from;
    }).length,
  };

  const channelRows: RecapChannel[] = [...channels.values()]
    .map(({ accountSet, ...row }) => ({ ...row, accounts: [...accountSet].sort() }))
    .sort(
      (a, b) =>
        b.sent + b.failed - (a.sent + a.failed) ||
        sum(b.strip) - sum(a.strip) ||
        b.upcoming - a.upcoming ||
        a.network.localeCompare(b.network),
    );

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
    prev,
    days,
    channels: channelRows,
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
    const change = recap.prev ? ` (${R.signed(recap.sent - recap.prev.sent)} on the ${hours} hours before)` : "";
    lines.push(`Sent in the last ${hours} hours: ${recap.sent}${recap.failed ? `, ${recap.failed} failed` : ""}${change}`);
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

  if (recap.days?.length) {
    lines.push(`Last ${recap.days.length} days: ${recap.days.map((d) => `${shortDay(d.end, tz)} ${d.sent}`).join(" · ")}`, "");
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

const shortDay = (iso: string, tz?: string): string =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });

const reach = (iso: string, tz?: string): string =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });

/**
 * The same recap, drawn the way fleet-nightly and gh-pulse are: four tiles
 * with the change against the window before, what is waiting on you as
 * buttons, a seven-day chart, a row per network with its own heat strip, and
 * the next day's posts. The plain text stays the other half of the mail.
 */
export function renderRecapHtml(recap: Recap, tz?: string, meta: { host?: string } = {}): string {
  const hours = Math.round(recap.windowMs / 3_600_000);
  const span = hours === 24 ? "24h" : `${hours}h`;
  const prev = recap.prev;
  const days = recap.days ?? [];
  const against = hours === 24 && days.length > 1 ? `vs ${new Date(days[days.length - 2]!.end).toLocaleDateString("en-US", { weekday: "short", timeZone: tz })}` : `vs the ${span} before`;
  const channels = recap.channels ?? [];
  const handoffs = recap.handoffs ?? [];
  const parts: string[] = [];

  parts.push(
    R.tiles([
      {
        label: `Sent, last ${span}`,
        value: recap.sent,
        prev: prev?.sent,
        against,
        sub: recap.failed ? `<span style="color:${R.DOWN}">${R.num(recap.failed)} failed</span>` : "no failures",
      },
      {
        label: `Booked, next ${span}`,
        value: recap.upcoming.length,
        prev: prev?.upcoming,
        against,
        sub: recap.nextAt ? `next ${R.esc(clock(recap.nextAt, tz))}` : "nothing booked",
      },
      {
        label: "Waiting on you",
        value: handoffs.length,
        prev: prev?.handoffs,
        against,
        invert: true,
        sub: handoffs.length ? "hand-offs only you can do" : "nothing to do by hand",
      },
      {
        label: "Queue",
        value: recap.pending,
        prev: prev?.pending,
        against,
        sub: recap.lastAt ? `reaches ${R.esc(reach(recap.lastAt, tz))}` : "empty",
      },
    ]),
  );

  // The one part of the mail that needs a person, so it comes first and every
  // card is a button: the card page has the text to paste and the link to open.
  if (handoffs.length) {
    parts.push(R.heading("Waiting on you", handoffs.length));
    const rows = handoffs.slice(0, LIST_LIMIT).map((card) => {
      const action = card.url ? R.button("Open card →", card.url) : R.code(`myna handoff show ${card.id}`);
      return (
        `<tr><td style="padding:10px 12px;border-bottom:1px solid ${R.LINE};vertical-align:middle">` +
        `<div>${R.chip(card.place, R.INK)} <span style="font-size:11px;color:${R.MUTE}">since ${R.esc(shortDay(card.createdAt, tz))}</span></div>` +
        `<div style="font-size:14px;color:${R.INK};margin-top:4px;line-height:1.35">${R.esc(card.title)}</div></td>` +
        `<td style="padding:10px 12px;border-bottom:1px solid ${R.LINE};vertical-align:middle;text-align:right;width:1%">${action}</td></tr>`
      );
    });
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border:1px solid ${R.LINE};border-left:3px solid ${R.BLUE};border-radius:8px;background:#fff">${rows.join("")}</table>`,
    );
    if (handoffs.length > LIST_LIMIT) {
      parts.push(`<div style="font-size:12px;color:${R.MUTE};margin-top:6px">…and ${handoffs.length - LIST_LIMIT} more: ${R.code("myna handoff")}</div>`);
    }
  }

  if (recap.failures.length) {
    parts.push(R.heading("Failed", recap.failures.length));
    const rows = recap.failures.slice(0, LIST_LIMIT).map(
      (f) =>
        `<tr>${R.td(R.esc(clock(f.at, tz)), { align: "left", style: `white-space:nowrap;color:${R.MUTE};font-size:12px` })}` +
        R.td(`<div style="font-weight:600">${R.esc(f.accountId)}</div><div style="color:${R.DOWN};font-size:12px">${R.esc(f.error)}</div><div style="color:${R.MUTE};font-size:12px">${R.esc(f.text)}</div>`, { align: "left" }) +
        "</tr>",
    );
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;border-left:3px solid ${R.DOWN}">${rows.join("")}</table>`,
    );
    if (recap.failures.length > LIST_LIMIT) {
      parts.push(`<div style="font-size:12px;color:${R.MUTE};margin-top:6px">…and ${recap.failures.length - LIST_LIMIT} more: ${R.code("myna history")}</div>`);
    }
  }

  if (days.length) {
    parts.push(R.heading(`Posts sent, last ${days.length} days`));
    parts.push(
      R.bars(
        days.map((d, i) => ({
          label: i === days.length - 1 ? `${shortDay(d.end, tz)} (last ${span})` : shortDay(d.end, tz),
          value: d.sent,
          current: i === days.length - 1,
          ...(d.failed ? { note: ` · <span style="color:${R.DOWN}">${R.num(d.failed)} failed</span>` } : {}),
        })),
        "sent",
      ),
    );
  }

  const movers = channels.filter((c) => c.sent !== c.prevSent);
  const up = movers.filter((c) => c.sent > c.prevSent).sort((a, b) => b.sent - b.prevSent - (a.sent - a.prevSent));
  const down = movers.filter((c) => c.sent < c.prevSent).sort((a, b) => a.sent - a.prevSent - (b.sent - b.prevSent));
  if (movers.length) {
    const list = (items: RecapChannel[], color: string) =>
      items.length
        ? items
            .map(
              (c) =>
                `<div style="padding:2px 0;font-size:13px"><span style="color:${color};font-weight:600">${R.signed(c.sent - c.prevSent)}</span> ${R.esc(c.network)} <span style="color:${R.MUTE};font-size:12px">${R.num(c.prevSent)} → ${R.num(c.sent)}</span></div>`,
            )
            .join("")
        : `<div style="font-size:12px;color:${R.MUTE}">none</div>`;
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>` +
        `<td style="vertical-align:top;width:50%;padding-right:12px"><div style="font-size:15px;font-weight:700;margin-bottom:4px">Up</div>${list(up, R.UP)}</td>` +
        `<td style="vertical-align:top;width:50%;padding-left:12px"><div style="font-size:15px;font-weight:700;margin-bottom:4px">Down</div>${list(down, R.DOWN)}</td>` +
        "</tr></table>",
    );
  }

  if (channels.length) {
    parts.push(R.heading("Every channel", channels.length));
    const rows = channels.map((c) => {
      const accounts = c.accounts.map((id) => id.slice(id.indexOf(":") + 1)).join(", ");
      const strip = R.heatStrip(c.strip.map((value, i) => ({ label: shortDay(days[i]?.end ?? recap.now, tz), value })));
      return (
        "<tr>" +
        R.td(`<div style="font-weight:600">${R.esc(c.network)}</div>${accounts ? `<div style="font-size:11px;color:${R.MUTE}">${R.esc(accounts)}</div>` : ""}`, { align: "left", style: "padding-left:0" }) +
        R.td(strip, { align: "left" }) +
        R.metric(c.sent, c.prevSent, { bold: true }) +
        (c.failed ? R.td(`<span style="color:${R.DOWN};font-weight:600">${R.num(c.failed)}</span>`) : R.td(`<span style="color:${R.FAINT}">0</span>`)) +
        R.metric(c.upcoming) +
        R.td(`<span style="color:${c.pending ? R.MUTE : R.FAINT}">${R.num(c.pending)}</span>`, { style: "padding-right:0" }) +
        "</tr>"
      );
    });
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">` +
        `<tr>${R.th("Channel", "left")}${R.th("7d", "left")}${R.th(`Sent ${span}`)}${R.th("Failed")}${R.th(`Next ${span}`)}${R.th("Queued")}</tr>` +
        rows.join("") +
        "</table>",
    );
  }

  parts.push(R.heading(`Next ${span}`, recap.upcoming.length));
  if (recap.upcoming.length) {
    const rows = recap.upcoming.slice(0, LIST_LIMIT).map(
      (post) =>
        "<tr>" +
        R.td(R.esc(clock(post.at, tz)), { align: "left", style: `white-space:nowrap;color:${R.MUTE};font-size:12px;padding-left:0` }) +
        R.td(R.chip(networkOf(post.target)), { align: "left", style: "white-space:nowrap" }) +
        R.td(`<span style="color:${R.INK}">${R.esc(post.text)}</span>`, { align: "left", style: "width:100%;padding-right:0" }) +
        "</tr>",
    );
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">${rows.join("")}</table>`);
    if (recap.upcoming.length > LIST_LIMIT) {
      parts.push(`<div style="font-size:12px;color:${R.MUTE};margin-top:6px">…and ${recap.upcoming.length - LIST_LIMIT} more: ${R.code("myna queue")}</div>`);
    }
  } else {
    parts.push(`<div style="font-size:13px;color:${R.MUTE}">Nothing booked for the next ${hours} hours.</div>`);
  }

  parts.push(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;font-size:12px;color:${R.MUTE}">` +
      `<tr><td style="padding:2px 10px 2px 0">${R.code("myna recap")}</td><td>this, on demand</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0">${R.code("myna recap off")}</td><td>stop these</td></tr>` +
      "</table>",
  );

  const networks = channels.length;
  return R.page({
    title: `myna · ${day(recap.now, tz)}`,
    subtitle: `Last ${hours} hours and the next · ${networks} channel${networks === 1 ? "" : "s"} · compared with the ${hours} hours before`,
    preheader: recapSubject(recap, tz).replace(/^myna — [^:]+: /, ""),
    body: parts.join("\n"),
    footer:
      `Sent counts come from myna's post history; each 7-day strip is shaded on that channel's own scale. ` +
      `"Booked" a day ago is rebuilt from what was tried since plus what is still overdue, and the queue a day ago from when each entry was added, because the queue keeps no log of itself. ` +
      `Generated by myna${meta.host ? ` on ${R.esc(meta.host)}` : ""} at ${R.esc(recap.now)}.`,
  });
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
  /** Whether the mail carried the HTML part, or only the text a `mail` without --html can send. */
  html?: boolean;
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
  const html = join(dir, "recap.html");
  const base = ["send", "--to", settings.to, "--subject", subject, "--file", file];
  try {
    writeFileSync(file, body, { mode: 0o600 });
    writeFileSync(html, renderRecapHtml(recap, tz, { host: hostname() }), { mode: 0o600 });
    try {
      // The text stays the plain part of a multipart/alternative mail; the
      // HTML is the house report drawn over the same numbers.
      await run(settings.command, [...base, "--html", html]);
      return { sent: true, subject, body, html: true };
    } catch (error) {
      // A `mail` from before --html refuses the flag before it sends
      // anything, so the plain recap is still worth sending.
      if (!/unknown option:? *--html/i.test(errorText(error))) throw error;
      await run(settings.command, base);
      return { sent: true, subject, body, html: false };
    }
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

const errorText = (error: unknown): string => {
  const e = error as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
  return [e.message, e.stderr, e.stdout].map((part) => String(part ?? "")).join("\n");
};

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
