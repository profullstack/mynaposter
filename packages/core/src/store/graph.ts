/**
 * The follow graph on disk.
 *
 * Three lists: the seeds (people worth learning from), the candidates (who
 * those people follow, scored by how many seeds agree), and a ledger of every
 * follow myna has sent. Nothing secret lives here, so it is plain JSON.
 */
import { readJson, writeJson } from "../util/json.ts";
import { configPath, GRAPH_FILE } from "../util/paths.ts";

export interface Seed {
  network: string;
  handle: string;
  id?: string;
  displayName?: string;
  /** Where the seed came from: `manual`, `search`, or a plugin id. */
  source: string;
  /** How much this seed's opinion counts when ranking. 1 is normal. */
  weight: number;
  addedAt: string;
  /** When their following list was last read. */
  expandedAt?: string;
  /** Why the last expansion failed, if it did. */
  error?: string;
}

export interface Candidate {
  network: string;
  handle: string;
  id?: string;
  displayName?: string;
  url?: string;
  bio?: string;
  followers?: number;
  /** Seed keys whose lists this person appeared in. */
  via: string[];
  discoveredAt: string;
  /** Set once a follow has gone out from any account. */
  followedAt?: string;
  /** Set by a person who never wants to follow this one. */
  skipped?: boolean;
}

export interface FollowRecord {
  accountId: string;
  network: string;
  handle: string;
  at: string;
  ok: boolean;
  error?: string;
}

export interface GraphFile {
  seeds: Seed[];
  candidates: Candidate[];
  follows: FollowRecord[];
}

/** Enough ledger for months of following, and bounded so the file cannot grow forever. */
const FOLLOW_LIMIT = 5000;

const EMPTY: GraphFile = { seeds: [], candidates: [], follows: [] };

export const graphKey = (network: string, handle: string): string => `${network}|${handle.trim().toLowerCase().replace(/^@/, "")}`;

export function readGraph(): GraphFile {
  const file = readJson<Partial<GraphFile>>(GRAPH_FILE, EMPTY);
  return { seeds: file.seeds ?? [], candidates: file.candidates ?? [], follows: file.follows ?? [] };
}

export function writeGraph(graph: GraphFile): void {
  writeJson(GRAPH_FILE, { ...graph, follows: graph.follows.slice(-FOLLOW_LIMIT) } satisfies GraphFile);
}

export function clearGraph(): void {
  writeJson(GRAPH_FILE, EMPTY);
}

export const graphPath = (): string => configPath(GRAPH_FILE);
