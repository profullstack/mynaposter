/**
 * myna dashboard: a local page for what went out, what is queued, and which
 * network is holding.
 *
 *   myna dashboard                 serve on 7777 and open a browser
 *   myna dashboard --port 9000     somewhere else
 *   myna dashboard --no-open       just serve it
 *   myna dashboard --json          print one snapshot and exit
 *
 * It binds 127.0.0.1 and nothing else. The page reads a person's whole posting
 * history, so putting it on a public interface would be handing that to anyone
 * who found the port; there is no token and no login because there is no
 * network exposure to guard.
 */
import {
  listAccounts,
  listEngagement,
  listHistory,
  listQueue,
  loadSettings,
  openBrowser,
  type MynaPlugin,
  type PluginContext,
} from "@profullstack/myna-core";
import { readSnapshot, type Snapshot } from "./snapshot.ts";
import { page } from "./page.ts";

export const DEFAULT_PORT = 7777;

/** One snapshot from the live stores. */
export function snapshot(now?: number): Snapshot {
  return readSnapshot({
    history: listHistory,
    queue: listQueue,
    accounts: listAccounts,
    engagement: listEngagement,
    settings: loadSettings,
    now,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Route one request. Exported so a test can drive it without a socket. */
export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/snapshot") {
    try {
      return json(snapshot());
    } catch (error) {
      // A locked vault is the usual cause: the page says so rather than dying.
      return json({ error: (error as Error).message }, 503);
    }
  }
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response("Not found", { status: 404 });
}

function readPort(flags: Record<string, unknown>): number {
  const raw = flags.port;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port wants a number between 1 and 65535, not "${String(raw)}".`);
  return port;
}

const dashboard: MynaPlugin = {
  id: "dashboard",
  name: "Dashboard",
  version: "0.9.0",
  description: "A local dashboard: the queue, the drip, what each network is holding, and what went out.",
  commands: [
    {
      name: "dashboard",
      summary: "Open a local dashboard: the queue, the drip and what each network is holding",
      usage: [
        "myna dashboard                 serve on 127.0.0.1:7777 and open it",
        "myna dashboard --port 9000     serve somewhere else",
        "myna dashboard --no-open       serve without opening a browser",
        "myna dashboard --json          print one snapshot and exit",
      ],
      async run(_args: string[], ctx: PluginContext) {
        const port = readPort(ctx.flags);

        if (ctx.flags.json) {
          ctx.out(JSON.stringify(snapshot(), null, 2));
          return 0;
        }

        // Fail before binding when the vault is locked, so the person gets the
        // real message here rather than a broken page in a browser tab.
        snapshot();

        const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });
        const url = `http://127.0.0.1:${server.port}`;
        ctx.out(`Dashboard on ${url}`);
        ctx.out("Reading the queue, the history and the pacing rules. Ctrl+C to stop.");
        if (ctx.flags.noOpen !== true && ctx.flags.open !== "false") {
          try {
            await openBrowser(url);
          } catch {
            ctx.out("Could not open a browser; the URL above works.");
          }
        }

        await new Promise<void>((resolve) => {
          const quit = () => {
            server.stop();
            resolve();
          };
          process.once("SIGINT", quit);
          process.once("SIGTERM", quit);
        });
        return 0;
      },
    },
  ],
};

export default dashboard;
export { buildSnapshot, readSnapshot, slotFor, horizonFor, NETWORK_SLOT_ORDER } from "./snapshot.ts";
export type { Snapshot, NetworkState, QueueRow, HistoryRow } from "./snapshot.ts";
export { page } from "./page.ts";
