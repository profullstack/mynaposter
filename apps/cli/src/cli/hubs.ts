/**
 * `myna hubs`: engage the hubs.
 *
 *   myna hubs [--campaign <id>]           the ranked hubs and the drafts waiting
 *   myna outreachgraph hubs <campaign>    rank a campaign's hubs in OutreachGraph and import them
 *   myna hubs add <network> <handle> [--score N] [--campaign <id>]
 *   myna hubs rm <hub>
 *   myna hubs scan [--hub a,b] [--campaign <id>]
 *                                         read the hubs' newest posts and draft replies
 *   myna hubs drafts [--status pending|queued|handoff|skipped|all]
 *   myna hubs approve <id> [--text "…"] [--account <id>]
 *                                         queue the reply under their post; pacing sends it
 *   myna hubs skip <id> | edit <id> "…"
 *
 * Drafts only. Nothing here replies to anyone until a person approves it, and
 * an approved reply still waits its turn in the queue.
 */
import {
  approveHubDraft,
  editHubDraft,
  HUB_NETWORKS,
  importHubs,
  listHubDrafts,
  rankedHubs,
  readHubs,
  removeHub,
  scanHubs,
  skipHubDraft,
  type HubDraft,
  type HubDraftStatus,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function draftLine(draft: HubDraft): void {
  out(`  ${draft.id}  ${draft.status.padEnd(8)} ${draft.hubId}  ${draft.postedAt.slice(0, 10)}`);
  out(`      theirs: ${oneLine(draft.postText, 110)}`);
  out(`      reply:  ${oneLine(draft.reply, 110)}`);
  out(`      ${draft.postUrl}`);
}

export async function runHubs(positional: string[], flags: Flags): Promise<number> {
  const [, sub = "status", ...rest] = positional;
  const json = Boolean(flags.json);
  const campaignId = str(flags.campaign);

  switch (sub) {
    case "status":
    case "list":
    case "ls": {
      const file = readHubs();
      const hubs = rankedHubs(file.hubs).filter((hub) => !campaignId || hub.campaignId === campaignId);
      if (json) {
        out(JSON.stringify({ hubs, pending: file.drafts.filter((draft) => draft.status === "pending").length }, null, 2));
        return 0;
      }
      if (!hubs.length) {
        out("No hubs yet. myna outreachgraph hubs <campaign> ranks a campaign's, or myna hubs add bluesky <handle>.");
        return 0;
      }
      out(`${hubs.length} hub${hubs.length === 1 ? "" : "s"}${campaignId ? ` for ${campaignId}` : ""}, best first:`);
      for (const hub of hubs) {
        const readable = HUB_NETWORKS.has(hub.network) ? "" : "  (watch by hand)";
        out(`  ${hub.score.toFixed(1).padStart(5)}  ${hub.id}${hub.displayName ? `  ${hub.displayName}` : ""}${readable}`);
        if (hub.why) out(`         ${hub.why}`);
        if (hub.note) out(`         ! ${hub.note}`);
      }
      const pending = file.drafts.filter((draft) => draft.status === "pending");
      out(`\n${pending.length} draft${pending.length === 1 ? "" : "s"} waiting. myna hubs drafts`);
      return 0;
    }

    case "add": {
      const [network, handle] = rest;
      if (!network || !handle) throw new Error("Usage: myna hubs add <network> <handle> [--score N] [--campaign <id>]");
      const score = Number(flags.score ?? 1);
      const result = importHubs([{ network, handle, score: Number.isFinite(score) ? score : 1, why: "added by hand" }], {
        source: "manual",
        ...(campaignId ? { campaignId } : {}),
      });
      out(result.added ? `Added ${network}:${handle}.` : `Updated ${network}:${handle}.`);
      return 0;
    }

    case "rm":
    case "remove": {
      if (!rest[0] || !removeHub(rest[0])) throw new Error(rest[0] ? `No hub ${rest[0]}.` : "Usage: myna hubs rm <hub>");
      out(`Removed ${rest[0]}.`);
      return 0;
    }

    case "scan": {
      const only = str(flags.hub)?.split(",").map((ref) => ref.trim()).filter(Boolean);
      const result = await scanHubs({ ...(only?.length ? { hubs: only } : {}), ...(campaignId ? { campaignId } : {}) });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const read of result.read) out(`  ${read.hub.padEnd(40)} ${String(read.posts).padStart(3)} posts, ${read.fresh} new${read.note ? `  ! ${read.note}` : ""}`);
      if (result.manual.length) out(`  watch by hand (no public read): ${result.manual.join(", ")}`);
      if (result.note) out(result.note);
      out(`${result.drafts.length} draft${result.drafts.length === 1 ? "" : "s"} written, ${result.declined} post${result.declined === 1 ? "" : "s"} not worth a reply. Nothing was posted.`);
      for (const draft of result.drafts) draftLine(draft);
      if (result.drafts.length) out("\nmyna hubs approve <id> queues one under their post; myna hubs skip <id> drops it.");
      return 0;
    }

    case "drafts": {
      const status = (str(flags.status) ?? "pending") as HubDraftStatus | "all";
      const drafts = listHubDrafts(status).filter((draft) => !campaignId || draft.campaignId === campaignId);
      if (json) {
        out(JSON.stringify(drafts, null, 2));
        return 0;
      }
      if (!drafts.length) out(`No ${status === "all" ? "" : `${status} `}drafts. myna hubs scan writes them.`);
      for (const draft of drafts) draftLine(draft);
      return 0;
    }

    case "approve": {
      if (!rest[0]) throw new Error('Usage: myna hubs approve <id> [--text "…"] [--account <id>]');
      const draft = approveHubDraft(rest[0], {
        ...(str(flags.text) ? { text: str(flags.text) } : {}),
        ...(str(flags.account) ? { account: str(flags.account) } : {}),
      });
      if (draft.status === "queued") out(`Queued as ${draft.queueId} from ${draft.account}, under ${draft.postUrl}. Pacing decides when it goes: myna queue`);
      else out(`No ${draft.network} account myna can reply from: hand-off card ${draft.handoffId} (myna handoff show ${draft.handoffId}).`);
      return 0;
    }

    case "skip": {
      if (!rest[0]) throw new Error("Usage: myna hubs skip <id>");
      out(`Skipped ${skipHubDraft(rest[0]).id}.`);
      return 0;
    }

    case "edit": {
      const [ref, ...words] = rest;
      const text = words.join(" ").trim() || str(flags.text);
      if (!ref || !text) throw new Error('Usage: myna hubs edit <id> "new reply"');
      out(`Draft ${editHubDraft(ref, text).id} now reads: ${text}`);
      return 0;
    }

    default:
      out(`No such thing as myna hubs ${sub}. Try: status, add, rm, scan, drafts, approve, skip, edit`);
      return 1;
  }
}
