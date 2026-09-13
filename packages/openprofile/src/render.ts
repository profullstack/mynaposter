/**
 * Writing an OpenProfile.md back out, and building one from parts.
 *
 * The renderer emits the house shape: `# Name`, `- **Key**: value` identity
 * bullets, a blank line, the headline, any further prose, then `## Section`
 * bodies verbatim. Known sections come first in the spec's order; unknown
 * ones follow in the order they were given. Absence is unstated: a null or
 * empty value is not written.
 */

import { KNOWN_SECTIONS, normaliseSection, type IdentityEntry, type OpenProfileDoc, type Section } from "./parse.ts";

/** A key-value bullet line, or null when the value is empty. */
export function keyLine(key: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  return `- **${key}**: ${v}`;
}

/** Lines for a keyed section, empty values left out. */
export function keyLines(entries: Record<string, string | number | null | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const line = keyLine(k, v);
    if (line) out.push(line);
  }
  return out;
}

/** Build a section from keyed bullets; null when nothing survives. */
export function keyedSection(title: string, entries: Record<string, string | number | null | undefined>): Section | null {
  const body = keyLines(entries).join("\n");
  if (!body) return null;
  return { title, name: normaliseSection(title), body };
}

/** Build a section from plain bullets; null when the list is empty. */
export function listSection(title: string, items: readonly (string | null | undefined)[]): Section | null {
  const lines = items.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => `- ${x.trim()}`);
  if (!lines.length) return null;
  return { title, name: normaliseSection(title), body: lines.join("\n") };
}

/** Known sections in the spec's order, then the rest as given. */
export function orderSections(list: readonly Section[]): Section[] {
  const rank = (s: Section) => {
    const i = KNOWN_SECTIONS.indexOf(s.name);
    return i === -1 ? KNOWN_SECTIONS.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

export function renderOpenProfile(doc: OpenProfileDoc): string {
  const out: string[] = [];
  out.push(`# ${(doc.name ?? "").trim() || "Unnamed"}`);
  const identity = doc.identity.filter((e) => e.value.trim() !== "");
  if (identity.length) {
    out.push("");
    for (const e of identity) out.push(`- **${e.key}**: ${e.value.trim()}`);
  }
  if (doc.headline?.trim()) {
    out.push("");
    out.push(doc.headline.trim());
  }
  if (doc.prose.trim()) {
    out.push("");
    out.push(doc.prose.trim());
  }
  for (const s of orderSections(doc.sections)) {
    if (!s.body.trim()) continue;
    out.push("");
    out.push(`## ${s.title}`);
    out.push("");
    out.push(s.body.trim());
  }
  return `${out.join("\n")}\n`;
}

/** A document from parts, for generators; every field optional, empty ones dropped. */
export function makeOpenProfile(parts: {
  name: string;
  identity?: Record<string, string | number | null | undefined> | IdentityEntry[];
  headline?: string | null;
  prose?: string | null;
  sections?: (Section | null | undefined)[];
}): OpenProfileDoc {
  const identity: IdentityEntry[] = Array.isArray(parts.identity)
    ? parts.identity.filter((e) => e.value.trim() !== "")
    : Object.entries(parts.identity ?? {})
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
        .map(([key, v]) => ({ key, value: String(v).trim() }));
  return {
    name: parts.name,
    identity,
    headline: parts.headline?.trim() || null,
    prose: parts.prose?.trim() ?? "",
    sections: (parts.sections ?? []).filter((s): s is Section => !!s && s.body.trim() !== ""),
  };
}
