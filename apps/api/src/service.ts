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
  postPaced,
  removeQueued,
  requireNetwork,
  resolveTargets,
  summarize,
  writerAvailable,
  listUpvotes,
  updateUpvote,
  scanUpvotes,
  runUpvotes,
  topicIndex,
  queriesFor,
  saveSettings,
  loadBrand,
  learnBrand,
  brandPath,
  listPlan,
  pendingPlan,
  getPlanItem,
  removePlanItem,
  generatePlan,
  draftPlanItem,
  queuePlanItem,
  atomize,
  cadence,
  runAutopilot,
  type PlanItem,
} from "@profullstack/myna-core";

export interface PostRequest {
  text: string;
  to?: string;
  title?: string;
  mediaPaths?: string[];
  /** Per-network options: `video` for a YouTube comment, `subreddit`, `privacy`. */
  extra?: Record<string, string>;
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

  const paced = await postPaced(targets, {
    text: request.text,
    title: request.title,
    media: request.mediaPaths?.length ? loadAllMedia(request.mediaPaths) : undefined,
    thread: request.thread ?? loadSettings().threadByDefault,
    signature: loadSettings().signature || undefined,
    extra: request.extra,
  }, { force: request.extra?.now === "true", mediaPaths: request.mediaPaths });
  const results = paced.results;

  return {
    summary: results.length ? summarize(results) : "nothing sent yet",
    results: results.map((result) => ({
      account: result.account.id,
      ok: result.ok,
      id: result.posts[0]?.id,
      url: result.posts[0]?.url,
      error: result.error,
    })),
    queued: paced.queued.map((entry) => ({ id: entry.id, account: entry.targets[0], at: entry.scheduledFor })),
    skipped: paced.skipped.map((entry) => ({ account: entry.account.id, reason: entry.reason })),
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
    extra: request.extra,
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

export async function search(spec: string, query: string, limit = 10) {
  if (!query.trim()) throw new Error("Give a query: ?q=…");
  const account = resolveTargets(spec).find((entry) => requireNetwork(entry.network).search);
  if (!account) throw new Error("None of those accounts can search.");
  return {
    account: account.id,
    items: await requireNetwork(account.network).search!(account, query, limit),
  };
}

export async function timeline(spec: string, limit = 20) {
  const account = resolveTargets(spec).find((entry) => requireNetwork(entry.network).timeline);
  if (!account) throw new Error("None of those accounts can read a timeline.");
  return {
    account: account.id,
    items: (await requireNetwork(account.network).timeline!(account, limit)) ?? [],
  };
}

/**
 * The upvoter, as the API and the MCP tools both see it.
 *
 * Read the queue, search now, cast what is due, and look at what myna thinks
 * you are about. The switch lives here too, because an assistant asked to
 * "start amplifying" should not have to tell somebody to go and run a CLI.
 */
export function upvoteQueue(status?: string) {
  const items = listUpvotes();
  const wanted = status?.trim().toLowerCase();
  const list = wanted && wanted !== "all" ? items.filter((item) => item.status === wanted) : items;
  const settings = loadSettings().upvote;
  return {
    enabled: settings.enabled,
    settings,
    pending: items.filter((item) => item.status === "pending").length,
    items: list.map((item) => ({
      id: item.id,
      account: item.accountId,
      network: item.network,
      action: item.action,
      handle: item.handle,
      score: item.score,
      matched: item.matched,
      post: { id: item.postId, url: item.postUrl, text: item.postText, at: item.postedAt },
      reply: item.reply,
      link: item.link,
      status: item.status,
      dueAt: item.dueAt,
      doneAt: item.doneAt,
      error: item.error,
      reason: item.reason,
    })),
  };
}

/** What myna thinks we are about, and the searches that follow from it. */
export function upvoteTopics() {
  const settings = loadSettings().upvote;
  const index = topicIndex(listHistory(), { days: settings.topicDays });
  return {
    days: settings.topicDays,
    topics: index.topics.map((topic) => ({ term: topic.term, weight: Number(topic.weight.toFixed(3)), posts: topic.posts })),
    queries: queriesFor(index, settings.queriesPerScan),
  };
}

export async function upvoteScan() {
  const result = await scanUpvotes();
  return {
    read: result.read,
    queries: result.queries,
    skipped: result.skipped,
    queued: result.queued.map((item) => ({
      id: item.id,
      account: item.accountId,
      action: item.action,
      handle: item.handle,
      score: item.score,
      url: item.postUrl,
      reply: item.reply,
    })),
  };
}

export async function upvoteSend(options: { limit?: number; dryRun?: boolean; networks?: string[] } = {}) {
  const result = await runUpvotes({
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.networks?.length ? { networks: options.networks } : {}),
  });
  return {
    cast: result.done.length,
    held: [...new Set(result.held)],
    items: result.done.map((item) => ({
      id: item.id,
      account: item.accountId,
      action: item.action,
      handle: item.handle,
      url: item.result?.url ?? item.postUrl,
      already: item.result?.already ?? false,
      status: item.status,
      error: item.error,
    })),
  };
}

/** Turn the whole thing on or off. */
export function upvoteEnabled(enabled: boolean) {
  const settings = loadSettings();
  settings.upvote.enabled = enabled;
  saveSettings(settings);
  return { enabled };
}

/** Drop one queued action, or change the reply it carries. */
export function upvoteEdit(id: string, patch: { skip?: boolean; reply?: string }) {
  const item = patch.skip
    ? updateUpvote(id, { status: "skipped", reason: "skipped over the API" })
    : patch.reply
      ? updateUpvote(id, { reply: patch.reply, drafted: "template", action: "reply" })
      : undefined;
  if (!item) throw new Error(`No queued action called ${id}.`);
  return { id: item.id, status: item.status, action: item.action, reply: item.reply };
}


/**
 * The brand, the plan, and the autopilot.
 *
 * Same shape as the CLI and the MCP tools, because the CLI is the spec. The
 * plan layer is deliberately separate from the queue: a plan item is a subject
 * and an angle on a date with no copy, and only `planQueue` turns one into a
 * scheduled post.
 */
const planView = (item: PlanItem) => ({
  id: item.id,
  forDate: item.forDate,
  status: item.status,
  pillar: item.pillar,
  angle: item.angle,
  source: item.source?.url ?? item.source?.path,
  drafted: Boolean(item.text),
  text: item.text,
  queuedPostId: item.queuedPostId,
});

export function brand() {
  const found = loadBrand();
  if (!found) return { brand: null, path: brandPath() };
  return {
    path: brandPath(),
    brand: {
      name: found.name,
      audience: found.audience,
      positioning: found.positioning,
      voice: found.voice,
      pillars: found.pillars,
      avoid: found.avoid,
      links: found.links,
    },
  };
}

export async function brandLearn(body: { url?: unknown; limit?: unknown }) {
  const result = await learnBrand({
    url: typeof body.url === "string" ? body.url : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  });
  return { read: result.read, sources: result.sources, ...brand() };
}

export function plan(status?: string) {
  const wanted = (status ?? "").toLowerCase();
  const items = wanted === "all" ? listPlan() : wanted ? listPlan().filter((item) => item.status === wanted) : pendingPlan();
  return { plan: items.map(planView) };
}

export async function planGenerate(body: { days?: unknown; perWeek?: unknown; to?: unknown }) {
  const result = await generatePlan({
    days: typeof body.days === "number" ? body.days : undefined,
    perWeek: typeof body.perWeek === "number" ? body.perWeek : undefined,
    targets: typeof body.to === "string" && body.to ? [body.to] : undefined,
  });
  return { planned: result.items.length, alreadyPlanned: result.duplicates, plan: result.items.map(planView) };
}

export async function planAtomize(body: { source?: unknown; angles?: unknown; overDays?: unknown; dryRun?: unknown; to?: unknown }) {
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) throw new Error("atomize needs a source: a URL, or a path to a file on this machine.");
  const result = await atomize({
    source,
    angles: typeof body.angles === "number" ? body.angles : undefined,
    overDays: typeof body.overDays === "number" ? body.overDays : undefined,
    dryRun: Boolean(body.dryRun),
    targets: typeof body.to === "string" && body.to ? [body.to] : undefined,
  });
  return {
    title: result.title,
    source: result.url ?? result.path,
    dryRun: Boolean(body.dryRun),
    planned: result.items.length,
    alreadyPlanned: result.duplicates,
    plan: result.items.map(planView),
    angles: result.angles,
  };
}

export async function planDraft(id: string, force = false) {
  const item = getPlanItem(id);
  if (!item) throw new Error(`No plan item ${id}.`);
  if (item.text && !force) return { item: planView(item), note: "Already drafted. Pass force to rewrite it." };
  return { item: planView(await draftPlanItem({ ...item, text: undefined })) };
}

export async function planQueue(id: string, body: { at?: unknown; to?: unknown } = {}) {
  const item = getPlanItem(id);
  if (!item) throw new Error(`No plan item ${id}.`);
  const at = typeof body.at === "string" ? Date.parse(body.at) : Number.NaN;
  if (typeof body.at === "string" && Number.isNaN(at)) throw new Error(`I could not read "${body.at}" as a time. Use an ISO timestamp.`);
  const result = await queuePlanItem(item, {
    from: Number.isNaN(at) ? undefined : at,
    targets: typeof body.to === "string" && body.to ? [body.to] : undefined,
  });
  return {
    item: planView(result.item),
    queued: result.queued.map((post) => ({ id: post.id, scheduledFor: post.scheduledFor, targets: post.targets })),
    skipped: result.skipped,
  };
}

export function planDrop(id: string) {
  if (!removePlanItem(id)) throw new Error(`No plan item ${id}.`);
  return { dropped: id };
}

export function autopilot() {
  const settings = loadSettings();
  const state = cadence(new Date(), settings);
  return {
    autopilot: { ...settings.autopilot, to: settings.autopilot.to || settings.defaultTargets },
    cadence: state,
    planOpen: pendingPlan().length,
    wouldAct: settings.autopilot.enabled && state.deficit > 0,
  };
}

export async function autopilotRun(dryRun = false) {
  const turn = await runAutopilot({ dryRun });
  return {
    idle: turn.idle,
    reason: turn.reason,
    cadence: turn.cadence,
    item: turn.item ? planView(turn.item) : undefined,
    queued: turn.queued,
    planned: turn.planned,
  };
}

/** Turn the autopilot on or off. */
export function autopilotEnabled(enabled: boolean) {
  const settings = loadSettings();
  settings.autopilot = { ...settings.autopilot, enabled };
  saveSettings(settings);
  return { enabled };
}
