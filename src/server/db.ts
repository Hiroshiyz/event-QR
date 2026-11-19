import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
export const makePool = (url: string) =>
  new pg.Pool({ connectionString: url, max: 25 });
export type Db = pg.PoolClient;
export async function transaction<T>(
  pool: pg.Pool,
  work: (db: Db) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let broken: Error | undefined;
  try {
    await db.query("BEGIN");
    const value = await work(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    db.release(broken);
  }
}
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(873624)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        !(
          await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      ) {
        await db.query(await readFile(`migrations/${name}`, "utf8"));
        await db.query("INSERT INTO schema_migrations(name) VALUES ($1)", [
          name,
        ]);
      }
    }
  });
}
