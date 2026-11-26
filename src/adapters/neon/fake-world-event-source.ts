import { randomUUID } from "node:crypto";
import type {
  SettlementCapturedEventV1,
  SettlementLiberatedEventV1,
} from "../../shared/contracts/world-events.js";

/**
 * TEST / INTEGRATION DOUBLE ONLY.
 * Simulates versioned event envelopes emitted by NEON's invasion/world simulation
 * without implementing any internal NEON logic (AI, InvasionEngine, WorldEventDirector).
 */
export class FakeWorldEventSource {
  private readonly defaultSource: string;

  constructor(defaultSource: string = "neon.fake-world-event-source") {
    this.defaultSource = defaultSource;
  }

  public buildSettlementCaptured(params: {
    readonly settlementId: string;
    readonly capturingFactionId: string;
    readonly eventId?: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly correlationId?: string | undefined;
    readonly invasionId?: string | undefined;
    readonly expectedSettlementVersion?: number | undefined;
    readonly occurredAt?: Date | undefined;
  }): SettlementCapturedEventV1 {
    return {
      event_id: params.eventId ?? randomUUID(),
      ...(params.idempotencyKey !== undefined ? { idempotency_key: params.idempotencyKey } : {}),
      event_type: "SettlementCaptured",
      version: 1,
      occurred_at: (params.occurredAt ?? new Date()).toISOString(),
      correlation_id: params.correlationId ?? randomUUID(),
      source: this.defaultSource,
      payload: {
        settlement_id: params.settlementId,
        capturing_faction_id: params.capturingFactionId,
        ...(params.invasionId !== undefined ? { invasion_id: params.invasionId } : {}),
        ...(params.expectedSettlementVersion !== undefined
          ? { expected_settlement_version: params.expectedSettlementVersion }
          : {}),
      },
    };
  }

  public buildSettlementLiberated(params: {
    readonly settlementId: string;
    readonly liberatingFactionId: string;
    readonly resultingState?: "rebuilding" | "peaceful" | undefined;
    readonly eventId?: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly correlationId?: string | undefined;
    readonly expectedSettlementVersion?: number | undefined;
    readonly occurredAt?: Date | undefined;
  }): SettlementLiberatedEventV1 {
    return {
      event_id: params.eventId ?? randomUUID(),
      ...(params.idempotencyKey !== undefined ? { idempotency_key: params.idempotencyKey } : {}),
      event_type: "SettlementLiberated",
      version: 1,
      occurred_at: (params.occurredAt ?? new Date()).toISOString(),
      correlation_id: params.correlationId ?? randomUUID(),
      source: this.defaultSource,
      payload: {
        settlement_id: params.settlementId,
        liberating_faction_id: params.liberatingFactionId,
        ...(params.resultingState !== undefined ? { resulting_state: params.resultingState } : {}),
        ...(params.expectedSettlementVersion !== undefined
          ? { expected_settlement_version: params.expectedSettlementVersion }
          : {}),
      },
    };
  }
}
