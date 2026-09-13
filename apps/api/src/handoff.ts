/**
 * Hand-offs, server side: the cards a person does by hand, kept where a
 * phone can reach them.
 *
 * A card is created by a signed-in myna cloud user and read by anyone who
 * holds its link. The id is 128 random bits, so the link is the whole secret,
 * and marking a card done needs the same link and nothing more: the person
 * on the phone is the person the card was made for. Listing and deleting
 * are the owner's.
 */
import { randomBytes } from "node:crypto";
import { normaliseHandoff, type HandoffInput } from "@profullstack/myna-core";
import { db } from "./db/index.ts";

export interface HandoffRow {
  id: string;
  user_id: string;
  place: string;
  title: string;
  text: string;
  open_url: string | null;
  steps: string[];
  account: string | null;
  created_at: Date;
  done_at: Date | null;
}

const shape = (row: HandoffRow, site: string) => ({
  id: row.id,
  place: row.place,
  title: row.title,
  text: row.text,
  openUrl: row.open_url,
  steps: row.steps,
  account: row.account,
  createdAt: new Date(row.created_at).toISOString(),
  doneAt: row.done_at ? new Date(row.done_at).toISOString() : null,
  url: `${site}/handoff/${row.id}`,
});

export type HandoffCard = ReturnType<typeof shape>;

/** Where the site lives, for the link a card carries. The API runs under it. */
export const siteUrl = (): string => (process.env.MYNA_SITE_URL ?? "https://mynaposter.com").replace(/\/+$/, "");

/** 22 characters of base64url: long enough to be the secret, short enough to type from a screenshot. */
const newId = (): string => randomBytes(16).toString("base64url");

/** What an id looks like, so a made-up path never reaches the database. */
export const ID_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export async function createHandoff(userId: string, input: Partial<HandoffInput> & Record<string, unknown>): Promise<HandoffCard> {
  const card = normaliseHandoff({
    place: String(input.place ?? ""),
    title: String(input.title ?? ""),
    text: String(input.text ?? ""),
    openUrl: typeof input.openUrl === "string" ? input.openUrl : undefined,
    steps: Array.isArray(input.steps) ? (input.steps as unknown[]).map(String) : [],
    account: typeof input.account === "string" ? input.account : undefined,
  });
  const id = newId();
  await db()`
    insert into handoffs (id, user_id, place, title, text, open_url, steps, account)
    values (${id}, ${userId}, ${card.place}, ${card.title}, ${card.text}, ${card.openUrl ?? null}, ${card.steps ?? []}, ${card.account ?? null})
  `;
  return shape((await getRow(id)) as HandoffRow, siteUrl());
}

async function getRow(id: string): Promise<HandoffRow | null> {
  if (!ID_SHAPE.test(id)) return null;
  const rows = (await db()`select * from handoffs where id = ${id}`) as unknown as HandoffRow[];
  return rows[0] ?? null;
}

export async function getHandoff(id: string): Promise<HandoffCard | null> {
  const row = await getRow(id);
  return row ? shape(row, siteUrl()) : null;
}

/** The owner's cards: open ones first, newest first; done ones only when asked. */
export async function listHandoffs(userId: string, options: { all?: boolean } = {}): Promise<HandoffCard[]> {
  const rows = (
    options.all
      ? await db()`select * from handoffs where user_id = ${userId} order by (done_at is null) desc, created_at desc limit 500`
      : await db()`select * from handoffs where user_id = ${userId} and done_at is null order by created_at desc limit 500`
  ) as unknown as HandoffRow[];
  return rows.map((row) => shape(row, siteUrl()));
}

/** Mark done, or open again. Anyone with the link may: the link is the card's audience. */
export async function finishHandoff(id: string, done = true): Promise<HandoffCard | null> {
  if (!(await getRow(id))) return null;
  if (done) await db()`update handoffs set done_at = coalesce(done_at, now()) where id = ${id}`;
  else await db()`update handoffs set done_at = null where id = ${id}`;
  return shape((await getRow(id)) as HandoffRow, siteUrl());
}

export async function removeHandoff(id: string, userId: string): Promise<boolean> {
  const row = await getRow(id);
  if (!row) return false;
  if (row.user_id !== userId) throw new Error("Only whoever made this hand-off can remove it.");
  await db()`delete from handoffs where id = ${id}`;
  return true;
}
