# MVP 實作報告

日期：2026-11-19（Asia/Taipei）。工作分支：`feat/activity-qr-system`，以已核准的本機 staging 為起點；staging 來源為遠端 main 的初始提交。

## 已實作功能

- React 黑白響應式介面：工作人員入場啟用、攤販核銷、後台總覽、攤販統計、QR 批次。
- 真實 256-bit QR 產碼、印刷留白與列印／PDF 樣式；加密列印暫存可在建立後 24 小時內受權限保護地下載。
- 帳密登入、伺服器 Session、角色與攤位授權、Origin／CSRF 驗證、限流及安全標頭。
- PostgreSQL 交易式啟用序號、前 1000 位資格、重複啟用保留序號、跨攤一次性核銷及冪等重送。
- 網路錯誤先查詢結果；重新整理後可沿用原鍵，瀏覽器儲存區不保存 QR token。
- 真實後台統計與 CSV 匯出，排除失敗及重複嘗試，保護私密 token 並防範公式注入。
- 帳號／攤販維運 CLI、migrations、過期列印與 Session 清理指令，以及 GitHub Actions CI 設定。

## 主要異動檔案

| 檔案或目錄 | 用途 |
| --- | --- |
| `src/client/main.tsx`、`Scanner.tsx`、`api.ts`、`style.css` | 操作介面、相機掃描、請求恢復與列印 |
| `src/server/app.ts`、`service.ts` | API、授權、交易與冪等業務操作 |
| `src/server/db.ts`、`crypto.ts`、`config.ts`、`index.ts`、`crypto-browser.ts` | 資料庫、加密、設定、啟動及共用 QR 解析 |
| `migrations/001_initial.sql` | 已核准資料結構、唯一約束、外鍵與保護 trigger |
| `scripts/` | migrations、帳號及攤販管理、到期清理 |
| `tests/`、`playwright.config.ts` | 單元、恢復、PostgreSQL、瀏覽器與正式 build 測試 |
| `.github/workflows/ci.yml` | PR 到 staging 與功能分支的檢查；無合併或部署權限 |
| `package.json`、`package-lock.json`、TypeScript／Vite／ESLint 設定、`index.html` | 專案建置、固定相依版本及工具設定 |
| `.env.example`、`.gitignore`、`README.md` | 設定範例、秘密檔案排除與操作說明 |
| `docs/PRD.md`、`ARCHITECTURE.md`、`SECURITY.md`、`API_SPEC.md`、`TESTING.md`、`IMPLEMENTATION_DECISIONS.md` | 已核准範圍、API 契約、實作與驗證紀錄 |

## 資料庫與 API

新增一份初始 migration，不重設既有正式資料。建立 events、staff_users、vendors、vendor_staff_assignments、sessions、qr_batches、credentials、entitlements、redemptions、idempotency_requests、print_artifacts、audit_logs；migrations 工具另維護 schema_migrations。

保留既有 10 個業務端點，依使用者授權補充登入／登出／本人查詢、批次清單／列印、啟用進度、冪等結果查詢與健康狀態。欄位、錯誤、權限及 HTTP 契約已記錄於 API_SPEC.md。未變更免費上限與跨攤一次性規則。

## 執行結果

- lint、typecheck、frontend/backend build 均通過。
- 單元／前端恢復 10 項、PostgreSQL 整合 22 項、瀏覽器 2 項、正式 build smoke 1 項，共 35 項通過，無跳過。
- 100 筆並發跨越第 1000 名、跨攤競爭、同鍵 10 筆重送、唯一約束與故障回滾均有 PostgreSQL 證據。
- 真實 QR PNG 經獨立解碼器往返；完整 Chromium 透過虛擬視訊裝置執行正式相機掃描元件。
- `npm audit --audit-level=low` 回報 0 vulnerabilities。
- 詳細測試內容、環境及未驗證範圍見 TESTING.md；遠端 CI 尚未執行，不宣稱通過。

## 安全、限制及人工事項

使用參數化 SQL、交易式計數器、資格及核銷唯一約束、啟用序號不可變 trigger。成功資料、資格、冪等結果與成功稽核同交易提交；前端不控制序號或核銷狀態。主資料表不存原始 QR token，短期列印內容以環境金鑰加密。

尚需以實際手機、印表機、紙張、光線及 PDF 分頁／縮放做現場驗收。沒有部署正式環境、推送遠端、建立或合併 PR；原始碼於本機功能分支審閱。

沒有補發、作廢／撤銷寫入、名額重新分配、商品限制或財務金額操作。這些營運決策，以及任何後續業務規則或資料庫變更，仍須先取得人類核准。正式部署另需明確核准，並完成金鑰備援、HTTPS、帳號與清理排程設定。

執行方式見 README.md；未建立預設正式帳密，未將 `.env`、測試生成的 QR／視訊、資料庫檔案或瀏覽器憑證加入版本控制。
