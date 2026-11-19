import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, encoded] = stored.split(":");
  if (!salt || !encoded) return false;
  const actual = scryptSync(password, salt, 64),
    expected = Buffer.from(encoded, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function encrypt(value: unknown, key: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decrypt<T>(encoded: string, key: string): T {
  const bytes = Buffer.from(encoded, "base64"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      bytes.subarray(0, 12),
    );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}
