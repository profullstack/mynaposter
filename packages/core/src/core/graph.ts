/**
 * The follow graph.
 *
 * Following someone's followers is noise: anyone can follow an account, and
 * most who do are bots, fans and the idle. Following who they *follow* is the
 * opposite — a curated list, maintained by a person whose judgement you have
 * already decided to trust. When several seeds follow the same account, that
 * account is the one to follow first.
 *
 *   seeds  --following-->  candidates  --ranked, throttled-->  follows
 *
 * Every step here is pure over the graph file except the two that touch a
 * network, and those are the only two that can fail.
 */
import type { Account, Profile } from "../net/types.ts";
import { getNetwork } from "../net/registry.ts";
import { listAccounts } from "../store/accounts.ts";
import { loadSettings, type Settings } from "../store/settings.ts";
import { graphKey, readGraph, writeGraph, type Candidate, type FollowRecord, type GraphFile, type Seed } from "../store/graph.ts";

export interface SeedInput {
  network: string;
  handle: string;
  id?: string;
  displayName?: string;
  source?: string;
  weight?: number;
}

export interface RankedCandidate extends Candidate {
  /** Sum of the weights of the seeds who follow them. */
  score: number;
  seeds: number;
}

/** Upsert seeds. A seed already present keeps its expansion state; its weight and source are refreshed. */
export function addSeeds(inputs: SeedInput[]): { added: number; updated: number } {
  const graph = readGraph();
  const byKey = new Map(graph.seeds.map((seed) => [graphKey(seed.network, seed.handle), seed]));
  let added = 0;
  let updated = 0;

  for (const input of inputs) {
    const network = getNetwork(input.network);
    if (!network) continue;
    const handle = input.handle.trim().replace(/^@/, "");
    if (!handle) continue;
    const key = graphKey(network.id, handle);
    const existing = byKey.get(key);
    if (existing) {
      existing.weight = input.weight ?? existing.weight;
      existing.source = input.source ?? existing.source;
      existing.id = input.id ?? existing.id;
      existing.displayName = input.displayName ?? existing.displayName;
      updated++;
    } else {
      byKey.set(key, {
        network: network.id,
        handle,
        id: input.id,
        displayName: input.displayName,
        source: input.source ?? "manual",
        weight: input.weight ?? 1,
        addedAt: new Date().toISOString(),
      });
      added++;
    }
  }

  graph.seeds = [...byKey.values()];
  writeGraph(graph);
  return { added, updated };
}

export function removeSeed(network: string, handle: string): boolean {
  const graph = readGraph();
  const key = graphKey(getNetwork(network)?.id ?? network, handle);
  const before = graph.seeds.length;
  graph.seeds = graph.seeds.filter((seed) => graphKey(seed.network, seed.handle) !== key);
  if (graph.seeds.length === before) return false;
  writeGraph(graph);
  return true;
}

/** The first connected account on a network that can do what `cap` names. */
function accountFor(network: string, cap: "following" | "follow", accounts: Account[]): Account | undefined {
  const adapter = getNetwork(network);
  if (!adapter?.[cap]) return undefined;
  return accounts.find((account) => account.network === adapter.id);
}

export interface ExpandOptions {
  accounts?: Account[];
  /** How many of each seed's follows to read. */
  perSeed?: number;
  /** Re-read a seed whose list is older than this. */
  staleMs?: number;
  /** Stop after this many seeds, so one tick of the daemon stays short. */
  maxSeeds?: number;
  /** Only these seeds, regardless of staleness. */
  only?: { network: string; handle: string }[];
  log?: (line: string) => void;
}

export interface ExpandResult {
  expanded: number;
  discovered: number;
  failed: { seed: Seed; error: string }[];
  /** Seeds on networks with no connected account that can read a following list. */
  unreadable: Seed[];
}

/** Read each due seed's following list into the candidate pool. */
export async function expandSeeds(options: ExpandOptions = {}): Promise<ExpandResult> {
  const settings = loadSettings();
  const accounts = options.accounts ?? listAccounts();
  const perSeed = options.perSeed ?? settings.graph.perSeed;
  const staleMs = options.staleMs ?? settings.graph.expandEveryHours * 3_600_000;
  const graph = readGraph();
  const result: ExpandResult = { expanded: 0, discovered: 0, failed: [], unreadable: [] };

  const wanted = options.only?.map((entry) => graphKey(getNetwork(entry.network)?.id ?? entry.network, entry.handle));
  const due = graph.seeds.filter((seed) => {
    if (wanted) return wanted.includes(graphKey(seed.network, seed.handle));
    if (!seed.expandedAt) return true;
    return Date.now() - Date.parse(seed.expandedAt) >= staleMs;
  });

  for (const seed of due.slice(0, options.maxSeeds ?? due.length)) {
    const account = accountFor(seed.network, "following", accounts);
    if (!account) {
      result.unreadable.push(seed);
      continue;
    }
    const network = getNetwork(seed.network)!;
    try {
      options.log?.(`reading who ${seed.handle} follows on ${network.name}`);
      // By handle, not id: every adapter takes what a person would type, and
      // a numeric X id or a DID is not that.
      const follows = await network.following!(account, seed.handle, perSeed);
      result.discovered += mergeCandidates(graph, seed, follows, settings);
      seed.expandedAt = new Date().toISOString();
      seed.error = undefined;
      result.expanded++;
    } catch (error) {
      seed.error = (error as Error).message;
      // A failed read still counts as an attempt, or one dead seed would be
      // retried on every tick forever.
      seed.expandedAt = new Date().toISOString();
      result.failed.push({ seed, error: seed.error });
    }
    writeGraph(graph);
  }

  return result;
}

/** Fold one seed's following list into the pool. Returns how many were new. */
function mergeCandidates(graph: GraphFile, seed: Seed, follows: Profile[], settings: Settings): number {
  const seedKey = graphKey(seed.network, seed.handle);
  const byKey = new Map(graph.candidates.map((candidate) => [graphKey(candidate.network, candidate.handle), candidate]));
  let added = 0;

  const upsert = (profile: Profile, via: string) => {
    const key = graphKey(seed.network, profile.handle);
    if (key === seedKey && via !== "seed") return;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      existing.id = profile.id ?? existing.id;
      existing.displayName = profile.displayName ?? existing.displayName;
      existing.url = profile.url ?? existing.url;
      existing.bio = profile.bio ?? existing.bio;
      existing.followers = profile.followers ?? existing.followers;
      return;
    }
    byKey.set(key, {
      network: seed.network,
      handle: profile.handle.replace(/^@/, ""),
      id: profile.id,
      displayName: profile.displayName,
      url: profile.url,
      bio: profile.bio,
      followers: profile.followers,
      via: [via],
      discoveredAt: new Date().toISOString(),
    });
    added++;
  };

  if (settings.graph.followSeeds) upsert({ handle: seed.handle, id: seed.id, displayName: seed.displayName }, "seed");
  for (const profile of follows) upsert(profile, seedKey);

  graph.candidates = [...byKey.values()];
  return added;
}

export interface RankOptions {
  /** Restrict to one network. */
  network?: string;
  /** Leave out anyone already followed or skipped. Default true. */
  fresh?: boolean;
  minSeeds?: number;
  accounts?: Account[];
}

/** A follow that failed is tried again after this long, and given up after `GIVE_UP_AFTER` failures. */
const RETRY_AFTER_MS = 24 * 3_600_000;
const GIVE_UP_AFTER = 3;

/**
 * Candidates best first. The score is the summed weight of the seeds who
 * follow them, so a person three trusted seeds all follow outranks a person
 * one seed follows. A seed itself counts as its own weight. Ties go to reach.
 */
export function rankCandidates(options: RankOptions = {}): RankedCandidate[] {
  const graph = readGraph();
  const settings = loadSettings();
  const accounts = options.accounts ?? safeAccounts();
  const own = new Set(accounts.map((account) => graphKey(account.network, account.handle)));
  const weights = new Map(graph.seeds.map((seed) => [graphKey(seed.network, seed.handle), seed.weight]));
  const networkId = options.network ? getNetwork(options.network)?.id ?? options.network : undefined;
  const minSeeds = options.minSeeds ?? settings.graph.minSeeds;

  // What the ledger says about each person: followed, or tried and failed.
  const tried = new Map<string, { ok: boolean; last: number; failures: number }>();
  for (const record of graph.follows) {
    const key = graphKey(record.network, record.handle);
    const entry = tried.get(key) ?? { ok: false, last: 0, failures: 0 };
    entry.ok ||= record.ok;
    entry.last = Math.max(entry.last, Date.parse(record.at));
    if (!record.ok) entry.failures++;
    tried.set(key, entry);
  }

  const ranked: RankedCandidate[] = [];
  for (const candidate of graph.candidates) {
    if (networkId && candidate.network !== networkId) continue;
    const key = graphKey(candidate.network, candidate.handle);
    if (own.has(key)) continue;
    if (options.fresh !== false) {
      if (candidate.skipped || candidate.followedAt) continue;
      const attempt = tried.get(key);
      if (attempt && (attempt.ok || attempt.failures >= GIVE_UP_AFTER || Date.now() - attempt.last < RETRY_AFTER_MS)) continue;
    }

    let score = 0;
    let seeds = 0;
    for (const via of candidate.via) {
      if (via === "seed") {
        score += weights.get(key) ?? 1;
        seeds++;
      } else if (weights.has(via)) {
        score += weights.get(via)!;
        seeds++;
      }
    }
    if (seeds < minSeeds && !candidate.via.includes("seed")) continue;
    ranked.push({ ...candidate, score, seeds });
  }

  return ranked.sort((a, b) => b.score - a.score || (b.followers ?? 0) - (a.followers ?? 0) || a.handle.localeCompare(b.handle));
}

/** The vault may be locked in a read-only context such as `graph candidates`. */
function safeAccounts(): Account[] {
  try {
    return listAccounts();
  } catch {
    return [];
  }
}

export function skipCandidate(network: string, handle: string, skipped = true): boolean {
  const graph = readGraph();
  const key = graphKey(getNetwork(network)?.id ?? network, handle);
  const candidate = graph.candidates.find((entry) => graphKey(entry.network, entry.handle) === key);
  if (!candidate) return false;
  candidate.skipped = skipped;
  writeGraph(graph);
  return true;
}

/**
 * How many follows an account may still send, given the hourly and daily
 * ceilings and the ledger. Failed attempts count: the network saw the request
 * either way, and a run of failures is exactly when to slow down.
 */
export function followBudget(accountId: string, settings = loadSettings(), now = Date.now()): number {
  const graph = readGraph();
  const mine = graph.follows.filter((record) => record.accountId === accountId);
  const lastHour = mine.filter((record) => now - Date.parse(record.at) < 3_600_000).length;
  const lastDay = mine.filter((record) => now - Date.parse(record.at) < 86_400_000).length;
  return Math.max(0, Math.min(settings.graph.followsPerHour - lastHour, settings.graph.followsPerDay - lastDay));
}

export interface FollowOptions {
  accounts?: Account[];
  /** Hard cap for this call, on top of the per-account budget. */
  limit?: number;
  /** Only these networks (ids). Default: the `graph.networks` setting. */
  networks?: string[];
  /** Ignore the hourly and daily ceilings. For a person at the keyboard, not the daemon. */
  ignoreBudget?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Follow the best candidates, within budget, and record what happened. */
export async function followNext(options: FollowOptions = {}): Promise<FollowRecord[]> {
  const settings = loadSettings();
  const accounts = options.accounts ?? listAccounts();
  const allowed = options.networks ?? networksFrom(settings.graph.networks);
  const budgets = new Map<string, number>();
  const sent: FollowRecord[] = [];
  let remaining = options.limit ?? Number.POSITIVE_INFINITY;

  for (const candidate of rankCandidates({ accounts })) {
    if (remaining <= 0) break;
    if (allowed && !allowed.includes(candidate.network)) continue;
    const account = accountFor(candidate.network, "follow", accounts);
    if (!account) continue;

    if (!options.ignoreBudget) {
      const budget = budgets.get(account.id) ?? followBudget(account.id, settings);
      if (budget <= 0) continue;
      budgets.set(account.id, budget - 1);
    }
    remaining--;

    if (options.dryRun) {
      options.log?.(`would follow ${candidate.handle} from ${account.id} (${candidate.seeds} seed${candidate.seeds === 1 ? "" : "s"})`);
      sent.push({ accountId: account.id, network: candidate.network, handle: candidate.handle, at: new Date().toISOString(), ok: true });
      continue;
    }

    const record = await followOne(account, candidate.handle);
    sent.push(record);
    options.log?.(
      record.ok
        ? `followed ${candidate.handle} from ${account.id} (${candidate.seeds} seed${candidate.seeds === 1 ? "" : "s"})`
        : `could not follow ${candidate.handle} from ${account.id}: ${record.error}`,
    );
  }

  return sent;
}

/** Follow one person from one account and write it to the ledger. */
export async function followOne(account: Account, ref: string, handle = ref): Promise<FollowRecord> {
  const network = getNetwork(account.network);
  if (!network?.follow) throw new Error(`${network?.name ?? account.network} has no follow API.`);
  const record: FollowRecord = { accountId: account.id, network: network.id, handle: handle.replace(/^@/, ""), at: new Date().toISOString(), ok: false };
  try {
    await network.follow(account, ref);
    record.ok = true;
  } catch (error) {
    record.error = (error as Error).message;
  }

  const graph = readGraph();
  graph.follows.push(record);
  const key = graphKey(record.network, record.handle);
  const candidate = graph.candidates.find((entry) => graphKey(entry.network, entry.handle) === key);
  if (candidate && record.ok) candidate.followedAt = record.at;
  writeGraph(graph);
  return record;
}

function networksFrom(spec: string): string[] | undefined {
  const parts = spec.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.includes("all") || parts.includes("*")) return undefined;
  return parts.map((part) => getNetwork(part)?.id ?? part);
}

export interface GraphStatus {
  seeds: number;
  seedsExpanded: number;
  candidates: number;
  ready: number;
  followed: number;
  failed: number;
  lastFollowAt?: string;
}

export function graphStatus(): GraphStatus {
  const graph = readGraph();
  const ok = graph.follows.filter((record) => record.ok);
  return {
    seeds: graph.seeds.length,
    seedsExpanded: graph.seeds.filter((seed) => seed.expandedAt && !seed.error).length,
    candidates: graph.candidates.length,
    ready: rankCandidates().length,
    followed: ok.length,
    failed: graph.follows.length - ok.length,
    lastFollowAt: ok.at(-1)?.at,
  };
}

export { readGraph, clearGraph, graphPath, type Seed, type Candidate, type FollowRecord } from "../store/graph.ts";
