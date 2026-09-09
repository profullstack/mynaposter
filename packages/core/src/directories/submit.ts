/**
 * Turning a URL into a directory listing, and sending it.
 *
 * The command people actually type is `myna directory saasrow <url>`, so the
 * work is here rather than in the CLI: read the page, describe the product,
 * let anything given explicitly win, and submit. The CLI, the TUI, the MCP
 * server and the desktop app all call this and so all behave the same.
 */
import { fetchPage, type PageSummary } from "../ai/extract.ts";
import { listingCopy, writerAvailable } from "../ai/writer.ts";
import {
  getDirectoryAccount,
  saveDirectoryAccount,
  removeDirectoryAccount,
  listDirectoryAccounts,
} from "../store/accounts.ts";
import { listDirectories, requireDirectory } from "./registry.ts";
import type { Directory, DirectoryAccount, Listing, ListingInput } from "./types.ts";

export interface BuildOptions {
  /** Fields the person supplied. Anything here wins over what was derived. */
  overrides?: Partial<ListingInput>;
  /**
   * Ask the model to write the description and pick the vocabulary terms.
   * Off falls back to the page's own metadata, which is worse but free and
   * works with no API key.
   */
  ai?: boolean;
  /** Cap for the description. Directories reject anything longer. */
  maxDescription?: number;
}

export interface BuiltListing {
  listing: ListingInput;
  page: PageSummary;
  /** How the description was arrived at, so the CLI can say so. */
  source: "ai" | "page" | "given";
}

/**
 * The product's name, as opposed to the page's title.
 *
 * A landing page is titled "Widget — the fastest way to frob" far more often
 * than it is titled "Widget", so the tagline after the separator is dropped.
 * `og:site_name` is better still when a page sets it, because that is the
 * publisher naming itself.
 */
export function deriveName(page: PageSummary): string {
  let host = "";
  try {
    host = new URL(page.url).hostname;
  } catch {
    /* not a URL we can read a host out of */
  }
  const bare = host.replace(/^www\./, "");

  // `fetchPage` falls back to the hostname for both of these when the page
  // declares neither, so a value equal to the host carries no information and
  // must not beat the title.
  const siteName = page.siteName?.trim();
  const title = page.title?.trim();
  const candidate =
    (siteName && siteName !== host && siteName !== bare ? siteName : "") ||
    (title && title !== host && title !== bare ? title : "") ||
    "";
  if (!candidate) return bare;
  const head = candidate.split(/\s+[|·—–-]\s+/)[0]?.trim() ?? candidate;
  // A separator can also be the product's own name ("Read-It"), so only take
  // the head when it left something substantial behind.
  return (head.length >= 2 ? head : candidate).slice(0, 120);
}

/** The page's own words, when there is no model to write better ones. */
export function deriveDescription(page: PageSummary, max: number): string {
  const meta = page.description?.trim();
  if (meta && meta.length >= 60) return meta.slice(0, max);
  const prose = (page.text ?? "").replace(/\s+/g, " ").trim();
  const merged = meta ? `${meta} ${prose}`.trim() : prose;
  if (!merged) return meta ?? "";
  if (merged.length <= max) return merged;
  // Cut on a sentence rather than mid-word.
  const cut = merged.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (stop > max / 2 ? cut.slice(0, stop + 1) : cut).trim();
}

/** Merge in what the person gave, dropping empties so a blank flag changes nothing. */
function applyOverrides(base: ListingInput, overrides?: Partial<ListingInput>): ListingInput {
  if (!overrides) return base;
  const merged: ListingInput = { ...base };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof ListingInput, unknown]>) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * Read a URL and build the listing that would be submitted.
 *
 * Separate from `submitListing` on purpose: `--dry-run` shows exactly this,
 * and a person editing a field before sending is the common case, not the
 * exception.
 */
export async function buildListing(
  directory: Directory,
  url: string,
  options: BuildOptions = {},
): Promise<BuiltListing> {
  const target = url.trim();
  if (!target) throw new Error("Which URL?");
  const website = /^https?:\/\//i.test(target) ? target : `https://${target}`;

  const page = await fetchPage(website);
  const max = options.maxDescription ?? 2000;

  let listing: ListingInput = {
    name: deriveName(page),
    website,
    description: deriveDescription(page, max),
  };
  let source: BuiltListing["source"] = "page";

  // The model is asked for the vocabulary terms as well as the prose, so it
  // needs the directory's lists first. A directory that publishes neither
  // simply gets a description.
  if (options.ai !== false && writerAvailable().ok) {
    const [categories, vocabulary] = await Promise.all([
      directory.caps.categories && directory.categories
        ? directory.categories().catch(() => [])
        : Promise.resolve([]),
      directory.caps.vocabulary && directory.vocabulary
        ? directory.vocabulary().catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const copy = await listingCopy({
      page,
      categories: categories.map((entry) => entry.name).filter(Boolean),
      vocabulary: vocabulary && {
        useCases: vocabulary.useCases,
        audiences: vocabulary.audiences,
        platforms: vocabulary.platforms,
        pricingModels: vocabulary.pricingModels,
      },
      maxDescription: Math.min(max, 900),
    });

    listing = {
      name: copy.name || listing.name,
      website,
      description: copy.description || listing.description,
      category: copy.category || undefined,
      tags: copy.tags.length ? copy.tags : undefined,
      useCases: copy.useCases.length ? copy.useCases : undefined,
      audiences: copy.audiences.length ? copy.audiences : undefined,
      platforms: copy.platforms.length ? copy.platforms : undefined,
      pricingModel: copy.pricingModel || undefined,
      alternatives: copy.alternatives.length ? copy.alternatives : undefined,
    };
    source = "ai";
  }

  const merged = applyOverrides(listing, options.overrides);
  if (options.overrides?.description?.trim()) source = "given";

  if (!merged.name) throw new Error(`Could not work out a product name from ${website}. Pass --name.`);
  if (!merged.description) throw new Error(`Could not work out a description from ${website}. Pass --description.`);

  return { listing: merged, page, source };
}

/** The stored credential for a directory, or a message saying how to get one. */
export function requireDirectoryAccount(id: string): DirectoryAccount {
  const account = getDirectoryAccount(id);
  if (account) return account;
  throw new Error(`Not signed in to ${id}. Run: myna directory login ${id}`);
}

export interface SubmitResult {
  directory: string;
  listing: Listing;
  /** What was sent, so a caller can show the fields without asking again. */
  input: ListingInput;
}

/** Send a listing to a directory. */
export async function submitListing(
  directoryId: string,
  input: ListingInput,
): Promise<SubmitResult> {
  const directory = requireDirectory(directoryId);
  const account = requireDirectoryAccount(directory.id);
  const listing = await directory.submit(account, input);
  return { directory: directory.id, listing, input };
}

/** Read a URL and submit it in one go — what the command does. */
export async function submitUrl(
  directoryId: string,
  url: string,
  options: BuildOptions = {},
): Promise<SubmitResult & { built: BuiltListing }> {
  const directory = requireDirectory(directoryId);
  // Fail before spending a model call on a page we cannot submit anyway.
  requireDirectoryAccount(directory.id);
  const built = await buildListing(directory, url, options);
  const result = await submitListing(directory.id, built.listing);
  return { ...result, built };
}

/** Sign in and store the credential. */
export async function loginDirectory(
  directoryId: string,
  input: Record<string, string>,
  ctx: Parameters<Directory["login"]>[1],
): Promise<DirectoryAccount> {
  const directory = requireDirectory(directoryId);
  const partial = await directory.login(input, ctx);
  const account: DirectoryAccount = {
    directory: directory.id,
    addedAt: new Date().toISOString(),
    ...partial,
  };
  saveDirectoryAccount(account);
  return account;
}

export function logoutDirectory(directoryId: string): boolean {
  return removeDirectoryAccount(requireDirectory(directoryId).id);
}

/** Every directory, with whether this machine is signed in to it. */
export function directoryStatus(): Array<{ directory: Directory; account?: DirectoryAccount }> {
  const accounts = new Map(listDirectoryAccounts().map((account) => [account.directory, account]));
  return listDirectories().map((directory) => ({ directory, account: accounts.get(directory.id) }));
}
