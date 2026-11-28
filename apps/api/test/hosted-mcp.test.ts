/**
 * The hosted MCP: what a signed-in non-operator sees and may do, metered by
 * credits. No database: the ledger is a memoryStore and no tool reaches the
 * network on these paths.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Credits, memoryStore } from "@profullstack/redeem-credits";
import { signCoinPayWebhook } from "@profullstack/stack/coinpay";
import { handleMcp } from "../src/mcp.ts";
import { HOSTED_TOOLS } from "../src/hosted-mcp.ts";
import * as credits from "../src/credits.ts";

const user = { id: "11111111-1111-1111-1111-111111111111", email: "someone@example.com" };
const call = async (name: string, args: Record<string, unknown> = {}, caller: Parameters<typeof handleMcp>[1] = { canCall: false, user }) =>
  ((await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, caller)) as { result: { content: { text: string }[]; isError?: boolean } }).result;

const saved = { ...process.env };
beforeEach(() => {
  credits.setLedgerForTests(new Credits(memoryStore()));
  delete process.env.COINPAY_API_KEY;
});
afterEach(() => {
  process.env = { ...saved };
  credits.setLedgerForTests(null);
});

test("a signed-in non-operator lists the hosted tools, every one annotated, none of the operator's posting tools", async () => {
  const reply = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { canCall: false, user })) as { result: { tools: { name: string; title: string; annotations: Record<string, unknown> }[] } };
  const names = reply.result.tools.map((t) => t.name);
  expect(names).toEqual(HOSTED_TOOLS.map((t) => t.name));
  expect(names).not.toContain("myna_post");
  for (const t of reply.result.tools) {
    expect(t.annotations.title).toBe(t.title);
    for (const h of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]) expect(typeof t.annotations[h], `${t.name}.${h}`).toBe("boolean");
    if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
  }
  expect(reply.result.tools.find((t) => t.name === "myna_delete_handoff")!.annotations.destructiveHint).toBe(true);
  const init = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize" }, { canCall: false, user })) as { result: { instructions: string } };
  expect(init.result.instructions).toContain("myna_save_handoff");
});

test("the operator still gets the full posting toolset; an anonymous caller runs nothing", async () => {
  const reply = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { canCall: true })) as { result: { tools: { name: string }[] } };
  expect(reply.result.tools.map((t) => t.name)).toContain("myna_post");
  const anon = await call("myna_account", {}, { canCall: false });
  expect(anon.isError).toBe(true);
});

test("myna_account shows the free monthly allowance, once granted", async () => {
  const r = await call("myna_account");
  expect(r.isError).toBeUndefined();
  const body = JSON.parse(r.content[0]!.text);
  expect(body.credits).toBe(100);
  expect(body.free_monthly).toBe(100);
  // Granted once: a second read does not double it.
  expect(JSON.parse((await call("myna_account")).content[0]!.text).credits).toBe(100);
});

test("an AI tool refuses without credits, and refunds when it fails", async () => {
  process.env.MYNA_FREE_CREDITS = "0";
  credits.setLedgerForTests(new Credits(memoryStore()));
  const broke = await call("myna_write_posts", { project: { name: "x" } });
  expect(broke.isError).toBe(true);
  expect(broke.content[0]!.text).toContain("Out of credits");

  process.env.MYNA_FREE_CREDITS = "3";
  credits.setLedgerForTests(new Credits(memoryStore()));
  const bad = await call("myna_write_posts", { project: {} });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]!.text).toContain("refunded");
  expect(await credits.balance(user.id)).toBe(3);
});

test("buying credits says so when CoinPay is not switched on", async () => {
  const r = await call("myna_buy_credits", { usd: 5 });
  expect(r.isError).toBe(true);
  expect(r.content[0]!.text).toContain("not switched on");
});

test("the CoinPay webhook refuses a bad signature and ignores other payments", async () => {
  process.env.COINPAY_WEBHOOK_SECRET = "s3cret";
  const body = JSON.stringify({ type: "payment.confirmed", data: { status: "confirmed", metadata: { kind: "other" } } });
  expect((await credits.handleCoinPayWebhook(body, "t=1,v1=00")).status).toBe(401);
  const sig = signCoinPayWebhook({ rawBody: body, secret: "s3cret" });
  expect(await credits.handleCoinPayWebhook(body, sig)).toEqual({ status: 200, result: "ignored: not a credits payment" });
  const pending = JSON.stringify({ type: "payment.pending", data: { status: "pending", metadata: { kind: "myna-credits", user_id: user.id } } });
  expect((await credits.handleCoinPayWebhook(pending, signCoinPayWebhook({ rawBody: pending, secret: "s3cret" }))).result).toContain("ignored");
});
