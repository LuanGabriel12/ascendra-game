# CARBON Database Integrity, Concurrency, Lock Ordering & Growth Audit

- **Branch Audited:** `carbon/full-backend-audit`
- **Migrations Audited:** `0001` through `0011` (Sessions `01..06`) + Corrective Incremental Migration `0012_audit_hardening_triggers_constraints_and_indexes`
- **Database Engine:** PostgreSQL (`16-alpine` in CI; `embedded-postgres` native PostgreSQL locally)

---

## 1. Migration Immutability & Lifecycle Audit (`0001..0012`)

| Version | Name | Session | Backfill / Legacy Safety | Rollback (`.down.sql`) | Audit Verdict |
|---|---|---|---|---|---|
| `0001` | `carbon_settlement_slice` | S01 | Base schema (`factions`, `settlements`, `settlement_history`, `processed_events`, `outbox_events`) | Clean reverse FK drop | Verified |
| `0002` | `settlement_snapshot_and_inbox_fingerprint` | S02 | Preserves legacy `payload_fingerprint IS NULL`; backfills `external_id`, `defense_state`, `max_defense_hp` | Restores `0001` columns cleanly | Verified |
| `0003` | `gameplay_contributions` | S02 | `NUMERIC(20,0)` `uint64` tick (`0..18446744073709551615`), `BIGINT` metrics, `UNIQUE(simulation_id, invasion_id, player_id)` | Clean drop | Verified |
| `0004` | `peoples_catalog_and_progression_rules` | S03 | Catalogs (`playable_peoples`, `lineages`, `cultures`, `backgrounds`, `progression_rules`) | Clean drop | Verified |
| `0005` | `accounts_characters_attributes_and_progression` | S03 | Enforces `allocated + unspent = earned`, `UNIQUE(canonical_name)`, `experience_grants` | Clean drop | Verified |
| `0006` | `item_catalog_rarities_and_affixes` | S04 | Immutable `(definition_code, definition_version)` PK, 7 rarities (`common..relic`), affix coherence | Clean drop | Verified |
| `0007` | `inventories_instances_loadouts_and_ledger` | S04 | Backfills 40-slot bag & `'Principal'` active loadout; partial unique indexes; trigger had `READ COMMITTED` race (`CARBON-AUD-003`) | Clean drop | Hardened in `0012` |
| `0008` | `social_standing_fame_reputation_and_identity_links` | S05 | Backfills `social_regions` & neutral `character_social_standing` | Clean drop | Verified |
| `0009` | `criminality_bounties_titles_and_world_history` | S05 | Enforces funded-active bounty check, single claim `UNIQUE(bounty_id)`, non-self/non-same-account `CHECK` | Clean FK drop + tables | Verified |
| `0010` | `combat_schools_abilities_and_specialization_trees` | S06 | Versioned `(ability_code, ability_version)` PK, 22+1 weapon families, slot-group checks | Clean drop | Verified |
| `0011` | `character_mastery_skills_loadouts_and_history` | S06 | Backfills `character_specialization_points` (`6 + (level - 1)`); enforces `spent + unspent = earned` | Clean drop | Verified |
| `0012` | `audit_hardening_triggers_constraints_and_indexes` | Audit | Adds `FOR UPDATE` container lock in `fn_enforce_container_slot_integrity()` + 4 composite indexes | Restores `0007` fn & drops indexes | **Added & Verified** |

### Migration Runner Hardening (`CARBON-AUD-010`)
- **Advisory Lock:** `pg_advisory_lock(84291001)` verified under 3-way concurrent `Promise.all([migrateUp, migrateUp, migrateUp])` against an empty database (`tests/integration/audit-recovery-migrations-and-property-fuzz.test.ts`).
- **SHA-256 Checksum Guard:** `migrator.ts` now stores LF-normalized SHA-256 checksums of `.up.sql` in `schema_migrations.checksum_sha256` (backfilling `NULL` legacy rows transparently) and throws `MigrationChecksumMismatchError` if any applied migration file is edited retroactively on disk.
- **Transactional Atomicity:** Each migration executes inside `BEGIN ... COMMIT` (PostgreSQL transactional DDL); an induced failure mid-migration leaves zero partial tables or `schema_migrations` entries.

---

## 2. Critical Database Concurrency Finding Resolved (`[CARBON-AUD-003]`)

- **Severity:** `P1` High (Cross-table container slot exclusivity race condition).
- **Location:** `migrations/0007_inventories_instances_loadouts_and_ledger.up.sql` (`fn_enforce_container_slot_integrity()`).
- **Proof of Failure (Pre-Fix):** Using two independent PostgreSQL connections (`clientA` and `clientB`) under `READ COMMITTED`, `clientA` updated an `item_instance` into `slot = 25` while `clientB` concurrently updated an `inventory_stack` into `slot = 25` before `clientA` committed. Because `fn_enforce_container_slot_integrity()` read `inventory_containers` without `FOR UPDATE`, neither transaction saw the other's uncommitted sibling-table row, and **both transactions committed**, placing an equipment instance and a material stack into the exact same container slot!
- **Fix (`migrations/0012_audit_hardening_triggers_constraints_and_indexes.up.sql`):** Updated `fn_enforce_container_slot_integrity()` to `SELECT capacity, owner_character_id INTO v_capacity, v_owner FROM inventory_containers WHERE id = NEW.container_id FOR UPDATE;` in both branches. Now `clientB` blocks on the `inventory_containers` row lock until `clientA` commits (or rolls back), then sees `clientA`'s committed row and deterministically raises `SQLSTATE 23505`.

---

## 3. Global Lock Acquisition Ordering Map (Deadlock Prevention)

All CARBON transactional Units of Work (`READ COMMITTED` for mutations; `REPEATABLE READ READ ONLY` for multi-table combat/social snapshots) follow a deterministic hierarchy:

```text
1. Target Character(s)        -> characters FOR UPDATE (sorted ascending by UUID when 2 characters involved, e.g. transferItemInstance, adjustMoralBounty, claimCriminalBounty, grantWeaponMasteryExperience)
2. Owning Account(s)          -> accounts FOR UPDATE (sorted ascending by UUID when 2 accounts involved)
3. Transactional Inbox        -> INSERT INTO processed_events ... ON CONFLICT DO NOTHING
4. Primary Containers/Loadout -> inventory_containers FOR UPDATE (sorted by owner UUID), equipment_loadouts FOR UPDATE
5. Domain Sub-Aggregates      -> item_instances FOR UPDATE (sorted ascending by UUID on loadout swaps)
                              -> inventory_stacks FOR UPDATE (sorted ascending by UUID in lockStacksInCanonicalOrder)
                              -> character_specialization_points / masteries / unlocks / learned_abilities FOR UPDATE
                              -> character_social_standing -> character_regional_standing -> character_reputations (sorted ascending by target_faction_id on propagation) -> character_jurisdiction_status FOR UPDATE
6. Append-Only Ledgers/Outbox -> item_grants / item_operation_ledger / social_standing_ledger / character_skill_history / outbox_events (pure INSERT, no backward lock edges)
```

> **Note on `claimCriminalBounty`:** Locks `criminal_bounties FOR UPDATE` first (serializing competing bounty hunters immediately on the contested bounty row), then locks `[claimantCharacterId, targetCharacterId].sort()` in canonical ascending UUID order. Because no other operation locks `characters` first and then locks `criminal_bounties` (`createCriminalBounty` only `INSERT`s a new bounty row), there is no lock-inversion cycle.

---

## 4. PostgreSQL `NUMERIC(20,0)` Rounding Check (Section 9)

- PostgreSQL `NUMERIC(20,0)` **rounds** fractional inputs (`10.6::numeric(20,0)` becomes `11`, which would pass `scale(simulation_tick) = 0` if raw floats reached SQL!).
- **Verification:** `PostgresContributionUnitOfWork.insertContribution` binds `contribution.tick.toString()` (a `bigint`), and `Uint64Schema` (`src/shared/contracts/int64-wire.ts`) strictly rejects non-integer JS numbers (`!Number.isInteger(val)`) and non-digit strings (`CANONICAL_UNSIGNED_DECIMAL_RE`) **before** any SQL statement is constructed. Tested explicitly with `"damage": 12.5` and `"tick": "10.5"` (`tests/unit/audit-contracts-procedural-and-invariants.test.ts`).

---

## 5. Transactional Outbox & Unbounded Table Growth Audit (Sections 19 & 28)

### Append-Only / Unbounded Tables Identified
1. `processed_events` (Transactional Inbox — idempotency barrier)
2. `outbox_events` (Transactional Outbox — integration events)
3. `gameplay_contributions` (Authoritative NEON invasion contributions)
4. `experience_grants` (Character XP provenance)
5. `character_build_history` (Attribute & respec audit trail)
6. `item_grants` (Loot/reward provenance & boss slot deduplication)
7. `item_operation_ledger` (Immutable item/stack movement ledger)
8. `social_standing_ledger` (MoralBounty, Fame, Reputation, Crime, Bounty ledger + anti-abuse window)
9. `criminal_records` & `historical_social_records` & `character_title_history`
10. `mastery_experience_grants` & `character_specialization_point_grants` & `character_skill_history`

### Fixes Applied in This Audit (`CARBON-AUD-009`)
- Added `idx_outbox_events_aggregate_created ON outbox_events(aggregate_id, created_at ASC)` (eliminating sequential scans on per-aggregate outbox queries).
- Added `idx_item_operation_ledger_counterparty ON item_operation_ledger(counterparty_character_id, ledger_seq ASC) WHERE counterparty_character_id IS NOT NULL` (enabling `BitmapOr` index scan on `character_id = $1 OR counterparty_character_id = $1` instead of full table scan).
- Added `idx_criminal_bounties_target_status ON criminal_bounties(target_character_id, status)`.
- Added `idx_processed_events_aggregate_processed ON processed_events(aggregate_id, processed_at DESC)`.
- Added bounded `LIMIT` pagination (`default 1000, max 5000`) to `PostgresInventoryRepository.listCharacterLedger` and `LIMIT 200` to `evaluateCharacterContextualRecognition` `historical_social_records`.

### Mandatory Requirements for Future Outbox Worker & Retention Policy
- **Outbox Relay Worker (Not Yet Implemented):** `outbox_events` currently guarantees **atomic persistence** alongside domain state, **not** network delivery. A future worker must poll `WHERE published_at IS NULL ORDER BY occurred_at ASC FOR UPDATE SKIP LOCKED LIMIT N`, track `attempt_count`, `last_error`, `next_attempt_at`, and `dead_lettered_at` (poison-message quarantine), and guarantee **at-least-once** delivery to consumers that deduplicate by `id` / `causation_event_id`.
- **Dangerous Retention Anti-Pattern Warning:** **NEVER** purge `processed_events`, `item_grants`, `experience_grants`, `mastery_experience_grants`, or future monetary `ledger_entries` via naive TTL deletion — deleting idempotency keys allows delayed transport retries to **re-grant items, XP, or currency**. Long-term scaling should use monthly range partitioning on `recorded_at` / `occurred_at` only for pure non-idempotency history tables (`outbox_events` where `published_at IS NOT NULL` and older than retention window), while keeping authoritative grant/idempotency keys permanently indexed or archived with active key tombstones.
