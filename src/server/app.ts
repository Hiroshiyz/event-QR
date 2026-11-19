import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type pg from "pg";
import type { Config } from "./config.js";
import {
  hash,
  token,
  checkPassword,
  passwordHash,
  decrypt,
  csvCell,
} from "./crypto.js";
import { transaction } from "./db.js";
import {
  ApiError,
  type Actor,
  failure,
  audit,
  active,
  authorizeVendor,
  credentialStatus,
  rejection,
  activate,
  redeem,
  createBatch,
} from "./service.js";

const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const vendorInput = z
  .object({ credentialToken: credential, vendorId: z.uuid() })
  .strict();
const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dummyHash = passwordHash("constant-timing-dummy-password");
declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}
export async function buildApp(config: Config, pool: pg.Pool) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
    rewriteUrl: (req) =>
      req.url?.startsWith("/api/") ? req.url.slice(4) : (req.url ?? "/"),
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send(failure("INVALID_INPUT", 400, "請檢查輸入欄位").body);
    if (error instanceof ApiError)
      return reply
        .code(error.httpStatus)
        .send(failure(error.code, error.httpStatus, error.message).body);
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply
        .code(status)
        .send(
          failure(status === 429 ? "RATE_LIMITED" : "INVALID_REQUEST", status)
            .body,
        );
    // Never log payloads, tokens, connection strings, or raw database errors.
    console.error("API request failed", {
      code: (error as { code?: string }).code ?? "INTERNAL",
    });
    return reply
      .code(500)
      .send(failure("INTERNAL_ERROR", 500, "操作失敗，請使用原請求重試").body);
  });
  const protectedPath = (path: string) =>
    !["/auth/login", "/health", "/tickets/"].some(
      (p) => path === p || (p === "/tickets/" && path.startsWith(p)),
    ) &&
    !path.startsWith("/assets/") &&
    path !== "/";
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer");
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin !== config.origin
    )
      throw new ApiError("INVALID_ORIGIN", 403);
    if (!protectedPath(path)) return;
    const sessionToken = req.cookies.session;
    const row =
      sessionToken &&
      (
        await pool.query(
          `SELECT u.id,u.email,u.role,s.csrf_token FROM sessions s JOIN staff_users u ON u.id=s.staff_user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
          [hash(sessionToken)],
        )
      ).rows[0];
    if (!row) throw new ApiError("UNAUTHENTICATED", 401);
    req.actor = {
      id: row.id,
      email: row.email,
      role: row.role,
      csrf: row.csrf_token,
    };
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-csrf-token"] !== row.csrf_token
    )
      throw new ApiError("INVALID_CSRF", 403);
  });
  const staff = (actor: Actor) => {
    if (actor.role !== "EVENT_STAFF") throw new ApiError("FORBIDDEN", 403);
  };
  const report = (actor: Actor) => {
    if (!["EVENT_STAFF", "FINANCE"].includes(actor.role))
      throw new ApiError("FORBIDDEN", 403);
  };
  const key = (req: { headers: any }) =>
    z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(req.headers["idempotency-key"]);
  app.get("/health", async () => ({ ok: true }));
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(req.body);
      const user = (
        await pool.query("SELECT * FROM staff_users WHERE email=$1", [
          input.email,
        ])
      ).rows[0];
      const valid = checkPassword(
        input.password,
        user?.password_hash ?? dummyHash,
      );
      if (!user?.active || !valid)
        throw new ApiError("INVALID_LOGIN", 401, "帳號或密碼錯誤");
      const sessionToken = token(),
        csrf = token();
      await pool.query(
        "INSERT INTO sessions(token_hash,staff_user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')",
        [hash(sessionToken), user.id, csrf],
      );
      reply.setCookie("session", sessionToken, {
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
      });
      return {
        id: user.id,
        email: user.email,
        role: user.role,
        csrfToken: csrf,
      };
    },
  );
  app.get("/auth/me", async (req) => {
    const vendors = (
      await pool.query(
        `SELECT v.id,v.name FROM vendors v JOIN vendor_staff_assignments a ON a.vendor_id=v.id
      WHERE a.staff_user_id=$1 AND v.event_id=$2 AND v.active ORDER BY v.name`,
        [req.actor!.id, config.eventId],
      )
    ).rows;
    return { ...req.actor, csrfToken: req.actor!.csrf, vendors };
  });
  app.post("/auth/logout", async (req, reply) => {
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(req.cookies.session!),
    ]);
    reply.clearCookie("session", { path: "/" });
    return { success: true };
  });
  app.post("/admissions/activate", async (req, reply) => {
    staff(req.actor!);
    const input = z
      .object({ credentialToken: credential })
      .strict()
      .parse(req.body);
    const result = await activate(
      pool,
      config,
      req.actor!,
      key(req),
      input.credentialToken,
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/vendor/redemptions/validate", async (req) => {
    const input = vendorInput.parse(req.body);
    await authorizeVendor(pool, config.eventId, req.actor!, input.vendorId);
    return transaction(pool, async (db) => {
      await active(db, config.eventId);
      const c = (
        await db.query(
          "SELECT * FROM credentials WHERE event_id=$1 AND token_hash=$2",
          [config.eventId, hash(input.credentialToken)],
        )
      ).rows[0];
      if (!c) {
        await audit(
          db,
          config.eventId,
          req.actor!.id,
          "VALIDATE_REJECTED",
          null,
          input.vendorId,
          { code: "INVALID_CREDENTIAL" },
        );
        return { invalid: true };
      }
      const e = (
        await db.query("SELECT * FROM entitlements WHERE credential_id=$1", [
          c.id,
        ])
      ).rows[0];
      const code = rejection(c, e);
      if (code)
        await audit(
          db,
          config.eventId,
          req.actor!.id,
          "VALIDATE_REJECTED",
          c.id,
          input.vendorId,
          { code },
        );
      return {
        ...credentialStatus(c, e),
        publicCode: c.public_code,
        message: code ? code : "可以免費兌換商品",
      };
    }).then((result) => {
      if ("invalid" in result) throw new ApiError("INVALID_CREDENTIAL", 404);
      return result;
    });
  });
  app.post("/vendor/redemptions", async (req, reply) => {
    const input = vendorInput.parse(req.body),
      result = await redeem(pool, config, req.actor!, key(req), input);
    return reply.code(result.status).send(result.body);
  });
  app.post("/admin/qr-batches", async (req, reply) => {
    staff(req.actor!);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        quantity: z.number().int().min(1).max(5000),
      })
      .strict()
      .parse(req.body);
    const result = await createBatch(pool, config, req.actor!, key(req), input);
    return reply.code(result.status).send(result.body);
  });
  app.get("/admin/qr-batches", async (req) => {
    staff(req.actor!);
    const q = pageInput.strict().parse(req.query);
    return {
      items: (
        await pool.query(
          `SELECT b.id,b.name,b.quantity,b.created_at AS "createdAt",p.expires_at AS "printExpiresAt"
      FROM qr_batches b LEFT JOIN print_artifacts p ON p.batch_id=b.id WHERE b.event_id=$1 ORDER BY b.created_at DESC,b.id LIMIT $2 OFFSET $3`,
          [config.eventId, q.limit, (q.page - 1) * q.limit],
        )
      ).rows,
      page: q.page,
      limit: q.limit,
    };
  });
  app.get("/admin/qr-batches/:id", async (req) => {
    staff(req.actor!);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = (
      await pool.query(
        'SELECT id,name,quantity,created_at AS "createdAt" FROM qr_batches WHERE id=$1 AND event_id=$2',
        [id, config.eventId],
      )
    ).rows[0];
    if (!b) throw new ApiError("NOT_FOUND", 404);
    return b;
  });
  app.get("/admin/qr-batches/:id/print", async (req) => {
    staff(req.actor!);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return transaction(pool, async (db) => {
      const artifact = (
        await db.query(
          `SELECT p.ciphertext,b.name FROM print_artifacts p JOIN qr_batches b ON b.id=p.batch_id
        WHERE b.id=$1 AND b.event_id=$2 AND p.expires_at>now()`,
          [id, config.eventId],
        )
      ).rows[0];
      if (!artifact)
        throw new ApiError(
          "PRINT_EXPIRED_OR_NOT_FOUND",
          404,
          "列印內容不存在或已超過 24 小時",
        );
      const cards = decrypt<{ publicCode: string; token: string }[]>(
        artifact.ciphertext,
        config.printKey,
      );
      await audit(db, config.eventId, req.actor!.id, "DOWNLOAD_PRINT", id);
      return {
        name: artifact.name,
        cards: cards.map((c) => ({
          publicCode: c.publicCode,
          qrContent: `EVTQR:${c.token}`,
        })),
      };
    });
  });
  app.get("/tickets/:publicCode", async (req) => {
    const { publicCode } = z
      .object({ publicCode: z.string().max(40) })
      .parse(req.params);
    const secret = credential.parse(req.headers["x-credential-token"]);
    const c = (
      await pool.query(
        "SELECT * FROM credentials WHERE event_id=$1 AND public_code=$2 AND token_hash=$3",
        [config.eventId, publicCode, hash(secret)],
      )
    ).rows[0];
    if (!c) throw new ApiError("INVALID_CREDENTIAL", 404);
    const e = (
      await pool.query(
        "SELECT status FROM entitlements WHERE credential_id=$1",
        [c.id],
      )
    ).rows[0];
    return {
      publicCode,
      credentialStatus: c.status,
      activationSequence: c.activation_sequence,
      entitlement: { status: e?.status ?? "NOT_ELIGIBLE" },
    };
  });
  async function dashboard() {
    return transaction(pool, async (db) => {
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const event = (
        await db.query(
          "SELECT name,status,activation_count FROM events WHERE id=$1",
          [config.eventId],
        )
      ).rows[0];
      if (!event) throw new ApiError("EVENT_NOT_FOUND", 404);
      const c = await db.query(
        "SELECT count(*)::int AS total FROM credentials WHERE event_id=$1",
        [config.eventId],
      );
      const e = await db.query(
        "SELECT count(*)::int AS issued,count(*) FILTER (WHERE status='AVAILABLE')::int AS available FROM entitlements WHERE event_id=$1",
        [config.eventId],
      );
      const r = await db.query(
        "SELECT count(*)::int AS total FROM redemptions WHERE event_id=$1",
        [config.eventId],
      );
      return {
        eventName: event.name,
        eventStatus: event.status,
        generated: c.rows[0].total,
        activated: event.activation_count,
        issued: e.rows[0].issued,
        available: e.rows[0].available,
        redeemed: r.rows[0].total,
        remaining: 1000 - e.rows[0].issued,
        quota: 1000,
      };
    });
  }
  app.get("/admissions/progress", async (req) => {
    staff(req.actor!);
    return dashboard();
  });
  app.get("/admin/dashboard", async (req) => {
    report(req.actor!);
    return dashboard();
  });
  app.get("/admin/reports/vendors", async (req) => {
    report(req.actor!);
    const items = (
      await pool.query(
        `SELECT v.id,v.name,count(r.id)::int AS count FROM vendors v
      LEFT JOIN redemptions r ON r.vendor_id=v.id AND r.event_id=v.event_id WHERE v.event_id=$1 GROUP BY v.id ORDER BY count(r.id) DESC,v.name`,
        [config.eventId],
      )
    ).rows;
    const total = items.reduce((n, v) => n + v.count, 0);
    return {
      total,
      items: items.map((v) => ({ ...v, share: total ? v.count / total : 0 })),
    };
  });
  app.get("/vendor/redemptions", async (req) => {
    const q = pageInput
      .extend({ vendorId: z.uuid() })
      .strict()
      .parse(req.query);
    await authorizeVendor(pool, config.eventId, req.actor!, q.vendorId);
    return transaction(pool, async (db) => {
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const rows = await db.query(
        `SELECT r.id,c.public_code AS "publicCode",r.redeemed_at AS "redeemedAt" FROM redemptions r
        JOIN credentials c ON c.id=r.credential_id WHERE r.event_id=$1 AND r.vendor_id=$2 ORDER BY r.redeemed_at DESC,r.id LIMIT $3 OFFSET $4`,
        [config.eventId, q.vendorId, q.limit, (q.page - 1) * q.limit],
      );
      const counts = (
        await db.query(
          `SELECT (SELECT count(*)::int FROM redemptions WHERE event_id=$1 AND vendor_id=$2
        AND redeemed_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei')) AS redeemed,
        (SELECT count(*)::int FROM audit_logs WHERE event_id=$1 AND vendor_id=$2 AND action IN ('REDEEM_REJECTED','VALIDATE_REJECTED')
        AND created_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei')) AS failed`,
          [config.eventId, q.vendorId],
        )
      ).rows[0];
      return { items: rows.rows, today: counts, page: q.page, limit: q.limit };
    });
  });
  app.get("/admin/reports/export", async (req, reply) => {
    report(req.actor!);
    // Explicit SQL formatting avoids interpreting a timestamp-without-time-zone in the host timezone.
    const formatted = (
      await pool.query(
        `SELECT r.id,c.public_code,v.name,r.vendor_id,
      to_char(r.redeemed_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD"T"HH24:MI:SS.MS') || '+08:00' AS local_time
      FROM redemptions r JOIN credentials c ON c.id=r.credential_id JOIN vendors v ON v.id=r.vendor_id
      WHERE r.event_id=$1 ORDER BY r.redeemed_at,r.id`,
        [config.eventId],
      )
    ).rows;
    await transaction(pool, (db) =>
      audit(db, config.eventId, req.actor!.id, "EXPORT_REPORT", null),
    );
    reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="redemptions.csv"');
    return (
      "\uFEFF" +
      [
        [
          "redemptionId",
          "publicCode",
          "vendorName",
          "vendorId",
          "redeemedAt (Asia/Taipei)",
        ]
          .map(csvCell)
          .join(","),
        ...formatted.map((r) =>
          [r.id, r.public_code, r.name, r.vendor_id, r.local_time]
            .map(csvCell)
            .join(","),
        ),
      ].join("\r\n")
    );
  });
  app.get("/requests/:operation/:key", async (req) => {
    const p = z
      .object({
        operation: z.enum(["activate", "redeem", "batch"]),
        key: z
          .string()
          .min(8)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .parse(req.params);
    if (p.operation === "redeem" && req.actor!.role !== "VENDOR")
      throw new ApiError("FORBIDDEN", 403);
    if (p.operation !== "redeem") staff(req.actor!);
    const r = (
      await pool.query(
        "SELECT http_status,response FROM idempotency_requests WHERE event_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4",
        [config.eventId, req.actor!.id, p.operation, p.key],
      )
    ).rows[0];
    if (!r?.response) throw new ApiError("REQUEST_NOT_FOUND", 404);
    if (p.operation === "redeem" && r.response.vendorId)
      await authorizeVendor(
        pool,
        config.eventId,
        req.actor!,
        r.response.vendorId,
      );
    return { httpStatus: r.http_status, result: r.response };
  });
  return app;
}
