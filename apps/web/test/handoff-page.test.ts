/**
 * The card page: which paths are cards, and what the shell carries.
 *
 * The CSP on the site forbids inline script and style, so the shell must
 * reference files for both and put the API base in a data attribute rather
 * than in a script.
 */
import { test, expect } from "bun:test";
import { handoffPath, renderHandoffPage } from "../src/handoff-page.ts";

test("only a well-formed card id is a card path", () => {
  expect(handoffPath("/handoff/AbCdEfGhIjKlMnOpQrStUv")).toBe("AbCdEfGhIjKlMnOpQrStUv");
  expect(handoffPath("/handoff/AbCdEfGhIjKlMnOpQrStUv/")).toBe("AbCdEfGhIjKlMnOpQrStUv");
  expect(handoffPath("/handoff/short")).toBeNull();
  expect(handoffPath("/handoff/")).toBeNull();
  expect(handoffPath("/handoff")).toBeNull();
  expect(handoffPath("/handoff/../index.html")).toBeNull();
  expect(handoffPath("/handoffs/AbCdEfGhIjKlMnOpQrStUv")).toBeNull();
});

test("the shell is CSP-clean: files for script and style, the API base as data, no indexing", () => {
  const html = renderHandoffPage("https://mynaposter.com/api");
  expect(html).toContain('<script src="/handoff.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="/handoff.css">');
  expect(html).toContain('data-api="https://mynaposter.com/api"');
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).not.toMatch(/<script>|<style>/);
  for (const id of ["status", "card", "place", "title", "text", "copy", "open", "done", "steps", "note"]) {
    expect(html).toContain(`id="${id}"`);
  }
});
