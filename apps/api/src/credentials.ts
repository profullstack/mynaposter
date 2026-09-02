/**
 * Password and token handling, with no database in it.
 *
 * Separated from cloud.ts on purpose. This is the part where a mistake is a
 * security bug rather than a 500, and it is the part that can be tested without
 * a running Postgres — so it is worth the file.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

/** Below these, the stored value cannot be a real scrypt output or salt. */
const MIN_HASH_BYTES = 32;
const MIN_SALT_BYTES = 16;

/**
 * Decode hex strictly.
 *
 * Buffer.from(value, "hex") stops at the first invalid character and returns
 * what it had, without complaint, so a malformed value silently becomes a short
 * or empty buffer. Everything downstream then compares lengths that agree for
 * the wrong reason.
 */
function decodeHex(value: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0) return Buffer.alloc(0);
  if (!/^[0-9a-fA-F]+$/.test(value)) return Buffer.alloc(0);
  return Buffer.from(value, "hex");
}

export interface ScryptParams {
  name?: string;
  N?: number;
  r?: number;
  p?: number;
  keylen?: number;
}

export interface StoredPassword {
  hash: string;
  salt: string;
  params: Required<Omit<ScryptParams, "name">> & { name: "scrypt" };
}

function derive(password: string, salt: Buffer, params: Required<Omit<ScryptParams, "name">>): Buffer {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

export function normalizeEmail(email: string): string {
  const value = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) throw new Error("That does not look like an email address.");
  return value;
}

/**
 * Length is the only rule here.
 *
 * Composition rules ("one capital, one symbol") push people towards Password1!
 * and no further, while costing real entropy in the passwords that would
 * otherwise have been good.
 */
export function checkPassword(password: string): void {
  if (String(password ?? "").length < 10) {
    throw new Error("Use a password of at least 10 characters.");
  }
}

export function hashPassword(password: string): StoredPassword {
  checkPassword(password);
  const salt = randomBytes(16);
  const params = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen };
  return {
    hash: derive(password, salt, params).toString("hex"),
    salt: salt.toString("hex"),
    params: { name: "scrypt", ...params },
  };
}

/**
 * Verify a password.
 *
 * Compared with timingSafeEqual, and the stored parameters are used rather than
 * the current constants, so N can be raised later without invalidating every
 * password already on file.
 */
export function verifyPassword(password: string, stored: { hash?: string | null; salt?: string | null; params?: ScryptParams | null }): boolean {
  if (!stored?.hash || !stored?.salt) return false;

  // Buffer.from() drops invalid hex silently rather than throwing, so "zz"
  // decodes to zero bytes. Left unchecked that made keylen 0, derive() return
  // an empty buffer, and timingSafeEqual(empty, empty) true -- any row with a
  // malformed or empty hash would have accepted any password at all.
  const expected = decodeHex(stored.hash);
  const salt = decodeHex(stored.salt);
  if (expected.length < MIN_HASH_BYTES || salt.length < MIN_SALT_BYTES) return false;

  const params = {
    N: stored.params?.N ?? SCRYPT.N,
    r: stored.params?.r ?? SCRYPT.r,
    p: stored.params?.p ?? SCRYPT.p,
    keylen: expected.length,
  };

  let actual: Buffer;
  try {
    actual = derive(password, salt, params);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Spend roughly the work a real verification would, for an address with no
 * account, so response time does not answer "does this email have an account".
 */
export function burnTime(password: string): void {
  derive(String(password ?? ""), randomBytes(16), { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen });
}

export function newToken(): string {
  return `myna_${randomBytes(32).toString("base64url")}`;
}

/** Tokens are stored hashed, so a database dump cannot be replayed as a login. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Reject anything that is not a client-sealed bundle. */
export function assertSealedBundle(blob: string): void {
  let parsed: { myna?: string; data?: string };
  try {
    parsed = JSON.parse(blob) as typeof parsed;
  } catch {
    throw new Error("That is not a myna bundle.");
  }
  if (parsed.myna !== "bundle" || !parsed.data) {
    throw new Error("That is not a sealed myna bundle. myna will not store an unencrypted one.");
  }
}
