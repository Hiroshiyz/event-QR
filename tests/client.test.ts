import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { token } from "../src/server/crypto.js";
import { mutate, setCsrf, clearPending } from "../src/client/api.js";
const originalFetch = globalThis.fetch;
const data = new Map<string, string>();
const storage: Storage = {
  get length() {
    return data.size;
  },
  clear: () => data.clear(),
  getItem: (key) => data.get(key) ?? null,
  removeItem: (key) => {
    data.delete(key);
  },
  setItem: (key, value) => {
    data.set(key, value);
  },
  key: (index) => Array.from(data.keys())[index] ?? null,
};
beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  setCsrf("test-csrf", "test-user");
  clearPending();
});
afterEach(() => {
  clearPending();
  globalThis.fetch = originalFetch;
  delete (globalThis as any).sessionStorage;
});
const result = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
describe("前端冪等恢復", () => {
  it("5xx與查不到結果時保留原鍵；重新整理後相同輸入沿用鍵且不儲存token", async () => {
    const secret = token(),
      payload = { credentialToken: secret };
    const keys: string[] = [];
    globalThis.fetch = async (_url, options) => {
      if (options?.method === "POST") {
        keys.push(
          (options.headers as Record<string, string>)["Idempotency-Key"],
        );
        return result(500, { error: { code: "INTERNAL_ERROR" } });
      }
      return result(404, { error: { code: "REQUEST_NOT_FOUND" } });
    };
    await assert.rejects(mutate("activate", payload), /結果尚未確認/);
    const saved = storage.getItem("qr-pending:test-user")!;
    assert.ok(saved);
    assert.ok(!saved.includes(secret));
    setCsrf("");
    setCsrf("new-csrf", "test-user");
    globalThis.fetch = async (_url, options) => {
      keys.push(
        (options!.headers as Record<string, string>)["Idempotency-Key"],
      );
      return result(200, { status: "ACTIVATED", activationSequence: 1 });
    };
    assert.equal((await mutate("activate", payload)).activationSequence, 1);
    assert.equal(keys[0], keys[1]);
    assert.equal(storage.getItem("qr-pending:test-user"), null);
  });
  it("網路中斷後查到已提交結果，回原結果而不重送", async () => {
    let posts = 0;
    globalThis.fetch = async (_url, options) => {
      if (options?.method === "POST") {
        posts++;
        throw new TypeError("network interrupted");
      }
      return result(200, {
        httpStatus: 201,
        result: { success: true, redemptionId: "original" },
      });
    };
    const saved = await mutate("redeem", {
      credentialToken: token(),
      vendorId: "test-vendor",
    });
    assert.equal(saved.redemptionId, "original");
    assert.equal(posts, 1);
    assert.equal(data.size, 0);
  });
  it("未知結果尚未確認時阻止改用不同內容，明確拒絕後可送新請求", async () => {
    const payload = { credentialToken: token() };
    globalThis.fetch = async (_url, options) =>
      options?.method === "POST"
        ? result(500, { error: { code: "INTERNAL_ERROR" } })
        : result(404, { error: { code: "REQUEST_NOT_FOUND" } });
    await assert.rejects(mutate("activate", payload));
    await assert.rejects(
      mutate("activate", { credentialToken: token() }),
      /原內容重試/,
    );
    globalThis.fetch = async () =>
      result(409, { error: { code: "CREDENTIAL_VOIDED" } });
    await assert.rejects(mutate("activate", payload), /作廢/);
    assert.equal(data.size, 0);
  });
});
