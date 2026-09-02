/**
 * Mastodon and everything that speaks its API: Pleroma, Akkoma, GoToSocial,
 * Iceshrimp, Pixelfed.
 *
 * Genuine username + password login. myna registers itself as an app on the
 * instance, then exchanges the password for a token through the OAuth password
 * grant. Instances with 2FA enabled reject that grant, so pasting an access
 * token stays available as the other path.
 */
import type { Account, Network, PostInput, PostResult, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";

const SCOPES = "read write follow";

const base = (account: Account): string => account.meta.instance;
const auth = (account: Account) => ({ authorization: `Bearer ${account.creds.token}` });

interface AppRegistration {
  client_id: string;
  client_secret: string;
}

interface TokenResponse {
  access_token: string;
}

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
}

interface Status {
  id: string;
  url: string;
  content: string;
  created_at: string;
  account: MastodonAccount;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
}

/** Strip the HTML the API returns so timelines read correctly in a terminal. */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

async function uploadMedia(account: Account, item: { data: Uint8Array; mime: string; path: string; alt?: string }): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? "upload");
  if (item.alt) form.append("description", item.alt);
  const response = await request(`${base(account)}/api/v2/media`, {
    method: "POST",
    headers: auth(account),
    body: form as never,
  });
  return ((await response.json()) as { id: string }).id;
}

function make(id: string, name: string, blurb: string, charLimit: number): Network {
  return {
    id,
    name,
    category: id === "mastodon" ? "fediverse" : "fediverse",
    blurb,
    auth: {
      kind: "password",
      note: "Username and password work on most instances. If the instance has 2FA, create a token at Preferences → Development → New application (scopes: read, write) and paste it instead.",
      fields: [
        { key: "instance", label: "Instance", placeholder: id === "pixelfed" ? "pixelfed.social" : "mastodon.social" },
        { key: "username", label: "Email or username", optional: true, help: "Leave blank if pasting a token." },
        { key: "password", label: "Password", secret: true, optional: true },
        { key: "token", label: "Access token", secret: true, optional: true, help: "Use instead of a password when 2FA is on." },
      ],
    },
    caps: {
      charLimit,
      mediaLimit: 4,
      threads: true,
      delete: true,
      timeline: true,
      notifications: true,
      stats: true,
    },

    async login(input, ctx) {
      const instance = normalizeInstance(input.instance);
      let token = input.token?.trim();

      if (!token) {
        if (!input.username || !input.password) {
          throw new Error("Enter a username and password, or paste an access token.");
        }
        ctx.report(`Registering myna on ${new URL(instance).host}…`);
        const app = await postJson<AppRegistration>(`${instance}/api/v1/apps`, {
          client_name: "myna",
          redirect_uris: "urn:ietf:wg:oauth:2.0:oob",
          scopes: SCOPES,
          website: "https://mynapost.com",
        });

        ctx.report("Exchanging your password for a token…");
        const granted = await postJson<TokenResponse>(`${instance}/oauth/token`, {
          grant_type: "password",
          client_id: app.client_id,
          client_secret: app.client_secret,
          username: input.username,
          password: input.password,
          scope: SCOPES,
        }).catch(() => {
          throw new Error(
            "The instance refused the password grant. That usually means 2FA is enabled — paste an access token instead.",
          );
        });
        token = granted.access_token;
      }

      const me = await getJson<MastodonAccount>(`${instance}/api/v1/accounts/verify_credentials`, {
        headers: { authorization: `Bearer ${token}` },
      });

      return {
        handle: `${me.acct}@${new URL(instance).host}`,
        displayName: me.display_name || me.username,
        creds: { token },
        meta: { instance, accountId: me.id },
      };
    },

    async post(account, input): Promise<PostResult> {
      const body: Record<string, unknown> = { status: input.text };
      if (input.replyTo) body.in_reply_to_id = input.replyTo;
      if (input.extra?.visibility) body.visibility = input.extra.visibility;
      if (input.extra?.spoiler) body.spoiler_text = input.extra.spoiler;
      if (input.media?.length) {
        body.media_ids = [];
        for (const item of input.media.slice(0, 4)) {
          (body.media_ids as string[]).push(await uploadMedia(account, item));
        }
      }
      const status = await postJson<Status>(`${base(account)}/api/v1/statuses`, body, {
        headers: { ...auth(account), "idempotency-key": `myna-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      });
      return { id: status.id, url: status.url };
    },

    async remove(account, statusId) {
      await request(`${base(account)}/api/v1/statuses/${statusId}`, { method: "DELETE", headers: auth(account) });
    },

    async timeline(account, limit) {
      const statuses = await getJson<Status[]>(`${base(account)}/api/v1/timelines/home?limit=${limit}`, { headers: auth(account) });
      return statuses.map((status): TimelineItem => ({
        id: status.id,
        author: status.account.display_name || status.account.username,
        handle: status.account.acct,
        text: plain(status.content),
        createdAt: status.created_at,
        url: status.url,
        likes: status.favourites_count,
        reposts: status.reblogs_count,
        replies: status.replies_count,
      }));
    },

    async notifications(account, limit) {
      const items = await getJson<{ id: string; type: string; created_at: string; account: MastodonAccount; status?: Status }[]>(
        `${base(account)}/api/v1/notifications?limit=${limit}`,
        { headers: auth(account) },
      );
      return items.map((item): TimelineItem => ({
        id: item.id,
        author: item.account.display_name || item.account.username,
        handle: item.account.acct,
        text: `${item.type}${item.status ? `: ${plain(item.status.content)}` : ""}`,
        createdAt: item.created_at,
        url: item.status?.url,
      }));
    },

    async stats(account, statusId) {
      const status = await getJson<Status>(`${base(account)}/api/v1/statuses/${statusId}`, { headers: auth(account) });
      return { likes: status.favourites_count, reposts: status.reblogs_count, replies: status.replies_count };
    },
  };
}

export const mastodon = make("mastodon", "Mastodon", "Fediverse microblogging. Also covers Pleroma, Akkoma and GoToSocial.", 500);
export const pixelfed = make("pixelfed", "Pixelfed", "Fediverse photo sharing. Mastodon-compatible API; posts need an image.", 2000);
