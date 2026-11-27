# ASCENDRA — CARBON Full Backend Engineering Audit Report (Sessions 01–06)

- **Audit Branch:** `carbon/full-backend-audit`
- **Base Commit Audited:** `09847c5` (`carbon/skills-weapon-mastery-engine`, integrating Sessions `01` through `06`)
- **Backup Reference Created Pre-Edit:** `backup/carbon-pre-audit-s06` -> `09847c5`
- **Audit Date:** `2026-11-27`
- **Final Classification:** **`READY WITH LIMITATIONS`** *(Approved to advance to Session 07 Economy Engine; zero open `P0` or `P1` defects; non-blocking host/transport/integration limitations explicitly documented below).*

---

## 1. Executive Summary

This audit suspended feature development to perform an adversarial, code-and-database-level review of all six CARBON backend engineering sessions (`01..06`, SQL migrations `0001..0011`, 6 cross-language NEON–CARBON contracts, and 10 existing test suites).

Rather than trusting documentation or green CI, every SQL trigger, Unit of Work, service command, idempotency path, competitive lock, and JSON/Zod boundary was inspected and attacked with reproducing PostgreSQL tests. **Eleven real findings (`1 P0`, `5 P1`, `4 P2`, `1 P3`)** were identified:
- **All `1 P0`, `5 P1`, and `4 P2` integrity/security/contract/performance findings (`CARBON-AUD-001` through `CARBON-AUD-010`) were first reproduced as failing tests against real PostgreSQL and then surgically fixed**, raising the suite from `51` tests (`10` suites) to **`65` tests (`13` suites, `65` passed, `0` failed, `0` skipped)** and increasing line coverage from `93.57%` (`75.70%` branches) to **`94.25%` (`77.45%` branches, `93.09%` functions)**.
- Historical migrations `0001..0011` and NEON Go files were **preserved 100% untouched**; database trigger and index fixes were delivered via incremental migration `0012_audit_hardening_triggers_constraints_and_indexes`.

---

## 2. Scope & Feature Reality Classification (Section 4)

| Session & Bounded Context | Declared Scope | Actual Status Verified in Code & DB | Classification |
|---|---|---|---|
| **S01 — Settlements & Factions** (`factions`, `settlements`) | Authoritative lifecycle FSM, optimistic `version`, `settlement_history`, Inbox/Outbox | Implemented & tested on real PostgreSQL (`0001`) | **Implemented & Tested** |
| **S02 — Contribution Engine** (`contributions`, `SettlementSnapshot`) | `ports.ContributionResult` ingestion, lossless `int64`/`uint64` wire parser, canonical SHA-256 fingerprints, legacy `NULL` fingerprint guard | Implemented & hardened (`0002..0003`, duplicate JSON keys fixed in `CARBON-AUD-005`) | **Implemented & Tested** |
| **S03 — Character Engine** (`peoples`, `characters`) | 26 planned peoples (`10` enabled, `16` disabled), decoupled lineages/cultures/origins, NFC/NFKD naming, 10 attributes (`allocated + unspent = earned`), quadratic XP, respec, `CharacterSnapshotV1` | Implemented & hardened (`0004..0005`, suspended-account & pre-auth inbox fixed in `CARBON-AUD-002`/`004`) | **Implemented & Tested** |
| **S04 — Inventory & Equipment** (`inventory`) | Versioned `ItemDefinition`, 7 rarities (`common..relic`), deterministic `SplitMix64Rng` procedural rolls, 40-slot bag + 60-slot storage, stacks, 2H/1H loadouts, durability, bindings, transfers, `item_operation_ledger`, `EquipmentSnapshotProposalV1` | Implemented & hardened (`0006..0007` + `0012` trigger `FOR UPDATE` fix `CARBON-AUD-003` + active-loadout overwrite fix `CARBON-AUD-001`) | **Implemented & Tested** |
| **S05 — Social, Bounty & Titles** (`social`, `titles`) | Signed `MoralBounty` (11 bands + hysteresis), `Fame`, scoped `Reputations` (1-hop faction propagation), `Jurisdictions`, `Crimes`, `Warrants`, escrow-gated `CriminalBounties` (`pending_economy_settlement`), bounded declarative Title AST (`Permanent`/`Conditional`/`Exclusive`), `external_identity_links`, `SocialStandingSnapshotV1` | Implemented & hardened (`0008..0009`, `restricted_archive` & `duplicate_verified` crime replay fixed in `CARBON-AUD-006`/`007`) | **Implemented & Tested** |
| **S06 — Skills & Weapon Mastery** (`skills`) | 12 schools (`6` enabled), `28` versioned abilities, `22+1` weapon families (`1..100` mastery), specialization DAGs & point conservation (`spent + unspent = earned`), loadout slots (`0..31`), non-destructive `resetSpecialization`, `AbilitySnapshotV1`, `master_of_blades` v2 | Implemented & hardened (`0010..0011`, cross-account `duplicate_verified` leak fixed in `CARBON-AUD-002`) | **Implemented & Tested** |
| **Combat Execution / Active Cooldowns / Hitboxes** | Runtime gameplay simulation | Belongs exclusively to **NEON (Go)**; CARBON only persists definitions, learning, loadouts, and read-only snapshots | **Out of Scope CARBON (NEON Owner)** |
| **HTTP/gRPC Network Server, AuthN/JWT & Outbox Worker** | Production network transport & relay | Not yet implemented; services operate in-process with `AuthorityPrincipal` | **Not Production-Ready Without Gateway** |
| **Genesis Ranked Runtime** | Ephemeral competitive match builds | CARBON enforces **persistence isolation** (`assertNotGenesisContext`) and defines `EphemeralGenesisAbilityBuildV1` contract; match orchestration is not yet implemented | **Isolation Enforced / Contract Proposed** |

---

## 3. Baseline vs Post-Audit Environment & Metrics (Sections 5 & 32)

- **OS / CPU / Memory:** Windows 10 Home (`10.0.19045`), AMD Ryzen 7 5700X (8C/16T), `31.93 GB` total RAM (`21.39 GB` free at baseline).
- **Toolchain:** Node.js `v24.22.3`, npm `11.19.1`, TypeScript `7.0.2`.
- **PostgreSQL Version Divergence (`Section 24`):**
  - **Local Embedded Test Harness:** `embedded-postgres@19.0.0-beta.20` (`PostgreSQL 19.0 on x86_64-windows`).
  - **GitHub Actions CI (`.github/workflows/ci.yml`):** `postgres:16-alpine` (`PostgreSQL 16`).
  - **Impact:** All SQL DDL/DML in `0001..0012` uses standard PostgreSQL 14+ syntax (`CREATE OR REPLACE FUNCTION`, `FOR UPDATE`, partial `UNIQUE` indexes, `JSONB`, `BIGINT`, `NUMERIC(20,0)`), avoiding PG17+/19-only syntax so CI (`postgres:16-alpine`) remains 100% compatible.
- **Dependency Vulnerabilities (`npm audit`):**
  - `npm audit --omit=dev` (production `pg`, `zod`): **`0` vulnerabilities**.
  - `npm audit` (including dev `embedded-postgres`, `tsx`, `typescript`, `@types/*`): **`0` vulnerabilities**.

| Metric | Pre-Audit Baseline (`09847c5`) | Post-Audit (`carbon/full-backend-audit`) |
|---|---:|---:|
| Total Test Suites | `10` | **`13`** |
| Total Executed Tests | `51` (`51` pass, `0` fail, `0` skip) | **`65`** (`65` pass, `0` fail, `0` skip) |
| Go Tests on Current Host | Blocked (`go` binary absent on host) | Blocked locally (`GO_NOT_AVAILABLE_ON_HOST`; runs in GitHub Actions `neon-go` job) |
| V8 Line / Statement Coverage (All Files) | `93.57%` | **`94.25%`** |
| V8 Branch Coverage (All Files) | `75.70%` | **`77.45%`** |
| V8 Function Coverage (All Files) | `92.12%` | **`93.09%`** |
| `int64-wire.ts` Branch Coverage | `73.42%` | **`93.88%`** |
| `migrator.ts` Branch Coverage | `67.74%` | **`84.21%`** |

### Uncovered Critical Paths Explicitly Identified (Section 32)
- Defensive `rowCount === 0` fallback branches inside `Pg*TransactionScope` `update*` methods when `FOR UPDATE` row locks already serialized concurrent callers earlier in the same transaction (`postgres-character-unit-of-work.ts`, `postgres-social-unit-of-work.ts`).
- `processed-events-inbox.ts` lines `63–85`: theoretical UUIDv5 hash collision across two distinct `external_event_id`s (`2^-122` probability) and unreadable row race after `ON CONFLICT DO NOTHING`.
- Optional `beforeCommitHook` branches in methods not targeted by fault-injection hooks (`grantFame`, `equipTitle`, `upgradeAbilityRank`).

---

## 4. Complete Defect Registry (`P0` – `P3`)

| ID | Severity | File & Pre-Fix Lines | Summary of Defect | Post-Audit Status |
|---|---|---|---|---|
| `CARBON-AUD-001` | **`P0` Critical** | `src/modules/inventory/application/inventory-engine-service.ts:1526-1670` | `saveInactiveLoadout` could overwrite slots of an **active** loadout (by matching deterministic `loadoutId` after activation, or colliding on `'Principal'`), stranding `equipped_active` items without slots and bypassing `in_ranked_series` lock | **Fixed & Regression-Tested** |
| `CARBON-AUD-002` | **`P1` High** | `skill-engine-service.ts:806-2005`, `character-engine-service.ts:222-836`, `inventory-engine-service.ts:705-2327`, `social-engine-service.ts:2363-2387` | `claimOrVerifyEvent` / `duplicate_verified` ran **before** `assertOwnedByOrSystem`, leaking victim character skill/loadout data to third-party accounts on replay and exposing `commandId` existence via `InboxIdempotencyConflictError` | **Fixed & Regression-Tested** |
| `CARBON-AUD-003` | **`P1` High** | `migrations/0007_inventories_instances_loadouts_and_ledger.up.sql:182-246` | `fn_enforce_container_slot_integrity()` queried `inventory_containers` without `FOR UPDATE`, allowing concurrent `item_instances` + `inventory_stacks` transactions under `READ COMMITTED` to occupy the **same** container slot | **Fixed in Migration `0012` & Proven on 2 PG Connections** |
| `CARBON-AUD-004` | **`P1` High** | `character-engine-service.ts`, `inventory-engine-service.ts:2136-2377`, `social-engine-service.ts:2378` | Suspended/closed accounts and non-active or `in_ranked_series` characters could still transfer unbound items out (`transferItemInstance`), destroy items, or mutate attributes/titles | **Fixed & Regression-Tested** |
| `CARBON-AUD-005` | **`P1` High** | `src/shared/contracts/int64-wire.ts:145-222` | `decodeWireJsonLossless` delegated to `JSON.parse` without rejecting duplicate JSON object keys (including `\uXXXX` escapes), allowing last-key-wins smuggling (`{"eligible":false,"eligible":true}`) | **Fixed & Regression-Tested** |
| `CARBON-AUD-006` | **`P1` High** | `social-engine-service.ts:2986-3085`, `social-snapshot-query.ts:493-510` | `evaluateCharacterContextualRecognition` included `visibility = 'restricted_archive'` records without `LIMIT` or Genesis guard; `public_limited` social snapshot did not filter active warrants by publicly `Wanted`/`Fugitive` jurisdiction status | **Fixed & Regression-Tested** |
| `CARBON-AUD-007` | **`P2` Moderate** | `inventory-engine-service.ts:240-252, 519-529, 613-637`, `social-engine-service.ts:986-1032` | `grantStackableMaterial` duplicate replay returned raw snake_case SQL rows cast as `InventoryStack[]` and missed `23505` catch on `uq_item_grants_boss_reward_slot`; `grantProceduralEquipment` omitted `serverSeed` from fingerprint; `recordAuthoritativeCrime` hardcoded `constitutedCrime: true, crimeRecord: null` on duplicate replay | **Fixed & Regression-Tested** |
| `CARBON-AUD-008` | **`P2` Moderate** | `contracts/neon-carbon/*.v1.schema.json`, `equipment-snapshot-query.ts`, `tests/helpers/json-schema-assertion.ts` | Static JSON Schemas accepted 19/20-digit overflows (`MAX_INT64 + 1`, `MAX_UINT64 + 1`) rejected by Zod, and `equipment-snapshot.v1.schema.json` lacked typed `specialEffects` items and runtime Zod `EquipmentSnapshotWireV1Schema` | **Fixed & Differential-Tested** |
| `CARBON-AUD-009` | **`P2` Moderate** | `migrations/0001..0011`, `postgres-inventory-unit-of-work.ts:1206` | Missing composite indexes on `outbox_events(aggregate_id, created_at)`, `item_operation_ledger(counterparty_character_id, ledger_seq)`, `criminal_bounties(target_character_id, status)`, and `processed_events(aggregate_id, processed_at)`, plus unbounded `listCharacterLedger` | **Fixed in Migration `0012` & Verified via `EXPLAIN ANALYZE`** |
| `CARBON-AUD-010` | **`P2` Moderate** | `src/shared/db/migrator.ts`, `tests/helpers/postgres-test-harness.ts:22-39` | `schema_migrations` lacked SHA-256 `.up.sql` tamper detection; `assertSafeTestDatabaseUrl` checked `_test`/`_ci` DB suffix without rejecting non-loopback remote hosts | **Fixed & Regression-Tested** |
| `CARBON-AUD-011` | **`P3` Low** | `README.md`, `docs/OWNERSHIP.md`, `migrations/0006` (`relic` vs *Divino*) | Root `README.md`/`OWNERSHIP.md` reflect Session 01 / Cycle 02 (left untouched on `carbon/*` to avoid merge conflicts with NEON); 7th item rarity persisted as `'relic'` (*Relíquia*) vs initial *Divino* naming note | **Documented (Joint Decision Item)** |

---

## 5. CI/CD, Repository Hygiene & Pull Request Integration Strategy (Sections 34–36)

### 5.1 CI/CD Audit (`.github/workflows/ci.yml`)
- Uses reproducible `npm ci`, Node.js `24`, `postgres:16-alpine` disposable service container with healthchecks, explicit `migrate:up -> migrate:down:all -> migrate:up` verification, `npm test`, `demo:session02..06`, and separate `neon-go` (`go vet`, `go build`, `go test`, `go test -race`, `go run ./cmd/sim`).
- No `continue-on-error: true` or masked exit codes; zero production secrets exposed (uses ephemeral CI-only `ascendra_ci_ephemeral_pw`).
- **Recommendation (`P3`):** Add explicit minimal `permissions: contents: read` at the workflow top level when updating `.github/workflows/ci.yml` in a future joint maintenance PR.

### 5.2 Repository Hygiene Audit
- **Secret Scan:** `git grep` across all tracked files confirmed **zero** leaked private keys, tokens, or real database credentials. `.gitignore` excludes `.env`, `.env.*`, `*.pem`, `*.key`, `node_modules/`, `dist/`, `.pgdata/`.
- **Preserved Artifacts:** `notebooks/Ascendra_Development.ipynb` and all NEON Go modules (`cmd/`, `internal/`, `go.mod`) are 100% intact.

### 5.3 Stacked Branch & Pull Request Strategy
Current CARBON branch ancestry forms a clean linear stack starting from `origin/main` (post-NEON Cycle 02):
1. `feature/carbon-initial-persistence` (Session 01)
2. `carbon/contribution-integration-engine` (`92f2732` — Session 02)
3. `carbon/character-progression-engine` (`8f39621` — Session 03)
4. `carbon/inventory-equipment-engine` (`6e0b843` — Session 04)
5. `carbon/reputation-bounty-titles-engine` (`ab54fae` — Session 05)
6. `carbon/skills-weapon-mastery-engine` (`09847c5` — Session 06, local)
7. `carbon/full-backend-audit` (Current audit & hardening branch)

**Recommended Review & Integration Sequence (No Force-Push, No Giant Monolithic Diff):**
- **Step A:** Publish `carbon/skills-weapon-mastery-engine` and `carbon/full-backend-audit` to `origin`.
- **Step B:** Open **stacked Pull Requests** (`S02 -> S01/main`, `S03 -> S02`, `S04 -> S03`, `S05 -> S04`, `S06 -> S05`, `Audit -> S06`) so reviewers can inspect each domain increment (`~2k–4k` lines per PR) rather than a single 6-session mega-PR, **merging `carbon/full-backend-audit` into `carbon/skills-weapon-mastery-engine` first (or before `main`)** so `main` never receives the pre-audit `P0`/`P1` defects (`CARBON-AUD-001`..`006`).
- **Step C (Conflict Avoidance with NEON Cycles 03–05):** NEON's remote branches (`origin/neon/invasion-siege-engine`) touch `cmd/`, `internal/`, `docs/siege/`, `docs/worldevents/`, `docs/ecosystem/`, `docs/OWNERSHIP.md`, and `README.md`. Because CARBON intentionally avoided editing `README.md`, `docs/OWNERSHIP.md`, and Go files during Sessions 03–06 and this audit, merging CARBON and NEON branches will have near-zero file conflicts.

---

## 6. Companion Audit Reports

- Security & Authorization Matrix: [CARBON_SECURITY_FINDINGS.md](./CARBON_SECURITY_FINDINGS.md)
- Database Integrity, Lock Map & Growth: [CARBON_DATABASE_INTEGRITY.md](./CARBON_DATABASE_INTEGRITY.md)
- Performance Baseline & `EXPLAIN ANALYZE`: [CARBON_PERFORMANCE_BASELINE.md](./CARBON_PERFORMANCE_BASELINE.md)
- NEON ↔ CARBON Contract Matrix: [CARBON_NEON_CONTRACT_COMPATIBILITY.md](./CARBON_NEON_CONTRACT_COMPATIBILITY.md)
- Session 07 Economy Readiness & Invariants: [CARBON_ECONOMY_READINESS.md](./CARBON_ECONOMY_READINESS.md)
- Engineering Handoff: [CARBON_AUDIT_HANDOFF.md](../handoff/CARBON_AUDIT_HANDOFF.md)
