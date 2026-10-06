/**
 * An issue's web copy: once a newsletter has gone out, it also goes up as a
 * post on the accounts `settings.newsletter.publishTo` names for its list (a
 * bl0ggers publication's newsletter channel, say), so the issue has a page
 * people can link to and find later.
 *
 * Each account gets the issue once. The post carries `myna:newsletter:<id>`
 * as its idempotency key, and the issue records what came back in
 * `published`, so the daemon can look on every turn without posting twice.
 * A failure is written down and tried again on a later turn, up to
 * MAX_ATTEMPTS, so a publication that is down does not lose the issue and
 * one that refuses it is not hammered forever.
 *
 * An issue that went out more than ARCHIVE_AFTER_MS ago is published with
 * `broadcast: false`: it is filed as back-issue, not mailed to the
 * publication's own subscribers as if it were news.
 */
import { postToAll } from "./poster.ts";
import { getAccount } from "../store/accounts.ts";
import { loadSettings } from "../store/settings.ts";
import { readNewsletters, writeNewsletters, type Newsletter, type NewslettersFile, type PublishedCopy } from "../store/newsletters.ts";

export const MAX_ATTEMPTS = 5;
export const ARCHIVE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const CTA_MARK = "{{cta}}";

export interface PublishOptions {
  /** Account ids; the list's `publishTo` when absent. */
  to?: string[];
  /** Mail the publication's subscribers. Default: only when the issue went out recently. */
  broadcast?: boolean;
  /** Post again to an account that already has the issue (it updates in place). */
  force?: boolean;
  now?: Date;
}

export interface PublishResult {
  account: string;
  ok: boolean;
  url?: string;
  error?: string;
  skipped?: string;
}

/** When the issue first reached anyone: its sentAt, else the earliest sent delivery. Null if nobody yet. */
export function wentOutAt(newsletter: Newsletter, file: NewslettersFile): string | null {
  if (newsletter.sentAt) return newsletter.sentAt;
  const sent = Object.values(file.deliveries[newsletter.id] ?? {})
    .filter((delivery) => delivery.state === "sent")
    .map((delivery) => delivery.at)
    .sort();
  return sent[0] ?? null;
}

/** The accounts an issue goes up on. */
export function publishTargets(newsletter: Pick<Newsletter, "list">, settings = loadSettings()): string[] {
  return settings.newsletter.publishTo[newsletter.list.toLowerCase()] ?? [];
}

/**
 * The web copy's Markdown: the issue body with `{{cta}}` as a plain link to
 * the set's first call to action (a page has no variants), or dropped.
 */
export function webBody(newsletter: Pick<Newsletter, "body" | "ctaSet">, settings = loadSettings()): string {
  const cta = newsletter.ctaSet ? settings.newsletter.ctaSets[newsletter.ctaSet]?.[0] : undefined;
  const link = cta ? `[${cta.label}](${cta.url})` : "";
  return newsletter.body
    .split(CTA_MARK)
    .join(link)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const externalIdForIssue = (id: string): string => `myna:newsletter:${id}`;

/** Publish one issue to its accounts. Throws only when the issue cannot be published at all. */
export async function publishNewsletter(id: string, options: PublishOptions = {}): Promise<PublishResult[]> {
  const now = options.now ?? new Date();
  const settings = loadSettings();
  const file = readNewsletters();
  const newsletter = file.newsletters.find((entry) => entry.id === id);
  if (!newsletter) throw new Error(`No newsletter "${id}". myna newsletter list shows them.`);
  const outAt = wentOutAt(newsletter, file);
  if (!outAt) throw new Error(`${id} has not gone out to anyone yet; it is published once it has.`);
  const targets = options.to?.length ? options.to : publishTargets(newsletter, settings);
  if (!targets.length)
    throw new Error(`Nowhere to publish ${id}: pass --to, or set newsletter.publishTo for the list "${newsletter.list}".`);

  const broadcast = options.broadcast ?? now.getTime() - Date.parse(outAt) < ARCHIVE_AFTER_MS;
  const results: PublishResult[] = [];
  for (const accountId of targets) {
    const earlier = newsletter.published?.[accountId];
    if (earlier?.ok && !options.force) {
      results.push({ account: accountId, ok: true, url: earlier.url, skipped: "already published" });
      continue;
    }
    const account = getAccount(accountId);
    if (!account) {
      results.push({ account: accountId, ok: false, error: `no account ${accountId}; myna accounts lists them` });
      continue;
    }
    const [result] = await postToAll([account], {
      title: newsletter.subject,
      text: webBody(newsletter, settings),
      // An issue's title repeats ("What shipped"); the idempotency key, not the title, names it.
      allowDuplicate: true,
      extra: {
        channel: "newsletter",
        externalId: externalIdForIssue(newsletter.id),
        broadcast: String(broadcast),
        // The web copy of a mailed issue is an archive page, not a launch: no paid ad.
        ad: "false",
      },
    });
    const copy: PublishedCopy = {
      at: now.toISOString(),
      ok: Boolean(result?.ok),
      attempts: (earlier?.attempts ?? 0) + 1,
      ...(result?.posts[0]?.url ? { url: result.posts[0].url } : {}),
      ...(result?.posts[0]?.id ? { postId: result.posts[0].id } : {}),
      ...(result?.ok ? {} : { error: result?.error ?? "not posted" }),
    };
    // Re-read: a send may have written deliveries while the post was in flight.
    const fresh = readNewsletters();
    const current = fresh.newsletters.find((entry) => entry.id === newsletter.id);
    if (current) {
      current.published = { ...current.published, [accountId]: copy };
      writeNewsletters(fresh);
    }
    newsletter.published = { ...newsletter.published, [accountId]: copy };
    results.push({ account: accountId, ok: copy.ok, url: copy.url, error: copy.error });
  }
  return results;
}

/**
 * The daemon's turn: every issue that has gone out and is still owed a web
 * copy somewhere gets one. Returns one line per post made or failed.
 */
export async function publishDueNewsletters(now = new Date()): Promise<string[]> {
  const settings = loadSettings();
  const file = readNewsletters();
  const lines: string[] = [];
  for (const newsletter of file.newsletters) {
    const owed = publishTargets(newsletter, settings).filter((accountId) => {
      const copy = newsletter.published?.[accountId];
      return !copy || (!copy.ok && copy.attempts < MAX_ATTEMPTS);
    });
    if (!owed.length || !wentOutAt(newsletter, file)) continue;
    const results = await publishNewsletter(newsletter.id, { to: owed, now });
    for (const result of results)
      lines.push(`${newsletter.id} → ${result.account}: ${result.ok ? (result.url ?? "published") : `failed (${result.error})`}`);
  }
  return lines;
}
