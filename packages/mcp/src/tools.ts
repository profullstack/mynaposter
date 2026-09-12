/**
 * The myna tools, and what they do.
 *
 * Kept apart from any one transport because there are two: `server.ts` serves
 * these over stdio for an assistant that launches a subprocess, and the API
 * serves the same table over HTTP for one that cannot. A tool that existed on
 * only one of them would be the worst kind of bug to find.
 */
import {
  NETWORKS,
  authSummary,
  draft,
  enqueue,
  listAccounts,
  listHistory,
  listQueue,
  loadSettings,
  postToAll,
  postPaced,
  removeQueued,
  runAfterSchedule,
  runAfterCancel,
  requireNetwork,
  resolveTargets,
  summarize,
  tailor,
  writerAvailable,
  buildListing,
  submitListing,
  directoryStatus,
  requireDirectory,
  requireDirectoryAccount,
  findSkillTarget,
  listDirectoryAccounts,
  readAccountSkill,
  readNetworkSkill,
  resolveSkill,
  selectSkill,
  skillKindFor,
  skillTargets,
  getNetwork,
  getDirectory,
  listTypeSkills,
  readTypeSkill,
  defaultTypeFor,
  DEFAULT_BLOG_TYPE,
  DEFAULT_SOCIAL_TYPE,
  type ListingInput,
} from "@profullstack/myna-core";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** The SDK's result type is an open record; this keeps ours assignable to it. */
  [key: string]: unknown;
}

const TARGET_DESCRIPTION =
  'Where to post: "all", a network id ("bluesky"), an account id ' +
  '("bluesky:alice.bsky.social"), or several separated by commas. Defaults to the ' +
  "configured default, which is usually every connected account.";

export const TOOLS = [
  {
    name: "myna_accounts",
    description:
      "List the social accounts connected to this machine. Returns ids you can pass as a target. " +
      "Never returns credentials. Start here: posting to an account that is not connected will fail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "myna_skills",
    description:
      "List the skill files on this machine: the post types (launch-announcement, release-notes, bug-story, " +
      "essay, repost, promo, reply, event, social-update, plus any added), one per network and one or more per " +
      "account, each a Markdown file with frontmatter carrying the rules and the limits myna enforces. A type " +
      "names which kinds of target may carry it; a bug-story never reaches a blog. Read with myna_skill before posting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "myna_skill",
    description:
      "Read the rules for posting somewhere, as a skill: the post type's skill (what the post is and its " +
      "structure), then the account's selected skill, then its network's skill, plus the merged limits. Call " +
      "this before myna_post and follow it. A blog's skill allows four posts a day, major features only, and " +
      "never a title the blog already carries; a bug-story type is not allowed on a blog at all. Reading never " +
      "changes which skill is selected.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: 'An account id ("htmlblog:dev.profullstack.com/~anthony/blog") or network:handle-slug, from myna_skills.' },
        network: { type: "string", description: 'A network id ("htmlblog") for the network-level skill alone.' },
        slug: { type: "string", description: "One particular skill of the account, by slug, instead of the selected one." },
        type: {
          type: "string",
          description:
            'A post type ("launch-announcement", "bug-story", ...). With an account, its skill is read first and the ' +
            "answer says whether the account's kind carries it; alone, the type skill itself.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myna_networks",
    description:
      "List every network myna supports, with how each one logs in and its character limit. " +
      "Use this to answer questions about what is possible, not what is connected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "myna_preview",
    description:
      "Show exactly what each target would receive for a given piece of text: the character count " +
      "that network will bill, whether it would be split into a thread, and whether it is over the limit. " +
      "Costs nothing and sends nothing. Worth calling before myna_post.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text." },
        to: { type: "string", description: TARGET_DESCRIPTION },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_post",
    description:
      "Publish a post to the given targets immediately. This is public and immediate: it reaches real " +
      "followers and several networks cannot delete it afterwards. Confirm the wording with the user " +
      "before calling it, and use dry_run first if you are unsure which accounts are selected.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text. Tailored per network automatically." },
        to: { type: "string", description: TARGET_DESCRIPTION },
        title: { type: "string", description: "Title, required by Reddit, Lemmy and the blog targets." },
        thread: { type: "boolean", description: "Split over-limit text into a reply chain instead of truncating." },
        allow_duplicate: {
          type: "boolean",
          description: "Blogs only: publish even though the blog already carries a post with this title. Almost never right.",
        },
        type: {
          type: "string",
          description:
            `What kind of post this is, from myna_skills: launch-announcement, release-notes, bug-story, essay, repost, promo, ` +
            `reply, event, social-update. Default: ${DEFAULT_BLOG_TYPE} when a blog or longform target is included, else ` +
            `${DEFAULT_SOCIAL_TYPE}. A target whose kind the type does not allow is refused.`,
        },
        video: {
          type: "string",
          description: "YouTube only: the video id or URL to comment on. Get ids from myna_search. Without it a YouTube target fails.",
        },
        reply_to: { type: "string", description: "YouTube only: the id of a comment to answer instead of commenting on the video." },
        dry_run: { type: "boolean", description: "Resolve the targets and show the text without sending." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_schedule",
    description:
      "Queue a post for later instead of sending it now. The scheduler sends it when due, so this is the " +
      "safe way to line something up for a person to review first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        at: { type: "string", description: "When to send it, as an ISO 8601 timestamp." },
        to: { type: "string", description: TARGET_DESCRIPTION },
        title: { type: "string" },
      },
      required: ["text", "at"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_search",
    description:
      "Search a network for public posts matching a query, where the network supports it. Today that is " +
      "YouTube, where it returns videos: id, title, channel and URL. Pair it with myna_post and its `video` " +
      "argument to comment on one. Reads only; sends nothing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        to: { type: "string", description: 'Which account or network to search with, e.g. "youtube".' },
        limit: { type: "number", description: "How many results. Default 10, at most 50." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_queue",
    description: "List scheduled posts that have not been sent yet, with their ids and due times.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "myna_cancel",
    description: "Remove a scheduled post from the queue before it sends.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The queue id, from myna_queue." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_history",
    description:
      "What was posted recently and what failed, with the error for each failure. Use it to check whether " +
      "a post actually landed rather than assuming it did.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many entries. Default 25." } },
      additionalProperties: false,
    },
  },
  {
    name: "myna_draft",
    description:
      "Draft post text with myna's writer, either from a topic or by reading a URL. Returns drafts only; " +
      "nothing is published. Needs the writer to be configured, which myna_accounts will not tell you: " +
      "if it is not, this returns an explanatory error.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to write about." },
        url: { type: "string", description: "A link to read and write a post about." },
        to: { type: "string", description: "Tailor one draft per network for these targets." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myna_timeline",
    description: "Read the home timeline of a connected account, where the network supports it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Which account or network to read." },
        limit: { type: "number", description: "How many posts. Default 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myna_directories",
    description:
      "List the software directories myna can submit a product to, and which of them this machine " +
      "is signed in to. A directory listing is a product entry, not a post: submitting one is a " +
      "different act from myna_post and goes to a different place.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "myna_directory_preview",
    description:
      "Read a product's URL and return the listing that would be submitted, without submitting it. " +
      "Use this first: a submission is public and is reviewed by a person, so the fields are worth " +
      "checking, and anything wrong can be corrected by passing it to myna_directory_submit.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory id; call myna_directories for the list." },
        url: { type: "string", description: "The product's website." },
        ai: {
          type: "boolean",
          description:
            "Let myna's writer describe the product. Default true where a model is configured; " +
            "false uses the page's own metadata.",
        },
      },
      required: ["directory", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_update",
    description:
      "Post an update to an agenticjobs board: a role filled, something shipped, when you are free next. " +
      "At most 600 characters and one link; the board allows five a day and refuses the same text twice. " +
      "Goes out through the board's own MCP post_update tool as the connected account (or an employer it " +
      "belongs to, with org). Public and immediate: confirm the wording with the user first, and use dry_run " +
      "to see which account it would come from.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "What happened. Plain text or Markdown, at most 600 characters." },
        link: { type: "string", description: "One public URL, optional. A trailing URL in body is moved here on its own." },
        org: { type: "string", description: "Post as this employer (slug) instead of as the account." },
        account: { type: "string", description: 'An agenticjobs account id ("agenticjobs:you@example.com"), when more than one board is connected. Defaults to every connected agenticjobs account.' },
        now: { type: "boolean", description: "Skip the pacing gates and send immediately." },
        dry_run: { type: "boolean", description: "Say which account it would come from and what it would say, without posting." },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_directory_submit",
    description:
      "Submit a product to a directory. This is public and cannot be taken back quietly, so confirm " +
      "the wording with the person first — myna_directory_preview shows exactly what would be sent. " +
      "Any field given here overrides what was read from the page.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory id; call myna_directories for the list." },
        url: { type: "string", description: "The product's website. Read to fill anything not given." },
        name: { type: "string", description: "Product name." },
        description: { type: "string", description: "What the product does." },
        category: { type: "string", description: "Category name the directory accepts." },
        tags: { type: "array", items: { type: "string" }, description: "Free-text tags." },
        use_cases: { type: "array", items: { type: "string" } },
        audiences: { type: "array", items: { type: "string" } },
        platforms: { type: "array", items: { type: "string" } },
        pricing_model: { type: "string" },
        alternatives: { type: "array", items: { type: "string" } },
      },
      required: ["directory", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "myna_directory_listings",
    description: "The listings this machine's account owns in a directory, and where each one stands.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory id. Omit for every connected directory." },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Run one tool.
 *
 * Errors come back as tool output with `isError`, not as a thrown protocol
 * error, so the agent reads the reason and can choose differently instead of
 * seeing an opaque failure.
 */
const text = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/**
 * Listing fields an agent supplied, in the directory's snake_case, mapped to
 * myna's. Only what was given: an absent field must not overwrite what reading
 * the page worked out.
 */
function listingOverrides(args: Record<string, unknown>): Partial<ListingInput> {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const arr = (value: unknown) =>
    Array.isArray(value) && value.length ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
  return {
    name: str(args.name),
    description: str(args.description),
    category: str(args.category),
    tags: arr(args.tags),
    useCases: arr(args.use_cases),
    audiences: arr(args.audiences),
    platforms: arr(args.platforms),
    pricingModel: str(args.pricing_model),
    alternatives: arr(args.alternatives),
  };
}

export async function callTool(name: string, args_: Record<string, unknown> = {}): Promise<ToolResult> {
  const args = args_ as Record<string, never>;

  try {
    switch (name) {
      case "myna_accounts": {
        const accounts = listAccounts().map(({ creds, ...rest }) => rest);
        if (!accounts.length) {
          return text(
            "No accounts are connected. A person needs to run `myna login <network>` first; " +
              "connecting an account requires a password or a browser sign-in and cannot be done from here.",
          );
        }
        return text(accounts);
      }

      case "myna_skills": {
        const settings = loadSettings();
        const targets = skillTargets(listAccounts(), listDirectoryAccounts());
        const networks = [...new Set(targets.map((target) => target.network))].sort();
        return text({
          types: listTypeSkills().map((type) => ({
            type: type.type,
            description: type.frontmatter.description,
            allowedKinds: type.frontmatter.allowedKinds ?? [],
            maxPerDay: type.frontmatter.maxPerDay,
            requiresUrl: type.frontmatter.requiresUrl,
            structure: type.frontmatter.structure ?? [],
            default: type.type === DEFAULT_BLOG_TYPE ? "for a blog or longform target" : type.type === DEFAULT_SOCIAL_TYPE ? "otherwise" : undefined,
          })),
          networks: networks.map((network) => {
            const skill = readNetworkSkill(network);
            return { network, kind: skillKindFor(network), path: skill.path, name: skill.frontmatter.name };
          }),
          accounts: targets.map((target) => {
            const selection = selectSkill(target, settings);
            const resolved = resolveSkill(target, { settings, selected: selection.skill });
            const { sources, ...limits } = resolved.limits;
            return {
              account: target.id,
              network: target.network,
              kind: resolved.kind,
              selected: selection.skill.slug,
              rotating: selection.rotating,
              skills: selection.all.map((file) => file.slug),
              limits,
            };
          }),
        });
      }

      case "myna_skill": {
        const settings = loadSettings();
        const typeSkill = args.type ? readTypeSkill(args.type, { materialise: true }) : undefined;
        if (args.type && !typeSkill) throw new Error(`No post type "${args.type}". Call myna_skills for the list.`);
        if (typeSkill && !args.account && !args.network) {
          return text({
            type: typeSkill.type,
            path: typeSkill.path,
            frontmatter: typeSkill.frontmatter,
            skill: typeSkill.raw || `${typeSkill.body}\n`,
          });
        }
        if (args.account) {
          const target = findSkillTarget(args.account, skillTargets(listAccounts(), listDirectoryAccounts()));
          if (!target) throw new Error(`No connected account matches "${args.account}". Call myna_skills for the ids.`);
          const selection = selectSkill(target, settings);
          const chosen = args.slug ? readAccountSkill(target, args.slug, { materialise: true }) : (readAccountSkill(target, selection.skill.slug, { materialise: true }) ?? selection.skill);
          if (!chosen) throw new Error(`${target.id} has no skill called "${args.slug}".`);
          const type = args.type ?? defaultTypeFor([target]);
          const resolved = resolveSkill(target, { settings, selected: chosen, type });
          const { sources, ...limits } = resolved.limits;
          const allowed = resolved.typeSkill ? !resolved.typeSkill.frontmatter.allowedKinds?.length || resolved.typeSkill.frontmatter.allowedKinds.includes(resolved.kind) : undefined;
          return text({
            account: target.id,
            network: target.network,
            kind: resolved.kind,
            slug: chosen.slug,
            rotating: selection.rotating,
            type,
            typeAllowedHere: allowed,
            limits,
            typeSkill: resolved.typeSkill ? resolved.typeSkill.raw || `${resolved.typeSkill.body}\n` : undefined,
            skill: chosen.raw || `${chosen.body}\n`,
            networkSkill: resolved.networkSkill.raw || `${resolved.networkSkill.body}\n`,
            instructions: resolved.body,
          });
        }
        if (args.network) {
          const id = getNetwork(args.network)?.id ?? getDirectory(args.network)?.id ?? args.network;
          const skill = readNetworkSkill(id, { materialise: true });
          return text({ network: id, kind: skillKindFor(id), path: skill.path, frontmatter: skill.frontmatter, skill: skill.raw || `${skill.body}\n` });
        }
        throw new Error("Give an account (an id from myna_skills) or a network.");
      }

      case "myna_networks":
        return text(
          NETWORKS.map((network) => ({
            id: network.id,
            name: network.name,
            login: authSummary(network),
            charLimit: network.caps.charLimit || null,
            threads: network.caps.threads,
            needsTitle: Boolean(network.caps.needsTitle),
          })),
        );

      case "myna_preview": {
        const targets = resolveTargets(args.to ?? loadSettings().defaultTargets);
        return text(
          targets.map((account) => {
            const parts = tailor(account.network, { text: args.text, thread: true });
            const limit = requireNetwork(account.network).caps.charLimit;
            return {
              account: account.id,
              limit: limit || null,
              parts: parts.length,
              overLimit: Boolean(limit) && parts[0].length > limit,
              first: parts[0],
            };
          }),
        );
      }

      case "myna_post": {
        const targets = resolveTargets(args.to ?? loadSettings().defaultTargets);
        if (!targets.length) throw new Error("No accounts connected.");

        const extra: Record<string, string> = {};
        if (args.video) extra.video = args.video;
        if (args.reply_to) extra.replyTo = args.reply_to;

        if (args.dry_run) {
          return text({
            dryRun: true,
            wouldPostTo: targets.map((account) => account.id),
            text: args.text,
            ...(Object.keys(extra).length ? { extra } : {}),
          });
        }

        if (args.allow_duplicate) extra.allowDuplicate = "true";
        const paced = await postPaced(targets, {
          type: args.type,
          text: args.text,
          title: args.title,
          thread: args.thread ?? loadSettings().threadByDefault,
          signature: loadSettings().signature || undefined,
          extra: Object.keys(extra).length ? extra : undefined,
          allowDuplicate: Boolean(args.allow_duplicate),
        }, { force: Boolean(args.now) });
        const results = paced.results;

        return text({
          summary: results.length ? summarize(results) : "nothing sent yet",
          results: results.map((result) => ({
            account: result.account.id,
            ok: result.ok,
            url: result.posts[0]?.url,
            error: result.error,
            skill: result.skill,
          })),
          type: paced.queued[0]?.type ?? args.type ?? defaultTypeFor(targets),
          queued: paced.queued.map((entry) => ({ id: entry.id, account: entry.targets[0], at: entry.scheduledFor, reason: paced.plan.later.find((t) => t.account.id === entry.targets[0])?.reason })),
          skipped: paced.skipped.map((entry) => ({ account: entry.account.id, reason: entry.reason })),
        });
      }

      case "myna_schedule": {
        const at = new Date(args.at);
        if (Number.isNaN(at.getTime())) throw new Error(`"${args.at}" is not a timestamp myna can read.`);
        const targets = resolveTargets(args.to ?? loadSettings().defaultTargets);
        const paced = await postPaced(targets, {
          text: args.text,
          title: args.title,
          thread: loadSettings().threadByDefault,
        }, { from: Math.max(at.getTime(), Date.now() + 1) });
        const hooks = paced.scheduleHooks;
        return text({
          queued: paced.queued.map((entry) => ({ id: entry.id, at: entry.scheduledFor, account: entry.targets[0] })),
          skipped: paced.skipped.map((entry) => ({ account: entry.account.id, reason: entry.reason })),
          ...(hooks.length ? { hooks } : {}),
        });
      }

      case "myna_queue":
        return text(listQueue().filter((post) => post.status === "pending"));

      case "myna_cancel":
        if (!removeQueued(args.id)) return text(`No queued post with id ${args.id}.`);
        const hooks = await runAfterCancel(args.id);
        return text(`Cancelled ${args.id}.${hooks.map((hook) => (hook.error ? ` ${hook.plugin} failed: ${hook.error}` : hook.line ? ` ${hook.plugin}: ${hook.line}` : "")).join("")}`);

      case "myna_history":
        return text(listHistory().slice(0, Number(args.limit ?? 25)));

      case "myna_draft": {
        const check = writerAvailable();
        if (!check.ok) throw new Error(check.reason!);
        if (!args.prompt && !args.url) throw new Error("Give either a prompt or a url.");
        const networks = args.to ? [...new Set(resolveTargets(args.to).map((account) => account.network))] : [];
        return text(await draft({ prompt: args.prompt, url: args.url, networks }));
      }

      case "myna_search": {
        if (!args.query) throw new Error("Give a query.");
        const account = resolveTargets(args.to ?? loadSettings().defaultTargets).find(
          (entry) => requireNetwork(entry.network).search,
        );
        if (!account) throw new Error("None of those accounts can search. Connect YouTube with `myna login youtube`.");
        const items = await requireNetwork(account.network).search!(account, args.query, Number(args.limit ?? 10));
        return text({ account: account.id, items });
      }

      case "myna_timeline": {
        const account = resolveTargets(args.to ?? loadSettings().defaultTargets).find(
          (entry) => requireNetwork(entry.network).timeline,
        );
        if (!account) throw new Error("None of those accounts can read a timeline.");
        const items = (await requireNetwork(account.network).timeline!(account, Number(args.limit ?? 20))) ?? [];
        return text({ account: account.id, items });
      }

      case "myna_directories":
        return text(
          directoryStatus().map(({ directory, account }) => ({
            id: directory.id,
            name: directory.name,
            homepage: directory.homepage,
            blurb: directory.blurb,
            connected: Boolean(account),
            handle: account?.handle ?? null,
            review: directory.caps.review,
          })),
        );

      case "myna_directory_preview": {
        const directory = requireDirectory(args.directory);
        const built = await buildListing(directory, args.url, {
          ai: args.ai === undefined ? undefined : Boolean(args.ai),
        });
        return text({
          directory: directory.id,
          listing: built.listing,
          describedBy: built.source,
          submitted: false,
        });
      }

      case "myna_update": {
        const body = String(args.body ?? "").trim();
        if (!body) throw new Error("Say what happened: body is required.");
        if (body.length > 600) throw new Error(`That is ${body.length} characters; the board takes 600.`);
        const targets = resolveTargets(args.account ?? "agenticjobs").filter((account) => account.network === "agenticjobs");
        if (!targets.length) {
          throw new Error(
            "No agenticjobs board is connected. A person needs to run `myna login agenticjobs <board url>`; " +
              "it is a device flow approved in a browser and cannot be done from here.",
          );
        }
        const extra: Record<string, string> = {};
        if (args.link) extra.link = String(args.link);
        if (args.org) extra.org = String(args.org);
        if (args.dry_run) {
          return text({ dryRun: true, wouldPostFrom: targets.map((account) => account.id), body, ...(Object.keys(extra).length ? { extra } : {}) });
        }
        const paced = await postPaced(targets, {
          text: body,
          thread: false,
          extra: Object.keys(extra).length ? extra : undefined,
        }, { force: Boolean(args.now) });
        return text({
          summary: paced.results.length ? summarize(paced.results) : "nothing sent yet",
          results: paced.results.map((result) => ({
            account: result.account.id,
            ok: result.ok,
            url: result.posts[0]?.url,
            error: result.error,
          })),
          queued: paced.queued?.map((entry) => ({ id: entry.id, scheduledFor: entry.scheduledFor })) ?? [],
        });
      }

      case "myna_directory_submit": {
        const directory = requireDirectory(args.directory);
        // Fail on a missing credential before reading the page: a person has
        // to run `myna directory login`, and nothing here can do it for them.
        requireDirectoryAccount(directory.id);
        const built = await buildListing(directory, args.url, {
          overrides: listingOverrides(args_),
        });
        const result = await submitListing(directory.id, built.listing);
        return text({ directory: result.directory, listing: result.listing, sent: result.input });
      }

      case "myna_directory_listings": {
        const ids = args.directory
          ? [requireDirectory(args.directory).id]
          : directoryStatus().filter((row) => row.account).map((row) => row.directory.id);
        if (!ids.length) {
          throw new Error(
            "No directory is connected. A person needs to run `myna directory login <id>` first; " +
              "it needs an emailed code and cannot be done from here.",
          );
        }
        const listings = [];
        for (const id of ids) {
          const directory = requireDirectory(id);
          for (const listing of await directory.listings(requireDirectoryAccount(id))) {
            listings.push({ directory: id, ...listing });
          }
        }
        return text(listings);
      }

      default:
        throw new Error(`Unknown tool "${name}"`);
    }
  } catch (error) {
    // Reported as tool output, not a protocol error, so the agent can read the
    // reason and choose differently rather than just seeing a failure.
    return { ...text(`Error: ${(error as Error).message}`), isError: true };
  }
}

