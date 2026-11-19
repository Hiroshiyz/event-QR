import type pg from "pg";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import type { Config } from "./config.js";
import { decrypt } from "./crypto.js";
import { transaction } from "./db.js";

export interface ReadinessCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}
/** Snapshot-only diagnostics. Never migrate, repair, create accounts or print secrets. */
export async function inspectReadiness(
  pool: pg.Pool,
  config: Config,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const add = (
    name: string,
    status: ReadinessCheck["status"],
    detail: string,
  ) => checks.push({ name, status, detail });
  if (
    !z.uuid().safeParse(config.eventId).success ||
    !/^[a-f0-9]{64}$/i.test(config.printKey)
  ) {
    return [
      {
        name: "configuration",
        status: "fail",
        detail: "活動 ID 或列印金鑰格式不合法；未連線資料庫。",
      },
    ];
  }
  const origin = z.url().safeParse(config.origin);
  if (
    !origin.success ||
    new URL(config.origin).origin !== config.origin ||
    !["http:", "https:"].includes(new URL(config.origin).protocol) ||
    (config.production && !config.origin.startsWith("https://"))
  ) {
    return [
      {
        name: "configuration",
        status: "fail",
        detail: "APP_ORIGIN 必須是精確來源，正式環境須 HTTPS。",
      },
    ];
  }
  add(
    "configuration",
    config.production ? "pass" : "warn",
    config.production
      ? "正式模式與 HTTPS 來源格式正確。"
      : "目前不是正式模式；不代表已驗證正式 HTTPS。",
  );
  const required = (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return transaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '10s'");
    add(
      "read_only",
      (await db.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only === "on"
        ? "pass"
        : "fail",
      "以唯讀快照執行，不修改設定、schema 或業務資料。",
    );
    const version = (await db.query("SHOW server_version_num")).rows[0]
      .server_version_num;
    add(
      "postgresql",
      Number(version) >= 160000 ? "pass" : "fail",
      "此專案驗證基準為 PostgreSQL 16 以上。",
    );
    const tables = [
      "schema_migrations",
      "events",
      "staff_users",
      "vendors",
      "vendor_staff_assignments",
      "sessions",
      "qr_batches",
      "credentials",
      "entitlements",
      "redemptions",
      "idempotency_requests",
      "print_artifacts",
      "audit_logs",
    ];
    const found = (
      await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",
        [tables],
      )
    ).rows.map((r) => r.tablename);
    const missing = tables.filter((t) => !found.includes(t));
    add(
      "schema_tables",
      missing.length ? "fail" : "pass",
      missing.length
        ? "缺少必要資料表；請依正式流程執行 migrations。"
        : "必要資料表存在。",
    );
    if (missing.length) return checks;
    const applied = (
      await db.query("SELECT name FROM schema_migrations")
    ).rows.map((r) => r.name);
    add(
      "migrations",
      required.length > 0 && required.every((name) => applied.includes(name))
        ? "pass"
        : "fail",
      "核對本機 SQL migration 名稱與資料庫紀錄；不自行套用 migration。",
    );
    const constraints = (
      await db.query(
        `SELECT r.relname AS table_name,c.contype,c.convalidated,c.confdeltype,ref.relname AS referenced_table,pg_get_constraintdef(c.oid) AS definition,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid LEFT JOIN pg_class ref ON ref.oid=c.confrelid
      WHERE c.connamespace='public'::regnamespace AND r.relname=ANY($1::text[])`,
        [
          [
            "credentials",
            "entitlements",
            "redemptions",
            "idempotency_requests",
            "events",
          ],
        ],
      )
    ).rows;
    const uniqueRequirements = [
      ["credentials", ["event_id", "activation_sequence"]],
      ["credentials", ["token_hash"]],
      ["entitlements", ["credential_id"]],
      ["redemptions", ["entitlement_id"]],
      ["idempotency_requests", ["event_id", "actor_id", "operation", "key"]],
    ] as const;
    const unique = uniqueRequirements.every(([table, columns]) =>
      constraints.some(
        (c) =>
          c.table_name === table &&
          ["u", "p"].includes(c.contype) &&
          JSON.stringify(c.columns) === JSON.stringify(columns),
      ),
    );
    add(
      "unique_constraints",
      unique ? "pass" : "fail",
      "核對啟用序號、QR hash、資格、核銷及冪等鍵的唯一約束。",
    );
    const foreignKeys = [
      ["credentials", ["event_id", "batch_id"], "qr_batches"],
      ["entitlements", ["event_id", "credential_id"], "credentials"],
      [
        "redemptions",
        ["event_id", "entitlement_id", "credential_id"],
        "entitlements",
      ],
      ["redemptions", ["event_id", "vendor_id"], "vendors"],
    ] as const;
    add(
      "foreign_keys",
      foreignKeys.every(([table, columns, target]) =>
        constraints.some(
          (c) =>
            c.table_name === table &&
            c.contype === "f" &&
            c.convalidated &&
            ["a", "r"].includes(c.confdeltype) &&
            c.referenced_table === target &&
            JSON.stringify(c.columns) === JSON.stringify(columns),
        ),
      )
        ? "pass"
        : "fail",
      "核對活動、憑證、資格、攤販的外鍵及非連鎖刪除設定。",
    );
    add(
      "quota_constraint",
      constraints.some(
        (c) =>
          c.table_name === "events" &&
          c.contype === "c" &&
          c.convalidated &&
          c.definition.includes("free_quota_limit = 1000"),
      )
        ? "pass"
        : "fail",
      "核對固定 1000 上限的資料庫 CHECK 約束。",
    );
    const triggers = (
      await db.query(
        `SELECT t.tgname,t.tgenabled,r.relname FROM pg_trigger t
      JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[])`,
        [["immutable_activation", "entitlement_quota"]],
      )
    ).rows;
    const triggerOK = [
      ["credentials", "immutable_activation"],
      ["entitlements", "entitlement_quota"],
    ].every(([table, name]) =>
      triggers.some(
        (t) =>
          t.relname === table &&
          t.tgname === name &&
          ["O", "A"].includes(t.tgenabled),
      ),
    );
    add(
      "safety_triggers",
      triggerOK ? "pass" : "fail",
      "核對啟用不可變與免費資格上限 trigger 已啟用。",
    );
    const event = (
      await db.query(
        "SELECT activation_count,free_quota_limit,status FROM events WHERE id=$1",
        [config.eventId],
      )
    ).rows[0];
    add(
      "event",
      event ? "pass" : "fail",
      event ? "已設定的單一活動存在。" : "找不到已設定活動，未自動建立。",
    );
    if (!event) return checks;
    add(
      "event_operation",
      event.status === "ACTIVE" ? "pass" : "warn",
      event.status === "ACTIVE"
        ? "活動開放操作。"
        : "活動目前關閉；此檢查不會變更狀態。",
    );
    const activation = (
      await db.query(
        `SELECT count(*)::int AS total,coalesce(max(activation_sequence),0)::int AS maximum,
      coalesce(min(activation_sequence),0)::int AS minimum FROM credentials WHERE event_id=$1 AND activation_sequence IS NOT NULL`,
        [config.eventId],
      )
    ).rows[0];
    const consistent =
      activation.total === event.activation_count &&
      activation.maximum === event.activation_count &&
      (activation.total === 0 || activation.minimum === 1);
    add(
      "activation_consistency",
      consistent ? "pass" : "fail",
      "核對歷史啟用數、不可變序號範圍與活動計數器；不自動重排或修復。",
    );
    const quota = (
      await db.query(
        `SELECT count(*)::int AS issued,count(*) FILTER (WHERE c.activation_sequence IS NULL OR c.activation_sequence NOT BETWEEN 1 AND 1000)::int AS invalid
      FROM entitlements e JOIN credentials c ON c.id=e.credential_id WHERE e.event_id=$1`,
        [config.eventId],
      )
    ).rows[0];
    add(
      "free_quota",
      event.free_quota_limit === 1000 &&
        quota.issued === Math.min(event.activation_count, 1000) &&
        quota.invalid === 0
        ? "pass"
        : "fail",
      "核對上限 1000、資格累計與成功啟用順序；已撤銷資格仍計入發放累計。",
    );
    const mismatch = (
      await db.query(
        `SELECT count(*)::int AS total FROM entitlements e LEFT JOIN redemptions r ON r.entitlement_id=e.id
      WHERE e.event_id=$1 AND ((e.status='REDEEMED' AND r.id IS NULL) OR (r.id IS NOT NULL AND e.status<>'REDEEMED'))`,
        [config.eventId],
      )
    ).rows[0].total;
    add(
      "redemption_consistency",
      mismatch === 0 ? "pass" : "fail",
      "核對成功核銷與資格狀態一致；保留全部歷史。",
    );
    const incomplete = (
      await db.query(
        "SELECT count(*)::int AS total FROM idempotency_requests WHERE event_id=$1 AND (response IS NULL OR http_status IS NULL)",
        [config.eventId],
      )
    ).rows[0].total;
    add(
      "idempotency_consistency",
      incomplete === 0 ? "pass" : "fail",
      "已提交的冪等紀錄均須有完整結果。",
    );
    const staff = (
      await db.query(
        "SELECT count(*)::int AS total FROM staff_users WHERE active AND role='EVENT_STAFF'",
      )
    ).rows[0].total;
    const vendors = (
      await db.query(
        `SELECT count(DISTINCT v.id)::int AS total FROM vendors v JOIN vendor_staff_assignments a ON a.vendor_id=v.id
      JOIN staff_users u ON u.id=a.staff_user_id WHERE v.event_id=$1 AND v.active AND u.active AND u.role='VENDOR'`,
        [config.eventId],
      )
    ).rows[0].total;
    add(
      "staff_account",
      staff > 0 ? "pass" : "fail",
      "至少需要一位有效工作人員；不列出帳號或密碼。",
    );
    add(
      "vendor_assignments",
      vendors > 0 ? "pass" : "fail",
      "至少一個有效攤位已指派有效攤販帳號。",
    );
    const artifact = (
      await db.query(
        `SELECT p.ciphertext FROM print_artifacts p JOIN qr_batches b ON b.id=p.batch_id
      WHERE b.event_id=$1 AND p.expires_at>now() ORDER BY p.expires_at DESC LIMIT 1`,
        [config.eventId],
      )
    ).rows[0];
    if (artifact) {
      let valid = false;
      try {
        const cards = decrypt(artifact.ciphertext, config.printKey);
        valid = z
          .array(
            z.object({
              publicCode: z.string(),
              token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            }),
          )
          .min(1)
          .safeParse(cards).success;
      } catch {
        /* never expose plaintext or encryption errors */
      }
      add(
        "print_key",
        valid ? "pass" : "fail",
        valid
          ? "可驗證目前活動的加密列印暫存，未輸出 token。"
          : "設定的金鑰無法驗證列印內容；請確認秘密設定與備份，不可重建或刪除憑證。",
      );
    } else
      add(
        "print_key",
        "warn",
        "目前沒有未到期列印內容可驗證；金鑰格式正確不代表可解密歷史內容。",
      );
    const expired = (
      await db.query(
        `SELECT count(*)::int AS total FROM print_artifacts p JOIN qr_batches b ON b.id=p.batch_id WHERE b.event_id=$1 AND p.expires_at<=now()`,
        [config.eventId],
      )
    ).rows[0].total;
    add(
      "expired_print_cleanup",
      expired ? "warn" : "pass",
      expired
        ? "存在到期列印暫存；請確認清理排程，本指令不會刪除。"
        : "目前活動無到期待清理的列印暫存。",
    );
    add(
      "manual_release_gate",
      "warn",
      "仍需人工確認 HTTPS／可信代理與限流容量、備份還原、清理排程及手機／紙張現場驗收；自動檢查不代表可直接上線。",
    );
    return checks;
  });
}
