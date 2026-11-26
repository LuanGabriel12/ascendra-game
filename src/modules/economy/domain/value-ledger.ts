/**
 * CARBON — Regional Economy Preparatory Interface (Audit Ledger Contract)
 *
 * NOTE: Full regional economy is intentionally NOT implemented in Session 01.
 * Every future transfer/grant/tax/contract payout MUST be persisted as an
 * immutable ledger movement rather than mutating unrecorded balances (`gold += X`).
 */

export interface LedgerAccountRef {
  readonly accountType: "player" | "settlement_treasury" | "faction_treasury" | "system_sink" | "system_mint";
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

export interface ValueLedgerPort {
  recordMovement(input: LedgerMovementInput): Promise<LedgerEntry>;
}
