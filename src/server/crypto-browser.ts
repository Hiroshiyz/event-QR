// Shared QR payload parser; this module deliberately has no Node.js imports.
export function parseQr(value: string) {
  const parsed = value.trim().startsWith("EVTQR:")
    ? value.trim().slice(6)
    : value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(parsed))
    throw new Error("請輸入完整活動 QR 憑證");
  return parsed;
}
