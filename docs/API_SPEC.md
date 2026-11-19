# Activity QR Voucher System — API 規格

## 1. 文件用途與規格狀態

本文件記錄已核准 MVP 的 API 契約，供開發者與 AI 實作及維護。實際驗證結果與限制見 `TESTING.md`，不可將規格本身當作測試通過證明。

實作前依序閱讀：`PRD.md`、`ARCHITECTURE.md`、`SECURITY.md`、本文件、`TESTING.md`、`DEVELOPMENT_RULES.md`。路徑均相對於 `docs/`。

- **既有設計**：本文件保留原 API 文件的端點、欄位與 JSON 範例。
- **必須遵守**：PRD、架構及安全文件已確認的業務與安全規則。
- **待確認**：尚未核准的營運功能；AI 不得自行改動業務規則或資料庫。使用者已授權自行補充必要 API，仍須同步文件與測試。
- 發現文件衝突時須先回報。變更業務規則、資料庫結構、外部 API 契約或安全行為前須取得核准。

## 2. 共通規則

### 2.1 身分、安全與資料

- 啟用由授權工作人員執行；登入與授權的具體機制見第 9 節。
- 攤販必須登入，後端必須驗證其對指定 `vendorId` 的權限；前端傳入的攤位或角色不是授權證明。
- 核銷操作人員須由後端登入資訊取得。
- Finance Staff 預設不得建立、作廢或修改免費資格。
- 必須使用 HTTPS。JSON 請求使用 `Content-Type: application/json`。
- `credentialToken` 是私密 QR token，與公開 `publicCode` 分開；資料庫僅保存供驗證的 token hash。
- 私密 QR token 不得出現在一般日誌、分析工具、錯誤追蹤或報表。
- 內部 ID 使用 UUID。範例中的 `vendor-001`、`redemption-001`、`opaque-qr-token` 僅為佔位值。
- 資料庫時間使用 UTC，活動顯示時區使用 Asia/Taipei；核銷時間範例為 UTC ISO 8601 字串。

### 2.2 狀態定義

| 對象 | 狀態 | 意義 |
| --- | --- | --- |
| Credential | `CREATED` | 已產生，尚未啟用 |
| Credential | `ACTIVATED` | 已啟用 |
| Credential | `VOIDED` | 已作廢 |
| Entitlement | `NOT_ELIGIBLE` | 不具免費資格 |
| Entitlement | `AVAILABLE` | 具資格且尚未兌換 |
| Entitlement | `REDEEMED` | 已完成兌換 |
| Entitlement | `REVOKED` | 資格已撤銷 |

憑證狀態與免費資格狀態分開管理。啟用回應的頂層 `status` 為憑證狀態；驗證及核銷回應的 `status` 為免費資格狀態。

回應中的 `NOT_ELIGIBLE` 不代表必須建立一筆 Entitlement 資料。`eligible` 與 `redeemable` 在已核銷、撤銷等狀態下的完整真值表見第 9 節。

## 3. API 清單（既有設計）

建議依照業務領域拆分 API，而不是全部集中在 QR Code Controller。
| Method | Endpoint | 功能 | 權限 |
| --- | --- | --- | --- |
| POST | `/admin/qr-batches` | 批次產生 QR Code | Event Staff |
| GET | `/admin/qr-batches/:id` | 查詢產碼批次 | Event Staff |
| POST | `/admissions/activate` | 啟用入場憑證 | 授權啟用流程 |
| GET | `/tickets/:publicCode` | 查看入場及資格狀態 | 憑證持有人 |
| POST | `/vendor/redemptions/validate` | 掃碼驗證資格 | Vendor |
| POST | `/vendor/redemptions` | 正式核銷商品 | Vendor |
| GET | `/vendor/redemptions` | 自己攤販的核銷紀錄 | Vendor |
| GET | `/admin/dashboard` | 活動總覽統計 | Event Staff / Finance Staff |
| GET | `/admin/reports/vendors` | 各攤販兌換統計 | Event Staff / Finance Staff |
| GET | `/admin/reports/export` | 匯出核銷資料 | Event Staff / Finance Staff |

這裡的 /tickets/:publicCode 不應只憑可猜測的公開編號就回傳敏感資訊。消費者必須透過持有的有效憑證或經授權的 Session 存取資料。

## 4. 入場憑證啟用

### 4.1 請求

```http
POST /admissions/activate
Content-Type: application/json
Idempotency-Key: activation-request-001
```

```json
{
  "credentialToken": "opaque-qr-token"
}
```

### 4.2 啟用成功，且取得免費資格

```json
{
  "status": "ACTIVATED",
  "activationSequence": 528,
  "eligible": true,
  "entitlement": {
    "status": "AVAILABLE"
  }
}
```

### 4.3 第 1,001 位啟用成功，無免費資格

```json
{
  "status": "ACTIVATED",
  "activationSequence": 1001,
  "eligible": false,
  "entitlement": {
    "status": "NOT_ELIGIBLE"
  }
}
```

注意： activationSequence 一定要由伺服器產生，而且在資料庫交易完成後回傳，不能由前端提供。

## 5. 攤販掃描驗證

### 5.1 請求

```http
POST /vendor/redemptions/validate
Content-Type: application/json
```

```json
{
  "credentialToken": "opaque-qr-token",
  "vendorId": "vendor-001"
}
```

### 5.2 可核銷回應

```json
{
  "eligible": true,
  "redeemable": true,
  "status": "AVAILABLE",
  "message": "可以免費兌換商品"
}
```

此 API 絕對不應修改免費資格的狀態，因為攤販可能掃描後發現商品缺貨，或消費者只是詢問資格。

## 6. 攤販正式核銷

### 6.1 請求

```http
POST /vendor/redemptions
Content-Type: application/json
Idempotency-Key: redemption-request-001
```

```json
{
  "credentialToken": "opaque-qr-token",
  "vendorId": "vendor-001"
}
```

### 6.2 核銷成功

```json
{
  "success": true,
  "redemptionId": "redemption-001",
  "status": "REDEEMED",
  "vendorId": "vendor-001",
  "redeemedAt": "2026-11-19T02:00:00.000Z"
}
```

### 6.3 另一攤販再次嘗試正式核銷

```json
{
  "success": false,
  "error": {
    "code": "ALREADY_REDEEMED",
    "message": "這張免費兌換資格已經使用"
  }
}
```

## 7. 欄位與處理要求

### 7.1 既有範例欄位

| 欄位 | 範例型別 | 意義 |
| --- | --- | --- |
| `credentialToken` | string | 私密 QR 憑證 token |
| `vendorId` | string | 目標攤位，後端須驗證登入者授權 |
| `activationSequence` | integer | 同一活動內唯一且不可修改的啟用序號 |
| `eligible` | boolean | 範例中表示是否具免費資格，完整狀態語意待確認 |
| `redeemable` | boolean | 驗證時是否可兌換；不代表預留資格 |
| `entitlement.status` | string | 啟用回應中的免費資格狀態 |
| `success` | boolean | 核銷操作結果 |
| `redemptionId` | string | 成功核銷紀錄 ID |
| `redeemedAt` | string | 成功核銷時間 |
| `error.code` | string | 機器可辨識的錯誤碼；目前範例為 `ALREADY_REDEEMED` |
| `message` / `error.message` | string | 人類可讀的提示文字 |

欄位驗證、HTTP 狀態碼及補充端點見第 9 節。

### 7.2 啟用：BR-001

1. QR 建立時不核發免費資格。
2. 後端以序列化的資料庫交易決定成功啟用順序，不信任前端時間或序號。
3. 同一活動的序號唯一且不可修改。重複啟用保持原序號，不重複增加計數或核發資格。
4. 僅成功啟用序號 1～1000 取得免費資格；第 1001 位起仍可正常入場。
5. 啟用、序號計數與資格核發須具交易原子性；失敗全部 Rollback，不消耗序號。序號分配方式須能滿足此回滾要求。
6. 成功結果於交易提交後回傳。作廢憑證不得啟用。
7. 以實際 PostgreSQL 並發測試驗證不超發及序號唯一，不能只用 Mock 證明。

### 7.3 驗證與核銷：BR-002

1. 掃描驗證不消耗或預留資格，也不建立成功核銷紀錄。
2. 驗證成功後仍須由攤販確認核銷；正式核銷須在交易中重新檢查當前資格。
3. 未啟用、作廢、無免費資格、資格已撤銷或已核銷者不得完成核銷。
4. 每張憑證最多一份免費資格；該資格跨所有攤販最多成功核銷一次。
5. 交易內以鎖定或條件式更新控制競爭，建立 Redemption 並更新資格為 `REDEEMED`；失敗全部 Rollback。
6. 資料庫須對 Redemption 的 `entitlementId` 設唯一約束，不能使用缺乏並發控制的先查後寫。
7. 成功核銷歸屬唯一攤販，並記錄登入操作人員與時間。
8. 未授權 `vendorId` 的請求須拒絕且不得修改資格。
9. 多攤競爭同一資格最多一筆成功；對有效資格的正常競爭測試須恰好一筆成功。
10. 相同請求以相同冪等鍵重送，回傳原結果且不新增紀錄；另一攤販的獨立核銷請求則須回傳 `ALREADY_REDEEMED`。
11. 網路逾時後應先查詢核銷結果；查詢契約見第 9 節。

### 7.4 報表

- 僅統計成功提交的 Redemption；失敗、重複嘗試與冪等重送不得增加總數。
- 各攤販統計與總數須與成功核銷紀錄一致。
- 免費資格累計發放數、未兌換數與剩餘可核發名額須分開理解；未兌換數不代表可重新發放的名額。
- 財務匯出不得包含私密 QR token，CSV 須防範公式注入。

## 8. 測試對照

| 功能 | `TESTING.md` 項目 | 驗證重點 |
| --- | --- | --- |
| 啟用 | ACT-001～ACT-006 | 邊界序號、重複啟用、並發跨越上限、失敗回滾 |
| 核銷 | RED-001～RED-008 | 跨攤一次性、並發競爭、冪等、唯讀驗證、資格與授權 |
| 報表 | RPT-001～RPT-004 | 各攤及總量、排除重複、未兌換數、token 保密 |

此表僅對應測試需求，不代表測試已執行或通過。交易與並發測試須使用實際 PostgreSQL。

## 9. 已核准 MVP 補充契約

### 9.1 傳輸、角色及登入

瀏覽器同源以 `/api` 前綴呼叫本文件端點，後端也接受原路徑。API 不回傳私密 token；受保護列印端點為必要例外。所有回應 `Cache-Control: no-store`，不提供跨來源 CORS。

| Method | Endpoint | 功能 | 權限 |
| --- | --- | --- | --- |
| GET | `/health` | 程序健康狀態 `{ok:true}`，不代表資料庫已通過業務測試 | 公開 |
| POST | `/auth/login` | 登入 | 公開，需正確 Origin，限流 |
| GET | `/auth/me` | 目前身分、CSRF token 及授權攤位 | 已登入 |
| POST | `/auth/logout` | 登出並使 Session 失效 | 已登入、CSRF |
| GET | `/admissions/progress` | 啟用頁所需活動統計 | Event Staff |
| GET | `/admin/qr-batches` | 批次清單 | Event Staff |
| GET | `/admin/qr-batches/:id/print` | 24 小時內受保護列印內容 | Event Staff |
| GET | `/requests/:operation/:key` | 查詢本人冪等操作結果 | 對應操作角色，核銷成功結果重新驗證攤位授權 |

登入 Body：`{email:string,password:string}`，拒絕未知欄位，Email 最長 254 字元，密碼 1～256 字元。建立帳號的 CLI 要求密碼至少 12 字元。登入成功 200：`{id,email,role,csrfToken}`，同時設定 HttpOnly、SameSite=Strict Cookie；正式環境加 Secure。Session 有效 8 小時，登出立即失效。密碼使用 scrypt 加鹽雜湊，Session 隨機 token 只存 hash。

`GET /auth/me` 回傳 `{id,email,role,csrf,csrfToken,vendors:[{id,name}]}`，`csrf` 與 `csrfToken` 相同；攤位僅列登入者於目前活動的有效授權。角色值為 `EVENT_STAFF`、`VENDOR`、`FINANCE`。畫面 Event Admin 是後台名稱，不是額外角色。

所有寫入請求（含登入）須有與 APP_ORIGIN 完全一致的 Origin；登入以外寫入須有 Cookie 與 `X-CSRF-Token`。後端不信任任意代理 header。無公開註冊、角色切換或使用者自行指定操作人員的入口。

限流採單一程序記憶體：一般每個 IP 每分鐘 300 次；登入每個 IP 每 15 分鐘 10 次。多實例部署需另設共用限流。

### 9.2 欄位驗證與 HTTP 結果

- `credentialToken`：必填，43 字元 base64url 字串，不含 `EVTQR:` 前綴。相機讀取的 QR 格式為 `EVTQR:<token>`，前端解析後才送出。
- `vendorId`、批次 ID：UUID；後端檢查活動與登入者授權。
- 啟用 Body 僅允許 `credentialToken`；驗證與核銷僅允許 `credentialToken`、`vendorId`。
- `activationSequence`、角色、資格狀態與操作人員不得由前端提供，未知 Body 欄位回 400。
- `GET /tickets/:publicCode` 要求 `X-Credential-Token`，且須與公開碼對應。公開碼最長 40 字元。不將私密 token 放入 URL。
- 查詢、登入、登出、驗證及啟用成功：200。首次批次建立、核銷成功：201；冪等回放保留原成功狀態碼。
- 錯誤統一 `{success:false,error:{code,message}}`。前端依 code 判定，不依賴 message 字句。

| HTTP | code | 意義 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` / `INVALID_REQUEST` | 欄位、JSON 或請求格式不合法 |
| 401 | `UNAUTHENTICATED` / `INVALID_LOGIN` | 未登入、Session 失效或帳密錯誤 |
| 403 | `FORBIDDEN` / `FORBIDDEN_VENDOR` / `INVALID_ORIGIN` / `INVALID_CSRF` | 角色、攤位、來源或 CSRF 驗證失敗 |
| 404 | `INVALID_CREDENTIAL` / `NOT_FOUND` / `REQUEST_NOT_FOUND` / `EVENT_NOT_FOUND` | 無有效憑證或找不到對應資料 |
| 404 | `PRINT_EXPIRED_OR_NOT_FOUND` | 列印內容不存在或已過期 |
| 409 | `EVENT_CLOSED` / `CREDENTIAL_VOIDED` / `NOT_ACTIVATED` / `NOT_ELIGIBLE` / `ENTITLEMENT_REVOKED` / `ALREADY_REDEEMED` | 活動或資格不允許操作 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同作用範圍的同鍵搭配不同請求內容 |
| 429 | `RATE_LIMITED` | 超過限流 |
| 500 | `INTERNAL_ERROR` | 未預期錯誤，請使用原鍵查詢或重試，不假定失敗 |

掃描驗證若找到憑證但不能兌換，仍回 200，包含 `{eligible,redeemable,status,publicCode,message}`；message 在不可兌換時為對應業務錯誤碼。無效憑證回 404，未授權回 403，活動關閉回 409。

| 憑證／資格 | eligible | redeemable |
| --- | --- | --- |
| ACTIVATED + AVAILABLE | true | true |
| ACTIVATED + REDEEMED | true | false |
| ACTIVATED + REVOKED 或無資格 | false | false |
| CREATED 或 VOIDED | false | false |

重複啟用保持原序號、回目前免費資格狀態，不復原已兌換／撤銷的資格；作廢憑證拒絕。免費資格未建立資料列時對外呈現 `NOT_ELIGIBLE`。

### 9.3 冪等與逾時恢復

批次建立、啟用與正式核銷要求 `Idempotency-Key`，8～128 字元，僅英數字、`_`、`-`。鍵的作用域為活動、登入操作人員、操作類型。原子保存請求指紋及 HTTP 結果，指紋不含原始 token。未預期交易錯誤全部回滾，沒有部分成功結果。

相同鍵及相同內容重送回原結果；同鍵不同內容回 409。不同操作人員或不同操作類型不共用鍵。核銷重播前仍須驗證當前攤位授權。記錄在活動期間保留，沒有自動清理；活動後保留政策待營運決定。

`GET /requests/:operation/:key` 中 operation 為 `batch`、`activate`、`redeem`；只可查詢本人結果，回 `{httpStatus,result}`。未找到或仍未提交回 404，不代表原請求一定失敗。前端遇到網路或 5xx 錯誤，先查詢，尚未確認時保留原鍵及原內容重試。

前端私密 token 僅保存在記憶體，不寫入 localStorage 或 sessionStorage。sessionStorage 按使用者保存請求鍵、操作類型與 SHA-256 內容指紋，重新整理後再掃描相同 QR 並送出相同內容即可沿用原鍵。若分頁關閉或儲存不可用，需先查核銷紀錄確認結果，不可直接當作失敗。

限流、重新登入或權限拒絕不能證明較早請求未提交，因此不會清除未知結果的原鍵。延遲完成的舊帳號請求只清理自己的鍵，不影響其他帳號。批次已建立但列表更新失敗時，介面保留成功收據與列印入口，不再要求重建。

### 9.4 批次與列印

`POST /admin/qr-batches` Body 為 `{name:string,quantity:integer}`，名稱去除首尾空白後 1～100 字元，數量 1～5000，拒絕未知欄位。回 201：`{id,name,quantity,createdAt}`；建立時所有憑證都是 CREATED，不產生免費資格。

`GET /admin/qr-batches` 支援 `page`（預設 1、最大 100000）及 `limit`（預設 50、最大 100），拒絕未知 query 欄位，依建立時間及 ID 遞減排列。回 `{items:[{id,name,quantity,createdAt,printExpiresAt}],page,limit}`。單批查詢回 `{id,name,quantity,createdAt}`。

列印端點回 `{name,cards:[{publicCode,qrContent}]}`。QR content 包含私密 token，只允許 Event Staff 於建立後 24 小時下載。列印暫存以 AES-256-GCM 加密，金鑰來自環境設定。每次下載稽核，不回傳 token hash。到期立即禁止下載，清理工作可移除到期加密內容，保留批次與所有歷史紀錄。

前端將 cards 轉為具有四周留白的 QR 圖像及公開碼，使用瀏覽器列印／另存 PDF。沒有額外的 QR PNG 下載 API、舊批次逾期重印或補發 API。

### 9.5 統計、攤販紀錄與匯出

`GET /admin/dashboard` 及 `/admissions/progress` 回：

```json
{
  "eventName": "活動名稱",
  "eventStatus": "ACTIVE",
  "generated": 3000,
  "activated": 1286,
  "issued": 1000,
  "available": 400,
  "redeemed": 600,
  "remaining": 0,
  "quota": 1000
}
```

`available` 計算 AVAILABLE 資格數，`remaining=1000-issued`。統計使用同一資料庫快照，避免並發更新造成單一回應內數字不一致。`eventStatus` 為 ACTIVE 或 CLOSED；寫入由伺服器設定的單一 EVENT_ID 與活動狀態控制。

`GET /admin/reports/vendors` 回 `{total,items:[{id,name,count,share}]}`。count 以成功 Redemption 為準，share 為 0～1，沒有核銷時為 0；依數量遞減、名稱排列。介面攤販篩選在前端進行。

`GET /vendor/redemptions` 必填 query `vendorId`，支援同上 page／limit，拒絕未知欄位。只回指定授權攤位的 `{items:[{id,publicCode,redeemedAt}],today:{redeemed,failed},page,limit}`；items 為最近成功核銷紀錄，依時間及 ID 遞減。today 以 Asia/Taipei 當日零時起算，failed 計算合法授權下不可兌換驗證及正式核銷失敗的次數，與成功統計分開；同一核銷請求冪等重送不重複增加失敗次數。

CSV 匯出為 UTF-8 BOM、CRLF、Asia/Taipei 時間（含 +08:00），欄位固定為 redemptionId、publicCode、vendorName、vendorId、redeemedAt (Asia/Taipei)。僅匯出目前活動的成功核銷，不含 token、hash、帳密或 Session。所有欄位加引號並轉義，可能成為公式的字串前加單引號。匯出操作稽核。

### 9.6 維護邊界

工作人員及攤販帳號、攤位指派由受信任的管理 CLI 處理，不提供公開註冊。補發、作廢、撤銷、重分配、商品限制與財務金額仍未定義完整營運程序，首版不提供相關寫入 API。新增必要 API 已獲授權；改動業務規則及資料庫仍須先取得核准。
