/**
 * The c0mpute backend for the writer, and myna's default.
 *
 * c0mpute is our own peer network, reached through Infernet, so a draft costs
 * a fraction of a cent against what our nodes earned instead of a frontier
 * bill. It needs no key to work: without one the public allowance is ten
 * queries a day, and `C0MPUTE_API_KEY` (an `ik_live_` account key) lifts that.
 *
 * It is slower than Claude — tens of seconds for a long draft, not a couple —
 * which is why the timeout here is generous. Drafting is not interactive.
 */
import { createAiProviders, type AiRouter } from "@profullstack/ai-providers";
import type { CompletionRequest } from "./anthropic.ts";

/** Big enough for a peer node writing several networks' drafts at once. */
const DEFAULT_TIMEOUT_MS = 240_000;

let router: AiRouter | undefined;

/**
 * The shared router, built once so its circuit breaker and its alternating
 * fallback order see every call this process makes.
 */
export function aiRouter(): AiRouter {
  router ??= createAiProviders({
    c0mpute: { timeoutMs: DEFAULT_TIMEOUT_MS },
    anthropic: { model: process.env.AI_ANTHROPIC_MODEL || "claude-opus-5" },
  });
  return router;
}

/** Only for tests, which need a fresh breaker per case. */
export function resetRouter(): void {
  router = undefined;
}

/**
 * One completion from c0mpute, falling back to a paid provider only when a
 * paid key is set.
 *
 * `model` is the setting's model name, which names a Claude model, so it is
 * deliberately not forwarded: c0mpute picks from its own house models.
 */
export async function completeC0mpute({
  system,
  prompt,
  maxTokens = 4000,
}: Omit<CompletionRequest, "model"> & { model?: string }): Promise<string> {
  const res = await aiRouter().generateText({
    system,
    user: prompt,
    maxTokens,
    feature: "myna.writer",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return res.text.trim();
}

/**
 * c0mpute is always available: with no key it still answers ten times a day,
 * which is enough to draft with, and the error when that runs out says so.
 */
export function hasCredentials(): boolean {
  return true;
}
