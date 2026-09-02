/**
 * The myna HTTP API.
 *
 * Every route mirrors a CLI command, so the API is learnable from `myna help`.
 * Writes require a bearer token; the token is compared in constant time and
 * never logged.
 */
import { Hono } from "hono";
import { timingSafeEqual, createHash } from "node:crypto";
import { hasDatabase, migrate, closeDatabase } from "./db/index.ts";
import { startScheduler, configDir, availableRasterizers, writerAvailable } from "@profullstack/myna-core";
import * as service from "./service.ts";

const app = new Hono();

const VERSION = "0.1.0";

/** Compare without leaking length or position through timing. */
function sameToken(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

app.use("*", async (context, next) => {
  const started = Date.now();
  await next();
  // Method, path and status only. Never the body, which carries post text.
  console.log(`${context.req.method} ${new URL(context.req.url).pathname} ${context.res.status} ${Date.now() - started}ms`);
});

/** Read routes are open when no token is configured; writes never are. */
app.use("/v1/*", async (context, next) => {
  const expected = process.env.MYNA_API_TOKEN;
  const isRead = context.req.method === "GET";

  if (!expected) {
    if (isRead) return next();
    return context.json({ error: "MYNA_API_TOKEN is not set, so this server will not accept writes." }, 503);
  }

  const header = context.req.header("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || !sameToken(supplied, expected)) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

/** Turn a thrown Error into a clean JSON body rather than a stack trace. */
const guard =
  <T>(fn: () => T | Promise<T>) =>
  async (context: { json: (body: unknown, status?: never) => Response }) => {
    try {
      return context.json({ ok: true, ...(await fn()) } as never);
    } catch (error) {
      return context.json({ ok: false, error: (error as Error).message } as never, 400 as never);
    }
  };

app.get("/", (context) =>
  context.json({
    name: "myna",
    version: VERSION,
    docs: "https://mynaposter.com",
    endpoints: [
      "GET  /v1/networks",
      "GET  /v1/accounts",
      "POST /v1/post",
      "POST /v1/schedule",
      "GET  /v1/queue",
      "DELETE /v1/queue/:id",
      "GET  /v1/history",
      "POST /v1/write",
      "GET  /v1/timeline/:target",
    ],
  }),
);

app.get("/health", (context) =>
  context.json({
    ok: true,
    version: VERSION,
    database: hasDatabase() ? "configured" : "local mode",
    rasterizers: availableRasterizers(),
    writer: writerAvailable().ok,
  }),
);

app.get("/v1/networks", guard(() => ({ networks: service.networks() })));
app.get("/v1/accounts", guard(() => ({ accounts: service.accounts() })));
app.get("/v1/queue", guard(() => ({ queue: service.queue() })));

app.get("/v1/history", (context) =>
  guard(() => ({ history: service.history(Number(context.req.query("limit") ?? 50)) }))(context),
);

app.get("/v1/timeline/:target", (context) =>
  guard(() => service.timeline(context.req.param("target"), Number(context.req.query("limit") ?? 20)))(context),
);

app.post("/v1/post", async (context) => {
  const body = await context.req.json().catch(() => ({}));
  return guard(() => service.post(body))(context);
});

app.post("/v1/schedule", async (context) => {
  const body = await context.req.json().catch(() => ({}));
  return guard(() => ({ queued: service.schedule(body) }))(context);
});

app.delete("/v1/queue/:id", (context) =>
  guard(() => {
    if (!service.cancel(context.req.param("id"))) throw new Error("No queued post with that id.");
    return { cancelled: context.req.param("id") };
  })(context),
);

app.post("/v1/write", async (context) => {
  const body = await context.req.json().catch(() => ({}));
  return guard(async () => ({ drafts: await service.write(body) }))(context);
});

app.notFound((context) => context.json({ ok: false, error: "Not found" }, 404));

const port = Number(process.env.PORT ?? 8787);

await migrate().catch((error: Error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});

// The hosted scheduler. Off unless asked for, so a read-only deployment does
// not start posting on its own.
if (process.env.MYNA_SCHEDULER === "1") {
  startScheduler(Number(process.env.MYNA_SCHEDULER_INTERVAL ?? 30) * 1000, (runs) => {
    for (const run of runs) console.log(`scheduler ${run.post.id}: ${run.results.filter((r) => r.ok).length}/${run.results.length}`);
  });
  console.log("Scheduler on.");
}

console.log(`myna api ${VERSION} on :${port} (${hasDatabase() ? "postgres" : "local mode"}, config ${configDir()})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeDatabase().finally(() => process.exit(0));
  });
}

export default { port, fetch: app.fetch };
