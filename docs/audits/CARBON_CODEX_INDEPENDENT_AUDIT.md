# CARBON — Independent Codex audit (partial)

- Base: c8f0a15f75f4987ff9841f6b48001f22e93dcc28.
- Gate: BLOCKED — REQUIRES FIXES. This is an interim record, not a completed independent audit.
- Worktree: carbon/codex-independent-audit. Existing NEON and original worktree were not modified.

## CI failure and repair

Run 46102815865 job 140848920409 used PostgreSQL 16.16. The migration lifecycle passed, but parallel test files shared ascendra_ci. Tests independently run destructive migration rollbacks, yielding missing relations, already existing relations and a deadlock. The external harness now creates a UUID-named database per context, uses the supplied safe database only as control connection, closes the context pool and drops only the generated database. The CI service user must have CREATEDB; the postgres image's initial user is a superuser. Within a context independent connections still share one database for concurrency tests. External restartAndReconnect cycles a pool, not the PostgreSQL server. The regression starts two contexts concurrently, checks independent migrations and data, rollback, reconnect, cleanup and the original control database. Unexpected process termination can leave a generated database behind.

## Snapshot fix

A regression first failed because equal-version snapshots with different normalization profiles were accepted. The checker now compares character/ability/equipment profiles and the active equipment/ability loadout ID. Character snapshot does not expose active loadout ID. Identity and version checks already existed. This does not establish that all mutation paths increment versions, or prove atomic snapshot collection; those need separate concurrent analysis.

## Prior findings status

The existing suite exercises each listed remediation but is not independent proof of complete coverage. Until broader adversarial review, 001–010 remain BLOCKED for independent classification:
- 001: active-loadout overwrite regression passes; alternate item and concurrent paths remain to audit.
- 002: cross-account replay regression passes; all authorities, revocation and replay semantics remain to audit.
- 003: two-connection item/stack regression passes locally; adversarial rollback, reverse ordering and PostgreSQL 16 remain to audit.
- 004: selected suspended, archived and ranked cases pass; all mutation paths remain to audit.
- 005: duplicate-key regression passes; hostile nesting and full wire boundaries remain to audit.
- 006: restricted-archive regression passes; all scopes and inference paths remain to audit.
- 007: selected replay mapping, seed and crime regressions pass; changed/deleted resource behavior remains to audit.
- 008: existing differential test uses a simplified schema helper; full 2020-12 conformance not established.
- 009: indexes exist in 0012; independent plans and pagination review remain.
- 010: checksum and migration concurrency tests pass locally; history backfill does not prove prior file integrity. Harness isolation is corrected locally, CI pending.
- 011: DOCUMENTED / JOINT DECISION: relic/Relíquia versus original Divino remains unresolved; no identifier migration.

## Unresolved financial and lock risks

A system-authority bounty creation can set escrow_committed using a nonblank textual funding_reference. A claim produces pending_economy_settlement, not a monetary payment. There is no verified reserve or ledger binding; the current code does not establish financial backing and legacy commitments must not be settled as funded. Restriction of active creation/claim has not yet been implemented or regression-tested. This is a gate blocker.

The previous reports propose conflicting lock hierarchies (characters before accounts versus accounts before characters). Existing code includes special ordering such as bounty-first and inbox-first paths; a complete graph, barrier tests and cycle analysis remain outstanding. Do not adopt either document as a proven global order. Inventory public service methods owning their transactions cannot simply be combined into an atomic bilateral economic exchange without a shared transaction scope.

## Validation and limits

- Local Node 24 / embedded PostgreSQL 19 beta: npm ci, typecheck, build, 67 tests passed, 0 failed, 0 skipped. The isolation and snapshot regressions passed. Five demos exited 0 individually.
- npm audit and npm audit --omit=dev reported 0 vulnerabilities with inherited NODE_TLS_REJECT_UNAUTHORIZED removed in those processes; npm strict-ssl was true. The inherited value was 0. No global setting was changed.
- PostgreSQL 16 remote validation of these changes, repeated full runs, Go checks, full coverage, broader lock/security review and complete 11-finding assessment remain pending.
- Migrations 0001–0012 were not edited. The original CI executed up/down/all/up in PG16 before tests. Local tests exercise lifecycle and checksum failure; this is not a full independent migration audit.
- No authentication/transport production readiness is asserted.

## Integration

Review the accumulated CARBON changes as a final secure head, with stacked PRs for review if useful, but do not merge intermediate heads containing known prior defects into main. Reconcile NEON contracts separately and avoid automatic merges. Session 07 is not approved.