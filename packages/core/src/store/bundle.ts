/**
 * Moving myna between machines.
 *
 * A bundle is everything one install knows: the connected accounts, the
 * scheduled queue and the settings. It is the only file myna produces that is
 * meant to leave the machine, which shapes every decision here.
 *
 * It is always encrypted, and always with a passphrase you type — never with
 * the local keyfile. Two reasons, and both matter:
 *
 *   The keyfile is machine-specific, so a bundle sealed with it would not open
 *   anywhere else, which defeats the point.
 *
 *   A bundle holds live tokens for every account. Unencrypted, a copy on a USB
 *   stick or in a chat message is a complete account takeover for every network
 *   at once. There is no `--plaintext` escape hatch for that reason.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import type { Account } from "../net/types.ts";
import { listAccounts, saveAccount } from "./accounts.ts";
import { listQueue, enqueue, type QueuedPost } from "./queue.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

export const BUNDLE_VERSION = 1;

export interface BundlePayload {
  accounts: Account[];
  queue: QueuedPost[];
  settings: Settings;
  /** Where and when it was made, to make a stale bundle recognisable. */
  savedAt: string;
  savedBy: string;
}

export interface BundleFile {
  myna: "bundle";
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
  /** Readable without the passphrase, so you can tell bundles apart. */
  meta: { savedAt: string; savedBy: string; accounts: number; queue: number };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

/** Everything this install knows, ready to be sealed. */
export function collect(options: { history?: boolean } = {}): BundlePayload {
  void options;
  return {
    accounts: listAccounts(),
    queue: listQueue().filter((post) => post.status === "pending"),
    settings: loadSettings(),
    savedAt: new Date().toISOString(),
    savedBy: `${process.env.USER ?? "someone"}@${process.env.HOSTNAME ?? "a machine"}`,
  };
}

export function seal(payload: BundlePayload, passphrase: string): BundleFile {
  if (passphrase.length < 8) {
    throw new Error("Use a passphrase of at least 8 characters. This file holds every token you have.");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);

  return {
    myna: "bundle",
    version: BUNDLE_VERSION,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex") },
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
    meta: {
      savedAt: payload.savedAt,
      savedBy: payload.savedBy,
      accounts: payload.accounts.length,
      queue: payload.queue.length,
    },
  };
}

export function open(file: BundleFile, passphrase: string): BundlePayload {
  if (file?.myna !== "bundle") throw new Error("That is not a myna bundle.");
  if (file.version > BUNDLE_VERSION) {
    throw new Error(`That bundle was written by a newer myna (format ${file.version}). Update myna and try again.`);
  }

  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, "hex"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as BundlePayload;
  } catch {
    // GCM cannot tell a wrong passphrase from a tampered file, and saying so is
    // more useful than picking one of the two and being wrong.
    throw new Error("Could not open the bundle. The passphrase is wrong, or the file has been altered.");
  }
}

export interface ApplyOptions {
  /** Replace an account that already exists rather than keeping the local one. */
  overwrite?: boolean;
  /** Also take the settings. Off by default: they are machine preferences. */
  settings?: boolean;
  /** Report what would change without changing anything. */
  dryRun?: boolean;
}

export interface ApplyResult {
  accountsAdded: string[];
  accountsReplaced: string[];
  accountsKept: string[];
  queueAdded: number;
  settingsApplied: boolean;
}

/**
 * Merge a bundle into this install.
 *
 * The default is additive. An account that already exists here is left alone
 * unless `overwrite` is set, because the local one is more likely to be the
 * working copy: tokens get refreshed in place, and a bundle taken a week ago
 * can carry a token that has since been rotated. Clobbering a live account
 * with a stale one is the failure that would be hardest to notice.
 */
export function apply(payload: BundlePayload, options: ApplyOptions = {}): ApplyResult {
  const existing = new Map(listAccounts().map((account) => [account.id, account]));
  const result: ApplyResult = {
    accountsAdded: [],
    accountsReplaced: [],
    accountsKept: [],
    queueAdded: 0,
    settingsApplied: false,
  };

  for (const account of payload.accounts ?? []) {
    if (!existing.has(account.id)) {
      result.accountsAdded.push(account.id);
      if (!options.dryRun) saveAccount(account);
    } else if (options.overwrite) {
      result.accountsReplaced.push(account.id);
      if (!options.dryRun) saveAccount(account);
    } else {
      result.accountsKept.push(account.id);
    }
  }

  const queued = new Set(listQueue().map((post) => post.id));
  for (const post of payload.queue ?? []) {
    if (queued.has(post.id) || post.status !== "pending") continue;
    result.queueAdded++;
    if (!options.dryRun) {
      // Re-enqueued rather than written through, so the local install assigns
      // its own id and a bundle loaded twice cannot double-post.
      enqueue({
        scheduledFor: post.scheduledFor,
        targets: post.targets,
        text: post.text,
        title: post.title,
        mediaPaths: post.mediaPaths,
        extra: post.extra,
        thread: post.thread,
      });
    }
  }

  if (options.settings && payload.settings) {
    result.settingsApplied = true;
    if (!options.dryRun) saveSettings(payload.settings);
  }

  return result;
}

/** One line describing a bundle, without opening it. */
export function describe(file: BundleFile): string {
  const when = new Date(file.meta.savedAt);
  const age = Number.isNaN(when.getTime()) ? file.meta.savedAt : when.toLocaleString();
  return `${file.meta.accounts} account${file.meta.accounts === 1 ? "" : "s"}, ${file.meta.queue} queued, saved ${age} by ${file.meta.savedBy}`;
}
