# ARCHITECTURE.md

## 1. Architecture

目前 MVP 採用 Modular Monolith：

- Frontend：React + TypeScript + Vite WebApp
- Backend：Node.js + TypeScript + Fastify API
- Database：PostgreSQL
- Database access：pg 參數化 SQL；明確 SQL migrations，不使用 ORM
- QR Scanner：html5-qrcode 瀏覽器相機掃描，另提供完整憑證輸入
- Deployment：依現有 CI/CD 環境決定

第一版以單一 Backend 維護商業邏輯，不拆成多個微服務。

## 2. Backend Modules

- `auth`：攤販及管理人員身分驗證
- `events`：活動設定、日期及活動狀態
- `vendors`：攤販與攤位管理
- `qr-batches`：批次產碼、列印及發放追蹤
- `credentials`：QR 憑證管理、啟用及作廢
- `entitlements`：免費資格核發與名額限制
- `redemptions`：核銷驗證與原子化兌換
- `reports`：統計、報表及匯出
- `audit`：重要操作稽核

## 3. Data Models

### Event

- id
- name
- status
- startAt
- endAt
- freeQuotaLimit (default: 1000)
- createdAt
- updatedAt

### Vendor

- id
- eventId
- name
- status
- createdAt

### StaffUser

- id
- email
- passwordHash / externalAuthId
- role
- status
- createdAt

多攤位權限由獨立關聯表管理。

### VendorStaffAssignment

- id
- staffUserId
- vendorId
- role
- createdAt

### QRBatch

- id
- eventId
- batchName
- quantity
- createdBy
- createdAt
- status

### Credential

- id
- eventId
- batchId
- publicCode
- tokenHash
- status
- activatedAt
- voidedAt
- createdAt

`tokenHash` 應有唯一索引。原始 QR 密鑰不可明文儲存在一般資料表或日誌。

### Entitlement

- id
- eventId
- credentialId
- status
- grantedAt
- redeemedAt
- revokedAt

每個活動內，每張憑證最多對應一筆免費兌換權益。

### Redemption

- id
- eventId
- entitlementId
- credentialId
- vendorId
- redeemedBy
- redeemedAt
- idempotencyKey

`entitlementId` 必須有唯一約束，保證同一權益最多產生一筆成功核銷。

重試時應使用同一 idempotencyKey 返回一致結果。

### AuditLog

- id
- actorId
- eventId
- action
- targetType
- targetId
- metadata
- createdAt

## 4. Transaction Consistency

免費資格核發：

- 在資料庫交易中鎖定活動名額或對應計數器。
- 確認憑證尚未啟用。
- 確認可用名額。
- 原子化啟用、核發資格、更新名額計數。
- 避免併發核發超過上限。

商品核銷：

1. 驗證登入身分及攤販權限。
2. 啟動資料庫交易。
3. 鎖定或條件式更新該筆免費權益。
4. 確認目前為 AVAILABLE。
5. 建立 Redemption。
6. 將 Entitlement 改為 REDEEMED。
7. 提交交易。
8. 回傳核銷結果。

任何錯誤須 Rollback。

資料庫唯一約束是最後一道防線，不可僅依賴前端按鈕停用或先查詢後寫入。

## 5. Reporting

攤販兌換統計以成功提交的 Redemption 資料為準。

MVP 可直接使用 SQL `GROUP BY vendorId` 統計。

初期不需要額外建立投影表。當資料量或報表效能有明確需求時，再考慮 Materialized View 或 Read Model。

## 6. Time and Identifiers

- 資料庫時間：UTC。
- 活動顯示時區：Asia/Taipei。
- 內部 ID：UUID。
- 對外公開編號與私密 QR token 分開。
- 原始 token 不應出現在報表、應用日誌或錯誤追蹤平台。

## 7. 已核准實作配置

實際 schema 以 `migrations/001_initial.sql` 為準。初期以 `src/server/service.ts` 集中交易式業務操作，`app.ts` 提供輸入驗證、登入授權與 API 路由；成長時可依第 2 節領域拆分，避免重複業務實作。

- `events.activation_count` 為可隨交易回滾的活動計數器。啟用以 `FOR NO KEY UPDATE` 串行鎖定活動，與外鍵 `KEY SHARE` 相容；不使用 PostgreSQL sequence 作為業務啟用序號。
- `credentials.activation_sequence` 與 `activated_at` 保存啟用結果；複合唯一約束防止同活動序號重複，trigger 防止已分配結果被改寫。
- `entitlements` 的單憑證唯一約束與核發 trigger 保護前 1000 位限制；1001 位起不建立免費資格資料列，API 回 `NOT_ELIGIBLE`。
- 核銷鎖定 Credential，再鎖定 Entitlement，建立 Redemption、更新資格、保存冪等結果及成功稽核於同一交易。
- 外鍵保護活動、憑證、資格、攤販的一致性；Redemption 的 entitlement_id 唯一是跨攤一次性的最後防線。
- `sessions` 存登入 token hash、CSRF token 與期限；`idempotency_requests` 以活動、操作人員、操作類型、鍵為複合主鍵。
- `print_artifacts` 暫存 AES-256-GCM 加密列印內容 24 小時，下載僅限 Event Staff。這是可重試列印的特定秘密儲存，不在 Credential 保存原始 token。到期下載被拒，清理指令只刪除過期暫存及 Session。
- 統計回應以同一 REPEATABLE READ 快照計算；各攤統計以成功 Redemption 為準，不以掃描或失敗操作計數。
- 單一活動由伺服器 `EVENT_ID` 選定，免費上限由資料庫 CHECK 固定 1000；沒有調整名額或重分配的 API。
- 前端與 API 同源，開發時 Vite 將 `/api` 代理到 3000 埠；正式執行由 Fastify 提供 build 產物，TLS 由反向代理提供。

目前不提供正式部署設定、補發／撤銷／作廢寫入流程或財務金額計算，維持 PRD 未決事項的邊界。

## 8. Operational Readiness

`npm run preflight` 為受信任維運 CLI，使用 `src/server/readiness.ts` 的唯讀快照診斷，沒有新增 HTTP 端點、資料表或自動修復流程。CLI 限單一連線，連線與查詢各有 10 秒逾時；可輸出純文字或不含秘密的 JSON，FAIL 結束碼為 1，WARN 仍須人工確認。

檢查不列出帳密、QR token、加密金鑰或連線字串，不建立測試資格、不改名額或歷史。查出不一致時保留資料並要求調查。現場手機、實體印刷及正式放行程序見 FIELD_ACCEPTANCE.md；自動檢查不能取代人工驗收。
