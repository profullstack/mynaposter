/**
 * Nostr.
 *
 * No account and no server: an identity is a keypair and a post is a signed
 * event pushed to whichever relays you list. Signing is BIP340 Schnorr, which
 * myna implements in util/crypto/schnorr.ts.
 */
import type { Account, Network, Profile, TimelineItem } from "../types.ts";
import { bech32Decode, bech32Encode } from "../../util/crypto/bech32.ts";
import { bigIntTo32Bytes, bytesToHex, hexToBytes, publicKey, sha256Bytes, sign } from "../../util/crypto/schnorr.ts";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.primal.net"];

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function parseSecretKey(input: string): Uint8Array {
  const value = input.trim();
  if (value.startsWith("nsec")) {
    const { prefix, bytes } = bech32Decode(value);
    if (prefix !== "nsec") throw new Error(`Expected an nsec key, got "${prefix}"`);
    return bytes;
  }
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new Error("A Nostr secret key is 32 bytes — paste an nsec or 64 hex characters.");
  return bytes;
}

/** NIP-01: the id is sha256 over a canonical array, not over the object. */
function eventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return bytesToHex(sha256Bytes(new TextEncoder().encode(serialized)));
}

function buildEvent(secretKey: Uint8Array, kind: number, content: string, tags: string[][]): NostrEvent {
  const pubkey = bytesToHex(publicKey(secretKey));
  const unsigned = { pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(sign(hexToBytes(id), secretKey)) };
}

const relaysOf = (account: { meta: Record<string, string> }): string[] =>
  (account.meta.relays || DEFAULT_RELAYS.join(",")).split(",").map((relay) => relay.trim()).filter(Boolean);

/** Push one event to one relay and resolve with what the relay said. */
function publishTo(url: string, event: NostrEvent, timeoutMs = 8000): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    const finish = (ok: boolean, message: string) => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve({ ok, message });
    };
    const timer = setTimeout(() => finish(false, "timed out"), timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      return finish(false, (error as Error).message);
    }

    socket.onopen = () => socket.send(JSON.stringify(["EVENT", event]));
    socket.onerror = () => finish(false, "connection failed");
    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as [string, string, boolean, string?];
        if (parsed[0] === "OK" && parsed[1] === event.id) finish(parsed[2], parsed[3] ?? "");
      } catch {
        /* relays send other frames too */
      }
    };
  });
}

/** Read a handful of events matching a filter from the first relay that answers. */
function queryRelay(url: string, filter: Record<string, unknown>, timeoutMs = 8000): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let socket: WebSocket;
    const finish = () => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    const subscription = `myna-${Math.random().toString(36).slice(2, 10)}`;

    try {
      socket = new WebSocket(url);
    } catch {
      return finish();
    }

    socket.onopen = () => socket.send(JSON.stringify(["REQ", subscription, filter]));
    socket.onerror = finish;
    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as [string, string, NostrEvent];
        if (parsed[0] === "EVENT" && parsed[1] === subscription) events.push(parsed[2]);
        if (parsed[0] === "EOSE" && parsed[1] === subscription) finish();
      } catch {
        /* ignore */
      }
    };
  });
}

export const nostr: Network = {
  id: "nostr",
  name: "Nostr",
  category: "minor",
  blurb: "Relay-based, no account. Your nsec is the login and stays on this machine.",
  auth: {
    kind: "token",
    note: "Paste your nsec (or 64 hex characters). It is encrypted into the local vault and never sent anywhere except as a signature.",
    fields: [
      { key: "nsec", label: "Secret key", secret: true, placeholder: "nsec1…" },
      { key: "relays", label: "Relays", optional: true, default: DEFAULT_RELAYS.join(","), help: "Comma separated." },
      { key: "name", label: "Display name", optional: true },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: true, delete: true, timeline: true, notifications: false, stats: false, follow: true },

  async login(input) {
    const secret = parseSecretKey(input.nsec);
    const pub = publicKey(secret);
    const npub = bech32Encode("npub", pub);
    return {
      handle: npub,
      displayName: input.name || `${npub.slice(0, 12)}…`,
      creds: { secret: bytesToHex(secret) },
      meta: { relays: input.relays || DEFAULT_RELAYS.join(","), pubkey: bytesToHex(pub) },
    };
  },

  async post(account, input) {
    const secret = hexToBytes(account.creds.secret);
    const tags: string[][] = [];
    if (input.replyTo) tags.push(["e", input.replyTo, "", "reply"]);
    for (const tag of input.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)) tags.push(["t", tag[1].toLowerCase()]);

    const event = buildEvent(secret, 1, input.text, tags);
    const relays = relaysOf(account);
    const results = await Promise.all(relays.map((relay) => publishTo(relay, event)));
    const accepted = results.filter((result) => result.ok).length;
    if (!accepted) {
      throw new Error(`No relay accepted the event (${results.map((r, i) => `${new URL(relays[i]).host}: ${r.message || "rejected"}`).join("; ")})`);
    }
    return { id: event.id, url: `https://njump.me/${bech32Encode("note", hexToBytes(event.id))}` };
  },

  /** NIP-09: deletion is a request other relays may honour, not a guarantee. */
  async remove(account, id) {
    const event = buildEvent(hexToBytes(account.creds.secret), 5, "deleted via myna", [["e", id]]);
    await Promise.all(relaysOf(account).map((relay) => publishTo(relay, event)));
  },

  async timeline(account, limit) {
    for (const relay of relaysOf(account)) {
      const events = await queryRelay(relay, { kinds: [1], limit });
      if (events.length) {
        return events
          .sort((a, b) => b.created_at - a.created_at)
          .map((event): TimelineItem => ({
            id: event.id,
            author: `${event.pubkey.slice(0, 8)}…`,
            handle: bech32Encode("npub", hexToBytes(event.pubkey)).slice(0, 16),
            text: event.content,
            createdAt: new Date(event.created_at * 1000).toISOString(),
            url: `https://njump.me/${bech32Encode("note", hexToBytes(event.id))}`,
          }));
      }
    }
    return [];
  },

  /** NIP-02: who someone follows is the `p` tags of their latest kind 3 event. */
  async following(account, handle, limit) {
    const list = await contactList(account, nostrPubkey(handle));
    if (!list) return [];
    return contactsOf(list).slice(0, limit);
  },

  /**
   * A follow is a new kind 3 that replaces the old one on every relay, so it
   * has to start from the current list or it wipes it. Publishing a list
   * myna could not find would do exactly that on any relay that did have one,
   * so an account with no list on its relays is refused rather than reset.
   */
  async follow(account, handle) {
    const target = nostrPubkey(handle);
    const current = await contactList(account, account.meta.pubkey);
    if (!current) {
      throw new Error(
        "No contact list found on your relays. Follow one person from another Nostr client first, so myna has a list to extend rather than replace.",
      );
    }
    const url = `https://njump.me/${bech32Encode("npub", hexToBytes(target))}`;
    if (current.tags.some((tag) => tag[0] === "p" && tag[1] === target)) return { already: true, id: target, url };

    const event = buildEvent(hexToBytes(account.creds.secret), 3, current.content, [...current.tags, ["p", target]]);
    const relays = relaysOf(account);
    const results = await Promise.all(relays.map((relay) => publishTo(relay, event)));
    if (!results.some((result) => result.ok)) throw new Error("No relay accepted the updated contact list.");
    return { id: event.id, url };
  },
};

/** The newest kind 3 for a pubkey across every relay, since relays disagree about which is current. */
async function contactList(account: Account, pubkey: string): Promise<NostrEvent | undefined> {
  const found = await Promise.all(relaysOf(account).map((relay) => queryRelay(relay, { kinds: [3], authors: [pubkey], limit: 1 })));
  return found
    .flat()
    .filter((event) => event.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];
}

function contactsOf(list: NostrEvent): Profile[] {
  const seen = new Set<string>();
  const out: Profile[] = [];
  for (const tag of list.tags) {
    if (tag[0] !== "p" || !/^[0-9a-f]{64}$/i.test(tag[1] ?? "") || seen.has(tag[1])) continue;
    seen.add(tag[1]);
    const npub = bech32Encode("npub", hexToBytes(tag[1]));
    out.push({ handle: npub, id: tag[1], displayName: tag[3] || undefined, url: `https://njump.me/${npub}` });
  }
  return out;
}

/** A hex pubkey from an npub, 64 hex characters, or an njump / nostr: link carrying one. */
export function nostrPubkey(ref: string): string {
  const trimmed = ref.trim().replace(/^nostr:/, "").replace(/^https?:\/\/[^/]+\//, "");
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub")) {
    const { prefix, bytes } = bech32Decode(trimmed);
    if (prefix === "npub" && bytes.length === 32) return bytesToHex(bytes);
  }
  throw new Error(`Not a Nostr pubkey: ${ref}`);
}

export const nostrInternals = { eventId, buildEvent, parseSecretKey, bigIntTo32Bytes, contactsOf };
