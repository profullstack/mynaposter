/**
 * `myna connect`: OpenConnection (https://logicsrc.com/openconnection) from
 * the terminal.
 *
 *   myna connect token [--scopes a,b] [--minutes 15] [--json]
 *   myna connect apps [--all] [--json]
 *   myna connect revoke <id>
 *
 * A setup token is what you paste into an app such as DefPromo; the app
 * claims it once and acts through myna cloud with a bearer of its own. The
 * apps list is who holds one, and revoke cuts one off. Needs a cloud
 * session: `myna cloud login`.
 */
import { cloud } from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const base = (): string => (cloud.session()?.server ?? process.env.MYNA_SERVER ?? cloud.DEFAULT_SERVER).replace(/\/+$/, "");

async function call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = cloud.requireSession();
  const reply = await fetch(`${base()}${path}`, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await reply.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!reply.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${reply.status}`);
  return data;
}

interface ConnectedApp {
  id: string;
  app: { name?: string; url?: string; version?: string };
  scopes: string[];
  issuedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  reclaims: number;
}

const stamp = (iso: string | null): string => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

export async function runConnect(positional: string[], flags: Flags): Promise<number> {
  const [sub = "token", ...rest] = positional;
  const json = flags.json === true;

  switch (sub) {
    case "token":
    case "setup": {
      const scopes = typeof flags.scopes === "string" ? flags.scopes : undefined;
      const minutes = flags.minutes !== undefined ? Number(flags.minutes) : undefined;
      const made = await call<{ token: string; expires: string; scopes: string[]; claimUrl: string }>("/v1/openconnection/setup", { body: { scopes, minutes } });
      if (json) {
        out(JSON.stringify({ token: made.token, expires: made.expires, scopes: made.scopes }, null, 2));
        return 0;
      }
      out(made.token);
      out("");
      out(`Paste that into the app (DefPromo: Settings, Provider, myna). It works once and expires ${stamp(made.expires)} UTC.`);
      out(`Scopes: ${made.scopes.join(", ")}`);
      return 0;
    }

    case "apps":
    case "list":
    case "ls": {
      const { apps } = await call<{ apps: ConnectedApp[] }>(`/v1/openconnection/apps${flags.all === true ? "?all=1" : ""}`);
      if (json) {
        out(JSON.stringify(apps, null, 2));
        return 0;
      }
      if (!apps.length) {
        out("No app holds a connection. myna connect token makes one to paste.");
        return 0;
      }
      for (const app of apps) {
        const name = app.app.name ?? "(unnamed app)";
        const state = app.revokedAt ? "revoked" : "active";
        out(`${app.id}  ${state.padEnd(7)}  ${stamp(app.issuedAt)}  ${name}${app.app.url ? `  ${app.app.url}` : ""}`);
        out(`          scopes ${app.scopes.join(", ")}; last used ${stamp(app.lastUsedAt)}${app.reclaims ? `; setup token claimed again ${app.reclaims}x after use: revoke this` : ""}`);
      }
      return 0;
    }

    case "revoke":
    case "rm": {
      const id = rest[0];
      if (!id) throw new Error("Usage: myna connect revoke <id>   (ids from: myna connect apps)");
      await call(`/v1/openconnection/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
      out(`Revoked ${id}. Its next call is refused.`);
      return 0;
    }

    default:
      throw new Error(`Unknown connect command: ${sub}. Try: token, apps, revoke.`);
  }
}
