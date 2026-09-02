#!/usr/bin/env node
// Published entry point. The TypeScript sources are compiled to dist/ on build;
// running from a checkout goes through Bun instead.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "..", "dist", "main.js");

if (existsSync(compiled)) {
  await import(compiled);
} else {
  await import(join(here, "..", "src", "main.ts"));
}
