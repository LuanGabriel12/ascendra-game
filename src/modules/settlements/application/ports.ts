import type { SettlementStateChangedOutboxPayloadV1 } from "../../../shared/contracts/world-events.js";
import type { Settlement, SettlementState } from "../domain/settlement.js";

export interface RegisterProcessedEventInput {
  readonly eventId: string;
  readonly externalEventId?: string | undefined;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly source: string;
  readonly correlationId: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly receivedAt?: Date | undefined;
  readonly payloadFingerprint: string;
  readonly canonicalPayload: Record<string, unknown>;
}

export interface AppendSettlementHistoryInput {
  readonly id: string;
  readonly settlementId: string;
  readonly settlementVersion: number;
  readonly previousState: SettlementState;
  readonly newState: SettlementState;
  readonly previousFactionId: string | null;
  readonly newFactionId: string | null;
  readonly causeEventId: string;
  readonly causeEventType: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface EnqueueSettlementOutboxInput {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: "SettlementStateChanged";
  readonly eventVersion: 1;
  readonly correlationId: string;
  readonly causationEventId: string;
  readonly payload: SettlementStateChangedOutboxPayloadV1;
  readonly occurredAt: Date;
}

export interface SettlementTransactionScope {
  /**
   * Atomically inserts into processed_events or verifies canonical payload equivalence.
   * Returns true if claimed by this transaction; false if verified idempotent duplicate;
   * throws InboxIdempotencyConflictError if a conflicting payload reuses event_id or idempotency_key.
   */
  tryRegisterProcessedEvent(input: RegisterProcessedEventInput): Promise<boolean>;

  /**
   * Acquires a PostgreSQL row-level exclusive lock (SELECT ... FOR UPDATE) on the settlement.
   */
  lockSettlementById(settlementId: string): Promise<Settlement | null>;

  factionExists(factionId: string): Promise<boolean>;

  /**
   * Persists the updated settlement guarded by expectedPreviousVersion.
   */
  updateSettlement(settlement: Settlement, expectedPreviousVersion: number): Promise<void>;

  appendHistory(input: AppendSettlementHistoryInput): Promise<void>;

  enqueueOutboxEvent(input: EnqueueSettlementOutboxInput): Promise<void>;
}

export interface SettlementUnitOfWork {
  executeInTransaction<T>(
    work: (scope: SettlementTransactionScope) => Promise<T>,
  ): Promise<T>;
}
