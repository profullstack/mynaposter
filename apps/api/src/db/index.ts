/**
 * The database, when there is one.
 *
 * myna runs in two shapes. On your own machine it is a single-user tool and
 * everything lives in ~/.config/myna, no database involved. Hosted, it serves
 * several people and needs Postgres. `DATABASE_URL` decides which, so the same
 * server binary covers both.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function db(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set; this endpoint needs the hosted database.");
    client = postgres(url, {
      max: Number(process.env.DATABASE_POOL ?? 10),
      // Railway and most managed Postgres want TLS but present a chain the
      // default verifier rejects, so verification is relaxed rather than off.
      ssl: url.includes("sslmode=disable") ? false : "prefer",
      onnotice: () => {},
    });
  }
  return client;
}

/**
 * Apply the schema at boot. It is written to be idempotent (every statement is
 * `if not exists`), which is why there is no migration table: re-running it is
 * a no-op, and a half-applied deploy self-heals on the next start.
 */
export async function migrate(): Promise<void> {
  if (!hasDatabase()) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  await db().unsafe(schema);
}

export async function closeDatabase(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = null;
}
