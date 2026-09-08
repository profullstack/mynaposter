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
import type { Network } from "@profullstack/myna-core";

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
