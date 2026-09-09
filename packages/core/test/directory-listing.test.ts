/**
 * Building a listing from a URL, and the shape SaaSRow is sent.
 *
 * The AI path is not exercised here — it needs a model — so these cover the
 * fallback that runs without one, which is also the path a person hits when no
 * API key is configured.
 */
import { test, expect, afterEach } from "bun:test";
import { buildListing, deriveDescription, deriveName } from "../src/directories/submit.ts";
import { saasrow } from "../src/directories/adapters/saasrow.ts";
import { getDirectory, requireDirectory, registerDirectory, unregisterDirectory, DIRECTORIES } from "../src/directories/registry.ts";
import type { PageSummary } from "../src/ai/extract.ts";
import type { DirectoryAccount } from "../src/directories/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const page = (overrides: Partial<PageSummary> = {}): PageSummary => ({
  url: "https://widget.test",
  title: "Widget",
  description: "",
  siteName: "",
  author: "",
  text: "",
  image: "",
  ...overrides,
});

test("the product's name is the name, not the page title with its tagline", () => {
  expect(deriveName(page({ title: "Widget — the fastest way to frob" }))).toBe("Widget");
  expect(deriveName(page({ title: "Widget | Frobbing, solved" }))).toBe("Widget");
  // og:site_name is the publisher naming itself, so it wins over the title.
  expect(deriveName(page({ title: "Pricing — Widget", siteName: "Widget" }))).toBe("Widget");
  // A hyphen can belong to the name itself; dropping to nothing would be worse.
  expect(deriveName(page({ title: "Read-It" }))).toBe("Read-It");
  // Nothing usable at all still beats an empty name.
  expect(deriveName(page({ title: "", url: "https://www.widget.test/x" }))).toBe("widget.test");
  // fetchPage defaults siteName to the hostname when a page declares none, so
  // a siteName equal to the host says nothing and must not beat the title.
  expect(deriveName(page({ title: "Widget", siteName: "widget.test" }))).toBe("Widget");
});

test("a description is cut on a sentence, not mid-word", () => {
  const prose = "Widget frobs things. It runs on your own machine. It also does other things entirely.";
  const cut = deriveDescription(page({ text: prose }), 60);

  expect(cut.endsWith(".")).toBe(true);
  expect(cut.length).toBeLessThanOrEqual(60);
  expect(prose.startsWith(cut)).toBe(true);
});

test("a short meta description is filled out from the page, not used alone", () => {
  const built = deriveDescription(page({ description: "Frobs things.", text: "Widget frobs things on your own hardware." }), 500);
  expect(built).toContain("Frobs things.");
  expect(built).toContain("own hardware");
});

test("buildListing reads the page, and anything given by hand wins over it", async () => {
  globalThis.fetch = (async () =>
    new Response(
      `<html><head><title>Widget — frobbing, solved</title>
       <meta property="og:description" content="Widget frobs things for teams that would rather not run their own frobber."></head>
       <body><p>Widget frobs things.</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    )) as unknown as typeof fetch;

  const { listing, source } = await buildListing(saasrow, "widget.test", {
    ai: false,
    overrides: { name: "Widget Pro", tags: ["frobbing"] },
  });

  expect(source).toBe("page");
  // A bare host is a URL a person types; it must not be submitted as one.
  expect(listing.website).toBe("https://widget.test");
  expect(listing.name).toBe("Widget Pro");
  expect(listing.tags).toEqual(["frobbing"]);
  expect(listing.description).toContain("frobs things");
});

test("an empty override changes nothing, so a blank flag cannot wipe a field", async () => {
  globalThis.fetch = (async () =>
    new Response(`<html><head><title>Widget</title><meta name="description" content="Widget frobs things for teams everywhere."></head><body>Widget frobs things for teams everywhere and always.</body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

  const { listing } = await buildListing(saasrow, "https://widget.test", {
    ai: false,
    overrides: { name: "", tags: [], category: "Software" },
  });

  expect(listing.name).toBe("Widget");
  expect(listing.category).toBe("Software");
});

test("SaaSRow is sent snake_case fields, and only the ones that have a value", async () => {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };
    if (message.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (message.method.startsWith("notifications/")) return new Response("", { status: 202 });
    sent.push(message.params?.arguments ?? {});
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: "uuid", name: "Widget", website: "https://widget.test", status: "pending", saasrow_url: "https://saasrow.com/software/uuid" }),
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const account: DirectoryAccount = {
    directory: "saasrow",
    handle: "you@example.com",
    addedAt: new Date().toISOString(),
    creds: { key: "sr_key" },
    meta: { site: "https://saasrow.com" },
  };

  const listing = await saasrow.submit(account, {
    name: "Widget",
    website: "https://widget.test",
    description: "Widget frobs things.",
    useCases: ["developer-tools"],
    tags: [],
  });

  expect(sent[0]).toEqual({
    name: "Widget",
    website: "https://widget.test",
    description: "Widget frobs things.",
    use_cases: ["developer-tools"],
  });
  // An empty array is absent, not sent as [], which some APIs read as "clear this".
  expect(sent[0]).not.toHaveProperty("tags");
  expect(listing.id).toBe("uuid");
  expect(listing.status).toBe("pending");
  expect(listing.url).toBe("https://saasrow.com/software/uuid");
});

test("submitting without a key says which command fixes it", async () => {
  const account: DirectoryAccount = {
    directory: "saasrow",
    handle: "you@example.com",
    addedAt: new Date().toISOString(),
    creds: {},
    meta: {},
  };
  await expect(
    saasrow.submit(account, { name: "Widget", website: "https://widget.test", description: "Frobs." }),
  ).rejects.toThrow(/myna directory login saasrow/);
});

test("the registry names what it knows when asked for something it does not", () => {
  expect(getDirectory("SaaSRow")?.id).toBe("saasrow");
  expect(() => requireDirectory("peerpush")).toThrow(/saasrow/);
});

test("a registered directory replaces one with the same id, and can be taken back out", () => {
  const before = DIRECTORIES.length;
  registerDirectory({ ...saasrow, id: "stub", name: "Stub" });
  expect(DIRECTORIES.length).toBe(before + 1);
  registerDirectory({ ...saasrow, id: "stub", name: "Stub Two" });
  expect(DIRECTORIES.length).toBe(before + 1);
  expect(getDirectory("stub")?.name).toBe("Stub Two");

  unregisterDirectory("stub");
  expect(getDirectory("stub")).toBeUndefined();
  expect(DIRECTORIES.length).toBe(before);
});
