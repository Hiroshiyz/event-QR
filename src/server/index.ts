import { getConfig } from "./config.js";
import { makePool } from "./db.js";
import { buildApp } from "./app.js";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
const config = getConfig(),
  pool = makePool(config.databaseUrl),
  app = await buildApp(config, pool);
await pool.query("SELECT 1");
if (config.production) {
  await app.register(staticFiles, {
    root: resolve("dist/client/assets"),
    prefix: "/assets/",
    wildcard: true,
    decorateReply: false,
  });
  app.get("/", async (_req, reply) => {
    const { readFile } = await import("node:fs/promises");
    return reply
      .type("text/html")
      .send(await readFile("dist/client/index.html"));
  });
}
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "127.0.0.1" });
console.log(`API listening on http://127.0.0.1:${process.env.PORT ?? 3000}`);
const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
