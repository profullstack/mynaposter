import { test, expect } from "bun:test";
import { versionAssets, hashFile } from "../src/asset-version.ts";

const versions: Record<string, string> = { "site.css": "aaaa", "handoff.js": "bbbb", "dashboard.js": "cccc" };
const of = (path: string) => versions[path] ?? null;

test("site.css and handoff.js get a content version", () => {
  const html = '<link rel="stylesheet" href="/site.css"><script src="/handoff.js"></script>';
  expect(versionAssets(html, of)).toBe('<link rel="stylesheet" href="/site.css?v=aaaa"><script src="/handoff.js?v=bbbb"></script>');
});

test("an already-versioned, unknown or off-site reference is untouched", () => {
  const html = '<script src="/dashboard.js?v=x"></script><link href="/nope.css"><a href="https://e.com/site.css">';
  expect(versionAssets(html, of)).toBe(html);
});

test("the hash follows the bytes", () => {
  expect(hashFile("a")).not.toBe(hashFile("b"));
  expect(hashFile("a")).toHaveLength(10);
});
