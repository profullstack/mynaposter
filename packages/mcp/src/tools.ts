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
  removeQueued,
  requireNetwork,
  resolveTargets,
  summarize,
  tailor,
  writerAvailable,
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

        if (args.dry_run) {
          return text({
            dryRun: true,
            wouldPostTo: targets.map((account) => account.id),
            text: args.text,
          });
        }

        const results = await postToAll(targets, {
          text: args.text,
          title: args.title,
          thread: args.thread ?? loadSettings().threadByDefault,
          signature: loadSettings().signature || undefined,
        });

        return text({
          summary: summarize(results),
          results: results.map((result) => ({
            account: result.account.id,
            ok: result.ok,
            url: result.posts[0]?.url,
            error: result.error,
          })),
        });
      }

      case "myna_schedule": {
        const at = new Date(args.at);
        if (Number.isNaN(at.getTime())) throw new Error(`"${args.at}" is not a timestamp myna can read.`);
        const targets = resolveTargets(args.to ?? loadSettings().defaultTargets);
        const entry = enqueue({
          scheduledFor: at.toISOString(),
          targets: targets.map((account) => account.id),
          text: args.text,
          title: args.title,
          thread: loadSettings().threadByDefault,
        });
        return text({ queued: entry.id, at: entry.scheduledFor, targets: entry.targets });
      }

      case "myna_queue":
        return text(listQueue().filter((post) => post.status === "pending"));

      case "myna_cancel":
        return text(removeQueued(args.id) ? `Cancelled ${args.id}.` : `No queued post with id ${args.id}.`);

      case "myna_history":
        return text(listHistory().slice(0, Number(args.limit ?? 25)));

      case "myna_draft": {
        const check = writerAvailable();
        if (!check.ok) throw new Error(check.reason!);
        if (!args.prompt && !args.url) throw new Error("Give either a prompt or a url.");
        const networks = args.to ? [...new Set(resolveTargets(args.to).map((account) => account.network))] : [];
        return text(await draft({ prompt: args.prompt, url: args.url, networks }));
      }

      case "myna_timeline": {
        const account = resolveTargets(args.to ?? loadSettings().defaultTargets).find(
          (entry) => requireNetwork(entry.network).timeline,
        );
        if (!account) throw new Error("None of those accounts can read a timeline.");
        const items = (await requireNetwork(account.network).timeline!(account, Number(args.limit ?? 20))) ?? [];
        return text({ account: account.id, items });
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

