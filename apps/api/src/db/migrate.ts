/** `bun run migrate`, and what the server calls at boot. */
import { migrate, hasDatabase, closeDatabase } from "./index.ts";

if (!hasDatabase()) {
  console.error("DATABASE_URL is not set. Nothing to migrate.");
  process.exit(1);
}

await migrate();
console.log("Schema applied.");
await closeDatabase();
