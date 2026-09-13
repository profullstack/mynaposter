/**
 * Reading an OpenProfile.md (logicsrc.com/docs/openprofile, 0.2).
 *
 * The nine rules, as a parser: one `#` is the name; the bullet list under it
 * is the identity block; one prose line after that is the headline; every
 * `##` opens a section whose title is kept verbatim and normalised separately
 * for matching. Nothing is required and nothing is dropped: an unknown key,
 * an unknown section, a second prose paragraph all survive a parse and a
 * render. A reader that wants more structure asks the helpers below for it.
 */

export interface IdentityEntry {
  /** The key as written, `Kind`, `Web`, `Discord`. */
  key: string;
  /** The value as written, trimmed. */
  value: string;
}

export interface Section {
  /** The heading text as written, `Find me`. */
  title: string;
  /** The normalised name, `accounts`. */
  name: string;
  /** The body, verbatim Markdown between this heading and the next `##`, trimmed. */
  body: string;
}

export interface OpenProfileDoc {
  /** The `#` heading, or null when the document has none. */
  name: string | null;
  identity: IdentityEntry[];
  /** The one prose line after the identity block, or null. */
  headline: string | null;
  /** Any further prose before the first `##`, verbatim. */
  prose: string;
  sections: Section[];
}

/** Rule 4: the section names in common use, and the words that mean them. */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {
  accounts: "accounts",
  account: "accounts",
  profiles: "accounts",
  elsewhere: "accounts",
  "find me": "accounts",
  "find-me": "accounts",
  social: "accounts",
  socials: "accounts",
  topics: "topics",
  topic: "topics",
  interests: "topics",
  reshare: "reshare",
  reshares: "reshare",
  resharing: "reshare",
  operator: "operator",
  match: "match",
  dating: "match",
  matching: "match",
  partner: "match",
  "looking for": "match",
  "looking-for": "match",
  photos: "photos",
  photo: "photos",
  pictures: "photos",
  broadcast: "broadcast",
  broadcasts: "broadcast",
  show: "broadcast",
  shows: "broadcast",
  guest: "guest",
  guests: "guest",
  speaking: "guest",
  links: "links",
  link: "links",
  about: "about",
  bio: "about",
  projects: "projects",
  project: "projects",
  work: "projects",
  services: "services",
  service: "services",
  contact: "contact",
};

/** The names the spec lists, in the order a renderer puts them. */
export const KNOWN_SECTIONS: readonly string[] = [
  "about",
  "accounts",
  "topics",
  "broadcast",
  "guest",
  "reshare",
  "match",
  "photos",
  "operator",
  "projects",
  "services",
  "links",
  "contact",
];

/** Rule 4: `Accounts`, `Profiles`, `Elsewhere` and `Find me` are one thing to a reader. */
export function normaliseSection(title: string): string {
  const key = title
    .trim()
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
  return SECTION_ALIASES[key] ?? key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const HEADING_1 = /^#\s+(.+?)\s*#*\s*$/;
const HEADING_2 = /^##\s+(.+?)\s*#*\s*$/;
const HEADING_ANY = /^#{1,6}\s/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
/** `Key: value`, `**Key**: value`, `**Key:** value`, `Key - value` is not one. */
const KEY_VALUE = /^\*{0,2}([A-Za-z][A-Za-z0-9 _/'-]{0,40}?)\*{0,2}\s*:\*{0,2}\s*(.*)$/;
const MD_LINK = /^\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/** Split `**Key**: value` into its halves, or null when the line is not one. */
export function keyValue(line: string): { key: string; value: string } | null {
  const m = KEY_VALUE.exec(line.trim());
  if (!m) return null;
  const key = m[1]!.trim();
  const value = m[2]!.trim().replace(/^\*\*|\*\*$/g, "").trim();
  if (!key) return null;
  return { key, value };
}

/** Read an OpenProfile.md into its parts. Never throws: an empty string is an empty document. */
export function parseOpenProfile(markdown: string): OpenProfileDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const doc: OpenProfileDoc = { name: null, identity: [], headline: null, prose: "", sections: [] };

  let i = 0;
  // Front matter is not part of the spec, but a file that has it should still read.
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }

  // Rule 1: the first `#` is the name. Prose before it is kept as prose.
  const before: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h1 = HEADING_1.exec(line);
    if (h1 && !line.startsWith("##")) {
      doc.name = h1[1]!.trim();
      i++;
      break;
    }
    if (HEADING_2.test(line)) break;
    before.push(line);
  }

  // Rule 2: the bullet list directly under the name is the identity block.
  let sawIdentity = false;
  const proseLines: string[] = [...before];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (HEADING_2.test(line)) break;
    if (!sawIdentity && line.trim() === "") {
      if (doc.identity.length > 0) sawIdentity = true;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && !sawIdentity) {
      const text = bullet[1]!.trim();
      const kv = keyValue(text);
      if (kv) {
        doc.identity.push(kv);
        continue;
      }
      const link = MD_LINK.exec(text);
      if (link) {
        doc.identity.push({ key: link[1]!.trim() || "Link", value: link[2]! });
        continue;
      }
      // A bare bullet that is not a key: the identity block has ended.
      sawIdentity = true;
    }
    if (doc.identity.length > 0) sawIdentity = true;
    proseLines.push(line);
  }

  // Rule 3: one prose line is the headline; the rest is kept.
  const prose = proseLines.map((l) => l.replace(/\s+$/, ""));
  while (prose.length && prose[0]!.trim() === "") prose.shift();
  while (prose.length && prose[prose.length - 1]!.trim() === "") prose.pop();
  if (prose.length) {
    const first = prose[0]!;
    if (!HEADING_ANY.test(first) && !BULLET.test(first)) {
      doc.headline = first.trim();
      prose.shift();
      while (prose.length && prose[0]!.trim() === "") prose.shift();
    }
  }
  doc.prose = prose.join("\n").trim();

  // Rule 4: `##` opens a section, kept verbatim.
  let current: Section | null = null;
  const body: string[] = [];
  const close = () => {
    if (current) {
      current.body = body.join("\n").trim();
      doc.sections.push(current);
    }
    body.length = 0;
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h2 = HEADING_2.exec(line);
    if (h2 && !line.startsWith("###")) {
      close();
      const title = h2[1]!.trim();
      current = { title, name: normaliseSection(title), body: "" };
      continue;
    }
    if (current) body.push(line);
    else if (line.trim()) {
      // Text after the headline but before any section, when the identity block was absent.
      doc.prose = doc.prose ? `${doc.prose}\n${line}` : line;
    }
  }
  close();
  return doc;
}

/** The identity block as a map; the first of a repeated key wins, keys match case-insensitively. */
export function identityMap(doc: OpenProfileDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of doc.identity) {
    const k = key.toLowerCase();
    if (!(k in out)) out[k] = value;
  }
  return out;
}

/** One identity value by key, case-insensitively. */
export function identityValue(doc: OpenProfileDoc, key: string): string | null {
  const k = key.toLowerCase();
  for (const e of doc.identity) if (e.key.toLowerCase() === k) return e.value;
  return null;
}

/** Rule 2: `bot` means agent; `org` and `company` mean organization. Absent is null, not a guess. */
export function kindOf(doc: OpenProfileDoc): "person" | "agent" | "organization" | null {
  const raw = identityValue(doc, "Kind")?.toLowerCase().trim();
  if (!raw) return null;
  if (raw === "person" || raw === "human") return "person";
  if (raw === "agent" || raw === "bot") return "agent";
  if (raw === "organization" || raw === "organisation" || raw === "org" || raw === "company") return "organization";
  return null;
}

/** The first section with this normalised name, or null. */
export function section(doc: OpenProfileDoc, name: string): Section | null {
  const n = normaliseSection(name);
  return doc.sections.find((s) => s.name === n) ?? null;
}

/** Every section with this normalised name (a person with two shows has two Broadcast sections). */
export function sections(doc: OpenProfileDoc, name: string): Section[] {
  const n = normaliseSection(name);
  return doc.sections.filter((s) => s.name === n);
}

/** The bullets of a section body, each without its marker, nested bullets flattened in order. */
export function bullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = BULLET.exec(line);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/**
 * `- **Key**: value` bullets of a section as a map, in order, first of a repeated
 * key wins. Bullets that are not key-value pairs are left out; ask `bullets` for them.
 */
export function sectionKeys(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bullets(body)) {
    const kv = keyValue(b);
    if (kv && !(kv.key in out)) out[kv.key] = kv.value;
  }
  return out;
}

export interface Account {
  /** The page, which is the identity (rule 5). */
  url: string;
  /** What to call it: the link label, or the `network:` prefix, or null. */
  label: string | null;
}

const URL_IN_TEXT = /https?:\/\/[^\s)\]>]+/;

/** Rule 5: every bullet under Accounts is one account, and the URL is the identity. */
export function accounts(doc: OpenProfileDoc): Account[] {
  const out: Account[] = [];
  for (const s of sections(doc, "accounts")) {
    for (const b of bullets(s.body)) {
      const link = MD_LINK.exec(b);
      if (link) {
        out.push({ url: link[2]!, label: link[1]!.trim() || null });
        continue;
      }
      const url = URL_IN_TEXT.exec(b)?.[0];
      if (url) {
        const label = b.slice(0, b.indexOf(url)).replace(/[:\s-]+$/, "").trim();
        out.push({ url, label: label || null });
        continue;
      }
      // `bluesky: ada.example` names a network and a handle without a URL.
      const kv = keyValue(b);
      if (kv && kv.value) out.push({ url: `${kv.key.toLowerCase()}:${kv.value}`, label: kv.key });
    }
  }
  return out;
}

/** Rule 6: lowercased, `#` stripped, trimmed; one per bullet or comma-separated on a line. */
export function topics(doc: OpenProfileDoc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim().replace(/^#/, "").trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const s of sections(doc, "topics")) {
    const items = bullets(s.body);
    const source = items.length ? items : s.body.split("\n").filter((l) => l.trim());
    for (const line of source) for (const part of line.split(",")) push(part);
  }
  return out;
}
