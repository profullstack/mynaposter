/**
 * The branded layout: off until a name or logo is set, then a full HTML
 * document with the logo, inline styles on every Markdown tag, the button in
 * the accent colour, and the footer (unsubscribe + address) still present.
 */
import { test, expect } from "bun:test";
import { composeNewsletter } from "../src/core/newsletter.ts";
import { DEFAULT_BRAND, styleBody } from "../src/core/newsletter-layout.ts";

const issue = {
  subject: "News",
  body: "Hello **there**, see [the site](https://example.com).\n\n## Section\n\n- one\n- two\n\n{{cta}}\n",
  list: "all",
  service: "an Example product",
  replyTo: null,
};
const base = {
  link: "https://example.com/u/tok",
  address: "Example Inc., 1 Main St, Town, ST 00000, USA",
  from: "Ann <ann@example.com>",
  token: "tok",
  cta: { label: "Book a demo", url: "https://example.com/book" },
};
const brand = { ...DEFAULT_BRAND, name: "Example", url: "https://example.com", logoUrl: "https://example.com/logo.png", accent: "#123456" };

test("without a brand the plain fragment is kept", () => {
  const html = composeNewsletter(issue, base).html ?? "";
  expect(html.startsWith("<!doctype html>")).toBe(false);
  expect(html).toContain("<hr>");
  expect(html).toContain("Unsubscribe");
});

test("an empty brand counts as no brand", () => {
  const html = composeNewsletter(issue, { ...base, brand: DEFAULT_BRAND }).html ?? "";
  expect(html.startsWith("<!doctype html>")).toBe(false);
});

test("a brand wraps the issue in the full layout", () => {
  const { html = "", text } = composeNewsletter(issue, { ...base, brand });
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain('src="https://example.com/logo.png"');
  expect(html).toContain('alt="Example"');
  expect(html).toContain(">Example</span>");
  // Button in the accent colour, links styled, headings ruled in the accent.
  expect(html).toContain("background:#123456");
  expect(html).toMatch(/<a href="https:\/\/example.com" style="color:#123456/);
  expect(html).toMatch(/<h3 style="[^"]*border-bottom:2px solid #123456/);
  // Footer survives, and the text part is unchanged by the layout.
  expect(html).toContain('href="https://example.com/u/tok"');
  expect(html).toContain("Example Inc., 1 Main St");
  expect(text).not.toContain("<");
  // Preheader carries the first paragraph, without Markdown marks.
  expect(html).toMatch(/<div style="display:none[^"]*">Hello there, see the site\./);
});

test("a bad accent falls back to the default instead of injecting CSS", () => {
  const html = composeNewsletter(issue, { ...base, brand: { ...brand, accent: "red;background:url(x)" } }).html ?? "";
  expect(html).not.toContain("url(x)");
  expect(html).toContain(DEFAULT_BRAND.accent);
});

test("styleBody leaves tags that already carry a style alone", () => {
  const out = styleBody('<p>a</p><a href="x" style="color:blue">b</a><img src="p.png" width="1" height="1" alt="" style="border:0">', "#000000");
  expect(out).toContain('<p style="');
  expect(out).toContain('style="color:blue"');
  expect(out.match(/style=/g)?.length).toBe(3);
});

test("the inbox preview skips a short greeting", () => {
  const html = composeNewsletter({ ...issue, body: "Hi,\n\nThis is the first issue, with **real** news about [our work](https://example.com) this month.\n" }, { ...base, brand }).html ?? "";
  expect(html).toMatch(/<div style="display:none[^"]*">This is the first issue, with real news about our work this month\./);
});
