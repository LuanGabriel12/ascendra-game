# CARBON Engineering Handoff — Full Backend Audit (Sessions 01–06 → Session 07 Economy)

- **Branch:** `carbon/full-backend-audit`
- **Base Commit:** `09847c5` (`carbon/skills-weapon-mastery-engine`)
- **Backup Ref:** `backup/carbon-pre-audit-s06` (`09847c5`)
- **Verdict:** **`READY WITH LIMITATIONS`** (Cleared to begin Session 07: *Economy, Trading, Loot & Crafting Engine*).

---

## 1. What Was Accomplished

1. **Full Code, Migration & Contract Inspection (`Sessions 01..06`, `0001..0011`, NEON `Cycles 01..05`):**
   - Verified separation of domain, application, and PostgreSQL Unit-of-Work layers across `factions`, `settlements`, `contributions`, `peoples`, `characters`, `inventory`, `social`, `titles`, and `skills`.
2. **Adversarial Defect Reproduction & Surgical Remediation (`CARBON-AUD-001`..`010`):**
   - **`P0` Fixed (`CARBON-AUD-001`):** Prevented `InventoryEngineService.saveInactiveLoadout` from overwriting active loadouts (`'Principal'` or activated presets), eliminating stranded `equipped_active` item corruption and `in_ranked_series` lock bypass.
   - **`P1` Fixed (`CARBON-AUD-002`):** Enforced ownership, active character, and active account checks **before** `claimOrVerifyEvent` across `SkillEngineService`, `CharacterEngineService`, `InventoryEngineService`, and `SocialEngineService.equipTitle` while preserving post-commit retry idempotency.
   - **`P1` Fixed (`CARBON-AUD-003`):** Added incremental migration `0012_audit_hardening_triggers_constraints_and_indexes` upgrading `fn_enforce_container_slot_integrity()` to lock `inventory_containers FOR UPDATE`, closing the cross-table `item_instances` vs `inventory_stacks` same-slot concurrency race.
   - **`P1` Fixed (`CARBON-AUD-004`):** Blocked suspended/closed accounts and `in_ranked_series` characters from transferring unbound items (`transferItemInstance`) or destroying items (`destroyItemInstance`).
   - **`P1` Fixed (`CARBON-AUD-005`):** Rejected duplicate JSON object keys (including `\uXXXX`-escaped keys) at all depths in `decodeWireJsonLossless`.
   - **`P1` Fixed (`CARBON-AUD-006`):** Excluded `restricted_archive` records from public NPC contextual recognition and filtered `public_limited` warrant summaries to publicly `Wanted`/`Fugitive` jurisdictions.
   - **`P2` Fixed (`CARBON-AUD-007`..`010`):** Fixed `grantStackableMaterial` duplicate replay row mapping & `23505` translation, fingerprinted `serverSeed` in `grantProceduralEquipment`, restored full crime/exemption fidelity on `recordAuthoritativeCrime` duplicate replay, aligned all 6 JSON Schemas with exact 64-bit integer decimal bounds (`EquipmentSnapshotWireV1Schema` added), added 4 missing composite indexes + ledger `LIMIT`, added SHA-256 migration checksum verification in `migrator.ts`, and restricted `postgres-test-harness.ts` to loopback hosts by default.
3. **New Adversarial Test Suites (`+14` tests -> `65/65` total across `13` suites):**
   - `tests/integration/audit-reproduction-and-security.test.ts`
   - `tests/integration/audit-recovery-migrations-and-property-fuzz.test.ts` (concurrent advisory-locked migrations, checksum tamper detection, pre-commit crash, post-commit lost-response retry, query timeout, pool saturation, DB restart, pardon-vs-crime race, and 80-step seeded conservation fuzzing)
   - `tests/unit/audit-contracts-procedural-and-invariants.test.ts` (6-schema Zod ↔ JSON Schema differential parity, `1k` + `10k` + `100k` procedural generation audit, test DB URL guard, Title AST security bounds)

---

## 2. Documented Limitations Explaining `READY WITH LIMITATIONS`

1. **Local Go Toolchain Absent (`GO_NOT_AVAILABLE_ON_HOST`):** Go simulation/port tests (`go test ./...`, `go test -race ./...`) could not be executed locally on this Windows host and rely on GitHub Actions (`neon-go` job).
2. **In-Process Boundary Only (No Network Auth Gateway or Outbox Relay Worker Yet):** `AuthorityPrincipal` must be populated by a verified authentication gateway before exposing CARBON over HTTP/gRPC, and a `FOR UPDATE SKIP LOCKED` Outbox relay worker with poison-message handling is required before live inter-process NEON ↔ CARBON event streaming.
3. **Joint NEON ↔ CARBON Contract Items Pending:**
   - Pre-capture world events (`SettlementThreatened` / `SettlementInvasionStarted` and `SettlementDefended`) proposed by NEON Cycles 04–05 need joint handler registration so peaceful settlements transition to `threatened`/`under_attack` automatically.
   - Confirm whether `'relic'` (*Relíquia*) remains the canonical 7th rarity identifier or aliases *Divino* in UI localization.
4. **Local `embedded-postgres` (`PG 19.0 beta`) vs CI (`postgres:16-alpine`):** Validated locally on PostgreSQL 19.0; push to GitHub Actions is required to confirm the identical green run on `postgres:16-alpine`.

---

## 3. Safe Publication Commands (Do Not Force-Push)

```powershell
# Publish Session 06 (if not yet pushed) and the Full Backend Audit branch:
git push -u origin carbon/skills-weapon-mastery-engine
git push -u origin carbon/full-backend-audit
```
