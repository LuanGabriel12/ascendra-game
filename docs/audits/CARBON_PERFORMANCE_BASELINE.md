# CARBON Performance Baseline & Query Plan Audit (Sessions 01–06)

- **Branch Audited:** `carbon/full-backend-audit` (including corrective migration `0012`)
- **Host Hardware:** AMD Ryzen 7 5700X (8 Cores / 16 Logical Processors), `31.93 GB` RAM, Windows 10 (`10.0.19045`), local NVMe SSD
- **Runtime:** Node.js `v24.22.3`, TypeScript `7.0.2`, `pg 8.23.1` (`max: 12` local pool)
- **Database Engine Measured Locally:** `PostgreSQL 19.0 on x86_64-windows, compiled by msvc-19.44.35230, 64-bit` (`embedded-postgres 19.0.0-beta.20` bound to `127.0.0.1`)
- **Background Cardinality Pre-Seeded Before Measurement:** `10,000` accounts, `10,000` characters, `10,000` `character_attributes` & `character_appearance` rows, `10,000` `character_social_standing` rows, and `15,000` `item_operation_ledger` rows (`ANALYZE` executed prior to timing).
- **Process Memory at Benchmark Completion:** `RSS = 135.1 MB`, `Heap Used = 43.4 MB`.

> **Methodological Disclaimer:** Single-host loopback benchmarks measure local SQL execution plans, serialization overhead, and lock discipline. They do **not** prove multi-thousand concurrent player capacity over WAN networks, cloud IOPS limits, or multi-replica connection pool contention.

---

## 1. Operation Latency (`p50` / `p95` / `p99`) & Throughput Baseline

| Engine & Operation | Samples | `p50` (ms) | `p95` (ms) | `p99` (ms) | Sequential Throughput (ops/s) | SQL Roundtrips / Tx Profile |
|---|---:|---:|---:|---:|---:|---|
| `Inventory.generateProceduralItem` (pure CPU) | `10,000` | `0.009` | `0.020` | `0.032` | `87,145.4` | `0` (pure integer `SplitMix64Rng`) |
| `Character.createCharacter` | `60` | `3.307` | `39.413` | `76.781` | `122.8` | ~14 statements (`BEGIN..COMMIT`, account lock, inbox, 4 catalog reads, 3 inserts, history, outbox) |
| `Character.grantExperience` | `60` | `2.108` | `2.707` | `6.450` | `445.0` | ~8 statements (`BEGIN..COMMIT`, inbox, char lock, rules, update, grant row, outbox) |
| `Character.allocateAttributes` | `30` | `3.187` | `4.001` | `37.362` | `228.2` | ~10 statements (char+account lock, inbox, rules, update, history, 2 outbox) |
| `Character.getCharacterSnapshot` | `60` | `1.257` | `1.554` | `6.205` | `720.3` | 5 read-only statements (`REPEATABLE READ`) |
| `Inventory.grantProceduralEquipment` | `35` | `4.934` | `6.372` | `35.877` | `169.5` | ~13–16 statements (inbox, char lock, rules/def/rarity/affixes, container lock, instance + affixes + grant + ledger + outbox) |
| `Inventory.moveInventoryEntry` | `30` | `3.478` | `5.447` | `31.651` | `220.4` | ~10 statements (char+account lock, inbox, container lock, slot check, update + trigger, ledger, outbox) |
| `Inventory.equipItem` | `30` | `6.569` | `72.499` | `79.396` | `61.8` | ~16–20 statements (char+account+container+loadout+item locks, displaced bag return, slot replace, `build_version` bump, ledger, 2 outbox) |
| `Inventory.activateLoadout` | `30` | `6.389` | `7.314` | `8.038` | `152.6` | ~16–22 statements (canonical UUID item locking, active flag swap, `build_version` bump, ledger, 2 outbox) |
| `Inventory.transferItemInstance` | `20` | `5.462` | `7.502` | `7.533` | `172.9` | ~15 statements (2 chars + 2 accounts + 2 bags locked in UUID order, inactive-loadout purge, update, ledger, outbox) |
| `Inventory.getEquipmentSnapshot` | `50` | `1.474` | `1.634` | `2.278` | `669.7` | 5 + `2 * equippedCount` statements (`REPEATABLE READ`) |
| `Social.adjustReputation` | `40` | `3.458` | `4.490` | `44.047` | `217.5` | ~11 statements (inbox, char lock, rules, standing + rep lock/update, ledger, outbox, conditional title check) |
| `Social.recordAuthoritativeCrime` | `30` | `5.209` | `5.841` | `10.417` | `183.8` | ~15 statements (crime + auto-warrant + jurisdiction + regional + standing + ledger + 2 outbox + conditional titles) |
| `Social.getSocialStandingSnapshot` | `50` | `1.604` | `1.975` | `4.307` | `595.5` | 8 read-only statements (`REPEATABLE READ`) |
| `Skill.grantWeaponMasteryExperience` | `50` | `3.065` | `7.569` | `38.018` | `212.1` | ~10 statements (inbox, char lock, rules, mastery upsert, grant row, history, outbox) |
| `Skill.learnAbility` | `1` (cold) | `37.484` | `37.484` | `37.484` | `26.6` | ~15 statements (DAG + mastery + budget validation + `build_version` bump) |
| `Skill.equipAbility` | `1` (cold) | `39.286` | `39.286` | `39.286` | `25.4` | ~16 statements (weapon family & budget check + slot replace + `build_version` bump) |
| `Skill.getAbilitySnapshot` | `50` | `2.672` | `3.144` | `8.200` | `354.3` | 9 read-only statements (`REPEATABLE READ`) |

> **Observation on Windows `p99` Spikes (`35–79 ms`):** Tail spikes on write transactions correspond to synchronous PostgreSQL WAL `fsync` flushes on Windows NTFS (`synchronous_commit = on`, which must remain `on` for economic/item anti-duping durability). Read-only `REPEATABLE READ` snapshots consistently execute in **`1.2–2.7 ms` (`p50`)** and **`1.5–3.2 ms` (`p95`)** over a 10,000-character database.

---

## 2. `EXPLAIN (ANALYZE, BUFFERS)` Verification Over `10,000+` Rows

### 2.1 Item Operation Ledger (`character_id OR counterparty_character_id`) — Post-`0012` Index Fix
Before migration `0012`, `OR counterparty_character_id = $1` forced a **Sequential Scan** across all `15,000` ledger rows because `counterparty_character_id` had no index. After `0012`:
```text
Limit  (cost=19.77..19.78 rows=3 width=701) (actual time=0.558..0.559 rows=4.00 loops=1)
  Buffers: shared hit=8 dirtied=1 written=1
  ->  Sort  (cost=19.77..19.78 rows=3 width=701) (actual time=0.557..0.558 rows=4.00 loops=1)
        Sort Key: ledger_seq
        ->  Bitmap Heap Scan on item_operation_ledger  (actual time=0.552..0.555 rows=4.00 loops=1)
              Recheck Cond: ((character_id = $1) OR (counterparty_character_id = $1))
              ->  BitmapOr  (actual time=0.018..0.019 loops=1)
                    ->  Bitmap Index Scan on idx_item_operation_ledger_character  (actual time=0.014..0.014 rows=2.00 loops=1)
                    ->  Bitmap Index Scan on idx_item_operation_ledger_counterparty  (actual time=0.004..0.004 rows=2.00 loops=1)
Execution Time: 0.574 ms
```

### 2.2 Outbox Lookup by Aggregate (`aggregate_id`) — Post-`0012` Index Fix
```text
Sort  (cost=13.65..13.65 rows=3 width=202) (actual time=0.584..0.596 rows=380.00 loops=1)
  ->  Bitmap Heap Scan on outbox_events  (actual time=0.411..0.527 rows=380.00 loops=1)
        ->  Bitmap Index Scan on idx_outbox_events_aggregate_created  (actual time=0.013..0.013 rows=380.00 loops=1)
Execution Time: 0.617 ms
```

### 2.3 Top Global Fame Leaderboard (`10,070` Characters)
```text
Limit  (cost=0.29..2.38 rows=25 width=24) (actual time=0.010..0.014 rows=25.00 loops=1)
  ->  Index Only Scan using idx_character_social_fame_desc on character_social_standing  (actual time=0.009..0.013 rows=25.00 loops=1)
Execution Time: 0.022 ms
```

---

## 3. Identified Future Bottlenecks & Recommendations (Non-Blocking for S07)

1. **`N+1` Affix Reads in `PostgresInventoryRepository.listCharacterItems` (`src/modules/inventory/infrastructure/postgres-inventory-unit-of-work.ts:1186-1199`):** Loads affixes per item instance in a loop (`1 + K` queries for `K` items). Safe at `K <= 40` bag capacity, but should be batched with `WHERE item_instance_id = ANY($1::uuid[])` when guild/regional warehouses with hundreds of items are introduced.
2. **In-Memory Static Catalog Caching:** Immutable versioned definitions (`item_definitions`, `ability_definitions`, `progression_rules`, `item_generation_rules`, `social_rules_versions`) are currently queried from PostgreSQL inside each transaction (`~0.1 ms` per query locally, but `3–4` extra network roundtrips on remote RDS/Cloud SQL). An optional bounded TTL/versioned read-through cache can cut write transaction roundtrips by ~30% in production deployment.
