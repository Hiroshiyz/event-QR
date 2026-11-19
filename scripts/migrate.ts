import "../src/server/config.js";
import { makePool, migrate } from "../src/server/db.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = makePool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
