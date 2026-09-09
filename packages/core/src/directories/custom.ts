/**
 * A directory myna has never heard of, reached by URL.
 *
 * The SaaSRow adapter knows SaaSRow: its field names, its emailed-code login.
 * This one knows nothing and asks. It reads the server's tool table, works out
 * which tool creates a listing and what that tool calls its fields, and maps
 * onto them. That is the point of pointing myna at an MCP server rather than
 * writing an adapter: the schema is already there, published by the server, so
 * a directory that names its field `product_url` instead of `website` needs no
 * code here.
 *
 * What it cannot do is sign you in. There is no MCP method for that, and every
 * directory issues keys its own way, so a custom directory takes a key you
 * already have and sends it as a bearer token.
 */
import { McpClient, type McpTool } from "./mcp.ts";
import type {
  Directory,
  DirectoryAccount,
  Listing,
  ListingInput,
  Vocabulary,
} from "./types.ts";

export interface CustomDirectoryConfig {
  /** What `myna directory <id> …` will accept. */
  id: string;
  name?: string;
  /** The MCP endpoint, e.g. https://example.com/api/mcp */
  url: string;
  homepage?: string;
  blurb?: string;
  /**
   * Tool names, where the server's are not ones we would guess. Everything
   * omitted is discovered from the tool table.
   */
  tools?: {
    create?: string;
    list?: string;
    update?: string;
    remove?: string;
    categories?: string;
    vocabulary?: string;
  };
}

/**
 * What a tool doing each job tends to be called. First match in the server's
 * table wins, so the most specific name is listed first.
 */
const TOOL_NAMES = {
  create: ["create_listing", "submit_listing", "create_product", "submit_product", "add_listing", "add_product", "create_entry"],
  list: ["list_my_listings", "my_listings", "list_my_products", "my_products", "list_listings", "list_my_entries"],
  update: ["update_listing", "update_product", "edit_listing", "patch_listing"],
  remove: ["delete_listing", "remove_listing", "delete_product", "withdraw_listing"],
  categories: ["list_categories", "get_categories", "categories"],
  vocabulary: ["get_vocabulary", "list_vocabulary", "vocabulary"],
} as const;

/** What a listing field tends to be called, in the order we would rather have. */
const FIELD_NAMES = {
  name: ["name", "title", "product_name", "productName"],
  website: ["website", "url", "product_url", "productUrl", "homepage", "link", "website_url"],
  description: ["description", "summary", "about", "details", "text"],
  category: ["category", "category_name", "categoryName"],
  tags: ["tags", "keywords", "labels"],
  useCases: ["use_cases", "useCases", "use_case"],
  audiences: ["audiences", "audience"],
  platforms: ["platforms", "platform"],
  pricingModel: ["pricing_model", "pricingModel", "pricing"],
  alternatives: ["alternatives", "alternative_to", "alternativeTo", "competitors"],
} as const;

type FieldKey = keyof typeof FIELD_NAMES;

interface Resolved {
  tools: Map<keyof typeof TOOL_NAMES, string>;
  /** Listing field -> the key this server's create tool uses for it. */
  fields: Map<FieldKey, string>;
  /** Ids the create tool marks required, so a missing one fails here not there. */
  required: string[];
}

/** Properties a tool's inputSchema declares. */
function propertiesOf(tool: McpTool | undefined): Record<string, unknown> {
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  return schema.properties ?? {};
}

function requiredOf(tool: McpTool | undefined): string[] {
  const schema = (tool?.inputSchema ?? {}) as { required?: unknown };
  return Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Work out this server's vocabulary once, from its own tool table.
 *
 * Discovery is cached per client because it costs a round trip and a server's
 * tools do not change under us mid-command.
 */
export function resolveTools(tools: McpTool[], overrides: CustomDirectoryConfig["tools"] = {}): Resolved {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const resolved: Resolved["tools"] = new Map();

  for (const job of Object.keys(TOOL_NAMES) as Array<keyof typeof TOOL_NAMES>) {
    const override = overrides[job];
    if (override) {
      if (!byName.has(override)) {
        throw new Error(`This server has no tool called "${override}". It offers: ${tools.map((tool) => tool.name).join(", ")}`);
      }
      resolved.set(job, override);
      continue;
    }
    const match = TOOL_NAMES[job].find((candidate) => byName.has(candidate));
    if (match) resolved.set(job, match);
  }

  const create = byName.get(resolved.get("create") ?? "");
  const properties = propertiesOf(create);
  const fields = new Map<FieldKey, string>();
  for (const key of Object.keys(FIELD_NAMES) as FieldKey[]) {
    const match = FIELD_NAMES[key].find((candidate) => candidate in properties);
    if (match) fields.set(key, match);
  }

  return { tools: resolved, fields, required: requiredOf(create) };
}

/** Build a Directory that talks to any MCP server. */
export function mcpDirectory(config: CustomDirectoryConfig): Directory {
  const id = config.id.trim().toLowerCase();
  if (!id) throw new Error("A directory needs an id.");
  if (!/^https?:\/\//i.test(config.url)) throw new Error(`"${config.url}" is not an http(s) URL.`);

  const name = config.name?.trim() || id;
  let discovery: Promise<Resolved> | undefined;

  const clientFor = (account?: DirectoryAccount): McpClient =>
    new McpClient({
      url: account?.meta?.url || config.url,
      token: account?.creds?.key || undefined,
      clientName: "myna",
    });

  /** The tool table, read once. */
  async function resolve(account?: DirectoryAccount): Promise<Resolved> {
    discovery ??= clientFor(account)
      .listTools()
      .then((tools) => resolveTools(tools, config.tools))
      .catch((error: Error) => {
        // Do not cache a failure: the next call should try the server again.
        discovery = undefined;
        throw error;
      });
    return discovery;
  }

  const toolFor = async (job: keyof typeof TOOL_NAMES, account?: DirectoryAccount): Promise<string> => {
    const { tools } = await resolve(account);
    const tool = tools.get(job);
    if (!tool) throw new Error(`${name} has no tool for that. It offers: ${[...tools.values()].join(", ") || "nothing myna recognises"}`);
    return tool;
  };

  /** Map myna's listing onto whatever this server calls those fields. */
  async function wire(listing: Partial<ListingInput>, account?: DirectoryAccount): Promise<Record<string, unknown>> {
    const { fields } = await resolve(account);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(listing) as Array<[FieldKey, unknown]>) {
      const wireName = fields.get(key);
      if (!wireName || value === undefined || value === null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      if (Array.isArray(value) && !value.length) continue;
      body[wireName] = value;
    }
    return body;
  }

  /** Read a listing back, whatever this server calls its fields. */
  function toListing(payload: unknown): Listing {
    const record = ((payload ?? {}) as Record<string, unknown>);
    const inner = ((record.data ?? record.listing ?? record.product ?? record) as Record<string, unknown>) ?? {};
    const pick = (...names: string[]): string | undefined => {
      for (const key of names) {
        const value = inner[key];
        if (typeof value === "string" && value.trim()) return value;
      }
      return undefined;
    };
    return {
      id: String(inner.id ?? inner.listing_id ?? inner.uuid ?? ""),
      name: pick(...FIELD_NAMES.name) ?? "",
      website: pick(...FIELD_NAMES.website) ?? "",
      description: pick(...FIELD_NAMES.description),
      category: pick(...FIELD_NAMES.category),
      tags: Array.isArray(inner.tags) ? inner.tags.map(String) : undefined,
      url: pick("saasrow_url", "listing_url", "public_url", "permalink", "page_url"),
      manageUrl: pick("manage_url", "management_url", "edit_url"),
      status: pick("status", "state", "review_status"),
      submittedAt: pick("submitted_at", "created_at", "createdAt"),
    };
  }

  /**
   * The rows out of whatever wrapper a server put them in. `extra` names the
   * key this particular call expects — `categories` comes back under
   * `categories`, listings under `listings`, and a server that wraps
   * everything in `data` is also common.
   */
  const rowsOf = (payload: unknown, ...extra: string[]): unknown[] => {
    if (Array.isArray(payload)) return payload;
    const record = ((payload ?? {}) as Record<string, unknown>);
    for (const key of [...extra, "data", "listings", "products", "items", "results"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    // A server that wraps its array one level deeper: {data: {categories: []}}.
    const nested = record.data;
    if (nested && typeof nested === "object") {
      for (const key of extra) {
        const value = (nested as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value;
      }
    }
    return [];
  };

  return {
    id,
    name,
    blurb: config.blurb?.trim() || `A directory at ${new URL(config.url).host}, reached over MCP`,
    homepage: config.homepage?.trim() || new URL(config.url).origin,
    endpoint: config.url,
    auth: {
      fields: [
        {
          key: "key",
          label: "API key",
          secret: true,
          help: "Whatever this directory issues. myna sends it as `Authorization: Bearer <key>`.",
        },
        { key: "url", label: "MCP endpoint", optional: true, default: config.url },
      ],
      note: `Custom directory. myna reads ${config.url} to see what it accepts, and sends your key as a bearer token.`,
      docsUrl: config.homepage,
    },
    // Assumed until the tool table says otherwise; `login` corrects them.
    caps: { update: true, delete: true, categories: true, vocabulary: true, review: true },

    async login(input, ctx) {
      const url = input.url?.trim() || config.url;
      const key = input.key?.trim();
      if (!key) throw new Error("An API key is required. A custom directory cannot issue you one.");

      const probe: DirectoryAccount = {
        directory: id,
        handle: "",
        addedAt: "",
        creds: { key },
        meta: { url },
      };

      // Verifying means reading the tool table with the key attached: it proves
      // the endpoint speaks MCP and that the key is not rejected outright.
      const tools = await clientFor(probe).listTools();
      const resolved = resolveTools(tools, config.tools);
      if (!resolved.tools.get("create")) {
        throw new Error(
          `${new URL(url).host} speaks MCP but offers no tool that creates a listing. ` +
            `It offers: ${tools.map((tool) => tool.name).join(", ") || "nothing"}`,
        );
      }
      ctx.report(`${tools.length} tools, listing with ${resolved.tools.get("create")}.`);

      return {
        handle: new URL(url).host,
        creds: { key },
        meta: { url, createTool: resolved.tools.get("create") ?? "" },
      };
    },

    async submit(account, listing) {
      const body = await wire(listing, account);
      const { required } = await resolve(account);
      const missing = required.filter((field) => body[field] === undefined);
      if (missing.length) throw new Error(`${name} requires ${missing.join(", ")}, and the page did not give myna that.`);
      return toListing(await clientFor(account).call(await toolFor("create", account), body));
    },

    async listings(account) {
      const tool = await toolFor("list", account);
      return rowsOf(await clientFor(account).call<unknown>(tool, {}), "listings", "my_listings").map(toListing);
    },

    async update(account, listingId, patch) {
      const tool = await toolFor("update", account);
      const body = await wire(patch, account);
      if (!Object.keys(body).length) throw new Error("Nothing to change.");
      return toListing(await clientFor(account).call(tool, { id: listingId, ...body }));
    },

    async remove(account, listingId) {
      await clientFor(account).call(await toolFor("remove", account), { id: listingId });
    },

    async categories(account) {
      const tool = await toolFor("categories", account);
      return rowsOf(await clientFor(account).call<unknown>(tool, {}), "categories").map((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        return {
          name: String(record.name ?? record.category ?? row ?? ""),
          count: typeof record.count === "number" ? record.count : undefined,
        };
      });
    },

    async vocabulary(account) {
      const tool = await toolFor("vocabulary", account);
      const payload = await clientFor(account).call<unknown>(tool, {});
      const record = ((payload ?? {}) as Record<string, unknown>);
      const data = ((record.data ?? record) as Record<string, unknown>) ?? {};
      const list = (...names: string[]): string[] => {
        for (const key of names) if (Array.isArray(data[key])) return (data[key] as unknown[]).map(String);
        return [];
      };
      return {
        useCases: list("use_cases", "useCases"),
        audiences: list("audiences", "audience"),
        platforms: list("platforms", "platform"),
        pricingModels: list("pricing_models", "pricingModels", "pricing"),
      } satisfies Vocabulary;
    },
  };
}
