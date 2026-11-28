import { randomUUID } from "node:crypto";
import { deriveDeterministicEventUuid } from "../../../shared/contracts/canonical-fingerprint.js";
import {
  withPgTransaction,
  type PgPool,
  type PgPoolClient,
} from "../../../shared/db/pool.js";
import {
  claimOrVerifyProcessedEvent,
  type ClaimProcessedEventInput,
  type ClaimProcessedEventResult,
} from "../../../shared/db/processed-events-inbox.js";
import type { Account, Character } from "../../characters/domain/character.js";
import {
  AccountNotFoundError,
  CharacterNotFoundError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import {
  InventoryCapacityExceededError,
  ItemBindingViolationError,
  ItemDefinitionNotFoundError,
  ItemInstanceNotFoundError,
  ItemOwnershipForbiddenError,
  StackOperationInvalidError,
} from "../../inventory/domain/errors.js";
import { buildStackEquivalenceKey } from "../../inventory/domain/equipment-and-stack-rules.js";
import type {
  InventoryContainer,
  InventoryStack,
  ItemDefinition,
  ItemInstance,
} from "../../inventory/domain/item-types.js";
import { PgInventoryTransactionScope } from "../../inventory/infrastructure/postgres-inventory-unit-of-work.js";
import { PgSocialTransactionScope } from "../../social/infrastructure/postgres-social-unit-of-work.js";
import { validateTitleConditionAst } from "../../titles/domain/title-contracts.js";
import {
  DEFAULT_ECONOMIC_RULES_V1,
  INITIAL_ANTI_BAD_LUCK_FRAGMENTS_CATALOG,
  INITIAL_CRAFTING_RECIPES_CATALOG,
  INITIAL_CURRENCIES_CATALOG,
  INITIAL_LOOT_TABLES_CATALOG,
  INITIAL_NPC_MERCHANTS_CATALOG,
  INITIAL_NPC_OFFERS_CATALOG,
  INITIAL_PROFESSIONS_CATALOG,
  INITIAL_REGIONAL_TAX_POLICIES,
  SESSION_07_ECONOMY_TITLES_V2,
} from "../catalog/initial-economy-catalog.js";
import type {
  CurrencyAccount,
  CurrencyAccountOwnerType,
  CurrencyAccountStatus,
  CurrencyDefinition,
  CurrencyLedgerEntryRecord,
  CurrencyLedgerTransactionRecord,
  CurrencyReconciliationResult,
  CurrencyReservation,
  CurrencyReservationPurpose,
  CurrencyReservationStatus,
  EconomicObservabilityReport,
  EconomicRulesConfig,
  EscrowAssetHolding,
  EscrowAssetKind,
  EscrowAssetPurpose,
  EscrowHoldingStatus,
  MonetaryOperationType,
  RegionalMarketPriceStats,
} from "../domain/economy-types.js";
import {
  AssetEscrowCustodyError,
  CraftingOrProfessionError,
  CurrencyNotFoundOrDisabledError,
  CurrencyOperationForbiddenError,
  EscrowReservationStateError,
  InsufficientFundsError,
  MonetaryLedgerImbalanceError,
  WalletNotFoundOrInactiveError,
} from "../domain/errors.js";
import {
  assertPositiveMonetaryAmount,
  checkedAddMonetary,
  checkedSubMonetary,
  validateLootTableDefinition,
} from "../domain/monetary-and-tax-rules.js";
import type {
  BalancedLedgerTransactionInput,
  LedgerEntry,
  LedgerMovementInput,
  PaginatedLedgerQuery,
  ValueLedgerPort,
} from "../domain/value-ledger.js";

export type EconomyOutboxEventType =
  | "CurrencyMinted"
  | "CurrencyTransferred"
  | "CurrencyDestroyed"
  | "FundsReserved"
  | "FundsConsumed"
  | "FundsReleased"
  | "TradeCreated"
  | "TradeAccepted"
  | "TradeOfferUpdated"
  | "TradeCompleted"
  | "TradeCancelled"
  | "MarketListingCreated"
  | "MarketSaleCompleted"
  | "MarketListingCancelled"
  | "MarketListingExpired"
  | "RegionalTaxCollected"
  | "NpcMerchantPurchaseCompleted"
  | "NpcMerchantSaleCompleted"
  | "EquipmentRepairCompleted"
  | "LootGranted"
  | "FragmentsGranted"
  | "RewardRedeemed"
  | "CraftingCompleted"
  | "CriminalBountyFunded"
  | "CriminalBountySettled";

interface CurrencyRow {
  currency_code: string;
  display_name: string;
  description: string;
  smallest_unit_name: string;
  denomination_notes: Record<string, number | string | boolean>;
  maximum_balance: string;
  is_tradeable: boolean;
  is_transferable: boolean;
  is_enabled: boolean;
  rules_version: number;
}

interface CurrencyAccountRow {
  id: string;
  owner_type: CurrencyAccountOwnerType;
  owner_id: string;
  owner_character_id: string | null;
  owner_settlement_id: string | null;
  owner_faction_id: string | null;
  currency_code: string;
  balance: string;
  version: number;
  status: CurrencyAccountStatus;
  created_at: Date;
  updated_at: Date;
}

interface ReservationRow {
  id: string;
  owner_wallet_id: string;
  owner_character_id: string | null;
  escrow_account_id: string;
  currency_code: string;
  reserved_amount: string;
  consumed_amount: string;
  released_amount: string;
  purpose: CurrencyReservationPurpose;
  reference_id: string;
  reserve_ledger_tx_id: string;
  resolution_ledger_tx_id: string | null;
  status: CurrencyReservationStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface EscrowHoldingRow {
  id: string;
  owner_account_id: string;
  owner_character_id: string;
  purpose: EscrowAssetPurpose;
  reference_id: string;
  asset_kind: EscrowAssetKind;
  item_instance_id: string | null;
  source_stack_id: string | null;
  definition_code: string;
  definition_version: number;
  quantity: number;
  remaining_quantity: number;
  quality_bp: number;
  binding_state: "unbound" | "bind_on_equip" | "account_bound" | "character_bound";
  bound_account_id: string | null;
  bound_character_id: string | null;
  stack_equivalence_key: string | null;
  status: EscrowHoldingStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function mapCurrencyRow(r: CurrencyRow): CurrencyDefinition {
  return {
    currencyCode: r.currency_code,
    displayName: r.display_name,
    description: r.description,
    smallestUnitName: r.smallest_unit_name,
    denominationNotes: r.denomination_notes ?? {},
    maximumBalance: BigInt(r.maximum_balance),
    isTradeable: r.is_tradeable,
    isTransferable: r.is_transferable,
    isEnabled: r.is_enabled,
    rulesVersion: r.rules_version,
  };
}

export function mapCurrencyAccountRow(r: CurrencyAccountRow): CurrencyAccount {
  return {
    id: r.id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    ownerCharacterId: r.owner_character_id,
    ownerSettlementId: r.owner_settlement_id,
    ownerFactionId: r.owner_faction_id,
    currencyCode: r.currency_code,
    balance: BigInt(r.balance),
    version: r.version,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapReservationRow(r: ReservationRow): CurrencyReservation {
  return {
    id: r.id,
    ownerWalletId: r.owner_wallet_id,
    ownerCharacterId: r.owner_character_id,
    escrowAccountId: r.escrow_account_id,
    currencyCode: r.currency_code,
    reservedAmount: BigInt(r.reserved_amount),
    consumedAmount: BigInt(r.consumed_amount),
    releasedAmount: BigInt(r.released_amount),
    purpose: r.purpose,
    referenceId: r.reference_id,
    reserveLedgerTxId: r.reserve_ledger_tx_id,
    resolutionLedgerTxId: r.resolution_ledger_tx_id,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapEscrowHoldingRow(r: EscrowHoldingRow): EscrowAssetHolding {
  return {
    id: r.id,
    ownerAccountId: r.owner_account_id,
    ownerCharacterId: r.owner_character_id,
    purpose: r.purpose,
    referenceId: r.reference_id,
    assetKind: r.asset_kind,
    itemInstanceId: r.item_instance_id,
    sourceStackId: r.source_stack_id,
    definitionCode: r.definition_code,
    definitionVersion: r.definition_version,
    quantity: r.quantity,
    remainingQuantity: r.remaining_quantity,
    qualityBp: r.quality_bp,
    bindingState: r.binding_state,
    boundAccountId: r.bound_account_id,
    boundCharacterId: r.bound_character_id,
    stackEquivalenceKey: r.stack_equivalence_key,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function deterministicPlayerWalletId(characterId: string, currencyCode: string): string {
  return deriveDeterministicEventUuid(`wallet:char:${characterId.toLowerCase()}:${currencyCode}`);
}

export function deterministicSettlementTreasuryId(
  settlementId: string,
  currencyCode: string,
): string {
  return deriveDeterministicEventUuid(
    `treasury:settlement:${settlementId.toLowerCase()}:${currencyCode}`,
  );
}

export function deterministicFactionTreasuryId(factionId: string, currencyCode: string): string {
  return deriveDeterministicEventUuid(
    `treasury:faction:${factionId.toLowerCase()}:${currencyCode}`,
  );
}

export function deterministicMerchantWalletId(merchantCode: string, currencyCode: string): string {
  return deriveDeterministicEventUuid(`wallet:merchant:${merchantCode}:${currencyCode}`);
}

/**
 * Shared Transactional Boundary for CARBON Session 07 Economic Operations (Section 10).
 * Coordinates Character, Account, Wallet, Reservation, Inventory, Stack, Ledger, Inbox, and Outbox
 * mutations inside a single atomic PostgreSQL transaction without intermediate commits.
 */
export class PgEconomyTransactionScope {
  public readonly pool: PgPool;
  public readonly client: PgPoolClient;
  public readonly characters: PgCharacterTransactionScope;
  public readonly inventory: PgInventoryTransactionScope;
  public readonly social: PgSocialTransactionScope;

  constructor(pool: PgPool, client: PgPoolClient) {
    this.pool = pool;
    this.client = client;
    this.characters = new PgCharacterTransactionScope(pool, client);
    this.inventory = new PgInventoryTransactionScope(client);
    this.social = new PgSocialTransactionScope(client);
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async loadEconomicRules(rulesVersion = 1): Promise<EconomicRulesConfig> {
    const res = await this.client.query<{
      rules_version: number;
      code: string;
      default_market_listing_fee_bp: number;
      default_market_sale_tax_bp: number;
      max_tax_rate_bp: number;
      default_repair_cost_per_durability: string;
      repair_treasury_share_bp: number;
      crafting_station_tax_treasury_share_bp: number;
      bounty_escrow_currency_code: string;
      is_active: boolean;
    }>(
      `SELECT * FROM economic_rules_versions WHERE rules_version = $1 AND is_active = TRUE`,
      [rulesVersion],
    );
    const r = res.rows[0];
    if (!r) {
      throw new CurrencyOperationForbiddenError(
        `Active economic_rules_versions v${rulesVersion} not found.`,
      );
    }
    return {
      rulesVersion: r.rules_version,
      code: r.code,
      defaultMarketListingFeeBp: r.default_market_listing_fee_bp,
      defaultMarketSaleTaxBp: r.default_market_sale_tax_bp,
      maxTaxRateBp: r.max_tax_rate_bp,
      defaultRepairCostPerDurability: BigInt(r.default_repair_cost_per_durability),
      repairTreasuryShareBp: r.repair_treasury_share_bp,
      craftingStationTaxTreasuryShareBp: r.crafting_station_tax_treasury_share_bp,
      bountyEscrowCurrencyCode: r.bounty_escrow_currency_code,
      isActive: r.is_active,
    };
  }

  public async requireActiveCurrency(currencyCode: string): Promise<CurrencyDefinition> {
    const res = await this.client.query<CurrencyRow>(
      "SELECT * FROM currencies WHERE currency_code = $1",
      [currencyCode],
    );
    const row = res.rows[0];
    if (!row || !row.is_enabled) {
      throw new CurrencyNotFoundOrDisabledError(currencyCode);
    }
    return mapCurrencyRow(row);
  }

  /**
   * Canonical lock order Step 2 & Step 3:
   * Locks all involved `characters` in ascending UUID order, then all owning `accounts` in ascending UUID order.
   */
  public async lockCharactersAndAccountsCanonical(
    characterIds: ReadonlyArray<string>,
  ): Promise<{
    readonly characters: Map<string, Character>;
    readonly accounts: Map<string, Account>;
  }> {
    const uniqueSortedCharIds = Array.from(
      new Set(characterIds.map((id) => id.trim().toLowerCase())),
    ).sort();
    const characters = new Map<string, Character>();
    for (const cid of uniqueSortedCharIds) {
      const ch = await this.characters.lockCharacterById(cid);
      if (!ch) {
        throw new CharacterNotFoundError(cid);
      }
      characters.set(ch.id.toLowerCase(), ch);
    }

    const uniqueSortedAccIds = Array.from(
      new Set(Array.from(characters.values()).map((c) => c.accountId.toLowerCase())),
    ).sort();
    const accounts = new Map<string, Account>();
    for (const aid of uniqueSortedAccIds) {
      const acc = await this.characters.lockAccountById(aid);
      if (!acc) {
        throw new AccountNotFoundError(aid);
      }
      accounts.set(acc.id.toLowerCase(), acc);
    }

    return { characters, accounts };
  }

  /**
   * Ensures a player wallet row exists (without mutating balance) and returns its wallet ID.
   * Callers lock all involved wallet IDs together via `lockWalletsCanonical(...)`.
   */
  public async ensurePlayerWalletId(characterId: string, currencyCode: string): Promise<string> {
    await this.requireActiveCurrency(currencyCode);
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM currency_accounts
       WHERE owner_type = 'player_wallet' AND owner_character_id = $1::uuid AND currency_code = $2`,
      [characterId, currencyCode],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const walletId = deterministicPlayerWalletId(characterId, currencyCode);
    const ins = await this.client.query<{ id: string }>(
      `INSERT INTO currency_accounts (
         id, owner_type, owner_id, owner_character_id, currency_code, balance, version, status
       )
       VALUES ($1::uuid, 'player_wallet', $2, $3::uuid, $4, 0, 1, 'active')
       ON CONFLICT (owner_type, owner_id, currency_code) DO UPDATE
         SET currency_code = EXCLUDED.currency_code
       RETURNING id`,
      [walletId, characterId.toLowerCase(), characterId, currencyCode],
    );
    return ins.rows[0]!.id;
  }

  public async ensureSettlementTreasuryId(
    settlementId: string,
    currencyCode: string,
  ): Promise<string> {
    await this.requireActiveCurrency(currencyCode);
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM currency_accounts
       WHERE owner_type = 'settlement_treasury' AND owner_settlement_id = $1::uuid AND currency_code = $2`,
      [settlementId, currencyCode],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const walletId = deterministicSettlementTreasuryId(settlementId, currencyCode);
    const ins = await this.client.query<{ id: string }>(
      `INSERT INTO currency_accounts (
         id, owner_type, owner_id, owner_settlement_id, currency_code, balance, version, status
       )
       VALUES ($1::uuid, 'settlement_treasury', $2, $3::uuid, $4, 0, 1, 'active')
       ON CONFLICT (owner_type, owner_id, currency_code) DO UPDATE
         SET currency_code = EXCLUDED.currency_code
       RETURNING id`,
      [walletId, settlementId.toLowerCase(), settlementId, currencyCode],
    );
    return ins.rows[0]!.id;
  }

  public async ensureFactionTreasuryId(factionId: string, currencyCode: string): Promise<string> {
    await this.requireActiveCurrency(currencyCode);
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM currency_accounts
       WHERE owner_type = 'faction_treasury' AND owner_faction_id = $1::uuid AND currency_code = $2`,
      [factionId, currencyCode],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const walletId = deterministicFactionTreasuryId(factionId, currencyCode);
    const ins = await this.client.query<{ id: string }>(
      `INSERT INTO currency_accounts (
         id, owner_type, owner_id, owner_faction_id, currency_code, balance, version, status
       )
       VALUES ($1::uuid, 'faction_treasury', $2, $3::uuid, $4, 0, 1, 'active')
       ON CONFLICT (owner_type, owner_id, currency_code) DO UPDATE
         SET currency_code = EXCLUDED.currency_code
       RETURNING id`,
      [walletId, factionId.toLowerCase(), factionId, currencyCode],
    );
    return ins.rows[0]!.id;
  }

  public async ensureCanonicalTechnicalAccountId(
    ownerType: "system_mint" | "system_sink" | "escrow_account",
    currencyCode: string,
  ): Promise<string> {
    await this.requireActiveCurrency(currencyCode);
    const ownerId =
      ownerType === "system_mint"
        ? "canonical_mint"
        : ownerType === "system_sink"
          ? "canonical_sink"
          : "canonical_escrow_pool";
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM currency_accounts
       WHERE owner_type = $1 AND owner_id = $2 AND currency_code = $3`,
      [ownerType, ownerId, currencyCode],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const fallbackId = deriveDeterministicEventUuid(`tech:${ownerType}:${currencyCode}`);
    const ins = await this.client.query<{ id: string }>(
      `INSERT INTO currency_accounts (id, owner_type, owner_id, currency_code, balance, version, status)
       VALUES ($1::uuid, $2, $3, $4, 0, 1, 'active')
       ON CONFLICT (owner_type, owner_id, currency_code) DO UPDATE
         SET currency_code = EXCLUDED.currency_code
       RETURNING id`,
      [fallbackId, ownerType, ownerId, currencyCode],
    );
    return ins.rows[0]!.id;
  }

  /**
   * Canonical lock order Step 5:
   * Locks all involved `currency_accounts` in strictly ascending UUID order (`ORDER BY id ASC FOR UPDATE`).
   */
  public async lockWalletsCanonical(
    walletIds: ReadonlyArray<string>,
  ): Promise<Map<string, CurrencyAccount>> {
    const uniqueSorted = Array.from(
      new Set(walletIds.map((id) => id.trim().toLowerCase())),
    ).sort();
    if (uniqueSorted.length === 0) {
      return new Map();
    }
    const res = await this.client.query<CurrencyAccountRow>(
      `SELECT * FROM currency_accounts
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR UPDATE`,
      [uniqueSorted],
    );
    const map = new Map<string, CurrencyAccount>();
    for (const r of res.rows) {
      map.set(r.id.toLowerCase(), mapCurrencyAccountRow(r));
    }
    for (const expectedId of uniqueSorted) {
      if (!map.has(expectedId)) {
        throw new WalletNotFoundOrInactiveError(`CurrencyAccount '${expectedId}' does not exist.`);
      }
    }
    return map;
  }

  public async lockReservationsCanonical(
    reservationIds: ReadonlyArray<string>,
  ): Promise<Map<string, CurrencyReservation>> {
    const uniqueSorted = Array.from(
      new Set(reservationIds.map((id) => id.trim().toLowerCase())),
    ).sort();
    if (uniqueSorted.length === 0) {
      return new Map();
    }
    const res = await this.client.query<ReservationRow>(
      `SELECT * FROM currency_reservations
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR UPDATE`,
      [uniqueSorted],
    );
    const map = new Map<string, CurrencyReservation>();
    for (const r of res.rows) {
      map.set(r.id.toLowerCase(), mapReservationRow(r));
    }
    return map;
  }

  public async lockEscrowHoldingsCanonical(
    holdingIds: ReadonlyArray<string>,
  ): Promise<Map<string, EscrowAssetHolding>> {
    const uniqueSorted = Array.from(
      new Set(holdingIds.map((id) => id.trim().toLowerCase())),
    ).sort();
    if (uniqueSorted.length === 0) {
      return new Map();
    }
    const res = await this.client.query<EscrowHoldingRow>(
      `SELECT * FROM escrow_asset_holdings
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR UPDATE`,
      [uniqueSorted],
    );
    const map = new Map<string, EscrowAssetHolding>();
    for (const r of res.rows) {
      map.set(r.id.toLowerCase(), mapEscrowHoldingRow(r));
    }
    return map;
  }

  public async findLedgerTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CurrencyLedgerTransactionRecord | null> {
    const txRes = await this.client.query<{
      id: string;
      ledger_tx_seq: string;
      processed_event_id: string | null;
      idempotency_key: string;
      operation_type: MonetaryOperationType;
      currency_code: string;
      total_amount: string;
      correlation_id: string;
      source_event_id: string;
      actor_type: string;
      actor_id: string;
      is_compensating: boolean;
      compensates_tx_id: string | null;
      metadata: Record<string, unknown>;
      rules_version: number;
      recorded_at: Date;
    }>("SELECT * FROM currency_ledger_transactions WHERE idempotency_key = $1", [idempotencyKey]);
    const tx = txRes.rows[0];
    if (!tx) {
      return null;
    }
    const entriesRes = await this.client.query<{
      id: string;
      ledger_entry_seq: string;
      transaction_id: string;
      entry_ordinal: number;
      debit_account_id: string;
      credit_account_id: string;
      currency_code: string;
      amount: string;
      debit_balance_after: string;
      credit_balance_after: string;
      memo: string;
      recorded_at: Date;
    }>(
      `SELECT * FROM currency_ledger_entries
       WHERE transaction_id = $1::uuid
       ORDER BY entry_ordinal ASC`,
      [tx.id],
    );
    return {
      id: tx.id,
      ledgerTxSeq: BigInt(tx.ledger_tx_seq),
      processedEventId: tx.processed_event_id,
      idempotencyKey: tx.idempotency_key,
      operationType: tx.operation_type,
      currencyCode: tx.currency_code,
      totalAmount: BigInt(tx.total_amount),
      correlationId: tx.correlation_id,
      sourceEventId: tx.source_event_id,
      actorType: tx.actor_type,
      actorId: tx.actor_id,
      isCompensating: tx.is_compensating,
      compensatesTxId: tx.compensates_tx_id,
      metadata: tx.metadata ?? {},
      rulesVersion: tx.rules_version,
      recordedAt: tx.recorded_at,
      entries: entriesRes.rows.map((e) => ({
        id: e.id,
        ledgerEntrySeq: BigInt(e.ledger_entry_seq),
        transactionId: e.transaction_id,
        entryOrdinal: e.entry_ordinal,
        debitAccountId: e.debit_account_id,
        creditAccountId: e.credit_account_id,
        currencyCode: e.currency_code,
        amount: BigInt(e.amount),
        debitBalanceAfter: BigInt(e.debit_balance_after),
        creditBalanceAfter: BigInt(e.credit_balance_after),
        memo: e.memo,
        recordedAt: e.recorded_at,
      })),
    };
  }

  /**
   * Executes an atomic, balanced multi-leg double-entry monetary transaction.
   * Every leg pairs `(debitAccountId, creditAccountId, amount > 0)` in the same currency,
   * guaranteeing `SUM(debits) === SUM(credits)` and updating all account balances atomically.
   */
  public async executeBalancedLedgerTransaction(
    input: BalancedLedgerTransactionInput,
  ): Promise<CurrencyLedgerTransactionRecord> {
    if (input.legs.length === 0) {
      throw new MonetaryLedgerImbalanceError("Ledger transaction requires at least one leg.");
    }
    const currency = await this.requireActiveCurrency(input.currencyCode);
    const rulesVersion = input.rulesVersion ?? 1;
    const isCompensating = input.isCompensating ?? false;

    const involvedIds: string[] = [];
    for (const leg of input.legs) {
      assertPositiveMonetaryAmount(leg.amount, "leg.amount");
      if (leg.debitAccountId.toLowerCase() === leg.creditAccountId.toLowerCase()) {
        throw new MonetaryLedgerImbalanceError(
          `Debit and credit account cannot be identical ('${leg.debitAccountId}').`,
        );
      }
      if (!leg.memo.trim()) {
        throw new MonetaryLedgerImbalanceError("Ledger entry memo cannot be blank.");
      }
      involvedIds.push(leg.debitAccountId, leg.creditAccountId);
    }

    const lockedMap = await this.lockWalletsCanonical(involvedIds);
    const runningBalances = new Map<string, bigint>();

    for (const [key, acc] of lockedMap) {
      if (acc.currencyCode !== currency.currencyCode) {
        throw new MonetaryLedgerImbalanceError(
          `Account '${acc.id}' holds '${acc.currencyCode}', expected '${currency.currencyCode}'.`,
        );
      }
      if (acc.status !== "active") {
        throw new WalletNotFoundOrInactiveError(
          `Account '${acc.id}' is '${acc.status}' and cannot participate in monetary movements.`,
        );
      }
      runningBalances.set(key, acc.balance);
    }

    let totalAmount = 0n;
    const computedEntries: Array<{
      readonly entryOrdinal: number;
      readonly debitAccountId: string;
      readonly creditAccountId: string;
      readonly amount: bigint;
      readonly debitBalanceAfter: bigint;
      readonly creditBalanceAfter: bigint;
      readonly memo: string;
    }> = [];

    for (let idx = 0; idx < input.legs.length; idx++) {
      const leg = input.legs[idx]!;
      const debitKey = leg.debitAccountId.toLowerCase();
      const creditKey = leg.creditAccountId.toLowerCase();
      const debitAcc = lockedMap.get(debitKey)!;
      const creditAcc = lockedMap.get(creditKey)!;

      const curDebitBal = runningBalances.get(debitKey)!;
      const curCreditBal = runningBalances.get(creditKey)!;

      let nextDebitBal: bigint;
      if (debitAcc.ownerType === "system_mint") {
        // Debiting system_mint increases cumulative minted counter
        nextDebitBal = checkedAddMonetary(curDebitBal, leg.amount, currency, true);
      } else if (debitAcc.ownerType === "system_sink") {
        if (!isCompensating) {
          throw new CurrencyOperationForbiddenError(
            "system_sink cannot be debited outside an authorized compensating entry.",
          );
        }
        nextDebitBal = checkedSubMonetary(debitAcc.id, currency.currencyCode, curDebitBal, leg.amount);
      } else {
        nextDebitBal = checkedSubMonetary(debitAcc.id, currency.currencyCode, curDebitBal, leg.amount);
      }

      let nextCreditBal: bigint;
      if (creditAcc.ownerType === "system_sink") {
        // Crediting system_sink increases cumulative destroyed counter
        nextCreditBal = checkedAddMonetary(curCreditBal, leg.amount, currency, true);
      } else if (creditAcc.ownerType === "system_mint") {
        if (!isCompensating) {
          throw new CurrencyOperationForbiddenError(
            "system_mint cannot be credited outside an authorized compensating entry.",
          );
        }
        nextCreditBal = checkedSubMonetary(
          creditAcc.id,
          currency.currencyCode,
          curCreditBal,
          leg.amount,
        );
      } else {
        const isEscrowPool = creditAcc.ownerType === "escrow_account";
        nextCreditBal = checkedAddMonetary(curCreditBal, leg.amount, currency, isEscrowPool);
      }

      runningBalances.set(debitKey, nextDebitBal);
      runningBalances.set(creditKey, nextCreditBal);
      totalAmount += leg.amount;

      computedEntries.push({
        entryOrdinal: idx,
        debitAccountId: debitAcc.id,
        creditAccountId: creditAcc.id,
        amount: leg.amount,
        debitBalanceAfter: nextDebitBal,
        creditBalanceAfter: nextCreditBal,
        memo: leg.memo.trim(),
      });
    }

    const now = new Date();
    for (const [key, acc] of lockedMap) {
      const nextBal = runningBalances.get(key)!;
      if (nextBal !== acc.balance) {
        const upd = await this.client.query(
          `UPDATE currency_accounts
           SET balance = $1::bigint, version = version + 1, updated_at = $2
           WHERE id = $3::uuid AND version = $4`,
          [nextBal.toString(), now, acc.id, acc.version],
        );
        if (upd.rowCount !== 1) {
          throw new MonetaryLedgerImbalanceError(
            `Concurrent version conflict updating CurrencyAccount '${acc.id}'.`,
          );
        }
      }
    }

    const txId = deriveDeterministicEventUuid(`ledger-tx:${input.idempotencyKey}`);
    const txIns = await this.client.query<{ ledger_tx_seq: string; recorded_at: Date }>(
      `INSERT INTO currency_ledger_transactions (
         id, processed_event_id, idempotency_key, operation_type, currency_code,
         total_amount, correlation_id, source_event_id, actor_type, actor_id,
         is_compensating, compensates_tx_id, metadata, rules_version, recorded_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3, $4, $5,
         $6::bigint, $7, $8, $9, $10,
         $11, $12::uuid, $13::jsonb, $14, $15
       )
       RETURNING ledger_tx_seq::text AS ledger_tx_seq, recorded_at`,
      [
        txId,
        input.processedEventId ?? null,
        input.idempotencyKey,
        input.operationType,
        currency.currencyCode,
        totalAmount.toString(),
        input.correlationId,
        input.sourceEventId,
        input.actorType,
        input.actorId,
        isCompensating,
        input.compensatesTxId ?? null,
        JSON.stringify(input.metadata ?? {}),
        rulesVersion,
        now,
      ],
    );

    const insertedEntries: CurrencyLedgerEntryRecord[] = [];
    for (const ce of computedEntries) {
      const entryId = deriveDeterministicEventUuid(`ledger-entry:${txId}:${ce.entryOrdinal}`);
      const entIns = await this.client.query<{ ledger_entry_seq: string }>(
        `INSERT INTO currency_ledger_entries (
           id, transaction_id, entry_ordinal, debit_account_id, credit_account_id,
           currency_code, amount, debit_balance_after, credit_balance_after, memo, recorded_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
           $6, $7::bigint, $8::bigint, $9::bigint, $10, $11
         )
         RETURNING ledger_entry_seq::text AS ledger_entry_seq`,
        [
          entryId,
          txId,
          ce.entryOrdinal,
          ce.debitAccountId,
          ce.creditAccountId,
          currency.currencyCode,
          ce.amount.toString(),
          ce.debitBalanceAfter.toString(),
          ce.creditBalanceAfter.toString(),
          ce.memo,
          now,
        ],
      );
      insertedEntries.push({
        id: entryId,
        ledgerEntrySeq: BigInt(entIns.rows[0]!.ledger_entry_seq),
        transactionId: txId,
        entryOrdinal: ce.entryOrdinal,
        debitAccountId: ce.debitAccountId,
        creditAccountId: ce.creditAccountId,
        currencyCode: currency.currencyCode,
        amount: ce.amount,
        debitBalanceAfter: ce.debitBalanceAfter,
        creditBalanceAfter: ce.creditBalanceAfter,
        memo: ce.memo,
        recordedAt: now,
      });
    }

    return {
      id: txId,
      ledgerTxSeq: BigInt(txIns.rows[0]!.ledger_tx_seq),
      processedEventId: input.processedEventId ?? null,
      idempotencyKey: input.idempotencyKey,
      operationType: input.operationType,
      currencyCode: currency.currencyCode,
      totalAmount,
      correlationId: input.correlationId,
      sourceEventId: input.sourceEventId,
      actorType: input.actorType,
      actorId: input.actorId,
      isCompensating,
      compensatesTxId: input.compensatesTxId ?? null,
      metadata: input.metadata ?? {},
      rulesVersion,
      recordedAt: txIns.rows[0]!.recorded_at,
      entries: insertedEntries,
    };
  }

  /**
   * Reserves monetary funds from `ownerWalletId` into `canonical_escrow_pool` inside the active transaction.
   */
  public async reserveFundsInScope(params: {
    readonly reservationId: string;
    readonly idempotencyKey: string;
    readonly processedEventId: string | null;
    readonly ownerWalletId: string;
    readonly ownerCharacterId: string | null;
    readonly currencyCode: string;
    readonly amount: bigint;
    readonly purpose: CurrencyReservationPurpose;
    readonly referenceId: string;
    readonly correlationId: string;
    readonly actorType: string;
    readonly actorId: string;
  }): Promise<{
    readonly reservation: CurrencyReservation;
    readonly ledgerTx: CurrencyLedgerTransactionRecord;
  }> {
    assertPositiveMonetaryAmount(params.amount, "reservedAmount");
    const escrowAccountId = await this.ensureCanonicalTechnicalAccountId(
      "escrow_account",
      params.currencyCode,
    );
    const ledgerTx = await this.executeBalancedLedgerTransaction({
      idempotencyKey: params.idempotencyKey,
      processedEventId: params.processedEventId,
      operationType: "escrow_reserve",
      currencyCode: params.currencyCode,
      correlationId: params.correlationId,
      sourceEventId: params.idempotencyKey,
      actorType: params.actorType,
      actorId: params.actorId,
      metadata: {
        reservation_id: params.reservationId,
        purpose: params.purpose,
        reference_id: params.referenceId,
      },
      legs: [
        {
          debitAccountId: params.ownerWalletId,
          creditAccountId: escrowAccountId,
          amount: params.amount,
          memo: `Escrow reserve (${params.purpose}:${params.referenceId})`,
        },
      ],
    });

    const now = new Date();
    await this.client.query(
      `INSERT INTO currency_reservations (
         id, owner_wallet_id, owner_character_id, escrow_account_id, currency_code,
         reserved_amount, consumed_amount, released_amount, purpose, reference_id,
         reserve_ledger_tx_id, resolution_ledger_tx_id, status, version, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6::bigint, 0, 0, $7, $8,
         $9::uuid, NULL, 'Reserved', 1, $10, $10
       )`,
      [
        params.reservationId,
        params.ownerWalletId,
        params.ownerCharacterId,
        escrowAccountId,
        params.currencyCode,
        params.amount.toString(),
        params.purpose,
        params.referenceId,
        ledgerTx.id,
        now,
      ],
    );

    return {
      reservation: {
        id: params.reservationId,
        ownerWalletId: params.ownerWalletId,
        ownerCharacterId: params.ownerCharacterId,
        escrowAccountId,
        currencyCode: params.currencyCode,
        reservedAmount: params.amount,
        consumedAmount: 0n,
        releasedAmount: 0n,
        purpose: params.purpose,
        referenceId: params.referenceId,
        reserveLedgerTxId: ledgerTx.id,
        resolutionLedgerTxId: null,
        status: "Reserved",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      ledgerTx,
    };
  }

  /**
   * Consumes an active `Reserved` reservation, paying recipient(s) from `escrowAccountId`
   * and marking the reservation `'Consumed'` atomically (preventing any double-consumption).
   */
  public async consumeReservationInScope(params: {
    readonly reservationId: string;
    readonly idempotencyKey: string;
    readonly processedEventId: string | null;
    readonly operationType: MonetaryOperationType;
    readonly payouts: ReadonlyArray<{
      readonly creditAccountId: string;
      readonly amount: bigint;
      readonly memo: string;
    }>;
    readonly correlationId: string;
    readonly actorType: string;
    readonly actorId: string;
  }): Promise<{
    readonly reservation: CurrencyReservation;
    readonly ledgerTx: CurrencyLedgerTransactionRecord;
  }> {
    const locked = await this.lockReservationsCanonical([params.reservationId]);
    const resv = locked.get(params.reservationId.toLowerCase());
    if (!resv) {
      throw new EscrowReservationStateError(`Reservation '${params.reservationId}' not found.`);
    }
    if (resv.status !== "Reserved") {
      throw new EscrowReservationStateError(
        `Reservation '${resv.id}' is already '${resv.status}' and cannot be consumed.`,
      );
    }
    const available = resv.reservedAmount - resv.consumedAmount - resv.releasedAmount;
    let payoutSum = 0n;
    for (const p of params.payouts) {
      assertPositiveMonetaryAmount(p.amount, "payout.amount");
      payoutSum += p.amount;
    }
    if (payoutSum !== available) {
      throw new EscrowReservationStateError(
        `Reservation '${resv.id}' available balance (${available.toString()}) must equal payout sum (${payoutSum.toString()}).`,
      );
    }

    const ledgerTx = await this.executeBalancedLedgerTransaction({
      idempotencyKey: params.idempotencyKey,
      processedEventId: params.processedEventId,
      operationType: params.operationType,
      currencyCode: resv.currencyCode,
      correlationId: params.correlationId,
      sourceEventId: params.idempotencyKey,
      actorType: params.actorType,
      actorId: params.actorId,
      metadata: {
        reservation_id: resv.id,
        purpose: resv.purpose,
        reference_id: resv.referenceId,
      },
      legs: params.payouts.map((p) => ({
        debitAccountId: resv.escrowAccountId,
        creditAccountId: p.creditAccountId,
        amount: p.amount,
        memo: p.memo,
      })),
    });

    const now = new Date();
    const nextConsumed = resv.consumedAmount + payoutSum;
    const upd = await this.client.query(
      `UPDATE currency_reservations
       SET consumed_amount = $1::bigint,
           resolution_ledger_tx_id = $2::uuid,
           status = 'Consumed',
           version = version + 1,
           updated_at = $3
       WHERE id = $4::uuid AND status = 'Reserved' AND version = $5`,
      [nextConsumed.toString(), ledgerTx.id, now, resv.id, resv.version],
    );
    if (upd.rowCount !== 1) {
      throw new EscrowReservationStateError(
        `Concurrent modification prevented consuming reservation '${resv.id}'.`,
      );
    }

    return {
      reservation: {
        ...resv,
        consumedAmount: nextConsumed,
        resolutionLedgerTxId: ledgerTx.id,
        status: "Consumed",
        version: resv.version + 1,
        updatedAt: now,
      },
      ledgerTx,
    };
  }

  /**
   * Releases or cancels an active `Reserved` reservation back to `ownerWalletId`.
   */
  public async releaseReservationInScope(params: {
    readonly reservationId: string;
    readonly idempotencyKey: string;
    readonly processedEventId: string | null;
    readonly terminalStatus: "Released" | "Cancelled";
    readonly correlationId: string;
    readonly actorType: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<{
    readonly reservation: CurrencyReservation;
    readonly ledgerTx: CurrencyLedgerTransactionRecord;
  }> {
    const locked = await this.lockReservationsCanonical([params.reservationId]);
    const resv = locked.get(params.reservationId.toLowerCase());
    if (!resv) {
      throw new EscrowReservationStateError(`Reservation '${params.reservationId}' not found.`);
    }
    if (resv.status !== "Reserved") {
      throw new EscrowReservationStateError(
        `Reservation '${resv.id}' is already '${resv.status}' and cannot be released.`,
      );
    }
    const available = resv.reservedAmount - resv.consumedAmount - resv.releasedAmount;

    const ledgerTx = await this.executeBalancedLedgerTransaction({
      idempotencyKey: params.idempotencyKey,
      processedEventId: params.processedEventId,
      operationType: params.terminalStatus === "Cancelled" ? "escrow_cancel" : "escrow_release",
      currencyCode: resv.currencyCode,
      correlationId: params.correlationId,
      sourceEventId: params.idempotencyKey,
      actorType: params.actorType,
      actorId: params.actorId,
      metadata: {
        reservation_id: resv.id,
        reason: params.reason,
      },
      legs: [
        {
          debitAccountId: resv.escrowAccountId,
          creditAccountId: resv.ownerWalletId,
          amount: available,
          memo: `Escrow ${params.terminalStatus.toLowerCase()}: ${params.reason}`,
        },
      ],
    });

    const now = new Date();
    const nextReleased = resv.releasedAmount + available;
    const upd = await this.client.query(
      `UPDATE currency_reservations
       SET released_amount = $1::bigint,
           resolution_ledger_tx_id = $2::uuid,
           status = $3,
           version = version + 1,
           updated_at = $4
       WHERE id = $5::uuid AND status = 'Reserved' AND version = $6`,
      [nextReleased.toString(), ledgerTx.id, params.terminalStatus, now, resv.id, resv.version],
    );
    if (upd.rowCount !== 1) {
      throw new EscrowReservationStateError(
        `Concurrent modification prevented releasing reservation '${resv.id}'.`,
      );
    }

    return {
      reservation: {
        ...resv,
        releasedAmount: nextReleased,
        resolutionLedgerTxId: ledgerTx.id,
        status: params.terminalStatus,
        version: resv.version + 1,
        updatedAt: now,
      },
      ledgerTx,
    };
  }

  /**
   * Moves an `in_container` equipment `ItemInstance` into authoritative `'in_escrow'` custody.
   * Rejects bound/non-tradable violations, purges inactive loadout pointers, and writes `item_operation_ledger`.
   */
  public async lockEquipmentInstanceIntoEscrow(params: {
    readonly holdingId: string;
    readonly operationId: string;
    readonly owner: Character;
    readonly itemInstanceId: string;
    readonly purpose: EscrowAssetPurpose;
    readonly referenceId: string;
    readonly allowSameAccountRestrictedAccountId?: string | null | undefined;
  }): Promise<{ readonly holding: EscrowAssetHolding; readonly instance: ItemInstance }> {
    const inst = await this.inventory.lockItemInstanceById(params.itemInstanceId);
    if (!inst) {
      throw new ItemInstanceNotFoundError(params.itemInstanceId);
    }
    if (inst.ownerCharacterId !== params.owner.id) {
      throw new ItemOwnershipForbiddenError(
        `Item '${inst.id}' does not belong to character '${params.owner.id}'.`,
      );
    }
    if (inst.locationState !== "in_container") {
      throw new AssetEscrowCustodyError(
        `Item '${inst.id}' is in location '${inst.locationState}'; only unequipped inventory items can enter escrow.`,
      );
    }

    const def = await this.inventory.findItemDefinition(inst.definitionCode, inst.definitionVersion);
    if (!def) {
      throw new ItemDefinitionNotFoundError(inst.definitionCode, inst.definitionVersion);
    }
    this.assertTradableEligibility({
      definition: def,
      bindingState: inst.bindingState,
      boundAccountId: inst.boundAccountId,
      ownerAccountId: params.owner.accountId,
      purpose: params.purpose,
      allowSameAccountRestrictedAccountId: params.allowSameAccountRestrictedAccountId ?? null,
    });

    await this.inventory.purgeInactiveLoadoutReferencesForItem(params.owner.id, inst.id);

    const now = new Date();
    const escrowed: ItemInstance = {
      ...inst,
      locationState: "in_escrow",
      containerId: null,
      containerSlotIndex: null,
      instanceVersion: inst.instanceVersion + 1,
      updatedAt: now,
    };
    await this.inventory.updateItemInstance(escrowed, inst.instanceVersion);

    await this.client.query(
      `INSERT INTO escrow_asset_holdings (
         id, owner_account_id, owner_character_id, purpose, reference_id,
         asset_kind, item_instance_id, source_stack_id, definition_code, definition_version,
         quantity, remaining_quantity, quality_bp, binding_state,
         bound_account_id, bound_character_id, stack_equivalence_key, status, version, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
         'equipment_instance', $6::uuid, NULL, $7, $8,
         1, 1, $9, $10,
         $11::uuid, $12::uuid, NULL, 'held', 1, $13, $13
       )`,
      [
        params.holdingId,
        params.owner.accountId,
        params.owner.id,
        params.purpose,
        params.referenceId,
        escrowed.id,
        escrowed.definitionCode,
        escrowed.definitionVersion,
        escrowed.qualityBp,
        escrowed.bindingState,
        escrowed.boundAccountId,
        escrowed.boundCharacterId,
        now,
      ],
    );

    await this.inventory.appendLedger({
      operationId: params.operationId,
      operationType: "escrow_lock",
      characterId: params.owner.id,
      itemInstanceId: escrowed.id,
      definitionCode: escrowed.definitionCode,
      definitionVersion: escrowed.definitionVersion,
      sourceLocation: `container:${inst.containerId}:slot:${inst.containerSlotIndex}`,
      destinationLocation: `escrow:${params.purpose}:${params.referenceId}`,
      quantity: 1,
      entityVersion: escrowed.instanceVersion,
      causeReference: params.operationId,
    });

    return {
      holding: {
        id: params.holdingId,
        ownerAccountId: params.owner.accountId,
        ownerCharacterId: params.owner.id,
        purpose: params.purpose,
        referenceId: params.referenceId,
        assetKind: "equipment_instance",
        itemInstanceId: escrowed.id,
        sourceStackId: null,
        definitionCode: escrowed.definitionCode,
        definitionVersion: escrowed.definitionVersion,
        quantity: 1,
        remainingQuantity: 1,
        qualityBp: escrowed.qualityBp,
        bindingState: escrowed.bindingState,
        boundAccountId: escrowed.boundAccountId,
        boundCharacterId: escrowed.boundCharacterId,
        stackEquivalenceKey: null,
        status: "held",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      instance: escrowed,
    };
  }

  /**
   * Physically deducts `quantity` from a specific `InventoryStack` into an `escrow_asset_holdings` row
   * so escrowed materials cannot be crafted, moved, split, merged, or listed twice.
   */
  public async lockMaterialStackIntoEscrow(params: {
    readonly holdingId: string;
    readonly operationId: string;
    readonly owner: Character;
    readonly stackId: string;
    readonly quantity: number;
    readonly purpose: EscrowAssetPurpose;
    readonly referenceId: string;
    readonly allowSameAccountRestrictedAccountId?: string | null | undefined;
  }): Promise<{ readonly holding: EscrowAssetHolding; readonly definition: ItemDefinition }> {
    if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
      throw new StackOperationInvalidError("Escrow stack quantity must be a positive integer.");
    }
    const stacks = await this.inventory.lockStacksInCanonicalOrder([params.stackId]);
    const st = stacks.get(params.stackId);
    if (!st) {
      throw new StackOperationInvalidError(`Stack '${params.stackId}' not found.`);
    }
    if (st.ownerCharacterId !== params.owner.id) {
      throw new ItemOwnershipForbiddenError(
        `Stack '${st.id}' does not belong to character '${params.owner.id}'.`,
      );
    }
    if (st.quantity < params.quantity) {
      throw new StackOperationInvalidError(
        `Stack '${st.id}' only has ${st.quantity} units, cannot lock ${params.quantity} into escrow.`,
      );
    }

    const def = await this.inventory.findItemDefinition(st.definitionCode, st.definitionVersion);
    if (!def) {
      throw new ItemDefinitionNotFoundError(st.definitionCode, st.definitionVersion);
    }
    this.assertTradableEligibility({
      definition: def,
      bindingState: st.bindingState,
      boundAccountId: st.boundAccountId,
      ownerAccountId: params.owner.accountId,
      purpose: params.purpose,
      allowSameAccountRestrictedAccountId: params.allowSameAccountRestrictedAccountId ?? null,
    });

    if (st.quantity === params.quantity) {
      await this.inventory.deleteStack(st.id);
    } else {
      await this.inventory.updateStack(
        {
          ...st,
          quantity: st.quantity - params.quantity,
          version: st.version + 1,
        },
        st.version,
      );
    }

    const now = new Date();
    await this.client.query(
      `INSERT INTO escrow_asset_holdings (
         id, owner_account_id, owner_character_id, purpose, reference_id,
         asset_kind, item_instance_id, source_stack_id, definition_code, definition_version,
         quantity, remaining_quantity, quality_bp, binding_state,
         bound_account_id, bound_character_id, stack_equivalence_key, status, version, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
         'material_stack', NULL, $6::uuid, $7, $8,
         $9, $9, $10, $11,
         $12::uuid, $13::uuid, $14, 'held', 1, $15, $15
       )`,
      [
        params.holdingId,
        params.owner.accountId,
        params.owner.id,
        params.purpose,
        params.referenceId,
        st.id,
        st.definitionCode,
        st.definitionVersion,
        params.quantity,
        st.qualityBp,
        st.bindingState,
        st.boundAccountId,
        st.boundCharacterId,
        st.stackEquivalenceKey,
        now,
      ],
    );

    await this.inventory.appendLedger({
      operationId: params.operationId,
      operationType: "escrow_lock",
      characterId: params.owner.id,
      stackId: st.id,
      definitionCode: st.definitionCode,
      definitionVersion: st.definitionVersion,
      sourceLocation: `container:${st.containerId}:slot:${st.containerSlotIndex}`,
      destinationLocation: `escrow:${params.purpose}:${params.referenceId}`,
      quantity: params.quantity,
      entityVersion: st.version + 1,
      causeReference: params.operationId,
    });

    return {
      holding: {
        id: params.holdingId,
        ownerAccountId: params.owner.accountId,
        ownerCharacterId: params.owner.id,
        purpose: params.purpose,
        referenceId: params.referenceId,
        assetKind: "material_stack",
        itemInstanceId: null,
        sourceStackId: st.id,
        definitionCode: st.definitionCode,
        definitionVersion: st.definitionVersion,
        quantity: params.quantity,
        remainingQuantity: params.quantity,
        qualityBp: st.qualityBp,
        bindingState: st.bindingState,
        boundAccountId: st.boundAccountId,
        boundCharacterId: st.boundCharacterId,
        stackEquivalenceKey: st.stackEquivalenceKey,
        status: "held",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      definition: def,
    };
  }

  private assertTradableEligibility(params: {
    readonly definition: ItemDefinition;
    readonly bindingState: "unbound" | "bind_on_equip" | "account_bound" | "character_bound";
    readonly boundAccountId: string | null;
    readonly ownerAccountId: string;
    readonly purpose: EscrowAssetPurpose;
    readonly allowSameAccountRestrictedAccountId: string | null;
  }): void {
    if (params.definition.tradeCategory === "non_tradable") {
      throw new ItemBindingViolationError(
        `Item '${params.definition.definitionCode}' has tradeCategory='non_tradable' and cannot be traded or listed.`,
      );
    }
    if (params.bindingState === "character_bound") {
      throw new ItemBindingViolationError(
        `Item '${params.definition.definitionCode}' is character_bound and cannot be traded or listed.`,
      );
    }
    if (params.purpose === "market_listing") {
      if (params.bindingState === "account_bound" || params.definition.tradeCategory === "restricted") {
        throw new ItemBindingViolationError(
          `Account-bound or restricted item '${params.definition.definitionCode}' cannot be listed on the public regional market.`,
        );
      }
      return;
    }

    // For player_trade: account_bound or restricted items are only permitted between characters of the SAME account
    if (params.bindingState === "account_bound" || params.definition.tradeCategory === "restricted") {
      if (
        !params.allowSameAccountRestrictedAccountId ||
        params.allowSameAccountRestrictedAccountId.toLowerCase() !==
          params.ownerAccountId.toLowerCase()
      ) {
        throw new ItemBindingViolationError(
          `Item '${params.definition.definitionCode}' (${params.bindingState}/${params.definition.tradeCategory}) cannot be traded across different accounts.`,
        );
      }
    }
  }

  /**
   * Delivers `deliverQuantity` (up to `holding.remainingQuantity`) from an active `'held'` escrow holding
   * into `recipient`'s `character_inventory` (or `personal_storage` ONLY when `allowPersonalStorageFallback === true`
   * during owner release/cancel). Throws `InventoryCapacityExceededError` on full bag so ZERO items are ever lost!
   */
  public async deliverFromEscrowHolding(params: {
    readonly holdingId: string;
    readonly deliverQuantity: number;
    readonly recipient: Character;
    readonly mode: "settle_to_recipient" | "release_to_owner";
    readonly operationId: string;
    readonly allowPersonalStorageFallback?: boolean | undefined;
  }): Promise<{
    readonly updatedHolding: EscrowAssetHolding;
    readonly deliveredInstance: ItemInstance | null;
    readonly deliveredStacks: ReadonlyArray<InventoryStack>;
  }> {
    const holdings = await this.lockEscrowHoldingsCanonical([params.holdingId]);
    const holding = holdings.get(params.holdingId.toLowerCase());
    if (!holding || holding.status !== "held") {
      throw new AssetEscrowCustodyError(
        `Escrow holding '${params.holdingId}' is not active ('${holding?.status ?? "missing"}').`,
      );
    }
    if (params.deliverQuantity <= 0 || params.deliverQuantity > holding.remainingQuantity) {
      throw new AssetEscrowCustodyError(
        `Invalid deliverQuantity ${params.deliverQuantity} for holding '${holding.id}' (remaining=${holding.remainingQuantity}).`,
      );
    }

    const genRules = (await this.inventory.loadGenerationRules(1))!;
    const { bag } = await this.inventory.ensureAndLockPrimaryContainers(
      params.recipient.id,
      genRules.defaultInventoryCapacity,
    );

    const now = new Date();
    const nextRemaining = holding.remainingQuantity - params.deliverQuantity;
    const nextStatus: EscrowHoldingStatus =
      nextRemaining > 0
        ? "held"
        : params.mode === "release_to_owner"
          ? "released"
          : "settled";

    let deliveredInstance: ItemInstance | null = null;
    const deliveredStacks: InventoryStack[] = [];

    if (holding.assetKind === "equipment_instance") {
      const inst = await this.inventory.lockItemInstanceById(holding.itemInstanceId!);
      if (!inst || inst.locationState !== "in_escrow") {
        throw new AssetEscrowCustodyError(
          `Escrowed ItemInstance '${holding.itemInstanceId}' missing or not in_escrow.`,
        );
      }

      let targetContainer: InventoryContainer = bag;
      let freeSlots = await this.inventory.findFreeContainerSlots(bag, 1);
      if (freeSlots.length < 1 && params.allowPersonalStorageFallback === true) {
        const storage = await this.inventory.ensureAndLockContainerByType(
          params.recipient.id,
          "personal_storage",
          60,
        );
        freeSlots = await this.inventory.findFreeContainerSlots(storage, 1);
        targetContainer = storage;
      }
      if (freeSlots.length < 1) {
        throw new InventoryCapacityExceededError(
          `Character '${params.recipient.id}' does not have free inventory capacity to receive item '${inst.definitionCode}'.`,
        );
      }

      deliveredInstance = {
        ...inst,
        ownerAccountId: params.recipient.accountId,
        ownerCharacterId: params.recipient.id,
        locationState: "in_container",
        containerId: targetContainer.id,
        containerSlotIndex: freeSlots[0]!,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await this.inventory.updateItemInstance(deliveredInstance, inst.instanceVersion);

      await this.inventory.appendLedger({
        operationId: params.operationId,
        operationType: params.mode === "release_to_owner" ? "escrow_release" : "escrow_settle",
        characterId: params.recipient.id,
        counterpartyCharacterId:
          holding.ownerCharacterId !== params.recipient.id ? holding.ownerCharacterId : null,
        itemInstanceId: deliveredInstance.id,
        definitionCode: deliveredInstance.definitionCode,
        definitionVersion: deliveredInstance.definitionVersion,
        sourceLocation: `escrow:${holding.purpose}:${holding.referenceId}`,
        destinationLocation: `container:${targetContainer.id}:slot:${freeSlots[0]!}`,
        quantity: 1,
        entityVersion: deliveredInstance.instanceVersion,
        causeReference: params.operationId,
      });
    } else {
      const def = await this.inventory.findItemDefinition(
        holding.definitionCode,
        holding.definitionVersion,
      );
      if (!def) {
        throw new ItemDefinitionNotFoundError(holding.definitionCode, holding.definitionVersion);
      }

      const recipientBoundAcc =
        holding.bindingState === "account_bound" ? params.recipient.accountId : null;
      const recipientBoundChar =
        holding.bindingState === "character_bound" ? params.recipient.id : null;
      const eqKey = buildStackEquivalenceKey({
        definitionCode: holding.definitionCode,
        definitionVersion: holding.definitionVersion,
        qualityBp: holding.qualityBp,
        bindingState:
          holding.bindingState === "bind_on_equip" ? "unbound" : holding.bindingState,
        boundAccountId: recipientBoundAcc,
        boundCharacterId: recipientBoundChar,
      });

      const placed = await this.deliverStackQuantityToCharacterContainers({
        recipient: params.recipient,
        primaryBag: bag,
        definition: def,
        quantity: params.deliverQuantity,
        qualityBp: holding.qualityBp,
        bindingState: holding.bindingState === "bind_on_equip" ? "unbound" : holding.bindingState,
        boundAccountId: recipientBoundAcc,
        boundCharacterId: recipientBoundChar,
        equivalenceKey: eqKey,
        allowPersonalStorageFallback: params.allowPersonalStorageFallback === true,
        seedPrefix: `${params.operationId}:${holding.id}`,
      });
      deliveredStacks.push(...placed);

      await this.inventory.appendLedger({
        operationId: params.operationId,
        operationType: params.mode === "release_to_owner" ? "escrow_release" : "escrow_settle",
        characterId: params.recipient.id,
        counterpartyCharacterId:
          holding.ownerCharacterId !== params.recipient.id ? holding.ownerCharacterId : null,
        stackId: placed[0]?.id ?? null,
        definitionCode: holding.definitionCode,
        definitionVersion: holding.definitionVersion,
        sourceLocation: `escrow:${holding.purpose}:${holding.referenceId}`,
        destinationLocation: `char:${params.recipient.id}:inventory`,
        quantity: params.deliverQuantity,
        entityVersion: placed[0]?.version ?? 1,
        causeReference: params.operationId,
      });
    }

    const upd = await this.client.query(
      `UPDATE escrow_asset_holdings
       SET remaining_quantity = $1,
           status = $2,
           version = version + 1,
           updated_at = $3
       WHERE id = $4::uuid AND version = $5`,
      [nextRemaining, nextStatus, now, holding.id, holding.version],
    );
    if (upd.rowCount !== 1) {
      throw new AssetEscrowCustodyError(
        `Concurrent version conflict updating EscrowAssetHolding '${holding.id}'.`,
      );
    }

    return {
      updatedHolding: {
        ...holding,
        remainingQuantity: nextRemaining,
        status: nextStatus,
        version: holding.version + 1,
        updatedAt: now,
      },
      deliveredInstance,
      deliveredStacks,
    };
  }

  public async deliverStackQuantityToCharacterContainers(params: {
    readonly recipient: Character;
    readonly primaryBag: InventoryContainer;
    readonly definition: ItemDefinition;
    readonly quantity: number;
    readonly qualityBp: number;
    readonly bindingState: "unbound" | "account_bound" | "character_bound";
    readonly boundAccountId: string | null;
    readonly boundCharacterId: string | null;
    readonly equivalenceKey: string;
    readonly allowPersonalStorageFallback: boolean;
    readonly seedPrefix: string;
  }): Promise<ReadonlyArray<InventoryStack>> {
    let remaining = params.quantity;
    const touched: InventoryStack[] = [];

    const tryFillContainer = async (container: InventoryContainer, tag: string): Promise<void> => {
      if (remaining <= 0) {
        return;
      }
      const existingCompat = await this.inventory.listCompatibleStacksInContainer(
        container.id,
        params.equivalenceKey,
      );
      for (const st of existingCompat) {
        if (remaining <= 0) {
          break;
        }
        const room = params.definition.maxStackSize - st.quantity;
        if (room <= 0) {
          continue;
        }
        const add = Math.min(room, remaining);
        const updated: InventoryStack = {
          ...st,
          quantity: st.quantity + add,
          version: st.version + 1,
        };
        await this.inventory.updateStack(updated, st.version);
        touched.push(updated);
        remaining -= add;
      }

      if (remaining > 0) {
        const neededSlots = Math.ceil(remaining / params.definition.maxStackSize);
        const freeSlots = await this.inventory.findFreeContainerSlots(container, neededSlots);
        for (let i = 0; i < freeSlots.length && remaining > 0; i++) {
          const chunk = Math.min(params.definition.maxStackSize, remaining);
          const created: InventoryStack = {
            id: deriveDeterministicEventUuid(`${params.seedPrefix}:${tag}:${i}`),
            containerId: container.id,
            ownerCharacterId: params.recipient.id,
            containerSlotIndex: freeSlots[i]!,
            definitionCode: params.definition.definitionCode,
            definitionVersion: params.definition.definitionVersion,
            quantity: chunk,
            qualityBp: params.qualityBp,
            bindingState: params.bindingState,
            boundAccountId: params.boundAccountId,
            boundCharacterId: params.boundCharacterId,
            stackEquivalenceKey: params.equivalenceKey,
            version: 1,
          };
          await this.inventory.insertStack(created);
          touched.push(created);
          remaining -= chunk;
        }
      }
    };

    await tryFillContainer(params.primaryBag, "bag");
    if (remaining > 0 && params.allowPersonalStorageFallback) {
      const storage = await this.inventory.ensureAndLockContainerByType(
        params.recipient.id,
        "personal_storage",
        60,
      );
      await tryFillContainer(storage, "storage");
    }

    if (remaining > 0) {
      throw new InventoryCapacityExceededError(
        `Character '${params.recipient.id}' lacks container space for ${remaining} remaining unit(s) of '${params.definition.definitionCode}'.`,
      );
    }

    return touched;
  }

  /**
   * Atomically consumes required stackable materials from `character`'s primary `character_inventory`.
   * If ANY material is missing or insufficient, throws `CraftingOrProfessionError` and rolls back all deductions!
   */
  public async consumeMaterialsFromCharacterBag(params: {
    readonly character: Character;
    readonly bag: InventoryContainer;
    readonly requirements: ReadonlyArray<{
      readonly definitionCode: string;
      readonly definitionVersion: number;
      readonly quantity: number;
    }>;
    readonly operationId: string;
    readonly causeReference: string;
  }): Promise<
    ReadonlyArray<{
      readonly definitionCode: string;
      readonly quantity: number;
      readonly averageQualityBp: number;
    }>
  > {
    const consumedSummary: Array<{
      readonly definitionCode: string;
      readonly quantity: number;
      readonly averageQualityBp: number;
    }> = [];

    // Lock all stacks in the character's primary bag in canonical ID order so deductions are deadlock-free
    const bagStackIdsRes = await this.client.query<{ id: string }>(
      `SELECT id FROM inventory_stacks WHERE container_id = $1::uuid ORDER BY id ASC FOR UPDATE`,
      [params.bag.id],
    );
    const allStacks =
      bagStackIdsRes.rows.length > 0
        ? await this.inventory.lockStacksInCanonicalOrder(bagStackIdsRes.rows.map((r) => r.id))
        : new Map<string, InventoryStack>();

    const orderedStacks = Array.from(allStacks.values()).sort(
      (a, b) => a.containerSlotIndex - b.containerSlotIndex,
    );

    for (const req of params.requirements) {
      const matching = orderedStacks.filter(
        (s) =>
          s.definitionCode === req.definitionCode && s.definitionVersion === req.definitionVersion,
      );
      const totalAvailable = matching.reduce((acc, s) => acc + s.quantity, 0);
      if (totalAvailable < req.quantity) {
        throw new CraftingOrProfessionError(
          `Insufficient material '${req.definitionCode}' v${req.definitionVersion}: required ${req.quantity}, available ${totalAvailable}.`,
        );
      }

      let needed = req.quantity;
      let weightedQualitySum = 0;
      for (const st of matching) {
        if (needed <= 0) {
          break;
        }
        const take = Math.min(st.quantity, needed);
        weightedQualitySum += take * st.qualityBp;
        if (take === st.quantity) {
          await this.inventory.deleteStack(st.id);
        } else {
          await this.inventory.updateStack(
            {
              ...st,
              quantity: st.quantity - take,
              version: st.version + 1,
            },
            st.version,
          );
        }

        await this.inventory.appendLedger({
          operationId: params.operationId,
          operationType: "consume",
          characterId: params.character.id,
          stackId: st.id,
          definitionCode: st.definitionCode,
          definitionVersion: st.definitionVersion,
          sourceLocation: `container:${st.containerId}:slot:${st.containerSlotIndex}`,
          destinationLocation: params.causeReference,
          quantity: take,
          entityVersion: st.version + 1,
          causeReference: params.operationId,
        });

        needed -= take;
      }

      consumedSummary.push({
        definitionCode: req.definitionCode,
        quantity: req.quantity,
        averageQualityBp: Math.floor(weightedQualitySum / req.quantity),
      });
    }

    return consumedSummary;
  }

  public async enqueueEconomyOutbox(params: {
    readonly aggregateType:
      | "CurrencyAccount"
      | "CurrencyReservation"
      | "TradeSession"
      | "MarketListing"
      | "NpcMerchant"
      | "RewardGrant"
      | "CraftingOperation"
      | "CriminalBounty";
    readonly aggregateId: string;
    readonly eventType: EconomyOutboxEventType;
    readonly correlationUuid: string;
    readonly causationEventUuid: string;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_events (
         id, aggregate_type, aggregate_id, event_type, event_version,
         correlation_id, causation_event_id, payload, occurred_at
       )
       VALUES ($1::uuid, $2, $3::uuid, $4, 1, $5::uuid, $6::uuid, $7::jsonb, $8)`,
      [
        randomUUID(),
        params.aggregateType,
        params.aggregateId,
        params.eventType,
        params.correlationUuid,
        params.causationEventUuid,
        JSON.stringify(params.payload),
        params.occurredAt,
      ],
    );
  }
}

export class PostgresEconomyUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: PgEconomyTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgEconomyTransactionScope(this.pool, client);
      return work(scope);
    });
  }
}

export class PostgresEconomyRepository implements ValueLedgerPort {
  private readonly pool: PgPool;
  private readonly uow: PostgresEconomyUnitOfWork;

  constructor(pool: PgPool) {
    this.pool = pool;
    this.uow = new PostgresEconomyUnitOfWork(pool);
  }

  /**
   * Seeds all versioned Session 07 catalogs idempotently across applied migrations (`0013..0015`).
   */
  public async seedInitialEconomyCatalogs(
    rules: EconomicRulesConfig = DEFAULT_ECONOMIC_RULES_V1,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO economic_rules_versions (
         rules_version, code, default_market_listing_fee_bp, default_market_sale_tax_bp,
         max_tax_rate_bp, default_repair_cost_per_durability, repair_treasury_share_bp,
         crafting_station_tax_treasury_share_bp, bounty_escrow_currency_code, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10)
       ON CONFLICT (rules_version) DO UPDATE
         SET default_market_listing_fee_bp = EXCLUDED.default_market_listing_fee_bp,
             default_market_sale_tax_bp = EXCLUDED.default_market_sale_tax_bp,
             max_tax_rate_bp = EXCLUDED.max_tax_rate_bp`,
      [
        rules.rulesVersion,
        rules.code,
        rules.defaultMarketListingFeeBp,
        rules.defaultMarketSaleTaxBp,
        rules.maxTaxRateBp,
        rules.defaultRepairCostPerDurability.toString(),
        rules.repairTreasuryShareBp,
        rules.craftingStationTaxTreasuryShareBp,
        rules.bountyEscrowCurrencyCode,
        rules.isActive,
      ],
    );

    for (const c of INITIAL_CURRENCIES_CATALOG) {
      await this.pool.query(
        `INSERT INTO currencies (
           currency_code, display_name, description, smallest_unit_name, denomination_notes,
           maximum_balance, is_tradeable, is_transferable, is_enabled, rules_version
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::bigint, $7, $8, $9, $10)
         ON CONFLICT (currency_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               maximum_balance = EXCLUDED.maximum_balance,
               is_tradeable = EXCLUDED.is_tradeable,
               is_transferable = EXCLUDED.is_transferable,
               is_enabled = EXCLUDED.is_enabled`,
        [
          c.currencyCode,
          c.displayName,
          c.description,
          c.smallestUnitName,
          JSON.stringify(c.denominationNotes),
          c.maximumBalance.toString(),
          c.isTradeable,
          c.isTransferable,
          c.isEnabled,
          c.rulesVersion,
        ],
      );

      if (c.isEnabled) {
        for (const [ownerType, ownerId] of [
          ["system_mint", "canonical_mint"],
          ["system_sink", "canonical_sink"],
          ["escrow_account", "canonical_escrow_pool"],
        ] as const) {
          const detId = deriveDeterministicEventUuid(`tech:${ownerType}:${c.currencyCode}`);
          await this.pool.query(
            `INSERT INTO currency_accounts (id, owner_type, owner_id, currency_code, balance, version, status)
             VALUES ($1::uuid, $2, $3, $4, 0, 1, 'active')
             ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING`,
            [detId, ownerType, ownerId, c.currencyCode],
          );
        }
      }
    }

    const hasMarketTables = await this.tableExists("regional_tax_policies");
    if (hasMarketTables) {
      const stRows = await this.pool.query<{ id: string; external_id: string }>(
        "SELECT id, external_id FROM settlements WHERE external_id IS NOT NULL",
      );
      const stByExt = new Map<string, string>();
      for (const sr of stRows.rows) {
        stByExt.set(sr.external_id, sr.id);
      }

      for (const tp of INITIAL_REGIONAL_TAX_POLICIES) {
        const stId = stByExt.get(tp.settlementExternalId);
        if (!stId) {
          continue;
        }
        await this.pool.query(
          `INSERT INTO regional_tax_policies (
             settlement_id, policy_version, listing_fee_bp, sale_tax_bp,
             crafting_tax_bp, repair_tax_bp, sink_burn_share_bp, rounding_mode, is_active, rules_version
           )
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (settlement_id, policy_version) DO NOTHING`,
          [
            stId,
            tp.policyVersion,
            tp.listingFeeBp,
            tp.saleTaxBp,
            tp.craftingTaxBp,
            tp.repairTaxBp,
            tp.sinkBurnShareBp,
            tp.roundingMode,
            tp.isActive,
            tp.rulesVersion,
          ],
        );

        const trId = deterministicSettlementTreasuryId(stId, "ascendra_coin");
        await this.pool.query(
          `INSERT INTO currency_accounts (
             id, owner_type, owner_id, owner_settlement_id, currency_code, balance, version, status
           )
           VALUES ($1::uuid, 'settlement_treasury', $2, $3::uuid, 'ascendra_coin', 0, 1, 'active')
           ON CONFLICT (owner_type, owner_id, currency_code) DO NOTHING`,
          [trId, stId.toLowerCase(), stId],
        );
      }

      for (const m of INITIAL_NPC_MERCHANTS_CATALOG) {
        const stId = stByExt.get(m.settlementExternalId);
        if (!stId) {
          continue;
        }
        let walletId: string | null = null;
        if (m.fundingMode === "treasury_backed") {
          const wRes = await this.pool.query<{ id: string }>(
            `SELECT id FROM currency_accounts
             WHERE owner_type = 'settlement_treasury' AND owner_settlement_id = $1::uuid AND currency_code = 'ascendra_coin'`,
            [stId],
          );
          walletId = wRes.rows[0]?.id ?? null;
        } else {
          const mwId = deterministicMerchantWalletId(m.merchantCode, "ascendra_coin");
          const insW = await this.pool.query<{ id: string }>(
            `INSERT INTO currency_accounts (
               id, owner_type, owner_id, currency_code, balance, version, status
             )
             VALUES ($1::uuid, 'merchant_account', $2, 'ascendra_coin', 0, 1, 'active')
             ON CONFLICT (owner_type, owner_id, currency_code) DO UPDATE SET currency_code = EXCLUDED.currency_code
             RETURNING id`,
            [mwId, m.merchantCode],
          );
          walletId = insW.rows[0]!.id;
        }

        await this.pool.query(
          `INSERT INTO npc_merchants (
             merchant_code, display_name, settlement_id, funding_mode, wallet_id,
             daily_buyback_budget_cap, daily_buyback_spent, is_enabled, rules_version, version
           )
           VALUES ($1, $2, $3::uuid, $4, $5::uuid, $6::bigint, $7::bigint, $8, $9, 1)
           ON CONFLICT (merchant_code) DO NOTHING`,
          [
            m.merchantCode,
            m.displayName,
            stId,
            m.fundingMode,
            walletId,
            m.dailyBuybackBudgetCap.toString(),
            m.dailyBuybackSpent.toString(),
            m.isEnabled,
            m.rulesVersion,
          ],
        );
      }

      for (const off of INITIAL_NPC_OFFERS_CATALOG) {
        const hasMerchant = await this.pool.query<{ ok: number }>(
          "SELECT 1 AS ok FROM npc_merchants WHERE merchant_code = $1",
          [off.merchantCode],
        );
        if ((hasMerchant.rowCount ?? 0) === 0) {
          continue;
        }
        const offerId = deriveDeterministicEventUuid(
          `npc-offer:${off.merchantCode}:${off.offerCode}`,
        );
        await this.pool.query(
          `INSERT INTO npc_merchant_offers (
             id, merchant_code, offer_code, offer_kind, definition_code, definition_version,
             currency_code, unit_price, stock_mode, current_stock, max_stock, is_enabled, version
           )
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11, $12, 1)
           ON CONFLICT (merchant_code, offer_code) DO NOTHING`,
          [
            offerId,
            off.merchantCode,
            off.offerCode,
            off.offerKind,
            off.definitionCode,
            off.definitionVersion,
            off.currencyCode,
            off.unitPrice.toString(),
            off.stockMode,
            off.currentStock,
            off.maxStock,
            off.isEnabled,
          ],
        );
      }
    }

    const hasLootAndCrafting = await this.tableExists("loot_tables");
    if (hasLootAndCrafting) {
      for (const frag of INITIAL_ANTI_BAD_LUCK_FRAGMENTS_CATALOG) {
        await this.pool.query(
          `INSERT INTO anti_bad_luck_fragments (
             fragment_code, display_name, source_content_ref, binding_policy,
             redemption_cost, reward_pool, is_enabled, rules_version
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (fragment_code) DO UPDATE
             SET redemption_cost = EXCLUDED.redemption_cost,
                 reward_pool = EXCLUDED.reward_pool,
                 is_enabled = EXCLUDED.is_enabled`,
          [
            frag.fragmentCode,
            frag.displayName,
            frag.sourceContentRef,
            frag.bindingPolicy,
            frag.redemptionCost,
            JSON.stringify(frag.rewardPool),
            frag.isEnabled,
            frag.rulesVersion,
          ],
        );
      }

      for (const lt of INITIAL_LOOT_TABLES_CATALOG) {
        validateLootTableDefinition(lt);
        await this.pool.query(
          `INSERT INTO loot_tables (
             loot_table_code, loot_table_version, display_name, source_category,
             guaranteed_fragment_code, guaranteed_fragment_qty, rolls_count, is_enabled, rules_version
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (loot_table_code, loot_table_version) DO NOTHING`,
          [
            lt.lootTableCode,
            lt.lootTableVersion,
            lt.displayName,
            lt.sourceCategory,
            lt.guaranteedFragmentCode,
            lt.guaranteedFragmentQty,
            lt.rollsCount,
            lt.isEnabled,
            lt.rulesVersion,
          ],
        );
        for (const ent of lt.entries) {
          const entryId = deriveDeterministicEventUuid(
            `loot-entry:${lt.lootTableCode}:v${lt.lootTableVersion}:${ent.entryCode}`,
          );
          await this.pool.query(
            `INSERT INTO loot_table_entries (
               id, loot_table_code, loot_table_version, entry_code, entry_kind,
               item_definition_code, item_definition_version, currency_code,
               weight, min_quantity, max_quantity, allowed_rarities, rarity_weights,
               min_item_level, max_item_level
             )
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)
             ON CONFLICT (loot_table_code, loot_table_version, entry_code) DO NOTHING`,
            [
              entryId,
              lt.lootTableCode,
              lt.lootTableVersion,
              ent.entryCode,
              ent.entryKind,
              ent.itemDefinitionCode,
              ent.itemDefinitionVersion,
              ent.currencyCode,
              ent.weight,
              ent.minQuantity,
              ent.maxQuantity,
              JSON.stringify(ent.allowedRarities),
              JSON.stringify(ent.rarityWeights),
              ent.minItemLevel,
              ent.maxItemLevel,
            ],
          );
        }
      }

      for (const prof of INITIAL_PROFESSIONS_CATALOG) {
        await this.pool.query(
          `INSERT INTO profession_definitions (
             profession_code, display_name, category, max_level, is_enabled, rules_version
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (profession_code) DO UPDATE
             SET is_enabled = EXCLUDED.is_enabled,
                 max_level = EXCLUDED.max_level`,
          [
            prof.professionCode,
            prof.displayName,
            prof.category,
            prof.maxLevel,
            prof.isEnabled,
            prof.rulesVersion,
          ],
        );
      }

      for (const rec of INITIAL_CRAFTING_RECIPES_CATALOG) {
        await this.pool.query(
          `INSERT INTO crafting_recipes (
             recipe_code, recipe_version, display_name, required_profession_code,
             required_mastery_level, required_station_code, required_materials,
             currency_code, currency_cost, output_definition_code, output_definition_version,
             output_quantity, allowed_rarities, min_quality_bp, max_quality_bp,
             profession_xp_granted, is_enabled, rules_version
           )
           VALUES (
             $1, $2, $3, $4,
             $5, $6, $7::jsonb,
             $8, $9::bigint, $10, $11,
             $12, $13::jsonb, $14, $15,
             $16::bigint, $17, $18
           )
           ON CONFLICT (recipe_code, recipe_version) DO NOTHING`,
          [
            rec.recipeCode,
            rec.recipeVersion,
            rec.displayName,
            rec.requiredProfessionCode,
            rec.requiredMasteryLevel,
            rec.requiredStationCode,
            JSON.stringify(rec.requiredMaterials),
            rec.currencyCode,
            rec.currencyCost.toString(),
            rec.outputDefinitionCode,
            rec.outputDefinitionVersion,
            rec.outputQuantity,
            JSON.stringify(rec.allowedRarities),
            rec.minQualityBp,
            rec.maxQualityBp,
            rec.professionXpGranted.toString(),
            rec.isEnabled,
            rec.rulesVersion,
          ],
        );
      }

      if (await this.tableExists("title_definitions")) {
        for (const td of SESSION_07_ECONOMY_TITLES_V2) {
          validateTitleConditionAst(td.requirements);
          await this.pool.query(
            `INSERT INTO title_definitions (
               title_code, title_version, display_name, description, category, rarity,
               persistence_mode, exclusivity_scope, visibility, stackability_policy,
               revocable, is_enabled, origin_summary, requirements, rules_version
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
             ON CONFLICT (title_code) DO UPDATE
               SET title_version = EXCLUDED.title_version,
                   description = EXCLUDED.description,
                   visibility = EXCLUDED.visibility,
                   is_enabled = EXCLUDED.is_enabled,
                   origin_summary = EXCLUDED.origin_summary,
                   requirements = EXCLUDED.requirements,
                   rules_version = EXCLUDED.rules_version`,
            [
              td.titleCode,
              td.titleVersion,
              td.displayName,
              td.description,
              td.category,
              td.rarity,
              td.persistenceMode,
              td.exclusivityScope,
              td.visibility,
              td.stackabilityPolicy,
              td.revocable,
              td.isEnabled,
              td.originSummary,
              JSON.stringify(td.requirements),
              td.rulesVersion,
            ],
          );
        }
      }
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const res = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1
       ) AS present`,
      [tableName],
    );
    return res.rows[0]?.present === true;
  }

  public async recordMovement(input: LedgerMovementInput): Promise<LedgerEntry> {
    return this.uow.executeInTransaction(async (scope) => {
      const existing = await scope.findLedgerTransactionByIdempotencyKey(input.idempotencyKey);
      if (existing && existing.entries[0]) {
        return {
          ...input,
          id: existing.entries[0].id,
        };
      }

      const resolveAccountId = async (ref: LedgerMovementInput["source"]): Promise<string> => {
        if (ref.accountType === "player" || ref.accountType === "player_wallet") {
          return scope.ensurePlayerWalletId(ref.accountId, input.currencyCode);
        }
        if (ref.accountType === "settlement_treasury") {
          return scope.ensureSettlementTreasuryId(ref.accountId, input.currencyCode);
        }
        if (ref.accountType === "faction_treasury") {
          return scope.ensureFactionTreasuryId(ref.accountId, input.currencyCode);
        }
        if (ref.accountType === "system_mint") {
          return scope.ensureCanonicalTechnicalAccountId("system_mint", input.currencyCode);
        }
        if (ref.accountType === "system_sink") {
          return scope.ensureCanonicalTechnicalAccountId("system_sink", input.currencyCode);
        }
        if (ref.accountType === "escrow_account") {
          return scope.ensureCanonicalTechnicalAccountId("escrow_account", input.currencyCode);
        }
        return ref.accountId;
      };

      const debitId = await resolveAccountId(input.source);
      const creditId = await resolveAccountId(input.destination);
      const opType: MonetaryOperationType =
        input.source.accountType === "system_mint"
          ? "currency_mint"
          : input.destination.accountType === "system_sink"
            ? "currency_sink"
            : "currency_transfer";

      const tx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: input.idempotencyKey,
        operationType: opType,
        currencyCode: input.currencyCode,
        correlationId: input.correlationId,
        sourceEventId: input.idempotencyKey,
        actorType: "value_ledger_port",
        actorId: "internal",
        legs: [
          {
            debitAccountId: debitId,
            creditAccountId: creditId,
            amount: input.amount,
            memo: input.reason,
          },
        ],
      });
      return {
        ...input,
        id: tx.entries[0]!.id,
      };
    });
  }

  public async queryLedgerEntries(
    query: PaginatedLedgerQuery,
  ): Promise<ReadonlyArray<CurrencyLedgerEntryRecord>> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const afterSeq = query.afterLedgerEntrySeq ?? 0n;

    const params: unknown[] = [afterSeq.toString(), safeLimit];
    const predicates: string[] = ["ledger_entry_seq > $1::bigint"];

    if (query.walletId) {
      params.push(query.walletId);
      predicates.push(
        `(debit_account_id = $${params.length}::uuid OR credit_account_id = $${params.length}::uuid)`,
      );
    }
    if (query.currencyCode) {
      params.push(query.currencyCode);
      predicates.push(`currency_code = $${params.length}`);
    }

    const res = await this.pool.query<{
      id: string;
      ledger_entry_seq: string;
      transaction_id: string;
      entry_ordinal: number;
      debit_account_id: string;
      credit_account_id: string;
      currency_code: string;
      amount: string;
      debit_balance_after: string;
      credit_balance_after: string;
      memo: string;
      recorded_at: Date;
    }>(
      `SELECT * FROM currency_ledger_entries
       WHERE ${predicates.join(" AND ")}
       ORDER BY ledger_entry_seq ASC
       LIMIT $2`,
      params,
    );

    return res.rows.map((e) => ({
      id: e.id,
      ledgerEntrySeq: BigInt(e.ledger_entry_seq),
      transactionId: e.transaction_id,
      entryOrdinal: e.entry_ordinal,
      debitAccountId: e.debit_account_id,
      creditAccountId: e.credit_account_id,
      currencyCode: e.currency_code,
      amount: BigInt(e.amount),
      debitBalanceAfter: BigInt(e.debit_balance_after),
      creditBalanceAfter: BigInt(e.credit_balance_after),
      memo: e.memo,
      recordedAt: e.recorded_at,
    }));
  }

  public async getTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CurrencyLedgerTransactionRecord | null> {
    return this.uow.executeInTransaction((scope) =>
      scope.findLedgerTransactionByIdempotencyKey(idempotencyKey),
    );
  }

  public async getPlayerWallet(
    characterId: string,
    currencyCode = "ascendra_coin",
  ): Promise<CurrencyAccount | null> {
    const res = await this.pool.query<CurrencyAccountRow>(
      `SELECT * FROM currency_accounts
       WHERE owner_type = 'player_wallet' AND owner_character_id = $1::uuid AND currency_code = $2`,
      [characterId, currencyCode],
    );
    return res.rows[0] ? mapCurrencyAccountRow(res.rows[0]) : null;
  }

  public async getSettlementTreasury(
    settlementId: string,
    currencyCode = "ascendra_coin",
  ): Promise<CurrencyAccount | null> {
    const res = await this.pool.query<CurrencyAccountRow>(
      `SELECT * FROM currency_accounts
       WHERE owner_type = 'settlement_treasury' AND owner_settlement_id = $1::uuid AND currency_code = $2`,
      [settlementId, currencyCode],
    );
    return res.rows[0] ? mapCurrencyAccountRow(res.rows[0]) : null;
  }

  /**
   * Reconciles every `currency_accounts` row and overall money supply against `currency_ledger_entries`
   * inside a `REPEATABLE READ READ ONLY` snapshot transaction so concurrent writes cannot skew totals!
   */
  public async reconcileCurrency(currencyCode: string): Promise<CurrencyReconciliationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const accRes = await client.query<CurrencyAccountRow>(
        "SELECT * FROM currency_accounts WHERE currency_code = $1 ORDER BY id ASC",
        [currencyCode],
      );
      const entriesRes = await client.query<{
        debit_account_id: string;
        credit_account_id: string;
        amount: string;
      }>("SELECT debit_account_id, credit_account_id, amount::text FROM currency_ledger_entries WHERE currency_code = $1", [
        currencyCode,
      ]);

      const resvRes = await client.query<{ unresolved: string }>(
        `SELECT COALESCE(SUM(reserved_amount - consumed_amount - released_amount), 0)::text AS unresolved
         FROM currency_reservations
         WHERE currency_code = $1 AND status = 'Reserved'`,
        [currencyCode],
      );
      await client.query("COMMIT");

      const debitsByAcc = new Map<string, bigint>();
      const creditsByAcc = new Map<string, bigint>();
      let totalLedgerDebits = 0n;
      let totalLedgerCredits = 0n;

      for (const e of entriesRes.rows) {
        const amt = BigInt(e.amount);
        totalLedgerDebits += amt;
        totalLedgerCredits += amt;
        debitsByAcc.set(e.debit_account_id, (debitsByAcc.get(e.debit_account_id) ?? 0n) + amt);
        creditsByAcc.set(e.credit_account_id, (creditsByAcc.get(e.credit_account_id) ?? 0n) + amt);
      }

      let totalMinted = 0n;
      let totalDestroyed = 0n;
      let actualCirculatingSupply = 0n;
      let activeEscrowBalance = 0n;
      const discrepancies: Array<{
        readonly accountId: string;
        readonly ownerType: CurrencyAccountOwnerType;
        readonly storedBalance: bigint;
        readonly reconstructedBalance: bigint;
      }> = [];

      for (const raw of accRes.rows) {
        const acc = mapCurrencyAccountRow(raw);
        const deb = debitsByAcc.get(acc.id) ?? 0n;
        const cred = creditsByAcc.get(acc.id) ?? 0n;

        let expectedAccountBalance: bigint;
        if (acc.ownerType === "system_mint") {
          expectedAccountBalance = deb - cred;
          totalMinted += acc.balance;
        } else if (acc.ownerType === "system_sink") {
          expectedAccountBalance = cred - deb;
          totalDestroyed += acc.balance;
        } else {
          expectedAccountBalance = cred - deb;
          actualCirculatingSupply += acc.balance;
          if (acc.ownerType === "escrow_account") {
            activeEscrowBalance += acc.balance;
          }
        }

        if (acc.balance !== expectedAccountBalance) {
          discrepancies.push({
            accountId: acc.id,
            ownerType: acc.ownerType,
            storedBalance: acc.balance,
            reconstructedBalance: expectedAccountBalance,
          });
        }
      }

      const expectedCirculatingSupply = totalMinted - totalDestroyed;
      const activeReservationsUnresolvedSum = BigInt(resvRes.rows[0]?.unresolved ?? "0");
      const isBalanced =
        discrepancies.length === 0 &&
        totalLedgerDebits === totalLedgerCredits &&
        actualCirculatingSupply === expectedCirculatingSupply &&
        activeEscrowBalance === activeReservationsUnresolvedSum;

      return {
        currencyCode,
        isBalanced,
        totalMinted,
        totalDestroyed,
        expectedCirculatingSupply,
        actualCirculatingSupply,
        activeEscrowBalance,
        activeReservationsUnresolvedSum,
        totalLedgerDebits,
        totalLedgerCredits,
        accountDiscrepancies: discrepancies,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  public async getRegionalMarketPriceStats(params: {
    readonly settlementId: string;
    readonly definitionCode: string;
    readonly currencyCode?: string | undefined;
    readonly since?: Date | undefined;
  }): Promise<RegionalMarketPriceStats> {
    const currencyCode = params.currencyCode ?? "ascendra_coin";
    const now = new Date();
    const openRes = await this.pool.query<{
      avail_qty: string;
      min_ask: string | null;
    }>(
      `SELECT
         COALESCE(SUM(remaining_quantity), 0)::text AS avail_qty,
         MIN(unit_price)::text AS min_ask
       FROM market_listings
       WHERE settlement_id = $1::uuid
         AND definition_code = $2
         AND currency_code = $3
         AND status IN ('Open', 'PartiallyFilled')
         AND expires_at > $4`,
      [params.settlementId, params.definitionCode, currencyCode, now],
    );

    const salesParams: unknown[] = [params.settlementId, params.definitionCode, currencyCode];
    let sinceClause = "";
    if (params.since) {
      salesParams.push(params.since);
      sinceClause = "AND sold_at >= $4";
    }

    const salesRes = await this.pool.query<{
      unit_price: string;
      quantity: number;
      gross_amount: string;
      sold_at: Date;
    }>(
      `SELECT unit_price::text, quantity, gross_amount::text, sold_at
       FROM market_sales
       WHERE settlement_id = $1::uuid
         AND definition_code = $2
         AND currency_code = $3
         ${sinceClause}
       ORDER BY sold_at DESC, id DESC`,
      salesParams,
    );

    const sales = salesRes.rows;
    let totalQty = 0;
    let totalGross = 0n;
    const unitPrices: bigint[] = [];
    for (const s of sales) {
      totalQty += s.quantity;
      totalGross += BigInt(s.gross_amount);
      unitPrices.push(BigInt(s.unit_price));
    }

    const lastTradedUnitPrice = sales[0] ? BigInt(sales[0].unit_price) : null;
    const vwap = totalQty > 0 ? totalGross / BigInt(totalQty) : null;

    let median: bigint | null = null;
    if (unitPrices.length > 0) {
      const sorted = unitPrices.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const mid = Math.floor((sorted.length - 1) / 2);
      median = sorted[mid]!;
    }

    return {
      settlementId: params.settlementId,
      definitionCode: params.definitionCode,
      currencyCode,
      observationWindowStart: params.since ?? null,
      observationWindowEnd: now,
      availableListedQuantity: Number(openRes.rows[0]?.avail_qty ?? "0"),
      lowestActiveAskPrice: openRes.rows[0]?.min_ask ? BigInt(openRes.rows[0].min_ask) : null,
      completedSalesCount: sales.length,
      totalTradedQuantity: totalQty,
      totalGrossVolume: totalGross,
      lastTradedUnitPrice,
      volumeWeightedAverageUnitPrice: vwap,
      medianSaleUnitPrice: median,
      methodology: "executed_sales_only_vwap_floor_and_lower_median",
    };
  }

  public async getEconomicObservabilityReport(): Promise<EconomicObservabilityReport> {
    const currRows = await this.pool.query<{ currency_code: string }>(
      "SELECT currency_code FROM currencies WHERE is_enabled = TRUE ORDER BY currency_code ASC",
    );
    const currencies: CurrencyReconciliationResult[] = [];
    for (const r of currRows.rows) {
      currencies.push(await this.reconcileCurrency(r.currency_code));
    }

    const activeResv = await this.pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM currency_reservations WHERE status = 'Reserved'",
    );
    const activeAssetEscrow = await this.pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM escrow_asset_holdings WHERE status = 'held'",
    );
    const completedTrades = await this.pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM trade_sessions WHERE status = 'Completed'",
    );

    let openMarketListingsCount = 0;
    let completedMarketSalesCount = 0;
    const regionalTaxCollectedByCurrency: Record<string, string> = {};
    if (await this.tableExists("market_listings")) {
      const openMkt = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM market_listings WHERE status IN ('Open', 'PartiallyFilled')",
      );
      openMarketListingsCount = Number(openMkt.rows[0]?.cnt ?? "0");
      const salesCnt = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM market_sales",
      );
      completedMarketSalesCount = Number(salesCnt.rows[0]?.cnt ?? "0");
      const taxRows = await this.pool.query<{ currency_code: string; total_tax: string }>(
        "SELECT currency_code, COALESCE(SUM(tax_amount), 0)::text AS total_tax FROM market_sales GROUP BY currency_code",
      );
      for (const tr of taxRows.rows) {
        regionalTaxCollectedByCurrency[tr.currency_code] = tr.total_tax;
      }
    }

    let equipmentGeneratedByCraftingCount = 0;
    let totalMaterialsConsumedInCrafting = 0;
    let authoritativeRewardGrantsCount = 0;
    let fundedActiveBountiesCount = 0;
    let settledBountyClaimsCount = 0;

    if (await this.tableExists("crafting_operations")) {
      const craftCnt = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM crafting_operations",
      );
      equipmentGeneratedByCraftingCount = Number(craftCnt.rows[0]?.cnt ?? "0");

      const matConsumed = await this.pool.query<{ total_mat: string }>(
        "SELECT COALESCE(SUM(quantity), 0)::text AS total_mat FROM item_operation_ledger WHERE operation_type = 'consume'",
      );
      totalMaterialsConsumedInCrafting = Number(matConsumed.rows[0]?.total_mat ?? "0");

      const rewCnt = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM reward_grants",
      );
      authoritativeRewardGrantsCount = Number(rewCnt.rows[0]?.cnt ?? "0");

      const bActive = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM criminal_bounties WHERE status = 'Active' AND reservation_id IS NOT NULL",
      );
      fundedActiveBountiesCount = Number(bActive.rows[0]?.cnt ?? "0");

      const bSettled = await this.pool.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM criminal_bounty_claims WHERE payout_commitment_status = 'settled'",
      );
      settledBountyClaimsCount = Number(bSettled.rows[0]?.cnt ?? "0");
    }

    return {
      generatedAt: new Date(),
      currencies,
      activeMonetaryReservationsCount: Number(activeResv.rows[0]?.cnt ?? "0"),
      activeAssetEscrowHoldingsCount: Number(activeAssetEscrow.rows[0]?.cnt ?? "0"),
      completedPlayerTradesCount: Number(completedTrades.rows[0]?.cnt ?? "0"),
      openMarketListingsCount,
      completedMarketSalesCount,
      regionalTaxCollectedByCurrency,
      equipmentGeneratedByCraftingCount,
      totalMaterialsConsumedInCrafting,
      authoritativeRewardGrantsCount,
      fundedActiveBountiesCount,
      settledBountyClaimsCount,
    };
  }
}
