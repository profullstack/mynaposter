/**
 * The live-links report: one email a night with a link to every post that
 * went live since the last one, so the posts themselves are a click away
 * (to check them, reply under them, share them on).
 *
 * The recap counts what was sent; this one lists where it is. It reads only
 * history.json, which records each post's URL as the network returned it, so
 * like the recap it runs from the daemon with no vault and nobody to type a
 * passphrase.
 *
 * Its window is "since the last one that was sent", not a fixed 24 hours, so
 * a missed night is caught up on the next rather than lost, and nothing is
 * listed twice.
 */
import { hostname } from "node:os";

import type { HistoryEntry } from "../store/history.ts";
import { listHistory } from "../store/history.ts";
import { readJson, writeJson } from "../util/json.ts";
import { LINKS_FILE } from "../util/paths.ts";
import { mailReport, recapDue } from "./recap.ts";
import * as R from "./report-email.ts";

export interface LinksSettings {
  /** Off until somebody turns it on: it is a second mail a day, and nobody asked for it by default. */
  enabled: boolean;
  /** One address or a comma list, as `mail send --to` takes. Empty means the recap's address. */
  to: string;
  /** Local time of day to send, "HH:MM". */
  at: string;
  command: string;
}

export const DEFAULT_LINKS: LinksSettings = { enabled: false, to: "", at: "22:00", command: "mail" };

const DAY_MS = 24 * 3_600_000;
/** However long the daemon was down, a report never reaches back more than a week. */
export const LINKS_MAX_WINDOW_MS = 7 * DAY_MS;

export interface LivePost {
  at: string;
  accountId: string;
  network: string;
  /** The title, or the first line of the text, trimmed for a list. */
  headline: string;
  url: string;
}

export interface LinksAccount {
  accountId: string;
  network: string;
  posts: LivePost[];
}

export interface LinksReport {
  now: string;
  since: string;
  /** Every live post in the window, newest first. */
  posts: LivePost[];
  /** The same posts, by account, busiest first. */
  accounts: LinksAccount[];
  /** Sent in the window but with no URL to link to (a network that does not return one). */
  unlinked: number;
}

/** The title if there is one, else the first non-empty line of the text, trimmed. */
export function headline(entry: Pick<HistoryEntry, "title" | "text">, max = 110): string {
  const raw = (entry.title?.trim() || entry.text.split("\n").map((l) => l.trim()).find(Boolean) || "").replace(/\s+/g, " ");
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

export function buildLinks(input: { now?: Date; since?: Date; history?: HistoryEntry[] } = {}): LinksReport {
  const now = input.now ?? new Date();
  const floor = now.getTime() - LINKS_MAX_WINDOW_MS;
  const since = new Date(Math.max(floor, (input.since ?? new Date(now.getTime() - DAY_MS)).getTime()));
  const inWindow = (input.history ?? listHistory()).filter((e) => {
    const t = new Date(e.at).getTime();
    return e.ok && t > since.getTime() && t <= now.getTime();
  });
  const posts = inWindow
    .filter((e) => /^https?:\/\//.test(e.url ?? ""))
    .map((e) => ({ at: e.at, accountId: e.accountId, network: e.network, headline: headline(e), url: e.url! }))
    .sort((a, b) => b.at.localeCompare(a.at));
  const byAccount = new Map<string, LinksAccount>();
  for (const p of posts) {
    const row = byAccount.get(p.accountId) ?? { accountId: p.accountId, network: p.network, posts: [] };
    row.posts.push(p);
    byAccount.set(p.accountId, row);
  }
  const accounts = [...byAccount.values()].sort((a, b) => b.posts.length - a.posts.length || a.accountId.localeCompare(b.accountId));
  return { now: now.toISOString(), since: since.toISOString(), posts, accounts, unlinked: inWindow.length - posts.length };
}

const day = (iso: string, tz?: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
const clock = (iso: string, tz?: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
const hoursOf = (r: LinksReport) => Math.max(1, Math.round((new Date(r.now).getTime() - new Date(r.since).getTime()) / 3_600_000));

export function linksSubject(r: LinksReport, tz?: string): string {
  const n = r.posts.length;
  return `myna — ${day(r.now, tz)}: ${n ? `${n} post${n === 1 ? "" : "s"} live` : "nothing posted"}`;
}

export function renderLinksText(r: LinksReport, tz?: string): string {
  const lines = [`myna — live posts, ${day(r.now, tz)}`, ""];
  if (!r.posts.length) {
    lines.push(`Nothing went live in the last ${hoursOf(r)} hours.`);
  } else {
    lines.push(`${r.posts.length} post${r.posts.length === 1 ? "" : "s"} went live in the last ${hoursOf(r)} hours.`, "");
    for (const a of r.accounts) {
      lines.push(`${a.accountId} (${a.posts.length})`);
      for (const p of a.posts) lines.push(`  ${clock(p.at, tz)}  ${p.headline}`, `    ${p.url}`);
      lines.push("");
    }
  }
  if (r.unlinked) lines.push(`${r.unlinked} more went out on a network that returns no link; see myna history.`);
  lines.push("", "myna links off   stop these");
  return lines.join("\n");
}

export function renderLinksHtml(r: LinksReport, tz?: string, meta: { host?: string } = {}): string {
  const hours = hoursOf(r);
  const parts: string[] = [];
  if (!r.posts.length) {
    parts.push(`<div style="font-size:14px;color:${R.MUTE};margin-top:16px">Nothing went live in the last ${hours} hours.</div>`);
  }
  for (const a of r.accounts) {
    parts.push(R.heading(a.accountId, a.posts.length));
    const rows = a.posts.map(
      (p) =>
        "<tr>" +
        R.td(R.esc(clock(p.at, tz)), { align: "left", style: `white-space:nowrap;color:${R.MUTE};font-size:12px;padding-left:0;vertical-align:middle` }) +
        R.td(
          `<a href="${R.esc(p.url)}" style="color:${R.INK};text-decoration:none;font-size:14px;line-height:1.35">${R.esc(p.headline)}</a>` +
            `<div style="font-size:11px;color:${R.MUTE};word-break:break-all;margin-top:2px">${R.esc(p.url)}</div>`,
          { align: "left", style: "width:100%;vertical-align:middle" },
        ) +
        R.td(R.button("Open →", p.url), { style: "padding-right:0;vertical-align:middle" }) +
        "</tr>",
    );
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">${rows.join("")}</table>`);
  }
  if (r.unlinked) {
    parts.push(`<div style="font-size:12px;color:${R.MUTE};margin-top:12px">${R.num(r.unlinked)} more went out on a network that returns no link: ${R.code("myna history")}</div>`);
  }
  parts.push(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;font-size:12px;color:${R.MUTE}">` +
      `<tr><td style="padding:2px 10px 2px 0">${R.code("myna links")}</td><td>this, on demand</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0">${R.code("myna links off")}</td><td>stop these</td></tr>` +
      "</table>",
  );
  const n = r.accounts.length;
  return R.page({
    title: `Live posts · ${day(r.now, tz)}`,
    subtitle: `${R.num(r.posts.length)} post${r.posts.length === 1 ? "" : "s"} in the last ${hours} hours · ${n} account${n === 1 ? "" : "s"}`,
    preheader: linksSubject(r, tz).replace(/^myna — [^:]+: /, ""),
    body: parts.join("\n"),
    footer: `Links come from myna's post history, as each network returned them. Generated by myna${meta.host ? ` on ${R.esc(meta.host)}` : ""} at ${R.esc(r.now)}.`,
  });
}

interface LinksState {
  lastSentAt?: string;
}

export const loadLinksState = (): LinksState => readJson<LinksState>(LINKS_FILE, {});
export const saveLinksState = (state: LinksState): void => writeJson(LINKS_FILE, state);

export interface LinksTurn {
  idle?: string;
  result?: { sent: boolean; html?: boolean; subject: string; count: number; error?: string };
}

/**
 * One turn: send tonight's report if it is due. `myna links --send` comes
 * through here with `force`, so a hand-sent report stamps the night and the
 * daemon does not follow it with the same links.
 */
export async function runLinks(settings: LinksSettings, options: { now?: Date; force?: boolean; history?: HistoryEntry[] } = {}): Promise<LinksTurn> {
  const now = options.now ?? new Date();
  const state = loadLinksState();
  if (!options.force && !recapDue({ enabled: settings.enabled, to: settings.to, at: settings.at, command: settings.command }, now, state.lastSentAt)) {
    return { idle: "not due" };
  }
  const report = buildLinks({ now, ...(state.lastSentAt ? { since: new Date(state.lastSentAt) } : {}), ...(options.history ? { history: options.history } : {}) });
  const subject = linksSubject(report);
  if (!settings.to) return { result: { sent: false, subject, count: report.posts.length, error: "no address; set one with: myna links on --to you@example.com" } };
  const mail = await mailReport(settings.command, settings.to, subject, renderLinksText(report), renderLinksHtml(report, undefined, { host: hostname() }));
  // Stamp only on success: a mail outage retries next tick and the window still starts at the last good send.
  if (mail.sent) saveLinksState({ lastSentAt: now.toISOString() });
  return { result: { ...mail, subject, count: report.posts.length } };
}
