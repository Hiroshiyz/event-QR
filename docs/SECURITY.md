# SECURITY.md

## QR Code Security

- 每個 QR Code 使用密碼學安全亂數產生不可預測的 token。
- 建議至少使用 128-bit 隨機值，優先採用 256-bit。
- QR Code 不得包含姓名、電話、Email 或個人資料。
- 資料庫只保留供驗證的 token hash。
- 私密 QR token 不得出現在分析工具、一般操作日誌或報表。
- 必須使用 HTTPS。
- 作廢的 QR Code 不得再次啟用或核銷。

## Authentication & Authorization

- 攤販必須登入後才能進行核銷。
- 後台必須區分 Event Staff、Finance Staff 權限。
- 所有權限均由 Backend 驗證。
- 不得信任前端傳入的角色或攤販識別碼。
- 攤販只能代表被授權的攤位核銷。
- 管理操作須保留 Audit Log。

## Redemption Safety

- QR 掃描驗證與實際商品核銷分開。
- 核銷使用資料庫交易。
- 同一 entitlement 只能成功核銷一次。
- 必須提供 idempotency 機制處理重送。
- 並發掃碼不得導致重複核銷。
- 網路逾時後應先查詢核銷結果，不可直接假定失敗。
- 原始 QR token 不能被當作唯一的後台授權憑證。
- 驗證成功後，攤販仍須按下確認才完成核銷。

## Physical QR Code Risks

實體 QR Code 本身屬於持有者憑證，單靠 QR Code 無法辨識掃描者是否為原始領取者。

應採用：

- 發放及啟用流程控管。
- 未啟用憑證不得免費兌換。
- 已作廢憑證不得恢復使用。
- 補發須先停用原憑證，並留下稽核紀錄。
- 若需防止消費者自行重複領取多張，必須設計額外的現場防重領機制。
- 如現場要求防止偷掃或拍照轉用，需補充身分核對、動態憑證或現場交付驗證機制。

## Additional Protections

- API Rate Limiting
- Login Brute-force Protection
- Audit Logging
- Session Expiration
- Secure Cookie / Token Storage
- Secret Management
- Database Backup
- CSV Formula Injection Protection
- QR Batch Download Access Control

安全規則不得為了開發方便而直接停用。