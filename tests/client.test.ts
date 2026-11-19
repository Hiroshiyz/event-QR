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
  Object.defineProperty(globalThis, "window", {
    value: new EventTarget(),
    configurable: true,
  });
  setCsrf("test-csrf", "test-user");
  clearPending();
});
afterEach(() => {
  clearPending();
  globalThis.fetch = originalFetch;
  delete (globalThis as any).sessionStorage;
  delete (globalThis as any).window;
  data.clear();
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
  it("先前結果不明時，限流與重新登入都保留原鍵", async () => {
    const payload = { credentialToken: token() },
      keys: string[] = [];
    let stage = 0;
    globalThis.fetch = async (_url, options) => {
      if (options?.method !== "POST")
        return result(404, { error: { code: "REQUEST_NOT_FOUND" } });
      keys.push((options.headers as Record<string, string>)["Idempotency-Key"]);
      if (stage === 0)
        return result(500, { error: { code: "INTERNAL_ERROR" } });
      if (stage === 1) return result(429, { error: { code: "RATE_LIMITED" } });
      if (stage === 2)
        return result(401, { error: { code: "UNAUTHENTICATED" } });
      return result(200, { status: "ACTIVATED" });
    };
    await assert.rejects(mutate("activate", payload));
    stage = 1;
    await assert.rejects(mutate("activate", payload), /稍候/);
    stage = 2;
    await assert.rejects(mutate("activate", payload), /登入/);
    setCsrf("");
    setCsrf("renewed", "test-user");
    stage = 3;
    await mutate("activate", payload);
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 1);
    assert.equal(data.size, 0);
  });
  it("舊帳號延遲回應不會清除新帳號未確認的請求", async () => {
    let resolveOld!: (value: Response) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = async (_url, options) => {
      if (
        options?.method === "POST" &&
        (options.headers as Record<string, string>)["X-CSRF-Token"] ===
          "test-csrf"
      ) {
        started();
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }
      return result(options?.method === "POST" ? 500 : 404, {
        error: {
          code:
            options?.method === "POST" ? "INTERNAL_ERROR" : "REQUEST_NOT_FOUND",
        },
      });
    };
    const old = mutate("activate", { credentialToken: token() });
    await began;
    setCsrf("another-csrf", "another-user");
    await assert.rejects(mutate("activate", { credentialToken: token() }));
    const saved = storage.getItem("qr-pending:another-user");
    assert.ok(saved);
    resolveOld(result(200, { status: "ACTIVATED" }));
    await old;
    assert.equal(storage.getItem("qr-pending:another-user"), saved);
    assert.equal(storage.getItem("qr-pending:test-user"), null);
  });
});
