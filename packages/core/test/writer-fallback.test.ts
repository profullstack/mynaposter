/**
 * The writer's understudy.
 *
 * The house Anthropic key is shared across the fleet and carries a spend cap,
 * so it returns "You have reached your specified API usage limits" for days at
 * a time, and a rotated key returns 401. Neither should stop myna writing when
 * a working OpenAI key is sitting next to it.
 *
 * What has to hold: an unavailable provider falls back, a refusal does not,
 * and the writer counts as available whenever either key would work.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { worthFallingBackFrom, hasOpenAI, writerAvailable, FALLBACK_MODEL } from "../src/ai/writer.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";

let dir = "";
let anthropic: string | undefined;
let openai: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-writer-"));
  process.env.MYNA_HOME = dir;
  anthropic = process.env.ANTHROPIC_API_KEY;
  openai = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = anthropic;
  if (openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = openai;
});

test("a capped or dead key is worth falling back from", () => {
  // The exact message the shared house key returns while capped.
  expect(
    worthFallingBackFrom(new Error("You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.")),
  ).toBe(true);
  expect(worthFallingBackFrom(new Error("API key is invalid."))).toBe(true);
  expect(worthFallingBackFrom(new Error("authentication_error"))).toBe(true);
  expect(worthFallingBackFrom(new Error("429 rate limit exceeded"))).toBe(true);
  expect(worthFallingBackFrom(new Error("529 overloaded"))).toBe(true);
  expect(worthFallingBackFrom(new Error("500 internal server error"))).toBe(true);
});

test("a refusal is never laundered through the other provider", () => {
  // The model read the prompt and said no. Asking a second model to do what
  // the first declined is the one thing the fallback must not be for.
  expect(worthFallingBackFrom(new Error("Claude declined to write this: it is a covert advert"))).toBe(false);
  // Nor is an ordinary bug worth a second, differently-broken attempt.
  expect(worthFallingBackFrom(new Error("Cannot read properties of undefined"))).toBe(false);
});

test("the writer is available when either key would work", () => {
  const settings = loadSettings();
  settings.ai.provider = "anthropic";
  saveSettings(settings);

  // Neither: genuinely unavailable, and the reason names both.
  expect(writerAvailable().ok).toBe(false);
  expect(writerAvailable().reason).toContain("OPENAI_API_KEY");

  // Only the understudy: still available, which is the whole point.
  process.env.OPENAI_API_KEY = "sk-test";
  expect(hasOpenAI()).toBe(true);
  expect(writerAvailable().ok).toBe(true);

  // Only the first choice: also available.
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  expect(writerAvailable().ok).toBe(true);
});

test("choosing openai outright does not fall back to anything", () => {
  const settings = loadSettings();
  settings.ai.provider = "openai";
  saveSettings(settings);
  expect(writerAvailable().ok).toBe(false);
  process.env.OPENAI_API_KEY = "sk-test";
  expect(writerAvailable().ok).toBe(true);
});

test("ollama never needs a key, and is never quietly sent elsewhere", () => {
  const settings = loadSettings();
  settings.ai.provider = "ollama";
  saveSettings(settings);
  // Picking a local model is a decision about where the text goes, so it is
  // available with no key at all and providerComplete never leaves the box.
  expect(writerAvailable().ok).toBe(true);
});

test("the understudy uses its own model, since the configured one is a Claude name", () => {
  expect(FALLBACK_MODEL).not.toContain("claude");
});
