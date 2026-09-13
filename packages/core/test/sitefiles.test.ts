/**
 * What a site says about itself: the two files are read from the page's
 * origin, an HTML 404 page dressed as either is not believed, and a
 * missing file is absent rather than an error.
 */
import { test, expect } from "bun:test";
import { readSiteFiles, looksLikeOpenProfile, looksLikeLlms, MAX_SITE_FILE } from "../src/ai/sitefiles.ts";

const PROFILE = "# Chovy\n\nKind: person\nWeb: https://chovy.com\n\n## Accounts\n\n- Bluesky: https://bsky.app/profile/chovy.bsky.social\n";
const LLMS = "# chovy.com\n\n> A person's site.\n\n- [Blog](https://chovy.com/blog)\n";
const HTML = "<!doctype html><html><head><title>Not found</title></head><body># nope</body></html>";

test("an OpenProfile.md is a heading with a section or an identity line; HTML never is", () => {
  expect(looksLikeOpenProfile(PROFILE)).toBe(true);
  expect(looksLikeOpenProfile("# Just a title\n\nKind: agent\n")).toBe(true);
  expect(looksLikeOpenProfile("# Just a title\n\nsome prose\n")).toBe(false);
  expect(looksLikeOpenProfile(HTML)).toBe(false);
  expect(looksLikeOpenProfile("")).toBe(false);
});

test("an llms.txt is Markdown with a title; HTML never is", () => {
  expect(looksLikeLlms(LLMS)).toBe(true);
  expect(looksLikeLlms("plain text with no heading")).toBe(false);
  expect(looksLikeLlms(HTML)).toBe(false);
});

test("both files are read from the origin of the page, in order, and a 404 or HTML answer is absent", async () => {
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith("/.well-known/openprofile.md")) return new Response(PROFILE, { headers: { "content-type": "text/markdown" } });
    if (url.endsWith("/llms.txt")) return new Response(HTML, { status: 404, headers: { "content-type": "text/html" } });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const files = await readSiteFiles("https://chovy.com/some/page?x=1", fake);
  expect(asked.sort()).toEqual(["https://chovy.com/.well-known/openprofile.md", "https://chovy.com/llms.txt"]);
  expect(files.origin).toBe("https://chovy.com");
  expect(files.openprofile).toBe(PROFILE);
  expect(files.llms).toBeNull();
  expect(files.readFrom).toEqual(["openprofile"]);
});

test("a bare host is read as https, a soft-404 served as 200 HTML is not believed, and a huge file is cut", async () => {
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openprofile.md")) return new Response(HTML, { headers: { "content-type": "text/html" } });
    if (url.endsWith("/llms.txt")) return new Response(`${LLMS}${"x".repeat(MAX_SITE_FILE * 2)}`, { headers: { "content-type": "text/plain" } });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const files = await readSiteFiles("chovy.com", fake);
  expect(files.origin).toBe("https://chovy.com");
  expect(files.openprofile).toBeNull();
  expect(files.llms?.length).toBe(MAX_SITE_FILE);
  expect(files.readFrom).toEqual(["llms"]);
});

test("a network failure is absence, not an error", async () => {
  const fake = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await readSiteFiles("https://down.example", fake)).toEqual({ origin: "https://down.example", openprofile: null, llms: null, readFrom: [] });
});
