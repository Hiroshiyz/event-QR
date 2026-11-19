import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  hash,
  token,
  passwordHash,
  checkPassword,
  encrypt,
  decrypt,
  csvCell,
} from "../src/server/crypto.js";
import { parseQr } from "../src/server/crypto-browser.js";
import { credentialStatus, rejection } from "../src/server/service.js";

describe("QR 與安全工具", () => {
  it("生成 256-bit 不可預測且不重複的 token", () => {
    const values = Array.from({ length: 1000 }, token);
    assert.equal(new Set(values).size, 1000);
    assert.ok(values.every((v) => v.length === 43));
    assert.notEqual(hash(values[0]), values[0]);
  });
  it("QR 解析僅接受完整憑證，不接受公開碼或 URL", () => {
    const value = token();
    assert.equal(parseQr("EVTQR:" + value), value);
    assert.equal(parseQr(value), value);
    assert.throws(() => parseQr("EVT-000001"));
    assert.throws(() => parseQr("https://example.com/?token=" + value));
  });
  it("加鹽密碼雜湊可驗證，錯誤密碼被拒", () => {
    const a = passwordHash("a-long-test-password"),
      b = passwordHash("a-long-test-password");
    assert.notEqual(a, b);
    assert.ok(checkPassword("a-long-test-password", a));
    assert.ok(!checkPassword("incorrect", a));
  });
  it("列印加密可往返，錯誤金鑰與竄改內容被拒", () => {
    const key = randomBytes(32).toString("hex"),
      data = [{ publicCode: "TEST", token: token() }],
      sealed = encrypt(data, key);
    assert.ok(!sealed.includes(data[0].token));
    assert.deepEqual(decrypt(sealed, key), data);
    assert.throws(() => decrypt(sealed, randomBytes(32).toString("hex")));
    const corrupted = Buffer.from(sealed, "base64");
    corrupted[30] ^= 1;
    assert.throws(() => decrypt(corrupted.toString("base64"), key));
  });
  it("CSV 防公式注入及正確轉義引號", () => {
    for (const text of [
      "=SUM(A1)",
      "+cmd",
      "-cmd",
      "@cmd",
      " \t=cmd",
      "\r=cmd",
    ])
      assert.ok(csvCell(text).startsWith("\"'"));
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell("咖啡"), '"咖啡"');
  });
  it("產生實際 QR PNG，且 QR 模組編碼可產生", async () => {
    const value = "EVTQR:" + token(),
      png = await QRCode.toBuffer(value);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(QRCode.create(value).modules.size > 20);
    const decoded = PNG.sync.read(png);
    const qr = jsQR(
      new Uint8ClampedArray(decoded.data),
      decoded.width,
      decoded.height,
    );
    assert.equal(qr?.data, value);
    assert.equal(parseQr(qr!.data), value.slice(6));
  });
  it("完整資格狀態不將已兌換或撤銷視為可核銷", () => {
    for (const state of ["CREATED", "VOIDED"])
      assert.equal(
        credentialStatus({ status: state }, { status: "AVAILABLE" }).redeemable,
        false,
      );
    assert.equal(
      credentialStatus({ status: "ACTIVATED" }, { status: "AVAILABLE" })
        .redeemable,
      true,
    );
    assert.equal(
      credentialStatus({ status: "ACTIVATED" }, { status: "REDEEMED" })
        .redeemable,
      false,
    );
    assert.equal(
      credentialStatus({ status: "ACTIVATED" }, { status: "REVOKED" }).eligible,
      false,
    );
    assert.equal(
      rejection({ status: "ACTIVATED" }, { status: "REDEEMED" }),
      "ALREADY_REDEEMED",
    );
  });
});
