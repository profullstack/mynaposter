/**
 * myna dashboard: a local page for what went out, what is queued, and which
 * network is holding.
 *
 *   myna dashboard                 serve on 7777 and open a browser
 *   myna dashboard --port 9000     somewhere else
 *   myna dashboard --no-open       just serve it
 *   myna dashboard --json          print one snapshot and exit
 *
 * It binds 127.0.0.1 and nothing else. The page reads a person's whole posting
 * history, so putting it on a public interface would be handing that to anyone
 * who found the port; there is no token and no login because there is no
 * network exposure to guard.
 *
 * It also serves the skill files, so an agent on this machine can read an
 * account's rules over HTTP before posting:
 *
 *   GET /skills                                 index, as Markdown (/skills.json for JSON)
 *   GET /:network/skill.md                      the network's skill
 *   GET /:network/:account/skill.md             the account's selected skill
 *   GET /:network/:account/skills/              the account's skills, as Markdown
 *   GET /:network/:account/skills/:slug.md      one of them
 *   GET /types/skill.md                         the post types, as an index
 *   GET /types/:type/skill.md                   one post type's skill
 *
 * `:account` is the handle as a path segment (`myna skill list` prints it).
 * Reading never moves a rotation cursor; only a send does that.
 */
import {
  findSkillTarget,
  listAccounts,
  listDirectoryAccounts,
  listEngagement,
  listHistory,
  listQueue,
  loadSettings,
  openBrowser,
  readAccountSkill,
  readNetworkSkill,
  resolveSkill,
  selectSkill,
  skillKindFor,
  skillTargets,
  handleSlug,
  getNetwork,
  getDirectory,
  listTypeSkills,
  readTypeSkill,
  DEFAULT_BLOG_TYPE,
  DEFAULT_SOCIAL_TYPE,
  type Account,
  type MynaPlugin,
  type PluginContext,
  type Settings,
} from "@profullstack/myna-core";
import { readSnapshot, type Snapshot, type SnapshotInput } from "./snapshot.ts";
import { page } from "./page.ts";

export const DEFAULT_PORT = 7777;

type Target = Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">;

/** The route that serves an account's skill, from its parts. */
export function skillRoute(network: string, handle: string, slug?: string): string {
  const base = `/${encodeURIComponent(network)}/${encodeURIComponent(handleSlug(handle))}`;
  return slug ? `${base}/skills/${encodeURIComponent(slug)}.md` : `${base}/skill.md`;
}

/** Each account's skill and limits, for the snapshot. Pure given the targets and settings. */
export function skillRows(targets: Target[], settings: Settings): SnapshotInput["skills"] {
  return targets.map((target) => {
    const selection = selectSkill(target, settings);
    const resolved = resolveSkill(target, { settings, selected: selection.skill });
    return {
      accountId: target.id,
      network: target.network,
      kind: resolved.kind,
      selected: selection.skill.slug,
      rotating: selection.rotating,
      skills: selection.all.map((file) => file.slug),
      maxPerDay: resolved.limits.maxPerDay,
      minGapMinutes: resolved.limits.minGapMinutes,
      maxChars: resolved.limits.maxChars,
      contentPolicy: resolved.limits.contentPolicy,
      path: skillRoute(target.network, target.handle),
    };
  });
}

const allTargets = (): Target[] => skillTargets(listAccounts(), listDirectoryAccounts());

/** One snapshot from the live stores. */
export function snapshot(now?: number): Snapshot {
  return readSnapshot({
    history: listHistory,
    queue: listQueue,
    accounts: listAccounts,
    engagement: listEngagement,
    settings: loadSettings,
    skills: (_accounts, settings) => skillRows(allTargets(), settings),
    now,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const markdown = (body: string, status = 200): Response =>
  new Response(body.endsWith("\n") ? body : `${body}\n`, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });

/** What the dashboard reads for the skill routes. Swapped in tests. */
export interface SkillSources {
  targets: () => Target[];
  settings: () => Settings;
}

const liveSources: SkillSources = { targets: allTargets, settings: loadSettings };

/** The Markdown index of the post types. */
export function typesIndex(): string {
  const lines = [
    "# myna post types",
    "",
    "What a kind of post is, wherever it goes. `myna post --type <slug>` names one; without it a post to a blog is a " +
      `${DEFAULT_BLOG_TYPE} and anything else a ${DEFAULT_SOCIAL_TYPE}. A type is refused on a target whose kind it does not allow.`,
    "",
  ];
  for (const type of listTypeSkills()) {
    const kinds = (type.frontmatter.allowedKinds ?? []).join(", ") || "any";
    const cap = type.frontmatter.maxPerDay !== undefined ? `, ${type.frontmatter.maxPerDay}/day` : "";
    lines.push(`- [${type.type}](/types/${encodeURIComponent(type.type)}/skill.md): ${type.frontmatter.description} (allowed on ${kinds}${cap})`);
  }
  return lines.join("\n");
}

/** The Markdown index of every skill on this machine. */
export function skillsIndex(sources: SkillSources = liveSources): string {
  const targets = sources.targets();
  const settings = sources.settings();
  const networks = [...new Set(targets.map((target) => target.network))].sort();
  const lines = [
    "# myna skills",
    "",
    "The rules for each place this machine posts to. Read the post type's skill, then the account's, then the network's, before posting there.",
    "",
    "## Post types",
    "",
    `[All types](/types/skill.md): ${listTypeSkills().map((type) => `[${type.type}](/types/${encodeURIComponent(type.type)}/skill.md)`).join(", ")}`,
    "",
    "## Networks",
    "",
    ...networks.map((network) => `- [${network}](/${encodeURIComponent(network)}/skill.md) (${skillKindFor(network)})`),
    "",
    "## Accounts",
    "",
  ];
  for (const target of targets) {
    const selection = selectSkill(target, settings);
    const resolved = resolveSkill(target, { settings, selected: selection.skill });
    const limits = [
      resolved.limits.maxPerDay !== undefined ? `${resolved.limits.maxPerDay}/day` : "",
      resolved.limits.maxChars !== undefined ? `${resolved.limits.maxChars} chars` : "",
      resolved.limits.contentPolicy ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`- [${target.id}](${skillRoute(target.network, target.handle)}) using \`${selection.skill.slug}\`${selection.rotating ? " (rotating)" : ""}${limits ? `: ${limits}` : ""}`);
    if (selection.all.length > 1) {
      lines.push(`  - all: ${selection.all.map((file) => `[${file.slug}](${skillRoute(target.network, target.handle, file.slug)})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** The skill routes. Returns undefined when the path is not one of them. */
export function handleSkillRoute(pathname: string, sources: SkillSources = liveSources): Response | undefined {
  if (pathname === "/skills" || pathname === "/skills/" || pathname === "/skills.md") return markdown(skillsIndex(sources));
  if (pathname === "/skills.json") {
    const settings = sources.settings();
    return json({ skills: skillRows(sources.targets(), settings) });
  }
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts.length < 2) return undefined;
  const network = parts[0];

  // /types/skill.md and /types/:type/skill.md: the post types, not a network.
  if (network === "types") {
    if (parts.length === 2 && parts[1] === "skill.md") return markdown(typesIndex());
    if (parts.length === 3 && parts[2] === "skill.md") {
      const type = readTypeSkill(parts[1], { materialise: true });
      if (!type) return markdown(`No post type called "${parts[1]}".`, 404);
      return markdown(type.raw || `${type.body}\n`);
    }
    return undefined;
  }

  // /:network/skill.md
  if (parts.length === 2 && parts[1] === "skill.md") {
    const targets = sources.targets();
    const known = getNetwork(network) || getDirectory(network) || targets.some((target) => target.network === network);
    if (!known) return markdown(`No network called "${network}".`, 404);
    const skill = readNetworkSkill(network, { materialise: true });
    return markdown(skill.raw);
  }

  const target = findSkillTarget(`${network}:${parts[1]}`, sources.targets());
  if (!target) {
    if (parts[parts.length - 1] === "skill.md" || parts.includes("skills")) return markdown(`No connected account matches "${network}:${parts[1]}".`, 404);
    return undefined;
  }
  const settings = sources.settings();

  // /:network/:account/skill.md
  if (parts.length === 3 && parts[2] === "skill.md") {
    const selection = selectSkill(target, settings);
    const chosen = readAccountSkill(target, selection.skill.slug, { materialise: true }) ?? selection.skill;
    return markdown(chosen.raw || `${chosen.body}\n`);
  }
  // /:network/:account/skills/
  if (parts.length === 3 && parts[2] === "skills") {
    const selection = selectSkill(target, settings);
    const lines = [
      `# ${target.id}`,
      "",
      `Using \`${selection.skill.slug}\`${selection.rotating ? ` (rotating${selection.last ? `, last ${selection.last}` : ""})` : selection.pinned ? ` (pinned)` : ""}.`,
      "",
      ...selection.all.map((file) => `- [${file.slug}](${skillRoute(target.network, target.handle, file.slug)})${file.slug === selection.skill.slug ? " (selected)" : ""}`),
      "",
      `Network skill: [${target.network}](/${encodeURIComponent(target.network)}/skill.md)`,
    ];
    return markdown(lines.join("\n"));
  }
  // /:network/:account/skills/:slug.md
  if (parts.length === 4 && parts[2] === "skills" && parts[3].endsWith(".md")) {
    const slug = parts[3].replace(/\.md$/, "");
    const file = readAccountSkill(target, slug, { materialise: true });
    if (!file) return markdown(`${target.id} has no skill called "${slug}".`, 404);
    return markdown(file.raw || `${file.body}\n`);
  }
  return undefined;
}

/** Route one request. Exported so a test can drive it without a socket. */
export function handle(request: Request, sources?: SkillSources): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/snapshot") {
    try {
      return json(snapshot());
    } catch (error) {
      // A locked vault is the usual cause: the page says so rather than dying.
      return json({ error: (error as Error).message }, 503);
    }
  }
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  try {
    const skill = handleSkillRoute(pathname, sources);
    if (skill) return skill;
  } catch (error) {
    return markdown((error as Error).message, 503);
  }
  return new Response("Not found", { status: 404 });
}

function readPort(flags: Record<string, unknown>): number {
  const raw = flags.port;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port wants a number between 1 and 65535, not "${String(raw)}".`);
  return port;
}

const dashboard: MynaPlugin = {
  id: "dashboard",
  name: "Dashboard",
  version: "0.9.0",
  description: "A local dashboard: the queue, the drip, what each network is holding, and what went out.",
  commands: [
    {
      name: "dashboard",
      summary: "Open a local dashboard: the queue, the drip and what each network is holding",
      usage: [
        "myna dashboard                 serve on 127.0.0.1:7777 and open it",
        "myna dashboard --port 9000     serve somewhere else",
        "myna dashboard --no-open       serve without opening a browser",
        "myna dashboard --json          print one snapshot and exit",
      ],
      async run(_args: string[], ctx: PluginContext) {
        const port = readPort(ctx.flags);

        if (ctx.flags.json) {
          ctx.out(JSON.stringify(snapshot(), null, 2));
          return 0;
        }

        // Fail before binding when the vault is locked, so the person gets the
        // real message here rather than a broken page in a browser tab.
        snapshot();

        const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => handle(request) });
        const url = `http://127.0.0.1:${server.port}`;
        ctx.out(`Dashboard on ${url}`);
        ctx.out("Reading the queue, the history and the pacing rules. Ctrl+C to stop.");
        if (ctx.flags.noOpen !== true && ctx.flags.open !== "false") {
          try {
            await openBrowser(url);
          } catch {
            ctx.out("Could not open a browser; the URL above works.");
          }
        }

        await new Promise<void>((resolve) => {
          const quit = () => {
            server.stop();
            resolve();
          };
          process.once("SIGINT", quit);
          process.once("SIGTERM", quit);
        });
        return 0;
      },
    },
  ],
};

export default dashboard;
export { buildSnapshot, readSnapshot, slotFor, horizonFor, NETWORK_SLOT_ORDER } from "./snapshot.ts";
export type { Snapshot, NetworkState, QueueRow, HistoryRow, SkillSummary } from "./snapshot.ts";
export { page } from "./page.ts";
