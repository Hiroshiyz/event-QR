# 活動 QR 憑證與核銷系統

React + TypeScript + Fastify + PostgreSQL 的單一活動 WebApp。活動人員建立並列印實體 QR，現場工作人員掃碼啟用，攤販驗證後確認核銷。只有前 1000 位成功啟用者取得免費資格，所有攤販共用一次性資格。

## 本機啟動

需求：Node.js 22（建議 22.13 以上）、npm、PostgreSQL 16 以上。先依 AGENTS.md 閱讀 docs。

```sh
npm ci
cp .env.example .env
```

在 PostgreSQL 建立空的開發資料庫與專用帳號，將連線字串填入 `.env` 的 `DATABASE_URL`。不要使用正式資料庫執行測試。

產生列印加密金鑰並填入 `.env` 的 `PRINT_ENCRYPTION_KEY`；金鑰不得提交 Git，遺失將無法解密尚未到期的列印內容：

```sh
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm run db:migrate
npm run admin -- event --name "活動名稱"
```

將輸出的活動 UUID 填入 `.env` 的 `EVENT_ID`。開發時 `APP_ORIGIN=http://localhost:5173`。

建立帳號，密碼從 stdin 傳入，不放在命令列、原始碼或 Git：

```sh
npm run admin -- user --email staff@example.com --role EVENT_STAFF
npm run admin -- user --email vendor@example.com --role VENDOR
npm run admin -- user --email finance@example.com --role FINANCE
```

CLI 會等待 stdin。輸入至少 12 字元密碼後按 Enter、Ctrl-D。終端可能會顯示輸入，正式使用應透過受信任的密碼管理工具將密碼送入 stdin。請勿將真實密碼貼入 shell 指令或聊天。

建立攤販與授權：

```sh
npm run admin -- vendor --name "A 攤｜咖啡飲品"
npm run admin -- assign --user <攤販使用者UUID> --vendor <攤販UUID>
npm run dev
```

瀏覽 `http://localhost:5173`。工作人員可切換後台／入場啟用頁；攤販僅進入自己的工作台；財務僅能查看與匯出報表。不提供公開註冊或角色切換。

停用使用者：`npm run admin -- disable-user --user <UUID>`。目前沒有補發、作廢、撤銷或名額重分配操作介面；相關營運規則仍待確認。

## 實體 QR 作業

1. 工作人員登入後，在「QR 批次」填名稱及數量，建立 1～5000 張憑證。
2. 按「列印」，確認 QR 圖片顯示後使用「列印／另存 PDF」。列印內容在建立後 24 小時內可再次下載。
3. 在乾淨的白紙上列印，保留 QR 四周空白。每張都有公開核對碼，避免將同一張憑證重複發放。
4. 現場工作人員開啟「入場啟用」，相機掃碼後確認啟用。重複啟用不會再次發放資格。
5. 攤販相機掃碼後按「檢查兌換資格」，核對可兌換後按「確認交付並核銷」。驗證本身不扣除資格。
6. 網路錯誤時保留原內容重試，前端保留原冪等鍵並先查詢結果；不要改換憑證直到原結果確認。sessionStorage 僅保存請求鍵與內容指紋，不保存 QR token；重新整理後再次掃描同張 QR、送出相同操作可沿用原鍵。若瀏覽器不允許儲存或已關閉分頁，需先查閱攤販紀錄確認是否已成功。

相機需要 HTTPS 或 localhost。從手機開啟電腦的普通 HTTP IP 位址通常無法使用相機。支援輸入完整 `EVTQR:…` 憑證作為替代，公開核對碼不能用於核銷。

列印檔等同實體憑證，需由主辦單位妥善保管。禁止把正式列印檔、QR 截圖或 token 加入 Git。列印 API 禁止快取且僅限 Event Staff；主資料表只存 token hash，暫存列印內容以 AES-256-GCM 加密。

每小時執行 `npm run db:cleanup`（例如由作業系統排程），清除已過期列印內容及 Session；到期內容即使尚未清除也無法下載。不要刪除歷史憑證、核銷、冪等與稽核紀錄。

## 驗證

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

另建名稱結尾為 `_test` 的專用 PostgreSQL 資料庫，測試會套用 migrations 並建立隔離活動；不會重設或刪除既有歷史資料。每次測試會累積測試資料，可在確認為拋棄式測試資料庫後由維運人員管理其生命週期。

```sh
TEST_DATABASE_URL=postgresql://.../activity_qr_test npm run test:integration
TEST_DATABASE_URL=postgresql://.../activity_qr_test npm run test:production
npx playwright install chromium
TEST_DATABASE_URL=postgresql://.../activity_qr_test npm run test:browser
```

瀏覽器測試需要本機 3000、5173 埠可用。它會暫時啟動 API 與 Vite；只使用隨機產生的測試帳密及憑證。測試結果見 `docs/TESTING.md`。

## 正式執行準備

```sh
npm run build
NODE_ENV=production npm start
```

正式環境需設定 HTTPS 的 `APP_ORIGIN`，反向代理同源網站到 `127.0.0.1:3000`；後端同時提供首頁、`/assets/` 及 `/api/`，也接受既有 API 原路徑。後端不信任任意 X-Forwarded-* header，Cookie 的 Secure 屬性由正式環境設定決定。

部署前需確認資料庫、金鑰備援、TLS、隔離資料庫權限、登入帳號、到期檔案清理排程、印刷品質與真機相機操作。單一 API 程序使用記憶體限流；若未來部署多實例，需另設共用限流儲存。

正式部署與營運未決事項仍需額外核准；分支與 PR 狀態以 GitHub 為準。

## 上線前唯讀檢查與現場驗收

```sh
npm run preflight
npm run --silent preflight -- --json
```

檢查設定、migration、資料庫保護約束、活動計數、免費資格、核銷一致性、帳號與列印金鑰，不套用 migrations、不改資料、不列出私密憑證。FAIL 會回傳結束碼 1；WARN 仍需人工確認，沒有 FAIL 不代表正式放行。JSON 輸出的 `manualApprovalRequired` 固定為 true。

手機、紙張、網路、權限與現場作業步驟見 [現場驗收清單](docs/FIELD_ACCEPTANCE.md)。清單目前未勾選，必須以實際設備執行並記錄。若偵測資料不一致，保留歷史並調查原因，不要透過刪除、重排序號或再發資格自行修復。

繁體中文字型隨網站打包，不依賴外部字型服務。Noto Sans TC 使用 SIL Open Font License 1.1，授權全文位於 `public/assets/licenses/NotoSansTC-OFL.txt`。
