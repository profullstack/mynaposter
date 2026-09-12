/**
 * A text message through Telnyx.
 *
 * One POST to the messaging API with a bearer key. The `from` number has to be
 * on a messaging profile at Telnyx; the API says so in its own words when it
 * is not, and those words are what the caller sees.
 */
export interface SmsConfig {
  apiKey: string;
  /** E.164, +14085550100. */
  from: string;
}

export interface SmsResult {
  id: string;
  to: string;
  /** Segments Telnyx will bill, when it says. */
  parts: number | null;
}

export const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";

/** A number as Telnyx wants it: digits with a leading +, US ten-digit numbers assumed +1. */
export function e164(value: string): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return `+${digits.slice(1).replace(/\D/g, "")}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendSms(config: SmsConfig, to: string, text: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SmsResult> {
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetcher(TELNYX_MESSAGES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ from: e164(config.from), to: e164(to), text }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as { data?: { id?: string; parts?: number }; errors?: Array<{ title?: string; detail?: string }> };
    if (!response.ok) {
      const why = (body.errors ?? []).map((error) => [error.title, error.detail].filter(Boolean).join(": ")).join("; ");
      throw new Error(`Telnyx answered ${response.status}${why ? `: ${why}` : ""}`);
    }
    return { id: body.data?.id ?? "", to: e164(to), parts: typeof body.data?.parts === "number" ? body.data.parts : null };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("Telnyx did not answer in time.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
