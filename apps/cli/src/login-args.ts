/**
 * Login values taken off the command line.
 *
 * `myna login tsbb https://bbs.hqtui.com/ --forum app-showcase` should not stop
 * to ask for a board URL it was just handed. Bare words fill the network's auth
 * fields in the order the adapter declares them, skipping any field a `--flag`
 * of the same name already answered, so the two spellings mix and the common
 * one-argument case — `myna login tsbb <site>` — needs no flag at all.
 *
 * Shared by the CLI and the TUI so `/login tsbb <site>` prefills the same
 * dialog the CLI fills in silently.
 */
import type { Account, Network } from "@profullstack/myna-core";

export function loginValuesFromArgs(
  network: Network,
  words: string[],
  flags: Record<string, unknown> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of network.auth.fields) {
    const flagged = flags[field.key];
    if (typeof flagged === "string" && flagged.trim()) values[field.key] = flagged.trim();
  }

  const queue = words.map((word) => word.trim()).filter(Boolean);
  for (const field of network.auth.fields) {
    if (!queue.length) break;
    if (values[field.key]) continue;
    values[field.key] = queue.shift() as string;
  }
  // Silently dropping the extra would log you in to the wrong thing, and a
  // mistyped flag arrives here as a bare word.
  if (queue.length) {
    throw new Error(
      `${network.id} takes at most ${network.auth.fields.length} login value(s), in this order: ` +
        `${network.auth.fields.map((field) => field.key).join(", ")}. Left over: ${queue.join(" ")}`,
    );
  }
  return values;
}

/** The part of an account a re-login reads: which network, and what it holds. */
export type KeptSource = Pick<Account, "id" | "network" | "creds" | "meta">;

/**
 * Login values a re-login keeps from the account already connected.
 *
 * A field marked `reuse` (the client id and secret a Google app was
 * registered with) is copied from the one account of that network in the
 * vault, unless the command line already answered it, so renewing an expired
 * sign-in is `myna login gcal` and one browser click. With several accounts
 * on the network nothing is guessed: the wrong client would sign the right
 * person in to the wrong app. Credentials are read first, then metadata (a
 * calendar id lives there).
 */
export function keptLoginValues(
  network: Network,
  accounts: readonly KeptSource[],
  given: Record<string, string> = {},
): { values: Record<string, string>; from: string | null } {
  const mine = accounts.filter((account) => account.network === network.id);
  if (mine.length !== 1) return { values: {}, from: null };
  const [account] = mine;
  const values: Record<string, string> = {};
  for (const field of network.auth.fields) {
    if (!field.reuse || given[field.key]) continue;
    const held = (account.creds as Record<string, unknown>)?.[field.key] ?? (account.meta as Record<string, unknown>)?.[field.key];
    if (typeof held === "string" && held.trim()) values[field.key] = held.trim();
  }
  return { values, from: Object.keys(values).length ? account.id : null };
}
