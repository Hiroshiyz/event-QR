import "../src/server/config.js";
import { makePool } from "../src/server/db.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = makePool(process.env.DATABASE_URL);
try {
  const expired = await pool.query(
    "DELETE FROM print_artifacts WHERE expires_at <= now()",
  );
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  console.log(
    `Removed ${expired.rowCount} expired print artifacts. No historical business records deleted.`,
  );
} finally {
  await pool.end();
}
