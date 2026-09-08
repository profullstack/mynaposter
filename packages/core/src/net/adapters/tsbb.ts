/**
 * tsbb — a TypeScript bulletin board, self-hosted.
 *
 * Works against any instance: the board describes itself at `GET /api/v1`, so
 * myna checks that first and fails with "that is not a tsbb board" rather than
 * with a 404 from some endpoint the operator never had.
 *
 * Login is a device flow, which suits a terminal better than either of the
 * alternatives: no password crosses this process, and no loopback port has to
 * be free. The board prints a short code, a person approves it in a browser,
 * and the board hands over a token once.
 *
 * A board is not one destination, it is a set of forums, and which one is
 * right depends on what is being posted. So login reads the board's forum list
 * and takes one or several, and posts then **cycle** through them: the next
 * announcement goes to the next forum in the list, rather than to every forum
 * at once, which is what a board reads as spam. `--forum <slug>` overrides for
 * a single post and leaves the rotation where it was.
 */
import type { Account, Network, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";
import { bodyUnderTitle, deriveTitle } from "../../util/text.ts";

interface Index {
  api?: string;
  version?: string;
  board?: { name: string; tagline?: string; url?: string };
  auth?: { scheme?: string; deviceFlow?: string };
}

interface DeviceStart {
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  /** Seconds the board wants between polls. */
  interval?: number;
  /** Absolute epoch milliseconds. This is what the board actually sends. */
  expiresAt?: number;
  /** Relative seconds, accepted in case a board sends this form instead. */
  expiresIn?: number;
}

interface Forum {
  slug: string;
  name?: string;
  description?: string;
  /** A container, not a destination. Nothing is posted into a category. */
  kind?: string;
  /**
   * Whether the caller may start a topic here, from tsbb 0.5.1 on. Older
   * boards omit it, and `undefined` has to mean "cannot tell" rather than
   * "no": treating a silent board as forbidding everything would refuse a
   * login that works.
   */
  canPost?: boolean;
  locked?: boolean;
}

interface DevicePoll {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
}

interface Topic {
  id: number;
  slug: string;
  title: string;
  replies: number;
  views: number;
  createdAt: number;
  lastPostAt: number;
  author: string;
  url: string;
}

const base = (account: Account): string => account.meta.instance;
const auth = (account: Account) => ({ authorization: `Bearer ${account.creds.token}` });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `app-showcase, announcements` and `app-showcase,announcements` are one thing. */
const splitForums = (raw: string | undefined): string[] =>
  String(raw ?? "")
    .split(",")
    .map((slug) => slug.trim().replace(/^\/?f\//, "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

/**
 * The forums a board publishes.
 *
 * Reading the list needs no token, but `canPost` is answered for whoever asks:
 * without a token that is a guest, who may post nowhere. Pass the token when
 * the answer is meant to be about the member.
 */
export async function listForums(instance: string, token?: string): Promise<Forum[]> {
  const result = await getJson<{ forums?: Forum[] } | Forum[]>(
    `${normalizeInstance(instance)}/api/v1/forums`,
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
  );
  const forums = Array.isArray(result) ? result : (result.forums ?? []);
  return forums.filter((forum) => typeof forum?.slug === "string");
}

/**
 * The forums an account posts to, in rotation order.
 *
 * Stored as one comma-separated `meta.forum` so an account connected before
 * there was a rotation still reads as a list of one.
 */
export function forumsOf(account: Account): string[] {
  return splitForums(account.meta.forum);
}

/**
 * A title and body for a post that arrived without one.
 *
 * Shared with every other network that needs a title, because the poster
 * derives one before an adapter is ever called: `postPaced` fills `input.title`
 * for any `needsTitle` network, so a private copy here would only ever run for
 * a direct `tsbb.post()` call. They are re-exported under these names because
 * that is what the tsbb tests and docs already call them.
 */
export { deriveTitle as forumTitle, bodyUnderTitle as forumBody };

/** Which forum is next, and where the cursor lands after it. */
export function nextForum(forums: string[], cursor: number): { forum: string; next: number } {
  if (!forums.length) return { forum: "", next: 0 };
  // A cursor can outlive the list it indexed, so a shortened list must not
  // start posting into undefined.
  const index = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) % forums.length : 0;
  return { forum: forums[index], next: (index + 1) % forums.length };
}

export const tsbb: Network = {
  id: "tsbb",
  name: "tsbb",
  category: "forum",
  blurb: "Self-hosted TypeScript bulletin board. Device-flow login, posts need a forum and a title.",
  auth: {
    kind: "device",
    note:
      "myna asks the board for a short code and opens the approval page. Sign in there as the member you want " +
      "to post as, approve the code, and the board hands back a token. Nothing is typed into myna.",
    docsUrl: "https://tsbb.dev",
    fields: [
      { key: "instance", label: "Board URL", placeholder: "tsbb.dev" },
      {
        key: "forum",
        label: "Forums to post to",
        optional: true,
        placeholder: "app-showcase,announcements",
        help: "Slugs from /f/<slug>, comma separated. Posts cycle through them, one forum per post.",
      },
      { key: "label", label: "Name this device", optional: true, default: "myna", help: "Shown in the board's session list." },
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    // A reply chain is what a forum thread already is.
    threads: true,
    // The API has no delete; removing a post is a browser-session thing.
    delete: false,
    timeline: true,
    notifications: true,
    stats: false,
    needsTitle: true,
  },

  async login(input, ctx) {
    const instance = normalizeInstance(input.instance);

    ctx.report(`Checking ${new URL(instance).host} is a tsbb board…`);
    const index = await getJson<Index>(`${instance}/api/v1`).catch(() => {
      throw new Error(`${new URL(instance).host} did not answer /api/v1. Is it a tsbb board?`);
    });
    if (index.api !== "tsbb") {
      throw new Error(`${new URL(instance).host} answered /api/v1 but is not a tsbb board.`);
    }

    // Which forums to publish in is settled before the device flow starts: a
    // typo'd slug should cost a retyped word, not an approval in a browser.
    // The forum list is public, so this needs no token.
    const available = await listForums(instance).catch(() => [] as Forum[]);
    let chosen = splitForums(input.forum);

    if (!chosen.length && available.length && ctx.ask) {
      ctx.report(`Forums on this board: ${available.map((forum) => forum.slug).join(", ")}`);
      chosen = splitForums(
        await ctx.ask("Which forums should posts go to? (comma separated, blank to decide per post)"),
      );
    }

    if (available.length) {
      const known = new Set(available.map((forum) => forum.slug));
      const unknown = chosen.filter((slug) => !known.has(slug));
      if (unknown.length) {
        throw new Error(
          `${new URL(instance).host} has no forum ${unknown.join(", ")}. It has: ${[...known].join(", ")}`,
        );
      }
      // A category holds forums rather than topics, and that is true of
      // everybody, so it can be refused before anyone approves anything.
      const categories = chosen.filter(
        (slug) => available.find((forum) => forum.slug === slug)?.kind === "category",
      );
      if (categories.length) {
        throw new Error(
          `${categories.join(", ")} ${categories.length === 1 ? "is a category" : "are categories"} on ` +
            `${new URL(instance).host}, not a forum. Topics go in the forums underneath.`,
        );
      }
    }
    if (chosen.length > 1) {
      ctx.report(`Posts will cycle through ${chosen.join(" → ")}, one forum per post.`);
    }

    const started = await postJson<DeviceStart>(`${instance}/api/v1/device/start`, {
      label: input.label?.trim() || "myna",
    });

    // verifyUrl already carries the code, so approving is usually one click.
    // The code is still printed for the case where the browser did not open.
    ctx.report(`Code: ${started.userCode}`);
    await ctx.openUrl(started.verifyUrl);
    ctx.report("Waiting for you to approve it…");

    // Poll no faster than the board asks. An expired code answers 410 rather
    // than pretending, which surfaces here as an HttpError we translate.
    const intervalMs = Math.max(1, started.interval ?? 2) * 1000;
    // The board sends an absolute expiresAt; expiresIn is accepted too because
    // the published schema documents neither and this is cheap insurance.
    const deadline = started.expiresAt
      ? started.expiresAt
      : Date.now() + (started.expiresIn ?? 600) * 1000;
    let token = "";

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      let poll: DevicePoll;
      try {
        poll = await postJson<DevicePoll>(`${instance}/api/v1/device/poll`, { deviceCode: started.deviceCode });
      } catch (error) {
        if (String((error as Error).message).includes("410")) {
          throw new Error("The code expired before it was approved. Run /login tsbb again.");
        }
        throw error;
      }
      if (poll.status === "approved" && poll.token) {
        token = poll.token;
        break;
      }
      if (poll.status === "denied") throw new Error("The board refused that code.");
      if (poll.status === "expired") throw new Error("The code expired before it was approved.");
    }

    if (!token) throw new Error("Timed out waiting for the code to be approved.");

    const me = await getJson<{ username?: string; name?: string }>(`${instance}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const username = me.username ?? me.name ?? "member";

    /*
     * Now that there is a token, ask again as the member.
     *
     * The list read before the device flow answered for a guest, and a guest
     * may post nowhere, so it could not be used to check this. From tsbb 0.5.1
     * a forum says whether the caller may start a topic in it; a feed-only or
     * locked forum is dropped here with a line saying so, rather than being
     * discovered by a 403 on the first announcement. An older board omits the
     * field, and "cannot tell" must not be read as "no".
     */
    if (chosen.length) {
      const asMember = await listForums(instance, token).catch(() => [] as Forum[]);
      const refused = chosen.filter(
        (slug) => asMember.find((forum) => forum.slug === slug)?.canPost === false,
      );
      if (refused.length) {
        const keep = chosen.filter((slug) => !refused.includes(slug));
        if (!keep.length) {
          throw new Error(
            `${username} cannot start topics in ${refused.join(", ")} on ${new URL(instance).host}: ` +
              "locked, reply-only, or above this member's rank. Pick a forum that takes topics.",
          );
        }
        ctx.report(
          `${refused.join(", ")} takes replies only, or is locked, so it is left out. Posting to ${keep.join(", ")}.`,
        );
        chosen = keep;
      }
    }

    return {
      handle: `${username}@${new URL(instance).host}`,
      displayName: index.board?.name ? `${username} on ${index.board.name}` : username,
      creds: { token },
      meta: {
        instance,
        forum: chosen.join(","),
        forumCursor: "0",
        board: index.board?.name ?? "",
      },
    };
  },

  async post(account, input) {
    const instance = base(account);

    // A reply goes to an existing topic; anything else starts one.
    if (input.replyTo) {
      const created = await postJson<{ id: number; url?: string }>(
        `${instance}/api/v1/topics/${input.replyTo}/posts`,
        { body: input.text, format: "markdown" },
        { headers: auth(account) },
      );
      return {
        // A reply's id is the post's, but the next part of a thread must reply
        // to the topic, so the topic id is what gets threaded on.
        id: String(input.replyTo),
        url: created.url ? `${instance}${created.url}` : undefined,
      };
    }

    // `--forum` is for this post only and leaves the rotation alone; otherwise
    // take the next forum in the account's list and move the cursor on, so a
    // run of announcements spreads across the forums instead of piling into one.
    const override = splitForums(input.extra?.forum)[0];
    const forums = forumsOf(account);
    if (!override && !forums.length) {
      throw new Error("tsbb needs a forum. Pass --forum <slug> or set some on the account with myna login.");
    }

    // `--to all` sends body text and no title, because every other network
    // takes one; the board is the only target that needs a headline.
    const title = input.title?.trim() || deriveTitle(input.text);
    const body = bodyUnderTitle(input.text, title);

    const create = (forum: string) =>
      postJson<{ id: number; slug?: string; url?: string; topic?: Topic }>(
        `${instance}/api/v1/forums/${encodeURIComponent(forum)}/topics`,
        { title, body, format: "markdown" },
        { headers: auth(account) },
      );

    if (override) {
      const created = await create(override);
      return locate(instance, created);
    }

    // Whether a member may start a topic in a given forum is not in the public
    // forum list, so a feed-only or locked forum can only announce itself with
    // a 403 on the first attempt. Rather than fail a release announcement over
    // it, take that as the board's answer: skip to the next forum in the
    // rotation, and stop keeping the refused one in the list.
    let cursor = Number(account.meta.forumCursor ?? 0);
    let remaining = [...forums];
    const refused: string[] = [];

    for (let attempt = 0; attempt < forums.length; attempt++) {
      const turn = nextForum(remaining, cursor);
      if (!turn.forum) break;
      try {
        const created = await create(turn.forum);
        await remember(account, remaining, remaining.length > 1 ? turn.next : 0);
        return locate(instance, created);
      } catch (error) {
        if (!isForbidden(error)) throw error;
        refused.push(turn.forum);
        remaining = remaining.filter((slug) => slug !== turn.forum);
        // The refused forum is gone from the list, so the cursor now points at
        // whatever moved into its place: do not advance it as well.
        cursor = remaining.length ? cursor % remaining.length : 0;
        await remember(account, remaining, cursor);
      }
    }

    throw new Error(
      `${new URL(instance).host} would not accept a new topic in ${refused.join(", ") || "any forum"}. ` +
        "That forum is locked, or reply-only, or this member cannot start topics there. " +
        "Pick different forums with: myna login tsbb " +
        `${instance} --forum <slugs>`,
    );
  },

  async timeline(account, limit) {
    const result = await getJson<{ topics: Topic[] }>(
      `${base(account)}/api/v1/latest?limit=${limit}`,
      { headers: auth(account) },
    );
    return (result.topics ?? []).map((topic): TimelineItem => ({
      id: String(topic.id),
      author: topic.author,
      handle: topic.author,
      text: topic.title,
      createdAt: new Date(topic.lastPostAt || topic.createdAt).toISOString(),
      url: `${base(account)}${topic.url}`,
      replies: topic.replies,
    }));
  },

  async notifications(account, limit) {
    const result = await getJson<{ notifications?: Record<string, any>[] }>(
      `${base(account)}/api/v1/notifications?limit=${limit}`,
      { headers: auth(account) },
    );
    return (result.notifications ?? []).slice(0, limit).map((item): TimelineItem => ({
      id: String(item.id ?? ""),
      author: item.actor ?? item.author ?? "",
      handle: item.actor ?? item.author ?? "",
      text: `${item.kind ?? item.type ?? "notification"}: ${item.title ?? item.excerpt ?? ""}`.trim(),
      createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : "",
      url: item.url ? `${base(account)}${item.url}` : undefined,
    }));
  },
};

/**
 * A 403 from the board, as opposed to any other reason a post failed.
 *
 * Only a refusal is worth skipping a forum over. A 500, a timeout or an expired
 * token must still fail loudly, or a broken board would quietly empty the
 * account's forum list one post at a time.
 */
export function isForbidden(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 403 || /\b403\b/.test(String((error as Error)?.message ?? ""));
}

function locate(instance: string, created: { id: number; url?: string; topic?: Topic }) {
  const id = created.topic?.id ?? created.id;
  const path = created.url ?? created.topic?.url;
  return { id: String(id), url: path ? `${instance}${path}` : undefined };
}

/** Persist the forum list and the rotation cursor together. */
async function remember(account: Account, forums: string[], cursor: number): Promise<void> {
  try {
    const { saveAccount } = await import("../../store/accounts.ts");
    saveAccount({
      ...account,
      meta: { ...account.meta, forum: forums.join(","), forumCursor: String(cursor) },
    });
  } catch {
    // Posting is what matters; the rotation catches up on the next login.
  }
}

/** Exported so `myna login tsbb` can check a URL before starting a device flow. */
export async function isTsbbBoard(url: string): Promise<boolean> {
  try {
    const index = await getJson<Index>(`${normalizeInstance(url)}/api/v1`);
    return index.api === "tsbb";
  } catch {
    return false;
  }
}

export { request as tsbbRequest };
