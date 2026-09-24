/**
 * `myna newsletter blast`: the whole send in two short commands, and a way to
 * watch it.
 *
 *   myna newsletter blast issue.md --csv users.csv --list L --id slug --subject "A" [--subject-b "B"]
 *        [--service s] [--cta-set name] [--via id] [--reply-to r] [--tags t] [--test-to addr]
 *        [--max-per-day N] [--clean]
 *     imports the CSV, creates the issue (or updates its draft), sends ONE test
 *     copy, prints who would get it and how the variants split, and stops.
 *
 *   myna newsletter blast --go <id> [--max-per-day N]      (or: send <id> --yes --background)
 *     starts the list send as a detached process, so the terminal comes back at
 *     once; it logs to the state dir and holds the issue's send lock.
 *
 *   myna newsletter status <id> [--watch]
 *     sent, failed, remaining, rate, ETA, whether the background send runs.
 *
 * Nothing here sends by itself: it drives the same sendNewsletter and ledger
 * as `myna newsletter send`, so a rerun resumes and nobody gets it twice.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename } from "node:path";
import {
  activePassphrase,
  acquireSendLock,
  addressOf,
  cleanSubscriberCsv,
  createNewsletter,
  editNewsletter,
  ensureStateDir,
  formatDuration,
  liveSendLock,
  loadSettings,
  readNewsletters,
  readSendLock,
  readSubscriberFile,
  releaseSendLock,
  requireNewsletter,
  resolveSender,
  sendLogPath,
  sendNewsletter,
  sendProgress,
  slugify,
  subscribe,
  subscribers,
  tailLines,
  tally,
  updateSendLock,
  SendLockedError,
  type Newsletter,
  type SendNewsletterOptions,
  type SendProgress,
  type SubscriberInput,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";
import { ctaSetFlag, list, num, printVariants, reportSubscribe, str, type Flags } from "./newsletter-flags.ts";

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

const BLAST_USAGE =
  'Usage: myna newsletter blast <issue.md> --list <L> --id <slug> --subject "..." [--csv users.csv] [--subject-b "..."] [--service s] ' +
  "[--cta-set name|none] [--via id] [--reply-to r] [--tags a,b] [--test-to addr] [--max-per-day N] [--clean]\n" +
  "       myna newsletter blast --go <id> [--max-per-day N]";

/** What a CLI send passes down, from the flags both `blast --go` and the worker read. */
function sendOptions(flags: Flags): Pick<SendNewsletterOptions, "limit" | "maxPerDay" | "paceMs" | "retryFailed" | "retryUncertain" | "via"> {
  return {
    limit: num(flags, "limit"),
    maxPerDay: num(flags, "maxPerDay"),
    paceMs: num(flags, "paceMs") ?? loadSettings().newsletter.paceMs,
    retryFailed: Boolean(flags.retryFailed),
    retryUncertain: Boolean(flags.retryUncertain),
    via: str(flags, "via") ?? str(flags, "smtp"),
  };
}

/** The flags handed on to the background child, as argv. */
function passthrough(flags: Flags): string[] {
  const args: string[] = [];
  for (const [flag, key] of [
    ["--max-per-day", "maxPerDay"],
    ["--limit", "limit"],
    ["--pace-ms", "paceMs"],
    ["--via", "via"],
    ["--smtp", "smtp"],
  ] as const) {
    const value = str(flags, key);
    if (value !== undefined) args.push(flag, value);
  }
  if (flags.retryFailed) args.push("--retry-failed");
  if (flags.retryUncertain) args.push("--retry-uncertain");
  return args;
}

function goCommand(id: string, flags: Flags): string {
  // --via is saved on the issue, so only the per-run caps travel.
  const args = ["myna newsletter blast --go", id];
  if (str(flags, "maxPerDay")) args.push("--max-per-day", str(flags, "maxPerDay") as string);
  if (str(flags, "limit")) args.push("--limit", str(flags, "limit") as string);
  return args.join(" ");
}

// ------------------------------------------------------------ step one

export interface BlastOptions {
  /** The email-cleaner command (tests hand in a fake). */
  cleaner?: string;
  /** How to start this program again, for --go (tests hand in bun + main.ts). */
  self?: string[];
}

export async function runBlast(rest: string[], flags: Flags, options: BlastOptions = {}): Promise<number> {
  if (flags.go) return await runGo(rest[0], flags, options);
  const path = rest[0];
  const listName = str(flags, "list")?.trim().toLowerCase();
  const idFlag = str(flags, "id");
  const subject = str(flags, "subject");
  if (!path || !listName || !idFlag || !subject) throw new Error(BLAST_USAGE);
  const body = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  if (!body.trim()) throw new Error(`${path} is empty. Nothing was imported or created.`);
  const subjectB = str(flags, "subjectB");
  const csv = str(flags, "csv");
  if (flags.clean && !csv) throw new Error("--clean cleans the --csv file; pass one.");
  const id = slugify(idFlag);
  if (!id) throw new Error(`--id ${idFlag} has nothing usable in it; use letters, digits and dashes.`);
  const running = liveSendLock(id);
  if (running) throw new SendLockedError(running);
  const via = str(flags, "via") ?? str(flags, "smtp");

  // 1. The list.
  if (csv) {
    let people: SubscriberInput[];
    if (flags.clean) {
      const cleaned = cleanSubscriberCsv(csv, { command: options.cleaner });
      const reasons = Object.entries(cleaned.byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ");
      out(`Cleaned ${basename(csv)}: ${cleaned.kept.length} kept, ${cleaned.rejected} rejected${reasons ? ` (${reasons})` : ""}.`);
      people = cleaned.kept;
    } else people = readSubscriberFile(csv);
    const tags = list(str(flags, "tags"));
    reportSubscribe(subscribe(listName, people.map((person) => ({ ...person, tags: [...(person.tags ?? []), ...tags] })), `import:${basename(csv)}`), listName);
  } else if (!subscribers(listName).some((row) => row.active)) {
    throw new Error(`Nobody on ${listName} can be mailed yet. Pass --csv <file> to import them.`);
  }

  // 2. The issue: new, a draft brought up to date, or one part way out that resumes.
  const file = readNewsletters();
  const existing = file.newsletters.find((entry) => entry.id === id);
  let newsletter: Newsletter;
  let resumed = false;
  if (!existing) {
    newsletter = createNewsletter({
      id,
      subject,
      body,
      list: listName,
      subjectB: subjectB ?? null,
      smtp: via ?? null,
      replyTo: str(flags, "replyTo") ?? null,
      ctaSet: ctaSetFlag(flags, "default") ?? null,
      service: str(flags, "service") ?? null,
    });
    out(`Created ${newsletter.id} to ${newsletter.list}.`);
  } else {
    const t = tally(existing.id, file);
    const touched = t.sent + t.failed + t.pending > 0 || existing.status === "sending" || existing.status === "sent";
    if (touched) {
      const same =
        existing.body === body && existing.subject === oneLine(subject) && (existing.subjectB ?? null) === (subjectB ? oneLine(subjectB) || null : null) && existing.list === listName;
      if (!same)
        throw new Error(
          `${existing.id} has already gone to ${t.sent} people, so its body, subjects and list cannot change now. ` +
            `Pass the same file, subjects and list to resume it, or use a new --id for a new issue.`,
        );
      newsletter = existing;
      resumed = true;
      out(`Resuming ${existing.id}: the same body and subjects, ${t.sent} already have it.`);
    } else {
      newsletter = editNewsletter(existing.id, {
        subject,
        body,
        list: listName,
        subjectB: subjectB ?? null,
        smtp: via ?? existing.smtp,
        replyTo: str(flags, "replyTo") ?? existing.replyTo,
        ctaSet: ctaSetFlag(flags, existing.ctaSet ?? "default") ?? null,
        service: str(flags, "service") ?? existing.service ?? null,
        // blast sends it, not the daemon.
        draft: true,
      });
      out(`Updated the draft ${newsletter.id} from ${path === "-" ? "stdin" : basename(path)}.`);
    }
  }

  // 3. One test copy, unless a resume was not asked for one.
  const testTo = str(flags, "testTo");
  if (!resumed || testTo) {
    const to = testTo ?? newsletter.replyTo ?? addressOf(resolveSender(via ?? newsletter.smtp).from ?? "");
    if (!to || !to.includes("@")) throw new Error("No address for the test copy: pass --test-to you@example.com, or --reply-to.");
    const test = await sendNewsletter(newsletter.id, { test: to, via, log: (line) => out(line) });
    if (!test.sent.length) {
      out(`Test copy failed: ${test.failed[0]?.error ?? "not sent"}. Nothing went to the list.`);
      return 1;
    }
    out(`Test copy sent to ${to}.`);
  }

  // 4. The numbers, and stop.
  const preview = await sendNewsletter(newsletter.id, { ...sendOptions(flags), dryRun: true });
  const due = preview.wouldSend.length + preview.remaining;
  out("");
  out(`${preview.id} to ${preview.list}: ${preview.audience} can be mailed, ${preview.alreadySent} already have it, ${due} to go.`);
  if (preview.remaining) out(`${preview.wouldSend.length} go on this run; ${preview.remaining} wait for the next day's cap (--max-per-day raises it).`);
  if (preview.variants.length < 2) {
    const only = preview.variants[0];
    if (only) out(`One variant (${only.key}): subject ${only.subjectKey}: ${only.subject}${only.cta ? `  |  CTA: ${only.cta.label}` : ""}`);
  } else printVariants(preview);
  if (preview.uncertain) out(`${preview.uncertain} died mid-send last time and may have it; they are skipped (add --retry-uncertain to --go to mail them).`);
  if (preview.previouslyFailed) out(`${preview.previouslyFailed} were refused before and are skipped (add --retry-failed to --go to try again).`);
  out(`Tracking: ${preview.tracked ? "on (crawlproof)" : "off"}.`);
  if (!due) {
    out("Everyone on the list already has it. Nothing to send.");
    return 0;
  }
  out("");
  out("Nothing has gone to the list. Check the test copy, then send it in the background:");
  out(`  ${goCommand(newsletter.id, flags)}`);
  return 0;
}

// ------------------------------------------------------------ --go

/** How to run this program again: the compiled binary, or the runtime plus its script. */
function selfCommand(): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs") && !script.startsWith("B:/~BUN") && existsSync(script) && script !== process.execPath) return [process.execPath, script];
  return [process.execPath];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runGo(idArg: string | undefined, flags: Flags, options: BlastOptions = {}): Promise<number> {
  if (!idArg) throw new Error("Usage: myna newsletter blast --go <id> [--max-per-day N]");
  const newsletter = requireNewsletter(idArg);
  const id = newsletter.id;
  const held = liveSendLock(id);
  if (held) throw new SendLockedError(held);

  const preview = await sendNewsletter(id, { ...sendOptions(flags), dryRun: true });
  if (!preview.wouldSend.length) {
    if (!preview.remaining) out(`Everyone on ${preview.list} already has ${id}. Nothing to send.`);
    else out(`Nothing can go now: ${preview.remaining} are due but today's cap is spent. Try again tomorrow, or raise it with --max-per-day N.`);
    return preview.remaining ? 1 : 0;
  }

  ensureStateDir();
  const logPath = sendLogPath(id);
  const fd = openSync(logPath, "a", 0o600);
  writeSync(fd, `\n=== ${new Date().toISOString()}  background send of ${id} started from pid ${process.pid} ===\n`);
  const env: Record<string, string | undefined> = { ...process.env, MYNA_BACKGROUND: "1" };
  const passphrase = activePassphrase();
  if (passphrase) env.MYNA_PASSPHRASE = passphrase;
  const [command, ...pre] = options.self ?? selfCommand();
  const child = spawn(command as string, [...pre, "newsletter", "_run", id, "--yes", ...passthrough(flags)], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
  });
  closeSync(fd);
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  child.on("error", (error) => {
    out(`Could not start the background send: ${error.message}`);
    exited = 1;
  });
  child.unref();

  // Wait until the child holds the lock (or has already finished, on a small list).
  let started = false;
  for (let i = 0; i < 100 && exited === null; i++) {
    if (readSendLock(id)?.pid === child.pid) {
      started = true;
      break;
    }
    await wait(100);
  }
  if (exited !== null && !started) {
    const code = exited as number;
    out(code === 0 ? `The background send of ${id} already finished:` : `The background send of ${id} stopped at once (exit ${code}):`);
    for (const line of tailLines(logPath, 8)) out(`  ${line}`);
    return code === 0 ? 0 : 1;
  }
  if (!started) out(`Started pid ${child.pid}, but it has not taken the lock yet; check the log.`);
  out(`Sending ${id} in the background, pid ${child.pid}: ${preview.wouldSend.length} go now${preview.remaining ? `, ${preview.remaining} wait for the next day` : ""}.`);
  printVariants(preview);
  out(`Watch it:   myna newsletter status ${id} --watch`);
  out(`The log:    tail -f ${logPath}`);
  out(`Stop it:    kill ${child.pid}   (the same --go resumes from the ledger; nobody gets it twice)`);
  return 0;
}

// ------------------------------------------------------------ the background child

export async function runSendWorker(idArg: string | undefined, flags: Flags): Promise<number> {
  if (!idArg) throw new Error("Usage: myna newsletter _run <id> --yes");
  const newsletter = requireNewsletter(idArg);
  const id = newsletter.id;
  const stamp = (line: string) => out(`${new Date().toISOString()}  ${line}`);
  let release: () => void;
  try {
    release = acquireSendLock(id, { log: sendLogPath(id), ...(num(flags, "maxPerDay") !== undefined ? { maxPerDay: num(flags, "maxPerDay") } : {}) });
  } catch (error) {
    stamp(`not started: ${(error as Error).message}`);
    return 1;
  }
  const stop = (signal: string) => {
    stamp(`stopped by ${signal}. The same --go resumes from the ledger.`);
    releaseSendLock(id);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGHUP", () => stop("SIGHUP"));
  try {
    const common = sendOptions(flags);
    const preview = await sendNewsletter(id, { ...common, dryRun: true });
    updateSendLock(id, { batch: preview.wouldSend.length });
    stamp(`pid ${process.pid}: ${preview.wouldSend.length} to go on this run, ${preview.alreadySent} already have it, ${preview.remaining} after this run.`);
    const report = await sendNewsletter(id, { ...common, log: stamp });
    stamp(`done: ${report.sent.length} sent, ${report.failed.length} failed, ${report.remaining} left. Status: ${report.status}.${report.via ? ` Via ${report.via}.` : ""}`);
    if (report.remaining) stamp(`${report.remaining} still to go: myna newsletter blast --go ${id}${passthrough(flags).length ? ` ${passthrough(flags).join(" ")}` : ""} (tomorrow, when the cap is spent).`);
    return report.failed.length ? 1 : 0;
  } catch (error) {
    stamp(`error: ${(error as Error).message}`);
    return 1;
  } finally {
    release();
  }
}

// ------------------------------------------------------------ status

function renderStatus(p: SendProgress, now = Date.now()): void {
  const pct = p.audience ? ` (${((p.sent / p.audience) * 100).toFixed(1)}%)` : "";
  out(`${p.id}  ${p.running && p.status !== "sent" ? "sending" : p.status}  to ${p.list}`);
  out(`  sent       ${p.sent} of ${p.audience}${pct}`);
  out(`  failed     ${p.failed}`);
  if (p.pending) out(`  pending    ${p.pending}  ${p.running ? "(in flight, or left by an earlier run that died)" : "(a run died mid-message; --retry-uncertain mails them)"}`);
  out(`  remaining  ${p.remaining}`);
  out(`  rate       ${p.ratePerMin === null ? "not enough recent sends to say" : `${p.ratePerMin.toFixed(1)}/min over the last 15 min`}`);
  if (p.running) {
    const eta = p.etaMs === null ? "unknown yet" : `${formatDuration(p.etaMs)}  (about ${new Date(now + p.etaMs).toISOString().slice(11, 16)} UTC)`;
    out(`  ETA        ${eta}${p.running.batch !== undefined && p.running.batch < p.remaining + p.sentThisRun ? `  for this run's ${p.running.batch}` : ""}`);
    out(`  running    yes, pid ${p.running.pid} since ${p.running.startedAt.slice(0, 19).replace("T", " ")} UTC, ${p.sentThisRun} sent this run`);
  } else if (p.stale) out(`  running    no: pid ${p.stale.pid} died without finishing (stale lock). myna newsletter blast --go ${p.id} resumes it.`);
  else out(`  running    no${p.remaining ? `. myna newsletter blast --go ${p.id} sends the rest.` : ""}`);
  if (p.lastSentAt) out(`  last sent  ${p.lastSentAt.slice(0, 19).replace("T", " ")} UTC`);
  if (p.variants.length > 1 || p.variants.some((v) => v.key !== "A")) {
    out("");
    table(
      p.variants.map((v) => ({ variant: v.key, subject: v.subjectKey, cta: v.cta, sent: String(v.sent), failed: String(v.failed), due: String(v.due) })),
      [
        { key: "variant", title: "Variant" },
        { key: "subject", title: "Subject" },
        { key: "cta", title: "CTA" },
        { key: "sent", title: "Sent" },
        { key: "failed", title: "Failed" },
        { key: "due", title: "To go" },
      ],
    );
  }
  if (p.log) {
    out("");
    out(`log ${p.log}:`);
    for (const line of tailLines(p.log, 5)) out(`  ${line}`);
  }
}

export async function runStatus(idArg: string | undefined, flags: Flags): Promise<number> {
  let id = idArg;
  if (!id) {
    const going = readNewsletters().newsletters.filter((n) => n.status === "sending" || liveSendLock(n.id));
    if (going.length !== 1) throw new Error(`Usage: myna newsletter status <id> [--watch]${going.length ? `   (going out now: ${going.map((n) => n.id).join(", ")})` : ""}`);
    id = (going[0] as Newsletter).id;
  }
  if (flags.json) {
    out(JSON.stringify(sendProgress(id), null, 2));
    return 0;
  }
  if (!flags.watch) {
    renderStatus(sendProgress(id));
    return 0;
  }
  const every = Math.max(1, num(flags, "every") ?? 3) * 1000;
  const clear = process.stdout.isTTY ? "\x1b[2J\x1b[H" : "";
  for (;;) {
    const progress = sendProgress(id);
    if (clear) process.stdout.write(clear);
    renderStatus(progress);
    if (!progress.running) {
      out("");
      out("No send of it is running; stopped watching.");
      return 0;
    }
    out("");
    out(`Every ${every / 1000}s. Ctrl-C stops watching; the send carries on.`);
    await wait(every);
  }
}
