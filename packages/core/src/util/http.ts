/** Fetch wrappers that fail with a message a person can act on. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} ${shortUrl(url)}${body ? ` — ${firstLine(body)}` : ""}`);
    this.name = "HttpError";
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** APIs return HTML error pages and 4KB JSON blobs; neither belongs in a TUI toast. */
function firstLine(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["error_description", "error", "message", "msg", "detail", "errors"]) {
      const value = parsed[key];
      if (typeof value === "string" && value) return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string") return nested;
      }
    }
  } catch {
    /* not JSON */
  }
  return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export const USER_AGENT = "myna/0.1.0 (+https://github.com/profullstack/myna)";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | URLSearchParams;
  timeoutMs?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: { "user-agent": USER_AGENT, ...options.headers },
      body: options.body as never,
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpError(response.status, url, await response.text().catch(() => ""));
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as Error).name === "AbortError") throw new Error(`Timed out after ${(options.timeoutMs ?? 30_000) / 1000}s: ${shortUrl(url)}`);
    throw new Error(`${(error as Error).message} (${shortUrl(url)})`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  return (await request(url, options)).json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, {
    ...options,
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function postForm<T>(url: string, form: Record<string, string>, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, {
    ...options,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...options.headers },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Normalize "mastodon.social" or "https://mastodon.social/" to "https://mastodon.social". */
export function normalizeInstance(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Instance URL is required");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
