/**
 * One-click unsubscribe for newsletters sent by myna, server side.
 *
 * A signed-in myna cloud user gets one inbox, a random public id their
 * unsubscribe links carry. The link is /v1/newsletter/u/<inbox>/<token>,
 * where the token was made on the sender's machine and means nothing here:
 * this side never learns an address. A POST to the link (the mail client's
 * one-click, RFC 8058, or the button on the page a GET shows) records the
 * token; the sender's myna pulls the tokens back and opts those people out.
 *
 * A GET never unsubscribes. Link scanners and preview panes fetch every URL
 * in a message, and a reader should not lose a subscription to one.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db/index.ts";

/** Inbox ids and tokens are base64url, 16 to 64 characters. */
export const PART_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export async function ensureInbox(userId: string): Promise<string> {
  const existing = (await db()`select id from newsletter_inboxes where user_id = ${userId}`) as unknown as { id: string }[];
  if (existing[0]) return existing[0].id;
  const id = randomBytes(12).toString("base64url");
  const rows = (await db()`
    insert into newsletter_inboxes (id, user_id) values (${id}, ${userId})
    on conflict (user_id) do update set user_id = excluded.user_id
    returning id
  `) as unknown as { id: string }[];
  return (rows[0] as { id: string }).id;
}

export async function inboxExists(inbox: string): Promise<boolean> {
  if (!PART_SHAPE.test(inbox)) return false;
  const rows = await db()`select 1 from newsletter_inboxes where id = ${inbox}`;
  return rows.length > 0;
}

/** Record one unsubscribe. Idempotent: pressing twice keeps the first time. */
export async function recordUnsubscribe(inbox: string, token: string): Promise<boolean> {
  if (!PART_SHAPE.test(token) || !(await inboxExists(inbox))) return false;
  await db()`
    insert into newsletter_unsubscribes (inbox_id, token) values (${inbox}, ${token})
    on conflict (inbox_id, token) do nothing
  `;
  return true;
}

export async function listUnsubscribes(userId: string, since?: string): Promise<{ token: string; at: string }[]> {
  const after = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(0);
  const rows = (await db()`
    select u.token, u.at from newsletter_unsubscribes u
    join newsletter_inboxes i on i.id = u.inbox_id
    where i.user_id = ${userId} and u.at > ${after}
    order by u.at asc
    limit 5000
  `) as unknown as { token: string; at: Date }[];
  return rows.map((row) => ({ token: row.token, at: new Date(row.at).toISOString() }));
}

// ---------------------------------------------------------------- the page

/** The page's own policy: no script at all, inline style, a form that posts to itself. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#1a1a1a}" +
  "main{max-width:32rem;margin:12vh auto;padding:0 16px}" +
  "h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1a1a1a;color:#fff;cursor:pointer}" +
  "p.small{font-size:.85rem;color:#666}" +
  "@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}p.small{color:#999}}";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function confirmPage(): string {
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe from this newsletter?</h1>
<p>You will not get it again. Nothing else is needed.</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>
<p class="small">Sent with myna. The sender never shared your address with this page.</p>`,
  );
}

export function donePage(): string {
  return page("Unsubscribed", `<h1>You are unsubscribed.</h1><p>The sender's next send leaves you out, for good.</p><p class="small">Sent with myna.</p>`);
}

export function unknownPage(): string {
  return page("Link not recognised", `<h1>This unsubscribe link is not recognised.</h1><p>It may have been copied incompletely. Reply to the email and ask to be removed.</p>`);
}
