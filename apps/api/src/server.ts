/**
 * The myna HTTP API.
 *
 * Every route mirrors a CLI command, so the API is learnable from `myna help`.
 * Writes require a bearer token; the token is compared in constant time and
 * never logged.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hasDatabase, migrate, closeDatabase } from "./db/index.ts";
import {
  startScheduler,
  configDir,
  availableRasterizers,
  writerAvailable,
  fetchPage,
  readSiteFiles,
  projectCopy,
  variations,
  suggestPlaces,
  type ProjectBrief,
} from "@profullstack/myna-core";
import * as service from "./service.ts";
import { handleMcpBody } from "./mcp.ts";
import * as cloud from "./cloud.ts";
import * as reshare from "./reshare.ts";
import * as atproto from "./atproto.ts";
import * as handoff from "./handoff.ts";
import * as oc from "./openconnection.ts";
import { store as synconfigStore } from "./synconfig.ts";
import { handleGet as synconfigGet, handlePut as synconfigPut, handleRevisions as synconfigRevisions } from "@profullstack/synconfig/server";
import { VERSION } from "@profullstack/myna-core";

const app = new Hono();



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
  // Cloud routes carry their own auth: MYNA_API_TOKEN is the operator driving
  // this instance, while those belong to an end user with an account. Running
  // both would mean nobody could sign up without the operator's token.
  const path = new URL(context.req.url).pathname;
  if (path.startsWith("/v1/cloud") || path.startsWith("/v1/reshare") || path.startsWith("/v1/atproto") || path.startsWith("/v1/handoff") || path.startsWith("/v1/synconfig") || path.startsWith("/v1/syncfg") || path.startsWith("/v1/openconnection")) return next();

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

/**
 * MCP over HTTP, for an agent that cannot launch a subprocess.
 *
 * Always authenticated, unlike the read routes below. tools/call can publish,
 * so an open MCP endpoint would be an open posting endpoint, and the fact that
 * the caller has to name a tool first is not a security boundary.
 */
app.post("/api/mcp", async (context) => {
  const expected = process.env.MYNA_API_TOKEN;
  if (!expected) {
    return context.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server has no MYNA_API_TOKEN set, so MCP is disabled." } },
      503,
    );
  }

  const header = context.req.header("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || !sameToken(supplied, expected)) {
    return context.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const reply = await handleMcpBody(body);
  // A notification gets no body at all, which is what 202 is for.
  return reply === null ? context.body(null, 202) : context.json(reply);
});

/**
 * The OpenMCP descriptor (https://logicsrc.com/openmcp): where the MCP endpoint
 * is, how to authenticate to it, and which catalogs list it.
 *
 * One file, kept with the site's assets because mynaposter.com is the origin a
 * catalog probes and the site serves it as a static file; this route is the
 * same bytes from the API's own origin. Read on every request so a redeploy is
 * enough to change it. Public, unlike /api/mcp itself: a catalog verifies the
 * listing with no token.
 */
const OPENMCP_DESCRIPTOR = new URL("../../web/assets/.well-known/openmcp.json", import.meta.url);

app.get("/.well-known/openmcp.json", (context) => {
  let body: string;
  try {
    body = readFileSync(OPENMCP_DESCRIPTOR, "utf8");
  } catch {
    return context.json({ ok: false, error: "Not found" }, 404);
  }
  return context.body(body, 200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
});

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
      "GET  /v1/search/:target?q=",
      "POST /api/mcp",
      "POST /v1/cloud/signup",
      "POST /v1/cloud/login",
      "GET  /v1/cloud/me",
      "PUT  /v1/cloud/backup",
      "GET  /v1/cloud/backup",
      "PUT  /v1/reshare/profile",
      "GET  /v1/reshare/profile",
      "POST /v1/reshare/requests",
      "GET  /v1/reshare/requests",
      "GET  /v1/reshare/matches",
      "POST /v1/reshare/claims",
      "PATCH /v1/reshare/claims/:id",
      "GET  /v1/reshare/ledger",
      "GET  /v1/atproto?kind=&online=1&q=",
      "POST /v1/atproto {url, description?, tags?}",
      "POST /v1/atproto/:id/refresh",
      "DELETE /v1/atproto/:id",
      "GET  /v1/handoff/:id",
      "POST /v1/handoff {place, title, text, openUrl?, steps?, account?}",
      "POST /v1/handoff/:id/done {done?}",
      "GET  /v1/handoff?all=1",
      "DELETE /v1/handoff/:id",
      "GET  /v1/synconfig            (alias /v1/syncfg)",
      "PUT  /v1/synconfig {snapshot, ifRevision}",
      "GET  /v1/synconfig/revisions",
    ],
    mcp: { endpoint: "/api/mcp", transport: "streamable-http", tools: 11 },
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

app.get("/v1/search/:target", (context) =>
  guard(() =>
    service.search(context.req.param("target"), context.req.query("q") ?? "", Number(context.req.query("limit") ?? 10)),
  )(context),
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

/**
 * Cloud backup. Entirely optional, and needs the database.
 *
 * These routes sit outside the /v1/* token middleware because they carry their
 * own auth: the operator's MYNA_API_TOKEN is for driving this instance, while
 * these belong to an end user with an account.
 */
const cloudRoutes = new Hono();

cloudRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) {
    return context.json({ ok: false, error: "This instance has no DATABASE_URL, so cloud backup is off." }, 503);
  }
  return next();
});

/** Resolve the caller, or answer 401. */
async function requireUser(context: { req: { header(name: string): string | undefined } }) {
  const header = context.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return cloud.whoami(token);
}

const body = async (context: { req: { json(): Promise<unknown> } }) =>
  (await context.req.json().catch(() => ({}))) as Record<string, string>;

cloudRoutes.post("/signup", async (context) => {
  try {
    const input = await body(context);
    const { user, token } = await cloud.signup(input.email, input.password);
    return context.json({ ok: true, email: user.email, token });
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 400);
  }
});

cloudRoutes.post("/login", async (context) => {
  try {
    const input = await body(context);
    const { user, token } = await cloud.login(input.email, input.password);
    return context.json({ ok: true, email: user.email, token });
  } catch (error) {
    // 401 rather than 400: it is a rejected credential, not a malformed request.
    return context.json({ ok: false, error: (error as Error).message }, 401);
  }
});

cloudRoutes.post("/logout", async (context) => {
  const header = context.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return context.json({ ok: await cloud.logout(token) });
});

cloudRoutes.get("/me", async (context) => {
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  const status = await cloud.backupStatus(user.id);
  return context.json({ ok: true, email: user.email, backup: status });
});

cloudRoutes.put("/backup", async (context) => {
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  try {
    const input = (await context.req.json().catch(() => ({}))) as { blob?: string; meta?: Record<string, unknown> };
    if (!input.blob) throw new Error("Send the sealed bundle as `blob`.");
    const saved = await cloud.putBackup(user.id, input.blob, input.meta ?? null);
    return context.json({ ok: true, ...saved });
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 400);
  }
});

cloudRoutes.get("/backup", async (context) => {
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  const backup = await cloud.getBackup(user.id);
  if (!backup) return context.json({ ok: false, error: "No backup stored yet." }, 404);
  return context.json({ ok: true, ...backup });
});

cloudRoutes.delete("/backup", async (context) => {
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  return context.json({ ok: await cloud.deleteBackup(user.id) });
});

app.route("/v1/cloud", cloudRoutes);

/**
 * The reshare network. Same sign-in as cloud backup, same database, and the
 * same rule: the server never holds a social token. It matches profiles to
 * requests and keeps score; every reshare is done by a sharer's own myna.
 */
const reshareRoutes = new Hono<{ Variables: { user: cloud.CloudUser } }>();

reshareRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) {
    return context.json({ ok: false, error: "This instance has no DATABASE_URL, so the reshare network is off." }, 503);
  }
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  context.set("user", user);
  return next();
});

const userOf = (context: { get(key: "user"): cloud.CloudUser }): cloud.CloudUser => context.get("user");

/** Run one call and shape the answer, with a thrown Error as a clean 400. */
const answer =
  <T>(fn: () => Promise<T>) =>
  async (context: { json: (body: unknown, status?: never) => Response }) => {
    try {
      return context.json({ ok: true, ...(await fn()) } as never);
    } catch (error) {
      return context.json({ ok: false, error: (error as Error).message } as never, 400 as never);
    }
  };

reshareRoutes.put("/profile", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { markdown?: string };
  return answer(async () => ({ profile: await reshare.putProfile(userOf(context).id, input.markdown ?? "") }))(context);
});

reshareRoutes.get("/profile", (context) => answer(async () => ({ profile: await reshare.getProfile(userOf(context).id) }))(context));

reshareRoutes.get("/profile.md", async (context) => {
  const markdown = await reshare.getProfileMarkdown(userOf(context).id);
  if (markdown === null) return context.json({ ok: false, error: "No profile published." }, 404);
  return context.body(markdown, 200, { "content-type": "text/markdown; charset=utf-8" });
});

reshareRoutes.delete("/profile", (context) => answer(async () => ({ left: await reshare.leave(userOf(context).id) }))(context));

reshareRoutes.post("/requests", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as reshare.RequestInput;
  return answer(() => reshare.createRequest(userOf(context).id, input))(context);
});

reshareRoutes.get("/requests", (context) => answer(async () => ({ requests: await reshare.listRequests(userOf(context).id) }))(context));

reshareRoutes.delete("/requests/:id", (context) =>
  answer(async () => ({ closed: await reshare.closeRequest(userOf(context).id, context.req.param("id")) }))(context),
);

reshareRoutes.get("/matches", (context) =>
  answer(async () => ({ matches: await reshare.matchesFor(userOf(context).id, Number(context.req.query("limit") ?? 10)) }))(context),
);

reshareRoutes.post("/claims", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { requestId?: string; network?: string };
  return answer(async () => ({ claim: await reshare.claim(userOf(context).id, input.requestId ?? "", input.network ?? "") }))(context);
});

reshareRoutes.patch("/claims/:id", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
  return answer(async () => {
    if (!(await reshare.report(userOf(context).id, context.req.param("id"), input))) throw new Error("No claim of yours awaiting a report with that id.");
    return { reported: true };
  })(context);
});

reshareRoutes.patch("/claims/:id/paid", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { ref?: string };
  return answer(async () => {
    if (!(await reshare.markPaid(userOf(context).id, context.req.param("id"), input.ref ?? ""))) {
      throw new Error("No unpaid, done claim on a request of yours with that id.");
    }
    return { paid: true };
  })(context);
});

reshareRoutes.get("/ledger", (context) => answer(() => reshare.ledger(userOf(context).id))(context));

app.route("/v1/reshare", reshareRoutes);

/**
 * The atproto directory: PDSes, relays, feed generators and labelers, listed
 * by anyone with a myna cloud account, probed before they are shown, at
 * mynaposter.com/listing/atproto. Reading is public.
 */
const atprotoRoutes = new Hono<{ Variables: { user: cloud.CloudUser | null } }>();

atprotoRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ ok: false, error: "This instance has no DATABASE_URL, so the atproto directory is off." }, 503);
  context.set("user", context.req.method === "GET" ? null : await requireUser(context));
  return next();
});

atprotoRoutes.get("/", async (context) => {
  try {
    const servers = await atproto.listServers({
      kind: context.req.query("kind") || undefined,
      online: context.req.query("online") === "1",
      q: context.req.query("q") || undefined,
    });
    return context.json({ ok: true, servers, total: servers.length });
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 500);
  }
});

atprotoRoutes.post("/", async (context) => {
  const user = context.get("user");
  if (!user) return context.json({ ok: false, error: "Sign in with myna cloud login to list a server." }, 401);
  try {
    const input = (await context.req.json().catch(() => ({}))) as { url?: string; description?: string; tags?: unknown };
    return context.json({ ok: true, server: await atproto.addServer(user.id, input) }, 201);
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 400);
  }
});

atprotoRoutes.post("/:id/refresh", async (context) => {
  if (!context.get("user")) return context.json({ ok: false, error: "Unauthorized" }, 401);
  const server = await atproto.refreshServer(context.req.param("id"));
  return server ? context.json({ ok: true, server }) : context.json({ ok: false, error: "No such server." }, 404);
});

atprotoRoutes.delete("/:id", async (context) => {
  const user = context.get("user");
  const header = context.req.header("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const operator = Boolean(process.env.MYNA_API_TOKEN) && supplied !== "" && sameToken(supplied, process.env.MYNA_API_TOKEN as string);
  if (!user && !operator) return context.json({ ok: false, error: "Unauthorized" }, 401);
  try {
    const removed = await atproto.removeServer(context.req.param("id"), user?.id ?? null, operator);
    return removed ? context.json({ ok: true }) : context.json({ ok: false, error: "No such server." }, 404);
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 403);
  }
});

app.route("/v1/atproto", atprotoRoutes);

// Every listed atproto server is probed again every half hour, so "online"
// means recently. Only where there is a database to hold the list.
if (hasDatabase()) {
  setInterval(() => {
    void atproto.refreshAll().then((r) => console.log(`atproto refresh: ${r.online}/${r.probed} online`)).catch((error: Error) => console.error(`atproto refresh failed: ${error.message}`));
  }, 30 * 60_000).unref();
}

/**
 * Hand-offs: the steps only a person can do, as cards at
 * mynaposter.com/handoff/<id>. Made by a signed-in myna cloud user; read and
 * marked done by anyone holding the link, which is 128 random bits and the
 * whole secret. Listing and deleting are the owner's.
 */
const handoffRoutes = new Hono<{ Variables: { user: cloud.CloudUser | null } }>();

handoffRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ ok: false, error: "This instance has no DATABASE_URL, so hand-offs are off." }, 503);
  const path = new URL(context.req.url).pathname.replace(/\/+$/, "");
  const readOne = context.req.method === "GET" && path !== "/v1/handoff";
  const markDone = context.req.method === "POST" && path.endsWith("/done");
  context.set("user", readOne || markDone ? null : await requireUser(context));
  return next();
});

handoffRoutes.get("/", async (context) => {
  const user = context.get("user");
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  const handoffs = await handoff.listHandoffs(user.id, { all: context.req.query("all") === "1" });
  return context.json({ ok: true, handoffs, total: handoffs.length });
});

handoffRoutes.get("/:id", async (context) => {
  const card = await handoff.getHandoff(context.req.param("id"));
  return card ? context.json({ ok: true, handoff: card }) : context.json({ ok: false, error: "No such hand-off." }, 404);
});

handoffRoutes.post("/", async (context) => {
  const user = context.get("user");
  if (!user) return context.json({ ok: false, error: "Sign in with myna cloud login to publish a hand-off." }, 401);
  try {
    const input = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
    return context.json({ ok: true, handoff: await handoff.createHandoff(user.id, input) }, 201);
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 400);
  }
});

handoffRoutes.post("/:id/done", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { done?: unknown };
  const card = await handoff.finishHandoff(context.req.param("id"), input.done !== false);
  return card ? context.json({ ok: true, handoff: card }) : context.json({ ok: false, error: "No such hand-off." }, 404);
});

handoffRoutes.delete("/:id", async (context) => {
  const user = context.get("user");
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  try {
    const removed = await handoff.removeHandoff(context.req.param("id"), user.id);
    return removed ? context.json({ ok: true }) : context.json({ ok: false, error: "No such hand-off." }, 404);
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 403);
  }
});

app.route("/v1/handoff", handoffRoutes);

/**
 * Settings sync: a user's settings.json, OpenProfile and skills as one
 * snapshot under a revision, so every machine signed in to the same account
 * sees the same myna. The handlers and the conflict rule live in
 * @profullstack/synconfig; this only wires them to a Postgres store and the
 * cloud user. /v1/syncfg is the same thing under the short name.
 */
const synconfigRoutes = new Hono<{ Variables: { user: cloud.CloudUser } }>();

synconfigRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ ok: false, error: "This instance has no DATABASE_URL, so settings sync is off." }, 503);
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  context.set("user", user);
  return next();
});

synconfigRoutes.get("/", async (context) => {
  const reply = await synconfigGet(synconfigStore, context.get("user").id);
  return context.json(reply.body, reply.status as 200);
});

synconfigRoutes.put("/", async (context) => {
  const body = await context.req.json().catch(() => ({}));
  const reply = await synconfigPut(synconfigStore, context.get("user").id, body);
  return context.json(reply.body, reply.status as 200);
});

synconfigRoutes.get("/revisions", async (context) => {
  const reply = await synconfigRevisions(synconfigStore, context.get("user").id);
  return context.json(reply.body, reply.status as 200);
});

app.route("/v1/synconfig", synconfigRoutes);
app.route("/v1/syncfg", synconfigRoutes);

/**
 * OpenConnection (https://logicsrc.com/openconnection): the door an app that
 * cannot register walks through. A signed-in person makes a setup token at
 * /v1/openconnection/setup (or mynaposter.com/connect), pastes it into the
 * app, and the app claims it once at /openconnection/claim/<secret> for a
 * bearer of its own. From then on the app acts under /openconnection/v1
 * with that bearer, scoped to what the person chose, revocable from the
 * person's list. CORS is open on these routes because the bearer is the
 * credential and no cookie is involved: a browser extension is the first
 * app, and it has no origin a server could allowlist.
 */
app.get("/.well-known/openconnection.json", (context) =>
  context.json(oc.descriptor(handoff.siteUrl()), 200, {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  }),
);

const ocPersonRoutes = new Hono<{ Variables: { user: cloud.CloudUser } }>();

ocPersonRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ ok: false, error: "This instance has no DATABASE_URL, so OpenConnection is off." }, 503);
  const user = await requireUser(context);
  if (!user) return context.json({ ok: false, error: "Unauthorized" }, 401);
  context.set("user", user);
  return next();
});

ocPersonRoutes.get("/", (context) => context.json({ ok: true, descriptor: oc.descriptor(handoff.siteUrl()) }));

ocPersonRoutes.post("/setup", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { scopes?: unknown; minutes?: unknown };
  try {
    return context.json({ ok: true, ...(await oc.issueSetup(context.get("user").id, input)) }, 201);
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 400);
  }
});

ocPersonRoutes.get("/apps", async (context) => {
  const apps = await oc.listApps(context.get("user").id, { all: context.req.query("all") === "1" });
  return context.json({ ok: true, apps, total: apps.length });
});

ocPersonRoutes.delete("/apps/:id", async (context) => {
  const removed = await oc.revokeApp(context.get("user").id, context.req.param("id"));
  return removed ? context.json({ ok: true }) : context.json({ ok: false, error: "No such connection." }, 404);
});

app.route("/v1/openconnection", ocPersonRoutes);

type OcEnv = { Variables: { connection: oc.Connection } };
const ocRoutes = new Hono<OcEnv>();

ocRoutes.use(
  "*",
  cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], maxAge: 600 }),
);

ocRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ error: "unavailable", message: "This instance has no DATABASE_URL, so OpenConnection is off." }, 503);
  return next();
});

ocRoutes.post("/claim/:secret", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { app?: unknown };
  try {
    return context.json(await oc.claim(context.req.param("secret"), input.app));
  } catch (error) {
    if (error instanceof oc.ClaimError) return context.json({ error: error.code, message: error.message }, error.status);
    return context.json({ error: "claim", message: (error as Error).message }, 400);
  }
});

const ocAuth: MiddlewareHandler<OcEnv> = async (context, next) => {
  const header = context.req.header("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  try {
    context.set("connection", await oc.authenticate(bearer));
  } catch (error) {
    if (error instanceof oc.AuthError) return context.json({ error: error.code, message: error.message }, 401);
    throw error;
  }
  return next();
};
ocRoutes.use("/v1", ocAuth);
ocRoutes.use("/v1/*", ocAuth);

const scoped =
  (scope: string): MiddlewareHandler<OcEnv> =>
  async (context, next) => {
    if (!oc.hasScope(context.get("connection").scopes, scope)) {
      return context.json({ error: "scope", scope, message: `This connection lacks ${scope}. Ask the person for a setup token that carries it.` }, 403);
    }
    return next();
  };

// The bridge pays for every model call, so writes are metered per connection.
const ocWriteLimiter = new oc.RateLimiter(Number(process.env.OC_WRITES_PER_HOUR ?? 60), 60 * 60 * 1000);
const ocReadLimiter = new oc.RateLimiter(Number(process.env.OC_READS_PER_HOUR ?? 600), 60 * 60 * 1000);

const limited =
  (limiter: oc.RateLimiter): MiddlewareHandler<OcEnv> =>
  async (context, next) => {
    const taken = limiter.take(context.get("connection").id);
    if (!taken.ok) {
      return context.json({ error: "rate_limited", message: `Too many requests; try again in ${taken.retryAfter}s.` }, 429, { "retry-after": String(taken.retryAfter) });
    }
    return next();
  };

const writerGate: MiddlewareHandler<OcEnv> = async (context, next) => {
  const state = writerAvailable();
  if (!state.ok) return context.json({ error: "writer", message: state.reason ?? "The writer is off on this bridge." }, 503);
  return next();
};

const briefOf = (input: unknown): ProjectBrief | null => {
  const project = (input && typeof input === "object" ? input : null) as Record<string, unknown> | null;
  if (!project || typeof project.name !== "string" || !project.name.trim()) return null;
  return {
    name: project.name.trim().slice(0, 200),
    description: typeof project.description === "string" ? project.description.slice(0, 2000) : "",
    audience: typeof project.audience === "string" ? project.audience.slice(0, 500) : undefined,
    features: Array.isArray(project.features) ? project.features.map(String).slice(0, 10) : undefined,
    tone: typeof project.tone === "string" ? project.tone.slice(0, 40) : undefined,
    url: typeof project.url === "string" && /^https?:\/\//.test(project.url) ? project.url.slice(0, 500) : undefined,
  };
};

ocRoutes.get("/v1/info", limited(ocReadLimiter), async (context) => {
  const connection = context.get("connection");
  return context.json({
    versions: [...oc.VERSIONS],
    profiles: [...oc.PROFILES],
    scopes: connection.scopes,
    principal: { name: await oc.principalName(connection.userId) },
    app: connection.app,
    issued: connection.issuedAt,
    expires: connection.expiresAt,
  });
});

ocRoutes.get("/v1/accounts", limited(ocReadLimiter), scoped("accounts:read"), async (context) =>
  context.json(await oc.accountsFor(context.get("connection").userId)),
);

const ocLeave: MiddlewareHandler<OcEnv> = async (context) => {
  await oc.revokeToken(context.get("connection").id);
  return context.json({ ok: true, revoked: true });
};
ocRoutes.delete("/v1", ocLeave);
ocRoutes.delete("/v1/", ocLeave);

ocRoutes.post("/v1/analyze", limited(ocWriteLimiter), scoped("analyze:create"), writerGate, async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url || !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) return context.json({ error: "url", message: "analyze needs a URL." }, 400);
  try {
    const [files, page] = await Promise.all([readSiteFiles(url), fetchPage(url)]);
    const copy = await projectCopy({ page, openprofile: files.openprofile, llms: files.llms });
    return context.json({ ...copy, url: page.url, image: page.image || null, read_from: [...files.readFrom, "html"] });
  } catch (error) {
    return context.json({ error: "analyze", message: (error as Error).message }, 502);
  }
});

ocRoutes.post("/v1/write", limited(ocWriteLimiter), scoped("write:create"), writerGate, async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
  const project = briefOf(input.project);
  if (!project) return context.json({ error: "project", message: "write needs a project with a name." }, 400);
  const raw = input.context && typeof input.context === "object" ? (input.context as Record<string, unknown>) : null;
  try {
    const result = await variations({
      kind: input.kind === "comment" ? "comment" : "post",
      network: typeof input.network === "string" ? input.network : null,
      count: Number(input.count) || 5,
      project,
      context: raw
        ? {
            title: typeof raw.title === "string" ? raw.title : undefined,
            content: typeof raw.content === "string" ? raw.content : undefined,
            url: typeof raw.url === "string" ? raw.url : undefined,
          }
        : null,
      includeLink: Boolean(input.include_link ?? input.includeLink),
      title: Boolean(input.title),
    });
    return context.json({ title: result.title, variations: result.variations, network: result.network });
  } catch (error) {
    return context.json({ error: "write", message: (error as Error).message }, 502);
  }
});

ocRoutes.post("/v1/suggest", limited(ocWriteLimiter), scoped("suggest:create"), writerGate, async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
  const project = briefOf(input.project);
  if (!project) return context.json({ error: "project", message: "suggest needs a project with a name." }, 400);
  try {
    const places = await suggestPlaces(project);
    const forums = await oc.forumsFor(places.keywords.length ? places.keywords : [project.name]);
    const submit = `https://nichedb.dev/submit${project.url ? `?url=${encodeURIComponent(project.url)}` : ""}`;
    return context.json({ ...places, forums, directories: [{ name: "nichedb.dev", url: submit }] });
  } catch (error) {
    return context.json({ error: "suggest", message: (error as Error).message }, 502);
  }
});

ocRoutes.get("/v1/activity", limited(ocReadLimiter), scoped("activity:write"), async (context) =>
  context.json({ activity: await oc.listActivity(context.get("connection").userId, Number(context.req.query("limit")) || 100) }),
);

ocRoutes.post("/v1/activity", limited(ocReadLimiter), scoped("activity:write"), async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as oc.ActivityInput;
  try {
    return context.json(await oc.recordActivity(context.get("connection"), input), 201);
  } catch (error) {
    return context.json({ error: "activity", message: (error as Error).message }, 400);
  }
});

app.route("/openconnection", ocRoutes);

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

// `::` so the project's private network (IPv6) reaches it from the site, and
// IPv4 still does on a box that only has that.
export default { port, hostname: "::", fetch: app.fetch };
