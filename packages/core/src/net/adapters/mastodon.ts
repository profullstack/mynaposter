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
import { authorize, callbackFrom, PASTE_FIELD, REDIRECT_URI } from "../oauth2.ts";

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
      kind: "oauth2",
      note:
        "The instance is all myna needs: it registers itself there and opens your browser to an Authorize " +
        "button. Paste a token only if you would rather not use a browser (Preferences, Development, New application).",
      fields: [
        { key: "instance", label: "Instance", placeholder: id === "pixelfed" ? "pixelfed.social" : "mastodon.social" },
        { key: "token", label: "Access token", secret: true, optional: true, help: "Optional. Leave blank to use the browser." },
        PASTE_FIELD,
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
      repost: true,
    },

    async login(input, ctx) {
      const instance = normalizeInstance(input.instance);
      const host = new URL(instance).host;
      let token = input.token?.trim();

      if (!token) {
        // Any client may register itself on a Mastodon server, so myna runs the
        // normal browser flow with no setup at all: no developer portal, no
        // client id to copy, nothing typed but the instance.
        //
        // There is deliberately no password path. Mastodon removed
        // grant_type=password; a 4.7 server answers `unsupported_grant_type`,
        // and offering the field only produces a confusing failure.
        ctx.report(`Registering myna on ${host}...`);
        const app = await postJson<AppRegistration>(`${instance}/api/v1/apps`, {
          client_name: "myna",
          redirect_uris: REDIRECT_URI,
          scopes: SCOPES,
          website: "https://mynaposter.com",
        });

        const granted = await authorize(
          {
            authorizeUrl: `${instance}/oauth/authorize`,
            tokenUrl: `${instance}/oauth/token`,
            clientId: app.client_id,
            clientSecret: app.client_secret,
            scopes: SCOPES.split(" "),
            // Not every server still in the wild implements PKCE, and the
            // client secret is already in hand from registering just now.
            pkce: false,
            ...callbackFrom(input, ctx),
          },
          ctx,
        );
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

    async repost(account, ref) {
      const target = mastodonStatusRef(ref, base(account));
      let id: string;
      if ("id" in target) {
        id = target.id;
      } else {
        // A post on another instance has no id here until this instance has
        // fetched it. The search endpoint with resolve does exactly that.
        const found = await getJson<{ statuses: Status[] }>(
          `${base(account)}/api/v2/search?type=statuses&resolve=true&limit=1&q=${encodeURIComponent(target.url)}`,
          { headers: auth(account) },
        );
        const status = found.statuses[0];
        if (!status) throw new Error(`${name} could not find that post: ${ref}`);
        id = status.id;
      }
      const boost = await postJson<Status & { reblog?: Status }>(`${base(account)}/api/v1/statuses/${id}/reblog`, {}, { headers: auth(account) });
      return { id: boost.id, url: boost.reblog?.url ?? boost.url };
    },
  };
}

/**
 * What to boost, from a bare status id or a URL. A URL on the account's own
 * instance ending in a numeric id can be used directly; anything else is a
 * remote post that the instance has to resolve first.
 */
export function mastodonStatusRef(ref: string, instance: string): { id: string } | { url: string } {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return { id: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a Fediverse post: ${ref}`);
  }
  const local = new URL(instance).host === url.host;
  const tail = /\/(\d+)\/?$/.exec(url.pathname);
  if (local && tail) return { id: tail[1] };
  return { url: url.toString() };
}

export const mastodon = make("mastodon", "Mastodon", "Fediverse microblogging. Also covers Pleroma, Akkoma and GoToSocial.", 500);
export const pixelfed = make("pixelfed", "Pixelfed", "Fediverse photo sharing. Mastodon-compatible API; posts need an image.", 2000);
