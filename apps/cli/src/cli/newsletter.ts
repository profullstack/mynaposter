/**
 * `myna newsletter`: issues to a contacts list, paced by the daily email cap,
 * with one-click unsubscribe and a postal address on every one.
 *
 *   myna newsletter create --subject "..." --list L [--at "tomorrow 9am"] [--smtp id] [--reply-to r] [--id slug] < issue.md
 *   myna newsletter list | show <id> [--body] | rm <id> [--force]
 *   myna newsletter edit <id> [--subject] [--list] [--at when | --draft] [--smtp] [--reply-to] [< issue.md]
 *   myna newsletter send <id> [--dry-run] [--test addr] [--limit N] [--retry-failed] [--retry-uncertain]
 *   myna newsletter subscribe <email...> --list L [--name] [--tags a,b]
 *   myna newsletter unsubscribe <email|token> [--list L]
 *   myna newsletter subscribers --list L [--json]
 *   myna newsletter import <file.csv|file.json> --list L [--tags a,b]
 *   myna newsletter sync          pull one-click unsubscribes from myna cloud
 *
 * Subscribers are contacts on a list, so `myna contacts` sees them too, and
 * `myna email --list` still mails the same list without any of this.
 */
import { readFileSync } from "node:fs";
import {
  createNewsletter,
  deliveriesFor,
  editNewsletter,
  loadSettings,
  parseWhen,
  readNewsletters,
  readSubscriberFile,
  removeNewsletter,
  requireNewsletter,
  sendNewsletter,
  subscribe,
  subscribers,
  syncUnsubscribes,
  tally,
  unsubscribe,
  type SubscribeResult,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";

type Flags = Record<string, unknown>;

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const list = (value: string | undefined): string[] => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** The body from stdin, or undefined when nothing is piped. */
function pipedBody(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  const body = readFileSync(0, "utf8");
  return body.trim() ? body : undefined;
}

const when = (value: string | undefined): string | undefined => (value ? parseWhen(value).at.toISOString() : undefined);

function reportSubscribe(result: SubscribeResult, listName: string): void {
  out(`${result.added.length} added to ${listName}${result.already.length ? `, ${result.already.length} already on it` : ""}.`);
  if (result.optedOut.length) out(`${result.optedOut.length} opted out before and stay out: ${result.optedOut.slice(0, 10).join(", ")}`);
  if (result.invalid.length) out(`${result.invalid.length} not an email address: ${result.invalid.slice(0, 10).join(", ")}`);
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
      if (!subject || !listName || !body) throw new Error('Usage: myna newsletter create --subject "..." --list <list> [--at when] [--smtp id] [--reply-to r] < issue.md');
      const created = createNewsletter({
        subject,
        body,
        list: listName,
        id: str(flags, "id"),
        scheduledFor: when(str(flags, "at")) ?? null,
        smtp: str(flags, "smtp") ?? null,
        replyTo: str(flags, "replyTo") ?? null,
        address: str(flags, "address") ?? null,
      });
      out(`Created ${created.id} (${created.status}${created.scheduledFor ? ` for ${created.scheduledFor}` : ""}) to ${created.list}.`);
      out(`Check it:  myna newsletter send ${created.id} --test you@example.com`);
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
      out(`List:      ${n.list} (${subscribers(n.list).filter((s) => s.active).length} can be mailed)`);
      if (n.scheduledFor) out(`Scheduled: ${n.scheduledFor}`);
      if (n.sentAt) out(`Sent:      ${n.sentAt}`);
      out(`Delivered: ${t.sent} sent, ${t.failed} failed, ${t.pending} uncertain`);
      if (n.smtp) out(`SMTP:      ${n.smtp}`);
      if (n.replyTo) out(`Reply-To:  ${n.replyTo}`);
      out(flags.body ? `\n${n.body}` : `Body:      ${n.body.length} chars of Markdown (--body prints it)`);
      return 0;
    }

    case "edit": {
      if (!rest[0]) throw new Error('Usage: myna newsletter edit <id> [--subject "..."] [--list L] [--at when | --draft] [< issue.md]');
      const edited = editNewsletter(rest[0], {
        subject: str(flags, "subject"),
        body: pipedBody(),
        list: str(flags, "list"),
        scheduledFor: when(str(flags, "at")),
        draft: Boolean(flags.draft),
        smtp: str(flags, "smtp"),
        replyTo: str(flags, "replyTo"),
        address: str(flags, "address"),
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
      if (!rest[0]) throw new Error("Usage: myna newsletter send <id> [--dry-run] [--test addr] [--limit N] [--retry-failed] [--retry-uncertain]");
      const report = await sendNewsletter(rest[0], {
        dryRun: Boolean(flags.dryRun),
        test: str(flags, "test"),
        limit: str(flags, "limit") ? Number(str(flags, "limit")) : undefined,
        retryFailed: Boolean(flags.retryFailed),
        retryUncertain: Boolean(flags.retryUncertain),
        log: (line) => out(line),
      });
      if (str(flags, "test")) {
        if (flags.dryRun) out(`would send a test copy of ${report.id} to ${str(flags, "test")}`);
        else if (report.sent.length) out(`Test copy of ${report.id} sent to ${report.sent[0]}.`);
        else out(`Test copy failed: ${report.failed[0]?.error}`);
        return report.failed.length ? 1 : 0;
      }
      if (flags.dryRun) {
        for (const to of report.wouldSend) out(`would email ${to}: ${report.subject}`);
      }
      out(
        `${report.id} to ${report.list}: ${report.audience} on the list, ${report.alreadySent} had it already, ` +
          `${flags.dryRun ? `${report.wouldSend.length} would go now` : `${report.sent.length} sent, ${report.failed.length} failed`}, ${report.remaining} left for a later run.`,
      );
      if (report.uncertain) out(`${report.uncertain} died mid-send last time and may have it; --retry-uncertain mails them again.`);
      if (report.previouslyFailed) out(`${report.previouslyFailed} were refused before; --retry-failed tries them again.`);
      if (!flags.dryRun) out(`Status: ${report.status}.`);
      return report.failed.length ? 1 : 0;
    }

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

    case "sync": {
      const result = await syncUnsubscribes();
      out(
        `${result.pulled} change${result.pulled === 1 ? "" : "s"} read: ${result.optedOut.length} newly unsubscribed, ${result.resubscribed.length} re-subscribed` +
          `${result.unknown ? `, ${result.unknown} for tokens this install never sent` : ""}.`,
      );
      return 0;
    }

    default:
      throw new Error(`Unknown: myna newsletter ${sub}. Try create, list, show, edit, rm, send, subscribe, unsubscribe, subscribers, import or sync.`);
  }
}
