/**
 * `myna skill`: the rules for each place myna posts to, as files.
 *
 *   myna skill list                                every network and account, which skill is on
 *   myna skill show htmlblog                       the network's skill
 *   myna skill show htmlblog:dev.profullstack.com/~anthony/blog
 *   myna skill init [--force]                      write the missing ones (or all of them)
 *   myna skill path <network[:account]>            where the file is, for an editor
 *   myna skill add <account> <slug> [--from file]  another skill for an account, from a file or stdin
 *   myna skill default <account> <slug>            pin one
 *   myna skill rotate <account> [on|off]           take turns through them
 *   myna skill remove <account> <slug>
 *
 * The files are Markdown with frontmatter, so an agent can load one as a
 * skill, and the frontmatter carries the limits myna enforces. Edit them
 * freely: myna writes a file only when it is absent, or with --force.
 */
import { readFileSync } from "node:fs";
import {
  addAccountSkill,
  ensureAccountSkill,
  ensureNetworkSkill,
  findSkillTarget,
  initSkills,
  listAccounts,
  listDirectoryAccounts,
  loadSettings,
  networkSkillPath,
  pinDefaultSkill,
  readAccountSkill,
  readNetworkSkill,
  removeAccountSkill,
  resolveSkill,
  selectSkill,
  setRotation,
  skillKindFor,
  skillTargets,
  skillsDir,
  getNetwork,
  getDirectory,
  DEFAULT_SKILL_SLUG,
  type Account,
  type ResolvedLimits,
  type SkillLimits,
} from "@profullstack/myna-core";
import { readStdin } from "./prompt.ts";
import { out, table } from "./io.ts";
import type { Flags } from "./headless.ts";

const USAGE = `Usage:
  myna skill list                              Every network and account, and which skill each is on
  myna skill show <network>                    Print the network's skill
  myna skill show <network:account> [slug]     Print an account's skill (its selected one by default)
  myna skill init [--force]                    Write every missing skill file; --force rewrites them all
  myna skill path <network[:account]> [slug]   Where the file is
  myna skill add <network:account> <slug>      Add a skill from --from <file> or stdin
  myna skill default <network:account> <slug>  Pin the skill a post uses
  myna skill rotate <network:account> [on|off] Take turns through the account's skills
  myna skill remove <network:account> <slug>   Delete one (never the default)

Files live in ${skillsDir()}. Agents: read the account skill, then the network skill, before posting.`;

type Target = Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">;

function targets(): Target[] {
  return skillTargets(listAccounts(), listDirectoryAccounts());
}

/** `network` or `network:account`, resolved against what is connected. */
function resolveSpec(spec: string | undefined): { network: string; account?: Target } {
  if (!spec) throw new Error(`Which one? ${USAGE}`);
  const all = targets();
  const account = findSkillTarget(spec, all);
  if (account) return { network: account.network, account };
  if (spec.includes(":")) {
    const network = spec.slice(0, spec.indexOf(":"));
    throw new Error(`No connected account matches "${spec}". Run: myna skill list${getNetwork(network) ? "" : `\nUnknown network "${network}" as well.`}`);
  }
  const network = getNetwork(spec)?.id ?? getDirectory(spec)?.id;
  if (!network) throw new Error(`"${spec}" is neither a network nor a connected account. Run: myna skill list`);
  return { network };
}

function requireAccount(spec: string | undefined): Target {
  const { account } = resolveSpec(spec);
  if (!account) throw new Error(`"${spec}" is a network. This command wants an account, as network:username. Run: myna skill list`);
  return account;
}

export async function runSkill(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;

  switch (sub ?? "list") {
    case "list": {
      const settings = loadSettings();
      const all = targets();
      const networks = [...new Set(all.map((target) => target.network))].sort();
      if (flags.json) {
        out(
          JSON.stringify(
            {
              dir: skillsDir(),
              networks: networks.map((network) => {
                const skill = readNetworkSkill(network);
                return { network, kind: skillKindFor(network), path: skill.path, materialised: Boolean(skill.raw), limits: pickLimits(skill.frontmatter) };
              }),
              accounts: all.map((target) => {
                const selection = selectSkill(target, settings);
                const resolved = resolveSkill(target, { settings, selected: selection.skill });
                return {
                  account: target.id,
                  network: target.network,
                  kind: resolved.kind,
                  selected: selection.skill.slug,
                  rotating: selection.rotating,
                  pinned: selection.pinned,
                  last: selection.last,
                  skills: selection.all.map((file) => ({ slug: file.slug, path: file.path, materialised: Boolean(file.raw), name: file.frontmatter.name })),
                  limits: stripSources(resolved.limits),
                };
              }),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (!all.length) {
        out("No accounts connected, so nothing has a skill yet. Run: myna login <network>");
        return 0;
      }
      out(`Skills in ${skillsDir()}\n`);
      table(
        networks.map((network) => {
          const skill = readNetworkSkill(network);
          return { network, kind: skillKindFor(network), file: skill.raw ? "written" : "template", limits: describeLimits(skill.frontmatter) };
        }),
        [
          { key: "network", title: "NETWORK" },
          { key: "kind", title: "KIND" },
          { key: "file", title: "FILE" },
          { key: "limits", title: "LIMITS" },
        ],
      );
      out("");
      table(
        all.map((target) => {
          const selection = selectSkill(target, settings);
          const resolved = resolveSkill(target, { settings, selected: selection.skill });
          const order = selection.all.map((file) => (file.slug === selection.skill.slug ? `[${file.slug}]` : file.slug)).join(" > ");
          return {
            account: target.id,
            using: selection.skill.slug + (selection.skill.raw ? "" : " (template)"),
            mode: selection.rotating ? `rotating${selection.last ? `, last ${selection.last}` : ""}` : selection.pinned ? `pinned ${selection.pinned}` : "default",
            skills: order,
            limits: describeLimits(resolved.limits),
          };
        }),
        [
          { key: "account", title: "ACCOUNT" },
          { key: "using", title: "USING" },
          { key: "mode", title: "MODE" },
          { key: "skills", title: "SKILLS" },
          { key: "limits", title: "EFFECTIVE LIMITS" },
        ],
      );
      const missing = all.filter((target) => !readAccountSkill(target)?.raw).length + networks.filter((network) => !readNetworkSkill(network).raw).length;
      if (missing) out(`\n${missing} file${missing === 1 ? " is" : "s are"} still the built-in template. Write them: myna skill init`);
      return 0;
    }

    case "init": {
      const result = initSkills(targets(), { force: Boolean(flags.force) });
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const path of result.written) out(`wrote  ${path}`);
      for (const path of result.kept) out(`kept   ${path}`);
      if (!result.written.length && !result.kept.length) out("No accounts connected, so nothing to write. Run: myna login <network>");
      else out(`\n${result.written.length} written, ${result.kept.length} left as they were.${result.kept.length && !flags.force ? " Pass --force to rewrite those from the templates." : ""}`);
      return 0;
    }

    case "show": {
      const { network, account } = resolveSpec(rest[0]);
      if (!account) {
        ensureNetworkSkill(network);
        const skill = readNetworkSkill(network);
        out(skill.raw.trimEnd());
        return 0;
      }
      ensureAccountSkill(account);
      const slug = rest[1];
      const settings = loadSettings();
      const selection = selectSkill(account, settings);
      const chosen = slug ? readAccountSkill(account, slug) : selection.skill;
      if (!chosen) throw new Error(`${account.id} has no skill called "${slug}". Run: myna skill list`);
      if (flags.json) {
        const resolved = resolveSkill(account, { settings, selected: chosen });
        out(JSON.stringify({ account: account.id, network, slug: chosen.slug, path: chosen.path, frontmatter: chosen.frontmatter, body: chosen.body, limits: resolved.limits, networkSkill: resolved.networkSkill.path }, null, 2));
        return 0;
      }
      out(chosen.raw.trimEnd());
      const resolved = resolveSkill(account, { settings, selected: chosen });
      out(`\n<!-- effective limits for ${account.id}: ${describeLimits(resolved.limits)}; network skill: ${resolved.networkSkill.path} -->`);
      return 0;
    }

    case "path": {
      const { network, account } = resolveSpec(rest[0]);
      if (!account) {
        out(networkSkillPath(network));
        return 0;
      }
      const slug = rest[1];
      const chosen = slug ? readAccountSkill(account, slug) : selectSkill(account).skill;
      if (!chosen) throw new Error(`${account.id} has no skill called "${slug}". Run: myna skill list`);
      out(chosen.path);
      return 0;
    }

    case "add": {
      const account = requireAccount(rest[0]);
      const slug = rest[1];
      if (!slug) throw new Error("Name it: myna skill add <network:account> <slug> --from file.md");
      const from = flags.from;
      const source = typeof from === "string" ? readFileSync(from, "utf8") : await readStdin();
      if (!source.trim()) throw new Error("Nothing to add. Pass --from <file> or pipe the skill in.");
      const file = addAccountSkill(account, slug, source, { force: Boolean(flags.force) });
      out(`wrote  ${file.path}`);
      const selection = selectSkill(account);
      if (!selection.rotating) out(`${account.id} still uses "${selection.skill.slug}". Pin this one: myna skill default ${account.id} ${file.slug}. Or take turns: myna skill rotate ${account.id} on`);
      return 0;
    }

    case "default": {
      const account = requireAccount(rest[0]);
      const slug = rest[1];
      if (!slug) throw new Error(`Which skill? ${selectSkill(account).all.map((file) => file.slug).join(", ")}`);
      ensureAccountSkill(account);
      pinDefaultSkill(account, slug);
      out(`${account.id} now uses "${slug}"${slug === DEFAULT_SKILL_SLUG ? " (the generated default)" : ""}.`);
      if (selectSkill(account).rotating) out("Rotation is on, so the pin only applies once it is off: myna skill rotate " + account.id + " off");
      return 0;
    }

    case "rotate": {
      const account = requireAccount(rest[0]);
      const mode = rest[1] ?? (flags.off ? "off" : "on");
      if (mode !== "on" && mode !== "off") throw new Error(`on or off, not "${mode}".`);
      setRotation(account, mode === "on");
      const selection = selectSkill(account);
      if (mode === "on" && selection.all.length < 2) out(`Rotation is on, but ${account.id} has only "${selection.all[0]?.slug}". Add another: myna skill add ${account.id} <slug> --from file.md`);
      else out(`${account.id} rotation ${mode}. ${mode === "on" ? `Next: ${selection.skill.slug}. Order: ${selection.all.map((file) => file.slug).join(" > ")}` : `Using: ${selection.skill.slug}`}`);
      return 0;
    }

    case "remove":
    case "rm": {
      const account = requireAccount(rest[0]);
      const slug = rest[1];
      if (!slug) throw new Error("Which one? myna skill remove <network:account> <slug>");
      if (!removeAccountSkill(account, slug)) throw new Error(`${account.id} has no skill called "${slug}".`);
      out(`removed ${slug} from ${account.id}`);
      return 0;
    }

    case "help":
    case "--help":
      out(USAGE);
      return 0;

    default:
      throw new Error(`Unknown skill command "${sub}".\n${USAGE}`);
  }
}

type LimitsLike = { [key: string]: unknown } | SkillLimits | ResolvedLimits;

function pickLimits(frontmatter: LimitsLike): Record<string, unknown> {
  const keys = ["maxPerDay", "minGapMinutes", "maxChars", "requiresCanonical", "contentPolicy"];
  const record = frontmatter as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function stripSources(limits: ResolvedLimits): Record<string, unknown> {
  const { sources, ...rest } = limits;
  return { ...rest, sources };
}

function describeLimits(input: LimitsLike): string {
  const limits = input as Record<string, unknown>;
  const parts: string[] = [];
  if (limits.maxPerDay !== undefined) parts.push(`${limits.maxPerDay}/day`);
  if (limits.minGapMinutes !== undefined) parts.push(`gap ${limits.minGapMinutes}m`);
  if (limits.maxChars !== undefined) parts.push(`${limits.maxChars} chars`);
  if (limits.requiresCanonical === true) parts.push("canonical");
  if (typeof limits.contentPolicy === "string" && limits.contentPolicy) parts.push(limits.contentPolicy);
  return parts.join(", ") || "none";
}
