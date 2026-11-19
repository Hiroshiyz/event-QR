import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
export interface Config {
  databaseUrl: string;
  origin: string;
  eventId: string;
  printKey: string;
  production: boolean;
}
export function getConfig(): Config {
  const { DATABASE_URL, APP_ORIGIN, EVENT_ID, PRINT_ENCRYPTION_KEY } =
    process.env;
  if (!DATABASE_URL || !APP_ORIGIN || !EVENT_ID || !PRINT_ENCRYPTION_KEY)
    throw new Error(
      "Set DATABASE_URL, APP_ORIGIN, EVENT_ID and PRINT_ENCRYPTION_KEY",
    );
  if (!/^[0-9a-f]{64}$/i.test(PRINT_ENCRYPTION_KEY))
    throw new Error("PRINT_ENCRYPTION_KEY must be 32 bytes encoded as hex");
  const url = new URL(APP_ORIGIN);
  if (url.origin !== APP_ORIGIN)
    throw new Error("APP_ORIGIN must be an exact origin");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("Production requires HTTPS APP_ORIGIN");
  return {
    databaseUrl: DATABASE_URL,
    origin: APP_ORIGIN,
    eventId: EVENT_ID,
    printKey: PRINT_ENCRYPTION_KEY,
    production: process.env.NODE_ENV === "production",
  };
}
