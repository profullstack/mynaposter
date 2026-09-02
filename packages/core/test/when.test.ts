import { test, expect } from "bun:test";
import { parseWhen } from "../../../apps/cli/src/tui/when.ts";

const NOW = new Date("2026-09-02T12:00:00");

test("in 2h", () => {
  const { at, rest } = parseWhen("in 2h the release is out", NOW);
  expect(at.getTime() - NOW.getTime()).toBe(2 * 3_600_000);
  expect(rest).toBe("the release is out");
});

test("in 30 minutes, spelled out", () => {
  const { at } = parseWhen("in 30 minutes", NOW);
  expect(at.getTime() - NOW.getTime()).toBe(30 * 60_000);
});

test("bare compact delay", () => {
  const { at, rest } = parseWhen("45m ship it", NOW);
  expect(at.getTime() - NOW.getTime()).toBe(45 * 60_000);
  expect(rest).toBe("ship it");
});

test("tomorrow with a time", () => {
  const { at, rest } = parseWhen("tomorrow 9am good morning", NOW);
  expect(at.getDate()).toBe(3);
  expect(at.getHours()).toBe(9);
  expect(rest).toBe("good morning");
});

test("tomorrow without a time defaults to 9am", () => {
  const { at } = parseWhen("tomorrow", NOW);
  expect(at.getDate()).toBe(3);
  expect(at.getHours()).toBe(9);
});

test("an explicit date", () => {
  const { at, rest } = parseWhen("2026-09-05 14:30 hello", NOW);
  expect(at.getFullYear()).toBe(2026);
  expect(at.getMonth()).toBe(8);
  expect(at.getDate()).toBe(5);
  expect(at.getHours()).toBe(14);
  expect(at.getMinutes()).toBe(30);
  expect(rest).toBe("hello");
});

test("a bare time already past today rolls to tomorrow", () => {
  const { at } = parseWhen("9am", NOW);
  expect(at.getDate()).toBe(3);
  expect(at.getHours()).toBe(9);
});

test("a bare time still ahead stays today", () => {
  const { at } = parseWhen("5pm", NOW);
  expect(at.getDate()).toBe(2);
  expect(at.getHours()).toBe(17);
});

test("nonsense is rejected with advice, not a wrong time", () => {
  expect(() => parseWhen("sometime soon", NOW)).toThrow(/Could not read that time/);
});
