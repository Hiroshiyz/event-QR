# TESTING.md

## 1. QR Batch Tests

- Batch generation produces the expected count.
- All generated credentials are unique.
- Invalid batch quantities are rejected.
- Repeated generation requests do not accidentally create duplicate batches.
- Voided credentials cannot be activated.

## 2. Eligibility Tests

- A valid credential can be activated.
- The same credential cannot activate twice.
- The first 1,000 eligible activations receive entitlements.
- The 1,001st activation does not receive a free entitlement.
- Concurrent activation requests cannot exceed the quota.
- Invalid or voided credentials are rejected.

## 3. Redemption Tests

- A valid entitlement can be redeemed.
- An ineligible credential cannot be redeemed.
- A voided credential cannot be redeemed.
- An already redeemed entitlement is rejected.
- Scanning without confirming does not redeem.
- Two concurrent redemption requests produce exactly one successful redemption.
- Repeating the same request with the same idempotency key yields the original result.
- Retrying after a network timeout does not create a second redemption.

## 4. Authorization Tests

- Unauthenticated users cannot redeem.
- A vendor cannot redeem for an unauthorized vendor.
- A vendor cannot access another vendor's private reporting data.
- Finance staff cannot perform restricted administrative writes.
- Participants cannot access vendor or admin endpoints.

## 5. Reporting Tests

- Total successful redemption counts match database records.
- Vendor totals match their own successful redemptions.
- Failed redemption attempts are excluded from successful redemption totals.
- CSV export contains correct fields and timezone.
- CSV export escapes potentially dangerous spreadsheet formulas.
- Concurrent successful redemptions appear exactly once in reporting.

## 6. CI Requirements

Run the project's configured:

- Lint
- Type checking
- Build
- Unit tests
- Integration tests

Use a real test database for concurrency and transaction behavior.

Mocks alone are insufficient to prove database transaction correctness.

If CI cannot run a required test, the Agent must explicitly report that limitation.

## 7. Acceptance

No feature may be declared fully verified unless the relevant tests pass and the acceptance criteria in PRD.md are satisfied.

## 8. 驗收測試清單

以下清單最初由使用者提供；目前已由 `tests/integration.test.ts` 覆蓋，實際執行結果與限制見第 9 節。勾選不能取代每次變更後的測試。並發與交易測試使用實際 PostgreSQL 資料庫執行。

### 入場啟用

- [x] ACT-001 第 1 位啟用：取得免費資格，序號 1
- [x] ACT-002 第 1,000 位啟用：取得免費資格，序號 1000
- [x] ACT-003 第 1,001 位啟用：正常入場，但無免費資格
- [x] ACT-004 同張 QR 重複啟用：保持原序號，名額不重複扣除
- [x] ACT-005 100 筆並發啟用跨越第 1,000 名：序號唯一，累計免費資格最多 1000
- [x] ACT-006 啟用交易途中失敗：全部 Rollback，不消耗序號

### 跨攤販核銷

- [x] RED-001 合格 QR 在攤販 A 核銷：成功，產生 1 筆核銷紀錄
- [x] RED-002 同張 QR 改在攤販 B 核銷：拒絕，ALREADY_REDEEMED
- [x] RED-003 攤販 A、B 同時核銷：恰好 1 筆成功
- [x] RED-004 同一請求重送 10 次：僅建立 1 筆成功核銷
- [x] RED-005 僅掃描驗證、不確認核銷：免費資格維持 AVAILABLE
- [x] RED-006 無免費資格的 QR：拒絕核銷
- [x] RED-007 未啟用或作廢的 QR：拒絕核銷
- [x] RED-008 攤販使用未授權 vendorId：拒絕，且不修改資格

### 後台報表

- [x] RPT-001 攤販 A 核銷 30 筆、B 核銷 20 筆：A=30、B=20、總數=50
- [x] RPT-002 同一 QR 嘗試重複核銷：報表只計入 1 筆成功
- [x] RPT-003 已發放 1000 資格，其中 600 筆已兌換：已兌換=600，未兌換=400
- [x] RPT-004 財務匯出核銷紀錄：資料正確且不洩露私密 QR token

## 9. Executed MVP Verification — 2026-11-19

測試環境：Node.js 22.12.0、PostgreSQL 16.15、隔離的 UTF-8 `activity_qr_test` 資料庫、Playwright Chromium。正式資料與真實 QR token 未用於測試。

| 檢查 | 指令 | 結果 |
| --- | --- | --- |
| Lint | `npm run lint` | 通過 |
| Typecheck | `npm run typecheck` | 通過 |
| Frontend/backend build | `npm run build` | 通過 |
| 單元及前端恢復 | `npm test` | 10 項通過，無跳過 |
| PostgreSQL 整合與並發 | `TEST_DATABASE_URL=… npm run test:integration` | 22 項通過，無跳過 |
| Production build smoke | `TEST_DATABASE_URL=… npm run test:production` | 1 項通過 |
| Chromium 瀏覽器驗收 | `TEST_DATABASE_URL=… npm run test:browser` | 2 項通過 |
| 相依弱點檢查 | `npm audit --audit-level=low` | 0 vulnerabilities |

### Database evidence

- ACT-001～006：首次序號 1、1000／1001 邊界、同張 20 筆並發啟用、100 筆請求從序號 951 跨到 1050。免費資格恰好新增 50 份，累計 1000，序號無重複。
- ACT-006 以測試專用 PostgreSQL trigger 在成功稽核寫入時注入錯誤，驗證計數器、憑證、資格及冪等資料全部回滾；解除故障後仍取得序號 1。
- RED-001～008：跨攤競爭恰好一筆成功、同鍵 10 筆並發重送回相同核銷 ID、驗證不消耗資格、資格／攤位授權限制。另直接驗證唯一約束拒絕第二筆成功紀錄。
- 核銷故障注入發生於建立成功紀錄及更新資格後，驗證交易失敗會回滾兩者，原冪等鍵可重試。
- RPT-001／002 透過真實服務啟用與核銷 50 張，確認 A=30、B=20、總數=50，重複不增加統計。
- RPT-003 使用交易建立受資料庫約束保護的報表 fixture（非 600 次 HTTP 核銷），確認已發放 1000、已兌換 600、AVAILABLE 400、剩餘可發放 0。
- RPT-004 核對 CSV 公開碼、+08:00 時區、公式注入防護，並確認不含原始 token、token hash 或操作人員 Email。

### Browser and QR evidence

- 瀏覽器流程：登入工作人員、建立 3 張 QR、列印預覽及 print CSS、手機啟用、A 攤先驗證且尚無核銷，再確認核銷；B 攤再次驗證時不可兌換；後台總數及 CSV 下載正常。
- 相機流程：以完整 Chromium 的虛擬視訊裝置播放實際 QR 影像，透過正式 html5-qrcode 掃描元件解析，關閉掃描畫面後完成啟用。沒有替換 QR 解碼器或移除認證。
- 單元測試將產生的 PNG 交給獨立 jsQR 解碼，核對回原憑證；另測試加密竄改、錯誤金鑰與 CSV 注入。
- 前端測試涵蓋網路中斷、5xx、查詢既有結果、重新整理後沿用原鍵，以及不將 QR token 寫入 sessionStorage。
- Production smoke 實際啟動 build 產物，核對首頁與靜態資源可存取、`/api` 前綴、未登入 401，以及正式 Cookie 的 Secure／HttpOnly 屬性。

### Limits and reproduction

- 實體手機、iOS／Android 相機權限、現場光線、紙張／印表機、PDF 換頁與印刷縮放仍需人工驗收；虛擬相機不代表現場硬體驗收。
- 列印樣式已在 Chromium print media 驗證；尚未使用真實印表機列印。
- 此環境補下載 Chromium 缺少的 libnspr4、libnss3、libasound2t64 至 `/tmp/activity-qr-browser-libs/root`，瀏覽器測試使用該路徑的 LD_LIBRARY_PATH；一般 Linux 可用 `npx playwright install --with-deps chromium` 安裝環境依賴。
- 建議 Node.js 22.13 以上；本次 22.12 可執行全部檢查，但某個 lint 工具的相依套件會發出引擎版本提示。
- `.github/workflows/ci.yml` 已配置獨立 PostgreSQL、lint、typecheck、build、全部測試及 audit；尚未推送 GitHub，因此未宣稱遠端 CI 通過。
- 先前測試發現外鍵 KEY SHARE 與活動 FOR UPDATE 升級死鎖；改用 FOR NO KEY UPDATE 後並發測試通過。測試保留以防回歸。
- 不因失敗停用測試、認證、授權或資料庫約束。隔離資料庫由 TEST_DATABASE_URL 指定且名稱須以 `_test` 結尾，避免誤用正式資料。

## 10. Code-review Regression — 2026-11-19

PR #1 自審修正及證據詳見 CODE_REVIEW_REPORT.md。單元／前端恢復增加至 13 項，瀏覽器增加至 3 項；PostgreSQL 22 項及正式 build smoke 1 項維持，共 39 項。新增覆蓋：限流／重新登入後原鍵保留、跨帳號延遲回應、COMMIT／ROLLBACK 連線失敗，以及批次已提交但列表更新失敗時不重複建立。

第 9 節保留初始 MVP 的 35 項歷史執行紀錄，不將後續測試覆寫為原版本結果。遠端 CI 以 PR 最後提交的 GitHub checks 為準。

## 11. Operational Readiness — 2026-11-19

PR #1 的最後提交兩組 GitHub CI 已通過，並合併至 staging。依使用者選擇，下一階段新增 `src/server/readiness.ts`、`scripts/preflight.ts`、`npm run preflight` 及 FIELD_ACCEPTANCE.md；更新 README、單元與整合測試。沒有新增 migration、外部 API、業務規則或資料庫結構變更。

唯讀檢查以 PostgreSQL REPEATABLE READ READ ONLY 快照執行；CLI 連線與各查詢都有逾時。檢查必要資料表、已套用 migration 名稱、唯一／外鍵／1000 上限 CHECK、保護 trigger、活動與資格／核銷／冪等紀錄、帳號指派及列印金鑰。不以紀錄名稱代替 migration 內容雜湊，也不宣稱可偵測所有 schema 漂移或取代既有並發測試。

新增證據：

- 設定錯誤時不連線，也不輸出輸入的秘密值。
- 正常活動可執行 JSON CLI，核對唯一約束、外鍵、名額 CHECK 與 trigger；檢查前後的啟用、資格、核銷、批次、憑證、冪等與稽核數量不變。
- 錯誤金鑰被標示失敗，既有加密列印內容保持不變。
- 計數器與憑證／資格不一致時報 FAIL，不會補發資格、重排序號或刪除紀錄。
- 輸出不包含測試 QR token、金鑰、操作人員 Email 或資料庫連線字串。

本階段 14 項單元／前端恢復、25 項 PostgreSQL 整合、3 項瀏覽器及 1 項正式 build smoke，共 43 項通過，無跳過；lint、typecheck、build 通過。機器檢查完成仍要求人工驗收，FIELD_ACCEPTANCE.md 保持未勾選；真實設備、印刷與正式部署未執行。
