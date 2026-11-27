# NEON ↔ CARBON Cross-Backend Contract Compatibility Audit

- **CARBON Branch Audited:** `carbon/full-backend-audit` (base `09847c5`, Sessions `01..06`)
- **NEON Branches Inspected (Read-Only):**
  - Integrated on `carbon/*` (`Cycle 01` `9d7cd2c`, `Cycle 02` `349fe69`)
  - Remote NEON branches (`origin/neon/dynamic-ecosystem-engine`, `origin/neon/world-event-director`, `origin/neon/invasion-siege-engine` @ `6610f4e`)
- **Go Compiler on Current CARBON Host:** Not installed (`GO_NOT_AVAILABLE_ON_HOST` — Go test suites verified via `.github/workflows/ci.yml` definition and read-only source inspection; **never claimed as executed locally**).

---

## 1. End-to-End Contract Compatibility Matrix

| Contract / Schema | Producer | Consumer | Version | CARBON Implementation | NEON Implementation (`6610f4e`) | Real Tests | Compatibility Status | Pending Alignment / Owner |
|---|---|---|---|---|---|---|---|---|
| `SettlementSnapshot` (`settlement-snapshot.v1.schema.json`) | **CARBON** | **NEON** (`ports.SettlementReader`) | `v1` | `PostgresSettlementSnapshotReader` (`settlement-snapshot-query.ts`) | `ports.SettlementSnapshot` (`internal/ports/carbon.go`) + memory fake | CARBON PG integration + Zod/JSON Schema parity | **Compatible** (`max_defense_hp` decimal string -> Go `int64` adapter needed) | Wire transport adapter (**Joint NEON ↔ CARBON**) |
| `ContributionResult` (`contribution-result.v1.schema.json`) | **NEON** (`ports.ContributionSink`) | **CARBON** | `v1` | `RecordContributionService` (`record`, `recordFromWireJson`, `recordStrictPortSemantics`) | `ports.ContributionResult` (`internal/ports/carbon.go`, unchanged through Cycle 05!) | CARBON PG + lossless `int64`/`uint64` + duplicate key rejection | **Compatible** (`Outcome: "Defended" \| "Captured"`, `Withdrawn -> Defended` in Cycle 05) | Wire transport & retry ack (**Joint**) |
| `SettlementCaptured` / `SettlementLiberated` (`contracts/events/*.v1.schema.json`) | **NEON** (World Event / Siege Director) | **CARBON** (`SettlementEventHandler`) | `v1` | `SettlementEventHandler` (`settlement-event-handler.ts`) | Proposed mapping in `NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md` & `NEON_SIEGE_CONTRACT_PROPOSAL.md` | CARBON PG integration | **Partial — Lifecycle Gap Identified** (see Section 2.1) | Add `SettlementThreatened` / `SettlementInvasionStarted` & `SettlementDefended` (**CARBON + NEON**) |
| `CharacterSnapshotV1` (`character-snapshot.v1.schema.json`) | **CARBON** | **NEON** (future combat/PvP/Ranked) | `v1` (`Proposed`) | `PostgresCharacterSnapshotReader` (`REPEATABLE READ`) | Not yet consumed in Go (`Cycle 01..05` are AI/Ecosystem/Siege) | CARBON PG + Zod/JSON Schema parity | **Ready Proposal** (excludes `accountId` by default) | Combat bootstrap port in Go (**NEON + CARBON**) |
| `EquipmentSnapshotProposalV1` (`equipment-snapshot.v1.schema.json`) | **CARBON** | **NEON** (future combat) | `v1` (`Proposed`) | `PostgresEquipmentSnapshotReader` + `EquipmentSnapshotWireV1Schema` [Hardened] | Not yet consumed in Go | CARBON PG + Zod/JSON Schema parity | **Ready Proposal** (suppresses broken & post-respec ineligible gear) | Combat stat formula agreement (**Joint**) |
| `SocialStandingSnapshotV1` (`social-standing-snapshot.v1.schema.json`) | **CARBON** | **NEON** (NPC guards, safe zones, titles) | `v1` (`Proposed`) | `PostgresSocialSnapshotReader` (4 privacy scopes) | Not yet consumed in Go | CARBON PG + privacy scope tests | **Ready Proposal** | Guard enforcement hook (**Joint**) |
| `AbilitySnapshotV1` (`ability-snapshot.v1.schema.json`) | **CARBON** | **NEON** (future combat skills) | `v1` (`Proposed`) | `PostgresAbilitySnapshotReader` + `assertConsistentCombatSnapshots` | Not yet consumed in Go | CARBON PG + build-version cross-check | **Ready Proposal** (`gameplay_effect_reference` catalog IDs) | Combat frame/cooldown execution in Go (**NEON**) |

---

## 2. Key Cross-Language Findings & Integration Gaps

### 2.1 Settlement Pre-Conflict State Transition Gap (`peaceful` -> `threatened` / `under_attack`)
- **Fact Confirmed in Code:**
  - `Settlement.applyCapture` (`src/modules/settlements/domain/settlement.ts:72-76, 157-161`) requires the settlement to be in `threatened`, `under_attack`, or `occupied` (rejecting direct capture from `peaceful`).
  - `SupportedNeonSettlementEventV1Schema` (`src/shared/contracts/world-events.ts:48-51`) currently handles only `SettlementCaptured` and `SettlementLiberated`.
  - In `origin/neon/world-event-director` and `origin/neon/invasion-siege-engine`, NEON explicitly noted this pre-condition (`NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md`, Section 1.3 & 3.1) and proposed emitting `SettlementThreatened` / `SettlementInvasionStarted` and `SettlementDefended`, plus mapping string slugs (`settlement-valewatch`, `faction-ironfang-orcs`, `out:sim-01:000001`) to UUIDv5 or `external_id` at the Go -> CARBON adapter boundary.
- **Impact:** Until CARBON adds handlers for `SettlementThreatened` / `SettlementInvasionStarted` (and `SettlementDefended`) or accepts `external_id` slugs in world event envelopes alongside UUIDs, a peaceful settlement in CARBON cannot transition automatically to `threatened`/`under_attack` from NEON's campaign warning alone.
- **Assigned Owner:** Joint NEON ↔ CARBON integration session (non-blocking for Session 07 Economy, which consumes `ContributionRecorded` and persistent item/character ledgers).

### 2.2 64-Bit Integer Wire Precision & Duplicate Key Hardening
- **Fact Confirmed in Code:** Go `encoding/json` serializes `int64`/`uint64` fields in `ports.ContributionResult` (`Tick uint64`, `Damage int64`, `Support int64`, `Objectives int64`) as bare JSON numbers unless a custom marshaler or wire DTO is used. JavaScript `JSON.parse` corrupts bare integers above `2^53 - 1` (`9007199254740991`).
- **CARBON Protection Verified:** `decodeWireJsonLossless` (`src/shared/contracts/int64-wire.ts`) quotes integer literals outside `±9007199254740991` prior to `JSON.parse`, rejects payloads `> 64 KiB`, and (after `CARBON-AUD-005`) rejects duplicate JSON object keys at all depths. Furthermore, after `CARBON-AUD-008`, all 6 JSON Schemas in `contracts/neon-carbon/*.v1.schema.json` enforce exact decimal bounds (`MAX_INT64 = 9223372036854775807`, `MIN_INT64 = -9223372036854775808`, `MAX_UINT64 = 18446744073709551615`), matching Zod 100%.

### 2.3 Duplicate Contribution Retry Semantics (`ErrDuplicateContribution` vs Idempotent Replay)
- **Fact Confirmed in Code:** NEON's in-memory fake (`internal/adapters/memory/contribution_sink.go`) returns `ports.ErrDuplicateContribution` on duplicate `event_id`, whereas distributed *at-least-once* batch retries benefit from idempotent acknowledgement on identical payload fingerprints.
- **CARBON Support:** `RecordContributionService` provides **both** `record()` / `recordFromWireJson()` (returning `{ status: "duplicate_idempotent" }` on matching SHA-256 canonical fingerprint, throwing `InboxIdempotencyConflictError` on mutated payload) AND `recordStrictPortSemantics()` (raising `DuplicateContributionError` to match Go's in-memory fake).

### 2.4 Opaque `PlayerID` vs Persistent `CharacterID`
- **Fact Confirmed in Code:** NEON emits opaque `player_id` strings (`ContributionResult.PlayerID`). CARBON never guesses or matches by `displayName`; `SocialEngineService.recognizeEligibleContribution` resolves `(source_namespace, external_subject_id) -> character_id` strictly through `external_identity_links` (`link_status = 'active'`).

### 2.5 Combat Snapshot Consistency (`BuildVersion` Torn-Read Prevention)
- **Fact Confirmed in Code:** Each individual snapshot reader (`CharacterSnapshotV1`, `EquipmentSnapshotProposalV1`, `AbilitySnapshotV1`) executes inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. However, querying the three snapshots in separate transactions during a concurrent `equipItem` or `learnAbility` can yield mismatched `buildVersion`s.
- **CARBON Guard:** `assertConsistentCombatSnapshots` (`src/modules/skills/application/ability-snapshot-query.ts`) verifies `characterSnapshot.buildVersion === equipmentSnapshot.buildVersion === abilitySnapshot.buildVersion` and matching `normalizationProfile`, throwing `CharacterBuildConflictError` so NEON never initializes a match with half-old equipment and half-new abilities.

### 2.6 Documented Catalog Divergence: `relic` (*Relíquia*) vs *Divino*
- **Fact Confirmed in Code:** Initial high-level design notes mentioned a 7th rarity named *Divino*, whereas Session 04 (`migrations/0006_item_catalog_rarities_and_affixes.up.sql:21`, `equipment-snapshot.v1.schema.json:97`) persisted the 7th tier as `'relic'` (*Relíquia*).
- **Audit Action:** Preserved `'relic'` untouched to avoid breaking persistent `CHECK` constraints and published schemas (`CARBON-AUD-011`); flagged for joint product/NEON decision if display localization or a future v2 alias is desired.
