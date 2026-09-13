/**
 * Who a document is about, as keys two documents can be compared on.
 *
 * Rule 5 says an account's URL is the identity. So the identity keys of a
 * document are its normalised `Web`, every Accounts URL, and `Email` when it
 * is present; a name alone is never one. Two documents that share a key are
 * the same person until a human says otherwise; two that share only a name
 * are two people.
 */

import { accounts, identityValue, type OpenProfileDoc } from "./parse.ts";

const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$|source$)/i;

/**
 * A URL as an identity key: lowercase scheme and host, `www.` dropped, tracking
 * query keys dropped, the fragment dropped, the trailing slash dropped, the
 * scheme dropped from the key so http and https meet. Non-URLs (a bare
 * `bluesky:ada.example` account) come back lowercased and trimmed.
 */
export function normaliseUrl(input: string): string {
  const raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) {
    // A bare domain or a `network:handle` pair.
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return normaliseUrl(`https://${raw}`);
    // `network:@handle`, `@handle`: the marker is not part of the identity.
    return raw.toLowerCase().replace(/^@/, "").replace(/^([a-z0-9-]+):@/, "$1:");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (!TRACKING.test(k)) keep.append(k, v);
  keep.sort();
  const query = keep.toString();
  let path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  // Profile paths are case-sensitive on some networks and not on most; the
  // ones people type by hand (handles) are compared lowercased.
  path = path.toLowerCase();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/** An email as an identity key: lowercased, trimmed, `mailto:` dropped. */
export function normaliseEmail(input: string): string | null {
  const e = input
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** The keys a de-duplicator compares: `web:<key>`, `account:<key>`, `email:<key>`. */
export function identityKeys(doc: OpenProfileDoc): string[] {
  const out = new Set<string>();
  const web = identityValue(doc, "Web");
  if (web) for (const part of web.split(/[\s,]+/)) if (/^https?:\/\//i.test(part) || /\./.test(part)) out.add(`web:${normaliseUrl(part)}`);
  for (const a of accounts(doc)) out.add(`account:${normaliseUrl(a.url)}`);
  const email = identityValue(doc, "Email");
  if (email) {
    const e = normaliseEmail(email);
    if (e) out.add(`email:${e}`);
  }
  const did = identityValue(doc, "DID");
  if (did?.trim()) out.add(`did:${did.trim().toLowerCase()}`);
  return [...out];
}

/** True when the two documents share at least one identity key. Names never count. */
export function samePerson(a: OpenProfileDoc, b: OpenProfileDoc): boolean {
  const keys = new Set(identityKeys(a));
  // A web key and an account key for the same page are the same page.
  const strip = (k: string) => k.replace(/^(web|account):/, "page:");
  const pages = new Set([...keys].map(strip));
  for (const k of identityKeys(b)) {
    if (keys.has(k) || pages.has(strip(k))) return true;
  }
  return false;
}

/** The network behind an account URL, from the host, when the host is known. */
export function networkOf(url: string): string | null {
  const key = normaliseUrl(url);
  const host = key.split("/")[0] ?? "";
  const table: Record<string, string> = {
    "bsky.app": "bluesky",
    "twitter.com": "x",
    "x.com": "x",
    "github.com": "github",
    "gitlab.com": "gitlab",
    "linkedin.com": "linkedin",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "instagram.com": "instagram",
    "facebook.com": "facebook",
    "threads.net": "threads",
    "tiktok.com": "tiktok",
    "twitch.tv": "twitch",
    "reddit.com": "reddit",
    "medium.com": "medium",
    "substack.com": "substack",
    "patreon.com": "patreon",
    "ko-fi.com": "ko-fi",
    "buymeacoffee.com": "buymeacoffee",
    "linktr.ee": "linktree",
    "open.spotify.com": "spotify",
    "podcasts.apple.com": "apple-podcasts",
    "music.apple.com": "apple-music",
    "soundcloud.com": "soundcloud",
    "bandcamp.com": "bandcamp",
    "dev.to": "devto",
    "news.ycombinator.com": "hackernews",
    "keybase.io": "keybase",
    "t.me": "telegram",
    "telegram.me": "telegram",
    "discord.gg": "discord",
    "discord.com": "discord",
    "pixelfed.social": "pixelfed",
    "hachyderm.io": "mastodon",
    "mastodon.social": "mastodon",
    "mastodon.online": "mastodon",
    "fosstodon.org": "mastodon",
    "mstdn.social": "mastodon",
    "infosec.exchange": "mastodon",
    "techhub.social": "mastodon",
    "primal.net": "nostr",
    "njump.me": "nostr",
    "snort.social": "nostr",
  };
  if (table[host]) return table[host]!;
  if (host.endsWith(".substack.com")) return "substack";
  if (host.endsWith(".bandcamp.com")) return "bandcamp";
  if (host.endsWith(".medium.com")) return "medium";
  if (host.endsWith(".github.io")) return "github";
  if (host.endsWith(".bsky.social")) return "bluesky";
  if (/^@[^/]+$/.test(key.split("/")[1] ?? "") && /\./.test(host)) return "mastodon";
  if (!/^https?:/.test(url) && /^[a-z]+:/.test(key)) return key.split(":")[0]!;
  return null;
}
