import { useEffect, useId, useState } from "react";
import { Camera, X } from "lucide-react";
import { parseQr } from "../server/crypto-browser.js";
export default function Scanner({
  onScan,
  onClose,
}: {
  onScan: (token: string) => void;
  onClose: () => void;
}) {
  const id =
    "scanner-" +
    useId().replaceAll(":", "").replaceAll("«", "").replaceAll("»", "");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      matched = false;
    let stop: (() => Promise<void>) | undefined;
    void import("html5-qrcode")
      .then(async ({ Html5Qrcode }) => {
        if (!alive) return;
        const scanner = new Html5Qrcode(id, false);
        stop = async () => {
          if (scanner.isScanning) await scanner.stop();
          scanner.clear();
        };
        try {
          await scanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 230, height: 230 } },
            (decoded) => {
              if (!alive || matched) return;
              try {
                const token = parseQr(decoded);
                matched = true;
                onScan(token);
              } catch {
                setError("這不是有效的活動 QR，請重新對準");
              }
            },
            () => {},
          );
          if (!alive) await stop();
        } catch {
          if (alive)
            setError(
              "無法開啟相機。請使用 HTTPS、允許相機權限，或改用完整憑證輸入。",
            );
        }
      })
      .catch(() => {
        if (alive) setError("掃描元件載入失敗，請關閉後重試");
      });
    return () => {
      alive = false;
      void stop?.().catch(() => {});
    };
  }, [id, onScan]);
  return (
    <div className="overlay">
      <section className="modal">
        <div className="section-title">
          <h2>
            <Camera size={20} /> 掃描實體 QR
          </h2>
          <button
            className="icon-button"
            aria-label="關閉相機"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <div id={id} className="camera-view" />
        <p>請將完整 QR Code 放入掃描框</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
