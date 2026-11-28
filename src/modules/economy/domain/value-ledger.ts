/**
 * CARBON — Regional & Global Monetary Ledger Port (Evolved in Session 07 from Session 01 Preparatory Contract)
 *
 * Preserves full backward compatibility with `LedgerAccountRef`, `LedgerMovementInput`,
 * `LedgerEntry`, and `ValueLedgerPort.recordMovement(...)` while extending it with balanced
 * multi-leg double-entry transactions, paginated queries, and strict supply reconciliation.
 */

import type {
  CurrencyLedgerEntryRecord,
  CurrencyLedgerTransactionRecord,
  CurrencyReconciliationResult,
  MonetaryOperationType,
} from "./economy-types.js";

export interface LedgerAccountRef {
  readonly accountType:
    | "player"
    | "player_wallet"
    | "settlement_treasury"
    | "faction_treasury"
    | "system_sink"
    | "system_mint"
    | "escrow_account"
    | "merchant_account";
  readonly accountId: string;
}

export interface LedgerMovementInput {
  readonly idempotencyKey: string;
  readonly source: LedgerAccountRef;
  readonly destination: LedgerAccountRef;
  readonly currencyCode: string;
  readonly amount: bigint;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface LedgerEntry extends LedgerMovementInput {
  readonly id: string;
}

export interface BalancedLedgerLegInput {
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amount: bigint;
  readonly memo: string;
}

export interface BalancedLedgerTransactionInput {
  readonly idempotencyKey: string;
  readonly processedEventId?: string | null | undefined;
  readonly operationType: MonetaryOperationType;
  readonly currencyCode: string;
  readonly correlationId: string;
  readonly sourceEventId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly isCompensating?: boolean | undefined;
  readonly compensatesTxId?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly rulesVersion?: number | undefined;
  readonly legs: ReadonlyArray<BalancedLedgerLegInput>;
}

export interface PaginatedLedgerQuery {
  readonly walletId?: string | undefined;
  readonly currencyCode?: string | undefined;
  readonly afterLedgerEntrySeq?: bigint | undefined;
  readonly limit?: number | undefined;
}

export interface ValueLedgerPort {
  recordMovement(input: LedgerMovementInput): Promise<LedgerEntry>;
  queryLedgerEntries(query: PaginatedLedgerQuery): Promise<ReadonlyArray<CurrencyLedgerEntryRecord>>;
  getTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CurrencyLedgerTransactionRecord | null>;
  reconcileCurrency(currencyCode: string): Promise<CurrencyReconciliationResult>;
}
