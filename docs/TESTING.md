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

以下勾選狀態依使用者提供的清單保留；本次僅補入文件，未執行測試，亦未附測試結果佐證，不代表已由本次作業驗證通過。並發與交易測試須使用實際 PostgreSQL 資料庫執行。

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
