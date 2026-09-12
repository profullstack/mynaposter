/**
 * OpenProfile.md: one Markdown file for who you are and where you are.
 *
 * The convention is docs/openprofile.md (published at logicsrc.com/openprofile).
 * myna both writes one, from the accounts it is logged into and a few
 * settings, and reads them, because the reshare network matches people by
 * the Topics and Reshare sections of their profiles.
 *
 * Every rule degrades. A file that is only a name still parses, an unknown
 * key is kept, an unknown section is kept, and nothing here throws on input.
 * The Markdown is the canonical copy: the structured object below is derived
 * on every read and never stored beside it.
 */
import type { Account } from "../net/types.ts";

export interface ProfilePair {
  key: string;
  value: string;
}

export interface ProfileAccount {
  /** What to call it: the link label, or the network name. */
  label: string;
  url: string;
  /** myna's network id when the host is known, else the lowercased label. */
  network: string;
}

export interface ReshareTerms {
  /** Network ids that will reshare. Empty means every account on a network that can. */
  networks: string[];
  /** What will be reshared. Empty means the profile's Topics. */
  topics: string[];
  /** Topics refused. A hit here wins over a hit in topics. */
  not: string[];
  /** USD per reshare; 0 is free. */
  rateUsd: number;
  /** The rate is per network rather than per request. */
  perNetwork: boolean;
  /** Reshares per day, or null for the reader's default. */
  limitPerDay: number | null;
}

export interface ProfileOperator {
  name?: string;
  profile?: string;
  email?: string;
  did?: string;
}

export interface ProfileSection {
  title: string;
  kind: string;
  markdown: string;
}

export interface OpenProfile {
  name: string | null;
  kind: "person" | "agent" | "organization" | null;
  handle: string | null;
  web: string | null;
  pay: string | null;
  /** A decentralized identifier: did:key, did:web, did:plc, as written. */
  did: string | null;
  /** The identity block, every pair, as written. */
  identity: ProfilePair[];
  headline: string | null;
  accounts: ProfileAccount[];
  topics: string[];
  reshare: ReshareTerms | null;
  operator: ProfileOperator | null;
  sections: ProfileSection[];
  /** The document as supplied. Always the source of truth. */
  markdown: string;
}

/** Section names the reader understands, from the words people write. */
const SECTION_KINDS: Array<[RegExp, string]> = [
  [/^(accounts?|profiles?|elsewhere|find me|social|socials|networks?|links?)$/i, "accounts"],
  [/^(topics?|tags?|keywords?|interests?|writes? about|about topics)$/i, "topics"],
  [/^(reshare|resharing|amplify|boost|boosts|reposts?)$/i, "reshare"],
  [/^(operator|operated by|run by|owner)$/i, "operator"],
  [/^(about|bio|summary)$/i, "about"],
  [/^(projects?|work)$/i, "projects"],
  [/^(services?|offers?)$/i, "services"],
  [/^(contact|reach me)$/i, "contact"],
];

/** Hosts a reader knows, mapped to myna network ids. */
const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)bsky\.app$/i, "bluesky"],
  [/^(www\.)?(x|twitter)\.com$/i, "x"],
  [/^(www\.)?threads\.(net|com)$/i, "threads"],
  [/^(www\.)?instagram\.com$/i, "instagram"],
  [/^(www\.)?facebook\.com$/i, "facebook"],
  [/^(www\.)?linkedin\.com$/i, "linkedin"],
  [/^(www\.|old\.)?reddit\.com$/i, "reddit"],
  [/^(www\.)?pinterest\.com$/i, "pinterest"],
  [/^(www\.)?tiktok\.com$/i, "tiktok"],
  [/^(www\.|m\.)?youtube\.com$|^youtu\.be$/i, "youtube"],
  [/^(www\.)?dev\.to$/i, "devto"],
  [/(^|\.)hashnode\.(com|dev)$/i, "hashnode"],
  [/(^|\.)tumblr\.com$/i, "tumblr"],
  [/^(www\.)?github\.com$/i, "github"],
  [/^njump\.me$|^primal\.net$|^snort\.social$|^iris\.to$/i, "nostr"],
  [/(^|\.)mastodon\.[a-z]+$|^mastodon\./i, "mastodon"],
  [/^(www\.)?micro\.blog$/i, "microblog"],
  [/^t\.me$|^telegram\.me$/i, "telegram"],
];

const strip = (value: string): string =>
  value
    .trim()
    .replace(/^(`+)([\s\S]*?)\1$/, "$2")
    .replace(/^(\*{1,3}|_{1,3})(?=\S)([\s\S]*\S)\1$/, "$2")
    .trim();

/** One bullet as `key: value`, `**key**: value`, or `[label](url)`. */
function parsePair(raw: string): ProfilePair | null {
  const text = raw.trim();
  if (!text) return null;
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(text);
  if (link) return { key: (link[1] ?? "").trim(), value: (link[2] ?? "").trim() };
  const pair = /^\*{0,2}([^:*]{1,40})\*{0,2}\s*:\s*(.+)$/.exec(text);
  if (!pair) return { key: "note", value: strip(text) };
  const value = (pair[2] ?? "").trim();
  const inner = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(value);
  return { key: (pair[1] ?? "").trim(), value: inner ? (inner[2] ?? "").trim() : strip(value) };
}

/**
 * A topic as the reader compares it: lowercased, no `#`, one space between
 * words whether the author wrote a hyphen, an underscore or a space, and no
 * trailing plural. `Machine-Learning`, `machine learning` and `#MachineLearnings`
 * are one topic.
 */
export function topicKey(topic: string): string {
  let key = topic.trim().toLowerCase().replace(/^#+/, "").replace(/[\s_-]+/g, " ").trim();
  if (key.length > 3 && key.endsWith("s") && !key.endsWith("ss")) key = key.slice(0, -1);
  return key;
}

/** Loose: equal keys, or one is a prefix of the other once it is four letters long. */
export function topicsMatch(a: string, b: string): boolean {
  const x = topicKey(a);
  const y = topicKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // `devtools` and `dev-tools` are one word to the people who write them.
  const cx = x.replace(/ /g, "");
  const cy = y.replace(/ /g, "");
  if (cx === cy) return true;
  const [short, long] = cx.length <= cy.length ? [cx, cy] : [cy, cx];
  return short.length >= 4 && long.startsWith(short);
}

/** Topics from a section or a line: comma lists, one per bullet, `#tags`. */
export function parseTopics(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split("\n")) {
    const bare = line.replace(/^\s*[-*]\s+/, "").trim();
    if (!bare || bare.startsWith("#") && /^#{1,6}\s/.test(bare)) continue;
    for (const part of bare.split(",")) {
      const topic = strip(part).replace(/^#/, "").trim();
      if (!topic) continue;
      const key = topicKey(topic);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(topic);
    }
  }
  return out;
}

/** myna's network id for a page, from its host; the label when the host is unknown. */
export function networkFromUrl(url: string, label = ""): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return label.trim().toLowerCase() || "web";
  }
  for (const [pattern, id] of HOSTS) if (pattern.test(host)) return id;
  const fallback = label.trim().toLowerCase();
  if (fallback && /^[a-z0-9.-]+$/.test(fallback)) return fallback;
  return host;
}

/** `$0.05/reshare`, `5 cents`, `free`, `$0.10 per reshare per network`. */
export function parseRate(value: string): { usd: number; perNetwork: boolean } {
  const text = value.trim().toLowerCase();
  if (!text || /^(free|none|0|\$0)$/.test(text)) return { usd: 0, perNetwork: false };
  const perNetwork = /network/.test(text);
  const cents = /(\d+(?:\.\d+)?)\s*(¢|cents?)/.exec(text);
  if (cents) return { usd: Number(cents[1]) / 100, perNetwork };
  const dollars = /\$?\s*(\d+(?:\.\d+)?)/.exec(text);
  return { usd: dollars ? Number(dollars[1]) : 0, perNetwork };
}

/** `3/day`, `20 per week` (as a daily figure), `10`. Null when unreadable. */
export function parseLimit(value: string): number | null {
  const match = /(\d+)\s*(?:\/|per|a|an)?\s*(day|week|hour|month)?/i.exec(value.trim());
  if (!match) return null;
  const count = Number(match[1]);
  const unit = (match[2] ?? "day").toLowerCase();
  if (unit === "week") return Math.max(1, Math.round(count / 7));
  if (unit === "month") return Math.max(1, Math.round(count / 30));
  if (unit === "hour") return count * 24;
  return count;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => strip(part).replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);
}

function parseReshare(markdown: string): ReshareTerms {
  const terms: ReshareTerms = { networks: [], topics: [], not: [], rateUsd: 0, perNetwork: false, limitPerDay: null };
  for (const line of markdown.split("\n")) {
    const pair = parsePair(line.replace(/^\s*[-*]\s+/, ""));
    if (!pair) continue;
    const key = pair.key.toLowerCase();
    if (/^networks?$/.test(key)) terms.networks = splitList(pair.value);
    else if (/^topics?$/.test(key)) terms.topics = parseTopics(pair.value);
    else if (/^(not|never|refuse|refused|except|no)$/.test(key)) terms.not = parseTopics(pair.value);
    else if (/^(rate|price|cost|fee)$/.test(key)) {
      const rate = parseRate(pair.value);
      terms.rateUsd = rate.usd;
      terms.perNetwork = rate.perNetwork;
    } else if (/^(limit|max|cap|per day)$/.test(key)) terms.limitPerDay = parseLimit(pair.value);
  }
  return terms;
}

function parseOperator(markdown: string): ProfileOperator | null {
  const operator: ProfileOperator = {};
  for (const line of markdown.split("\n")) {
    const pair = parsePair(line.replace(/^\s*[-*]\s+/, ""));
    if (!pair) continue;
    const key = pair.key.toLowerCase();
    if (key === "name") operator.name = pair.value;
    else if (/^(profile|openprofile|url)$/.test(key)) operator.profile = pair.value;
    else if (/^(email|e-mail|mail)$/.test(key)) operator.email = pair.value;
    else if (key === "did" && /^did:[a-z0-9]+:/.test(pair.value)) operator.did = pair.value;
    else if (pair.key !== "note" && /^https?:\/\//.test(pair.value) && !operator.profile) {
      operator.name = operator.name ?? pair.key;
      operator.profile = pair.value;
    }
  }
  return operator.name || operator.profile || operator.email || operator.did ? operator : null;
}

function parseAccounts(markdown: string): ProfileAccount[] {
  const out: ProfileAccount[] = [];
  const seen = new Set<string>();
  const add = (label: string, url: string): void => {
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, url, network: networkFromUrl(url, label) });
  };
  for (const line of markdown.split("\n")) {
    const bullet = line.replace(/^\s*[-*]\s+/, "").trim();
    if (!bullet) continue;
    const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i.exec(bullet);
    if (md) {
      add((md[1] ?? "").trim(), md[2] ?? "");
      continue;
    }
    const bare = /(https?:\/\/\S+)/i.exec(bullet);
    if (bare) {
      const url = bare[1] ?? "";
      let label = url;
      try {
        label = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // Keep the URL as its own label.
      }
      add(label, url);
      continue;
    }
    // `bluesky: ada.example` names a network and a handle with no page.
    const pair = parsePair(bullet);
    if (pair && pair.key !== "note") {
      const network = pair.key.toLowerCase();
      const handle = pair.value.replace(/^@/, "");
      const url = accountUrlFor(network, handle, {}) ?? `${network}:${handle}`;
      add(pair.key, url);
    }
  }
  return out;
}

/** Parse a document. Never throws. */
export function parseOpenProfile(markdown: string): OpenProfile {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const profile: OpenProfile = {
    name: null,
    kind: null,
    handle: null,
    web: null,
    pay: null,
    did: null,
    identity: [],
    headline: null,
    accounts: [],
    topics: [],
    reshare: null,
    operator: null,
    sections: [],
    markdown,
  };

  let index = 0;
  // Everything before the first h2 is the head: name, identity block, headline.
  const head: string[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^##\s/.test(line)) break;
    head.push(line);
  }

  let afterName = false;
  let inBlock = false;
  let blockDone = false;
  for (const line of head) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && profile.name === null) {
      profile.name = strip(h1[1] ?? "");
      afterName = true;
      continue;
    }
    if (!afterName) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet && !blockDone) {
      inBlock = true;
      const pair = parsePair(bullet[1] ?? "");
      if (pair) profile.identity.push(pair);
      continue;
    }
    if (inBlock && !line.trim()) {
      blockDone = true;
      inBlock = false;
      continue;
    }
    if (inBlock) blockDone = true;
    if (line.trim() && profile.headline === null && !/^#/.test(line)) profile.headline = strip(line);
  }

  for (const pair of profile.identity) {
    const key = pair.key.toLowerCase();
    if (/^(kind|type)$/.test(key)) {
      const value = pair.value.toLowerCase();
      profile.kind = /^(agent|bot)$/.test(value)
        ? "agent"
        : /^(person|human|individual)$/.test(value)
          ? "person"
          : /^(org|organization|organisation|company|team)$/.test(value)
            ? "organization"
            : null;
    } else if (key === "handle") profile.handle = pair.value.replace(/^@/, "");
    else if (/^(web|website|site|homepage)$/.test(key)) profile.web = pair.value;
    else if (/^(pay|wallet|payment|pay to)$/.test(key)) profile.pay = pair.value;
    else if (key === "did" && /^did:[a-z0-9]+:/.test(pair.value)) profile.did = pair.value;
  }

  // Sections.
  let current: ProfileSection | null = null;
  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      const title = strip(h2[1] ?? "");
      let kind = title.toLowerCase();
      for (const [pattern, name] of SECTION_KINDS) if (pattern.test(title)) kind = name;
      current = { title, kind, markdown: "" };
      profile.sections.push(current);
      continue;
    }
    if (current) current.markdown += `${line}\n`;
  }

  for (const section of profile.sections) {
    if (section.kind === "accounts") profile.accounts.push(...parseAccounts(section.markdown));
    else if (section.kind === "topics") profile.topics.push(...parseTopics(section.markdown));
    else if (section.kind === "reshare") profile.reshare = parseReshare(section.markdown);
    else if (section.kind === "operator") profile.operator = parseOperator(section.markdown);
  }

  return profile;
}

/** The page for one of myna's accounts, when the network has a public one. */
export function accountUrlFor(network: string, handle: string, meta: Record<string, string>): string | null {
  const user = handle.replace(/^@/, "");
  const instance = (meta.instance ?? meta.service ?? meta.server ?? "").replace(/\/+$/, "");
  switch (network) {
    case "bluesky":
      return `https://bsky.app/profile/${user}`;
    case "x":
      return `https://x.com/${user}`;
    case "threads":
      return `https://www.threads.net/@${user}`;
    case "instagram":
      return `https://www.instagram.com/${user}`;
    case "facebook":
      return `https://www.facebook.com/${user}`;
    case "linkedin":
      return `https://www.linkedin.com/in/${user}`;
    case "reddit":
      return `https://www.reddit.com/user/${user}`;
    case "pinterest":
      return `https://www.pinterest.com/${user}`;
    case "tiktok":
      return `https://www.tiktok.com/@${user}`;
    case "youtube":
      return `https://www.youtube.com/@${user}`;
    case "devto":
      return `https://dev.to/${user}`;
    case "hashnode":
      return `https://hashnode.com/@${user}`;
    case "tumblr":
      return `https://${user}.tumblr.com`;
    case "microblog":
      return `https://micro.blog/${user}`;
    case "telegram":
      return `https://t.me/${user}`;
    case "nostr":
      return `https://njump.me/${meta.npub ?? user}`;
    case "mastodon":
    case "misskey":
    case "pixelfed":
    case "lemmy":
      return instance ? `${instance.startsWith("http") ? instance : `https://${instance}`}/@${user}` : null;
    case "ghost":
    case "wordpress":
    case "htmlblog":
    case "gitblog":
      return instance || (meta.url ? meta.url : null);
    default:
      return null;
  }
}

export interface ProfileInput {
  name: string;
  kind?: "person" | "agent" | "organization" | "";
  handle?: string;
  web?: string;
  email?: string;
  avatar?: string;
  pay?: string;
  did?: string;
  resume?: string;
  headline?: string;
  /** Extra identity pairs, kept as given. */
  extra?: ProfilePair[];
  accounts: Array<Pick<Account, "network" | "handle" | "meta">>;
  topics: string[];
  reshare?: Partial<ReshareTerms> | null;
  operator?: ProfileOperator | null;
}

/** Network ids shown as labels people recognise. */
const LABELS: Record<string, string> = {
  x: "X",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  misskey: "Misskey",
  pixelfed: "Pixelfed",
  lemmy: "Lemmy",
  nostr: "Nostr",
  threads: "Threads",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  youtube: "YouTube",
  devto: "dev.to",
  hashnode: "Hashnode",
  tumblr: "Tumblr",
  microblog: "Micro.blog",
  telegram: "Telegram",
  ghost: "Blog",
  wordpress: "Blog",
  htmlblog: "Blog",
  gitblog: "Blog",
};

/** Write a document. The inverse of parseOpenProfile for everything it can express. */
export function renderOpenProfile(input: ProfileInput): string {
  const blocks: string[] = [`# ${input.name.trim() || "Unnamed"}`];

  const identity: string[] = [];
  if (input.kind) identity.push(`- **Kind**: ${input.kind}`);
  if (input.handle) identity.push(`- **Handle**: @${input.handle.replace(/^@/, "")}`);
  if (input.web) identity.push(`- **Web**: ${input.web}`);
  if (input.email) identity.push(`- **Email**: ${input.email}`);
  if (input.avatar) identity.push(`- **Avatar**: ${input.avatar}`);
  if (input.pay) identity.push(`- **Pay**: ${input.pay}`);
  if (input.did) identity.push(`- **DID**: ${input.did}`);
  if (input.resume) identity.push(`- **Resume**: ${input.resume}`);
  for (const pair of input.extra ?? []) if (pair.key && pair.value) identity.push(`- **${pair.key}**: ${pair.value}`);
  if (identity.length) blocks.push(identity.join("\n"));

  if (input.headline?.trim()) blocks.push(input.headline.trim().split("\n")[0] ?? "");

  const accounts: string[] = [];
  const seen = new Set<string>();
  for (const account of input.accounts) {
    const url = accountUrlFor(account.network, account.handle, account.meta ?? {});
    const label = LABELS[account.network] ?? account.network;
    const line = url ? `- [${label}](${url})` : `- ${account.network}: ${account.handle}`;
    if (seen.has(line)) continue;
    seen.add(line);
    accounts.push(line);
  }
  if (accounts.length) blocks.push(["## Accounts", "", ...accounts].join("\n"));

  const topics = input.topics.map((topic) => topic.trim()).filter(Boolean);
  if (topics.length) blocks.push(["## Topics", "", `- ${topics.join(", ")}`].join("\n"));

  if (input.reshare) {
    const lines: string[] = [];
    if (input.reshare.networks?.length) lines.push(`- **Networks**: ${input.reshare.networks.join(", ")}`);
    if (input.reshare.topics?.length) lines.push(`- **Topics**: ${input.reshare.topics.join(", ")}`);
    if (input.reshare.not?.length) lines.push(`- **Not**: ${input.reshare.not.join(", ")}`);
    const rate = input.reshare.rateUsd ?? 0;
    lines.push(`- **Rate**: ${rate > 0 ? `$${rate.toFixed(2)}/reshare${input.reshare.perNetwork ? "/network" : ""}` : "free"}`);
    if (input.reshare.limitPerDay) lines.push(`- **Limit**: ${input.reshare.limitPerDay}/day`);
    blocks.push(["## Reshare", "", ...lines].join("\n"));
  }

  if (input.operator && (input.operator.name || input.operator.profile || input.operator.email || input.operator.did)) {
    const lines: string[] = [];
    if (input.operator.name) lines.push(`- **Name**: ${input.operator.name}`);
    if (input.operator.profile) lines.push(`- **Profile**: ${input.operator.profile}`);
    if (input.operator.email) lines.push(`- **Email**: ${input.operator.email}`);
    if (input.operator.did) lines.push(`- **DID**: ${input.operator.did}`);
    blocks.push(["## Operator", "", ...lines].join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}
