/**
 * Owner edits over a generated document, and several documents into one.
 *
 * Every app that serves a profile generates it from what it knows (a feed, a
 * resume, social bios) and lets the person it is about correct it. The
 * correction is an overlay: the owner's identity keys, headline and sections
 * win; a section the owner did not touch is still generated; a section the
 * owner wrote as the single word `none` is dropped. The same overlay shape
 * travels over the API, the CLI, the MCP tool and the web form.
 *
 * A directory that meets the same person on several apps merges their
 * documents: identity keys first-writer-wins, Accounts and Topics unioned,
 * Broadcast sections kept apart as `### <show>` groups (the spec allows it),
 * other sections first-writer-wins. The result says nothing either source did
 * not say.
 */

import { accounts, bullets, normaliseSection, parseOpenProfile, sectionKeys, sections, type IdentityEntry, type OpenProfileDoc, type Section } from "./parse.ts";
import { normaliseUrl } from "./identity.ts";

/** The owner's overlay. Every field optional; `null` removes; the string `none` removes a section. */
export interface Overrides {
  name?: string | null;
  /** Identity keys to set; a null value removes the key. Keys match case-insensitively. */
  identity?: Record<string, string | null>;
  headline?: string | null;
  prose?: string | null;
  /** Section bodies by normalised name (or title); `none` removes the section. */
  sections?: Record<string, string>;
}

export const REMOVED = "none";

function titleFor(name: string): string {
  const known: Record<string, string> = {
    accounts: "Accounts",
    topics: "Topics",
    reshare: "Reshare",
    operator: "Operator",
    match: "Match",
    photos: "Photos",
    broadcast: "Broadcast",
    guest: "Guest",
    links: "Links",
    about: "About",
    projects: "Projects",
    services: "Services",
    contact: "Contact",
  };
  return known[name] ?? name.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`);
}

/** The generated document with the owner's overlay applied. Neither input is changed. */
export function applyOverrides(generated: OpenProfileDoc, overrides: Overrides | null | undefined): OpenProfileDoc {
  const doc: OpenProfileDoc = {
    name: generated.name,
    identity: generated.identity.map((e) => ({ ...e })),
    headline: generated.headline,
    prose: generated.prose,
    sections: generated.sections.map((s) => ({ ...s })),
  };
  if (!overrides) return doc;
  if (overrides.name !== undefined) doc.name = overrides.name?.trim() || doc.name;
  if (overrides.headline !== undefined) doc.headline = overrides.headline?.trim() || null;
  if (overrides.prose !== undefined) doc.prose = overrides.prose?.trim() ?? "";
  for (const [key, value] of Object.entries(overrides.identity ?? {})) {
    const k = key.toLowerCase();
    const at = doc.identity.findIndex((e) => e.key.toLowerCase() === k);
    if (value === null || value.trim() === "") {
      if (at >= 0) doc.identity.splice(at, 1);
    } else if (at >= 0) doc.identity[at] = { key: doc.identity[at]!.key, value: value.trim() };
    else doc.identity.push({ key, value: value.trim() });
  }
  for (const [rawName, body] of Object.entries(overrides.sections ?? {})) {
    const name = normaliseSection(rawName);
    const keep = doc.sections.filter((s) => s.name !== name);
    if (body.trim().toLowerCase() === REMOVED || body.trim() === "") {
      doc.sections = keep;
      continue;
    }
    const existing = doc.sections.find((s) => s.name === name);
    const title = existing?.title ?? (rawName === name ? titleFor(name) : rawName);
    const at = doc.sections.findIndex((s) => s.name === name);
    const replacement: Section = { title, name, body: body.trim() };
    if (at >= 0) {
      doc.sections = [...doc.sections.slice(0, at), replacement, ...keep.slice(at)];
    } else doc.sections = [...keep, replacement];
  }
  return doc;
}

/**
 * A whole edited OpenProfile.md as an overlay: everything the owner wrote
 * becomes an override, so a `PUT` of a file is the same as a `PUT` of JSON.
 * Sections the file lacks but the generator had are left to the generator;
 * pass `dropMissing` to remove them instead.
 */
export function overridesFromDocument(markdown: string, generated?: OpenProfileDoc, dropMissing = false): Overrides {
  const doc = parseOpenProfile(markdown);
  const overrides: Overrides = { sections: {} };
  if (doc.name) overrides.name = doc.name;
  overrides.headline = doc.headline;
  if (doc.prose) overrides.prose = doc.prose;
  overrides.identity = {};
  for (const e of doc.identity) overrides.identity[e.key] = e.value;
  if (generated) {
    for (const e of generated.identity) {
      if (!doc.identity.some((x) => x.key.toLowerCase() === e.key.toLowerCase())) overrides.identity[e.key] = null;
    }
  }
  // A file may carry the same section twice (rule 4 allows two Broadcast
  // sections for two shows); both survive, one after the other.
  for (const s of doc.sections) {
    const prior = overrides.sections![s.name];
    overrides.sections![s.name] = prior ? `${prior}\n\n${s.body}` : s.body;
  }
  if (dropMissing && generated) {
    for (const s of generated.sections) if (!doc.sections.some((x) => x.name === s.name)) overrides.sections![s.name] = REMOVED;
  }
  return overrides;
}

/** Two overlays into one, the second winning key by key. */
export function mergeOverrides(base: Overrides | null | undefined, patch: Overrides | null | undefined): Overrides {
  const out: Overrides = { ...(base ?? {}) };
  if (!patch) return out;
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.headline !== undefined) out.headline = patch.headline;
  if (patch.prose !== undefined) out.prose = patch.prose;
  if (patch.identity) out.identity = { ...(base?.identity ?? {}), ...patch.identity };
  if (patch.sections) {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(base?.sections ?? {})) merged[normaliseSection(k)] = v;
    for (const [k, v] of Object.entries(patch.sections)) merged[normaliseSection(k)] = v;
    out.sections = merged;
  }
  return out;
}

function unionBullets(bodies: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of bodies) {
    for (const b of bullets(body)) {
      const url = /https?:\/\/[^\s)]+/.exec(b)?.[0];
      const key = url ? normaliseUrl(url) : b.trim().toLowerCase().replace(/^#/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- ${b}`);
    }
  }
  return out.join("\n");
}

/**
 * Several documents about the same person into one. Order matters: the first
 * is the primary and its name, identity and headline are kept where they
 * exist; later documents fill what is absent. Accounts and Topics are unioned;
 * Broadcast sections are kept apart under `### <show>` headings; every other
 * section is the first document's, or the first that has it.
 */
export function mergeProfiles(docs: readonly OpenProfileDoc[]): OpenProfileDoc {
  const [first, ...rest] = docs;
  if (!first) return { name: null, identity: [], headline: null, prose: "", sections: [] };
  const identity: IdentityEntry[] = first.identity.map((e) => ({ ...e }));
  let headline = first.headline;
  let prose = first.prose;
  let name = first.name;
  for (const d of rest) {
    name ??= d.name;
    headline ??= d.headline;
    if (!prose) prose = d.prose;
    for (const e of d.identity) {
      if (!identity.some((x) => x.key.toLowerCase() === e.key.toLowerCase())) identity.push({ ...e });
    }
  }
  const out: Section[] = [];
  const all = docs.flatMap((d) => d.sections);
  const names = [...new Set(all.map((s) => s.name))];
  for (const n of names) {
    const group = all.filter((s) => s.name === n);
    const title = group[0]!.title;
    if (n === "accounts" || n === "topics" || n === "photos" || n === "links") {
      out.push({ title, name: n, body: unionBullets(group.map((s) => s.body)) });
    } else if (n === "broadcast" && group.length > 1) {
      // Distinct shows stay distinct; the same show from two apps is one group.
      const shows = new Map<string, string>();
      for (const s of group) {
        const keys = sectionKeys(s.body);
        const feed = keys.Feed ? normaliseUrl(keys.Feed) : null;
        const label = keys.Show?.trim() || "Broadcast";
        const id = feed ?? label.toLowerCase();
        if (!shows.has(id)) {
          const body = s.body.includes("\n### ") || s.body.startsWith("### ") ? s.body : `### ${label}\n\n${s.body}`;
          shows.set(id, body);
        }
      }
      out.push({ title, name: n, body: [...shows.values()].join("\n\n") });
    } else {
      out.push({ ...group[0]! });
    }
  }
  return { name, identity, headline, prose, sections: out };
}

/** Every Broadcast section as keyed shows, `###` groups split apart. */
export function broadcasts(doc: OpenProfileDoc): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const s of sections(doc, "broadcast")) {
    const parts = s.body.split(/^###\s+/m).filter((p) => p.trim());
    if (parts.length > 1 || s.body.trimStart().startsWith("###")) {
      for (const part of parts) {
        const [head, ...bodyLines] = part.split("\n");
        const keys = sectionKeys(bodyLines.join("\n"));
        if (!keys.Show && head?.trim()) keys.Show = head.trim();
        out.push(keys);
      }
    } else out.push(sectionKeys(s.body));
  }
  return out;
}

/** The Guest section as keys, or null when the person offers no appearances. */
export function guest(doc: OpenProfileDoc): Record<string, string> | null {
  const s = sections(doc, "guest")[0];
  return s ? sectionKeys(s.body) : null;
}

export { accounts };
