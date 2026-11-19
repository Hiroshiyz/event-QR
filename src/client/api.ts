let csrf = "";
let actorId = "";
export function setCsrf(value: string, actor = "") {
  if (actorId !== actor) pending = undefined;
  csrf = value;
  actorId = actor;
}
export class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const messages: Record<string, string> = {
  UNAUTHENTICATED: "登入已過期，請重新登入",
  INVALID_LOGIN: "帳號或密碼錯誤",
  FORBIDDEN: "沒有此操作權限",
  FORBIDDEN_VENDOR: "你沒有這個攤位的操作權限",
  ALREADY_REDEEMED: "這張免費資格已使用",
  NOT_ELIGIBLE: "此憑證沒有免費資格",
  NOT_ACTIVATED: "此憑證尚未啟用入場",
  CREDENTIAL_VOIDED: "此憑證已作廢",
  ENTITLEMENT_REVOKED: "免費資格已撤銷",
  INVALID_CREDENTIAL: "查無有效憑證",
  EVENT_CLOSED: "活動目前未開放操作",
  RATE_LIMITED: "操作過於頻繁，請稍候再試",
  IDEMPOTENCY_CONFLICT: "請求內容與原請求不同，請先確認原操作結果",
  PRINT_EXPIRED_OR_NOT_FOUND: "列印內容不存在或已超過 24 小時",
};
export const explain = (code: string) => messages[code] ?? code;
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    credentials: "same-origin",
    signal: options.signal ?? AbortSignal.timeout(30000),
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-CSRF-Token": csrf,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const value = await response.json();
    const code = value.error?.code ?? "UNKNOWN_ERROR";
    if (code === "UNAUTHENTICATED")
      window.dispatchEvent(new Event("session-expired"));
    throw new RequestError(
      code,
      messages[code] ?? value.error?.message ?? "操作失敗",
      response.status,
    );
  }
  return response.json();
}
// Keep only a payload fingerprint and request key in sessionStorage, never QR tokens.
// Scanning the same QR after a refresh can safely recover the original request.
let pending:
  | { operation: string; key: string; fingerprint: string }
  | undefined;
const storageKey = () => "qr-pending:" + actorId;
export async function mutate(
  operation: "activate" | "redeem" | "batch",
  input: unknown,
) {
  const owner = actorId;
  const scope = storageKey();
  const serialized = JSON.stringify(input);
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serialized),
      ),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (actorId !== owner) throw new Error("登入身分已變更，請重新操作");
  if (!pending) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(scope) ?? "null");
      if (
        saved &&
        ["activate", "redeem", "batch"].includes(saved.operation) &&
        typeof saved.key === "string" &&
        /^[a-f0-9]{64}$/.test(saved.fingerprint)
      )
        pending = saved;
    } catch {
      /* unavailable storage falls back to in-memory retry */
    }
  }
  if (
    pending &&
    (pending.operation !== operation || pending.fingerprint !== fingerprint)
  )
    throw new Error("上一筆操作結果尚未確認，請先以原內容重試");
  pending ??= { operation, key: crypto.randomUUID(), fingerprint };
  try {
    sessionStorage.setItem(scope, JSON.stringify(pending));
  } catch {
    /* memory still protects retries */
  }
  const { key } = pending;
  // A late response from another login must never clear this user's request.
  const finish = () => {
    if (actorId === owner && pending?.key === key) pending = undefined;
    try {
      const stored = JSON.parse(sessionStorage.getItem(scope) ?? "null");
      if (stored?.key === key) sessionStorage.removeItem(scope);
    } catch {
      /* storage optional */
    }
  };
  const paths = {
    activate: "/admissions/activate",
    redeem: "/vendor/redemptions",
    batch: "/admin/qr-batches",
  };
  try {
    const result = await api(paths[operation], {
      method: "POST",
      body: serialized,
      headers: { "Idempotency-Key": key },
    });
    finish();
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.status < 500) {
      // Authentication, throttling and conflicts do not establish whether an
      // earlier attempt committed. Preserve its key until a terminal result.
      if (
        ![401, 403, 408, 425, 429].includes(error.status) &&
        error.code !== "IDEMPOTENCY_CONFLICT"
      )
        finish();
      throw error;
    }
    if (actorId !== owner)
      throw new Error("登入身分已變更，請重新登入原帳號確認操作結果");
    try {
      const saved = await api(`/requests/${operation}/${key}`);
      finish();
      if (saved.httpStatus >= 400)
        throw new RequestError(
          saved.result.error.code,
          explain(saved.result.error.code),
        );
      return saved.result;
    } catch (lookupError) {
      if (
        lookupError instanceof RequestError &&
        lookupError.code !== "REQUEST_NOT_FOUND"
      )
        throw lookupError;
      throw new Error(
        "連線中斷，結果尚未確認。請保留原內容並重試，系統會使用同一請求避免重複操作。",
      );
    }
  }
}
export function clearPending() {
  pending = undefined;
  try {
    sessionStorage.removeItem(storageKey());
  } catch {
    /* storage optional */
  }
}
