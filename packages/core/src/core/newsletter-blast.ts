/**
 * What `myna newsletter blast` and `myna newsletter status` need beyond the
 * plain send: how far a send is (from the ledger, the same one the send
 * resumes from), how fast it is going, and a CSV run through cli-tools'
 * `email-cleaner` before it is imported.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readNewsletters, requireNewsletter, type Newsletter } from "../store/newsletters.ts";
import { recipients } from "../store/contacts.ts";
import { parseSubscribers, variantIndex, variantsFor, type SubscriberInput } from "./newsletter.ts";
import { lockIsLive, readSendLock, sendLogPath, type SendLock } from "./newsletter-lock.ts";

export interface VariantProgress {
  key: string;
  subjectKey: string;
  cta: string;
  sent: number;
  failed: number;
  /** Still to go to this variant. */
  due: number;
}

export interface SendProgress {
  id: string;
  status: Newsletter["status"];
  list: string;
  /** Everyone on the list who can be mailed now. */
  audience: number;
  sent: number;
  /** Refused and not retried on their own. */
  failed: number;
  /** Marked pending: in flight right now, or from a run that died mid-message. */
  pending: number;
  /** Not reached yet: no ledger row, or a failure that is retried on its own. */
  remaining: number;
  variants: VariantProgress[];
  /** Messages a minute over the recent window, or null with too few to say. */
  ratePerMin: number | null;
  /** Milliseconds to go at that rate, for what this run will still send. */
  etaMs: number | null;
  lastSentAt: string | null;
  /** The background (or foreground) send holding the lock, while it runs. */
  running: SendLock | null;
  /** A lock left by a send that died. */
  stale: SendLock | null;
  /** Sent since the running send started. */
  sentThisRun: number;
  log: string | null;
}

/** The recent window the rate is measured over. */
export const RATE_WINDOW_MS = 15 * 60_000;

/**
 * Messages a minute from send times: the ones inside the window before `now`,
 * first to last. Two are needed to say anything. The ETA is `toGo` at that rate.
 */
export function sendRate(sentTimes: number[], toGo: number, now: number, windowMs = RATE_WINDOW_MS): { ratePerMin: number | null; etaMs: number | null } {
  const recent = sentTimes.filter((t) => t <= now && now - t <= windowMs).sort((a, b) => a - b);
  if (recent.length < 2) return { ratePerMin: null, etaMs: toGo === 0 ? 0 : null };
  const span = (recent[recent.length - 1] as number) - (recent[0] as number);
  if (span <= 0) return { ratePerMin: null, etaMs: null };
  const ratePerMin = ((recent.length - 1) / span) * 60_000;
  return { ratePerMin, etaMs: toGo === 0 ? 0 : Math.round((toGo / ratePerMin) * 60_000) };
}

/** Where an issue's send stands, read from the ledger and the lock. Reads only. */
export function sendProgress(id: string, options: { now?: number } = {}): SendProgress {
  const now = options.now ?? Date.now();
  const file = readNewsletters();
  const newsletter = requireNewsletter(id, file);
  const ledger = file.deliveries[newsletter.id] ?? {};
  const variants = variantsFor(newsletter);
  const rows = new Map<string, VariantProgress>(
    variants.map((v) => [v.key, { key: v.key, subjectKey: v.subjectKey, cta: v.cta?.label ?? "", sent: 0, failed: 0, due: 0 }]),
  );
  const row = (key: string): VariantProgress => {
    let found = rows.get(key);
    if (!found) {
      found = { key, subjectKey: "", cta: "", sent: 0, failed: 0, due: 0 };
      rows.set(key, found);
    }
    return found;
  };

  let sent = 0;
  let failed = 0;
  let pending = 0;
  const sentTimes: number[] = [];
  let last = 0;
  for (const entry of Object.values(ledger)) {
    if (entry.state === "sent") {
      sent++;
      row(entry.variant ?? "A").sent++;
      const t = Date.parse(entry.at);
      if (Number.isFinite(t)) {
        sentTimes.push(t);
        last = Math.max(last, t);
      }
    } else if (entry.state === "failed" && !entry.retryable) {
      failed++;
      row(entry.variant ?? "A").failed++;
    } else if (entry.state === "pending") pending++;
  }

  const audience = recipients({ list: newsletter.list }).filter((contact) => contact.email);
  let remaining = 0;
  for (const contact of audience) {
    const entry = ledger[contact.id];
    if (!entry || (entry.state === "failed" && entry.retryable)) {
      remaining++;
      const variant = variants[variantIndex(newsletter.id, contact.email as string, variants.length)];
      if (variant) row(variant.key).due++;
    }
  }

  const lock = readSendLock(newsletter.id);
  const running = lock && lockIsLive(lock) ? lock : null;
  const stale = lock && !running ? lock : null;
  const since = running ? Date.parse(running.startedAt) : Number.NaN;
  const sentThisRun = Number.isFinite(since) ? sentTimes.filter((t) => t >= since).length : 0;
  const toGo = running?.batch !== undefined ? Math.min(remaining, Math.max(0, running.batch - sentThisRun)) : remaining;
  const { ratePerMin, etaMs } = sendRate(sentTimes, toGo, now);
  const logPath = running?.log ?? stale?.log ?? sendLogPath(newsletter.id);

  return {
    id: newsletter.id,
    status: newsletter.status,
    list: newsletter.list,
    audience: audience.length,
    sent,
    failed,
    pending,
    remaining,
    variants: [...rows.values()],
    ratePerMin,
    etaMs,
    lastSentAt: last ? new Date(last).toISOString() : null,
    running,
    stale,
    sentThisRun,
    log: existsSync(logPath) ? logPath : null,
  };
}

/** "2h 05m", "4m 10s", "12s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** The last `n` lines of a file, or none. */
export function tailLines(path: string | null, n: number): string[] {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  return lines.slice(-n);
}

export interface CleanResult {
  kept: SubscriberInput[];
  total: number;
  rejected: number;
  /** Reason → how many entries had it; one entry can have several. */
  byReason: Record<string, number>;
}

/**
 * Run a subscriber CSV through cli-tools' `email-cleaner - --format json` and
 * keep the rows it calls valid. The cleaner is found on PATH (or `command`).
 */
export function cleanSubscriberCsv(path: string, options: { command?: string } = {}): CleanResult {
  const text = readFileSync(path, "utf8");
  const command = options.command ?? "email-cleaner";
  const run = spawnSync(command, ["-", "--format", "json"], { input: text, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (run.error) {
    if ((run.error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`--clean needs ${command} (from profullstack/cli-tools) on PATH, and it is not there. Install it, or drop --clean.`);
    throw run.error;
  }
  if (run.status !== 0) throw new Error(`${command} failed (exit ${run.status}): ${(run.stderr || "").trim().split("\n")[0] || "no message"}`);
  let parsed: { valid?: { email?: string }[]; invalid?: { reasons?: string[] }[]; stats?: { total?: number; byReason?: Record<string, number> } };
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`${command} did not answer with JSON; nothing was imported.`);
  }
  const valid = new Set((parsed.valid ?? []).map((entry) => (entry.email ?? "").trim().toLowerCase()).filter(Boolean));
  const people = parseSubscribers(text, "csv");
  const seen = new Set<string>();
  const kept = people.filter((person) => {
    const email = person.email.trim().toLowerCase();
    if (!valid.has(email) || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
  const byReason: Record<string, number> = { ...(parsed.stats?.byReason ?? {}) };
  if (!parsed.stats?.byReason) for (const entry of parsed.invalid ?? []) for (const reason of entry.reasons ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1;
  return { kept, total: parsed.stats?.total ?? people.length, rejected: parsed.invalid?.length ?? people.length - kept.length, byReason };
}
