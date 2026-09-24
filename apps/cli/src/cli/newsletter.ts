/**
 * `myna newsletter`: issues to a contacts list, paced by the daily email cap,
 * with one-click unsubscribe and a postal address on every one.
 *
 *   myna newsletter create --subject "..." [--subject-b "..."] --list L [--cta-set default|none] [--service moshcode]
 *        [--at "tomorrow 9am"] [--via provider] [--reply-to r] [--id slug] < issue.md
 *   myna newsletter list | show <id> [--body] | rm <id> [--force]
 *   myna newsletter edit <id> [--subject] [--subject-b] [--list] [--cta-set] [--service] [--at when | --draft] [--via] [--reply-to] [< issue.md]
 *   myna newsletter send <id> [--dry-run] [--to addr] [--yes] [--via provider] [--limit N] [--max-per-day N] [--pace-ms N] [--retry-failed] [--retry-uncertain]
 *   myna newsletter send <id> --yes --background     the list send, detached (same as blast --go)
 *   myna newsletter blast <issue.md> --csv F --list L --id slug --subject "A" [...]   import, create, one test copy, then stop
 *   myna newsletter blast --go <id> [--max-per-day N]   the list send, detached, logged under the state dir
 *   myna newsletter status <id> [--watch]            sent, failed, remaining, rate, ETA, per variant
 *
 * --via names a mail provider (`myna mail provider list`): an SMTP server, an
 * HTTP API such as Resend or Postmark, or myna cloud. --smtp is its old name.
 *   myna newsletter subscribe <email...> --list L [--name] [--tags a,b]
 *   myna newsletter unsubscribe <email|token> [--list L]
 *   myna newsletter subscribers --list L [--json]
 *   myna newsletter import <file.csv|file.json> --list L [--tags a,b]
 *   myna newsletter sync | sync-optouts     pull unsubscribes from myna cloud and crawlproof
 *   myna newsletter track set <trackingId> [--secret <hex>] | track status [--check] | track off
 *   myna newsletter stats <id> [--json]     opens, clicks, CTR, unsubscribes per variant
 *   myna newsletter cta list | add "<label>" <url> | rm "<label>"   [--set default]
 *
 * Subscribers are contacts on a list, so `myna contacts` sees them too, and
 * `myna email --list` still mails the same list without any of this.
 *
 * An issue with --subject-b and/or a CTA set is an A/B test: the variants are
 * the subjects crossed with the set's calls to action, one per person, fixed
 * by a hash of the issue id and the address. With tracking set up, links are
 * signed crawlproof click URLs, the HTML carries an open pixel, and the
 * unsubscribe link is crawlproof's signed one.
 */
import { readFileSync } from "node:fs";
import {
  connectTracking,
  TRACKING_ID,
  TRACKING_SECRETS,
  createNewsletter,
  deliveriesFor,
  editNewsletter,
  fetchNewsletterStats,
  fetchTrackingEvents,
  getPluginSecrets,
  loadSettings,
  newsletterTracking,
  parseWhen,
  readNewsletters,
  readSubscriberFile,
  removeNewsletter,
  requireNewsletter,
  saveSettings,
  sendNewsletter,
  setPluginSecrets,
  subscribe,
  subscribers,
  syncAllUnsubscribes,
  tally,
  trackingBase,
  unsubscribe,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";
import { ctaSetFlag, list, num, printVariants, reportSubscribe, str, type Flags } from "./newsletter-flags.ts";
import { runBlast, runGo, runSendWorker, runStatus } from "./newsletter-blast.ts";
import { askSecret } from "./prompt.ts";

/** The body from stdin, or undefined when nothing is piped. */
function pipedBody(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  const body = readFileSync(0, "utf8");
  return body.trim() ? body : undefined;
}

const when = (value: string | undefined): string | undefined => (value ? parseWhen(value).at.toISOString() : undefined);

async function runTrack(rest: string[], flags: Flags): Promise<number> {
  const [sub, id] = rest;
  const settings = loadSettings();
  if (sub === "set") {
    if (!id || !TRACKING_ID.test(id.trim()))
      throw new Error("Usage: myna newsletter track set <trackingId> [--secret <hex>]   (the id is 24 hex, from the project's Tracking tab on crawlproof.com; pass --secret or pipe the secret in)");
    const secret = (str(flags, "secret") ?? (process.stdin.isTTY ? await askSecret("Tracking secret") : readFileSync(0, "utf8"))).trim();
    if (!/^[0-9a-f]{32,}$/i.test(secret)) throw new Error("The tracking secret is hex, from crawlproof.com. Nothing was saved.");
    settings.newsletter.trackingId = id.trim().toLowerCase();
    saveSettings(settings);
    setPluginSecrets(TRACKING_SECRETS, { ...getPluginSecrets(TRACKING_SECRETS), trackingSecret: secret });
    out(`Tracking through ${trackingBase({ id: settings.newsletter.trackingId, host: settings.newsletter.trackingHost })}. The secret is in the vault.`);
    out("Every issue's links, open pixel and unsubscribe link now go through it.");
    return 0;
  }
  if (sub === "connect") {
    if (!id) throw new Error("Usage: myna newsletter track connect <site>   (a CrawlProof project, e.g. moshcode.sh; needs myna crawlproof login)");
    const connected = await connectTracking(id);
    out(`Tracking through ${trackingBase({ id: connected.trackingId, host: connected.host })} for ${connected.site}${connected.enabled ? " (switched on just now)" : ""}. The secret is in the vault.`);
    out("Every issue's links, open pixel and unsubscribe link now go through it.");
    return 0;
  }
  if (sub === "off") {
    settings.newsletter.trackingId = "";
    saveSettings(settings);
    const secrets = getPluginSecrets(TRACKING_SECRETS);
    delete secrets.trackingSecret;
    setPluginSecrets(TRACKING_SECRETS, secrets);
    out("Tracking is off. Issues use the myna cloud (or newsletter.unsubscribeUrl) unsubscribe link again.");
    return 0;
  }
  if (sub === "status" || sub === undefined) {
    const n = settings.newsletter;
    const tracking = newsletterTracking();
    out(`tracking     ${n.trackingId ? trackingBase({ id: n.trackingId, host: n.trackingHost }) : "off  (myna newsletter track set <trackingId>)"}`);
    out(`secret       ${getPluginSecrets(TRACKING_SECRETS).trackingSecret ? "in the vault" : "missing"}`);
    out(`unsubscribe  ${tracking ? "crawlproof's signed link" : n.unsubscribeUrl || "myna cloud (needs myna cloud login)"}`);
    out(`address      ${n.address || 'not set, nothing is sent  (myna config newsletter.address "Company, street, city, country")'}`);
    out(`pace         ${n.paceMs} ms between messages`);
    out(`opt-outs     crawlproof pulled up to ${readNewsletters().trackingSince ?? "never"}`);
    if (flags.check) {
      if (!tracking) throw new Error("Nothing to check: tracking is not set.");
      const events = await fetchTrackingEvents(tracking, { since: new Date(Date.now() - 86_400_000).toISOString() });
      out(`check        crawlproof answered: ${events.length} event(s) in the last day`);
    }
    return 0;
  }
  throw new Error(`Unknown: myna newsletter track ${sub}. Try connect, set, status or off.`);
}

function runCta(rest: string[], flags: Flags): number {
  const [sub, label, url] = rest;
  const settings = loadSettings();
  const setName = str(flags, "set") ?? "default";
  const sets = settings.newsletter.ctaSets;
  switch (sub ?? "list") {
    case "list": {
      const names = str(flags, "set") ? [setName] : Object.keys(sets);
      for (const name of names) {
        out(`${name}:`);
        const ctas = sets[name] ?? [];
        if (!ctas.length) out("  (empty)");
        ctas.forEach((cta, i) => out(`  ${i + 1}. ${cta.label.padEnd(22)} ${cta.url}`));
      }
      return 0;
    }
    case "add": {
      if (!label || !url || !/^https?:\/\//.test(url)) throw new Error('Usage: myna newsletter cta add "<label>" <https://url> [--set default]');
      const ctas = (sets[setName] ?? []).filter((cta) => cta.label.toLowerCase() !== label.toLowerCase());
      ctas.push({ label, url });
      sets[setName] = ctas;
      saveSettings(settings);
      out(`${setName} now has ${ctas.length} call(s) to action.`);
      return 0;
    }
    case "rm": {
      if (!label) throw new Error('Usage: myna newsletter cta rm "<label>" [--set default]');
      const before = sets[setName] ?? [];
      const after = before.filter((cta, i) => cta.label.toLowerCase() !== label.toLowerCase() && String(i + 1) !== label);
      if (after.length === before.length) throw new Error(`No "${label}" in ${setName}.`);
      sets[setName] = after;
      saveSettings(settings);
      out(`Removed. ${setName} has ${after.length} left.`);
      return 0;
    }
    default:
      throw new Error(`Unknown: myna newsletter cta ${sub}. Try list, add or rm.`);
  }
}

async function runStats(id: string | undefined, flags: Flags): Promise<number> {
  if (!id) throw new Error("Usage: myna newsletter stats <id> [--json]");
  const tracking = newsletterTracking();
  if (!tracking) throw new Error("Tracking is not set, so there is nothing to count. myna newsletter track set <trackingId>");
  const stats = await fetchNewsletterStats(id, tracking);
  if (flags.json) {
    out(JSON.stringify(stats, null, 2));
    return 0;
  }
  if (!stats.rows.length) {
    out(`Nothing sent for ${stats.id} yet.`);
    return 0;
  }
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  table(
    stats.rows.map((row) => ({
      variant: row.variant,
      subject: row.subjectKey,
      cta: row.cta,
      sent: String(row.sent),
      opens: `${row.opens} (${row.opensTotal})`,
      clicks: String(row.clicks),
      ctr: pct(row.ctr),
      unsub: String(row.unsubscribes),
    })),
    [
      { key: "variant", title: "Variant" },
      { key: "subject", title: "Subject" },
      { key: "cta", title: "CTA" },
      { key: "sent", title: "Sent" },
      { key: "opens", title: "Opens (all)" },
      { key: "clicks", title: "Clicks" },
      { key: "ctr", title: "CTR" },
      { key: "unsub", title: "Unsubs" },
    ],
  );
  out("");
  out("Opens and clicks count unique messages, with machine-flagged ones left out; the number in brackets counts every open.");
  out(stats.leader ? `Leader: ${stats.leader} (by ${stats.basis === "clicks" ? "click-through rate" : "open rate, no clicks yet"}).` : "No leader yet: no opens or clicks.");
  return 0;
}

export async function runNewsletter(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  switch (sub ?? "list") {
    case "list":
    case "ls": {
      const file = readNewsletters();
      if (flags.json) {
        out(JSON.stringify(file.newsletters.map((n) => ({ ...n, body: undefined, deliveries: tally(n.id, file) })), null, 2));
        return 0;
      }
      if (!file.newsletters.length) {
        out('No newsletters yet.  myna newsletter create --subject "..." --list <list> < issue.md');
        return 0;
      }
      table(
        file.newsletters.map((n) => {
          const t = tally(n.id, file);
          return {
            id: n.id,
            status: n.status,
            list: n.list,
            when: n.sentAt?.slice(0, 16).replace("T", " ") ?? n.scheduledFor?.slice(0, 16).replace("T", " ") ?? "",
            sent: `${t.sent}${t.failed ? ` +${t.failed} failed` : ""}`,
            subject: n.subject,
          };
        }),
        [
          { key: "id", title: "Id" },
          { key: "status", title: "Status" },
          { key: "list", title: "List" },
          { key: "when", title: "When (UTC)" },
          { key: "sent", title: "Sent" },
          { key: "subject", title: "Subject" },
        ],
      );
      return 0;
    }

    case "create":
    case "new": {
      const subject = str(flags, "subject");
      const listName = str(flags, "list");
      const body = pipedBody();
      if (!subject || !listName || !body)
        throw new Error(
          'Usage: myna newsletter create --subject "..." [--subject-b "..."] --list <list> [--cta-set default|none] [--service moshcode] [--at when] [--via provider] [--reply-to r] [--id slug] < issue.md',
        );
      const created = createNewsletter({
        subject,
        body,
        list: listName,
        id: str(flags, "id"),
        scheduledFor: when(str(flags, "at")) ?? null,
        smtp: str(flags, "via") ?? str(flags, "smtp") ?? null,
        replyTo: str(flags, "replyTo") ?? null,
        address: str(flags, "address") ?? null,
        subjectB: str(flags, "subjectB") ?? null,
        ctaSet: ctaSetFlag(flags, "default") ?? null,
        service: str(flags, "service") ?? null,
      });
      out(`Created ${created.id} (${created.status}${created.scheduledFor ? ` for ${created.scheduledFor}` : ""}) to ${created.list}.`);
      if (created.subjectB || created.ctaSet) {
        const ctas = created.ctaSet ? (loadSettings().newsletter.ctaSets[created.ctaSet]?.length ?? 1) : 1;
        out(`A/B test: ${(created.subjectB ? 2 : 1) * ctas} variant(s)${created.ctaSet ? `, calls to action from "${created.ctaSet}"` : ""}.`);
      }
      out(`Check it:  myna newsletter send ${created.id} --to you@example.com`);
      if (!loadSettings().newsletter.address && !created.address) out('Before it can go out:  myna config newsletter.address "Company, 1 Main St, City, ST 00000, USA"');
      return 0;
    }

    case "show": {
      if (!rest[0]) throw new Error("Usage: myna newsletter show <id> [--body]");
      const file = readNewsletters();
      const n = requireNewsletter(rest[0], file);
      if (flags.json) {
        out(JSON.stringify({ ...n, deliveries: deliveriesFor(n.id, file) }, null, 2));
        return 0;
      }
      const t = tally(n.id, file);
      out(`${n.id}  ${n.status}`);
      out(`Subject:   ${n.subject}`);
      if (n.subjectB) out(`Subject B: ${n.subjectB}`);
      out(`List:      ${n.list} (${subscribers(n.list).filter((s) => s.active).length} can be mailed)`);
      if (n.ctaSet) out(`CTA set:   ${n.ctaSet}`);
      if (n.service) out(`Service:   ${n.service} (the footer says they have an account there)`);
      if (n.scheduledFor) out(`Scheduled: ${n.scheduledFor}`);
      if (n.sentAt) out(`Sent:      ${n.sentAt}`);
      out(`Delivered: ${t.sent} sent, ${t.failed} failed, ${t.pending} uncertain`);
      if (n.smtp) out(`Via:       ${n.smtp}`);
      if (n.replyTo) out(`Reply-To:  ${n.replyTo}`);
      out(flags.body ? `\n${n.body}` : `Body:      ${n.body.length} chars of Markdown (--body prints it)`);
      return 0;
    }

    case "edit": {
      if (!rest[0]) throw new Error('Usage: myna newsletter edit <id> [--subject "..."] [--subject-b "..."] [--list L] [--cta-set name|none] [--service s] [--at when | --draft] [< issue.md]');
      const edited = editNewsletter(rest[0], {
        subject: str(flags, "subject"),
        body: pipedBody(),
        list: str(flags, "list"),
        scheduledFor: when(str(flags, "at")),
        draft: Boolean(flags.draft),
        smtp: str(flags, "via") ?? str(flags, "smtp"),
        replyTo: str(flags, "replyTo"),
        address: str(flags, "address"),
        subjectB: str(flags, "subjectB"),
        ctaSet: ctaSetFlag(flags, undefined),
        service: str(flags, "service"),
      });
      out(`Saved ${edited.id} (${edited.status}${edited.scheduledFor ? ` for ${edited.scheduledFor}` : ""}).`);
      return 0;
    }

    case "rm":
    case "delete": {
      if (!rest[0]) throw new Error("Usage: myna newsletter rm <id> [--force]");
      out(removeNewsletter(rest[0], { force: Boolean(flags.force) }) ? `Removed ${rest[0]}.` : `No newsletter ${rest[0]}.`);
      return 0;
    }

    case "send": {
      if (!rest[0]) throw new Error("Usage: myna newsletter send <id> [--dry-run] [--to addr] [--yes] [--via provider] [--limit N] [--max-per-day N] [--retry-failed] [--retry-uncertain]");
      const test = str(flags, "to") ?? str(flags, "test");
      const dryRun = Boolean(flags.dryRun);
      if (flags.background) {
        if (test || dryRun) throw new Error("--background is for the list send; a test copy or a dry run is quick enough to run here.");
        if (!flags.yes) throw new Error(`--background sends to the whole list, so it needs --yes too: myna newsletter send ${rest[0]} --yes --background`);
        return await runGo(rest[0], flags);
      }
      const common = {
        limit: num(flags, "limit"),
        maxPerDay: num(flags, "maxPerDay"),
        paceMs: num(flags, "paceMs") ?? loadSettings().newsletter.paceMs,
        retryFailed: Boolean(flags.retryFailed),
        retryUncertain: Boolean(flags.retryUncertain),
        via: str(flags, "via") ?? str(flags, "smtp"),
        log: (line: string) => out(line),
      };
      // A list send needs --yes. Without it: the numbers, and nothing sent.
      if (!test && !dryRun && !flags.yes) {
        const preview = await sendNewsletter(rest[0], { ...common, dryRun: true });
        out(`${preview.id} to ${preview.list}: ${preview.audience} on the list, ${preview.alreadySent} had it already, ${preview.wouldSend.length} would go now, ${preview.remaining} left for a later run.`);
        printVariants(preview);
        out(`Tracking: ${preview.tracked ? "on (crawlproof)" : "off"}.`);
        out(`Not sent. Send yourself a copy with --to you@example.com, then add --yes to send to the list.`);
        return 1;
      }
      const report = await sendNewsletter(rest[0], { ...common, dryRun, test });
      if (test) {
        if (dryRun) out(`would send a test copy of ${report.id} to ${test}`);
        else if (report.sent.length) out(`Test copy of ${report.id} sent to ${report.sent[0]}.`);
        else out(`Test copy failed: ${report.failed[0]?.error}`);
        return report.failed.length ? 1 : 0;
      }
      if (dryRun) {
        for (const to of report.wouldSend.slice(0, 20)) out(`would email ${to}`);
        if (report.wouldSend.length > 20) out(`... and ${report.wouldSend.length - 20} more`);
        printVariants(report);
        out(`Tracking: ${report.tracked ? "on (crawlproof)" : "off"}.`);
      }
      out(
        `${report.id} to ${report.list}: ${report.audience} on the list, ${report.alreadySent} had it already, ` +
          `${dryRun ? `${report.wouldSend.length} would go now` : `${report.sent.length} sent, ${report.failed.length} failed`}, ${report.remaining} left for a later run.`,
      );
      if (report.uncertain) out(`${report.uncertain} died mid-send last time and may have it; --retry-uncertain mails them again.`);
      if (report.previouslyFailed) out(`${report.previouslyFailed} were refused before; --retry-failed tries them again.`);
      if (report.retrying) out(`${report.retrying} hit a retryable error last time (rate limit or outage) and were tried again.`);
      if (report.via && !dryRun) out(`Via: ${report.via}.`);
      if (!dryRun) out(`Status: ${report.status}.${report.remaining ? " Run the same command again to carry on." : ""}`);
      return report.failed.length ? 1 : 0;
    }

    case "blast":
      return await runBlast(rest, flags);

    case "status":
      return await runStatus(rest[0], flags);

    // The detached child `blast --go` and `send --background` start. Not in the help.
    case "_run":
      return await runSendWorker(rest[0], flags);

    case "stats":
      return await runStats(rest[0] ?? str(flags, "campaign"), flags);

    case "track":
      return await runTrack(rest, flags);

    case "cta":
    case "ctas":
      return runCta(rest, flags);

    case "subscribe":
    case "sub": {
      const listName = str(flags, "list");
      if (!listName || !rest.length) throw new Error('Usage: myna newsletter subscribe <email...> --list <list> [--name "..."] [--tags a,b]');
      const name = rest.length === 1 ? (str(flags, "name") ?? null) : null;
      reportSubscribe(subscribe(listName, rest.map((email) => ({ email, name, tags: list(str(flags, "tags")) })), `newsletter:${listName}`), listName);
      return 0;
    }

    case "unsubscribe":
    case "unsub": {
      if (!rest[0]) throw new Error("Usage: myna newsletter unsubscribe <email|token> [--list L]");
      const listName = str(flags, "list");
      const result = unsubscribe(rest[0], { list: listName });
      if (!result) out(`No subscriber ${rest[0]}.`);
      else if (result.permanent) out(`${result.id} is opted out for good: no list, newsletter or email reaches them again.`);
      else out(`${result.id} is off ${listName}.`);
      return result ? 0 : 1;
    }

    case "subscribers": {
      const listName = str(flags, "list") ?? rest[0];
      if (!listName) throw new Error("Usage: myna newsletter subscribers --list <list>");
      const rows = subscribers(listName);
      if (flags.json) {
        out(JSON.stringify(rows.map((row) => ({ ...row.contact, active: row.active })), null, 2));
        return 0;
      }
      if (!rows.length) {
        out(`Nobody on ${listName}.  myna newsletter subscribe <email> --list ${listName}`);
        return 0;
      }
      table(
        rows.map((row) => ({ email: row.contact.email ?? row.contact.id, name: row.contact.name ?? "", added: row.contact.addedAt.slice(0, 10), state: row.active ? "" : row.contact.optedOut ? "unsubscribed" : "no email" })),
        [
          { key: "email", title: "Email" },
          { key: "name", title: "Name" },
          { key: "added", title: "Added" },
          { key: "state", title: "" },
        ],
      );
      out(`${rows.filter((row) => row.active).length} of ${rows.length} can be mailed.`);
      return 0;
    }

    case "import": {
      const path = rest[0];
      const listName = str(flags, "list");
      if (!path || !listName) throw new Error("Usage: myna newsletter import <file.csv|file.json> --list <list> [--tags a,b]");
      const people = readSubscriberFile(path).map((person) => ({ ...person, tags: [...(person.tags ?? []), ...list(str(flags, "tags"))] }));
      reportSubscribe(subscribe(listName, people, `import:${path.split("/").pop()}`), listName);
      return 0;
    }

    case "sync":
    case "sync-optouts": {
      const result = await syncAllUnsubscribes();
      const cloud = result.cloud;
      const failed = (source: string): string | undefined => result.errors.find((line) => line.startsWith(source));
      if (failed("myna cloud")) out(`myna cloud: FAILED, ${failed("myna cloud")}`);
      else
        out(
          `myna cloud: ${cloud.pulled} change${cloud.pulled === 1 ? "" : "s"} read: ${cloud.optedOut.length} newly unsubscribed, ${cloud.resubscribed.length} re-subscribed` +
            `${cloud.unknown ? `, ${cloud.unknown} for tokens this install never sent` : ""}.`,
        );
      if (failed("crawlproof")) out(`crawlproof: FAILED, ${failed("crawlproof")}`);
      else if (result.tracking)
        out(`crawlproof: ${result.tracking.pulled} unsubscribe${result.tracking.pulled === 1 ? "" : "s"} read, ${result.tracking.optedOut.length} newly opted out${result.tracking.optedOut.length ? `: ${result.tracking.optedOut.join(", ")}` : ""}.`);
      else out("crawlproof: tracking is off.");
      if (result.errors.length) {
        out(`Could not read unsubscribes from ${result.errors.join(" or ")}. Sends stay stopped until this works.`);
        return 1;
      }
      return 0;
    }

    default:
      throw new Error(`Unknown: myna newsletter ${sub}. Try blast, status, create, list, show, edit, rm, send, stats, subscribe, unsubscribe, subscribers, import, sync, track or cta.`);
  }
}
