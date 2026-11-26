import { randomUUID } from "node:crypto";
import { computeCanonicalFingerprintV1 } from "../../../shared/contracts/canonical-fingerprint.js";
import {
  parseSupportedNeonSettlementEvent,
  type SupportedNeonSettlementEventV1,
} from "../../../shared/contracts/world-events.js";
import type { Logger } from "../../../shared/observability/logger.js";
import {
  FactionNotFoundError,
  SettlementConcurrencyConflictError,
  SettlementNotFoundError,
} from "../domain/errors.js";
import type { SettlementState } from "../domain/settlement.js";
import type { SettlementUnitOfWork } from "./ports.js";

export type HandleSettlementEventResult =
  | {
      readonly status: "applied";
      readonly applied: true;
      readonly eventId: string;
      readonly settlementId: string;
      readonly newState: SettlementState;
      readonly newVersion: number;
      readonly controllingFactionId: string | null;
      readonly historyRecordId: string;
      readonly outboxEventId: string;
    }
  | {
      readonly status: "duplicate_noop";
      readonly applied: false;
      readonly eventId: string;
      readonly idempotencyKey: string;
    };

export interface SettlementEventHandlerDependencies {
  readonly unitOfWork: SettlementUnitOfWork;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { eventId: string; settlementId: string }) => Promise<void>)
    | undefined;
}

function buildSemanticSettlementFingerprint(event: SupportedNeonSettlementEventV1): {
  readonly fingerprint: string;
  readonly canonicalJson: Record<string, unknown>;
} {
  if (event.event_type === "SettlementCaptured") {
    return computeCanonicalFingerprintV1({
      event_type: event.event_type,
      version: event.version,
      settlement_id: event.payload.settlement_id.toLowerCase(),
      capturing_faction_id: event.payload.capturing_faction_id.toLowerCase(),
      invasion_id: event.payload.invasion_id?.toLowerCase(),
      expected_settlement_version: event.payload.expected_settlement_version,
    });
  }

  return computeCanonicalFingerprintV1({
    event_type: event.event_type,
    version: event.version,
    settlement_id: event.payload.settlement_id.toLowerCase(),
    liberating_faction_id: event.payload.liberating_faction_id.toLowerCase(),
    resulting_state: event.payload.resulting_state,
    expected_settlement_version: event.payload.expected_settlement_version,
  });
}

export class SettlementEventHandler {
  private readonly unitOfWork: SettlementUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { eventId: string; settlementId: string }) => Promise<void>)
    | undefined;

  constructor(deps: SettlementEventHandlerDependencies) {
    this.unitOfWork = deps.unitOfWork;
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async handle(rawEvent: unknown): Promise<HandleSettlementEventResult> {
    const receivedAt = new Date();
    const event = parseSupportedNeonSettlementEvent(rawEvent);
    const settlementId = event.payload.settlement_id;
    const idempotencyKey = event.idempotency_key ?? event.event_id;
    const occurredAt = new Date(event.occurred_at);
    const { fingerprint, canonicalJson } = buildSemanticSettlementFingerprint(event);

    try {
      const outcome = await this.unitOfWork.executeInTransaction(
        async (scope): Promise<HandleSettlementEventResult> => {
          const claimed = await scope.tryRegisterProcessedEvent({
            eventId: event.event_id,
            externalEventId: event.event_id.toLowerCase(),
            idempotencyKey,
            eventType: event.event_type,
            eventVersion: event.version,
            source: event.source,
            correlationId: event.correlation_id,
            aggregateId: settlementId,
            occurredAt,
            receivedAt,
            payloadFingerprint: fingerprint,
            canonicalPayload: canonicalJson,
          });

          if (!claimed) {
            return {
              status: "duplicate_noop",
              applied: false,
              eventId: event.event_id,
              idempotencyKey,
            };
          }

          const current = await scope.lockSettlementById(settlementId);
          if (!current) {
            throw new SettlementNotFoundError(settlementId);
          }

          const targetFactionId = this.extractTargetFactionId(event);
          const factionFound = await scope.factionExists(targetFactionId);
          if (!factionFound) {
            throw new FactionNotFoundError(targetFactionId);
          }

          const transition =
            event.event_type === "SettlementCaptured"
              ? current.applyCapture({
                  capturingFactionId: event.payload.capturing_faction_id,
                  occurredAt,
                  expectedVersion: event.payload.expected_settlement_version,
                })
              : current.applyLiberation({
                  liberatingFactionId: event.payload.liberating_faction_id,
                  occurredAt,
                  resultingState: event.payload.resulting_state,
                  expectedVersion: event.payload.expected_settlement_version,
                });

          await scope.updateSettlement(transition.updated, current.version);

          const historyRecordId = randomUUID();
          await scope.appendHistory({
            id: historyRecordId,
            settlementId: current.id,
            settlementVersion: transition.updated.version,
            previousState: transition.previousState,
            newState: transition.newState,
            previousFactionId: transition.previousFactionId,
            newFactionId: transition.newFactionId,
            causeEventId: event.event_id,
            causeEventType: event.event_type,
            correlationId: event.correlation_id,
            occurredAt,
          });

          const outboxEventId = randomUUID();
          await scope.enqueueOutboxEvent({
            id: outboxEventId,
            aggregateId: current.id,
            eventType: "SettlementStateChanged",
            eventVersion: 1,
            correlationId: event.correlation_id,
            causationEventId: event.event_id,
            occurredAt,
            payload: {
              settlement_id: current.id,
              region_id: current.regionId,
              previous_state: transition.previousState,
              new_state: transition.newState,
              previous_faction_id: transition.previousFactionId,
              new_faction_id: transition.newFactionId,
              settlement_version: transition.updated.version,
              cause_event_id: event.event_id,
              cause_event_type: event.event_type,
            },
          });

          if (this.beforeCommitHook) {
            await this.beforeCommitHook({ eventId: event.event_id, settlementId: current.id });
          }

          return {
            status: "applied",
            applied: true,
            eventId: event.event_id,
            settlementId: current.id,
            newState: transition.updated.state,
            newVersion: transition.updated.version,
            controllingFactionId: transition.updated.controllingFactionId,
            historyRecordId,
            outboxEventId,
          };
        },
      );

      if (outcome.status === "duplicate_noop") {
        this.logger.info("Ignored verified duplicate NEON settlement event", {
          event_id: event.event_id,
          correlation_id: event.correlation_id,
          aggregate_id: settlementId,
          operation: `handle:${event.event_type}`,
          result: "duplicate_noop",
        });
      } else {
        this.logger.info("Applied NEON settlement state transition", {
          event_id: event.event_id,
          correlation_id: event.correlation_id,
          aggregate_id: settlementId,
          operation: `handle:${event.event_type}`,
          result: "applied",
          settlement_version: outcome.newVersion,
        });
      }

      return outcome;
    } catch (error) {
      this.logger.error("Failed to process NEON settlement event; transaction rolled back", {
        event_id: event.event_id,
        correlation_id: event.correlation_id,
        aggregate_id: settlementId,
        operation: `handle:${event.event_type}`,
        result: "rolled_back",
        reason: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  private extractTargetFactionId(event: SupportedNeonSettlementEventV1): string {
    return event.event_type === "SettlementCaptured"
      ? event.payload.capturing_faction_id
      : event.payload.liberating_faction_id;
  }
}

export { SettlementConcurrencyConflictError };
