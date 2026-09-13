/**
 * The transport: three calls against the tool's cloud.
 *
 *   GET  <path>            the latest snapshot, or nothing yet
 *   PUT  <path>            { snapshot, ifRevision }: a new revision, the old one
 *                          when nothing changed, or a conflict when another
 *                          machine saved first
 *   GET  <path>/revisions  what is kept
 *
 * Retries only on the answers that mean "nobody heard you" (no response,
 * 502, 503, 504), which is safe because a PUT is conditional on the
 * revision: sent twice, it lands once.
 */
import type { Snapshot } from "./snapshot.ts";

export interface StoredSnapshotInfo {
  revision: number;
  digest: string;
  savedAt: string;
  host: string | null;
  version: string | null;
  size: number;
}

export interface Latest extends StoredSnapshotInfo {
  snapshot: Snapshot;
}

export type PutResult = { revision: number; digest: string; savedAt: string; unchanged?: boolean } | { conflict: true; revision: number; error: string };

export interface SyncTransport {
  get(): Promise<Latest | null>;
  put(snapshot: Snapshot, ifRevision: number | null): Promise<PutResult>;
  revisions(): Promise<StoredSnapshotInfo[]>;
}

export interface ClientOptions {
  /** The API's base, e.g. `https://mynaposter.com/api`. */
  baseUrl: string;
  /** The route under it. */
  path?: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers, for a tool that identifies itself. */
  headers?: Record<string, string>;
}

const RETRY_ON = new Set([0, 502, 503, 504]);
const BACKOFF_MS = [400, 1200];

type Reply<T> = ({ ok: true } & T) | { ok: false; error?: string; revision?: number };

export function createClient(options: ClientOptions): SyncTransport {
  const base = `${options.baseUrl.replace(/\/+$/, "")}${options.path ?? "/v1/synconfig"}`;
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 20_000;

  async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: Reply<T> }> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let parsed: Reply<T> | undefined;
      try {
        const response = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(options.headers ?? {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeout),
        });
        status = response.status;
        const text = await response.text();
        parsed = text ? (JSON.parse(text) as Reply<T>) : ({ ok: false, error: `${status} with no body` } as Reply<T>);
      } catch (error) {
        if (attempt < BACKOFF_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
          continue;
        }
        throw new Error(`Could not reach ${url}: ${(error as Error).message}`);
      }
      if (RETRY_ON.has(status) && attempt < BACKOFF_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
        continue;
      }
      return { status, body: parsed! };
    }
  }

  return {
    async get() {
      const { status, body } = await call<Latest>("GET", base);
      if (status === 404) return null;
      if (!body.ok) throw new Error(body.error ?? `GET ${base} answered ${status}`);
      const { ok: _ok, ...rest } = body;
      void _ok;
      return rest as Latest;
    },
    async put(snapshot, ifRevision) {
      const { status, body } = await call<{ revision: number; digest: string; savedAt: string; unchanged?: boolean }>("PUT", base, { snapshot, ifRevision });
      if (status === 409) return { conflict: true, revision: (body as { revision?: number }).revision ?? 0, error: (body as { error?: string }).error ?? "another machine saved first" };
      if (!body.ok) throw new Error(body.error ?? `PUT ${base} answered ${status}`);
      const { ok: _ok, ...rest } = body;
      void _ok;
      return rest;
    },
    async revisions() {
      const { status, body } = await call<{ revisions: StoredSnapshotInfo[] }>("GET", `${base}/revisions`);
      if (!body.ok) throw new Error(body.error ?? `GET ${base}/revisions answered ${status}`);
      return body.revisions;
    },
  };
}
