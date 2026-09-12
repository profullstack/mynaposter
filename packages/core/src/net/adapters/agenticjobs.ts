/**
 * agenticjobs — a self-hosted job board, and the updates on it.
 *
 * Two different things live on that board and only one of them belongs here.
 * A **job opening** is a publication: it stays an explicit target reached with
 * `myna jobs post`, because a status update fanning out into a job opening at
 * your company is not something you can delete your way out of. An **update**
 * is a status post — a role filled, something shipped, who is free in March —
 * and that is what this adapter posts. It goes out with the rest of a fan-out.
 *
 * Login is the board's device flow, which suits a terminal better than either
 * alternative: no password crosses this process and no loopback port has to be
 * free. The board prints a short code, a person approves it in a browser, and
 * the board hands over a token once.
 *
 * You post as yourself or as an employer you belong to. Which one is decided
 * at login, from the employers the board says the account can post for, and
 * `--org <slug>` overrides for a single post. Posting as yourself needs a
 * published resume on the board, so the update has a page behind it.
 */
import type { Account, FollowResult, Network, Profile, TimelineItem } from "../types.ts";
import { getJson, HttpError, normalizeInstance, postJson, request } from "../../util/http.ts";
import { McpClient, McpToolError } from "../../directories/mcp.ts";
import { VERSION } from "../../version.ts";

/** The board's own description of itself, at a well-known path. */
interface Descriptor {
  software?: { name?: string; version?: string };
  name?: string;
  url?: string;
}

interface DeviceStart {
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  /** Seconds the board wants between polls. */
  interval?: number;
  /** Absolute epoch milliseconds. */
  expiresAt?: number;
}

interface DevicePoll {
  status: "pending" | "expired" | "approved";
  token?: string;
}

interface Me {
  user?: { email?: string; name?: string | null };
  orgs?: { slug: string; name: string }[];
  resumes?: { slug: string; visibility: string }[];
}

interface UpdateRow {
  id: string;
  body: string;
  link: string | null;
  createdAt: string;
  author: { kind: string; name: string; slug: string | null };
  authorUrl?: string | null;
}

/** The most an update can say. The board enforces this too. */
export const UPDATE_LIMIT = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function base(account: Account): string {
  return account.meta.instance ?? "https://agenticjobs.work";
}

function auth(account: Account): Record<string, string> {
  return { authorization: `Bearer ${account.creds.token}` };
}

/**
 * Split a trailing URL out of the post into the board's own link field.
 *
 * Every other network takes one blob of text with the link inside it, and the
 * poster hands each adapter that same blob. This board has a column for the
 * link and renders it under the body, so leaving the URL in the text as well
 * would print it twice.
 *
 * Only a URL at the very end is taken, which is where a myna post puts one. A
 * link in the middle of a sentence is part of the sentence, and cutting it out
 * would leave a hole.
 */
export function splitLink(text: string, given?: string): { body: string; link?: string } {
  const trimmed = text.trim();
  if (given && given.trim()) return { body: trimmed, link: given.trim() };

  const match = /\s(https?:\/\/\S+)$/.exec(trimmed);
  if (!match) return { body: trimmed };

  const body = trimmed.slice(0, match.index).trim();
  // A post that is only a link keeps it in the body: the board wants at least
  // a dozen characters of text, and a bare URL is not an update.
  if (body.length < 12) return { body: trimmed };
  return { body, link: match[1] };
}

/**
 * Who to follow, from what a person would type.
 *
 * An employer is the default because that is what most people mean. A person
 * is named `candidate:ada` or by pasting the URL of either page, which is what
 * you have to hand when you are looking at one.
 */
export function followTarget(handle: string): { kind: "orgs" | "candidates"; slug: string } {
  const raw = handle.trim().replace(/^@/, "");

  const url = /^https?:\/\//.test(raw) ? safeUrl(raw) : null;
  if (url) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "candidates" && parts[1]) return { kind: "candidates", slug: parts[1] };
    if (parts[0] === "employers" && parts[1]) return { kind: "orgs", slug: parts[1] };
  }

  const prefixed = /^(candidate|person|people|candidates):(.+)$/i.exec(raw);
  if (prefixed) return { kind: "candidates", slug: prefixed[2].trim() };

  const employer = /^(employer|org|company|employers|orgs):(.+)$/i.exec(raw);
  if (employer) return { kind: "orgs", slug: employer[2].trim() };

  return { kind: "orgs", slug: raw };
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Which door an account's updates go through. `mcp` unless the account or the environment says otherwise. */
export function transportOf(account: Account): "mcp" | "rest" {
  const chosen = (process.env.MYNA_AGENTICJOBS_TRANSPORT ?? account.meta.transport ?? "mcp").trim().toLowerCase();
  return chosen === "rest" ? "rest" : "mcp";
}

interface PostedUpdate {
  update: UpdateRow;
  author: string;
}

/** True when the board has no MCP endpoint at all, as opposed to having refused the update. */
function noMcpHere(error: unknown): boolean {
  if (error instanceof McpToolError) return false;
  if (error instanceof HttpError) return error.status === 404 || error.status === 405 || error.status === 501;
  return /no JSON-RPC response|Method not found|Not found/i.test(String((error as Error)?.message ?? ""));
}

async function postUpdate(account: Account, instance: string, payload: Record<string, string>): Promise<PostedUpdate> {
  if (transportOf(account) === "mcp") {
    const client = new McpClient({ url: `${instance}/api/mcp`, token: account.creds.token, clientName: "myna", clientVersion: VERSION });
    try {
      const result = await client.call<PostedUpdate | string>("post_update", payload);
      if (result && typeof result === "object" && result.update?.id) return result;
      // A board that answered in prose alone still posted; read the update back is
      // more than this needs, so the id is the prose and the url is the author's page.
      throw new Error(`post_update answered without an update: ${typeof result === "string" ? result : JSON.stringify(result)}`);
    } catch (error) {
      if (!noMcpHere(error)) throw error;
    }
  }
  return postJson<PostedUpdate>(`${instance}/api/v1/updates`, payload, { headers: auth(account) });
}

export const agenticjobs: Network = {
  id: "agenticjobs",
  name: "Agentic Jobs",
  category: "minor",
  blurb:
    "A self-hosted job board, and the updates on it. Device-flow login, 600 characters and one link, five a day, posted over the board's MCP.",
  auth: {
    kind: "device",
    note:
      "myna asks the board for a short code and opens the approval page. Sign in there as the account you want " +
      "to post as, approve the code, and the board hands back a token. Nothing is typed into myna.",
    docsUrl: "https://agenticjobs.work/docs",
    fields: [
      { key: "instance", label: "Board URL", default: "agenticjobs.work", placeholder: "agenticjobs.work" },
      {
        key: "org",
        label: "Post as this employer",
        optional: true,
        placeholder: "acme",
        help: "An employer slug you post for. Leave blank to post as yourself, which needs a published resume.",
      },
      { key: "label", label: "Name this device", optional: true, default: "myna", help: "Shown in the board's session list." },
    ],
  },
  caps: {
    charLimit: UPDATE_LIMIT,
    // The board takes text and one link. A resume or a job description is a
    // document with its own endpoint, not an attachment on a status post.
    mediaLimit: 0,
    threads: false,
    delete: true,
    timeline: true,
    notifications: false,
    stats: false,
    follow: true,
    // Deliberately NOT an explicit target. This posts updates, and an update
    // is a status post: it belongs in `--to all` with the rest of them. The
    // job opening, which must never be fanned out into, is a different command.
    explicitTarget: false,
  },

  async login(input, ctx) {
    const instance = normalizeInstance(input.instance || "agenticjobs.work");
    const host = new URL(instance).host;

    ctx.report(`Checking ${host} is an agenticjobs board…`);
    const descriptor = await getJson<Descriptor>(`${instance}/.well-known/agenticjobs`).catch(() => {
      throw new Error(`${host} did not answer /.well-known/agenticjobs. Is it an agenticjobs board?`);
    });
    if (descriptor.software?.name && descriptor.software.name !== "agenticjobs") {
      throw new Error(`${host} answered, but says it runs ${descriptor.software.name}.`);
    }

    const started = await postJson<DeviceStart>(`${instance}/api/v1/auth/device`, {
      label: input.label?.trim() || "myna",
    });

    // verifyUrl carries the code, so approving is one click. The code is
    // still printed, for the case where the browser did not open or is on
    // another machine.
    ctx.report(`Code: ${started.userCode}`);
    await ctx.openUrl(started.verifyUrl);
    ctx.report("Waiting for you to approve it…");

    const intervalMs = Math.max(1, started.interval ?? 2) * 1000;
    const deadline = started.expiresAt ?? Date.now() + 600 * 1000;
    let token = "";

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const poll = await postJson<DevicePoll>(`${instance}/api/v1/auth/device/poll`, {
        deviceCode: started.deviceCode,
      });
      if (poll.status === "approved" && poll.token) {
        token = poll.token;
        break;
      }
      if (poll.status === "expired") {
        throw new Error("The code expired before it was approved. Run the login again.");
      }
    }
    if (!token) throw new Error("Timed out waiting for the code to be approved.");

    const me = await getJson<Me>(`${instance}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const orgs = me.orgs ?? [];

    // Who the updates come from is settled here rather than at post time,
    // where getting it wrong means an update on the wrong page.
    let org = (input.org ?? "").trim();
    if (!org && orgs.length && ctx.ask) {
      ctx.report(`Employers you post for: ${orgs.map((entry) => entry.slug).join(", ")}`);
      org = (
        await ctx.ask("Post updates as which employer? (blank to post as yourself)")
      ).trim();
    }
    if (org && !orgs.some((entry) => entry.slug === org)) {
      throw new Error(
        orgs.length
          ? `This account does not post for "${org}". It posts for: ${orgs.map((entry) => entry.slug).join(", ")}`
          : `This account posts for no employers on ${host}, so it cannot post as "${org}".`,
      );
    }

    // Posting as yourself needs a page for the update to sit on, and the
    // board refuses without one. Better to say so now than at the first post
    // of a release announcement.
    if (!org && !(me.resumes ?? []).some((resume) => resume.visibility === "public")) {
      throw new Error(
        `This account has no published resume on ${host}, so it cannot post updates as itself. ` +
          `Publish one, or log in again naming an employer you post for.`,
      );
    }

    const who = me.user?.name?.trim() || me.user?.email || "account";
    return {
      handle: org ? `${org}@${host}` : `${who}@${host}`,
      displayName: org ? (orgs.find((entry) => entry.slug === org)?.name ?? org) : who,
      creds: { token },
      meta: { instance, org, board: descriptor.name ?? "" },
    };
  },

  async post(account, input) {
    const instance = base(account);
    const org = (input.extra?.org ?? account.meta.org ?? "").trim();
    const { body, link } = splitLink(input.text, input.extra?.link);
    const payload = { body, ...(link ? { link } : {}), ...(org ? { org } : {}) };

    // The board speaks MCP at /api/mcp with the same bearer token, and its
    // post_update tool is the update form: body, one link, an employer. That
    // is the door an agent uses, so it is the door myna uses too, and a board
    // too old to have it (or one with MCP switched off) is answered over REST
    // instead. A refusal from the tool itself (five a day, the same text
    // twice, no published resume) is the board's answer and is not retried.
    const created = await postUpdate(account, instance, payload);
    return {
      id: created.update.id,
      // An update has no page of its own; it lives on its author's, and the
      // board's own feed anchors on the id.
      url: created.author ? `${created.author}#${created.update.id}` : undefined,
    };
  },

  async remove(account, id) {
    await request(`${base(account)}/api/v1/updates/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: auth(account),
    });
  },

  /**
   * What the account follows.
   *
   * A job board has no home timeline in the usual sense; this is the board's
   * own answer to the same question, which is the updates from the employers
   * and people this account chose to follow.
   */
  async timeline(account, limit) {
    const result = await getJson<{ items?: UpdateRow[] }>(
      `${base(account)}/api/v1/updates?following=true`,
      { headers: auth(account) },
    );
    return (result.items ?? []).slice(0, limit).map((update): TimelineItem => ({
      id: update.id,
      author: update.author.name,
      handle: update.author.slug ?? update.author.name,
      text: update.link ? `${update.body} ${update.link}` : update.body,
      createdAt: new Date(update.createdAt).toISOString(),
      url: update.authorUrl ? `${update.authorUrl}#${update.id}` : undefined,
    }));
  },

  /**
   * Who this account follows.
   *
   * Only this account. Every other adapter reads a public list, and this one
   * deliberately cannot: who a candidate follows says which employers they are
   * looking at, and a board that published that would be publishing the fact
   * that somebody is job hunting. So a seed pointed at somebody else is
   * refused with a sentence rather than answered with a guess.
   */
  async following(account, handle, limit): Promise<Profile[]> {
    const mine = account.handle.split("@")[0];
    const asked = handle.trim().replace(/^@/, "").split("@")[0];
    if (asked && asked !== mine && asked !== account.meta.org) {
      throw new Error(
        `${new URL(base(account)).host} does not publish who somebody else follows. ` +
          "On this board that would publish the fact that they are looking.",
      );
    }

    const result = await getJson<{
      items?: { kind: string; slug: string | null; name: string }[];
    }>(`${base(account)}/api/v1/me/following`, { headers: auth(account) });

    return (result.items ?? []).slice(0, limit).map((entry): Profile => ({
      handle: entry.kind === "employer" ? (entry.slug ?? entry.name) : `candidate:${entry.slug ?? ""}`,
      displayName: entry.name,
      url: entry.slug
        ? `${base(account)}/${entry.kind === "employer" ? "employers" : "candidates"}/${entry.slug}`
        : undefined,
    }));
  },

  async follow(account, handle): Promise<FollowResult> {
    const target = followTarget(handle);
    if (!target.slug) throw new Error("Name an employer, or a candidate as candidate:<slug>.");

    const before = await getJson<{ items?: { slug: string | null }[] }>(
      `${base(account)}/api/v1/me/following`,
      { headers: auth(account) },
    ).catch(() => ({ items: [] as { slug: string | null }[] }));
    const already = (before.items ?? []).some((entry) => entry.slug === target.slug);

    await postJson<{ following: boolean; followers: number }>(
      `${base(account)}/api/v1/${target.kind}/${encodeURIComponent(target.slug)}/follow`,
      {},
      { headers: auth(account) },
    );

    return {
      already,
      url: `${base(account)}/${target.kind === "orgs" ? "employers" : "candidates"}/${target.slug}`,
    };
  },
};
