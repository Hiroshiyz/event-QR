# DEVELOPMENT_RULES.md

## Branch Strategy

- `main`：正式環境的受保護分支。
- `staging`：整合與測試分支。
- `feat/*`：新功能分支。
- `fix/*`：錯誤修正分支。
- `test/*`：測試分支。

所有功能由 staging 建立分支，完成後 PR 回 staging。

## Coding Rules

- 使用既有程式語言及架構。
- 不自行新增大型框架或替換 ORM。
- Controller 不放複雜商業邏輯。
- 商業邏輯集中在 Service。
- 所有輸入必須進行驗證。
- API 必須提供明確錯誤碼。
- DB schema 修改必須附帶 migration。
- 不得在開發過程中修改無關的既有功能。
- 禁止將測試專用的繞過驗證邏輯帶入正式環境。

## Pull Request Rules

PR 必須包含：

- Purpose
- Scope
- Implementation Summary
- API / Schema Changes
- Tests Executed
- Test Results
- Risk Assessment
- Manual Verification Steps

PR 目標一律為 staging。

Agent 不得自行 Merge、Force Push、跳過 CI 或部署 production。

## Commit Rules

優先使用 Conventional Commits，例如：

- `feat: implement qr batch generation`
- `feat: implement vendor redemption`
- `fix: prevent duplicate redemption`
- `test: add concurrent redemption cases`
- `docs: update redemption requirements`

每個 PR 應保持單一主要目的，避免將多項不相關功能混合提交。