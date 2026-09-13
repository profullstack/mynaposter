/**
 * The synconfig store over Postgres: revisions of a user's settings snapshot.
 *
 * The one thing that matters here is the insert. `max(revision) + 1` and the
 * precondition on `max(revision)` happen in one statement, so two machines
 * saving at once get one revision and one conflict. The unique index on
 * (user_id, revision) is the backstop: a race the statement somehow missed
 * becomes a unique violation, reported as the same conflict.
 */
import type { SnapshotStore, StoredSnapshot, Snapshot } from "@profullstack/synconfig/server";
import { KEEP_REVISIONS } from "@profullstack/synconfig/server";
import { db } from "./db/index.ts";

interface Row {
  revision: number;
  digest: string;
  host: string | null;
  version: string | null;
  size: number;
  body: Snapshot;
  created_at: Date;
}

const shape = (row: Row): StoredSnapshot => ({
  revision: Number(row.revision),
  digest: row.digest,
  host: row.host,
  version: row.version,
  size: Number(row.size),
  body: row.body,
  savedAt: new Date(row.created_at).toISOString(),
});

export const store: SnapshotStore = {
  async latest(userId) {
    const rows = (await db()`select * from settings_snapshots where user_id = ${userId} order by revision desc limit 1`) as unknown as Row[];
    return rows[0] ? shape(rows[0]) : null;
  },

  async insert(userId, entry, ifRevision) {
    const sql = db();
    try {
      const rows = (await sql`
        insert into settings_snapshots (user_id, revision, digest, host, version, size, body)
        select ${userId}, coalesce(max(revision), 0) + 1, ${entry.digest}, ${entry.host}, ${entry.version}, ${entry.size}, ${sql.json(entry.body as never)}
          from settings_snapshots where user_id = ${userId}
        having ${ifRevision === null} or coalesce(max(revision), 0) = ${ifRevision ?? -1}
        returning revision, created_at
      `) as unknown as { revision: number; created_at: Date }[];
      if (!rows[0]) {
        const current = await this.latest(userId);
        return { conflict: true, revision: current?.revision ?? 0 };
      }
      const revision = Number(rows[0].revision);
      await sql`delete from settings_snapshots where user_id = ${userId} and revision <= ${revision - KEEP_REVISIONS}`;
      return { revision, savedAt: new Date(rows[0].created_at).toISOString() };
    } catch (error) {
      if (/unique|duplicate key/i.test((error as Error).message)) {
        const current = await this.latest(userId);
        return { conflict: true, revision: current?.revision ?? 0 };
      }
      throw error;
    }
  },

  async list(userId, limit) {
    const rows = (await db()`select revision, digest, host, version, size, created_at from settings_snapshots where user_id = ${userId} order by revision desc limit ${limit}`) as unknown as Omit<Row, "body">[];
    return rows.map((row) => ({ revision: Number(row.revision), digest: row.digest, host: row.host, version: row.version, size: Number(row.size), savedAt: new Date(row.created_at).toISOString() }));
  },
};
