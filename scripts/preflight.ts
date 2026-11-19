import { getConfig } from "../src/server/config.js";
import pg from "pg";
import { inspectReadiness } from "../src/server/readiness.js";
const json = process.argv.includes("--json");
let pool: pg.Pool | undefined;
try {
  const config = getConfig();
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  const checks = await inspectReadiness(pool, config),
    failed = checks.some((c) => c.status === "fail");
  const output = {
    automatedChecksPassed: !failed,
    manualApprovalRequired: true,
    checks,
  };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    for (const check of checks)
      console.log(
        `${check.status.toUpperCase()} ${check.name}: ${check.detail}`,
      );
    console.log(
      failed
        ? "自動檢查有未通過項目；未修改任何資料。"
        : "自動檢查完成；仍須完成現場驗收與人工放行。",
    );
  }
  if (failed) process.exitCode = 1;
} catch {
  const failure = {
    automatedChecksPassed: false,
    manualApprovalRequired: true,
    error:
      "檢查無法完成；請確認環境設定、資料庫連線與 migrations。未自動修復任何資料。",
  };
  if (json) console.log(JSON.stringify(failure));
  else console.error(failure.error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
