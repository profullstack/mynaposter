/**
 * `myna autopilot`: hold a cadence, and get out of the way when you are
 * already holding it yourself.
 *
 *   myna autopilot                  where the cadence stands, and what is next
 *   myna autopilot on | off
 *   myna autopilot now [--dry-run]  take one turn immediately
 *   myna autopilot set <key> <val>  perWeek, holdHours, to, refillPlan, planAheadDays
 *
 * It never publishes in the moment. Everything it books lands at least
 * `holdHours` out, where `myna queue` lists it and `myna cancel` removes it.
 */
import { cadence, loadSettings, runAutopilot, saveSettings, pendingPlan, writerAvailable } from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const NUMERIC = new Set(["perWeek", "holdHours", "planAheadDays"]);
const BOOLEAN = new Set(["refillPlan"]);
const TEXT = new Set(["to"]);

export async function runAutopilotCommand(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();

  switch (sub ?? "status") {
    case "status": {
      const state = cadence(new Date(), settings);
      const open = pendingPlan().length;
      if (flags.json) {
        out(JSON.stringify({ ...settings.autopilot, cadence: state, planOpen: open }, null, 2));
        return 0;
      }
      out(
        settings.autopilot.enabled
          ? "Autopilot is on: the daemon takes one turn an hour and books at most one post."
          : "Autopilot is off (myna autopilot on).",
      );
      out(`  cadence: ${state.total} of ${state.target} a week (${state.sent} sent in the last 7 days, ${state.booked} booked for the next 7)`);
      out(
        state.deficit > 0
          ? `  ${state.deficit} short, so it will fill ${state.deficit === 1 ? "one slot" : "those slots"} from the plan`
          : "  at cadence, so it will do nothing",
      );
      out(`  hold: nothing is booked sooner than ${settings.autopilot.holdHours}h out`);
      out(`  to: ${settings.autopilot.to || `${settings.defaultTargets} (defaultTargets)`}`);
      out(`  plan: ${open} item${open === 1 ? "" : "s"} waiting${settings.autopilot.refillPlan ? `, topped up to ${settings.autopilot.planAheadDays} days when empty` : ", no automatic top-up"}`);
      const writer = writerAvailable();
      if (!writer.ok) out(`  writer: not available (${writer.reason}), so it cannot draft anything`);
      return 0;
    }

    case "on":
    case "off": {
      settings.autopilot = { ...settings.autopilot, enabled: sub === "on" };
      saveSettings(settings);
      if (sub === "off") {
        out("Off. Anything already booked stays booked; myna queue lists it.");
        return 0;
      }
      out(`On. myna run takes a turn an hour, holding ${settings.autopilot.perWeek} posts a week.`);
      out(`Nothing it books is due sooner than ${settings.autopilot.holdHours}h out, so you always have that long to cancel.`);
      const writer = writerAvailable();
      if (!writer.ok) out(`The writer is not available (${writer.reason}), so it cannot draft until it is.`);
      return 0;
    }

    case "now": {
      const turn = await runAutopilot({ dryRun: Boolean(flags.dryRun), log: (line) => out(line) });
      out(turn.reason);
      if (turn.item && turn.idle === false) {
        out("");
        out(`  ${turn.item.angle}`);
        if (turn.item.text) out(`  ${turn.item.text.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      for (const post of turn.queued ?? []) {
        out(`  queued ${post.id} for ${post.scheduledFor.slice(0, 16).replace("T", " ")} to ${post.targets[0]}`);
      }
      return 0;
    }

    case "set": {
      const [key, ...value] = rest;
      const text = value.join(" ").trim();
      if (!key) throw new Error("Which one? perWeek, holdHours, to, refillPlan, planAheadDays");
      const next = { ...settings.autopilot };
      if (NUMERIC.has(key)) {
        const number = Number(text);
        if (!Number.isFinite(number) || number <= 0) throw new Error(`${key} wants a positive number.`);
        (next as unknown as Record<string, number>)[key] = number;
      } else if (BOOLEAN.has(key)) {
        (next as unknown as Record<string, boolean>)[key] = text === "" ? true : /^(on|true|yes|1)$/i.test(text);
      } else if (TEXT.has(key)) {
        (next as unknown as Record<string, string>)[key] = text;
      } else {
        throw new Error(`Unknown key "${key}". One of: perWeek, holdHours, to, refillPlan, planAheadDays`);
      }
      settings.autopilot = next;
      saveSettings(settings);
      out(`${key}: ${(next as unknown as Record<string, unknown>)[key]}`);
      return 0;
    }

    default:
      throw new Error(`Unknown: myna autopilot ${sub}. Try: status, on, off, now, set`);
  }
}
