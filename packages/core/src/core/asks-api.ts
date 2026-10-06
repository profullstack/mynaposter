/**
 * Asks, as the REST API and the MCP tools both see it.
 *
 * One shape for both, so an assistant and a dashboard read the same thing,
 * and the CLI stays the spec: every call here is a `myna asks` subcommand.
 * Replying is the only one that writes anything a person will see, and even
 * that only makes a card; nothing here can post to Reddit.
 */
import { loadSettings, saveSettings } from "../store/settings.ts";
import { findIn, readAsks, writeAsks, type Ask, type AskStatus, type IdeaStatus } from "../store/asks.ts";
import {
  mergeIdeas,
  rankIdeas,
  refreshAskStats,
  replyToAsk,
  replyTotals,
  scanAsks,
  setAskStatus,
  setIdea,
  subsOf,
  summarizeIdea,
  syncReplies,
  type IdeaSummary,
} from "./asks.ts";

const ASK_STATUSES: AskStatus[] = ["new", "drafted", "replied", "skipped"];
const IDEA_STATUSES: IdeaStatus[] = ["watching", "build", "building", "shipped", "ignored"];

export function askView(ask: Ask) {
  const latest = ask.stats[ask.stats.length - 1];
  const ours = [...ask.stats].reverse().find((stats) => stats.ours)?.ours;
  return {
    id: ask.id,
    sub: ask.sub,
    title: ask.title,
    url: ask.url,
    author: ask.author,
    postedAt: ask.postedAt,
    kind: ask.kind,
    score: ask.score,
    confirmed: Boolean(ask.judged),
    label: ask.label,
    wants: ask.wants,
    ideaId: ask.ideaId,
    product: ask.product,
    status: ask.status,
    reply: ask.reply,
    card: ask.handoffUrl ?? ask.handoffId,
    repliedAt: ask.repliedAt,
    thread: latest ? { score: latest.score, comments: latest.comments, at: latest.at } : undefined,
    ours,
  };
}

export function ideaView(summary: IdeaSummary) {
  return {
    id: summary.idea.id,
    label: summary.idea.label,
    status: summary.idea.status,
    askers: summary.askers,
    asks: summary.asks,
    subs: summary.subs,
    score: summary.score,
    comments: summary.comments,
    demand: summary.demand,
    replied: summary.replied,
    terms: summary.idea.terms.slice(0, 8),
    flaggedAt: summary.idea.flaggedAt,
    product: summary.idea.product,
    note: summary.idea.note,
  };
}

/** Status, settings, totals, and the top of both lists. */
export function asksOverview() {
  const settings = loadSettings().asks;
  const file = readAsks();
  if (syncReplies(file)) writeAsks(file);
  return {
    enabled: settings.enabled,
    settings,
    subs: subsOf(settings),
    products: file.products,
    totals: { asks: file.asks.length, new: file.asks.filter((ask) => ask.status === "new").length, ...replyTotals(file.asks) },
    ideas: rankIdeas(file, settings)
      .filter((summary) => summary.idea.status !== "ignored")
      .slice(0, 10)
      .map(ideaView),
  };
}

export function asksList(options: { status?: string; sub?: string; idea?: string; limit?: number } = {}) {
  const file = readAsks();
  if (syncReplies(file)) writeAsks(file);
  const status = options.status?.trim().toLowerCase() || "new";
  if (status !== "all" && !ASK_STATUSES.includes(status as AskStatus)) throw new Error(`status is one of ${ASK_STATUSES.join(", ")} or all.`);
  const sub = options.sub?.replace(/^\/?r\//i, "").toLowerCase();
  return file.asks
    .filter((ask) => status === "all" || ask.status === status)
    .filter((ask) => !sub || ask.sub.toLowerCase() === sub)
    .filter((ask) => !options.idea || ask.ideaId === options.idea)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, Math.max(1, Math.min(500, options.limit ?? 50)))
    .map(askView);
}

export function asksShow(id: string) {
  const file = readAsks();
  const ask = findIn(file.asks, id);
  if (!ask) throw new Error(`No ask ${id}.`);
  return { ...askView(ask), text: ask.text, stats: ask.stats };
}

export function asksIdeas(options: { all?: boolean } = {}) {
  const settings = loadSettings().asks;
  const file = readAsks();
  return {
    windowDays: settings.windowDays,
    buildAt: settings.buildAt,
    ideas: rankIdeas(file, settings)
      .filter((summary) => options.all || (summary.idea.status !== "ignored" && summary.idea.status !== "shipped"))
      .map(ideaView),
  };
}

export function asksIdea(id: string) {
  const settings = loadSettings().asks;
  const file = readAsks();
  const idea = findIn(file.ideas, id);
  if (!idea) throw new Error(`No idea ${id}.`);
  return {
    ...ideaView(summarizeIdea(file, idea, settings)),
    asks: file.asks.filter((ask) => idea.askIds.includes(ask.id)).map(askView),
  };
}

export async function asksScan(subs?: string[]) {
  const result = await scanAsks(subs?.length ? { subs } : {});
  return {
    read: result.read,
    sources: result.sources,
    judged: result.judged,
    rejected: result.rejected,
    deferred: result.deferred,
    skipped: result.skipped,
    found: result.found.map(askView),
    flagged: result.flagged.map((idea) => ({ id: idea.id, label: idea.label })),
  };
}

export async function asksReply(id: string, options: { text?: string; force?: boolean } = {}) {
  const result = await replyToAsk(id, { ...(options.text?.trim() ? { text: options.text } : {}), force: Boolean(options.force) });
  return {
    drafted: result.drafted,
    text: result.card.text,
    open: result.ask.url,
    card: result.card.cloudUrl ?? null,
    handoff: result.card.id,
    note: "Nothing was posted. A person pastes this from the card and marks it done; stats then track it.",
  };
}

export async function asksStats(options: { refresh?: boolean; ids?: string[] } = {}) {
  const result = options.refresh || options.ids?.length ? await refreshAskStats(options.ids?.length ? { ids: options.ids } : {}) : undefined;
  const file = readAsks();
  if (!result && syncReplies(file)) writeAsks(file);
  return {
    refreshed: result?.refreshed ?? 0,
    foundOurs: result?.foundOurs.map((ask) => ask.id) ?? [],
    errors: result?.errors ?? [],
    totals: replyTotals(file.asks),
    replies: file.asks.filter((ask) => ask.status === "replied" || ask.status === "drafted").map(askView),
  };
}

/** Change one thing: the switch, an ask's status, or an idea. */
export function asksSet(patch: {
  enabled?: boolean;
  id?: string;
  status?: string;
  idea?: string;
  ideaStatus?: string;
  label?: string;
  note?: string;
  mergeInto?: string;
}) {
  const done: string[] = [];
  if (typeof patch.enabled === "boolean") {
    const settings = loadSettings();
    settings.asks.enabled = patch.enabled;
    saveSettings(settings);
    done.push(`asks is ${patch.enabled ? "on" : "off"}`);
  }
  if (patch.id) {
    const status = patch.status?.trim().toLowerCase();
    if (!status || !ASK_STATUSES.includes(status as AskStatus)) throw new Error(`status is one of ${ASK_STATUSES.join(", ")}.`);
    const ask = setAskStatus(patch.id, status as AskStatus);
    if (!ask) throw new Error(`No ask ${patch.id}.`);
    done.push(`${ask.id} is ${ask.status}`);
  }
  if (patch.idea) {
    if (patch.mergeInto) {
      const merged = mergeIdeas(patch.mergeInto, patch.idea);
      if (!merged) throw new Error(`Could not merge ${patch.idea} into ${patch.mergeInto}.`);
      done.push(`merged ${patch.idea} into ${merged.id}`);
    } else {
      const status = patch.ideaStatus?.trim().toLowerCase();
      if (status && !IDEA_STATUSES.includes(status as IdeaStatus)) throw new Error(`ideaStatus is one of ${IDEA_STATUSES.join(", ")}.`);
      const idea = setIdea(patch.idea, {
        ...(status ? { status: status as IdeaStatus } : {}),
        ...(patch.label ? { label: patch.label } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      });
      if (!idea) throw new Error(`No idea ${patch.idea}.`);
      done.push(`idea ${idea.id} is ${idea.status}${patch.label ? `, called ${idea.label}` : ""}`);
    }
  }
  return { done: done.length ? done : ["nothing to change"] };
}
