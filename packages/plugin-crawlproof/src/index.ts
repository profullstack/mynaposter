/**
 * CrawlProof ads for what myna publishes.
 *
 * CrawlProof (crawlproof.com) runs an ad network across the sites that carry
 * its slots. This plugin turns a blog post into a campaign the moment it is
 * published: after `myna post` lands a page on a blog, the page's URL goes to
 * CrawlProof, which reads it, writes the creatives, and starts serving. One
 * command does the same for any URL by hand.
 *
 *   myna crawlproof login                 paste a CrawlProof API token (crp_…)
 *   myna crawlproof ad <url> [--name N] [--budget CENTS] [--draft true]
 *   myna crawlproof ads                   campaigns, newest first
 *   myna crawlproof ads show <ref>        one campaign with its delivery
 *   myna crawlproof ads pause|resume|budget|delete <ref>
 *   myna crawlproof auto on|off           run an ad for every blog post (on)
 *   myna crawlproof logout
 *
 * A social post is not a blog post: a tweet about a page does not get its
 * own campaign. Pass `--ad true` on any post to run one for the first URL in
 * it anyway.
 *
 * Only types come from @profullstack/myna-core; everything else arrives
 * through the PluginContext, so this is also a worked example of a plugin
 * that reacts to posting without being a network.
 */
import type { MynaPlugin, PluginContext, PostedEvent } from "@profullstack/myna-core";

export const DEFAULT_URL = "https://crawlproof.com";
/** Cents per day, the same default the CrawlProof dashboard starts a campaign at. */
export const DEFAULT_BUDGET_CENTS = 500;

export interface Campaign {
  id: string;
  ref_slug: string;
  name: string;
  status: string;
  destination_url: string;
  daily_budget_cents?: number;
  dashboard_url?: string;
  creatives?: number;
  /** True when a campaign for this URL already existed and was returned instead. */
  existing?: boolean;
  created_at?: string;
}

interface Secrets {
  token: string;
  url: string;
  auto: boolean;
  budgetCents: number;
}

class CrawlProofError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CrawlProofError";
  }
}

function secretsOf(ctx: PluginContext): Secrets | undefined {
  const stored = ctx.secrets.get();
  if (!stored.token) return undefined;
  return {
    token: stored.token,
    url: (stored.url || DEFAULT_URL).replace(/\/+$/, ""),
    auto: stored.auto !== "off",
    budgetCents: Number(stored.budgetCents) > 0 ? Number(stored.budgetCents) : DEFAULT_BUDGET_CENTS,
  };
}

async function call<T>(secrets: Secrets, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${secrets.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secrets.token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const detail = typeof parsed.error === "string" ? parsed.error : text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw new CrawlProofError(response.status, `${response.status} ${detail || response.statusText}`);
  }
  return parsed as T;
}

export interface AdOptions {
  name?: string;
  budgetCents?: number;
  draft?: boolean;
}

/** Create a campaign for a URL. CrawlProof returns the existing one when there already is one. */
export async function createAd(secrets: Secrets, url: string, options: AdOptions = {}): Promise<Campaign> {
  return call<Campaign>(secrets, "POST", "/api/ads/v1/campaigns", {
    url,
    name: options.name,
    daily_budget_cents: options.budgetCents ?? secrets.budgetCents,
    status: options.draft ? "draft" : "active",
  });
}

export interface CampaignStats {
  impressions: number;
  clicks: number;
  spent_cents: number;
  free_impressions: number;
  free_clicks: number;
  visits: { total: number; days: { day: string; visits: number }[] };
}

/** One campaign by ref slug or id, with its delivery. */
export async function showAd(secrets: Secrets, ref: string): Promise<Campaign & { stats?: CampaignStats }> {
  return call<Campaign & { stats?: CampaignStats }>(secrets, "GET", `/api/ads/v1/campaigns/${encodeURIComponent(ref)}`);
}

/** Change a campaign in place: status, budget, bid, name. */
export async function patchAd(secrets: Secrets, ref: string, patch: Record<string, unknown>): Promise<Campaign> {
  return call<Campaign>(secrets, "PATCH", `/api/ads/v1/campaigns/${encodeURIComponent(ref)}`, patch);
}

/** Remove a campaign, metering included. Pausing keeps the history. */
export async function deleteAd(secrets: Secrets, ref: string): Promise<{ ok: boolean; deleted?: string }> {
  return call<{ ok: boolean; deleted?: string }>(secrets, "DELETE", `/api/ads/v1/campaigns/${encodeURIComponent(ref)}`);
}

export async function listAds(secrets: Secrets, limit = 20): Promise<Campaign[]> {
  const result = await call<{ campaigns?: Campaign[] }>(secrets, "GET", `/api/ads/v1/campaigns?limit=${limit}`);
  return result.campaigns ?? [];
}

const describe = (campaign: Campaign): string =>
  `${campaign.existing ? "already running" : campaign.status} ${campaign.ref_slug} for ${campaign.destination_url}`;

/** The first http(s) URL in a piece of text. */
export function firstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>()"']+/.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
}

/**
 * Which URLs of a post get a campaign: every page a blog target published,
 * or — with `--ad true` — the first URL in the text when no blog was in it.
 */
export function urlsToPromote(event: PostedEvent): string[] {
  const urls = new Set<string>();
  for (const target of event.targets) {
    if (target.ok && target.url && target.category === "blog") urls.add(target.url);
  }
  if (!urls.size && event.extra?.ad === "true") {
    const url = firstUrl(event.text);
    if (url) urls.add(url);
  }
  return [...urls];
}

const plugin: MynaPlugin = {
  id: "crawlproof",
  name: "CrawlProof ads",
  version: "0.8.1",
  description: "Run a CrawlProof ad campaign for every blog post myna publishes, or for any URL by hand.",

  commands: [
    {
      name: "crawlproof",
      summary: "CrawlProof ads: a campaign for every blog post, or any URL",
      usage: [
        "crawlproof login                       Paste a CrawlProof API token (Social → API tokens)",
        "crawlproof ad <url> [--name N] [--budget CENTS] [--draft true]",
        "crawlproof ads [--limit N]             Campaigns, newest first",
        "crawlproof ads show <ref>              One campaign with its delivery and attributed visits",
        "crawlproof ads pause|resume <ref>      Stop or restart it; the history stays",
        "crawlproof ads budget <ref> <cents>    Daily budget",
        "crawlproof ads delete <ref> --yes      Remove it, metering included",
        "crawlproof auto on|off                 Run an ad for every blog post myna publishes (on by default)",
        "crawlproof budget <cents>              Daily budget for automatic campaigns",
        "crawlproof status | logout",
      ],
      async run(args, ctx) {
        const [sub = "status", ...rest] = args;
        switch (sub) {
          case "login": {
            if (!ctx.ask) throw new Error("crawlproof login needs a keyboard.");
            const url = (typeof ctx.flags.url === "string" && ctx.flags.url) || (await ctx.ask(`CrawlProof URL [${DEFAULT_URL}]`)) || DEFAULT_URL;
            const token = (typeof ctx.flags.token === "string" && ctx.flags.token) || (await ctx.ask("API token (crp_…)", { secret: true }));
            if (!token.trim().startsWith("crp_")) throw new Error("That is not a CrawlProof API token; they start with crp_.");
            const secrets: Secrets = { token: token.trim(), url: url.replace(/\/+$/, ""), auto: true, budgetCents: DEFAULT_BUDGET_CENTS };
            ctx.out("Checking the token…");
            await listAds(secrets, 1);
            ctx.secrets.set({ ...ctx.secrets.get(), token: secrets.token, url: secrets.url });
            ctx.out(`Connected to ${secrets.url}. Every blog post now gets a campaign; \`myna crawlproof auto off\` stops that.`);
            return 0;
          }
          case "logout":
            ctx.secrets.clear();
            ctx.out("Forgotten.");
            return 0;
          case "status": {
            const secrets = secretsOf(ctx);
            if (!secrets) {
              ctx.out("Not connected. Run: myna crawlproof login");
              return 1;
            }
            ctx.out(`${secrets.url}  automatic ads: ${secrets.auto ? "on" : "off"}  budget: ${secrets.budgetCents}¢/day`);
            return 0;
          }
          case "auto": {
            const stored = ctx.secrets.get();
            if (!stored.token) throw new Error("Not connected. Run: myna crawlproof login");
            const value = rest[0];
            if (value !== "on" && value !== "off") throw new Error("Usage: myna crawlproof auto on|off");
            ctx.secrets.set({ ...stored, auto: value });
            ctx.out(value === "on" ? "Every blog post myna publishes gets a campaign." : "Blog posts no longer get a campaign; `myna crawlproof ad <url>` still works.");
            return 0;
          }
          case "budget": {
            const stored = ctx.secrets.get();
            if (!stored.token) throw new Error("Not connected. Run: myna crawlproof login");
            const cents = Number(rest[0]);
            if (!Number.isInteger(cents) || cents < 0) throw new Error("Usage: myna crawlproof budget <cents per day>");
            ctx.secrets.set({ ...stored, budgetCents: String(cents) });
            ctx.out(`Automatic campaigns will run at ${cents}¢ a day.`);
            return 0;
          }
          case "ad": {
            const secrets = secretsOf(ctx);
            if (!secrets) throw new Error("Not connected. Run: myna crawlproof login");
            const url = rest[0];
            if (!/^https?:\/\//.test(url ?? "")) throw new Error("Usage: myna crawlproof ad <url>");
            const campaign = await createAd(secrets, url, {
              name: typeof ctx.flags.name === "string" ? ctx.flags.name : undefined,
              budgetCents: typeof ctx.flags.budget === "string" ? Number(ctx.flags.budget) : undefined,
              draft: ctx.flags.draft === "true" || ctx.flags.draft === true,
            });
            if (ctx.flags.json) ctx.out(JSON.stringify(campaign, null, 2));
            else ctx.out(`${describe(campaign)}${campaign.dashboard_url ? `\n${campaign.dashboard_url}` : ""}`);
            return 0;
          }
          case "ads": {
            const secrets = secretsOf(ctx);
            if (!secrets) throw new Error("Not connected. Run: myna crawlproof login");
            const [verb, ref, value] = rest;
            if (verb === "show" || verb === "pause" || verb === "resume" || verb === "budget" || verb === "delete") {
              if (!ref) throw new Error(`Usage: myna crawlproof ads ${verb} <ref>${verb === "budget" ? " <cents>" : ""}`);
              if (verb === "delete") {
                if (!ctx.flags.yes) throw new Error("delete removes the campaign and its metering; pass --yes. Pause keeps the history.");
                const gone = await deleteAd(secrets, ref);
                ctx.out(`deleted ${gone.deleted ?? ref}`);
                return 0;
              }
              if (verb === "budget") {
                const cents = Number(value);
                if (!Number.isInteger(cents) || cents < 0) throw new Error("Usage: myna crawlproof ads budget <ref> <cents per day>");
                ctx.out(describe(await patchAd(secrets, ref, { daily_budget_cents: cents })));
                return 0;
              }
              if (verb === "pause" || verb === "resume") {
                ctx.out(describe(await patchAd(secrets, ref, { status: verb === "pause" ? "paused" : "active" })));
                return 0;
              }
              const campaign = await showAd(secrets, ref);
              if (ctx.flags.json) {
                ctx.out(JSON.stringify(campaign, null, 2));
                return 0;
              }
              ctx.out(`${describe(campaign)}\n  ${campaign.daily_budget_cents ?? "?"}¢/day${campaign.dashboard_url ? `  ${campaign.dashboard_url}` : ""}`);
              const s = campaign.stats;
              if (s) {
                ctx.out(`  impressions ${s.impressions} (+${s.free_impressions} free) · clicks ${s.clicks} (+${s.free_clicks} free) · spent ${s.spent_cents}¢ · visits attributed ${s.visits?.total ?? 0}`);
                for (const day of (s.visits?.days ?? []).slice(0, 7)) ctx.out(`    ${day.day}  ${day.visits} visit${day.visits === 1 ? "" : "s"}`);
              }
              return 0;
            }
            const limit = typeof ctx.flags.limit === "string" ? Number(ctx.flags.limit) || 20 : 20;
            const campaigns = await listAds(secrets, limit);
            if (ctx.flags.json) {
              ctx.out(JSON.stringify(campaigns, null, 2));
              return 0;
            }
            if (!campaigns.length) ctx.out("No campaigns yet.");
            for (const campaign of campaigns) {
              ctx.out(`${campaign.status.padEnd(8)} ${campaign.ref_slug.padEnd(20)} ${campaign.name}  ${campaign.destination_url}`);
            }
            return 0;
          }
          default:
            throw new Error(`Unknown: myna crawlproof ${sub}. Try login, ad, ads, auto, budget, status or logout.`);
        }
      },
    },
  ],

  async afterPost(event, ctx) {
    const secrets = secretsOf(ctx);
    if (!secrets) return;
    const forced = event.extra?.ad === "true";
    if (!secrets.auto && !forced) return;

    const urls = urlsToPromote(event);
    if (!urls.length) return;

    const lines: string[] = [];
    for (const url of urls) {
      try {
        const campaign = await createAd(secrets, url, { name: event.title });
        lines.push(describe(campaign));
      } catch (error) {
        // One URL failing must not hide the others; say which one.
        lines.push(`no ad for ${url}: ${(error as Error).message}`);
      }
    }
    return lines.join("; ");
  },
};

export default plugin;
