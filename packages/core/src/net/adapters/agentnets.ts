/**
 * Networks built for AI agents: Moltbook, The Colony, 4claw, MoltExchange,
 * and ugig.net's feed.
 *
 * Each one publishes a skill.md for agents and authenticates with a bearer
 * key. Moltbook, The Colony and 4claw also hand a key to anyone who asks over
 * the API, so login registers a new agent when no key is pasted — the key is
 * printed once and stored in the vault with the account. MoltExchange and
 * Moltbook then want a person to verify the agent before it may post; that
 * step happens in a browser and login says so.
 */
import type { LoginContext, Network, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { solveChallenge } from "./moltbook-challenge.ts";

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const firstLine = (text: string): string => text.split("\n")[0].replace(/^#+\s*/, "").trim();
const tagsOf = (extra?: Record<string, string>): string[] =>
  (extra?.tags ?? "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);

/** The key is shown once by every one of these services; say so loudly. */
function announceKey(ctx: LoginContext, service: string, key: string): void {
  ctx.report(`${service} issued an API key. It is saved to the myna vault with this account; it is not shown again by ${service}.`);
  ctx.report(`Key ends in …${key.slice(-6)}`);
}

// ─── Moltbook ────────────────────────────────────────────────────────────────

const MOLTBOOK = "https://www.moltbook.com/api/v1";

interface MoltbookVerification {
  verification_code: string;
  challenge_text: string;
}

/**
 * Answer the challenge a new post comes back with. The rule-based reader goes
 * first; a model is only asked when it declines, and a wrong answer is never
 * sent on a guess.
 */
async function answerChallenge(challenge: string): Promise<string> {
  const solved = solveChallenge(challenge);
  if (solved) return solved;
  const { providerComplete } = await import("../../ai/writer.ts");
  const reply = await providerComplete(
    "You decode obfuscated arithmetic word problems. The text has alternating caps, stray symbols and broken words. It contains exactly two numbers and one operation. Reply with only the result to two decimal places, like 15.00.",
    challenge,
    50,
  );
  const number = reply.match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!number) throw new Error(`Moltbook's verification challenge was not solved: "${challenge}"`);
  return Number(number).toFixed(2);
}

export const moltbook: Network = {
  id: "moltbook",
  name: "Moltbook",
  category: "forum",
  blurb: "The social network for AI agents. Posts go to a submolt and need a title. Verification challenges are solved for you.",
  auth: {
    kind: "token",
    note:
      "Paste an existing key (moltbook_…), or leave it blank and give a name to register a new agent. " +
      "A new agent posts only after its human opens the claim link and verifies with a post on X.",
    docsUrl: "https://www.moltbook.com/skill.md",
    fields: [
      { key: "apiKey", label: "API key", secret: true, optional: true, help: "Blank registers a new agent." },
      { key: "name", label: "Agent name (to register)", optional: true },
      { key: "description", label: "What the agent does (to register)", optional: true },
      { key: "submolt", label: "Default submolt", optional: true, default: "general" },
    ],
  },
  caps: { charLimit: 40000, mediaLimit: 0, threads: false, delete: true, timeline: true, notifications: false, stats: false, needsTitle: true, upvote: true },

  async login(input, ctx) {
    let apiKey = input.apiKey?.trim();
    if (!apiKey) {
      if (!input.name) throw new Error("Moltbook needs an API key, or a name to register a new agent.");
      const registered = await postJson<{ agent: { api_key: string; claim_url: string; verification_code: string } }>(
        `${MOLTBOOK}/agents/register`,
        { name: input.name, description: input.description || input.name },
      );
      apiKey = registered.agent.api_key;
      announceKey(ctx, "Moltbook", apiKey);
      ctx.report(`Claim it: ${registered.agent.claim_url} (verification code ${registered.agent.verification_code})`);
      await ctx.openUrl(registered.agent.claim_url);
    }
    const me = await getJson<{ agent?: { name: string; display_name?: string }; name?: string }>(`${MOLTBOOK}/agents/me`, { headers: bearer(apiKey) });
    const agent = me.agent ?? (me as { name: string });
    return { handle: agent.name, displayName: me.agent?.display_name ?? agent.name, creds: { apiKey }, meta: { submolt: input.submolt || "general" } };
  },

  async post(account, input) {
    const submolt = input.extra?.submolt || input.extra?.community || account.meta.submolt || "general";
    const created = await postJson<{ post: { id: string; verification_status?: string; verification?: MoltbookVerification } }>(
      `${MOLTBOOK}/posts`,
      {
        submolt_name: submolt,
        title: (input.title || firstLine(input.text)).slice(0, 300),
        content: input.text,
        ...(input.extra?.url ? { url: input.extra.url, type: "link" } : {}),
      },
      { headers: bearer(account.creds.apiKey) },
    );
    const post = created.post;
    if (post.verification && post.verification_status !== "verified") {
      const answer = await answerChallenge(post.verification.challenge_text);
      const verified = await postJson<{ success: boolean; error?: string }>(
        `${MOLTBOOK}/verify`,
        { verification_code: post.verification.verification_code, answer },
        { headers: bearer(account.creds.apiKey) },
      );
      if (!verified.success) throw new Error(`Moltbook kept post ${post.id} unpublished: ${verified.error ?? "challenge answer rejected"} (answered ${answer}).`);
    }
    return { id: post.id, url: `https://www.moltbook.com/post/${post.id}` };
  },

  async remove(account, id) {
    await request(`${MOLTBOOK}/posts/${id}`, { method: "DELETE", headers: bearer(account.creds.apiKey) });
  },

  async timeline(account, limit) {
    const feed = await getJson<{ posts: Record<string, any>[] }>(`${MOLTBOOK}/posts?sort=new&limit=${limit}`, { headers: bearer(account.creds.apiKey) });
    return feed.posts.map((post): TimelineItem => ({
      id: post.id,
      author: post.author?.name ?? post.author_name ?? "",
      handle: post.author?.name ?? post.author_name ?? "",
      text: `${post.title}${post.content ? `\n${post.content}` : ""}`,
      createdAt: post.created_at ?? "",
      url: `https://www.moltbook.com/post/${post.id}`,
      likes: post.upvotes,
      replies: post.comment_count,
    }));
  },

  async upvote(account, ref, direction = 1) {
    const id = ref.replace(/^.*\/post\//, "").replace(/[/?#].*$/, "");
    await postJson(`${MOLTBOOK}/posts/${id}/${direction ? "upvote" : "downvote"}`, {}, { headers: bearer(account.creds.apiKey) });
    return { url: `https://www.moltbook.com/post/${id}` };
  },
};

// ─── The Colony ──────────────────────────────────────────────────────────────

const COLONY = "https://thecolony.ai/api/v1";

/** The API key is long-lived; every session trades it for a 24-hour JWT. */
async function colonyToken(apiKey: string): Promise<string> {
  const token = await postJson<{ access_token: string }>(`${COLONY}/auth/token`, { api_key: apiKey });
  return token.access_token;
}

/** Colonies are addressed by uuid; people know them by name. */
async function colonyId(nameOrId: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  const colonies = await getJson<{ id: string; name: string }[]>(`${COLONY}/colonies`);
  const found = colonies.find((colony) => colony.name.toLowerCase() === nameOrId.toLowerCase());
  if (!found) throw new Error(`No colony named "${nameOrId}". Try one of: ${colonies.map((colony) => colony.name).join(", ")}`);
  return found.id;
}

const COLONY_TYPES = new Set(["finding", "question", "analysis", "human_request", "discussion", "paid_task", "poll"]);

export const colony: Network = {
  id: "colony",
  name: "The Colony",
  category: "forum",
  blurb: "Forum for AI agents and humans. Posts go to a colony and need a title. Registers itself if you have no key.",
  auth: {
    kind: "token",
    note: "Paste an existing key (col_…), or leave it blank and give a username to register a new agent; registration completes on its own.",
    docsUrl: "https://thecolony.cc/skill.md",
    fields: [
      { key: "apiKey", label: "API key", secret: true, optional: true, help: "Blank registers a new agent." },
      { key: "username", label: "Username (to register)", optional: true },
      { key: "bio", label: "Bio (to register)", optional: true },
      { key: "colony", label: "Default colony", optional: true, default: "general" },
    ],
  },
  caps: { charLimit: 50000, mediaLimit: 0, threads: false, delete: true, timeline: false, notifications: false, stats: false, needsTitle: true },

  async login(input, ctx) {
    let apiKey = input.apiKey?.trim();
    if (!apiKey) {
      if (!input.username) throw new Error("The Colony needs an API key, or a username to register a new agent.");
      const begun = await postJson<{ api_key: string; claim_token: string }>(`${COLONY}/auth/register/begin`, {
        username: input.username,
        display_name: input.username,
        bio: input.bio || input.username,
        registered_via: "myna",
      });
      apiKey = begun.api_key;
      // Step two proves the key was kept: its last six characters.
      await postJson(`${COLONY}/auth/register/confirm`, { claim_token: begun.claim_token, key_fingerprint: apiKey.slice(-6) });
      announceKey(ctx, "The Colony", apiKey);
    }
    const me = await getJson<{ username: string; display_name?: string }>(`${COLONY}/users/me`, { headers: bearer(await colonyToken(apiKey)) });
    return { handle: me.username, displayName: me.display_name ?? me.username, creds: { apiKey }, meta: { colony: input.colony || "general" } };
  },

  async post(account, input) {
    const token = await colonyToken(account.creds.apiKey);
    const type = input.extra?.postType ?? input.extra?.kind;
    const created = await postJson<{ id: string }>(
      `${COLONY}/posts`,
      {
        colony_id: await colonyId(input.extra?.colony || input.extra?.community || account.meta.colony || "general"),
        title: (input.title || firstLine(input.text)).slice(0, 300),
        body: input.text,
        ...(tagsOf(input.extra).length ? { tags: tagsOf(input.extra) } : {}),
        ...(type && COLONY_TYPES.has(type) ? { post_type: type } : {}),
      },
      { headers: bearer(token) },
    );
    return { id: created.id, url: `https://thecolony.ai/post/${created.id}` };
  },

  async remove(account, id) {
    await request(`${COLONY}/posts/${id}`, { method: "DELETE", headers: bearer(await colonyToken(account.creds.apiKey)) });
  },
};

// ─── 4claw ───────────────────────────────────────────────────────────────────

const FOURCLAW = "https://www.4claw.org/api/v1";

export const fourclaw: Network = {
  id: "4claw",
  name: "4claw",
  category: "forum",
  blurb: "Moderated imageboard for AI agents. A post starts a thread on a board and needs a title.",
  auth: {
    kind: "token",
    note: "Paste an existing key (clawchan_…) with its agent name, or leave the key blank to register that name (letters, digits, underscore).",
    docsUrl: "https://www.4claw.org/skill.md",
    fields: [
      { key: "apiKey", label: "API key", secret: true, optional: true, help: "Blank registers a new agent." },
      { key: "name", label: "Agent name" },
      { key: "description", label: "What the agent does (to register)", optional: true },
      { key: "board", label: "Default board", optional: true, placeholder: "singularity" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: false, timeline: false, notifications: false, stats: false, needsTitle: true },

  async login(input, ctx) {
    let apiKey = input.apiKey?.trim();
    let name = input.name;
    if (!apiKey) {
      const registered = await postJson<{ agent: { api_key: string; name: string } }>(`${FOURCLAW}/agents/register`, {
        name: input.name,
        description: (input.description || input.name).slice(0, 280),
      });
      apiKey = registered.agent.api_key;
      name = registered.agent.name;
      announceKey(ctx, "4claw", apiKey);
    }
    // There is no "who am I"; listing the boards is what proves the key works.
    const boards = await getJson<{ boards?: { slug: string }[] } | { slug: string }[]>(`${FOURCLAW}/boards`, { headers: bearer(apiKey) });
    const slugs = (Array.isArray(boards) ? boards : (boards.boards ?? [])).map((board) => board.slug);
    if (input.board && slugs.length && !slugs.includes(input.board)) {
      throw new Error(`4claw has no board "${input.board}". Boards: ${slugs.join(", ")}`);
    }
    return { handle: name, displayName: name, creds: { apiKey }, meta: { board: input.board ?? "" } };
  },

  async post(account, input) {
    const board = input.extra?.board || input.extra?.community || account.meta.board;
    if (!board) throw new Error("4claw needs a board. Pass --board <slug> or set one on the account.");
    if (input.replyTo) {
      const reply = await postJson<{ reply?: { id: string } }>(
        `${FOURCLAW}/threads/${input.replyTo}/replies`,
        { content: input.text, anon: false, bump: true },
        { headers: bearer(account.creds.apiKey) },
      );
      return { id: reply.reply?.id ?? input.replyTo, url: `https://www.4claw.org/t/${input.replyTo}` };
    }
    const created = await postJson<{ thread: { id: string } }>(
      `${FOURCLAW}/boards/${encodeURIComponent(board)}/threads`,
      { title: input.title || firstLine(input.text), content: input.text, anon: false },
      { headers: bearer(account.creds.apiKey) },
    );
    return { id: created.thread.id, url: `https://www.4claw.org/t/${created.thread.id}` };
  },
};

// ─── MoltExchange ────────────────────────────────────────────────────────────

const MOLTEXCHANGE = "https://api.moltexchange.ai/v1";

export const moltexchange: Network = {
  id: "moltexchange",
  name: "MoltExchange",
  category: "forum",
  blurb: "Q&A for AI agents. A post is a question in an exchange (overflow, openclaw, meta) and needs a title.",
  auth: {
    kind: "token",
    note:
      "Register: POST https://api.moltexchange.ai/v1/agent-signup/init with {\"handle\": \"…\"}, then open the link it returns to verify. " +
      "The key (molt_…) is refused until the agent is verified.",
    docsUrl: "https://api.moltexchange.ai/skill.md",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      { key: "exchange", label: "Default exchange", optional: true, default: "overflow" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: false, timeline: false, notifications: false, stats: false, needsTitle: true, explicitTarget: true },

  async login(input) {
    const me = await getJson<{ agent?: { handle: string; displayName?: string }; handle?: string }>(`${MOLTEXCHANGE}/agents/me`, { headers: bearer(input.apiKey) });
    const handle = me.agent?.handle ?? me.handle;
    if (!handle) throw new Error("MoltExchange accepted the key but did not say whose it is.");
    return { handle, displayName: me.agent?.displayName ?? handle, creds: { apiKey: input.apiKey }, meta: { exchange: input.exchange || "overflow" } };
  },

  async post(account, input) {
    const created = await postJson<{ question?: { id: string; url?: string }; id?: string; url?: string }>(
      `${MOLTEXCHANGE}/questions`,
      {
        exchange: input.extra?.exchange || account.meta.exchange || "overflow",
        title: input.title || firstLine(input.text),
        body: input.text,
        ...(tagsOf(input.extra).length ? { tags: tagsOf(input.extra) } : {}),
      },
      { headers: bearer(account.creds.apiKey) },
    );
    const id = created.question?.id ?? created.id;
    if (!id) throw new Error("MoltExchange returned no question id.");
    return { id, url: created.question?.url ?? created.url };
  },
};

// ─── ugig.net ────────────────────────────────────────────────────────────────

const UGIG = "https://ugig.net/api";

export const ugig: Network = {
  id: "ugig",
  name: "ugig.net",
  category: "minor",
  blurb: "Gig marketplace for agents and humans. Posts to the ugig.net feed; 5000 characters, one link.",
  auth: {
    kind: "token",
    note: "Sign in at ugig.net, then Settings → API keys (or POST /api/api-keys with a session) and paste the ugig_live_… key.",
    docsUrl: "https://ugig.net/skill.md",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
  },
  caps: { charLimit: 5000, mediaLimit: 0, threads: false, delete: true, timeline: true, notifications: false, stats: false },

  async login(input) {
    const me = await getJson<{ profile: { username: string; full_name?: string; agent_name?: string } }>(`${UGIG}/profile`, { headers: bearer(input.apiKey) });
    const profile = me.profile;
    return { handle: profile.username, displayName: profile.agent_name || profile.full_name || profile.username, creds: { apiKey: input.apiKey }, meta: {} };
  },

  async post(account, input) {
    const url = input.extra?.url ?? input.text.match(/https?:\/\/\S+/)?.[0];
    const created = await postJson<{ post: { id: string } }>(
      `${UGIG}/posts`,
      {
        content: input.text,
        ...(url ? { url } : {}),
        tags: tagsOf(input.extra).slice(0, 10),
      },
      { headers: bearer(account.creds.apiKey) },
    );
    return { id: created.post.id, url: `https://ugig.net/post/${created.post.id}` };
  },

  async remove(account, id) {
    await request(`${UGIG}/posts/${id}`, { method: "DELETE", headers: bearer(account.creds.apiKey) });
  },

  async timeline(account, limit) {
    const feed = await getJson<{ posts?: Record<string, any>[] }>(`${UGIG}/feed?sort=new&limit=${limit}`, { headers: bearer(account.creds.apiKey) });
    return (feed.posts ?? []).slice(0, limit).map((post): TimelineItem => ({
      id: post.id,
      author: post.author?.full_name ?? post.author?.username ?? "",
      handle: post.author?.username ?? "",
      text: post.content,
      createdAt: post.created_at ?? "",
      url: `https://ugig.net/post/${post.id}`,
      likes: post.upvotes ?? post.score,
      replies: post.comments_count,
    }));
  },
};
