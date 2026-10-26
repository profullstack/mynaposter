/**
 * `myna brain`: the team's content brain, a git repo of Markdown.
 *
 *   myna brain init <dir> [--product p]      scaffold one, seeded from brand.md and your skills, and link it
 *   myna brain link <git-url|path> [--product p]
 *   myna brain unlink
 *   myna brain pull                           git pull --ff-only; lists what changed
 *   myna brain push [-m "msg"]                git add -A, commit, push
 *   myna brain show|status [--show-prompt] [--json]
 *
 * Layout and workflow: docs/brain.md.
 */
import {
  brainStatus,
  initBrain,
  linkBrain,
  loadBrand,
  planBrainPrompt,
  pullBrain,
  pushBrain,
  unlinkBrain,
  type BrainStatus,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const USAGE = [
  "myna brain init <dir> [--product <slug>]       scaffold a brain repo and link it",
  "myna brain link <git-url|path> [--product <slug>]",
  "myna brain unlink",
  "myna brain pull",
  'myna brain push [-m "message"]',
  "myna brain show [--show-prompt] [--json]",
];

const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

function show(status: BrainStatus): void {
  if (!status.linked) {
    out("No brain linked. The writer reads brand.md only.");
    out("");
    for (const line of USAGE.slice(0, 2)) out(`  ${line}`);
    return;
  }
  out(`source:    ${status.source}`);
  out(`dir:       ${status.dir}${status.present ? "" : " (missing here; run: myna brain pull)"}`);
  if (status.product) out(`product:   ${status.product}`);
  out(`last pull: ${status.lastPull ?? "never"}`);
  if (status.git) out(`HEAD:      ${status.git.sha} ${status.git.subject}${status.git.branch ? ` (${status.git.branch})` : ""}${status.git.dirty ? " [uncommitted changes]" : ""}`);
  else if (status.present) out("HEAD:      (not a git repo)");
  if (status.files.length) {
    out("");
    out("Files:");
    const width = Math.max(...status.files.map((file) => file.path.length));
    for (const file of status.files) out(`  ${file.path.padEnd(width)}  ${size(file.bytes)}`);
  }
  out("");
  if (!status.prompt.included.length && !status.prompt.truncated) {
    out("In the prompt: nothing (no knowledge/*.md yet).");
    return;
  }
  out(`In the prompt (${size(status.prompt.bytes)}, in this order):`);
  for (const path of status.prompt.included) out(`  ${path}`);
  if (status.prompt.truncated) out(`  ${status.prompt.truncated} (truncated at the cap)`);
  if (status.prompt.omitted.length) out(`Left out (over the cap): ${status.prompt.omitted.join(", ")}`);
}

export async function runBrain(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const product = typeof flags.product === "string" ? flags.product : undefined;

  switch (sub ?? "show") {
    case "show":
    case "status": {
      const status = brainStatus();
      if (flags.json) {
        out(JSON.stringify(flags.showPrompt ? { ...status, text: planBrainPrompt().text } : status, null, 2));
        return 0;
      }
      show(status);
      if (flags.showPrompt) {
        out("");
        out("----- knowledge block appended to every writer system prompt -----");
        out(planBrainPrompt().text.trim() || "(empty)");
      }
      return 0;
    }

    case "init": {
      const dir = rest[0];
      if (!dir) {
        out("Say where: myna brain init <dir>");
        return 1;
      }
      const result = initBrain(dir, { product, force: Boolean(flags.force), brand: loadBrand() });
      out(`brain at ${result.dir}`);
      for (const file of result.written) out(`  wrote ${file}`);
      out(result.seededFromBrand ? "  positioning/voice seeded from brand.md" : "  no brand.md: knowledge files are templates. Start with knowledge/positioning.md");
      out(`  ${result.skillsCopied} skill file${result.skillsCopied === 1 ? "" : "s"} copied into skills/`);
      out(result.committed ? "  committed: myna brain init" : `  ${result.note ?? "not committed"}`);
      out("");
      out(`linked. Add a remote and push to share it: git -C ${result.dir} remote add origin <url> && myna brain push`);
      return 0;
    }

    case "link": {
      const source = rest[0];
      if (!source) {
        out("myna brain link <git-url|path> [--product <slug>]");
        return 1;
      }
      const brain = linkBrain(source, { product, log: (line) => out(line) });
      out(`linked ${brain.source}`);
      out(`  dir: ${brain.dir}${brain.product ? `\n  product: ${brain.product}` : ""}`);
      const plan = planBrainPrompt();
      out(`  ${plan.included.length} knowledge file${plan.included.length === 1 ? "" : "s"} go into the prompt`);
      return 0;
    }

    case "unlink": {
      const result = unlinkBrain();
      if (!result.was) {
        out("No brain was linked.");
        return 0;
      }
      out(`unlinked ${result.was.source}${result.removed ? ` (removed the clone at ${result.removed})` : ""}`);
      return 0;
    }

    case "pull": {
      const result = pullBrain();
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }
      if (!result.ok) {
        out(`pull failed: ${result.error}`);
        return 1;
      }
      if (result.skipped) {
        out(`skipped: ${result.skipped}`);
        return 0;
      }
      if (result.cloned) out(`cloned into ${result.dir}`);
      else if (!result.changed.length) out(`up to date at ${result.to?.slice(0, 7) ?? "?"}`);
      else {
        out(`${result.from?.slice(0, 7)}..${result.to?.slice(0, 7)}: ${result.changed.length} changed`);
        for (const file of result.changed) out(`  ${file}`);
      }
      return 0;
    }

    case "push": {
      // No short flags in the parser, so -m arrives as a positional.
      const at = rest.indexOf("-m");
      const message = typeof flags.message === "string" ? flags.message : at >= 0 ? rest[at + 1] : rest.join(" ") || undefined;
      const result = pushBrain(message || undefined);
      if (!result.ok) {
        out(`push failed: ${result.error}`);
        return 1;
      }
      out(`${result.committed ? "committed" : "nothing new to commit"}${result.sha ? ` ${result.sha}` : ""}${result.pushed ? ", pushed" : ""}`);
      if (result.note) out(result.note);
      return 0;
    }

    default:
      out(`Unknown: myna brain ${sub}`);
      for (const line of USAGE) out(`  ${line}`);
      return 1;
  }
}
