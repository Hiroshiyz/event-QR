# 活動 QR 系統已核准實作方案

2026-11-19 使用者核准本方案，並進一步授權自行補充必要 API；業務規則與資料庫的後續變更仍須先取得核准。以下保存核准時的方案，實際 API 與執行方式以 API_SPEC.md、README.md 及程式碼為準，測試結果見 TESTING.md。

## 1. 已確認流程

- 活動人員於後台批次產生可列印的實體 QR，建立時沒有免費資格。
- 工作人員現場登入後掃碼啟用；成功序號 1～1000 有免費資格，1001 起仍可入場。
- 攤販登入後掃碼查驗，確認交付操作後送出正式核銷。
- 所有攤販共用一次性資格；重送與並發不得產生第二筆成功紀錄。
- 依提供圖片實作黑白介面、手機工作人員頁、手機攤販頁，以及後台總覽、攤販統計、QR 批次頁。
- 畫面數字取自資料庫，不沿用圖片中的示範統計；正式操作不使用模擬掃碼。

## 2. 分支提案

已查詢遠端 https://github.com/Hiroshiyz/event-QR.git，目前只有 main，提交為 5a8985dfdae1af35efb8da3529edb41aa48afa6a。

已核准從遠端最新 main 建立本機 staging，再建立 feat/activity-qr-system 實作分支。若開始時 main 已更新，先重新檢查。保留任何未提交內容，不在 main 或 staging 實作。

推送 staging、推送 feature branch 與建立指向 staging 的 PR，於取得推送授權且 GitHub 存取可用時進行。不得自動合併或部署正式環境。

## 3. 技術與實作範圍提案

- TypeScript、React 前端、Node.js 模組化 API、PostgreSQL。
- SQL migrations 明確建立資料結構與約束，透過參數化查詢執行交易。
- 預定選用 Vite、Fastify、pg、Zod、qrcode、瀏覽器相機 QR 解碼套件及 Node.js 內建測試（原提案 Vitest，因套件安全弱點改用內建測試）；實作時先核對官方文件與 Node 相容性，固定相依版本。
- 提供本機環境設定範例、資料庫建立與 migrations 指令、工作人員及攤販帳號管理 CLI。
- 單一活動由伺服器設定選定，無使用者可調整免費名額的入口。
- 帳號由管理 CLI 建立，不開放自行註冊或從介面切換角色。
- 暫不實作補發、資格撤銷、名額重分配、商品品項限制、結算單價或付款；這些仍需營運決策。

## 4. 已核准的資料庫設計

| 資料表 | 主要資料與約束 |
| --- | --- |
| events | 活動 ID、名稱、狀態、交易式 activation_count；MVP 免費上限固定 1000 |
| staff_users | 帳號、密碼雜湊、角色 EVENT_STAFF / VENDOR / FINANCE、帳號狀態 |
| vendor_staff_assignments | 使用者與活動攤販授權；複合唯一約束 |
| vendors | 活動、名稱、啟用狀態 |
| sessions | 登入 token 的 hash、使用者、到期時間；不存明文登入 token |
| qr_batches | 活動、名稱、數量、建立者與時間 |
| credentials | 活動、批次、public_code、token_hash、狀態、啟用時間及 activation_sequence；token_hash 唯一；活動內公開碼與非空序號唯一 |
| entitlements | 活動、credential_id、狀態與時間；credential_id 唯一；第 1001 位起不建立免費資格資料列 |
| redemptions | 活動、entitlement_id、credential_id、vendor_id、操作人員及時間；entitlement_id 唯一；外鍵防止跨活動關聯 |
| idempotency_requests | 活動、操作人員、操作類型、鍵、請求指紋及原結果；作用範圍內鍵唯一；不保存明文 QR token |
| print_artifacts | 批次、AES-256-GCM 加密列印內容、到期時間；加密金鑰來自環境秘密設定，不寫入 Git |
| audit_logs | 管理操作及成功核銷的稽核資料；不記錄 QR token 或密碼 |

啟用：交易鎖定活動計數器，再檢查並鎖定憑證，重複啟用直接保留序號；首次啟用才增加計數、寫入序號，序號不超過 1000 時核發資格。所有修改與成功稽核在同一交易內，失敗全部回滾。不要使用不能隨交易回滾的 PostgreSQL sequence 作為業務啟用序號。

核銷：登入與攤位授權檢查後，在交易內鎖定憑證與資格，僅 AVAILABLE 可以建立成功紀錄；建立 Redemption、更新資格與冪等結果一併提交。資料庫唯一約束提供最後防線。鎖定順序一致，必要的暫時性交易衝突採有限重試。

不可修改啟用序號的規則由資料庫 trigger 保護。成功核銷歸屬以外鍵與活動一致性約束保護。所有 migrations 隨原始碼提交。

## 5. 實體 QR 列印與掃碼安全提案

- 每張 QR 使用 256-bit 密碼學隨機 token；publicCode 僅作為人工核對碼。
- QR 內容採專用格式的 opaque token，不含個人資料、不以公開碼代替私密 token。
- 印刷頁包含 QR、公開碼與必要提示，提供列印樣式及瀏覽器列印／另存 PDF。
- 原始 token 僅用於產碼、授權列印與掃碼請求；不寫入一般資料表、日誌、報表或 Git。
- 為支援列印失敗重試，批次列印內容使用 AES-256-GCM 加密保存，預設可下載 24 小時；逾期刪除加密列印檔，不刪除憑證、資格、核銷或稽核歷史。
- 只有 Event Staff 可以下載列印內容；下載須稽核並禁止快取。金鑰遺失後無法還原列印內容。
- 24 小時為已核准預設值。逾期不提供舊批次重印；更長保存期及補發流程另行確認。
- 工作人員與攤販使用 HTTPS 下的相機掃碼，處理相機拒絕、無相機及連續掃描；提供人工輸入完整憑證作為替代，不接受只輸入 publicCode 核銷。

## 6. 已核准的登入與安全行為

- 帳號密碼登入；密碼使用 scrypt 加鹽雜湊，不提供預設正式密碼。
- 使用伺服器端 Session，瀏覽器以 HttpOnly、Secure（HTTPS 環境）、SameSite Cookie 持有隨機 token；資料庫只存 token hash。
- Session 有效期預設 8 小時；登出立即失效。
- 寫入操作驗證 CSRF token 與 Origin；登入限流，敏感請求不記錄 body 或認證資訊。
- Event Staff 可管理批次、列印與啟用，以及查看總覽／統計；Vendor 只存取自己授權的攤位；Finance 只能讀取報表與匯出。
- 不新增 Admin 業務角色，介面 Event Admin 代表後台區域。
- 核銷在伺服器重新驗證權限，不相信前端狀態。

## 7. 已核准的 API 補充

保留現有 10 個端點與已給出的 JSON 成功範例。API_SPEC.md 的待確認項目須於核准後補成正式契約。

- 新增登入、登出、目前登入者及 CSRF 資訊端點。
- 新增 Event Staff 的 QR 批次清單與受保護列印內容端點，以及工作人員入場進度查詢。
- 新增以冪等鍵查詢本人請求結果的端點，供網路逾時恢復使用；不回傳其他操作人員的結果。
- 持有人狀態查詢須以請求 header 提供有效 QR token，並與 path publicCode 一致；不使用 URL query 傳私密 token。
- 啟用、核銷及批次建立要求 Idempotency-Key，鍵作用域包含活動、登入操作人員與操作類型；相同鍵與 payload 重送回原結果；同鍵不同 payload 回 409 IDEMPOTENCY_CONFLICT。
- 冪等記錄於活動期間保留，不定期刪除導致活動中重送產生副作用；活動後清理政策另定。
- 請求指紋不保存原始 token。即使回放成功結果，仍須確認目前帳號及攤位權限。
- 查詢／驗證及啟用成功回 200；首次建立批次／核銷回 201，冪等重播保留原狀態碼；欄位錯誤 400，未登入 401，未授權 403，不存在或無效憑證 404，狀態衝突及重複核銷 409，限流 429，未預期錯誤 500。
- 非成功操作統一使用 { success: false, error: { code, message } }，不回傳堆疊或秘密資料。
- 拒絕未知欄位；UUID、token 格式與數量上限等以共用 schema 定義，更新文件與測試。
- 批次數量提案為每次 1～5000；列表預設 50 筆、最多 100 筆；CSV 匯出完整授權範圍資料。
- eligible 表示目前有效免費資格（AVAILABLE 或 REDEEMED）；redeemable 僅在憑證 ACTIVATED 且資格 AVAILABLE 時為 true；REVOKED、VOIDED、未啟用或無資格均不得核銷。
- 重複啟用不復原免費資格；回原 activationSequence 及目前資格狀態。
- 驗證成功受理但不可兌換時回 200 與 redeemable=false、對應狀態及提示；無效憑證與未授權仍為錯誤。
- 報表金額不在範圍內；CSV 僅匯出公開碼、攤販、核銷時間等核准欄位，不包含 token、token hash、登入資訊。
- 畫面「失敗嘗試」只統計該攤當日合法授權下的不可兌換驗證或正式核銷失敗，與成功核銷統計分開；同一冪等重送不重複計入。此指標定義已隨方案核准。
- 活動是否可操作依伺服器設定的進行中狀態判定，不讓前端指定任意 eventId。

## 8. 預定交付與檢查

1. 建立核准的 feature branch、專案骨架及本機環境設定。
2. 實作 migrations、登入授權與帳號 CLI。
3. 實作批次產碼、受保護列印、實體 QR 掃描。
4. 實作交易式入場啟用、唯讀驗證、一次性核銷、冪等恢復。
5. 依圖片完成 React 介面與真實報表、CSV 匯出。
6. 補上輸入、授權、交易、報表及瀏覽器流程測試。
7. PostgreSQL 執行 ACT-001～006、RED-001～008、RPT-001～004，包含 100 筆跨越第 1000 名的並發啟用與跨攤同時核銷。
8. 執行 lint、typecheck、build、unit、integration；QR 列印掃描往返測試與人工相機驗收另標明結果。任何未執行或受環境限制項目如實回報。
9. 更新 PRD 已確認流程、ARCHITECTURE、SECURITY、API_SPEC、TESTING 及開發執行說明；不將測試需求勾選當作通過證明。
10. 準備可審閱 diff 與 PR 資料；取得推送授權後才推送與開 PR，不自動合併或部署。

## 9. 已知環境限制

- Node.js 22 與 npm 可用。
- psql 可用，但初始檢查未連上 PostgreSQL 且 Docker socket 存取受限；實作期間已啟動本機隔離 PostgreSQL 16 並完成測試。
- 不要求使用者提供正式資料庫或秘密；優先使用隔離測試資料庫。無法取得測試資料庫時不宣稱並發規則已驗證。
- Sites 已閱讀建置工作流程，但不以其 D1 儲存取代專案要求的 PostgreSQL，亦不在核准正式部署前發布網站。

## 10. 實作期間補充

- 已建立本機 staging 與 feat/activity-qr-system，未推送遠端、合併或部署。
- 已使用本機隔離 PostgreSQL 16 執行測試，不使用正式資料。
- Node.js 內建測試、Playwright Chromium 及 PNG QR 解碼提供交易與流程驗證。
- 依使用者授權補充 API 契約；未更改免費上限與跨攤一次性規則，資料庫依原核准設計實作。
