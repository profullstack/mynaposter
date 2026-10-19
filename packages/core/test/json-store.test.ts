/**
 * The config store under concurrent writers: a corrupt file is an error rather
 * than an empty store, and parallel saves never rename a half-written file
 * into place.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJson } from "../src/util/json.ts";

let home: string;
const saved = process.env.MYNA_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myna-json-"));
  process.env.MYNA_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.MYNA_HOME;
  else process.env.MYNA_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

test("a missing file reads as the fallback", () => {
  expect(readJson("absent.json", { ok: true })).toEqual({ ok: true });
});

test("a corrupt file throws instead of reading as the fallback", () => {
  writeJson("store.json", { keep: 1 });
  writeFileSync(join(home, "store.json"), '{"newsletters": [');
  expect(() => readJson("store.json", {})).toThrow(/not valid JSON/);
});

test("parallel writers never leave a partial file or a stray temp file", async () => {
  const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, pad: "x".repeat(40) })) };
  writeJson("store.json", big);
  const script = `
    process.env.MYNA_HOME = ${JSON.stringify(home)};
    const { readJson, writeJson } = await import(${JSON.stringify(join(import.meta.dir, "../src/util/json.ts"))});
    for (let n = 0; n < 40; n++) writeJson("store.json", readJson("store.json", {}));
  `;
  const runs = Array.from({ length: 4 }, () => new Promise<number>((done) => {
    spawn(process.execPath, ["-e", script], { stdio: "inherit" }).on("exit", (code) => done(code ?? 1));
  }));
  expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
  expect((readJson("store.json", {}) as typeof big).rows.length).toBe(20000);
  expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}, 60000);
