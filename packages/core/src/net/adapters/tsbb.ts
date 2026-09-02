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
    fields: [
      { key: "instance", label: "Board URL", placeholder: "tsbb.dev" },
      { key: "forum", label: "Default forum", optional: true, placeholder: "general", help: "Slug from /f/<slug>." },
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
      meta: { instance, forum: input.forum?.trim() ?? "", board: index.board?.name ?? "" },
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

    const forum = input.extra?.forum || account.meta.forum;
    if (!forum) {
      throw new Error("tsbb needs a forum. Pass --forum <slug> or set a default on the account.");
    }

    const created = await postJson<{ id: number; slug?: string; url?: string; topic?: Topic }>(
      `${instance}/api/v1/forums/${encodeURIComponent(forum)}/topics`,
      {
        title: input.title || input.text.split("\n")[0].slice(0, 200),
        body: input.text,
        format: "markdown",
      },
      { headers: auth(account) },
    );

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
