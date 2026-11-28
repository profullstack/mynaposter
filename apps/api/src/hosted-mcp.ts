/**
 * The hosted MCP for every myna cloud account (Claude, ChatGPT and any MCP
 * client, signed in with OAuth).
 *
 * The operator's server (packages/mcp) posts as the instance's own connected
 * accounts, so only operators may call it. Everyone else gets these tools,
 * which act on THEIR OWN cloud data and never hold their social credentials
 * (the server never stores them; see the accounts table note in schema.sql):
 *
 *   - AI: read a site, write post variations for a network, suggest where to
 *     post. One credit per call (free monthly allowance, then pay as you go).
 *   - Hand-off cards: save a ready-to-post draft as a card with a link the
 *     person opens on their phone to copy, open the network and mark done.
 *     Their own myna (TUI/CLI/desktop) posts automatically.
 *   - Credits: balance and a CoinPay top-up link.
 */
import {
  fetchPage,
  readSiteFiles,
  projectCopy,
  variations,
  suggestPlaces,
  writerAvailable,
  type ProjectBrief,
} from "@profullstack/myna-core";
import * as handoff from "./handoff.ts";
import * as credits from "./credits.ts";
import * as webhooks from "./webhooks.ts";

export interface HostedUser {
  id: string;
  email: string;
}

type Json = Record<string, unknown>;
type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

const project = {
  type: "object",
  description: "What the posts are about.",
  properties: {
    name: { type: "string", description: "Product, project or topic name." },
    description: { type: "string", description: "What it is and why it matters (a few sentences)." },
    url: { type: "string", description: "Link to include or read from (https://...)." },
    audience: { type: "string", description: "Who it is for." },
    tone: { type: "string", description: "e.g. friendly, technical, playful, formal." },
    features: { type: "array", items: { type: "string" }, description: "Up to 10 points worth mentioning." },
  },
  required: ["name"],
} as const;

const NETWORKS = ["bluesky", "mastodon", "linkedin", "x", "threads", "facebook", "reddit", "hackernews", "devto", "producthunt", "nostr", "telegram", "discord"];

interface HostedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  hints: Hints;
  /** Credits spent per call. */
  cost: number;
  run(user: HostedUser, args: Json): Promise<unknown>;
}

const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_WEB: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const AI: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CREATE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DELETE: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function briefOf(input: unknown): ProjectBrief | null {
  const p = (input && typeof input === "object" ? input : null) as Json | null;
  if (!p || typeof p.name !== "string" || !p.name.trim()) return null;
  return {
    name: p.name.trim().slice(0, 200),
    description: str(p.description, 2000),
    audience: str(p.audience, 500) || undefined,
    features: Array.isArray(p.features) ? p.features.map(String).slice(0, 10) : undefined,
    tone: str(p.tone, 40) || undefined,
    url: typeof p.url === "string" && /^https?:\/\//.test(p.url) ? p.url.slice(0, 500) : undefined,
  };
}

const URL_SHAPE = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;

export const HOSTED_TOOLS: HostedTool[] = [
  {
    name: "myna_account",
    title: "Account and credits",
    description:
      "Your myna account: email, credits left this month, the free monthly allowance, what each tool costs, and how to buy more. Call this first when the user asks about limits or billing.",
    inputSchema: { type: "object", properties: {} },
    hints: READ,
    cost: 0,
    async run(user) {
      const left = await credits.balance(user.id);
      return {
        email: user.email,
        credits: left,
        free_monthly: credits.freeMonthly(),
        costs: { myna_analyze_site: 1, myna_write_posts: 1, myna_suggest_places: 1, everything_else: 0 },
        buy: credits.coinpayConfigured()
          ? { tool: "myna_buy_credits", packs_usd: credits.PACKS_USD, usd_per_credit: credits.USD_PER_CREDIT, pricing: "https://mynaposter.com/pricing" }
          : { pricing: "https://mynaposter.com/pricing" },
      };
    },
  },
  {
    name: "myna_analyze_site",
    title: "Read a website",
    description:
      "Read a product's website (its page, llms.txt and OpenProfile when present) and return a project brief: name, one-line pitch, description, audience and key points. Feed the result to myna_write_posts. Costs 1 credit.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The site to read, e.g. https://example.com" } }, required: ["url"] },
    hints: READ_WEB,
    cost: 1,
    async run(_user, args) {
      const url = str(args.url, 500);
      if (!url || !URL_SHAPE.test(url)) throw new Error("myna_analyze_site needs a URL like https://example.com");
      const [files, page] = await Promise.all([readSiteFiles(url), fetchPage(url)]);
      const copy = await projectCopy({ page, openprofile: files.openprofile, llms: files.llms });
      return { ...copy, url: page.url, image: page.image || null, read_from: [...files.readFrom, "html"] };
    },
  },
  {
    name: "myna_write_posts",
    title: "Write social posts",
    description:
      "Write ready-to-post variations of a social post (or a reply comment) about a project, shaped for one network's length and style. Nothing is posted: show them to the user, then save the chosen one with myna_save_handoff or post it from their own myna. Costs 1 credit.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        network: { type: "string", enum: NETWORKS, description: "Network to shape the post for (length, hashtags, tone)." },
        kind: { type: "string", enum: ["post", "comment"], description: "A top-level post (default) or a reply to the context below." },
        count: { type: "integer", minimum: 1, maximum: 10, description: "How many variations (default 5)." },
        include_link: { type: "boolean", description: "Put project.url in the post." },
        title: { type: "boolean", description: "Also write a title (for Reddit, Hacker News, dev.to)." },
        context: {
          type: "object",
          description: "For a comment: the post being replied to.",
          properties: { title: { type: "string" }, content: { type: "string" }, url: { type: "string" } },
        },
      },
      required: ["project"],
    },
    hints: AI,
    cost: 1,
    async run(_user, args) {
      const p = briefOf(args.project);
      if (!p) throw new Error("myna_write_posts needs project.name");
      const raw = args.context && typeof args.context === "object" ? (args.context as Json) : null;
      const result = await variations({
        kind: args.kind === "comment" ? "comment" : "post",
        network: typeof args.network === "string" ? args.network : null,
        count: Math.max(1, Math.min(10, Number(args.count) || 5)),
        project: p,
        context: raw ? { title: str(raw.title, 300) || undefined, content: str(raw.content, 4000) || undefined, url: str(raw.url, 500) || undefined } : null,
        includeLink: Boolean(args.include_link),
        title: Boolean(args.title),
      });
      return { title: result.title, variations: result.variations, network: result.network };
    },
  },
  {
    name: "myna_suggest_places",
    title: "Suggest where to post",
    description:
      "Suggest where a project should be posted: networks, communities and keywords, plus forums and directories that fit. Costs 1 credit.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
    hints: AI,
    cost: 1,
    async run(_user, args) {
      const p = briefOf(args.project);
      if (!p) throw new Error("myna_suggest_places needs project.name");
      const places = await suggestPlaces(p);
      const submit = `https://nichedb.dev/submit${p.url ? `?url=${encodeURIComponent(p.url)}` : ""}`;
      return { ...places, directories: [{ name: "nichedb.dev", url: submit }] };
    },
  },
  {
    name: "myna_save_handoff",
    title: "Save a post as a hand-off card",
    description:
      "Save a ready-to-post draft as a hand-off card: a private link (myna.../handoff/<id>) the user opens on any device to copy the text, open the network and mark it done. Use it after the user picks a post. Returns the card and its link. Free.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "Where it goes, e.g. 'linkedin', 'r/selfhosted', 'Hacker News'." },
        title: { type: "string", description: "Short card title (or the post title for Reddit/HN)." },
        text: { type: "string", description: "The exact text to post." },
        open_url: { type: "string", description: "Where to post it (compose or submit URL), https://..." },
        steps: { type: "array", items: { type: "string" }, description: "Optional steps, one per line." },
        account: { type: "string", description: "Optional: which of the user's accounts posts it." },
      },
      required: ["place", "text"],
    },
    hints: CREATE,
    cost: 0,
    async run(user, args) {
      const card = await handoff.createHandoff(user.id, {
        place: str(args.place, 120),
        title: str(args.title, 300) || str(args.place, 120),
        text: str(args.text, 10_000),
        openUrl: typeof args.open_url === "string" && /^https:\/\//.test(args.open_url) ? args.open_url.slice(0, 1000) : undefined,
        steps: Array.isArray(args.steps) ? args.steps.map(String).slice(0, 20) : undefined,
        account: str(args.account, 200) || undefined,
      } as never);
      await webhooks.emit(user.id, "handoff.created", card, `handoff:${card.id}`).catch(() => {});
      return { handoff: card };
    },
  },
  {
    name: "myna_list_handoffs",
    title: "List hand-off cards",
    description: "The user's hand-off cards, newest first: open ones by default, or all with all=true. Free.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include cards already marked done." } } },
    hints: READ,
    cost: 0,
    async run(user, args) {
      const cards = await handoff.listHandoffs(user.id, { all: args.all === true });
      return { handoffs: cards, total: cards.length };
    },
  },
  {
    name: "myna_mark_handoff_done",
    title: "Mark a hand-off card done",
    description: "Mark one of the user's hand-off cards done (or not done again with done=false), e.g. after they posted it. Free.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, done: { type: "boolean" } }, required: ["id"] },
    hints: UPDATE,
    cost: 0,
    async run(user, args) {
      const id = str(args.id, 64);
      const card = await handoff.getHandoff(id);
      if (!card || !(await handoff.listHandoffs(user.id, { all: true })).some((c) => c.id === id)) throw new Error("No such hand-off card on your account.");
      return { handoff: await handoff.finishHandoff(id, args.done !== false) };
    },
  },
  {
    name: "myna_delete_handoff",
    title: "Delete a hand-off card",
    description: "Delete one of the user's hand-off cards. Its link stops working. Free.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    hints: DELETE,
    cost: 0,
    async run(user, args) {
      const removed = await handoff.removeHandoff(str(args.id, 64), user.id).catch(() => false);
      if (!removed) throw new Error("No such hand-off card on your account.");
      return { deleted: true };
    },
  },
  {
    name: "myna_buy_credits",
    title: "Buy credits",
    description:
      "Make a CoinPay checkout link to buy credits (1 credit = 1 US cent; packs of 5, 20 or 50 USD, any amount from 5 to 500). Pay with crypto or PayPal; credits land as soon as the payment confirms and never expire. Give the link to the user; nothing is charged until they pay.",
    inputSchema: { type: "object", properties: { usd: { type: "number", minimum: 5, maximum: 500, description: "Amount in USD (default 5)." } } },
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    cost: 0,
    async run(user, args) {
      const out = await credits.startTopup(user, Number(args.usd) || 5);
      return { checkout_url: out.checkoutUrl, usd: out.usd, credits: out.credits, note: "Open the link to pay. Credits appear after the payment confirms; check with myna_account." };
    },
  },
];

/** tools/list for a signed-in non-operator: names, schemas, titles and the annotations directories require. */
export function hostedToolList(): object[] {
  return HOSTED_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, ...t.hints },
  }));
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(value && typeof value === "object" && !isError ? { structuredContent: value } : {}),
  ...(isError ? { isError: true } : {}),
});

/** Run one hosted tool for `user`, metering it. Always resolves to an MCP tool result. */
export async function callHostedTool(user: HostedUser, name: string, args: Json): Promise<object> {
  const tool = HOSTED_TOOLS.find((t) => t.name === name);
  if (!tool) return text(`Unknown tool ${name}. Tools: ${HOSTED_TOOLS.map((t) => t.name).join(", ")}`, true);
  if (tool.cost > 0) {
    const writer = writerAvailable();
    if (!writer.ok) return text(writer.reason ?? "The writer is off on this server right now; try again later.", true);
    let spent: { ok: boolean; balance: number };
    try {
      spent = await credits.spend(user.id, tool.cost, name);
    } catch (error) {
      console.warn(`[hosted-mcp] credits for ${name}: ${(error as Error).message}`);
      return text("Credits are unavailable for a moment; try again shortly.", true);
    }
    if (!spent.ok) {
      return text(
        `Out of credits (${spent.balance} left; ${name} costs ${tool.cost}). Free credits refill on the 1st of each month (UTC). ` +
          `Buy more with myna_buy_credits or at https://mynaposter.com/pricing.`,
        true,
      );
    }
    try {
      return text({ ...((await tool.run(user, args)) as Json), credits_left: spent.balance });
    } catch (error) {
      await credits.refund(user.id, tool.cost, `${name} failed`).catch(() => {});
      return text(`${name} failed: ${(error as Error).message} (your credit was refunded)`, true);
    }
  }
  try {
    return text(await tool.run(user, args));
  } catch (error) {
    return text((error as Error).message, true);
  }
}
