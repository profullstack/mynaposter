/**
 * Hand-off cards on disk, and in the recap.
 *
 * What has to hold: a card needs a place, a title and text, and an --open
 * that is a URL; open cards list first and newest first; done cards come
 * only when asked; a card is found by id, cloud id or a prefix; marking done
 * and undoing it round-trip; and the recap names what is waiting on you
 * with the link to do it.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHandoff, attachCloud, getHandoff, handoffUrl, listHandoffs, markHandoff, normaliseHandoff, removeHandoff } from "../src/store/handoffs.ts";
import { buildRecap, recapSubject, renderRecapText } from "../src/core/recap.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-handoffs-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

test("a card is checked before it is kept", () => {
  expect(() => normaliseHandoff({ place: "", title: "t", text: "x" })).toThrow(/needs a place/);
  expect(() => normaliseHandoff({ place: "HN", title: "", text: "x" })).toThrow(/needs a title/);
  expect(() => normaliseHandoff({ place: "HN", title: "t", text: "  " })).toThrow(/text to paste/);
  expect(() => normaliseHandoff({ place: "HN", title: "t", text: "x", openUrl: "not a url" })).toThrow(/not a URL/);
  expect(() => normaliseHandoff({ place: "HN", title: "t", text: "x", openUrl: "javascript:alert(1)" })).toThrow(/http/);
  expect(normaliseHandoff({ place: " HN ", title: " Submit ", text: "a\r\nb\n", openUrl: "https://news.ycombinator.com/submit", steps: [" one ", "", "two"] })).toEqual({
    place: "HN",
    title: "Submit",
    text: "a\nb",
    openUrl: "https://news.ycombinator.com/submit",
    steps: ["one", "two"],
  });
});

test("open cards first, newest first; done ones only when asked; found by id, cloud id or prefix", () => {
  const first = addHandoff({ place: "r/ai", title: "Comment", text: "hello", steps: ["copy", "paste"] });
  const second = addHandoff({ place: "HN", title: "Submit", text: "title + url" });
  expect(listHandoffs().map((card) => card.id)).toEqual([second.id, first.id]);

  expect(markHandoff(first.id)?.doneAt).toBeDefined();
  expect(listHandoffs().map((card) => card.id)).toEqual([second.id]);
  expect(listHandoffs({ all: true }).map((card) => card.id)).toEqual([second.id, first.id]);
  expect(markHandoff(first.id, false)?.doneAt).toBeUndefined();
  expect(listHandoffs()).toHaveLength(2);

  attachCloud(second.id, "AbCdEfGhIjKlMnOpQrStUv", "https://mynaposter.com/handoff/AbCdEfGhIjKlMnOpQrStUv");
  expect(getHandoff("AbCdEfGhIjKlMnOpQrStUv")?.id).toBe(second.id);
  expect(getHandoff("AbCdEf")?.id).toBe(second.id);
  expect(getHandoff(second.id.slice(0, 4))?.id).toBe(second.id);
  expect(getHandoff("nope")).toBeUndefined();
  expect(markHandoff("nope")).toBeUndefined();

  expect(removeHandoff(first.id)).toBe(true);
  expect(removeHandoff(first.id)).toBe(false);
  expect(listHandoffs()).toHaveLength(1);
});

test("the card link is the site, not the API", () => {
  expect(handoffUrl("AbCdEfGhIjKlMnOpQrStUv")).toBe("https://mynaposter.com/handoff/AbCdEfGhIjKlMnOpQrStUv");
});

test("the recap says what is waiting on you, with the link", () => {
  const open = addHandoff({ place: "r/ai", title: "Comment on the thread", text: "hello" });
  attachCloud(open.id, "AbCdEfGhIjKlMnOpQrStUv", "https://mynaposter.com/handoff/AbCdEfGhIjKlMnOpQrStUv");
  const done = addHandoff({ place: "HN", title: "Submit", text: "x" });
  markHandoff(done.id);

  const recap = buildRecap({ now: new Date("2026-09-13T12:00:00Z"), history: [], queue: [] });
  expect(recap.handoffs).toEqual([{ id: open.id, place: "r/ai", title: "Comment on the thread", url: "https://mynaposter.com/handoff/AbCdEfGhIjKlMnOpQrStUv", createdAt: open.createdAt }]);

  const text = renderRecapText(recap, "UTC");
  expect(text).toContain("Waiting on you: 1");
  expect(text).toContain("  r/ai  Comment on the thread");
  expect(text).toContain("    https://mynaposter.com/handoff/AbCdEfGhIjKlMnOpQrStUv");
  expect(recapSubject(recap, "UTC")).toContain("1 waiting on you");

  // A card with no cloud copy points at the command instead.
  const local = buildRecap({ now: new Date(), history: [], queue: [], handoffs: [{ ...open, cloudUrl: undefined, cloudId: undefined }] });
  expect(renderRecapText(local, "UTC")).toContain(`    myna handoff show ${open.id}`);
  // And an empty list says nothing.
  const quiet = buildRecap({ now: new Date(), history: [], queue: [], handoffs: [] });
  expect(renderRecapText(quiet, "UTC")).not.toContain("Waiting on you");
  expect(recapSubject(quiet, "UTC")).not.toContain("waiting");
});
