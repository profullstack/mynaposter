/**
 * The server half: check a snapshot, digest it, keep revisions.
 *
 * Framework-free on purpose. A tool's API wires three handlers to three
 * routes and gives them a store; the store is the only thing that knows the
 * database. The server does not know the tool's policy, only the shape of a
 * snapshot and its size limits, so a tool can start syncing a new file
 * without the server being redeployed.
 *
 * Revisions are a monotonic integer per user. A PUT carries the revision
 * the client last saw; the store inserts `max + 1` only when `max` is still
 * that, in one statement, so two machines saving at once produce one
 * revision and one conflict rather than two revisions.
 */
import { createHash } from "node:crypto";
import type { Snapshot, SnapshotFile } from "./snapshot.ts";
import { DEFAULT_LIMITS, normalizeRel, type SyncLimits } from "./policy.ts";

export interface StoredSnapshot {
  revision: number;
  digest: string;
  host: string | null;
  version: string | null;
  size: number;
  body: Snapshot;
  savedAt: string;
}

export type InsertResult = { revision: number; savedAt: string } | { conflict: true; revision: number };

export interface SnapshotStore {
  latest(userId: string): Promise<StoredSnapshot | null>;
  /** Insert as `max(revision) + 1` when `ifRevision` is null or equals the current max; else conflict. */
  insert(userId: string, entry: { digest: string; host: string | null; version: string | null; size: number; body: Snapshot }, ifRevision: number | null): Promise<InsertResult>;
  list(userId: string, limit: number): Promise<Omit<StoredSnapshot, "body">[]>;
}

/** Same rule as the client's `digestFiles`, spelled out again so the server never imports the client. */
export function digestSnapshot(snapshot: Snapshot): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(snapshot.files).sort()) {
    const content = snapshot.files[path]!.content;
    hash.update(`${path}\0${Buffer.byteLength(content, "utf8")}\0${content}\0`);
  }
  return hash.digest("hex");
}

/** Why a body is not a snapshot, or null when it is one. Structure and size only; the tool's policy is the client's business. */
export function snapshotProblem(body: unknown, limits: SyncLimits = DEFAULT_LIMITS): string | null {
  if (!body || typeof body !== "object") return "snapshot must be an object";
  const snapshot = body as Partial<Snapshot>;
  if (snapshot.version !== 1) return "snapshot.version must be 1";
  if (!snapshot.files || typeof snapshot.files !== "object" || Array.isArray(snapshot.files)) return "snapshot.files must be an object";
  const entries = Object.entries(snapshot.files as Record<string, unknown>);
  if (!entries.length) return "no files in the snapshot";
  if (entries.length > limits.maxFiles) return `too many files (${entries.length}; the cap is ${limits.maxFiles})`;
  let total = 0;
  for (const [path, value] of entries) {
    if (normalizeRel(path) !== path) return `not a plain relative path: ${path}`;
    const content = (value as { content?: unknown })?.content;
    if (typeof content !== "string") return `${path}: content must be a string`;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > limits.maxFileBytes) return `${path} is ${bytes} bytes; the cap is ${limits.maxFileBytes}`;
    total += bytes;
  }
  if (total > limits.maxTotalBytes) return `the snapshot is ${total} bytes; the cap is ${limits.maxTotalBytes}`;
  if (snapshot.host !== undefined && typeof snapshot.host !== "string") return "snapshot.host must be a string";
  if (snapshot.app !== undefined && typeof snapshot.app !== "string") return "snapshot.app must be a string";
  return null;
}

export interface HandlerReply {
  status: number;
  body: Record<string, unknown>;
}

export const KEEP_REVISIONS = 10;

/** `PUT`: `{ snapshot, ifRevision }` → 200 with the revision (old one when unchanged), 400 when malformed, 409 when another machine saved first. */
export interface PutOptions {
  limits?: SyncLimits;
  /** Where the app's version is in a snapshot, when it is not `app`. moshcode writes `moshcode`. */
  versionOf?: (snapshot: Snapshot) => string | null | undefined;
}

export async function handlePut(store: SnapshotStore, userId: string, body: unknown, options: SyncLimits | PutOptions = DEFAULT_LIMITS): Promise<HandlerReply> {
  const opts: PutOptions = "maxFileBytes" in options ? { limits: options } : options;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const input = (body ?? {}) as { snapshot?: unknown; ifRevision?: unknown };
  const problem = snapshotProblem(input.snapshot, limits);
  if (problem) return { status: 400, body: { ok: false, error: problem } };
  const snapshot = input.snapshot as Snapshot;
  const ifRevision = input.ifRevision === null || input.ifRevision === undefined ? null : Number(input.ifRevision);
  if (ifRevision !== null && !Number.isInteger(ifRevision)) return { status: 400, body: { ok: false, error: "ifRevision must be an integer or null" } };

  const digest = digestSnapshot(snapshot);
  const latest = await store.latest(userId);
  if (latest && latest.digest === digest) {
    return { status: 200, body: { ok: true, revision: latest.revision, digest, savedAt: latest.savedAt, unchanged: true } };
  }
  const size = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  // A precondition against an account with nothing in it protects nothing:
  // the revisions it names are gone (forgotten from the web, or never made),
  // so there is no other machine's save to lose. Refusing here would strand
  // every machine behind a force after a perfectly deliberate delete.
  const precondition = latest ? ifRevision : null;
  const version = (opts.versionOf ? opts.versionOf(snapshot) : snapshot.app) ?? null;
  const inserted = await store.insert(userId, { digest, host: snapshot.host ?? null, version: version ? String(version).slice(0, 40) : null, size, body: snapshot }, precondition);
  if ("conflict" in inserted) {
    return { status: 409, body: { ok: false, error: "another machine saved first; load, or save with force", revision: inserted.revision } };
  }
  return { status: 200, body: { ok: true, revision: inserted.revision, digest, savedAt: inserted.savedAt } };
}

/** `GET`: the latest snapshot, or 404 when nothing has been saved. */
export async function handleGet(store: SnapshotStore, userId: string): Promise<HandlerReply> {
  const latest = await store.latest(userId);
  if (!latest) return { status: 404, body: { ok: false, error: "nothing synced yet" } };
  return { status: 200, body: { ok: true, revision: latest.revision, digest: latest.digest, savedAt: latest.savedAt, host: latest.host, version: latest.version, size: latest.size, snapshot: latest.body } };
}

export async function handleRevisions(store: SnapshotStore, userId: string, limit = KEEP_REVISIONS): Promise<HandlerReply> {
  const revisions = await store.list(userId, limit);
  return { status: 200, body: { ok: true, revisions } };
}

/** A store in memory: the reference for a real one, and what the tests use. Keeps `KEEP_REVISIONS` per user. */
export function memoryStore(keep = KEEP_REVISIONS): SnapshotStore & { rows: Map<string, StoredSnapshot[]> } {
  const rows = new Map<string, StoredSnapshot[]>();
  const of = (userId: string) => rows.get(userId) ?? [];
  return {
    rows,
    async latest(userId) {
      const all = of(userId);
      return all.length ? all[all.length - 1]! : null;
    },
    async insert(userId, entry, ifRevision) {
      const all = of(userId);
      const max = all.length ? all[all.length - 1]!.revision : 0;
      if (ifRevision !== null && ifRevision !== max) return { conflict: true, revision: max };
      const saved: StoredSnapshot = { revision: max + 1, savedAt: new Date().toISOString(), ...entry };
      const kept = [...all, saved].filter((row) => row.revision > max + 1 - keep);
      rows.set(userId, kept);
      return { revision: saved.revision, savedAt: saved.savedAt };
    },
    async list(userId, limit) {
      return of(userId)
        .slice()
        .reverse()
        .slice(0, limit)
        .map(({ body: _body, ...rest }) => {
          void _body;
          return rest;
        });
    },
  };
}

export type { Snapshot, SnapshotFile };
