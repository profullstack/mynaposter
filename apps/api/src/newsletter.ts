/**
 * One-click unsubscribe for newsletters sent by myna, server side.
 *
 * A signed-in myna cloud user gets one inbox, a random public id their
 * unsubscribe links carry. The link is /v1/newsletter/u/<inbox>/<token>,
 * where the token was made on the sender's machine and means nothing here:
 * this side never learns an address.
 *
 * Two doors, one outcome:
 *   - the List-Unsubscribe-Post header (RFC 8058, what Gmail and Yahoo require
 *     of bulk senders): the mail client POSTs the link and nobody sees a page;
 *   - the footer link: one click unsubscribes and shows "you're unsubscribed"
 *     with a Re-subscribe button, so a click nobody meant is one press to undo.
 *
 * Each token has one row holding its latest state, `unsubscribed` or
 * `resubscribed`, stamped when it last changed. The sender's myna pulls the
 * rows changed since its last pull and opts people out, or back in.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db/index.ts";

/** Inbox ids and tokens are base64url, 16 to 64 characters. */
export const PART_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export type SubscriptionState = "unsubscribed" | "resubscribed";

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

/**
 * Set a token's state. Idempotent: pressing unsubscribe twice keeps the first
 * time, so a pull that already saw it is not handed it again.
 */
export async function recordState(inbox: string, token: string, state: SubscriptionState): Promise<boolean> {
  if (!PART_SHAPE.test(token) || !(await inboxExists(inbox))) return false;
  await db()`
    insert into newsletter_unsubscribes (inbox_id, token, state) values (${inbox}, ${token}, ${state})
    on conflict (inbox_id, token) do update set state = excluded.state, at = now()
    where newsletter_unsubscribes.state <> excluded.state
  `;
  return true;
}

export const recordUnsubscribe = (inbox: string, token: string): Promise<boolean> => recordState(inbox, token, "unsubscribed");
export const recordResubscribe = (inbox: string, token: string): Promise<boolean> => recordState(inbox, token, "resubscribed");

export async function listUnsubscribes(userId: string, since?: string): Promise<{ token: string; at: string; state: SubscriptionState }[]> {
  const after = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(0);
  const rows = (await db()`
    select u.token, u.at, u.state from newsletter_unsubscribes u
    join newsletter_inboxes i on i.id = u.inbox_id
    where i.user_id = ${userId} and date_trunc('milliseconds', u.at) > ${after}
    order by u.at asc
    limit 5000
  `) as unknown as { token: string; at: Date; state: SubscriptionState }[];
  return rows.map((row) => ({ token: row.token, at: new Date(row.at).toISOString(), state: row.state }));
}

// ---------------------------------------------------------------- the pages

/** The page's own policy: no script at all, inline style, forms that post to this origin. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#1a1a1a}" +
  "main{max-width:32rem;margin:12vh auto;padding:0 16px}" +
  "h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1a1a1a;color:#fff;cursor:pointer}" +
  "button.quiet{background:transparent;color:inherit;border:1px solid currentColor}" +
  "p.small{font-size:.85rem;color:#666}" +
  "@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}button.quiet{background:transparent;color:#eee}p.small{color:#999}}";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

/** What one click on the footer link shows: done, and the way back. */
export function unsubscribedPage(resubscribeAction: string): string {
  return page(
    "You're unsubscribed",
    `<h1>You're unsubscribed.</h1>
<p>You won't get this newsletter again. There is nothing else to do.</p>
<p>Clicked by mistake, or changed your mind?</p>
<form method="post" action="${resubscribeAction}"><button type="submit" class="quiet">Re-subscribe</button></form>
<p class="small">Sent with myna. The sender never shared your address with this page.</p>`,
  );
}

/** After Re-subscribe: back on, and one press to leave again. */
export function resubscribedPage(unsubscribeAction: string): string {
  return page(
    "You're subscribed again",
    `<h1>Welcome back. You're subscribed again.</h1>
<p>The next issue will reach you as before.</p>
<form method="post" action="${unsubscribeAction}"><button type="submit" class="quiet">Unsubscribe</button></form>
<p class="small">Sent with myna.</p>`,
  );
}

export function unknownPage(): string {
  return page("Link not recognised", `<h1>This unsubscribe link is not recognised.</h1><p>It may have been copied incompletely. Reply to the email and ask to be removed.</p>`);
}
