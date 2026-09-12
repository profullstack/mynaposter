/**
 * The reshare network, server side.
 *
 * The server holds three things and does none of the sharing: profiles
 * (an OpenProfile.md per person, with the matcher's fields read out of it),
 * requests (an author's posts and offer) and claims (one sharer, one
 * request, one network, with the outcome the sharer reported). Every
 * reshare is done by the sharer's own myna with the sharer's own accounts,
 * so nothing here ever holds a social token or posts on anyone's behalf.
 *
 * Matching is the same pure function the CLI uses, imported from core, so a
 * sharer sees the same answer whether they ask the server or score locally.
 */
import { parseOpenProfile, scoreMatch, sharerFromProfile, type MatchSharer } from "@profullstack/myna-core";
import { db } from "./db/index.ts";

export interface ProfileStatus {
  joined: boolean;
  handle: string | null;
  topics: string[];
  networks: string[];
  rateUsd: number;
  perDay: number;
  updatedAt: string | null;
  done: number;
  open: number;
}

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_POSTS = 30;
const MAX_TOPICS = 40;

interface ProfileRow {
  user_id: string;
  markdown: string;
  name: string | null;
  handle: string | null;
  topics: string[];
  refused: string[];
  networks: string[];
  accounts: string[];
  rate_usd: string;
  per_day: number;
  pay: string | null;
  active: boolean;
  updated_at: Date;
}

const sharerOf = (row: ProfileRow): MatchSharer => ({
  topics: row.topics,
  not: row.refused,
  networks: row.networks,
  accounts: row.accounts,
  rateUsd: Number(row.rate_usd),
});

async function profileStatus(userId: string, row: ProfileRow | undefined): Promise<ProfileStatus> {
  const counts = await db()`
    select
      (select count(*) from reshare_claims where sharer_id = ${userId} and status = 'done') as done,
      (select count(*) from reshare_requests where user_id = ${userId} and status = 'open' and expires_at > now()) as open
  `;
  const first = counts[0] as { done: string; open: string } | undefined;
  return {
    joined: Boolean(row?.active),
    handle: row?.handle ?? null,
    topics: row?.topics ?? [],
    networks: row?.networks ?? [],
    rateUsd: row ? Number(row.rate_usd) : 0,
    perDay: row?.per_day ?? 0,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    done: Number(first?.done ?? 0),
    open: Number(first?.open ?? 0),
  };
}

async function profileRow(userId: string): Promise<ProfileRow | undefined> {
  const rows = await db()`select * from reshare_profiles where user_id = ${userId}`;
  return rows[0] as ProfileRow | undefined;
}

/** Store a profile. The Markdown is kept whole; the columns are what the matcher narrows on. */
export async function putProfile(userId: string, markdown: string): Promise<ProfileStatus> {
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("Send the OpenProfile.md as `markdown`.");
  if (Buffer.byteLength(markdown, "utf8") > MAX_PROFILE_BYTES) throw new Error("That profile is over 64 KB.");

  const profile = parseOpenProfile(markdown);
  if (!profile.name) throw new Error("The profile needs a `# Name` heading.");
  if (!profile.reshare) throw new Error("The profile has no `## Reshare` section, so it offers nothing to the network.");
  if (profile.reshare.rateUsd > 0 && !profile.pay) {
    throw new Error("A Reshare rate above free needs a `Pay` line in the identity block, or nobody can honour it.");
  }
  const sharer = sharerFromProfile(profile);

  await db()`
    insert into reshare_profiles (user_id, markdown, name, handle, topics, refused, networks, accounts, rate_usd, per_day, pay, active, updated_at)
    values (
      ${userId}, ${markdown}, ${profile.name}, ${profile.handle},
      ${sharer.topics.slice(0, MAX_TOPICS)}, ${sharer.not.slice(0, MAX_TOPICS)}, ${sharer.networks}, ${sharer.accounts ?? []},
      ${sharer.rateUsd}, ${profile.reshare.limitPerDay ?? 3}, ${profile.pay}, true, now()
    )
    on conflict (user_id) do update set
      markdown = excluded.markdown, name = excluded.name, handle = excluded.handle,
      topics = excluded.topics, refused = excluded.refused, networks = excluded.networks, accounts = excluded.accounts,
      rate_usd = excluded.rate_usd, per_day = excluded.per_day, pay = excluded.pay, active = true, updated_at = now()
  `;
  return profileStatus(userId, await profileRow(userId));
}

export async function getProfile(userId: string): Promise<ProfileStatus> {
  return profileStatus(userId, await profileRow(userId));
}

export async function getProfileMarkdown(userId: string): Promise<string | null> {
  return (await profileRow(userId))?.markdown ?? null;
}

/** Leave: the profile stays (so the ledger keeps its names) but matches nothing. */
export async function leave(userId: string): Promise<boolean> {
  const rows = await db()`update reshare_profiles set active = false, updated_at = now() where user_id = ${userId} returning user_id`;
  return rows.length > 0;
}

export interface RequestInput {
  title?: string;
  text?: string;
  topics?: string[];
  posts?: Array<{ network: string; url: string; id?: string }>;
  link?: string | null;
  bountyUsd?: number;
  maxSharers?: number;
}

const isUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/\S+$/i.test(value);

export async function createRequest(userId: string, input: RequestInput): Promise<{ id: string; matched: number }> {
  const posts = (Array.isArray(input.posts) ? input.posts : [])
    .filter((post) => post && typeof post.network === "string" && isUrl(post.url))
    .slice(0, MAX_POSTS)
    .map((post) => ({ network: post.network.toLowerCase(), url: post.url, ...(post.id ? { id: String(post.id) } : {}) }));
  const link = isUrl(input.link) ? input.link : null;
  if (!posts.length && !link) throw new Error("Send at least one post as {network, url}, or a link.");

  const topics = (Array.isArray(input.topics) ? input.topics : [])
    .filter((topic): topic is string => typeof topic === "string" && topic.trim() !== "")
    .map((topic) => topic.trim().toLowerCase())
    .slice(0, MAX_TOPICS);
  const bountyUsd = Number(input.bountyUsd ?? 0);
  if (!Number.isFinite(bountyUsd) || bountyUsd < 0 || bountyUsd > 100) throw new Error("bountyUsd must be between 0 and 100.");
  const maxSharers = Math.min(100, Math.max(1, Math.floor(Number(input.maxSharers ?? 10)) || 10));

  const rows = await db()`
    insert into reshare_requests (user_id, title, text, topics, posts, link, bounty_usd, max_sharers)
    values (
      ${userId}, ${typeof input.title === "string" ? input.title.slice(0, 200) : null},
      ${typeof input.text === "string" ? input.text.slice(0, 2000) : null},
      ${topics}, ${db().json(posts as never)}, ${link}, ${bountyUsd}, ${maxSharers}
    )
    returning id
  `;
  const id = (rows[0] as { id: string }).id;

  // How many active sharers this would reach, so the author hears something
  // more useful than "queued". Not who: that is the sharers' business.
  const sharers = (await db()`
    select * from reshare_profiles where active = true and user_id <> ${userId}
  `) as unknown as ProfileRow[];
  const request = { topics, networks: posts.map((post) => post.network), link, bountyUsd };
  const matched = sharers.filter((row) => scoreMatch(request, sharerOf(row)) !== null).length;
  return { id, matched };
}

export async function listRequests(userId: string): Promise<unknown[]> {
  const rows = (await db()`
    select r.id, r.title, r.topics, r.posts, r.link, r.bounty_usd, r.max_sharers, r.status, r.created_at, r.expires_at,
      coalesce(
        (select json_agg(json_build_object(
          'id', c.id, 'sharer', coalesce(p.handle, p.name, 'someone'), 'network', c.network, 'status', c.status,
          'url', c.result_url, 'bountyUsd', c.bounty_usd, 'paidAt', c.paid_at
        ) order by c.created_at)
        from reshare_claims c left join reshare_profiles p on p.user_id = c.sharer_id
        where c.request_id = r.id),
        '[]'::json
      ) as claims
    from reshare_requests r
    where r.user_id = ${userId}
    order by r.created_at desc
    limit 100
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    topics: row.topics,
    posts: row.posts,
    link: row.link,
    bountyUsd: Number(row.bounty_usd),
    maxSharers: row.max_sharers,
    status: row.expires_at && new Date(row.expires_at as string) < new Date() && row.status === "open" ? "expired" : row.status,
    createdAt: new Date(row.created_at as string).toISOString(),
    claims: row.claims,
  }));
}

export async function closeRequest(userId: string, id: string): Promise<boolean> {
  const rows = await db()`
    update reshare_requests set status = 'closed' where id = ${id} and user_id = ${userId} and status = 'open' returning id
  `;
  return rows.length > 0;
}

/** Open requests this sharer fits, best first. Never the sharer's own, never one already claimed by them. */
export async function matchesFor(userId: string, limit: number): Promise<unknown[]> {
  const me = await profileRow(userId);
  if (!me?.active) return [];
  const sharer = sharerOf(me);

  const rows = (await db()`
    select r.id, r.title, r.text, r.topics, r.posts, r.link, r.bounty_usd, r.created_at,
      coalesce(p.handle, p.name, 'someone') as author,
      (select count(*) from reshare_claims c where c.request_id = r.id) as claimed
    from reshare_requests r
    left join reshare_profiles p on p.user_id = r.user_id
    where r.status = 'open'
      and r.expires_at > now()
      and r.user_id <> ${userId}
      and r.bounty_usd >= ${Number(me.rate_usd)}
      and not exists (select 1 from reshare_claims c where c.request_id = r.id and c.sharer_id = ${userId})
    order by r.created_at desc
    limit 200
  `) as unknown as Array<{
    id: string;
    title: string | null;
    text: string | null;
    topics: string[];
    posts: Array<{ network: string; url: string; id?: string }>;
    link: string | null;
    bounty_usd: string;
    created_at: Date;
    author: string;
    claimed: string;
    max_sharers?: number;
  }>;

  const out: Array<Record<string, unknown> & { score: number }> = [];
  for (const row of rows) {
    const result = scoreMatch(
      { topics: row.topics, networks: row.posts.map((post) => post.network), link: row.link, bountyUsd: Number(row.bounty_usd) },
      sharer,
    );
    if (!result) continue;
    out.push({
      id: row.id,
      author: row.author,
      title: row.title,
      text: row.text,
      topics: row.topics,
      posts: row.posts,
      link: row.link,
      bountyUsd: Number(row.bounty_usd),
      networks: result.networks,
      score: result.score,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit)));
}

/** Take a request for one network. Refused when it is full, closed, or the sharer's own. */
export async function claim(userId: string, requestId: string, network: string): Promise<{ id: string; requestId: string; network: string; status: string }> {
  const me = await profileRow(userId);
  if (!me?.active) throw new Error("Join the network first: myna reshare join");
  if (typeof network !== "string" || !network.trim()) throw new Error("Name the network.");
  const net = network.trim().toLowerCase();

  const requests = await db()`
    select id, user_id, bounty_usd, max_sharers,
      (select count(*) from reshare_claims c where c.request_id = r.id and c.status <> 'failed') as claimed
    from reshare_requests r
    where id = ${requestId} and status = 'open' and expires_at > now()
  `;
  const request = requests[0] as { id: string; user_id: string; bounty_usd: string; max_sharers: number; claimed: string } | undefined;
  if (!request) throw new Error("That request is closed or gone.");
  if (request.user_id === userId) throw new Error("That is your own request.");
  if (Number(request.claimed) >= request.max_sharers) throw new Error("That request has all the sharers it asked for.");

  // What this reshare will be worth: the sharer's rate, which the author's
  // offer already covers or the match would not have been shown.
  const rows = await db()`
    insert into reshare_claims (request_id, sharer_id, network, bounty_usd)
    values (${requestId}, ${userId}, ${net}, ${Math.min(Number(me.rate_usd), Number(request.bounty_usd))})
    on conflict (request_id, sharer_id, network) do nothing
    returning id, request_id, network, status
  `;
  const row = rows[0] as { id: string; request_id: string; network: string; status: string } | undefined;
  if (!row) throw new Error("You already claimed that request on that network.");
  return { id: row.id, requestId: row.request_id, network: row.network, status: row.status };
}

export async function report(userId: string, claimId: string, outcome: { ok?: boolean; url?: string; error?: string }): Promise<boolean> {
  const status = outcome.ok ? "done" : "failed";
  const rows = await db()`
    update reshare_claims set
      status = ${status},
      result_url = ${isUrl(outcome.url) ? outcome.url : null},
      error = ${typeof outcome.error === "string" ? outcome.error.slice(0, 500) : null},
      done_at = now()
    where id = ${claimId} and sharer_id = ${userId} and status = 'claimed'
    returning id
  `;
  return rows.length > 0;
}

interface LedgerRow {
  id: string;
  request_id: string;
  who: string;
  network: string;
  result_url: string | null;
  bounty_usd: string;
  pay: string | null;
  done_at: Date;
  paid_at: Date | null;
  pay_ref: string | null;
}

const ledgerRow = (row: LedgerRow) => ({
  id: row.id,
  requestId: row.request_id,
  who: row.who,
  network: row.network,
  url: row.result_url,
  bountyUsd: Number(row.bounty_usd),
  pay: row.pay,
  doneAt: new Date(row.done_at).toISOString(),
  paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  payRef: row.pay_ref,
});

/** What this person owes sharers (their requests, done, with a bounty) and what they have earned. */
export async function ledger(userId: string): Promise<{ owed: unknown[]; earned: unknown[] }> {
  const owed = (await db()`
    select c.id, c.request_id, coalesce(p.handle, p.name, 'someone') as who, c.network, c.result_url, c.bounty_usd, p.pay, c.done_at, c.paid_at, c.pay_ref
    from reshare_claims c
    join reshare_requests r on r.id = c.request_id
    left join reshare_profiles p on p.user_id = c.sharer_id
    where r.user_id = ${userId} and c.status = 'done' and c.bounty_usd > 0
    order by c.paid_at nulls first, c.done_at desc
    limit 200
  `) as unknown as LedgerRow[];
  const earned = (await db()`
    select c.id, c.request_id, coalesce(p.handle, p.name, 'someone') as who, c.network, c.result_url, c.bounty_usd, null as pay, c.done_at, c.paid_at, c.pay_ref
    from reshare_claims c
    join reshare_requests r on r.id = c.request_id
    left join reshare_profiles p on p.user_id = r.user_id
    where c.sharer_id = ${userId} and c.status = 'done'
    order by c.done_at desc
    limit 200
  `) as unknown as LedgerRow[];
  return { owed: owed.map(ledgerRow), earned: earned.map(ledgerRow) };
}

/** The author says a claim has been paid, with the reference they paid under. */
export async function markPaid(userId: string, claimId: string, ref: string): Promise<boolean> {
  const rows = await db()`
    update reshare_claims c set paid_at = now(), pay_ref = ${typeof ref === "string" ? ref.slice(0, 200) : null}
    from reshare_requests r
    where c.id = ${claimId} and r.id = c.request_id and r.user_id = ${userId} and c.status = 'done' and c.paid_at is null
    returning c.id
  `;
  return rows.length > 0;
}
