/**
 * `myna plan` and `myna atomize`.
 *
 *   myna plan                          what is planned, and what state it is in
 *   myna plan generate [--days 30]     angles from the brand's pillars
 *        [--per-week 5] [--to all]
 *   myna plan draft <id>               write the copy for one angle
 *   myna plan queue <id> [--at when]   book a drafted item
 *   myna plan drop <id> | clear
 *
 *   myna atomize <url|file>            one long thing becomes many dated angles
 *        [--angles 12] [--over 30d] [--dry-run]
 *
 * A plan item is a subject and an angle on a date, with no copy. That is the
 * whole design: a month generated as finished posts is a month of copy to
 * delete, a month generated as angles is a list you can read in thirty seconds.
 */
import {
  atomize,
  draftPlanItem,
  generatePlan,
  getPlanItem,
  listPlan,
  clearOpenPlan,
  queuePlanItem,
  removePlanItem,
  type PlanItem,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";
import { parseWhen, parseDuration } from "../tui/when.ts";

type Flags = Record<string, unknown>;

const DAY_MS = 86_400_000;

/** "30d", "3w", or a bare number of days. */
function daysFrom(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value);
  if (/^\d+$/.test(text)) return Number(text);
  const ms = parseDuration(text);
  if (ms === undefined) throw new Error(`I do not understand "${text}". Try: 30d, 6w`);
  return Math.max(1, Math.round(ms / DAY_MS));
}

const targetsFrom = (flags: Flags): string[] | undefined =>
  typeof flags.to === "string" && flags.to.trim() ? [flags.to.trim()] : undefined;

function printPlan(items: PlanItem[]): void {
  table(
    items.map((item) => ({
      id: item.id,
      when: item.forDate,
      status: item.status,
      pillar: item.pillar.slice(0, 18),
      angle: item.angle.replace(/\s+/g, " ").slice(0, 64),
    })),
    [
      { key: "id", title: "ID" },
      { key: "when", title: "FOR" },
      { key: "status", title: "STATUS" },
      { key: "pillar", title: "PILLAR" },
      { key: "angle", title: "ANGLE" },
    ],
  );
}

export async function runPlan(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;

  switch (sub ?? "status") {
    case "status":
    case "list": {
      const all = listPlan();
      const items = flags.all ? all : all.filter((item) => item.status === "open" || item.status === "drafted");
      if (flags.json) {
        out(JSON.stringify(items, null, 2));
        return 0;
      }
      if (!items.length) {
        out(all.length ? "Nothing open. myna plan --all shows everything." : "Nothing planned.");
        out("");
        out("  myna plan generate           angles from your brand's pillars");
        out("  myna atomize <url>           angles from one long thing you wrote");
        return 0;
      }
      printPlan(items);
      out("");
      const open = all.filter((item) => item.status === "open").length;
      const drafted = all.filter((item) => item.status === "drafted").length;
      const queued = all.filter((item) => item.status === "queued").length;
      out(`${open} open, ${drafted} drafted, ${queued} queued.`);
      out("myna plan draft <id> writes one; myna plan queue <id> books it.");
      return 0;
    }

    case "generate": {
      const result = await generatePlan({
        days: daysFrom(flags.days, 30),
        perWeek: Number(flags.perWeek ?? 5),
        targets: targetsFrom(flags),
        log: (line) => out(line),
      });
      out("");
      if (!result.items.length) {
        out(result.duplicates ? "Everything it came up with was already planned." : "Nothing planned.");
        return result.items.length ? 0 : 1;
      }
      printPlan(result.items);
      return 0;
    }

    case "draft": {
      const id = rest[0];
      if (!id) throw new Error("Which one? Run: myna plan");
      const item = getPlanItem(id);
      if (!item) throw new Error(`No plan item ${id}`);
      if (item.text && !flags.force) {
        out(item.text);
        out("");
        out("Already drafted. --force rewrites it.");
        return 0;
      }
      // draftPlanItem returns early when the item already carries a draft, so
      // the rewrite is asked for by handing it one that does not.
      const drafted = await draftPlanItem({ ...item, text: undefined });
      out(drafted.text ?? "");
      out("");
      out(`myna plan queue ${drafted.id} books it.`);
      return 0;
    }

    case "queue": {
      const id = rest[0];
      if (!id) throw new Error("Which one? Run: myna plan");
      let item = getPlanItem(id);
      if (!item) throw new Error(`No plan item ${id}`);
      if (!item.text) {
        out(`Drafting ${item.id} first.`);
        item = await draftPlanItem(item);
      }
      const at = flags.at ? parseWhen(String(flags.at)).at.getTime() : Date.now() + 60_000;
      const result = await queuePlanItem(item, { from: at, targets: targetsFrom(flags), log: (line) => out(line) });
      for (const post of result.queued) {
        out(`Queued ${post.id} for ${post.scheduledFor.slice(0, 16).replace("T", " ")} to ${post.targets[0]}`);
      }
      for (const skip of result.skipped) out(`skip  ${skip.id}  ${skip.reason}`);
      return result.queued.length ? 0 : 1;
    }

    case "drop":
    case "rm": {
      const id = rest[0];
      if (!id) throw new Error("Which one? Run: myna plan");
      if (!removePlanItem(id)) throw new Error(`No plan item ${id}`);
      out(`Dropped ${id}.`);
      return 0;
    }

    case "clear": {
      const gone = clearOpenPlan();
      out(gone ? `Cleared ${gone} item${gone === 1 ? "" : "s"} that had not been booked.` : "Nothing open to clear.");
      return 0;
    }

    default:
      throw new Error(`Unknown: myna plan ${sub}. Try: status, generate, draft, queue, drop, clear`);
  }
}

export async function runAtomize(positional: string[], flags: Flags): Promise<number> {
  const source = positional[0];
  if (!source) throw new Error("What should I split? Try: myna atomize https://example.com/blog/post");

  const result = await atomize({
    source,
    angles: flags.angles ? Number(flags.angles) : undefined,
    overDays: daysFrom(flags.over, 30),
    targets: targetsFrom(flags),
    dryRun: Boolean(flags.dryRun),
    log: (line) => out(line),
  });

  out("");
  out(result.title);
  out("");
  if (result.items.length) {
    printPlan(result.items);
    out("");
    out(`${result.items.length} planned. myna plan shows them; myna plan draft <id> writes one.`);
    return 0;
  }
  // A dry run has no ids to print, so print the angles themselves.
  for (const angle of result.angles) out(`- ${angle.pillar ? `[${angle.pillar}] ` : ""}${angle.angle}`);
  if (!result.angles.length) {
    out("Nothing to split out of that.");
    return 1;
  }
  if (result.duplicates) out(`\n${result.duplicates} of these are already in the plan.`);
  return 0;
}
