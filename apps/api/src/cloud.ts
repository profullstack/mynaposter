/**
 * Optional cloud backup.
 *
 * Entirely opt-in: myna is a local-first tool and works with none of this. What
 * it buys is one command to move an install to a new machine without carrying a
 * file around.
 *
 * The thing being stored is a bundle that was already sealed on the client with
 * a passphrase that never leaves it. This side holds ciphertext it cannot read.
 * So the server is a dumb, durable shelf: losing it loses a backup, and breaking
 * into it yields nothing, because the tokens for 26 social networks are not the
 * kind of thing that should sit decryptable on somebody's server.
 *
 * Auth is email and password. The house pattern is magic link and passkey, with
 * an optional password for devices those cannot reach; a terminal has no mail
 * client to open a link in and no authenticator to hold a passkey, which is that
 * exception exactly.
 */
import { db } from "./db/index.ts";
import {
  assertSealedBundle,
  burnTime,
  hashPassword,
  hashToken,
  newToken,
  normalizeEmail,
  verifyPassword,
} from "./credentials.ts";

/** 5 MB. A bundle of a few hundred accounts is a few hundred KB. */
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

export interface CloudUser {
  id: string;
  email: string;
}

async function mintToken(userId: string, name = "cli"): Promise<string> {
  const token = newToken();
  await db()`
    insert into api_tokens (user_id, token_hash, name)
    values (${userId}, ${hashToken(token)}, ${name})
  `;
  return token;
}

export async function signup(email: string, password: string): Promise<{ user: CloudUser; token: string }> {
  const address = normalizeEmail(email);
  const stored = hashPassword(password);

  const existing = await db()`select id from users where email = ${address}`;
  if (existing.length) throw new Error("That email already has an account. Sign in instead.");

  const rows = await db()`
    insert into users (email, password_hash, password_salt, password_params)
    values (${address}, ${stored.hash}, ${stored.salt}, ${db().json(stored.params as never)})
    returning id, email
  `;
  const user = rows[0] as CloudUser;
  return { user, token: await mintToken(user.id) };
}

export async function login(email: string, password: string): Promise<{ user: CloudUser; token: string }> {
  const address = normalizeEmail(email);
  const rows = await db()`
    select id, email, password_hash, password_salt, password_params
    from users where email = ${address}
  `;

  const row = rows[0] as
    | { id: string; email: string; password_hash: string | null; password_salt: string | null; password_params: Record<string, number> | null }
    | undefined;

  // The same message and roughly the same work either way, so neither the
  // wording nor the response time answers "does this address have an account".
  const wrong = new Error("Wrong email or password.");
  if (!row?.password_hash) {
    burnTime(password);
    throw wrong;
  }
  if (!verifyPassword(password, { hash: row.password_hash, salt: row.password_salt, params: row.password_params })) {
    throw wrong;
  }

  return { user: { id: row.id, email: row.email }, token: await mintToken(row.id) };
}

/** Resolve a bearer token to its owner, or null. */
export async function whoami(token: string): Promise<CloudUser | null> {
  if (!token) return null;
  const rows = await db()`
    update api_tokens set last_used_at = now()
    where token_hash = ${hashToken(token)}
    returning user_id
  `;
  const userId = (rows[0] as { user_id: string } | undefined)?.user_id;
  if (!userId) return null;

  const users = await db()`select id, email from users where id = ${userId}`;
  return (users[0] as CloudUser | undefined) ?? null;
}

export async function logout(token: string): Promise<boolean> {
  const rows = await db()`delete from api_tokens where token_hash = ${hashToken(token)} returning id`;
  return rows.length > 0;
}

export async function putBackup(
  userId: string,
  blob: string,
  meta: Record<string, unknown> | null,
): Promise<{ bytes: number; updatedAt: string }> {
  const bytes = Buffer.byteLength(blob, "utf8");
  if (bytes > MAX_BACKUP_BYTES) {
    throw new Error(`That backup is ${(bytes / 1e6).toFixed(1)} MB, over the ${MAX_BACKUP_BYTES / 1e6} MB limit.`);
  }
  // Refuse anything that is not a sealed bundle, so a mistake on the client
  // cannot silently leave something readable sitting up here.
  assertSealedBundle(blob);

  const rows = await db()`
    insert into backups (user_id, blob, meta, bytes, updated_at)
    values (${userId}, ${blob}, ${db().json((meta ?? {}) as never)}, ${bytes}, now())
    on conflict (user_id) do update
      set blob = excluded.blob, meta = excluded.meta, bytes = excluded.bytes, updated_at = now()
    returning bytes, updated_at
  `;
  const row = rows[0] as { bytes: number; updated_at: Date };
  return { bytes: row.bytes, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function getBackup(userId: string): Promise<{ blob: string; meta: unknown; bytes: number; updatedAt: string } | null> {
  const rows = await db()`select blob, meta, bytes, updated_at from backups where user_id = ${userId}`;
  const row = rows[0] as { blob: string; meta: unknown; bytes: number; updated_at: Date } | undefined;
  if (!row) return null;
  return { blob: row.blob, meta: row.meta, bytes: row.bytes, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function backupStatus(userId: string): Promise<{ meta: unknown; bytes: number; updatedAt: string } | null> {
  const rows = await db()`select meta, bytes, updated_at from backups where user_id = ${userId}`;
  const row = rows[0] as { meta: unknown; bytes: number; updated_at: Date } | undefined;
  if (!row) return null;
  return { meta: row.meta, bytes: row.bytes, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function deleteBackup(userId: string): Promise<boolean> {
  const rows = await db()`delete from backups where user_id = ${userId} returning user_id`;
  return rows.length > 0;
}
