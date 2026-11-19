import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";
import { transaction, type Db } from "./db.js";
import { hash, token, encrypt } from "./crypto.js";

export class ApiError extends Error {
  constructor(
    public code: string,
    public httpStatus = 409,
    message = code,
  ) {
    super(message);
  }
}
export interface Actor {
  id: string;
  role: "EVENT_STAFF" | "VENDOR" | "FINANCE";
  email: string;
  csrf: string;
}
export interface Result {
  status: number;
  body: any;
}
export const failure = (
  code: string,
  status = 409,
  message = code,
): Result => ({ status, body: { success: false, error: { code, message } } });
export async function audit(
  db: Db,
  event: string,
  actor: string,
  action: string,
  target: string | null,
  vendor: string | null = null,
  metadata = {},
) {
  await db.query(
    "INSERT INTO audit_logs(event_id,actor_id,action,target_id,vendor_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)",
    [event, actor, action, target, vendor, metadata],
  );
}
export async function active(db: Db, eventId: string) {
  const event = (await db.query("SELECT * FROM events WHERE id=$1", [eventId]))
    .rows[0];
  if (!event) throw new ApiError("EVENT_NOT_FOUND", 404);
  if (event.status !== "ACTIVE") throw new ApiError("EVENT_CLOSED");
}
export async function authorizeVendor(
  pool: pg.Pool,
  event: string,
  actor: Actor,
  vendor: string,
) {
  if (actor.role !== "VENDOR") throw new ApiError("FORBIDDEN", 403);
  const match = await pool.query(
    `SELECT 1 FROM vendors v JOIN vendor_staff_assignments a ON a.vendor_id=v.id
    WHERE v.id=$1 AND v.event_id=$2 AND v.active AND a.staff_user_id=$3`,
    [vendor, event, actor.id],
  );
  if (!match.rowCount) throw new ApiError("FORBIDDEN_VENDOR", 403);
}
export function credentialStatus(c: any, e: any) {
  const state = e?.status ?? "NOT_ELIGIBLE";
  return {
    eligible:
      c.status === "ACTIVATED" && ["AVAILABLE", "REDEEMED"].includes(state),
    redeemable: c.status === "ACTIVATED" && state === "AVAILABLE",
    status: state,
  };
}
export function rejection(c: any, e: any): string | undefined {
  if (c.status === "VOIDED") return "CREDENTIAL_VOIDED";
  if (c.status !== "ACTIVATED") return "NOT_ACTIVATED";
  if (!e) return "NOT_ELIGIBLE";
  if (e.status === "REDEEMED") return "ALREADY_REDEEMED";
  if (e.status !== "AVAILABLE") return "ENTITLEMENT_REVOKED";
}
export async function idempotent(
  pool: pg.Pool,
  event: string,
  actor: Actor,
  operation: string,
  key: string,
  payload: unknown,
  work: (db: Db) => Promise<Result>,
): Promise<Result> {
  return transaction(pool, async (db) => {
    const fingerprint = hash(JSON.stringify(payload)),
      scope = [event, actor.id, operation, key];
    await db.query(
      `INSERT INTO idempotency_requests(event_id,actor_id,operation,key,fingerprint)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [...scope, fingerprint],
    );
    const saved = (
      await db.query(
        `SELECT * FROM idempotency_requests WHERE event_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4 FOR UPDATE`,
        scope,
      )
    ).rows[0];
    if (saved.fingerprint !== fingerprint)
      return failure("IDEMPOTENCY_CONFLICT");
    if (saved.response)
      return { status: saved.http_status, body: saved.response };
    const result = await work(db);
    await db.query(
      `UPDATE idempotency_requests SET http_status=$5,response=$6
      WHERE event_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4`,
      [...scope, result.status, result.body],
    );
    return result;
  });
}
export async function activate(
  pool: pg.Pool,
  config: Config,
  actor: Actor,
  key: string,
  credentialToken: string,
) {
  return idempotent(
    pool,
    config.eventId,
    actor,
    "activate",
    key,
    { tokenHash: hash(credentialToken) },
    async (db) => {
      // Foreign-key inserts hold KEY SHARE on events. NO KEY UPDATE serializes the
      // counter without a lock-upgrade deadlock against those FK checks.
      const event = (
        await db.query("SELECT * FROM events WHERE id=$1 FOR NO KEY UPDATE", [
          config.eventId,
        ])
      ).rows[0];
      if (!event || event.status !== "ACTIVE") return failure("EVENT_CLOSED");
      const c = (
        await db.query(
          "SELECT * FROM credentials WHERE event_id=$1 AND token_hash=$2 FOR UPDATE",
          [config.eventId, hash(credentialToken)],
        )
      ).rows[0];
      if (!c) return failure("INVALID_CREDENTIAL", 404);
      if (c.status === "VOIDED") return failure("CREDENTIAL_VOIDED");
      if (c.status !== "ACTIVATED") {
        const count = (
          await db.query(
            "UPDATE events SET activation_count=activation_count+1 WHERE id=$1 RETURNING activation_count",
            [config.eventId],
          )
        ).rows[0].activation_count;
        c.activation_sequence = count;
        await db.query(
          "UPDATE credentials SET status='ACTIVATED',activation_sequence=$2,activated_at=now() WHERE id=$1",
          [c.id, count],
        );
        if (count <= 1000)
          await db.query(
            "INSERT INTO entitlements(event_id,credential_id) VALUES ($1,$2)",
            [config.eventId, c.id],
          );
        await audit(db, config.eventId, actor.id, "ACTIVATE", c.id);
      }
      const e = (
        await db.query(
          "SELECT status FROM entitlements WHERE credential_id=$1",
          [c.id],
        )
      ).rows[0];
      return {
        status: 200,
        body: {
          status: "ACTIVATED",
          activationSequence: c.activation_sequence,
          eligible: ["AVAILABLE", "REDEEMED"].includes(e?.status),
          entitlement: { status: e?.status ?? "NOT_ELIGIBLE" },
        },
      };
    },
  );
}
export async function redeem(
  pool: pg.Pool,
  config: Config,
  actor: Actor,
  key: string,
  input: { credentialToken: string; vendorId: string },
) {
  await authorizeVendor(pool, config.eventId, actor, input.vendorId);
  return idempotent(
    pool,
    config.eventId,
    actor,
    "redeem",
    key,
    { tokenHash: hash(input.credentialToken), vendorId: input.vendorId },
    async (db) => {
      await active(db, config.eventId);
      const c = (
        await db.query(
          "SELECT * FROM credentials WHERE event_id=$1 AND token_hash=$2 FOR UPDATE",
          [config.eventId, hash(input.credentialToken)],
        )
      ).rows[0];
      const e = c
        ? (
            await db.query(
              "SELECT * FROM entitlements WHERE credential_id=$1 FOR UPDATE",
              [c.id],
            )
          ).rows[0]
        : undefined;
      const error = c ? rejection(c, e) : "INVALID_CREDENTIAL";
      if (error) {
        await audit(
          db,
          config.eventId,
          actor.id,
          "REDEEM_REJECTED",
          c?.id ?? null,
          input.vendorId,
          { code: error },
        );
        return failure(
          error,
          c ? 409 : 404,
          error === "ALREADY_REDEEMED" ? "這張免費兌換資格已經使用" : error,
        );
      }
      const record = (
        await db.query(
          `INSERT INTO redemptions(event_id,entitlement_id,credential_id,vendor_id,redeemed_by,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [config.eventId, e.id, c.id, input.vendorId, actor.id, key],
        )
      ).rows[0];
      await db.query(
        "UPDATE entitlements SET status='REDEEMED',redeemed_at=$2 WHERE id=$1",
        [e.id, record.redeemed_at],
      );
      await audit(db, config.eventId, actor.id, "REDEEM", c.id, input.vendorId);
      return {
        status: 201,
        body: {
          success: true,
          redemptionId: record.id,
          status: "REDEEMED",
          vendorId: input.vendorId,
          redeemedAt: record.redeemed_at.toISOString(),
        },
      };
    },
  );
}
export async function createBatch(
  pool: pg.Pool,
  config: Config,
  actor: Actor,
  key: string,
  input: { name: string; quantity: number },
) {
  return idempotent(
    pool,
    config.eventId,
    actor,
    "batch",
    key,
    input,
    async (db) => {
      await active(db, config.eventId);
      const b = (
        await db.query(
          "INSERT INTO qr_batches(event_id,name,quantity,created_by) VALUES ($1,$2,$3,$4) RETURNING *",
          [config.eventId, input.name, input.quantity, actor.id],
        )
      ).rows[0];
      const cards = Array.from({ length: input.quantity }, () => ({
        publicCode: `EVT-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
        token: token(),
      }));
      await db.query(
        `INSERT INTO credentials(event_id,batch_id,public_code,token_hash)
      SELECT $1,$2,unnest($3::text[]),unnest($4::text[])`,
        [
          config.eventId,
          b.id,
          cards.map((c) => c.publicCode),
          cards.map((c) => hash(c.token)),
        ],
      );
      await db.query(
        "INSERT INTO print_artifacts(batch_id,ciphertext) VALUES ($1,$2)",
        [b.id, encrypt(cards, config.printKey)],
      );
      await audit(db, config.eventId, actor.id, "CREATE_BATCH", b.id, null, {
        quantity: input.quantity,
      });
      return {
        status: 201,
        body: {
          id: b.id,
          name: b.name,
          quantity: b.quantity,
          createdAt: b.created_at.toISOString(),
        },
      };
    },
  );
}
