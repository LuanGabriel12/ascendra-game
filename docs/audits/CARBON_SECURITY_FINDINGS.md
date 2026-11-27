# CARBON Security, Authorization & Boundary Findings (Sessions 01–06)

- **Branch Audited:** `carbon/full-backend-audit`
- **Base Commit:** `09847c5` (`carbon/skills-weapon-mastery-engine`, containing Sessions `01..06`)
- **Audit Scope:** Authorization enforcement, `AuthorityPrincipal` trust boundary, cross-account isolation, idempotency replay privacy, wire parser hardening, snapshot privacy, and competitive lock isolation.

---

## 1. Threat Model & Trust Boundary Honesty

> **CRITICAL PRODUCTION BOUNDARY WARNING:**
> CARBON currently operates as an **in-process modular TypeScript persistence engine** without a public HTTP/gRPC/WebSocket gateway, JWT/session verifier, mTLS peer authenticator, or rate-limiting proxy.
>
> `AuthorityPrincipal` (`authenticated_account` vs `internal_system_authority`) is an **application-layer capability token**, NOT a cryptographic authentication mechanism. Passing `npm test` in CI does **not** make CARBON safe to expose directly to untrusted network traffic. Before any network exposure, an authenticated transport adapter must derive `AuthorityPrincipal` exclusively from verified session credentials (for player actions) or mTLS/service-signed internal channels (for `internal_system_authority`), and **never** from client-supplied JSON fields or event `source` strings.

---

## 2. Permission Matrix Across Mutable Operations & Sensitive Queries

| Module / Operation | Character Owner (`authenticated_account`) | Third-Party Account (`authenticated_account`) | Suspended / Closed Account | `internal_system_authority` | Unauthenticated / Malformed Principal | Genesis Context (`genesis_ranked_md3_scratch`) |
|---|---|---|---|---|---|---|
| `SettlementEventHandler.handle` | N/A (internal event bus) | N/A | N/A | Allowed (trusted worker) | Must never be exposed publicly | N/A |
| `RecordContributionService.record*` | N/A (NEON sink) | N/A | N/A | Allowed (trusted NEON adapter) | Must never be exposed publicly | N/A |
| `CharacterEngine.createCharacter` | Allowed (own `accountId` only, cap <= 6) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) | Allowed | Rejected at boundary | **Rejected** (`GenesisTemporaryStatePersistenceForbiddenError`) |
| `CharacterEngine.allocateAttributes` | Allowed (if active & not `in_ranked_series`) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed (if not `in_ranked_series`) | Rejected | **Rejected** |
| `CharacterEngine.respecAttributes` | Allowed (via `RespecAuthorizationPolicy`, not `in_ranked_series`) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `CharacterEngine.grantExperience` | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** | **Rejected** | Allowed (validated sources only) | Rejected | **Rejected** |
| `CharacterEngine.updateAppearance` | Allowed (active account & char) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `InventoryEngine.grantProceduralEquipment` | **Rejected** (`ItemOwnershipForbiddenError`) | **Rejected** | **Rejected** | Allowed | Rejected | **Rejected** |
| `InventoryEngine.grantStackableMaterial` | **Rejected** (`ItemOwnershipForbiddenError`) | **Rejected** | **Rejected** | Allowed | Rejected | **Rejected** |
| `InventoryEngine.equipItem` / `unequipItem` / `activateLoadout` | Allowed (active & not `in_ranked_series`) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `InventoryEngine.saveInactiveLoadout` | Allowed on **inactive** presets only (not `in_ranked_series`) [Fixed] | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed on inactive presets | Rejected | **Rejected** |
| `InventoryEngine.moveInventoryEntry` / `splitStack` / `mergeStacks` | Allowed (active account & char) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `InventoryEngine.transferItemInstance` | Allowed (`unbound`, or `account_bound` same account; active sender & recipient; not `in_ranked_series`) [Fixed] | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed (subject to binding & active checks) | Rejected | **Rejected** |
| `InventoryEngine.destroyItemInstance` | Allowed (unequipped only; not `in_ranked_series`) [Fixed] | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `InventoryEngine.applyDurabilityLoss` / `repairItem` | **Rejected** (`ItemOwnershipForbiddenError`) | **Rejected** | N/A | Allowed | Rejected | **Rejected** |
| `SocialEngine.adjustMoralBounty` / `grantFame` / `adjustReputation` | **Rejected** (`SocialAuthorizationForbiddenError`) | **Rejected** | N/A | Allowed | Rejected | **Rejected** |
| `SocialEngine.recordAuthoritativeCrime` / `issueArrestWarrant` / `resolveCriminalStatus` | **Rejected** (`SocialAuthorizationForbiddenError`) | **Rejected** | N/A | Allowed | Rejected | **Rejected** |
| `SocialEngine.createCriminalBounty` / `claimCriminalBounty` | **Rejected** (`SocialAuthorizationForbiddenError`) | **Rejected** | N/A | Allowed (self/same-account claim blocked!) | Rejected | **Rejected** |
| `SocialEngine.unlockTitle` / `revokeTitle` | **Rejected** (`SocialAuthorizationForbiddenError`) | **Rejected** | N/A | Allowed | Rejected | **Rejected** |
| `SocialEngine.equipTitle` | Allowed (active account & char) | **Rejected** (`CharacterOwnershipForbiddenError`) | **Rejected** (`AccountInactiveError`) [Fixed] | Allowed | Rejected | **Rejected** |
| `SkillEngine.grantWeaponMasteryExperience` / `grantSpecializationPoints` | **Rejected** (`SkillAuthorizationForbiddenError`) | **Rejected** | N/A | Allowed | Rejected | **Rejected** |
| `SkillEngine.unlockSpecializationNode` / `learnAbility` / `upgradeAbilityRank` / `equipAbility` / `unequipAbility` / `saveLoadoutAbilities` / `resetSpecialization` | Allowed (active account & char; not `in_ranked_series`) | **Rejected** (`CharacterOwnershipForbiddenError`) [Replay Leak Fixed] | **Rejected** (`AccountInactiveError`) | Allowed | Rejected | **Rejected** |
| `CharacterSnapshotReader.getCharacterSnapshot` | Allowed (`includeAccountId: true` forbidden for non-system!) | **Rejected** (`CharacterOwnershipForbiddenError`) | Allowed (read-only) | Allowed | Rejected | Allowed ONLY as read-only template (`accountId` omitted) |
| `EquipmentSnapshotReader` / `AbilitySnapshotReader` | Allowed | **Rejected** (`CharacterOwnershipForbiddenError`) | Allowed (read-only) | Allowed | Rejected | **Rejected** (`GenesisTemporaryStatePersistenceForbiddenError`) |
| `SocialSnapshotReader.getSocialStandingSnapshot` | `self_character` & `public_limited` allowed | `public_limited` ONLY (`moralBounty`, `Suspected`, regional/faction reps redacted!) | `public_limited` | All 4 scopes (`internal_authorized`, `judicial_authority`) | Rejected | **Rejected** |

---

## 3. Detailed Security & Integrity Findings Resolved

### `[CARBON-AUD-001]` — `P0` Critical: Active Loadout Overwrite, Stranded `equipped_active` Item Corruption & `in_ranked_series` Bypass
- **Location:** `src/modules/inventory/application/inventory-engine-service.ts` (`saveInactiveLoadout`, pre-audit lines `1526–1670`).
- **Preconditions:** Any authenticated character owner who creates a named loadout (e.g. `"ArenaSet"`), activates it via `activateLoadout`, and subsequently calls `saveInactiveLoadout` with the same `loadoutName` (or `"Principal"`).
- **Evidence & Root Cause:** `saveInactiveLoadout` derived `loadoutId = deriveDeterministicEventUuid("loadout:" + characterId + ":" + loadoutName)` and executed `INSERT INTO equipment_loadouts ... VALUES ($1, $2, $3, FALSE, 1) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, preserving `is_active = TRUE` and replacing `equipment_loadout_slots` directly. It also lacked a `competitive_lock_state === 'in_ranked_series'` check.
- **Impact:**
  1. Bypassed `in_ranked_series` competitive build freeze on the active loadout.
  2. Permanently stranded previously equipped items in `location_state = 'equipped_active'` (`container_id = NULL`) with zero active slot references (preventing unequip, move, transfer, or destruction) while placing `in_container` items into active loadout slots without bumping `build_version`.
  3. Passing `"Principal"` triggered raw unhandled PostgreSQL `23505` on `uq_equipment_loadouts_character_name`.
- **Remediation:** Locked candidate rows by `(id = $2 OR name = $3) FOR UPDATE`, rejected any `is_active = TRUE` target or name collision with `LoadoutInvalidError`, and enforced `competitiveLockState !== 'in_ranked_series'`.
- **Post-Audit Status:** **FIXED & VERIFIED** (`tests/integration/audit-reproduction-and-security.test.ts`).

### `[CARBON-AUD-002]` — `P1` High: Cross-Account Idempotency Replay Information Disclosure & Pre-Auth Inbox Oracle
- **Locations:**
  - `src/modules/skills/application/skill-engine-service.ts` (`unlockSpecializationNode`, `learnAbility`, `upgradeAbilityRank`, `equipAbility`, `unequipAbility`, `saveLoadoutAbilities`, `resetSpecialization`)
  - `src/modules/characters/application/character-engine-service.ts` (`createCharacter`, `allocateAttributes`, `respecAttributes`, `updateAppearance`)
  - `src/modules/inventory/application/inventory-engine-service.ts` (`splitStack`, `mergeStacks`, `moveInventoryEntry`, `equipItem`, `unequipItem`, `saveInactiveLoadout`, `activateLoadout`, `transferItemInstance`, `destroyItemInstance`)
  - `src/modules/social/application/social-engine-service.ts` (`equipTitle`)
- **Preconditions:** Attacker (`authenticated_account` B) replays or guesses a `commandId` previously executed by Victim (`authenticated_account` A).
- **Evidence & Root Cause:** In all 7 player-mutable methods of `SkillEngineService`, `if (claim.status === "duplicate_verified") return ...` executed **before** `assertCharacterMutableByPrincipal` checked `character.assertOwnedByOrSystem(cmd.principal)`. In `CharacterEngineService`, `InventoryEngineService`, and `SocialEngineService.equipTitle`, `claimOrVerifyEvent` ran before ownership verification, leaking `InboxIdempotencyConflictError` on mismatched payloads instead of `CharacterOwnershipForbiddenError`.
- **Impact:** Unauthorized third-party accounts could read another player's learned abilities, specialization point balances, and loadout slots on matching replay, or probe `commandId` existence via error-type differentials.
- **Remediation:** Split authorization (`assertOwnedByOrSystem`, `assertActiveStatus`, `assertAccountActive`) from optimistic build state (`competitiveLockState`, `expectedBuildVersion`). Authorization now executes **strictly before** `claimOrVerifyEvent`, while optimistic version checks execute **after** `duplicate_verified` so legitimate post-commit retries by the true owner remain idempotent even after `buildVersion` increments.
- **Post-Audit Status:** **FIXED & VERIFIED**.

### `[CARBON-AUD-004]` — `P1` High: Suspended/Closed Account & Ranked-Locked Asset Laundering via Item Transfers and Mutations
- **Locations:** `CharacterEngineService`, `InventoryEngineService` (`transferItemInstance`, `destroyItemInstance`, stack/loadout mutations), `SocialEngineService.equipTitle`, `SkillEngineService`.
- **Preconditions:** Account transitions to `status = 'suspended' | 'closed'`, character transitions to `status = 'locked_for_transfer' | 'archived'`, or character enters `competitive_lock_state = 'in_ranked_series'`.
- **Evidence & Root Cause:** Only `createCharacter` and `SkillEngineService` checked `accounts.status === 'active'`; `InventoryEngineService.transferItemInstance` checked neither sender/recipient `accounts.status`, nor `characters.status === 'active'`, nor `competitive_lock_state`.
- **Impact:** A suspended account could liquidate and transfer unbound items to an external accomplice account (`transferItemInstance`) — a severe pre-Economy asset-laundering vector — or mutate/destroy items during an active ranked series.
- **Remediation:** Enforced `character.assertActiveStatus()` and `assertAccountActive` across all player-mutable Character, Inventory, Skill, and Social operations; locked both sender and recipient accounts in canonical ascending UUID order in `transferItemInstance`; blocked `transferItemInstance` and `destroyItemInstance` while `in_ranked_series`.
- **Post-Audit Status:** **FIXED & VERIFIED**.

### `[CARBON-AUD-005]` — `P1` High: Duplicate JSON Object Key Smuggling in `decodeWireJsonLossless`
- **Location:** `src/shared/contracts/int64-wire.ts` (`decodeWireJsonLossless`).
- **Evidence & Root Cause:** `JSON.parse` silently overwrites duplicate object keys (`{"eligible":false,"eligible":true}` -> `true`), creating parser differentials across Go/TypeScript boundaries (including `\uXXXX`-escaped duplicate keys).
- **Remediation:** Added a depth-aware structural key scanner (`assertNoDuplicateJsonObjectKeys`) decoding JSON string escapes and rejecting any duplicate object key at any nesting depth before returning parsed wire payloads.
- **Post-Audit Status:** **FIXED & VERIFIED**.

### `[CARBON-AUD-006]` — `P1` High: Restricted Historical Record Exposure in NPC Recognition & Public Warrant Filtering
- **Locations:** `src/modules/social/application/social-engine-service.ts` (`evaluateCharacterContextualRecognition`), `src/modules/social/application/social-snapshot-query.ts` (`getSocialStandingSnapshot`).
- **Evidence & Root Cause:** `evaluateCharacterContextualRecognition` queried `historical_social_records` without excluding `visibility = 'restricted_archive'`, without `LIMIT`, and without rejecting `genesis_ranked_md3_scratch`. `getSocialStandingSnapshot` (`public_limited`) did not intersect `activeWarrantSummary` with jurisdictions publicly in `Wanted` / `Fugitive` state.
- **Remediation:** Excluded `visibility = 'restricted_archive'`, added `ORDER BY recorded_at DESC LIMIT 200`, added `assertNotGenesisContext`, and restricted `public_limited` warrant summaries to publicly wanted jurisdictions.
- **Post-Audit Status:** **FIXED & VERIFIED**.

---

## 4. Residual Security Risks (Must Be Addressed Before Production Network Exposure)

1. **No Network Authentication / Session Layer Yet:** `AuthorityPrincipal` is trusted in-process. A future HTTP/gRPC gateway **must** authenticate player tokens (OAuth2/OIDC/session) and bind `principal.accountId` server-side, and restrict `internal_system_authority` to internal worker/NEON mTLS channels.
2. **Event `source` Field Is Audit Metadata Only:** `BaseEventEnvelopeV1Schema.source` and `EnvelopedContributionSubmissionV1Schema.source` are strings for observability and must never be used for authorization decisions.
3. **Server Seed Confidentiality (`GrantProceduralEquipment`):** `SplitMix64Rng` is a deterministic non-cryptographic PRNG (`SHA-256` seeded, integer-only), **not** a CSPRNG. When loot drops are wired in Session 07, `serverSeed` must incorporate secret server-side entropy (never client-predictable timestamps or client-chosen strings) so players cannot pre-compute or cherry-pick procedural rolls.
