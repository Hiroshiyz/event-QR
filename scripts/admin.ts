import "../src/server/config.js";
import { parseArgs } from "node:util";
import { z } from "zod";
import { makePool } from "../src/server/db.js";
import { passwordHash } from "../src/server/crypto.js";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string" },
    user: { type: "string" },
    vendor: { type: "string" },
    event: { type: "string" },
  },
});
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = makePool(process.env.DATABASE_URL);
try {
  const command = positionals[0];
  if (command === "event") {
    const name = z.string().trim().min(1).max(100).parse(values.name);
    const result = await pool.query(
      "INSERT INTO events(name) VALUES ($1) RETURNING id,name",
      [name],
    );
    console.log(result.rows[0]);
  } else if (command === "user") {
    const email = z.email().parse(values.email).toLowerCase(),
      role = z.enum(["EVENT_STAFF", "VENDOR", "FINANCE"]).parse(values.role);
    if (process.stdin.isTTY)
      console.error(
        "請由 stdin 傳入至少 12 字元密碼；完成後按 Ctrl-D。密碼不應出現在命令列或版本控制。",
      );
    let password = "";
    for await (const chunk of process.stdin) password += chunk;
    password = password.replace(/\r?\n$/, "");
    z.string().min(12).max(256).parse(password);
    console.log(
      (
        await pool.query(
          "INSERT INTO staff_users(email,password_hash,role) VALUES ($1,$2,$3) RETURNING id,email,role",
          [email, passwordHash(password), role],
        )
      ).rows[0],
    );
  } else if (command === "vendor") {
    const event = z.uuid().parse(values.event ?? process.env.EVENT_ID),
      name = z.string().trim().min(1).max(100).parse(values.name);
    console.log(
      (
        await pool.query(
          "INSERT INTO vendors(event_id,name) VALUES ($1,$2) RETURNING id,name",
          [event, name],
        )
      ).rows[0],
    );
  } else if (command === "assign") {
    const user = z.uuid().parse(values.user),
      vendor = z.uuid().parse(values.vendor);
    const result = await pool.query(
      `INSERT INTO vendor_staff_assignments(staff_user_id,vendor_id)
      SELECT id,$2 FROM staff_users WHERE id=$1 AND role='VENDOR' ON CONFLICT DO NOTHING`,
      [user, vendor],
    );
    if (!result.rowCount)
      throw new Error(
        "No assignment created; check vendor user or existing assignment",
      );
    console.log("Vendor assignment created.");
  } else if (command === "disable-user") {
    const user = z.uuid().parse(values.user);
    await pool.query("UPDATE staff_users SET active=false WHERE id=$1", [user]);
    console.log("User disabled; existing sessions cannot authorize requests.");
  } else
    throw new Error(
      "Commands: event --name; user --email --role (password on stdin); vendor --name [--event]; assign --user --vendor; disable-user --user",
    );
} finally {
  await pool.end();
}
