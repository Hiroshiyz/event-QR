import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ScanLine,
  Store,
  LayoutDashboard,
  LogOut,
  Camera,
  Info,
  Users,
  QrCode,
  Gift,
  CircleCheck,
  Download,
  Plus,
  Printer,
  X,
  Check,
  AlertCircle,
} from "lucide-react";
import QRCode from "qrcode";
import { api, mutate, setCsrf, clearPending, explain } from "./api";
import { parseQr } from "../server/crypto-browser.js";
import Scanner from "./Scanner";
import "@fontsource-variable/noto-sans-tc";
import "./style.css";

type User = {
  id: string;
  email: string;
  role: "EVENT_STAFF" | "VENDOR" | "FINANCE";
  csrfToken: string;
  vendors: { id: string; name: string }[];
};
type Progress = {
  eventName: string;
  eventStatus: string;
  generated: number;
  activated: number;
  issued: number;
  available: number;
  redeemed: number;
  remaining: number;
  quota: number;
};
type Vendor = { id: string; name: string; count: number; share: number };
type Batch = {
  id: string;
  name: string;
  quantity: number;
  createdAt: string;
  printExpiresAt: string | null;
};
const fmt = (value: number) => value.toLocaleString("zh-TW");
const time = (value: string) =>
  new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
function Message({ error }: { error: string }) {
  return error ? (
    <div className="notice error" role="alert">
      <AlertCircle size={18} />
      <span>{error}</span>
    </div>
  ) : null;
}
function Metric({
  label,
  value,
  detail,
  icon,
  compact = false,
}: {
  label: string;
  value: number;
  detail: string;
  icon?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section className={"metric " + (compact ? "compact" : "")}>
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{fmt(value)}</strong>
      <span>{detail}</span>
    </section>
  );
}
function Bar({ value, total }: { value: number; total: number }) {
  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <span
        style={{
          width: `${total ? Math.min(100, (value / total) * 100) : 0}%`,
        }}
      />
    </div>
  );
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-shell">
      <div className="brand">
        <QrCode size={26} /> 活動 QR 憑證管理
      </div>
      <h1>登入工作台</h1>
      <p>請使用主辦單位提供的帳號</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const session = await api("/auth/login", {
              method: "POST",
              body: JSON.stringify({ email, password }),
            });
            setCsrf(session.csrfToken, session.id);
            setPassword("");
            onLogin(await api("/auth/me"));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          電子郵件
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          密碼
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <Message error={error} />
        <button className="primary" disabled={busy}>
          {busy ? "登入中…" : "登入"}
        </button>
      </form>
      <small>帳號權限由主辦單位管理</small>
    </main>
  );
}
function Operations({ user }: { user: User }) {
  const isStaff = user.role === "EVENT_STAFF";
  const [vendorId, setVendorId] = useState(user.vendors[0]?.id ?? "");
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scanning, setScanning] = useState(false);
  const [input, setInput] = useState(""),
    [result, setResult] = useState<any>(null),
    [validation, setValidation] = useState<any>(null);
  const refresh = useCallback(async () => {
    if (!isStaff && !vendorId) return;
    setData(
      await api(
        isStaff
          ? "/admissions/progress"
          : `/vendor/redemptions?vendorId=${vendorId}&limit=10`,
      ),
    );
  }, [isStaff, vendorId]);
  useEffect(() => {
    setData(null);
    setValidation(null);
    setResult(null);
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const scan = useCallback((value: string) => {
    setInput(value);
    setScanning(false);
    setValidation(null);
    setResult(null);
    setError("");
  }, []);
  async function submit() {
    setBusy(true);
    setError("");
    setResult(null);
    setValidation(null);
    try {
      const secret = parseQr(input);
      if (isStaff) {
        setResult(await mutate("activate", { credentialToken: secret }));
        await refresh();
      } else
        setValidation(
          await api("/vendor/redemptions/validate", {
            method: "POST",
            body: JSON.stringify({ credentialToken: secret, vendorId }),
          }),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="operations">
      <header className="hero">
        <p className="eyebrow">
          {isStaff
            ? "活動入口"
            : (user.vendors.find((v) => v.id === vendorId)?.name ??
              "尚未指派攤位")}
        </p>
        <h1>{isStaff ? "入場憑證啟用" : "攤販核銷中心"}</h1>
        <p>
          {isStaff
            ? "掃描參加者的實體 QR Code"
            : "驗證資格，確認後完成商品兌換"}
        </p>
      </header>
      <div className="operation-content">
        {!isStaff && user.vendors.length > 1 && (
          <label>
            操作攤位
            <select
              value={vendorId}
              disabled={busy}
              onChange={(e) => {
                setVendorId(e.target.value);
                setInput("");
              }}
            >
              {user.vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="metrics two">
          {isStaff ? (
            <>
              <Metric
                compact
                label="已啟用入場"
                value={data?.activated ?? 0}
                detail="位參加者"
              />
              <Metric
                compact
                label="免費名額剩餘"
                value={data?.remaining ?? 0}
                detail="共 1,000 名"
              />
            </>
          ) : (
            <>
              <Metric
                compact
                label="今日已兌換"
                value={data?.today.redeemed ?? 0}
                detail="筆成功核銷"
              />
              <Metric
                compact
                label="今日失敗嘗試"
                value={data?.today.failed ?? 0}
                detail="筆驗證或核銷失敗"
              />
            </>
          )}
        </div>
        {isStaff && (
          <div className="progress-block">
            <div className="spread">
              <span>免費資格發放進度</span>
              <span>{data?.issued ?? 0} / 1000</span>
            </div>
            <Bar value={data?.issued ?? 0} total={1000} />
          </div>
        )}
        <section className="scan-card">
          <div className="scan-icon">
            <ScanLine size={34} />
          </div>
          <h2>{isStaff ? "準備掃描入場 QR Code" : "掃描消費者 QR Code"}</h2>
          <p>
            {isStaff
              ? "啟用成功後，系統會自動核發免費資格。"
              : "掃描後會先檢查兌換資格，不會立即扣除。"}
          </p>
          <button
            className="primary"
            disabled={busy || (!isStaff && !vendorId)}
            onClick={() => {
              setScanning(true);
              setError("");
            }}
          >
            <Camera size={17} /> 開啟相機掃描
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="manual-label">
              完整憑證輸入
              <input
                autoComplete="off"
                spellCheck={false}
                placeholder="EVTQR:…"
                value={input}
                disabled={busy}
                onChange={(e) => {
                  setInput(e.target.value);
                  setValidation(null);
                  setResult(null);
                }}
              />
            </label>
            <button
              className="secondary"
              disabled={busy || !input || (!isStaff && !vendorId)}
            >
              {busy ? "處理中…" : isStaff ? "確認啟用入場" : "檢查兌換資格"}
            </button>
          </form>
        </section>
        <Message error={error} />
        {result && (
          <section className="result success" role="status">
            <CircleCheck />
            <h2>{isStaff ? "已啟用入場" : "核銷成功"}</h2>
            {isStaff ? (
              <>
                <strong>啟用序號 {result.activationSequence}</strong>
                <p>
                  {result.entitlement.status === "AVAILABLE"
                    ? "已取得免費兌換資格"
                    : result.entitlement.status === "REDEEMED"
                      ? "此憑證的免費資格已使用"
                      : result.entitlement.status === "REVOKED"
                        ? "此憑證的免費資格已撤銷"
                        : "可正常入場，未取得免費資格"}
                </p>
              </>
            ) : (
              <p>核銷時間 {time(result.redeemedAt)}</p>
            )}
            <button
              className="secondary"
              onClick={() => {
                setResult(null);
                setInput("");
              }}
            >
              掃描下一張
            </button>
          </section>
        )}
        {validation && (
          <section
            className={
              "result " + (validation.redeemable ? "success" : "error")
            }
            role="status"
          >
            <h2>{validation.redeemable ? "可免費兌換" : "無法兌換"}</h2>
            <p>{validation.publicCode}</p>
            <p>{explain(validation.message)}</p>
            {validation.redeemable && (
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const r = await mutate("redeem", {
                      credentialToken: parseQr(input),
                      vendorId,
                    });
                    setResult(r);
                    setValidation(null);
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "核銷中…" : "確認交付並核銷"}
              </button>
            )}
          </section>
        )}
        {isStaff ? (
          <div className="notice">
            <Info size={18} />
            <span>此介面只負責啟用入場，不會執行商品核銷。</span>
          </div>
        ) : (
          <section className="recent">
            <div className="spread">
              <h3>最近核銷紀錄</h3>
              <span>Asia/Taipei</span>
            </div>
            {data?.items.length === 0 && (
              <p className="empty">目前尚無成功核銷紀錄</p>
            )}
            {data?.items.map((r: any) => (
              <div className="record" key={r.id}>
                <span className="record-icon">
                  <Check size={18} />
                </span>
                <div>
                  <strong>{r.publicCode}</strong>
                  <small>{time(r.redeemedAt)}</small>
                </div>
                <span className="success-text">成功</span>
              </div>
            ))}
          </section>
        )}
        {!data && !error && <p className="empty">正在載入資料…</p>}
      </div>
      {scanning && <Scanner onScan={scan} onClose={() => setScanning(false)} />}
    </div>
  );
}
function Admin({ user }: { user: User }) {
  const [tab, setTab] = useState("overview"),
    [stats, setStats] = useState<Progress | null>(null),
    [vendors, setVendors] = useState<Vendor[]>([]),
    [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState(""),
    [name, setName] = useState(""),
    [quantity, setQuantity] = useState(1000),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [batchPage, setBatchPage] = useState(1);
  const [print, setPrint] = useState<{
    name: string;
    cards: { publicCode: string; image: string }[];
  } | null>(null);
  const refresh = useCallback(async () => {
    const [s, v, b] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/reports/vendors"),
      user.role === "EVENT_STAFF"
        ? api(`/admin/qr-batches?page=${batchPage}`)
        : Promise.resolve({ items: [] }),
    ]);
    setStats(s);
    setVendors(v.items);
    setBatches(b.items);
  }, [user.role, batchPage]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function showPrint(id: string) {
    setBusy(true);
    setError("");
    try {
      const content = await api(`/admin/qr-batches/${id}/print`);
      const cards = await Promise.all(
        content.cards.map(async (c: any) => ({
          publicCode: c.publicCode,
          image: await QRCode.toDataURL(c.qrContent, {
            width: 320,
            margin: 4,
            errorCorrectionLevel: "M",
          }),
        })),
      );
      setPrint({ name: content.name, cards });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportCsv() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/reports/export", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("匯出失敗，請確認登入權限");
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "redemptions.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin">
      <div className="admin-heading">
        <div>
          <h1>活動管理儀表板</h1>
          <p>{stats?.eventName ?? "正在載入活動資料"}</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void exportCsv()}
        >
          <Download size={16} /> 匯出核銷 CSV
        </button>
      </div>
      <nav className="tabs" aria-label="後台分頁">
        {[
          ["overview", "總覽"],
          ["vendors", "攤販統計"],
          ...(user.role === "EVENT_STAFF" ? [["batches", "QR 批次"]] : []),
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <Message error={error} />
      {tab === "overview" && (
        <>
          <div className="metrics two">
            <Metric
              label="已產生 QR Code"
              value={stats?.generated ?? 0}
              detail="張入場憑證"
              icon={<QrCode size={17} />}
            />
            <Metric
              label="已啟用憑證"
              value={stats?.activated ?? 0}
              detail="位已入場"
              icon={<Users size={17} />}
            />
            <Metric
              label="免費資格已核發"
              value={stats?.issued ?? 0}
              detail={`剩餘 ${stats?.remaining ?? 0} 個可核發名額`}
              icon={<Gift size={17} />}
            />
            <Metric
              label="成功兌換"
              value={stats?.redeemed ?? 0}
              detail={`${stats?.available ?? 0} 份尚未兌換`}
              icon={<CircleCheck size={17} />}
            />
          </div>
          <section className="panel exchange-progress">
            <div className="spread">
              <h3>免費商品兌換進度</h3>
              <strong>
                {stats?.issued
                  ? ((stats.redeemed / stats.issued) * 100).toFixed(1)
                  : "0.0"}
                %
              </strong>
            </div>
            <Bar value={stats?.redeemed ?? 0} total={stats?.issued ?? 0} />
            <div className="spread muted">
              <span>已兌換 {stats?.redeemed ?? 0}</span>
              <span>未兌換 {stats?.available ?? 0}</span>
            </div>
          </section>
          <section className="ranking">
            <h3>各攤販核銷排行榜</h3>
            {!vendors.length && <p className="empty">尚未建立攤販</p>}
            {vendors.map((v, i) => (
              <div className="rank" key={v.id}>
                <span>{i + 1}</span>
                <div>
                  <div className="spread">
                    <span>{v.name}</span>
                    <span>{fmt(v.count)} 次</span>
                  </div>
                  <Bar
                    value={v.count}
                    total={Math.max(1, ...vendors.map((v) => v.count))}
                  />
                </div>
              </div>
            ))}
          </section>
        </>
      )}
      {tab === "vendors" && (
        <section>
          <div className="section-title">
            <h2>攤販兌換統計</h2>
            <select
              aria-label="篩選攤販"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部攤販</option>
              {vendors.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>攤販名稱</th>
                  <th>成功次數</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {vendors
                  .filter((v) => !filter || v.id === filter)
                  .map((v) => (
                    <tr key={v.id}>
                      <td>{v.name}</td>
                      <td>{fmt(v.count)}</td>
                      <td>{(v.share * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">
            報表只計算成功核銷，不包含重複掃描、驗證失敗的次數。
          </p>
        </section>
      )}
      {tab === "batches" && (
        <>
          <form
            className="panel batch-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await mutate("batch", { name, quantity });
                await refresh();
                setName("");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>
              <QrCode size={18} /> 批次產生入場 QR Code
            </h2>
            <label>
              批次名稱
              <input
                required
                maxLength={100}
                placeholder="例如：活動第一批"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              預計產生數量
              <input
                type="number"
                required
                min={1}
                max={5000}
                value={quantity}
                disabled={busy}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </label>
            <button className="primary" disabled={busy}>
              <Plus size={17} />
              {busy ? "處理中…" : "建立可列印 QR 批次"}
            </button>
            <p className="footnote">
              建立 QR 不會取得免費資格。列印內容建立後 24
              小時內可下載，請妥善保管。
            </p>
          </form>
          <div className="batch-list">
            {batches.map((b) => (
              <div className="batch-row" key={b.id}>
                <span className="batch-icon">
                  <QrCode size={20} />
                </span>
                <div>
                  <strong>{b.name}</strong>
                  <small>
                    {fmt(b.quantity)} 張憑證 · {time(b.createdAt)}
                  </small>
                </div>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !b.printExpiresAt ||
                    new Date(b.printExpiresAt) < new Date()
                  }
                  onClick={() => void showPrint(b.id)}
                >
                  <Printer size={16} />
                  {!b.printExpiresAt || new Date(b.printExpiresAt) < new Date()
                    ? "列印已到期"
                    : "列印"}
                </button>
              </div>
            ))}
          </div>
          <div className="pagination">
            <button
              className="secondary"
              disabled={batchPage <= 1 || busy}
              onClick={() => setBatchPage((p) => p - 1)}
            >
              上一頁
            </button>
            <span>第 {batchPage} 頁</span>
            <button
              className="secondary"
              disabled={batches.length < 50 || busy}
              onClick={() => setBatchPage((p) => p + 1)}
            >
              下一頁
            </button>
          </div>
        </>
      )}
      {print && (
        <div className="print-overlay">
          <div className="print-toolbar">
            <div>
              <strong>{print.name}</strong>
              <small>{print.cards.length} 張實體憑證</small>
            </div>
            <button className="primary" onClick={() => window.print()}>
              <Printer size={18} /> 列印／另存 PDF
            </button>
            <button
              className="icon-button"
              aria-label="關閉列印"
              onClick={() => setPrint(null)}
            >
              <X />
            </button>
          </div>
          <div className="print-area">
            {print.cards.map((c) => (
              <article className="print-card" key={c.publicCode}>
                <h2>活動入場憑證</h2>
                <img
                  src={c.image}
                  alt={`入場 QR ${c.publicCode}`}
                  width={180}
                  height={180}
                />
                <strong>{c.publicCode}</strong>
                <p>請由現場工作人員掃碼啟用</p>
                <small>免費資格依成功啟用順序核發 · 請妥善保管</small>
              </article>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("admin"),
    [error, setError] = useState("");
  useEffect(() => {
    api<User>("/auth/me")
      .then((u) => {
        setCsrf(u.csrfToken, u.id);
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setCsrf("");
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  if (loading)
    return (
      <main className="login-shell">
        <p>正在載入工作台…</p>
      </main>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setCsrf(u.csrfToken, u.id);
          setView("admin");
          setUser(u);
        }}
      />
    );
  const operations =
    user.role === "VENDOR" || (user.role === "EVENT_STAFF" && view === "staff");
  return (
    <div className={"app-shell " + (operations ? "mobile-shell" : "")}>
      <header className="topbar">
        <div className="brand">
          {operations ? (
            user.role === "VENDOR" ? (
              <Store size={19} />
            ) : (
              <ScanLine size={19} />
            )
          ) : (
            <LayoutDashboard size={19} />
          )}
          <span>
            {operations
              ? user.role === "VENDOR"
                ? "Vendor Portal"
                : "Event Staff"
              : "Event Admin"}
          </span>
        </div>
        <div className="top-actions">
          {user.role === "EVENT_STAFF" && (
            <button
              onClick={() => setView(view === "staff" ? "admin" : "staff")}
            >
              {view === "staff" ? "管理後台" : "入場啟用"}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="登出"
            title={user.email + " · 登出"}
            onClick={async () => {
              try {
                await api("/auth/logout", { method: "POST" });
                clearPending();
                setUser(null);
                setCsrf("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <Message error={error} />
      {operations ? <Operations user={user} /> : <Admin user={user} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
