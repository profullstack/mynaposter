/**
 * Hubs, as the REST API and the MCP tools both see them. Every call here is a
 * `myna hubs` subcommand. Approving is the only call that leads anywhere
 * public, and even it only queues: the scheduler's pacing sends.
 */
import { loadSettings } from "../store/settings.ts";
import { readHubs, type HubDraft, type HubDraftStatus } from "../store/hubs.ts";
import {
  approveHubDraft,
  editHubDraft,
  importHubs,
  listHubDrafts,
  rankedHubs,
  READABLE,
  removeHub,
  scanHubs,
  skipHubDraft,
  type HubInput,
} from "./hubs.ts";

const STATUSES: Array<HubDraftStatus | "all"> = ["pending", "queued", "handoff", "skipped", "all"];

export const draftView = (draft: HubDraft) => ({
  id: draft.id,
  hub: draft.hubId,
  network: draft.network,
  post: { url: draft.postUrl, text: draft.postText, postedAt: draft.postedAt },
  reply: draft.reply,
  status: draft.status,
  account: draft.account,
  queueId: draft.queueId,
  handoff: draft.handoffId,
  campaignId: draft.campaignId,
});

export function hubsOverview(options: { campaignId?: string } = {}) {
  const file = readHubs();
  const hubs = rankedHubs(file.hubs).filter((hub) => !options.campaignId || hub.campaignId === options.campaignId);
  return {
    settings: loadSettings().hubs,
    hubs: hubs.map((hub) => ({ ...hub, readable: READABLE.has(hub.network) })),
    drafts: {
      pending: file.drafts.filter((draft) => draft.status === "pending").length,
      queued: file.drafts.filter((draft) => draft.status === "queued").length,
      handoff: file.drafts.filter((draft) => draft.status === "handoff").length,
      skipped: file.drafts.filter((draft) => draft.status === "skipped").length,
    },
    posting: "Drafts only. A person approves each reply; approved replies are queued and paced by myna.",
  };
}

export function hubsAdd(input: HubInput & { campaignId?: string }) {
  return importHubs([input], { source: "manual", ...(input.campaignId ? { campaignId: input.campaignId } : {}) });
}

export function hubsImport(input: { hubs: HubInput[]; campaignId?: string; product?: { name: string; url: string; about?: string }; replace?: boolean }) {
  return importHubs(input.hubs, {
    source: "outreachgraph",
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.product ? { product: input.product } : {}),
    ...(input.replace ? { replace: true } : {}),
  });
}

export function hubsRemove(ref: string) {
  if (!removeHub(ref)) throw new Error(`No hub ${ref}.`);
  return { removed: ref };
}

export async function hubsScan(options: { hubs?: string[]; campaignId?: string } = {}) {
  const result = await scanHubs({
    ...(options.hubs?.length ? { hubs: options.hubs } : {}),
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  });
  return { ...result, drafts: result.drafts.map(draftView) };
}

export function hubsDrafts(status = "pending") {
  const wanted = status.trim().toLowerCase() as HubDraftStatus | "all";
  if (!STATUSES.includes(wanted)) throw new Error(`status is one of ${STATUSES.join(", ")}.`);
  return listHubDrafts(wanted).map(draftView);
}

export function hubsDecide(id: string, decision: { action: "approve" | "skip" | "edit"; text?: string; account?: string }) {
  if (decision.action === "skip") return draftView(skipHubDraft(id));
  if (decision.action === "edit") return draftView(editHubDraft(id, decision.text ?? ""));
  return draftView(approveHubDraft(id, { ...(decision.text ? { text: decision.text } : {}), ...(decision.account ? { account: decision.account } : {}) }));
}
