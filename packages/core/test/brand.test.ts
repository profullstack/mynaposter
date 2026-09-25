/**
 * The brand file: what survives a round trip, and what reaches the writer.
 *
 * The parser has to accept what a person actually types, which is why the
 * pillar separator is tested three ways. `brandPrompt` is the part every
 * writing path calls, so an empty brand has to produce an empty string rather
 * than a block of headings with nothing under them.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandPath, brandPrompt, hasBrand, loadBrand, parseBrand, renderBrand, saveBrand, EMPTY_BRAND } from "../src/core/brand.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-brand-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const SAMPLE = `# Profullstack

## Audience

People who run their own infrastructure and would rather read a man page than a demo.

## Positioning

Every tool ships a CLI, a TUI, an MCP server and an API, so nothing is only clickable.

## Voice

Short declaratives. Name the failure before the fix. Never open with a question.

## Pillars

- Terminals: the terminal is a better interface than a dashboard for anything you repeat
- Self-hosting — you should own the credentials
- Open standards: a format anyone can read outlasts the tool that wrote it

## Avoid

- excited to announce
- game changer

## Links

- https://profullstack.com
- [The manifesto](https://fleetsysops.com/manifesto.md)
`;

test("parses the headings, and all three pillar separators", () => {
  const brand = parseBrand(SAMPLE);
  expect(brand.name).toBe("Profullstack");
  expect(brand.audience).toStartWith("People who run their own infrastructure");
  expect(brand.positioning).toContain("CLI, a TUI, an MCP server and an API");
  expect(brand.voice).toStartWith("Short declaratives.");

  expect(brand.pillars).toHaveLength(3);
  expect(brand.pillars[0]).toEqual({
    name: "Terminals",
    note: "the terminal is a better interface than a dashboard for anything you repeat",
  });
  // An em dash is what a person types as often as a colon.
  expect(brand.pillars[1]).toEqual({ name: "Self-hosting", note: "you should own the credentials" });
  expect(brand.pillars[2].name).toBe("Open standards");

  expect(brand.avoid).toEqual(["excited to announce", "game changer"]);
  // A Markdown link contributes its target, not its label.
  expect(brand.links).toEqual(["https://profullstack.com", "https://fleetsysops.com/manifesto.md"]);
});

test("render then parse keeps every field", () => {
  const first = parseBrand(SAMPLE);
  const again = parseBrand(renderBrand(first));
  expect(again.name).toBe(first.name);
  expect(again.audience).toBe(first.audience);
  expect(again.positioning).toBe(first.positioning);
  expect(again.voice).toBe(first.voice);
  expect(again.pillars).toEqual(first.pillars);
  expect(again.avoid).toEqual(first.avoid);
  expect(again.links).toEqual(first.links);
});

test("a pillar with no note keeps its whole line as the name", () => {
  const brand = parseBrand("# X\n\n## Pillars\n\n- Licensing\n");
  expect(brand.pillars).toEqual([{ name: "Licensing", note: "" }]);
});

test("save and load go through the config dir", () => {
  expect(hasBrand()).toBe(false);
  expect(loadBrand()).toBeNull();

  const written = saveBrand(parseBrand(SAMPLE));
  expect(written).toBe(brandPath());
  expect(hasBrand()).toBe(true);
  expect(loadBrand()?.name).toBe("Profullstack");
});

test("brandPrompt carries the brand, and says nothing when there is none", () => {
  expect(brandPrompt(null)).toBe("");
  // An empty brand is not the same as no brand, and still must add nothing:
  // a heading with no content under it is worse than silence in a prompt.
  expect(brandPrompt({ ...EMPTY_BRAND })).toBe("");

  const prompt = brandPrompt(parseBrand(SAMPLE));
  expect(prompt).toContain("You write as Profullstack.");
  expect(prompt).toContain("Never: excited to announce; game changer");
  expect(prompt).toContain("Terminals, Self-hosting, Open standards");
  // The notes are deliberately left out: the pillar names are the steer, and
  // a system prompt that recites the whole document produces copy that sounds
  // like it is reciting the whole document.
  expect(prompt).not.toContain("outlasts the tool that wrote it");
});

test("a file that is not a brand reads as empty fields rather than throwing", () => {
  // Escaped rather than literal: a source file carrying raw NUL bytes is
  // stored as binary, which makes it undiffable in review.
  writeFileSync(brandPath(), "\u0000\u0000not markdown at all\n");
  expect(() => loadBrand()).not.toThrow();
  const brand = loadBrand();
  expect(brand?.name).toBe("");
  expect(brand?.pillars).toEqual([]);
});
