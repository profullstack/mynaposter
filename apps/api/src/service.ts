/**
 * What the API and the MCP server both do.
 *
 * Keeping this separate from the HTTP layer means the MCP tools and the REST
 * routes cannot drift apart: there is one implementation of "post to these
 * accounts" and both surfaces call it.
 */
import {
  NETWORKS,
  authSummary,
  draft,
  enqueue,
  infographicCopy,
  listAccounts,
  listHistory,
  listQueue,
  loadAllMedia,
  loadSettings,
  postToAll,
  removeQueued,
  requireNetwork,
  resolveTargets,
  summarize,
  writerAvailable,
} from "@profullstack/myna-core";

export interface PostRequest {
  text: string;
  to?: string;
  title?: string;
  mediaPaths?: string[];
  thread?: boolean;
  dryRun?: boolean;
}

export function networks() {
  return NETWORKS.map((network) => ({
    id: network.id,
    name: network.name,
    category: network.category,
    blurb: network.blurb,
    login: authSummary(network),
    charLimit: network.caps.charLimit,
    capabilities: network.caps,
  }));
}

/** Accounts, minus every secret. */
export function accounts() {
  return listAccounts().map(({ creds, ...rest }) => rest);
}

export async function post(request: PostRequest) {
  const targets = resolveTargets(request.to ?? loadSettings().defaultTargets);
  if (!targets.length) throw new Error("No accounts connected.");

  if (request.dryRun) {
    return {
      dryRun: true,
      targets: targets.map((account) => account.id),
      text: request.text,
    };
  }

  const results = await postToAll(targets, {
    text: request.text,
    title: request.title,
    media: request.mediaPaths?.length ? loadAllMedia(request.mediaPaths) : undefined,
    thread: request.thread ?? loadSettings().threadByDefault,
    signature: loadSettings().signature || undefined,
  });

  return {
    summary: summarize(results),
    results: results.map((result) => ({
      account: result.account.id,
      ok: result.ok,
      id: result.posts[0]?.id,
      url: result.posts[0]?.url,
      error: result.error,
    })),
  };
}

export function schedule(request: PostRequest & { at: string }) {
  const at = new Date(request.at);
  if (Number.isNaN(at.getTime())) throw new Error(`"${request.at}" is not a date myna can read.`);
  const targets = resolveTargets(request.to ?? loadSettings().defaultTargets);

  return enqueue({
    scheduledFor: at.toISOString(),
    targets: targets.map((account) => account.id),
    text: request.text,
    title: request.title,
    mediaPaths: request.mediaPaths,
    thread: request.thread ?? loadSettings().threadByDefault,
  });
}

export const queue = () => listQueue();
export const cancel = (id: string) => removeQueued(id);
export const history = (limit = 50) => listHistory().slice(0, limit);

export async function write(options: { prompt?: string; url?: string; to?: string }) {
  const check = writerAvailable();
  if (!check.ok) throw new Error(check.reason!);

  const networkIds = options.to
    ? [...new Set(resolveTargets(options.to).map((account) => account.network))]
    : [];
  return draft({ prompt: options.prompt, url: options.url, networks: networkIds });
}

export async function graphicCopy(input: string) {
  const check = writerAvailable();
  if (!check.ok) throw new Error(check.reason!);
  return infographicCopy(/^https?:\/\//.test(input) ? { url: input } : { prompt: input });
}

export async function timeline(spec: string, limit = 20) {
  const account = resolveTargets(spec).find((entry) => requireNetwork(entry.network).timeline);
  if (!account) throw new Error("None of those accounts can read a timeline.");
  return {
    account: account.id,
    items: (await requireNetwork(account.network).timeline!(account, limit)) ?? [],
  };
}
