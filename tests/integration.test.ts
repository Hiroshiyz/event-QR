import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { makePool, migrate, transaction } from "../src/server/db.js";
import { token, hash, passwordHash, decrypt } from "../src/server/crypto.js";
import {
  activate,
  redeem,
  createBatch,
  type Actor,
} from "../src/server/service.js";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
const pool = makePool(url),
  apps: FastifyInstance[] = [];
before(async () => {
  await migrate(pool);
});
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await pool.end();
});
async function fixture(activated = 0, count = 4) {
  const eventId = randomUUID(),
    staffId = randomUUID(),
    aId = randomUUID(),
    bId = randomUUID(),
    financeId = randomUUID(),
    batchId = randomUUID();
  const vendorA = randomUUID(),
    vendorB = randomUUID();
  const config: Config = {
    databaseUrl: url!,
    eventId,
    origin: "http://localhost:5173",
    printKey: randomBytes(32).toString("hex"),
    production: false,
  };
  await pool.query(
    "INSERT INTO events(id,name,activation_count) VALUES ($1,$2,$3)",
    [eventId, "測試活動", activated],
  );
  const secret = passwordHash("integration-password-123");
  for (const [id, role] of [
    [staffId, "EVENT_STAFF"],
    [aId, "VENDOR"],
    [bId, "VENDOR"],
    [financeId, "FINANCE"],
  ]) {
    await pool.query(
      "INSERT INTO staff_users(id,email,password_hash,role) VALUES ($1,$2,$3,$4)",
      [id, id + "@test.invalid", secret, role],
    );
  }
  await pool.query(
    "INSERT INTO vendors(id,event_id,name) VALUES ($1,$3,$4),($2,$3,$5)",
    [vendorA, vendorB, eventId, "A 攤", "B 攤"],
  );
  await pool.query(
    "INSERT INTO vendor_staff_assignments VALUES ($1,$2),($3,$4)",
    [aId, vendorA, bId, vendorB],
  );
  await pool.query(
    "INSERT INTO qr_batches(id,event_id,name,quantity,created_by) VALUES ($1,$2,$3,$4,$5)",
    [batchId, eventId, "測試批次", Math.max(1, count + activated), staffId],
  );
  if (activated) {
    await pool.query(
      `INSERT INTO credentials(event_id,batch_id,public_code,token_hash,status,activation_sequence,activated_at)
      SELECT $1::uuid,$2::uuid,'seed-'||g,$1::uuid::text||'-seed-'||g,'ACTIVATED',g,now() FROM generate_series(1,$3::int) g`,
      [eventId, batchId, activated],
    );
    await pool.query(
      "INSERT INTO entitlements(event_id,credential_id) SELECT event_id,id FROM credentials WHERE event_id=$1 AND activation_sequence<=1000",
      [eventId],
    );
  }
  const cards = Array.from({ length: count }, () => ({
    id: randomUUID(),
    token: token(),
    code: "TEST-" + randomUUID().slice(0, 20),
  }));
  for (const card of cards)
    await pool.query(
      "INSERT INTO credentials(id,event_id,batch_id,public_code,token_hash) VALUES ($1,$2,$3,$4,$5)",
      [card.id, eventId, batchId, card.code, hash(card.token)],
    );
  const actor = (id: string, role: Actor["role"]): Actor => ({
    id,
    role,
    email: id + "@test.invalid",
    csrf: token(),
  });
  const staff = actor(staffId, "EVENT_STAFF"),
    a = actor(aId, "VENDOR"),
    b = actor(bId, "VENDOR"),
    finance = actor(financeId, "FINANCE");
  const app = await buildApp(config, pool);
  await app.ready();
  apps.push(app);
  async function headers(actor: Actor) {
    const session = token();
    await pool.query(
      "INSERT INTO sessions VALUES ($1,$2,$3,now()+interval '1 hour')",
      [hash(session), actor.id, actor.csrf],
    );
    return {
      cookie: `session=${session}`,
      origin: config.origin,
      "x-csrf-token": actor.csrf,
      "idempotency-key": randomUUID(),
    };
  }
  const activateCard = (index = 0, key = randomUUID()) =>
    activate(pool, config, staff, key, cards[index].token);
  const redeemCard = (
    index = 0,
    who = a,
    vendorId = vendorA,
    key = randomUUID(),
  ) =>
    redeem(pool, config, who, key, {
      credentialToken: cards[index].token,
      vendorId,
    });
  return {
    config,
    staff,
    a,
    b,
    finance,
    vendorA,
    vendorB,
    cards,
    app,
    headers,
    activateCard,
    redeemCard,
  };
}
async function counts(event: string) {
  return (
    await pool.query(
      `SELECT (SELECT activation_count FROM events WHERE id=$1) AS activations,
    (SELECT count(*)::int FROM entitlements WHERE event_id=$1) AS issued,
    (SELECT count(*)::int FROM redemptions WHERE event_id=$1) AS redeemed`,
      [event],
    )
  ).rows[0];
}
describe("PostgreSQL 入場啟用", () => {
  it("ACT-001 首位啟用取得序號 1 與免費資格", async () => {
    const f = await fixture();
    const r = await f.activateCard();
    assert.equal(r.body.activationSequence, 1);
    assert.equal(r.body.entitlement.status, "AVAILABLE");
  });
  it("ACT-002 / ACT-003 第1000位有資格，第1001位仍正常入場", async () => {
    const f = await fixture(999);
    const first = await f.activateCard(0),
      second = await f.activateCard(1);
    assert.equal(first.body.activationSequence, 1000);
    assert.equal(first.body.eligible, true);
    assert.equal(second.body.activationSequence, 1001);
    assert.equal(second.body.eligible, false);
    assert.equal(second.body.status, "ACTIVATED");
    assert.equal((await counts(f.config.eventId)).issued, 1000);
    await assert.rejects(
      pool.query(
        "INSERT INTO entitlements(event_id,credential_id) VALUES ($1,$2)",
        [f.config.eventId, f.cards[1].id],
      ),
      { code: "23514" },
    );
  });
  it("ACT-004 同張 QR 並發重複啟用維持序號，不重複計數", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.activateCard()),
    );
    assert.ok(results.every((r) => r.body.activationSequence === 1));
    assert.deepEqual(await counts(f.config.eventId), {
      activations: 1,
      issued: 1,
      redeemed: 0,
    });
    await assert.rejects(
      pool.query("UPDATE credentials SET activation_sequence=2 WHERE id=$1", [
        f.cards[0].id,
      ]),
      { code: "23514" },
    );
  });
  it("ACT-005 100筆並發跨越第1000名，序號唯一且僅新增50份資格", async () => {
    const f = await fixture(950, 100);
    const results = await Promise.all(f.cards.map((_, i) => f.activateCard(i)));
    const seq = results
      .map((r) => r.body.activationSequence)
      .sort((a, b) => a - b);
    assert.deepEqual(
      seq,
      Array.from({ length: 100 }, (_, i) => 951 + i),
    );
    assert.equal(results.filter((r) => r.body.eligible).length, 50);
    assert.deepEqual(await counts(f.config.eventId), {
      activations: 1050,
      issued: 1000,
      redeemed: 0,
    });
  });
  it("ACT-006 交易途中故障全部回滾，重試仍取得序號1", async () => {
    const f = await fixture();
    await pool.query(`CREATE FUNCTION test_fail_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.actor_id='${f.staff.id}'::uuid AND NEW.action='ACTIVATE' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_activation BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_activation()`);
    const key = randomUUID();
    try {
      await assert.rejects(f.activateCard(0, key));
      assert.deepEqual(await counts(f.config.eventId), {
        activations: 0,
        issued: 0,
        redeemed: 0,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT status,activation_sequence FROM credentials WHERE id=$1",
            [f.cards[0].id],
          )
        ).rows[0].status,
        "CREATED",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM idempotency_requests WHERE event_id=$1",
            [f.config.eventId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        "DROP TRIGGER test_fail_activation ON audit_logs; DROP FUNCTION test_fail_activation()",
      );
    }
    assert.equal((await f.activateCard(0, key)).body.activationSequence, 1);
  });
});
describe("PostgreSQL 全域核銷", () => {
  it("RED-001 / RED-002 A成功後B回ALREADY_REDEEMED且只一筆紀錄", async () => {
    const f = await fixture();
    await f.activateCard();
    assert.equal((await f.redeemCard()).status, 201);
    assert.equal(
      (await f.redeemCard(0, f.b, f.vendorB)).body.error.code,
      "ALREADY_REDEEMED",
    );
    assert.equal((await counts(f.config.eventId)).redeemed, 1);
    const row = (
      await pool.query(
        "SELECT vendor_id,redeemed_by FROM redemptions WHERE event_id=$1",
        [f.config.eventId],
      )
    ).rows[0];
    assert.equal(row.vendor_id, f.vendorA);
    assert.equal(row.redeemed_by, f.a.id);
  });
  it("RED-003 A、B同時核銷，恰好一筆成功", async () => {
    const f = await fixture();
    await f.activateCard();
    const r = await Promise.all([
      f.redeemCard(),
      f.redeemCard(0, f.b, f.vendorB),
    ]);
    assert.equal(r.filter((r) => r.status === 201).length, 1);
    assert.equal(
      r.filter((r) => r.body.error?.code === "ALREADY_REDEEMED").length,
      1,
    );
    assert.equal((await counts(f.config.eventId)).redeemed, 1);
  });
  it("RED-004 同請求同鍵並發重送10次，回同筆成功且僅一紀錄", async () => {
    const f = await fixture();
    await f.activateCard();
    const key = randomUUID(),
      results = await Promise.all(
        Array.from({ length: 10 }, () => f.redeemCard(0, f.a, f.vendorA, key)),
      );
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.redemptionId)).size, 1);
    assert.equal((await counts(f.config.eventId)).redeemed, 1);
  });
  it("RED-005 只驗證維持AVAILABLE且不建立核銷", async () => {
    const f = await fixture();
    await f.activateCard();
    const r = await f.app.inject({
      method: "POST",
      url: "/vendor/redemptions/validate",
      headers: await f.headers(f.a),
      payload: { credentialToken: f.cards[0].token, vendorId: f.vendorA },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().redeemable, true);
    assert.equal((await counts(f.config.eventId)).redeemed, 0);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM entitlements WHERE credential_id=$1",
          [f.cards[0].id],
        )
      ).rows[0].status,
      "AVAILABLE",
    );
  });
  it("RED-006 第1001位無免費資格拒絕核銷", async () => {
    const f = await fixture(1000);
    await f.activateCard();
    assert.equal((await f.redeemCard()).body.error.code, "NOT_ELIGIBLE");
  });
  it("RED-007 未啟用、作廢、撤銷及無效QR拒絕核銷", async () => {
    const f = await fixture();
    assert.equal((await f.redeemCard()).body.error.code, "NOT_ACTIVATED");
    await pool.query("UPDATE credentials SET status='VOIDED' WHERE id=$1", [
      f.cards[0].id,
    ]);
    assert.equal((await f.redeemCard()).body.error.code, "CREDENTIAL_VOIDED");
    await f.activateCard(1);
    await pool.query(
      "UPDATE entitlements SET status='REVOKED' WHERE credential_id=$1",
      [f.cards[1].id],
    );
    assert.equal(
      (await f.redeemCard(1)).body.error.code,
      "ENTITLEMENT_REVOKED",
    );
    const r = await redeem(pool, f.config, f.a, randomUUID(), {
      credentialToken: token(),
      vendorId: f.vendorA,
    });
    assert.equal(r.status, 404);
  });
  it("RED-008 使用未授權vendorId回403且不修改資格", async () => {
    const f = await fixture();
    await f.activateCard();
    const r = await f.app.inject({
      method: "POST",
      url: "/vendor/redemptions",
      headers: await f.headers(f.a),
      payload: { credentialToken: f.cards[0].token, vendorId: f.vendorB },
    });
    assert.equal(r.statusCode, 403);
    assert.equal((await counts(f.config.eventId)).redeemed, 0);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM entitlements WHERE credential_id=$1",
          [f.cards[0].id],
        )
      ).rows[0].status,
      "AVAILABLE",
    );
  });
  it("核銷交易故障回滾成功紀錄、資格及冪等結果", async () => {
    const f = await fixture();
    await f.activateCard();
    await pool.query(`CREATE FUNCTION test_fail_redeem() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.actor_id='${f.a.id}'::uuid AND NEW.action='REDEEM' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_redeem BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_redeem()`);
    const key = randomUUID();
    try {
      await assert.rejects(f.redeemCard(0, f.a, f.vendorA, key));
      assert.equal((await counts(f.config.eventId)).redeemed, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM entitlements WHERE credential_id=$1",
            [f.cards[0].id],
          )
        ).rows[0].status,
        "AVAILABLE",
      );
    } finally {
      await pool.query(
        "DROP TRIGGER test_fail_redeem ON audit_logs; DROP FUNCTION test_fail_redeem()",
      );
    }
    assert.equal((await f.redeemCard(0, f.a, f.vendorA, key)).status, 201);
  });
  it("資料庫唯一約束拒絕第二筆成功核銷", async () => {
    const f = await fixture();
    await f.activateCard();
    await f.redeemCard();
    await assert.rejects(
      pool.query(
        `INSERT INTO redemptions(event_id,entitlement_id,credential_id,vendor_id,redeemed_by,idempotency_key)
      SELECT event_id,entitlement_id,credential_id,vendor_id,redeemed_by,'duplicate' FROM redemptions WHERE event_id=$1`,
        [f.config.eventId],
      ),
      { code: "23505" },
    );
  });
});
describe("報表與匯出", () => {
  it("RPT-001 / RPT-002 A=30、B=20、總數50，重複核銷不增加報表", async () => {
    const f = await fixture(0, 50);
    await Promise.all(f.cards.map((_, i) => f.activateCard(i)));
    await Promise.all(
      f.cards.map((_, i) =>
        f.redeemCard(i, i < 30 ? f.a : f.b, i < 30 ? f.vendorA : f.vendorB),
      ),
    );
    await f.redeemCard();
    const r = await f.app.inject({
      url: "/admin/reports/vendors",
      headers: await f.headers(f.finance),
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().total, 50);
    assert.deepEqual(
      r.json().items.map((v: any) => v.count),
      [30, 20],
    );
  });
  it("RPT-003 發放1000且兌換600：已兌換600、未兌換400、剩餘名額0", async () => {
    const f = await fixture(1000);
    await transaction(pool, async (db) => {
      const ids = (
        await db.query(
          "SELECT * FROM entitlements WHERE event_id=$1 ORDER BY id LIMIT 600",
          [f.config.eventId],
        )
      ).rows;
      await db.query(
        `INSERT INTO redemptions(event_id,entitlement_id,credential_id,vendor_id,redeemed_by,idempotency_key)
        SELECT event_id,id,credential_id,$2,$3,'fixture-report' FROM entitlements WHERE id=ANY($1::uuid[])`,
        [ids.map((i) => i.id), f.vendorA, f.a.id],
      );
      await db.query(
        "UPDATE entitlements SET status='REDEEMED',redeemed_at=now() WHERE id=ANY($1::uuid[])",
        [ids.map((i) => i.id)],
      );
    });
    const r = await f.app.inject({
      url: "/admin/dashboard",
      headers: await f.headers(f.finance),
    });
    assert.equal(r.json().issued, 1000);
    assert.equal(r.json().redeemed, 600);
    assert.equal(r.json().available, 400);
    assert.equal(r.json().remaining, 0);
  });
  it("RPT-004 CSV正確、不洩露token、hash、操作人員，並防公式注入", async () => {
    const f = await fixture();
    await f.activateCard();
    await f.redeemCard();
    await pool.query("UPDATE vendors SET name=$1 WHERE id=$2", [
      "=SUM(A1)",
      f.vendorA,
    ]);
    const r = await f.app.inject({
      url: "/admin/reports/export",
      headers: await f.headers(f.finance),
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-type"]!, /text\/csv/);
    assert.match(r.body, /\+08:00/);
    assert.ok(r.body.includes(f.cards[0].code));
    assert.ok(r.body.includes("'=SUM(A1)"));
    assert.ok(!r.body.includes(f.cards[0].token));
    assert.ok(!r.body.includes(hash(f.cards[0].token)));
    assert.ok(!r.body.includes(f.a.email));
    assert.equal(r.body.split("\r\n").length, 2);
  });
});
describe("認證、契約與列印", () => {
  it("登入、CSRF、Origin、登出、過期Session及財務寫入限制", async () => {
    const f = await fixture();
    assert.equal(
      (await f.app.inject({ url: "/admin/dashboard" })).statusCode,
      401,
    );
    const login = await f.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: f.config.origin },
      payload: { email: f.staff.email, password: "integration-password-123" },
    });
    assert.equal(login.statusCode, 200);
    assert.match(login.headers["set-cookie"]!.toString(), /HttpOnly/);
    const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const headers = {
      cookie,
      origin: f.config.origin,
      "x-csrf-token": login.json().csrfToken,
    };
    assert.equal(
      (await f.app.inject({ url: "/auth/me", headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { cookie, origin: f.config.origin },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { ...headers, origin: "https://evil.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ method: "POST", url: "/auth/logout", headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ url: "/auth/me", headers })).statusCode,
      401,
    );
    const finance = await f.headers(f.finance);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/admissions/activate",
          headers: finance,
          payload: { credentialToken: f.cards[0].token },
        })
      ).statusCode,
      403,
    );
    const expired = await f.headers(f.staff);
    await pool.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(expired.cookie.slice(8))],
    );
    assert.equal(
      (await f.app.inject({ url: "/auth/me", headers: expired })).statusCode,
      401,
    );
  });
  it("同冪等鍵不同payload回409，查詢僅限本人；重播前重新檢查攤位授權", async () => {
    const f = await fixture();
    await f.activateCard();
    await f.activateCard(1);
    const key = randomUUID();
    await f.redeemCard(0, f.a, f.vendorA, key);
    assert.equal(
      (await f.redeemCard(1, f.a, f.vendorA, key)).body.error.code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/requests/redeem/${key}`,
          headers: await f.headers(f.a),
        })
      ).json().result.success,
      true,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/requests/redeem/${key}`,
          headers: await f.headers(f.b),
        })
      ).statusCode,
      404,
    );
    await pool.query(
      "DELETE FROM vendor_staff_assignments WHERE staff_user_id=$1",
      [f.a.id],
    );
    await assert.rejects(f.redeemCard(0, f.a, f.vendorA, key), {
      code: "FORBIDDEN_VENDOR",
    });
  });
  it("批次建立冪等、hash唯一、建立不核發，列印內容加密且受權限與期限保護", async () => {
    const f = await fixture(),
      key = randomUUID();
    const r = await createBatch(pool, f.config, f.staff, key, {
      name: "實體測試",
      quantity: 3,
    });
    assert.equal(
      (
        await createBatch(pool, f.config, f.staff, key, {
          name: "實體測試",
          quantity: 3,
        })
      ).body.id,
      r.body.id,
    );
    const data = (
      await pool.query(
        "SELECT ciphertext FROM print_artifacts WHERE batch_id=$1",
        [r.body.id],
      )
    ).rows[0];
    const cards = decrypt<{ token: string; publicCode: string }[]>(
      data.ciphertext,
      f.config.printKey,
    );
    assert.equal(cards.length, 3);
    assert.equal(new Set(cards.map((c) => c.token)).size, 3);
    assert.ok(!data.ciphertext.includes(cards[0].token));
    assert.equal((await counts(f.config.eventId)).issued, 0);
    const printed = await f.app.inject({
      url: `/admin/qr-batches/${r.body.id}/print`,
      headers: await f.headers(f.staff),
    });
    assert.equal(printed.statusCode, 200);
    assert.equal(printed.json().cards[0].qrContent, "EVTQR:" + cards[0].token);
    assert.equal(printed.headers["cache-control"], "no-store");
    assert.equal(
      (
        await f.app.inject({
          url: `/admin/qr-batches/${r.body.id}/print`,
          headers: await f.headers(f.finance),
        })
      ).statusCode,
      403,
    );
    await pool.query(
      "UPDATE print_artifacts SET expires_at=now()-interval '1 second' WHERE batch_id=$1",
      [r.body.id],
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/admin/qr-batches/${r.body.id}/print`,
          headers: await f.headers(f.staff),
        })
      ).statusCode,
      404,
    );
  });
  it("持有人查詢須持有效token，拒絕未知欄位與偽造activationSequence", async () => {
    const f = await fixture(),
      headers = await f.headers(f.staff);
    assert.equal(
      (await f.app.inject({ url: `/tickets/${f.cards[0].code}` })).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/tickets/${f.cards[0].code}`,
          headers: { "x-credential-token": f.cards[0].token },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/admissions/activate",
          headers,
          payload: { credentialToken: f.cards[0].token, activationSequence: 1 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/admin/reports/vendors",
          headers: await f.headers(f.a),
        })
      ).statusCode,
      403,
    );
  });
  it("活動關閉拒絕寫入，登入與列印錯誤不洩露秘密", async () => {
    const f = await fixture();
    await pool.query("UPDATE events SET status='CLOSED' WHERE id=$1", [
      f.config.eventId,
    ]);
    assert.equal((await f.activateCard()).body.error.code, "EVENT_CLOSED");
    const r = await f.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: f.config.origin },
      payload: { email: f.staff.email, password: "bad" },
    });
    assert.equal(r.statusCode, 401);
    assert.ok(!r.body.includes("password_hash"));
  });
});
