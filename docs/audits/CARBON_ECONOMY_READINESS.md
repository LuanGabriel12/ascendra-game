# CARBON Session 07 Economy Readiness Assessment

- **Target Next Session:** `CARBON Engineering Session 07 — Economy, Currencies, Wallets, Ledger, Trading, Market, Escrow, Loot & Crafting Engine`
- **Audit Base:** `carbon/full-backend-audit` (Sessions `01..06` + `0012` audit hardening)

---

## 1. Readiness Evaluation of Existing Foundations

| Economic Capability Planned for Session 07 | Supporting Foundation in Sessions 01–06 | Audit Verification Status | Pre-Economy Gaps / Constraints |
|---|---|---|---|
| **Currencies, Wallets & Double-Entry Monetary Ledger** | Preparatory `ValueLedgerPort` (`src/modules/economy/domain/value-ledger.ts`), `CheckedAddSignedInt64` patterns, `Transactional Inbox/Outbox`, `accounts` & `characters` active-status guards | **Ready Foundation** (no mutable `gold` column exists anywhere in `0001..0012`!) | Must implement dedicated `currencies`, `currency_accounts` (player/settlement/faction/escrow/system_mint/system_sink), and immutable double-entry `currency_ledger_entries` with `BIGINT` non-negative balance constraints |
| **Player-to-Player Direct Trading** | `InventoryEngineService.transferItemInstance` (`unbound` / `account_bound` rules, inactive-loadout pointer purge, canonical ascending character & account `FOR UPDATE` locking, suspended-account & `in_ranked_series` blocks fixed in `CARBON-AUD-004`) | **Ready Foundation** | Direct `transferItemInstance` is one-way; P2P trade must wrap two-sided item + stack + currency exchange inside a **single atomic PostgreSQL transaction** locking both accounts, both characters, both wallets, and all offered item instances/stacks in canonical UUID order |
| **Regional Market & Order Escrow** | `inventory_containers` + `item_instances.location_state` + `social_regions` + `settlements` + `character_reputations` (for regional tax/fee modifiers) | **Requires Controlled Schema Extension in S07** | `chk_item_instances_single_location` (`0007`) currently allows `'in_container'`, `'equipped_active'`, `'destroyed'`. Market/trade escrow in S07 must either add an incremental migration extending `location_state` with `'in_escrow'` (with `container_id IS NULL` and `escrow_id` reference) OR introduce `'market_escrow'` container type so escrowed items **cannot** be equipped, moved, destroyed, or double-listed |
| **Criminal Bounty Escrow & Payout Settlement** | `criminal_bounties` (`funding_status = 'escrow_committed'`, `funding_reference`) & `criminal_bounty_claims` (`UNIQUE(bounty_id)`, `chk_bounty_claim_no_self_or_same_account`, `payout_commitment_status = 'pending_economy_settlement'`) | **Ready Bridge** (zero fake money paid in S05!) | S07 must verify real escrow reservation before setting `funding_status = 'escrow_committed'` and settle `pending_economy_settlement` claims idempotently (`UNIQUE(bounty_claim_id)` in monetary ledger) while keeping anti-alt/anti-collusion checks |
| **Boss Loot, World Event Rewards & Anti-Bad-Luck Fragments** | `item_grants` (`UNIQUE(processed_event_id)`, `UNIQUE(external_grant_id)`, `UNIQUE(source_event_id, recipient_character_id, reward_slot_index)`), `gameplay_contributions` (`eligible = true`), `external_identity_links`, stackable `arcane_fragment` / `abyssal_crystal`, `SplitMix64Rng` (`server_seed` fingerprinted in `CARBON-AUD-007`) | **Strong Foundation** | Loot service must require secret server-side seed entropy (never client-supplied seeds) and resolve `player_id -> character_id` strictly via `external_identity_links` |
| **Crafting & Material Consumption** | `inventory_stacks` (`stack_equivalence_key`, exact split/merge conservation verified by 80-step fuzzing, `fn_enforce_container_slot_integrity` hardened with `FOR UPDATE` in `CARBON-AUD-003`), immutable `(definition_code, definition_version)` | **Ready Foundation** | Currently `InventoryEngineService` has `grantStackableMaterial`, `splitStack`, `mergeStacks`, `moveInventoryEntry`, and `destroyItemInstance`, but no `consumeStackableMaterial` yet — S07 Crafting must deduct materials atomically (`UPDATE/DELETE inventory_stacks` + `item_operation_ledger` `'consume'` + `item_instances` `'crafting'` grant in one transaction) |
| **NPC Merchant Buy/Sell & Equipment Repair Sink** | `trade_category` (`standard`, `restricted`, `non_tradable`), `repairItem` (`internal_system_authority`), contextual settlement/faction reputations | **Ready Foundation** | Repair & vendor services in S07 must atomically debit player wallet -> credit `system_sink` / `settlement_treasury` before invoking durability repair or item mint/sink |
| **Competitive Isolation (`Legacy Ranked` & `Genesis Ranked`)** | `assertNotGenesisContext` across all engines + `in_ranked_series` lock on attributes, loadouts, skills, transfers, and item destruction (`CARBON-AUD-001` & `CARBON-AUD-004`) | **Verified** | S07 must enforce `assertNotGenesisContext` on **every** wallet, trade, market, loot, and crafting command so temporary Genesis matches can never mint gold, fragments, or tradable items |

---

## 2. Mandatory Economic Invariants for Session 07

Before any Session 07 PR can be approved, the Economy Engine **must** enforce all 10 invariants below in PostgreSQL constraints and transactional code:

1. **Zero Unbacked Balance Mutation:** No wallet balance may ever be modified without a corresponding immutable double-entry row `(debit_account_id, credit_account_id, currency_code, amount > 0, idempotency_key)` in the monetary ledger within the same transaction.
2. **Closed-System Monetary Conservation:** Across all non-mint/non-sink accounts (`player`, `escrow`, `settlement_treasury`, `faction_treasury`), `SUM(credits) - SUM(debits)` for every transaction must equal `0`; only authorized `system_mint` sources (validated PvE/event policies) may increase total money supply, and `system_sink` (taxes, listing fees, repairs, respec fees, crafting fees) must be explicitly accounted for.
3. **Strict Non-Negative Balances & `int64` Overflow Guards:** All wallet/escrow balances must satisfy `CHECK (balance >= 0)` in PostgreSQL and overflow-checked `BigInt` (`<= MAX_INT64`) arithmetic in TypeScript; fractional currency amounts are forbidden (use smallest atomic integer denomination).
4. **Canonical Multi-Entity Lock Ordering:** Any transaction touching multiple wallets, characters, items, or market orders **must** lock rows in deterministic global order (`accounts` UUID ASC -> `characters` UUID ASC -> `currency_accounts` UUID ASC -> `inventory_containers` UUID ASC -> `item_instances` UUID ASC -> `inventory_stacks` UUID ASC) to prevent deadlocks under concurrent trading/sniping.
5. **Single Authoritative Escrow Custody:** An item or material quantity listed on the market or locked in a trade offer must leave `in_container` immediately upon listing/escrow so it cannot be equipped, consumed in crafting, transferred, or listed twice.
6. **Cancellation & Expiration Idempotency:** Cancelling or expiring a market order or trade must transition status via `UPDATE ... WHERE id = $1 AND status = 'open'` (`rowCount === 1` required!) so a concurrent buyer fill and seller cancel can **never** both succeed (preventing classic MMORPG item/gold duplication!).
7. **Binding & Tradeability Enforcement:** `character_bound`, `bind_on_pickup`, already-bound `bind_on_equip`, and `trade_category = 'non_tradable'` items/stacks must be rejected at market listing and cross-account trade boundaries.
8. **Suspended/Closed Account & Competitive Lock Freeze:** Accounts with `status !== 'active'` cannot trade, list, buy, withdraw escrow, or craft; characters in `in_ranked_series` cannot alter equipped items or active combat build state via market/trade side doors.
9. **Anti-Wash-Trading & Same-Account Restrictions:** Cross-character self-dealing on the same `AccountID` must never generate fame, merchant progression, or bounty payouts (`claimant_account_id <> target_account_id` already enforced in `criminal_bounty_claims`).
10. **Permanent Idempotency Retention on Economic Commands:** Every mint, payout, trade settlement, market fill, and crafting execution must claim a `processed_events` fingerprint **after** caller authorization and **inside** the same PostgreSQL transaction, and economic idempotency keys must never be TTL-purged without archival tombstones.

---

## 3. Pre-Economy Gate Verdict

All `P0` and `P1` integrity/security defects discovered in Sessions `01..06` (`CARBON-AUD-001`..`CARBON-AUD-006`) and contract/database hardening items (`CARBON-AUD-007`..`CARBON-AUD-010`) have been **reproduced, fixed, and regression-tested against real PostgreSQL**.

**Gate Decision:** **APPROVED TO START SESSION 07 (`READY WITH LIMITATIONS` — see `CARBON_FULL_BACKEND_AUDIT.md` for documented non-blocking host/transport limitations).**
