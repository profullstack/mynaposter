/**
 * The newsletter in the TUI: a screen that shows the issues, the lists and
 * how the sends went, and `/newsletter` to drive them. The body of a new
 * issue is whatever is in the compose box, so an issue is written in the same
 * editor as a post.
 *
 *   /newsletter                          the screen
 *   /newsletter new <list> <subject>     an issue from the compose box
 *   /newsletter dry <id>                 who it would reach now
 *   /newsletter test <id> <you@x>        one [test] copy
 *   /newsletter send <id>                to the list, after a yes
 *   /newsletter schedule <id> <when>     the daemon sends it
 *   /newsletter stats <id>               per variant, from crawlproof
 *   /newsletter subscribe <list> <email...> | unsubscribe <email> | import <list> <file>
 *   /newsletter rm <id>
 */
import type { Container, Theme } from "@profullstack/hqtui";
import {
  createNewsletter,
  editNewsletter,
  fetchNewsletterStats,
  loadSettings,
  newsletterTracking,
  readContacts,
  readNewsletters,
  readSubscriberFile,
  removeNewsletter,
  requireNewsletter,
  sendNewsletter,
  subscribe,
  subscribers,
  tally,
  unsubscribe,
} from "@profullstack/myna-core";
import { toast, type State } from "./state.ts";
import { parseWhen, describeWhen } from "./when.ts";

/** What the last newsletter command said, shown under the issues. */
let lastLines: string[] = [];

const say = (lines: string[]): void => {
  lastLines = lines.slice(-12);
};

export function newsletterScreen(ui: Container, _state: State, theme: Theme): void {
  const file = readNewsletters();
  const settings = loadSettings();
  const rows = file.newsletters.map((n) => {
    const t = tally(n.id, file);
    return {
      id: n.id,
      status: n.status,
      list: n.list,
      ab: n.subjectB ? "A/B" : "",
      sent: `${t.sent}${t.failed ? ` +${t.failed}!` : ""}`,
      when: (n.sentAt ?? n.scheduledFor ?? "").slice(0, 16).replace("T", " "),
      subject: n.subject,
    };
  });
  ui.panel({ title: `Newsletters (${rows.length})`, size: Math.max(rows.length, 1) + 5 }, (panel) => {
    if (!rows.length) panel.label("No issues yet. Write one in the compose box, then /newsletter new <list> <subject>", { size: 1, fg: theme.muted });
    else
      panel.table({
        rows,
        columns: [
          { key: "id", title: "Id", width: 22 },
          { key: "status", title: "Status", width: 10 },
          { key: "list", title: "List", width: 14 },
          { key: "ab", title: "", width: 4 },
          { key: "sent", title: "Sent", width: 8 },
          { key: "when", title: "When (UTC)", width: 17 },
          { key: "subject", title: "Subject" },
        ],
      });
    panel.spacer(1);
    const tracking = newsletterTracking();
    const address = settings.newsletter.address;
    panel.label(
      `Tracking: ${tracking ? `crawlproof ${tracking.id}` : "off"}   Address: ${address ? "set" : "NOT SET (myna config newsletter.address)"}`,
      { size: 1, fg: address ? theme.muted : theme.warning },
    );
  });

  const lists = Object.keys(readContacts().lists);
  ui.panel({ title: `Lists (${lists.length})`, size: Math.max(lists.length, 1) + 3 }, (panel) => {
    if (!lists.length) {
      panel.label("No lists. /newsletter subscribe <list> <email...>", { size: 1, fg: theme.muted });
      return;
    }
    panel.table({
      rows: lists.map((name) => {
        const people = subscribers(name);
        return { list: name, active: String(people.filter((p) => p.active).length), out: String(people.filter((p) => !p.active).length) };
      }),
      columns: [
        { key: "list", title: "List", width: 24 },
        { key: "active", title: "Can be mailed", width: 14 },
        { key: "out", title: "Unsubscribed / no email" },
      ],
    });
  });

  ui.panel({ title: "Last command", size: "1fr" }, (panel) => {
    if (!lastLines.length) {
      panel.label("/newsletter dry <id> first, then test, then send.", { size: 1, fg: theme.muted });
      return;
    }
    for (const line of lastLines) panel.label(line, { size: 1 });
  });
}

/** `/newsletter …`. Returns nothing; results land on the screen and in a toast. */
export async function runNewsletterCommand(state: State, args: string, redraw: () => void): Promise<void> {
  state.screen = "newsletter";
  const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
    say(lines);
    redraw();
  };
  switch (sub) {
    case "":
    case "list":
      return;
    case "new":
    case "create": {
      const [list, ...subjectWords] = rest;
      const body = state.compose.value;
      if (!list || !subjectWords.length) throw new Error("Usage: /newsletter new <list> <subject>   (the body is the compose box)");
      if (!body.trim()) throw new Error("The compose box is empty. Write the issue there first.");
      const created = createNewsletter({ subject: subjectWords.join(" "), body, list });
      say([`Created ${created.id} to ${created.list}. Next: /newsletter dry ${created.id}`]);
      toast(state, `Created ${created.id}`, "success");
      return;
    }
    case "dry": {
      const report = await sendNewsletter(requireId(rest), { dryRun: true, log });
      log(`${report.audience} on ${report.list}, ${report.alreadySent} had it, ${report.wouldSend.length} would go now, ${report.remaining} later.`);
      return;
    }
    case "test": {
      const [id, to] = rest;
      if (!id || !to) throw new Error("Usage: /newsletter test <id> <you@example.com>");
      state.busy = `Sending a test copy to ${to}…`;
      try {
        const report = await sendNewsletter(id, { test: to, log });
        if (report.failed.length) throw new Error(report.failed[0]?.error ?? "The test copy failed.");
        toast(state, `Test copy sent to ${to}`, "success");
      } finally {
        state.busy = "";
      }
      return;
    }
    case "send": {
      const id = requireId(rest);
      const newsletter = requireNewsletter(id);
      const dry = await sendNewsletter(newsletter.id, { dryRun: true });
      state.confirm = {
        title: `Send ${newsletter.id}?`,
        message: `"${newsletter.subject}" to ${dry.wouldSend.length} on ${newsletter.list} now${dry.remaining ? `, ${dry.remaining} left for later runs (daily cap)` : ""}. ${dry.alreadySent} already have it and are skipped.`,
        onYes: () => {
          state.busy = `Sending ${newsletter.id}…`;
          redraw();
          const pace = loadSettings().newsletter.paceMs;
          void sendNewsletter(newsletter.id, { log, paceMs: pace })
            .then((report) => {
              log(`${report.sent.length} sent, ${report.failed.length} failed, ${report.remaining} left. Status: ${report.status}.`);
              toast(state, `${report.id}: ${report.sent.length} sent`, report.failed.length ? "error" : "success");
            })
            .catch((error: Error) => toast(state, error.message, "error"))
            .finally(() => {
              state.busy = "";
              redraw();
            });
        },
      };
      state.mode = "confirm";
      return;
    }
    case "schedule": {
      const [id, ...when] = rest;
      if (!id || !when.length) throw new Error("Usage: /newsletter schedule <id> <when>   e.g. friday 9am");
      const at = parseWhen(when.join(" ")).at;
      const edited = editNewsletter(id, { scheduledFor: at.toISOString() });
      say([`${edited.id} is scheduled for ${describeWhen(at)}. The daemon (myna run) sends it.`]);
      toast(state, `Scheduled ${edited.id}`, "success");
      return;
    }
    case "stats": {
      const id = requireId(rest);
      const tracking = newsletterTracking();
      if (!tracking) throw new Error("Tracking is off. myna newsletter track set <id>");
      state.busy = "Reading crawlproof…";
      try {
        const stats = await fetchNewsletterStats(id, tracking);
        say([
          "Variant  Sent  Opens  Clicks  CTR     Unsubs",
          ...stats.rows.map((r) => `${r.variant.padEnd(8)} ${String(r.sent).padEnd(5)} ${String(r.opens).padEnd(6)} ${String(r.clicks).padEnd(7)} ${(r.ctr * 100).toFixed(1).padStart(5)}%  ${r.unsubscribes}`),
          stats.leader ? `Leader: ${stats.leader} (by ${stats.basis})` : "No leader yet.",
        ]);
      } finally {
        state.busy = "";
      }
      return;
    }
    case "subscribe": {
      const [list, ...emails] = rest;
      if (!list || !emails.length) throw new Error("Usage: /newsletter subscribe <list> <email...>");
      const result = subscribe(list, emails.map((email) => ({ email })), `newsletter:${list}`);
      say([`${result.added.length} added to ${list}, ${result.already.length} already on it, ${result.optedOut.length} opted out before (stay out), ${result.invalid.length} not an address.`]);
      return;
    }
    case "import": {
      const [list, path] = rest;
      if (!list || !path) throw new Error("Usage: /newsletter import <list> <file.csv|file.json>");
      const result = subscribe(list, readSubscriberFile(path), `import:${path.split("/").pop()}`);
      say([`${result.added.length} added to ${list}, ${result.already.length} already on it, ${result.optedOut.length} opted out, ${result.invalid.length} invalid.`]);
      return;
    }
    case "unsubscribe": {
      const [who, list] = rest;
      if (!who) throw new Error("Usage: /newsletter unsubscribe <email> [list]");
      const result = unsubscribe(who, { list });
      say([result ? (result.permanent ? `${result.id} is opted out for good.` : `${result.id} is off ${list}.`) : `No subscriber ${who}.`]);
      return;
    }
    case "rm": {
      const id = requireId(rest);
      state.confirm = {
        title: `Remove ${id}?`,
        message: "Its delivery ledger goes with it.",
        onYes: () => {
          try {
            removeNewsletter(id, { force: true });
            toast(state, `Removed ${id}`, "success");
          } catch (error) {
            toast(state, (error as Error).message, "error");
          }
          redraw();
        },
      };
      state.mode = "confirm";
      return;
    }
    default:
      throw new Error(`Unknown: /newsletter ${sub}. Try new, dry, test, send, schedule, stats, subscribe, import, unsubscribe or rm.`);
  }
}

function requireId(rest: string[]): string {
  if (!rest[0]) throw new Error("Which issue? /newsletter shows the ids.");
  return rest[0];
}
