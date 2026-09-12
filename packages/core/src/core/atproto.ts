/**
 * AT Protocol servers, as a directory sees them.
 *
 * The network behind Bluesky is made of servers anyone can run: a PDS holds
 * people's repositories, a relay crawls PDSes and streams the firehose, a
 * feed generator serves a custom feed, a labeler applies labels. Each kind
 * answers a different XRPC endpoint, and that answer is the whole probe: a
 * directory lists what a server said about itself, and whether it answered.
 *
 * Nothing here needs an account. The endpoints are the public ones every
 * atproto client uses before signing in.
 */

export type AtprotoKind = "pds" | "relay" | "feed" | "labeler" | "unknown";

export interface AtprotoProbe {
  /** The server's origin, normalised. */
  url: string;
  kind: AtprotoKind;
  online: boolean;
  /** The server's own DID, when it says one. */
  did: string | null;
  /** A PDS: the handle domains it hands out. */
  userDomains: string[];
  /** A PDS: whether new accounts need an invite code. */
  inviteCodeRequired: boolean | null;
  /** Whatever `_health` reported as the version. */
  version: string | null;
  /** A feed generator: its display name. */
  name: string | null;
  error: string | null;
}

const KNOWN_RELAYS = new Set(["bsky.network"]);

/** An https origin from whatever was pasted: a bare host, a handle domain, a URL with a path. */
export function atprotoOrigin(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) throw new Error("An atproto server is reached over https.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("An atproto server is reached over https.");
  return `${url.protocol}//${url.host}`;
}

async function getJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    throw new Error((error as Error).name === "AbortError" ? "timed out" : (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a server what it is. Never throws; an unreachable server is an offline probe with the reason. */
export async function probeAtproto(input: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<AtprotoProbe> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const url = atprotoOrigin(input);
  const probe: AtprotoProbe = { url, kind: "unknown", online: false, did: null, userDomains: [], inviteCodeRequired: null, version: null, name: null, error: null };

  try {
    const health = await getJson(fetcher, `${url}/xrpc/_health`, timeoutMs);
    if (health.status === 200) {
      probe.online = true;
      if (typeof health.body?.version === "string") probe.version = health.body.version;
    }

    const server = await getJson(fetcher, `${url}/xrpc/com.atproto.server.describeServer`, timeoutMs);
    if (server.status === 200 && server.body) {
      probe.online = true;
      probe.kind = "pds";
      if (typeof server.body.did === "string") probe.did = server.body.did;
      if (Array.isArray(server.body.availableUserDomains)) probe.userDomains = (server.body.availableUserDomains as unknown[]).filter((d): d is string => typeof d === "string");
      if (typeof server.body.inviteCodeRequired === "boolean") probe.inviteCodeRequired = server.body.inviteCodeRequired;
      return probe;
    }

    const feed = await getJson(fetcher, `${url}/xrpc/app.bsky.feed.describeFeedGenerator`, timeoutMs);
    if (feed.status === 200 && feed.body) {
      probe.online = true;
      probe.kind = "feed";
      if (typeof feed.body.did === "string") probe.did = feed.body.did;
      const feeds = Array.isArray(feed.body.feeds) ? (feed.body.feeds as Array<{ uri?: string }>) : [];
      probe.name = feeds.length ? `${feeds.length} feed${feeds.length === 1 ? "" : "s"}` : null;
      return probe;
    }

    const labels = await getJson(fetcher, `${url}/xrpc/com.atproto.label.queryLabels?uriPatterns=*&limit=1`, timeoutMs);
    if (labels.status === 200 && labels.body && Array.isArray(labels.body.labels)) {
      probe.online = true;
      probe.kind = "labeler";
      return probe;
    }

    if (probe.online) {
      // Health answered, nothing else did: a relay, or something that only streams.
      probe.kind = KNOWN_RELAYS.has(new URL(url).host) ? "relay" : "relay";
      return probe;
    }
    probe.error = `nothing at ${url} answered as an atproto server`;
    return probe;
  } catch (error) {
    probe.error = (error as Error).message;
    return probe;
  }
}
