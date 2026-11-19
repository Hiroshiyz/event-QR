# Activity QR Voucher System — API 規格

## 1. 文件用途與規格狀態

本文件供開發者與 AI 理解 API 設計，並與 `AGENTS.md` 指向的 `docs/API_SPEC.md` 保持一致。這是設計文件，不代表 API 已實作或測試通過。

實作前依序閱讀：`PRD.md`、`ARCHITECTURE.md`、`SECURITY.md`、本文件、`TESTING.md`、`DEVELOPMENT_RULES.md`。路徑均相對於 `docs/`。

- **既有設計**：本文件保留原 API 文件的端點、欄位與 JSON 範例。
- **必須遵守**：PRD、架構及安全文件已確認的業務與安全規則。
- **待確認**：原文件未定義的契約；AI 不得自行補成已核准規格。
- 發現文件衝突時須先回報。變更業務規則、資料庫結構、外部 API 契約或安全行為前須取得核准。

## 2. 共通規則

### 2.1 身分、安全與資料

- 啟用由授權工作人員執行；登入與授權的具體機制待確認。
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

回應中的 `NOT_ELIGIBLE` 不代表必須建立一筆 Entitlement 資料。`eligible` 與 `redeemable` 在已核銷、撤銷等狀態下的完整真值表尚待確認，不可僅從成功範例推導。

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
| GET | `/admin/dashboard` | 活動總覽統計 | Admin / Finance |
| GET | `/admin/reports/vendors` | 各攤販兌換統計 | Admin / Finance |
| GET | `/admin/reports/export` | 匯出核銷資料 | Admin / Finance |

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

欄位必填性、長度限制、完整回應 schema 與 HTTP 狀態碼尚未完整定義。本表描述現有範例，不新增欄位契約。

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
11. 網路逾時後應先查詢核銷結果；查詢契約尚待確認，AI 不得自行新增端點。

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

## 9. 實作前待確認事項

| 項目 | 尚待確認的契約 |
| --- | --- |
| 認證與角色 | 登入機制、啟用授權、持有人 Session 或憑證傳遞方式；清單中 Admin / Finance 與 PRD Event Staff / Finance Staff 的精確對應，不可自行新增 Admin 角色 |
| HTTP 與錯誤 | 各端點成功與失敗狀態碼、統一錯誤格式、除 `ALREADY_REDEEMED` 外的錯誤碼 |
| 欄位與狀態 | 必填性、格式、限制、未知欄位處理；各狀態回應及 `eligible` / `redeemable` 完整真值表 |
| 冪等 | `Idempotency-Key` 已出現在啟用與核銷範例；必填性、格式、作用範圍、保留期限、同鍵不同 payload、並發重送與失敗重試處理待定 |
| 重複啟用回應 | 資格已核銷或撤銷後重複啟用的回應；原序號及不重複核發的規則仍須遵守 |
| 驗證失敗 | 不可兌換的完整回應；不得直接假設使用正式核銷端點的錯誤格式 |
| 僅列端點的 API | 批次、持有人查詢、核銷紀錄、Dashboard、報表的完整請求、回應、分頁、篩選、排序與匯出細節 |
| 逾時查詢 | 如何查詢既有核銷結果及其授權範圍 |
| 活動識別 | 單一活動如何由後端識別，以及未開始或已結束的處理方式 |
| 營運政策 | PRD 待確認的商品限制、交付順序、補發撤銷、異常復原及結算金額 |

涉及待確認事項時，先準備具體方案並取得確認，再實作相關契約。不得用範例值、建議技術或未確認政策填補規格空白。
