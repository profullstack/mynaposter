/**
 * Flag readers and printers shared by `myna newsletter` and `myna newsletter
 * blast`, in their own module so neither file imports the other back.
 */
import { loadSettings, type SendNewsletterReport, type SubscribeResult } from "@profullstack/myna-core";
import { out } from "./io.ts";

export type Flags = Record<string, unknown>;

export const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
export const list = (value: string | undefined): string[] => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
export const num = (flags: Flags, key: string): number | undefined => {
  const value = str(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} takes a number.`);
  return parsed;
};

/** --cta-set: a set name, or "none". Absent, `fallback`. */
export function ctaSetFlag(flags: Flags, fallback: string | null | undefined): string | null | undefined {
  const value = str(flags, "ctaSet");
  if (value === undefined) return fallback;
  if (value === "none") return null;
  if (!loadSettings().newsletter.ctaSets[value]?.length) throw new Error(`No CTA set "${value}", or it is empty. myna newsletter cta list shows them.`);
  return value;
}

export function reportSubscribe(result: SubscribeResult, listName: string): void {
  out(`${result.added.length} added to ${listName}${result.already.length ? `, ${result.already.length} already on it` : ""}.`);
  if (result.optedOut.length) out(`${result.optedOut.length} opted out before and stay out: ${result.optedOut.slice(0, 10).join(", ")}`);
  if (result.invalid.length) out(`${result.invalid.length} not an email address: ${result.invalid.slice(0, 10).join(", ")}`);
}

export function printVariants(report: SendNewsletterReport): void {
  if (report.variants.length < 2) return;
  out(`${report.variants.length} variants, split over the ${Object.values(report.split).reduce((a, b) => a + b, 0)} still due:`);
  for (const variant of report.variants) {
    out(`  ${variant.key}  ${String(report.split[variant.key] ?? 0).padStart(6)}  subject ${variant.subjectKey}: ${variant.subject}${variant.cta ? `  |  CTA: ${variant.cta.label}` : ""}`);
  }
}
