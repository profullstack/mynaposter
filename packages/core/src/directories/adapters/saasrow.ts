/**
 * SaaSRow — a software directory that takes listings over MCP.
 *
 * Two transports, for two different jobs. Listings go over MCP
 * (`/api/mcp`): that is the interface SaaSRow publishes for machines, the tool
 * schemas describe the fields, and a field added there needs no release here.
 * Signing in goes over REST, because there is no MCP tool for it and there
 * should not be — the emailed code is a conversation with a person, and MCP
 * carries the key once a person has one.
 *
 * The key is `sr_` + 40 characters, issued by the site and sent as a bearer
 * token. It is stored in myna's encrypted vault like any other credential.
 */
import { postJson, getJson } from "../../util/http.ts";
import { McpClient } from "../mcp.ts";
import type {
  Directory,
  DirectoryAccount,
  Listing,
  ListingInput,
  Vocabulary,
} from "../types.ts";

const DEFAULT_SITE = "https://saasrow.com";

/** The site to talk to. Overridable so a staging deploy can be pointed at. */
function siteFor(account?: DirectoryAccount): string {
  const site = account?.meta?.site || process.env.MYNA_SAASROW_URL || DEFAULT_SITE;
  return site.replace(/\/+$/, "");
}

function clientFor(account: DirectoryAccount): McpClient {
  const key = account.creds.key;
  if (!key) throw new Error("No SaaSRow API key stored. Run: myna directory login saasrow");
  return new McpClient({
    url: `${siteFor(account)}/api/mcp`,
    token: key,
    clientName: "myna",
  });
}

/** Drop the keys a directory has no value for, so an empty patch stays empty. */
function wireFields(listing: Partial<ListingInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !value.trim()) return;
    if (Array.isArray(value) && !value.length) return;
    body[key] = value;
  };
  put("name", listing.name);
  put("website", listing.website);
  put("description", listing.description);
  put("category", listing.category);
  put("tags", listing.tags);
  put("use_cases", listing.useCases);
  put("audiences", listing.audiences);
  put("platforms", listing.platforms);
  put("pricing_model", listing.pricingModel);
  put("alternatives", listing.alternatives);
  return body;
}

interface WireListing {
  id?: string;
  name?: string;
  website?: string;
  description?: string;
  category?: string;
  tags?: string[];
  status?: string;
  saasrow_url?: string;
  manage_url?: string;
  created_at?: string;
  submitted_at?: string;
}

/**
 * Unwrap whatever the tool answered with.
 *
 * The REST routes wrap a listing in `{ data, message }` and the MCP tools hand
 * back the listing itself; reading through both means a change on either side
 * does not turn into "submitted, but myna showed nothing".
 */
function unwrap(payload: unknown): WireListing {
  const record = (payload ?? {}) as Record<string, unknown>;
  const inner = (record.data ?? record.listing ?? record) as WireListing;
  return inner ?? {};
}

function toListing(payload: unknown): Listing {
  const wire = unwrap(payload);
  return {
    id: String(wire.id ?? ""),
    name: wire.name ?? "",
    website: wire.website ?? "",
    description: wire.description,
    category: wire.category,
    tags: wire.tags,
    url: wire.saasrow_url,
    manageUrl: wire.manage_url,
    status: wire.status,
    submittedAt: wire.submitted_at ?? wire.created_at,
  };
}

interface VerifyResponse {
  api_key?: string;
  key?: { id?: string; name?: string; prefix?: string };
  user?: { email?: string };
}

export const saasrow: Directory = {
  id: "saasrow",
  name: "SaaSRow",
  blurb: "A software directory that publishes each listing to search, AI assistants, an API and MCP",
  homepage: DEFAULT_SITE,
  auth: {
    fields: [
      {
        key: "email",
        label: "Email",
        placeholder: "you@example.com",
        help: "SaaSRow mails a one-time code to this address. There is no password.",
      },
      {
        key: "key",
        label: "API key",
        secret: true,
        optional: true,
        placeholder: "sr_…",
        help: "Paste a key you already have to skip the emailed code.",
      },
      {
        key: "site",
        label: "Site",
        optional: true,
        default: DEFAULT_SITE,
        help: "Only change this to point at another deployment.",
      },
    ],
    note: "Signing in emails a one-time code, then stores the API key it returns. Listings are then submitted over SaaSRow's MCP server.",
    docsUrl: "https://saasrow.com/developers",
  },
  caps: { update: true, delete: true, categories: true, vocabulary: true, review: true },

  async login(input, ctx) {
    const site = (input.site || DEFAULT_SITE).replace(/\/+$/, "");
    const pasted = input.key?.trim();

    // A key in hand needs no email round trip; verify it and keep it.
    if (pasted) {
      const me = await getJson<{ user?: { email?: string }; key_id?: string }>(`${site}/api/v1/me`, {
        headers: { authorization: `Bearer ${pasted}` },
      });
      const email = me.user?.email ?? input.email ?? "";
      if (!email) throw new Error("That key was accepted but SaaSRow returned no account email.");
      return {
        handle: email,
        creds: { key: pasted },
        meta: { site, keyId: me.key_id ?? "", keyPrefix: pasted.slice(0, 11) },
      };
    }

    const email = input.email?.trim();
    if (!email) throw new Error("An email address is required.");
    if (!ctx.ask) throw new Error("Signing in to SaaSRow needs to ask for the emailed code, and nothing here can ask.");

    await postJson(`${site}/api/v1/auth/cli`, { email });
    ctx.report(`SaaSRow emailed a code to ${email}. It is good for 15 minutes.`);

    const code = (await ctx.ask("Code from the email (XXXX-XXXX): ")).trim();
    if (!code) throw new Error("No code entered.");

    const result = await postJson<VerifyResponse>(`${site}/api/v1/auth/cli/verify`, {
      email,
      code: code.toUpperCase(),
      key_name: "myna",
    });
    const key = result.api_key;
    if (!key) throw new Error("SaaSRow accepted the code but returned no API key.");

    return {
      handle: result.user?.email ?? email,
      creds: { key },
      meta: {
        site,
        keyId: result.key?.id ?? "",
        keyPrefix: result.key?.prefix ?? key.slice(0, 11),
      },
    };
  },

  async submit(account, listing) {
    const body = wireFields(listing);
    if (!body.name || !body.website || !body.description) {
      throw new Error("SaaSRow needs a name, a website and a description.");
    }
    return toListing(await clientFor(account).call("create_listing", body));
  },

  async listings(account) {
    const payload = await clientFor(account).call<unknown>("list_my_listings", {});
    const record = (payload ?? {}) as Record<string, unknown>;
    const rows = (Array.isArray(payload) ? payload : (record.data ?? record.listings ?? [])) as unknown[];
    return (Array.isArray(rows) ? rows : []).map(toListing);
  },

  async update(account, id, patch) {
    const body = wireFields(patch);
    if (!Object.keys(body).length) throw new Error("Nothing to change.");
    return toListing(await clientFor(account).call("update_listing", { id, ...body }));
  },

  async remove(account, id) {
    await clientFor(account).call("delete_listing", { id });
  },

  /** Public: the read tools need no key, so this works before a login. */
  async categories(account) {
    const client = account
      ? clientFor(account)
      : new McpClient({ url: `${siteFor(account)}/api/mcp`, clientName: "myna" });
    const payload = await client.call<unknown>("list_categories", {});
    const record = (payload ?? {}) as Record<string, unknown>;
    const rows = (Array.isArray(payload) ? payload : (record.data ?? record.categories ?? [])) as Array<
      Record<string, unknown>
    >;
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      name: String(row.name ?? row.category ?? ""),
      count: typeof row.count === "number" ? row.count : undefined,
    }));
  },

  async vocabulary(account) {
    const client = account
      ? clientFor(account)
      : new McpClient({ url: `${siteFor(account)}/api/mcp`, clientName: "myna" });
    const payload = await client.call<unknown>("get_vocabulary", {});
    const record = ((payload ?? {}) as Record<string, unknown>);
    const data = ((record.data ?? record) as Record<string, unknown>) ?? {};
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
    return {
      useCases: list(data.use_cases),
      audiences: list(data.audiences),
      platforms: list(data.platforms),
      pricingModels: list(data.pricing_models),
    } satisfies Vocabulary;
  },
};
