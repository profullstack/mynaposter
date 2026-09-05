/** Every network myna knows about. */
import type { Network } from "./types.ts";
import { bluesky } from "./adapters/bluesky.ts";
import { mastodon, pixelfed } from "./adapters/mastodon.ts";
import { misskey } from "./adapters/misskey.ts";
import { lemmy } from "./adapters/lemmy.ts";
import { nostr } from "./adapters/nostr.ts";
import { reddit } from "./adapters/reddit.ts";
import { telegram, discord, slack, matrix, mattermost } from "./adapters/chat.ts";
import { x } from "./adapters/x.ts";
import { facebook, instagram, threads } from "./adapters/meta.ts";
import { linkedin, pinterest, tiktok } from "./adapters/professional.ts";
import { youtube } from "./adapters/youtube.ts";
import { devto, hashnode, ghost, wordpress, microblog, tumblr } from "./adapters/blogs.ts";
import { tsbb } from "./adapters/tsbb.ts";

export const NETWORKS: Network[] = [
  // The ones people ask for first.
  x,
  facebook,
  instagram,
  threads,
  bluesky,
  reddit,
  linkedin,
  pinterest,
  tiktok,
  youtube,
  // Fediverse.
  mastodon,
  misskey,
  pixelfed,
  lemmy,
  nostr,
  tsbb,
  // Chat.
  telegram,
  discord,
  slack,
  matrix,
  mattermost,
  // Long-form.
  devto,
  hashnode,
  ghost,
  wordpress,
  microblog,
  tumblr,
];

const BY_ID = new Map(NETWORKS.map((network) => [network.id, network]));

/** Names people actually type. */
const ALIASES: Record<string, string> = {
  twitter: "x",
  tweet: "x",
  bsky: "bluesky",
  at: "bluesky",
  fb: "facebook",
  meta: "facebook",
  ig: "instagram",
  insta: "instagram",
  li: "linkedin",
  yt: "youtube",
  masto: "mastodon",
  fedi: "mastodon",
  pleroma: "mastodon",
  akkoma: "mastodon",
  gotosocial: "mastodon",
  sharkey: "misskey",
  firefish: "misskey",
  tg: "telegram",
  dev: "devto",
  "dev.to": "devto",
  wp: "wordpress",
  "micro.blog": "microblog",
  nostril: "nostr",
  forum: "tsbb",
  board: "tsbb",
};

export function getNetwork(id: string): Network | undefined {
  const key = id.trim().toLowerCase();
  return BY_ID.get(key) ?? BY_ID.get(ALIASES[key] ?? "");
}

export function requireNetwork(id: string): Network {
  const network = getNetwork(id);
  if (!network) {
    throw new Error(`Unknown network "${id}". Try one of: ${NETWORKS.map((entry) => entry.id).join(", ")}`);
  }
  return network;
}

export function networksByCategory(): Record<string, Network[]> {
  const grouped: Record<string, Network[]> = {};
  for (const network of NETWORKS) {
    (grouped[network.category] ??= []).push(network);
  }
  return grouped;
}

/** How a network's login will feel, for `/networks`. */
export function authSummary(network: Network): string {
  switch (network.auth.kind) {
    case "password":
      return "username + password";
    case "token":
      return "paste a token";
    case "oauth1":
      return "app keys";
    case "oauth2":
      return "browser sign-in";
    case "device":
      return "approve a code";
  }
}
