/**
 * secp256k1 + BIP340 Schnorr, in BigInt.
 *
 * Nostr signs every event with BIP340 and node:crypto exposes no Schnorr
 * primitive, so this is the one piece of cryptography myna implements itself.
 * It is verified against the BIP340 reference vectors in test/schnorr.test.ts.
 * Points are held in Jacobian coordinates so a scalar multiply needs one
 * modular inverse at the end instead of one per bit.
 */
import { createHash } from "node:crypto";

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function powMod(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** p is prime, so a⁻¹ = a^(p-2). */
const inverse = (a: bigint, m = P): bigint => powMod(a, m - 2n, m);

/** p ≡ 3 (mod 4), so the square root is a^((p+1)/4) when one exists. */
const sqrtMod = (a: bigint): bigint => powMod(a, (P + 1n) / 4n, P);

interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint;
}

const ZERO: Jacobian = { x: 0n, y: 1n, z: 0n };
const G: Jacobian = { x: Gx, y: Gy, z: 1n };

function double(p: Jacobian): Jacobian {
  if (p.z === 0n || p.y === 0n) return ZERO;
  const A = mod(p.x * p.x);
  const B = mod(p.y * p.y);
  const C = mod(B * B);
  const D = mod(2n * (mod((p.x + B) * (p.x + B)) - A - C));
  const E = mod(3n * A);
  const F = mod(E * E);
  return {
    x: mod(F - 2n * D),
    y: mod(E * (D - mod(F - 2n * D)) - 8n * C),
    z: mod(2n * p.y * p.z),
  };
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = mod(p.z * p.z);
  const z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2);
  const u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * q.z * z2z2);
  const s2 = mod(q.y * p.z * z1z1);
  const h = mod(u2 - u1);
  const r = mod(2n * (s2 - s1));
  if (h === 0n) return r === 0n ? double(p) : ZERO;
  const i = mod(mod(2n * h) * mod(2n * h));
  const j = mod(h * i);
  const v = mod(u1 * i);
  const x3 = mod(r * r - j - 2n * v);
  return {
    x: x3,
    y: mod(r * (v - x3) - 2n * s1 * j),
    z: mod((mod((p.z + q.z) * (p.z + q.z)) - z1z1 - z2z2) * h),
  };
}

function multiply(k: bigint, point: Jacobian = G): Jacobian {
  let result = ZERO;
  let addend = point;
  let scalar = mod(k, N);
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, addend);
    addend = double(addend);
    scalar >>= 1n;
  }
  return result;
}

function affine(p: Jacobian): { x: bigint; y: bigint } | null {
  if (p.z === 0n) return null;
  const zInv = inverse(p.z);
  const zInv2 = mod(zInv * zInv);
  return { x: mod(p.x * zInv2), y: mod(p.y * zInv2 * zInv) };
}

/** The even-y point with this x coordinate, or null when x is not on the curve. */
function liftX(x: bigint): Jacobian | null {
  if (x <= 0n || x >= P) return null;
  const ySquared = mod(x * x * x + 7n);
  const y = sqrtMod(ySquared);
  if (mod(y * y) !== ySquared) return null;
  return { x, y: y % 2n === 0n ? y : P - y, z: 1n };
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Hex string has an odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Hex string contains a non-hex character");
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

/** BIP340 tagged hash: sha256(sha256(tag) ‖ sha256(tag) ‖ msg). */
function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(tagHash, tagHash, ...parts);
}

/** The 32-byte x-only public key for a 32-byte private key. */
export function publicKey(privateKey: Uint8Array): Uint8Array {
  const d = bytesToBigInt(privateKey);
  if (d <= 0n || d >= N) throw new Error("Private key is out of range");
  const point = affine(multiply(d));
  if (!point) throw new Error("Private key produced the point at infinity");
  return bigIntTo32Bytes(point.x);
}

/**
 * Sign a 32-byte message. `aux` defaults to zeros, which BIP340 permits and
 * which keeps signatures deterministic — useful when testing.
 */
export function sign(message: Uint8Array, privateKey: Uint8Array, aux: Uint8Array = new Uint8Array(32)): Uint8Array {
  if (message.length !== 32) throw new Error("BIP340 signs a 32-byte message");
  const d0 = bytesToBigInt(privateKey);
  if (d0 <= 0n || d0 >= N) throw new Error("Private key is out of range");

  const point = affine(multiply(d0));
  if (!point) throw new Error("Private key produced the point at infinity");
  const d = point.y % 2n === 0n ? d0 : N - d0;
  const px = bigIntTo32Bytes(point.x);

  const t = bigIntTo32Bytes(d ^ bytesToBigInt(taggedHash("BIP0340/aux", aux)));
  const rand = taggedHash("BIP0340/nonce", t, px, message);
  const k0 = mod(bytesToBigInt(rand), N);
  if (k0 === 0n) throw new Error("Nonce was zero; retry with different aux bytes");

  const rPoint = affine(multiply(k0));
  if (!rPoint) throw new Error("Nonce produced the point at infinity");
  const k = rPoint.y % 2n === 0n ? k0 : N - k0;
  const rx = bigIntTo32Bytes(rPoint.x);

  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", rx, px, message)), N);
  const s = bigIntTo32Bytes(mod(k + e * d, N));

  const signature = new Uint8Array(64);
  signature.set(rx, 0);
  signature.set(s, 32);
  return signature;
}

export function verify(signature: Uint8Array, message: Uint8Array, xOnlyPublicKey: Uint8Array): boolean {
  if (signature.length !== 64 || message.length !== 32 || xOnlyPublicKey.length !== 32) return false;
  const point = liftX(bytesToBigInt(xOnlyPublicKey));
  if (!point) return false;
  const r = bytesToBigInt(signature.subarray(0, 32));
  const s = bytesToBigInt(signature.subarray(32));
  if (r >= P || s >= N) return false;

  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", signature.subarray(0, 32), xOnlyPublicKey, message)), N);
  const result = affine(add(multiply(s), multiply(N - e, point)));
  if (!result) return false;
  return result.y % 2n === 0n && result.x === r;
}

export const sha256Bytes = sha256;
