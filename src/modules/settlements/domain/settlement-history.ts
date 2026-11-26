import type { SettlementState } from "./settlement.js";

export interface SettlementHistoryRecord {
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
  readonly recordedAt: Date;
}
