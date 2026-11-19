# ARCHITECTURE.md

## 1. Architecture

建議採用 Modular Monolith：

- Frontend：React WebApp
- Backend：Node.js API
- Database：PostgreSQL
- ORM：Prisma（若專案採用 Prisma）
- QR Scanner：瀏覽器相機掃描功能
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