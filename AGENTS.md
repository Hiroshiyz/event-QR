# AGENTS.md

## 1. Project

Activity QR Voucher System

A single-event WebApp supporting physical QR credentials, admission activation, free product redemption, vendor operations and financial reporting.

Read project documentation before implementation.

## 2. Source of Truth

Read these documents in order:

1. `docs/PRD.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/API_SPEC.md`
5. `docs/TESTING.md`
6. `docs/DEVELOPMENT_RULES.md`

Existing code must be inspected before making changes.

If an existing implementation conflicts with confirmed business rules, identify and report the conflict before altering the behavior.

Do not invent unresolved business requirements.

## 3. Mandatory Business Invariants

### BR-001: First 1,000 Admission Activations

- QR creation does not grant redemption eligibility.
- Only successful admission activation can grant eligibility.
- Admission order must be decided by a serialized database transaction.
- Activation sequence numbers must be unique and immutable within an event.
- Only sequence numbers 1 through 1000 receive free entitlements.
- Activation number 1001 and later must not receive free entitlements.
- Repeated activation must not increment counters or grant new entitlements.
- Concurrent activations must not oversubscribe the free quota.

### BR-002: One Redemption Across All Vendors

- One eligible credential may have at most one free entitlement.
- An entitlement may be redeemed successfully only once.
- Redemption eligibility is global across all vendors.
- Scanning and checking eligibility must not consume the entitlement.
- Redemption must require authenticated vendor authorization.
- Redemption must use database transaction safety.
- Database constraints must prevent duplicate successful redemptions.
- Different vendors racing to redeem the same entitlement must not both succeed.
- Successful redemption must be attributed to exactly one vendor.
- Request retries must be idempotent.

## 4. Development Workflow

For every implementation task:

1. Read relevant documentation and inspect the repository.
2. Identify dependencies, affected modules and tests.
3. Present a concise implementation plan.
4. Obtain approval before changing business rules, database schema, external API contracts or security-sensitive behavior.
5. Create a feature branch from the latest staging, preserving any uncommitted changes.
6. Implement only the agreed scope.
7. Add or update automated tests.
8. Run repository lint, typecheck, build and relevant tests.
9. Review the diff and update affected documentation.
10. Create a Pull Request targeting staging only when GitHub access is available and authorized.
11. Wait for human review and merge.

Never implement directly on staging or main.

## 5. Required Database Safety

The Agent must:

- Use transaction-safe activation sequencing.
- Use transaction-safe redemption.
- Define unique constraints for activation and redemption invariants.
- Add concurrency tests against PostgreSQL.
- Use migrations for schema changes.
- Preserve historical redemption and audit records.
- Ensure failed transactions do not partially update eligibility or reporting data.

Do not implement a read-check-write redemption flow without concurrency control.

## 6. Forbidden Actions

Never:

- Automatically merge PRs.
- Force-push to protected branches.
- Deploy production without explicit approval.
- Reset existing production data.
- Delete redemption history to fix inconsistencies.
- Change the 1,000-person limit without approval.
- Allow a second successful redemption for the same entitlement.
- Trust frontend-provided activation order.
- Trust frontend-provided redemption status.
- Disable tests, authentication or authorization for convenience.
- Commit secrets or raw QR credentials.
- Claim tests passed when they were not executed.

## 7. Definition of Done

A change is complete only when:

- The relevant PRD acceptance criteria are satisfied.
- Relevant business invariants are preserved.
- Required database migrations are included.
- Unit and integration tests pass.
- Concurrency tests pass when activation or redemption logic changes.
- Authorization and security have been reviewed.
- Documentation is up to date.
- A feature branch or reviewable PR is ready.

## 8. Final Report

Every completed task must report:

- Implemented features.
- Changed files.
- Database migrations.
- API changes.
- Tests executed and results.
- Security or concurrency considerations.
- Known limitations.
- Branch and PR status.
- Decisions still requiring human approval.

The Agent must not declare business invariants verified without supporting tests.
