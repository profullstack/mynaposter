/**
 * Contacts from an agenticjobs board: the contact info candidates published.
 *
 * A candidate's resume carries a contact block that the board shows to
 * signed-in readers and withholds from strangers. Reading it here uses the
 * account myna is logged in to the board with, so what comes back is exactly
 * what the board would show that account on the page: published by the
 * person, to members. Nothing is scraped around the gate, and the source is
 * written on every contact so the list can be pruned by where it came from.
 */
import type { Account } from "../net/types.ts";
import { readContacts, upsertContact, type Contact } from "../store/contacts.ts";

interface CandidateSummary {
  slug: string;
  name: string;
  headline: string | null;
  skills?: string[];
}

interface CandidateDetail {
  candidate: CandidateSummary;
  parsed: { contact?: Array<{ key: string; value: string; href: string | null }>; name?: string | null } | null;
  url?: string;
  openprofile?: string;
  contactRedacted?: boolean;
}

export interface ImportOptions {
  fetch?: typeof fetch;
  /** Tags to put on every imported contact, beside `agenticjobs`. */
  tags?: string[];
  /** A list to add them to. */
  list?: string;
  limit?: number;
  log?: (line: string) => void;
}

export interface ImportResult {
  read: number;
  imported: Contact[];
  /** Candidates with nothing reachable published. */
  skipped: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;

/** Read published contacts from the board the account is logged in to. */
export async function importFromAgenticjobs(account: Account, options: ImportOptions = {}): Promise<ImportResult> {
  const fetcher = options.fetch ?? fetch;
  const instance = (account.meta.instance ?? "https://agenticjobs.work").replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${account.creds.token}`, accept: "application/json" };
  const log = options.log ?? (() => {});
  const result: ImportResult = { read: 0, imported: [], skipped: [] };

  const read = async <T>(url: string): Promise<T> => {
    const response = await fetcher(url, { headers });
    if (!response.ok) throw new Error(`${url.replace(instance, "")} answered ${response.status}`);
    return (await response.json()) as T;
  };
  const listing = await read<{ items?: CandidateSummary[] }>(`${instance}/api/v1/candidates?limit=${options.limit ?? 100}`);
  const items = listing.items ?? [];
  result.read = items.length;
  const file = readContacts();

  for (const summary of items) {
    let detail: CandidateDetail;
    try {
      detail = await read<CandidateDetail>(`${instance}/api/v1/candidates/${encodeURIComponent(summary.slug)}`);
    } catch (error) {
      result.skipped.push(`${summary.slug}: ${(error as Error).message}`);
      continue;
    }
    if (detail.contactRedacted) {
      result.skipped.push(`${summary.slug}: contact withheld (sign in to the board with myna login agenticjobs)`);
      continue;
    }
    const pairs = detail.parsed?.contact ?? [];
    let email: string | null = null;
    let phone: string | null = null;
    const handles: string[] = [];
    for (const pair of pairs) {
      const value = pair.value.trim();
      if (!email && (EMAIL.test(value) || pair.href?.startsWith("mailto:"))) email = (pair.href?.startsWith("mailto:") ? pair.href.slice(7) : value).toLowerCase();
      else if (!phone && (PHONE.test(value) || pair.href?.startsWith("tel:"))) phone = pair.href?.startsWith("tel:") ? pair.href.slice(4) : value.replace(/[^\d+]/g, "");
      else if (pair.href && /^https?:\/\//.test(pair.href)) handles.push(`${pair.key.toLowerCase()}:${pair.href}`);
    }
    if (!email && !phone && !handles.length) {
      result.skipped.push(`${summary.slug}: nothing published to reach them by`);
      continue;
    }
    const contact = upsertContact(
      {
        name: summary.name || detail.parsed?.name || null,
        email,
        phone,
        handles,
        openprofile: detail.openprofile ?? `${instance}/candidates/${summary.slug}/openprofile.md`,
        source: `agenticjobs:${summary.slug}`,
        tags: ["agenticjobs", ...(options.tags ?? []), ...(summary.skills ?? []).slice(0, 5).map((s) => s.toLowerCase())],
        ...(summary.headline ? { note: summary.headline } : {}),
      },
      file,
    );
    result.imported.push(contact);
    log(`${summary.name}: ${email ?? phone ?? handles[0]}`);
  }

  if (options.list && result.imported.length) {
    const { addToList } = await import("../store/contacts.ts");
    addToList(options.list, result.imported.map((contact) => contact.id), readContacts());
  }
  return result;
}
