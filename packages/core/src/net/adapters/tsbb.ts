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

/** The forums a board publishes. Reading them needs no token. */
export async function listForums(instance: string): Promise<Forum[]> {
  const result = await getJson<{ forums?: Forum[] } | Forum[]>(`${normalizeInstance(instance)}/api/v1/forums`);
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
 * Move the rotation on, in the vault, the way the token refreshes do.
 *
 * A cursor that cannot be written is not worth failing a post that already
 * succeeded over: the worst case is the next announcement repeating this forum.
 */
async function rememberCursor(account: Account, next: number): Promise<void> {
  try {
    const { saveAccount } = await import("../../store/accounts.ts");
    saveAccount({ ...account, meta: { ...account.meta, forumCursor: String(next) } });
  } catch {
    // Posting is what matters; the rotation catches up on the next login.
  }
}

/** Longest title worth putting on a topic. Boards truncate past this anyway. */
const TITLE_CAP = 90;
/** Below this, a "sentence" is a fragment and the next one belongs in the title too. */
const TITLE_FLOOR = 24;

/**
 * A topic title for a post that was not given one.
 *
 * A forum needs a title where the other networks do not, so a fan-out to
 * `--to all` arrives here with nothing but body text. Taking the first line and
 * cutting it at N characters produced titles that stopped mid-word, mid-clause
 * and sometimes mid-URL, which is what a board's front page then shows forever.
 *
 * So: a markdown heading if the text has one, otherwise whole sentences up to
 * the cap, and a word boundary rather than a character count when even the
 * first sentence is too long.
 */
export function forumTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

  // A blog post's own H1 is a better title than anything derived from prose.
  const heading = /^#{1,6}\s+(.+)$/.exec(firstLine);
  if (heading) return trimTitle(heading[1]);

  // A trailing link is how a social post ends and never how a title should.
  const withoutUrl = firstLine.replace(/\s*https?:\/\/\S+\s*$/, "").trim() || firstLine;

  // Sentence ends are ". " and friends. A period inside 0.15.0 is followed by a
  // digit, not a space, so version numbers survive.
  const sentences = withoutUrl.split(/(?<=[.!?])\s+/);
  let title = "";
  for (const sentence of sentences) {
    const candidate = title ? `${title} ${sentence}` : sentence;
    if (title && candidate.length > TITLE_CAP) break;
    title = candidate;
    if (title.length >= TITLE_FLOOR) break;
  }

  return trimTitle(title || withoutUrl);
}

/** Cap on a word boundary, and do not leave dangling punctuation behind. */
function trimTitle(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (text.length <= TITLE_CAP) return text;
  const cut = text.slice(0, TITLE_CAP);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > TITLE_CAP / 2 ? cut.slice(0, boundary) : cut).replace(/[.,;:]+$/, "")}…`;
}

/**
 * The body to post under that title.
 *
 * When the title came from the text's own heading, repeating that heading as
 * the first line of the topic is just the title twice.
 */
export function forumBody(text: string, title: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return text;
  const heading = /^#{1,6}\s+(.+)$/.exec(lines[first].trim());
  if (!heading || trimTitle(heading[1]) !== title) return text;
  return lines.slice(first + 1).join("\n").replace(/^\s+/, "");
}

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
    const turn = nextForum(forums, Number(account.meta.forumCursor ?? 0));
    const forum = override || turn.forum;
    if (!forum) {
      throw new Error("tsbb needs a forum. Pass --forum <slug> or set some on the account with myna login.");
    }

    // `--to all` sends body text and no title, because every other network
    // takes one; the board is the only target that needs a headline.
    const title = input.title?.trim() || forumTitle(input.text);

    const created = await postJson<{ id: number; slug?: string; url?: string; topic?: Topic }>(
      `${instance}/api/v1/forums/${encodeURIComponent(forum)}/topics`,
      {
        title,
        body: forumBody(input.text, title),
        format: "markdown",
      },
      { headers: auth(account) },
    );

    // Only a post that actually landed advances the rotation, and only the
    // rotation's own turn does: an explicit --forum is a detour, not a step.
    if (!override && forums.length > 1) await rememberCursor(account, turn.next);

    const id = created.topic?.id ?? created.id;
    const path = created.url ?? created.topic?.url;
    return { id: String(id), url: path ? `${instance}${path}` : undefined };
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
