/**
 * Where mail and texts go out from, and what has gone out.
 *
 * SMTP servers and the Telnyx setup are two files: the non-secret shape in
 * plain JSON, the password and the API key in the encrypted vault under the
 * plugin-secrets door, keyed by server id. The sends ledger is what the daily
 * caps count against, and what `myna email log` shows.
 */
import { readJson, writeJson } from "../util/json.ts";
import { OUTREACH_FILE } from "../util/paths.ts";
import { getPluginSecrets, setPluginSecrets } from "./accounts.ts";
import type { SmtpServer } from "../core/smtp.ts";

export interface SmsSetup {
  provider: "telnyx";
  from: string;
}

export interface SentRecord {
  at: string;
  kind: "email" | "sms";
  to: string;
  via: string;
  subject?: string;
  ok: boolean;
  id?: string;
  error?: string;
}

export interface OutreachFile {
  smtp: SmtpServer[];
  sms: SmsSetup | null;
  sent: SentRecord[];
}

const LIMIT = 5000;

export function readOutreach(): OutreachFile {
  const file = readJson<Partial<OutreachFile>>(OUTREACH_FILE, {});
  return { smtp: Array.isArray(file.smtp) ? file.smtp : [], sms: file.sms ?? null, sent: Array.isArray(file.sent) ? file.sent : [] };
}

export function writeOutreach(file: OutreachFile): void {
  if (file.sent.length > LIMIT) file.sent = file.sent.slice(-LIMIT);
  writeJson(OUTREACH_FILE, file);
}

export function saveSmtpServer(server: SmtpServer, pass: string): void {
  const file = readOutreach();
  file.smtp = [...file.smtp.filter((entry) => entry.id !== server.id), server];
  writeOutreach(file);
  setPluginSecrets("smtp", { ...getPluginSecrets("smtp"), [server.id]: pass });
}

export function removeSmtpServer(id: string): boolean {
  const file = readOutreach();
  const before = file.smtp.length;
  file.smtp = file.smtp.filter((entry) => entry.id !== id);
  writeOutreach(file);
  const secrets = { ...getPluginSecrets("smtp") };
  delete secrets[id];
  setPluginSecrets("smtp", secrets);
  return file.smtp.length < before;
}

export function smtpServer(id?: string): SmtpServer & { pass: string } {
  const file = readOutreach();
  const server = id ? file.smtp.find((entry) => entry.id === id) : file.smtp[0];
  if (!server) throw new Error(id ? `No SMTP server "${id}". myna smtp list shows them.` : "No SMTP server yet. Add one: myna smtp add <id> --host ... --user ... --from ...");
  const pass = getPluginSecrets("smtp")[server.id] ?? "";
  return { ...server, pass };
}

export function saveSms(setup: SmsSetup, apiKey: string): void {
  const file = readOutreach();
  file.sms = setup;
  writeOutreach(file);
  setPluginSecrets("sms", { apiKey });
}

export function smsConfig(): { from: string; apiKey: string; provider: "telnyx" } {
  const file = readOutreach();
  if (!file.sms) throw new Error("No SMS setup yet. myna sms setup --from +1...  (a Telnyx number on a messaging profile)");
  const apiKey = getPluginSecrets("sms").apiKey ?? process.env.TELNYX_API_KEY ?? "";
  if (!apiKey) throw new Error("No Telnyx API key. myna sms setup --api-key <key>, or set TELNYX_API_KEY.");
  return { ...file.sms, apiKey };
}

export function recordSent(entries: SentRecord[]): void {
  if (!entries.length) return;
  const file = readOutreach();
  file.sent.push(...entries);
  writeOutreach(file);
}

export function outreachSentToday(kind: "email" | "sms", now = Date.now()): number {
  return readOutreach().sent.filter((entry) => entry.kind === kind && entry.ok && now - Date.parse(entry.at) < 86_400_000).length;
}
