/**
 * `myna handoff`: the steps only a person can do, as cards.
 *
 *   myna handoff add <place> --title "..." [--open <url>] [--step "..."]... [--account x] [--local]
 *                                       text on stdin, or --from <file>
 *   myna handoff [list] [--all] [--json]
 *   myna handoff show <id>              the card, with its text
 *   myna handoff done <id> | undo <id>  mark it, here and on the cloud copy
 *   myna handoff rm <id>
 *
 * A card is kept here. When this machine is signed in to myna cloud it is
 * published too, and the command prints mynaposter.com/handoff/<id>: open it
 * on a phone, copy, paste, mark done.
 */
import { readFileSync } from "node:fs";
import { handoffs, type Handoff } from "@profullstack/myna-core";
import { out } from "./io.ts";
import { readStdin } from "./prompt.ts";

type Flags = Record<string, unknown>;

const stamp = (iso: string): string => iso.slice(0, 16).replace("T", " ");

function line(card: Handoff): string {
  const state = card.doneAt ? "done" : "open";
  return `${card.id}  ${state}  ${stamp(card.createdAt)}  ${card.place.padEnd(24)}  ${card.title}${card.cloudUrl ? `\n          ${card.cloudUrl}` : ""}`;
}

function show(card: Handoff): void {
  out(`${card.place}${card.account ? `  (from ${card.account})` : ""}`);
  out(card.title);
  out("");
  out(card.text);
  out("");
  if (card.openUrl) out(`open   ${card.openUrl}`);
  card.steps.forEach((step, index) => out(`${index + 1}. ${step}`));
  if (card.steps.length) out("");
  out(`id     ${card.id}${card.cloudId ? `   cloud ${card.cloudId}` : ""}`);
  if (card.cloudUrl) out(`card   ${card.cloudUrl}`);
  out(`made   ${stamp(card.createdAt)}${card.doneAt ? `   done ${stamp(card.doneAt)}` : ""}`);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []);

export async function runHandoff(positional: string[], flags: Flags): Promise<number> {
  const [sub = "list", ...rest] = positional;
  const json = flags.json === true;

  switch (sub) {
    case "list":
    case "ls": {
      const cards = handoffs.listHandoffs({ all: flags.all === true });
      if (json) {
        out(JSON.stringify(cards, null, 2));
        return 0;
      }
      if (!cards.length) {
        out(flags.all ? "No hand-offs yet." : "Nothing waiting on you. myna handoff list --all shows the done ones.");
        return 0;
      }
      for (const card of cards) out(line(card));
      return 0;
    }

    case "add": {
      const place = rest.join(" ").trim();
      if (!place) throw new Error('Usage: myna handoff add <place> --title "..." [--open <url>] [--step "..."] [--from file] < text.md');
      const title = typeof flags.title === "string" ? flags.title : "";
      const from = flags.from;
      const text = typeof from === "string" ? readFileSync(from, "utf8") : await readStdin();
      if (!text.trim()) throw new Error("Pipe the text to paste on stdin, or pass --from <file>.");

      const card = handoffs.addHandoff({
        place,
        title,
        text,
        openUrl: typeof flags.open === "string" ? flags.open : undefined,
        steps: strings(flags.step),
        account: typeof flags.account === "string" ? flags.account : undefined,
      });

      let published: Handoff = card;
      if (flags.local !== true && handoffs.cloudSignedIn()) {
        try {
          const cloud = await handoffs.publishHandoff(card);
          published = handoffs.attachCloud(card.id, cloud.id, cloud.url) ?? card;
        } catch (error) {
          out(`Kept here, not published: ${(error as Error).message}`);
        }
      }
      if (json) {
        out(JSON.stringify(published, null, 2));
        return 0;
      }
      out(`Hand-off ${published.id}: ${published.place}, ${published.title}`);
      if (published.cloudUrl) out(published.cloudUrl);
      else if (flags.local !== true) out("Not signed in to myna cloud, so the card is only here. myna cloud login, then myna handoff add again, publishes it.");
      return 0;
    }

    case "show": {
      const card = rest[0] && handoffs.getHandoff(rest[0]);
      if (!card) throw new Error(rest[0] ? `No hand-off ${rest[0]}.` : "Usage: myna handoff show <id>");
      if (json) out(JSON.stringify(card, null, 2));
      else show(card);
      return 0;
    }

    case "done":
    case "undo": {
      const done = sub === "done";
      const card = rest[0] && handoffs.markHandoff(rest[0], done);
      if (!card) throw new Error(rest[0] ? `No hand-off ${rest[0]}.` : `Usage: myna handoff ${sub} <id>`);
      if (card.cloudId) {
        try {
          await handoffs.finishCloudHandoff(card.cloudId, done);
        } catch (error) {
          out(`Marked here; the cloud copy was not updated: ${(error as Error).message}`);
        }
      }
      out(`${card.id} ${done ? "done" : "open again"}: ${card.title}`);
      return 0;
    }

    case "rm":
    case "remove": {
      const card = rest[0] && handoffs.getHandoff(rest[0]);
      if (!card) throw new Error(rest[0] ? `No hand-off ${rest[0]}.` : "Usage: myna handoff rm <id>");
      if (card.cloudId && handoffs.cloudSignedIn()) {
        try {
          await handoffs.removeCloudHandoff(card.cloudId);
        } catch (error) {
          out(`Removed here; the cloud copy stays: ${(error as Error).message}`);
        }
      }
      handoffs.removeHandoff(card.id);
      out(`Removed ${card.id}.`);
      return 0;
    }

    default:
      throw new Error(`Unknown handoff command "${sub}". Try: add, list, show, done, undo, rm`);
  }
}
