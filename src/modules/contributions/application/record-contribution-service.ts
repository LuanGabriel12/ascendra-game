import { randomUUID } from "node:crypto";
import { deriveDeterministicEventUuid } from "../../../shared/contracts/canonical-fingerprint.js";
import type { Logger } from "../../../shared/observability/logger.js";
import { SettlementNotFoundError } from "../../settlements/domain/errors.js";
import {
  parseContributionSubmission,
  parseContributionWireJson,
  type ValidatedContributionSubmission,
} from "../contracts/contribution-contracts.js";
import { GameplayContribution } from "../domain/contribution.js";
import {
  DuplicateContributionError,
  LogicalContributionConflictError,
} from "../domain/errors.js";
import type { ContributionUnitOfWork } from "./ports.js";

export type RecordContributionOutcome =
  | {
      readonly status: "applied";
      readonly duplicate: false;
      readonly contribution: GameplayContribution;
      readonly outboxEventId: string;
    }
  | {
      readonly status: "duplicate_idempotent";
      readonly duplicate: true;
      readonly contribution: GameplayContribution;
    };

export interface RecordContributionServiceDependencies {
  readonly unitOfWork: ContributionUnitOfWork;
  readonly logger: Logger;
  /**
   * When true, rejects contributions referencing a settlement_id not yet persisted in `settlements`.
   * Defaults to false so standalone contract batches can be ingested while still linking `resolved_settlement_id`
   * whenever the settlement exists.
   */
  readonly requireRegisteredSettlement?: boolean | undefined;
  readonly beforeCommitHook?:
    | ((context: { externalEventId: string; contributionId: string }) => Promise<void>)
    | undefined;
}

export class RecordContributionService {
  private readonly unitOfWork: ContributionUnitOfWork;
  private readonly logger: Logger;
  private readonly requireRegisteredSettlement: boolean;
  private readonly beforeCommitHook:
    | ((context: { externalEventId: string; contributionId: string }) => Promise<void>)
    | undefined;

  constructor(deps: RecordContributionServiceDependencies) {
    this.unitOfWork = deps.unitOfWork;
    this.logger = deps.logger;
    this.requireRegisteredSettlement = deps.requireRegisteredSettlement ?? false;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  /**
   * Accepts a parsed JSON value (`ContributionResult` or v1 envelope) and persists it
   * atomically across `processed_events`, `gameplay_contributions`, and `outbox_events`.
   */
  public async record(rawInput: unknown): Promise<RecordContributionOutcome> {
    const receivedAt = new Date();
    const validated = parseContributionSubmission(rawInput);
    return this.executeValidated(validated, receivedAt);
  }

  /**
   * Accepts raw UTF-8 JSON wire text (e.g. emitted by Go `encoding/json`) and preserves full
   * 64-bit `int64`/`uint64` precision prior to validation and transactional persistence.
   */
  public async recordFromWireJson(rawJsonText: string): Promise<RecordContributionOutcome> {
    const receivedAt = new Date();
    const validated = parseContributionWireJson(rawJsonText);
    return this.executeValidated(validated, receivedAt);
  }

  /**
   * Optional strict Go-port adapter matching `internal/adapters/memory/contribution_sink.go`
   * behavior (`ErrDuplicateContribution` on any duplicate `event_id`).
   * For distributed partial-batch retries, prefer `record()` / `recordFromWireJson()` which
   * return `duplicate_idempotent` on verified identical payloads.
   */
  public async recordStrictPortSemantics(rawInput: unknown): Promise<GameplayContribution> {
    const outcome = await this.record(rawInput);
    if (outcome.status === "duplicate_idempotent") {
      throw new DuplicateContributionError(outcome.contribution.externalEventId);
    }
    return outcome.contribution;
  }

  private async executeValidated(
    submission: ValidatedContributionSubmission,
    receivedAt: Date,
  ): Promise<RecordContributionOutcome> {
    const aggregateDeterministicUuid = deriveDeterministicEventUuid(
      `contrib-logical:${submission.simulationId}:${submission.invasionId}:${submission.playerId}`,
    );

    try {
      const result = await this.unitOfWork.executeInTransaction(
        async (scope): Promise<RecordContributionOutcome> => {
          const claim = await scope.claimOrVerifyEvent({
            eventUuid: submission.deterministicEventUuid,
            externalEventId: submission.externalEventId,
            idempotencyKey: submission.idempotencyKey,
            eventType: "ContributionRecorded",
            eventVersion: submission.contractVersion,
            source: submission.source,
            correlationUuid: submission.correlationUuid,
            aggregateUuid: aggregateDeterministicUuid,
            occurredAt: submission.occurredAt,
            receivedAt,
            payloadFingerprint: submission.payloadFingerprint,
            canonicalPayload: submission.canonicalPayload,
          });

          if (claim.status === "duplicate_verified") {
            const existing = await scope.findByExternalEventId(claim.existingExternalEventId);
            if (!existing) {
              throw new Error(
                `Inconsistent state: processed_events contains '${claim.existingExternalEventId}' without matching gameplay_contributions row.`,
              );
            }
            return {
              status: "duplicate_idempotent",
              duplicate: true,
              contribution: existing,
            };
          }

          // Check logical contribution uniqueness before insert for clear domain diagnostics
          const logicalExisting = await scope.findByLogicalIdentity({
            simulationId: submission.simulationId,
            invasionId: submission.invasionId,
            playerId: submission.playerId,
          });
          if (logicalExisting) {
            throw new LogicalContributionConflictError({
              simulationId: submission.simulationId,
              invasionId: submission.invasionId,
              playerId: submission.playerId,
              existingExternalEventId: logicalExisting.externalEventId,
              incomingExternalEventId: submission.externalEventId,
            });
          }

          const resolvedSettlementId = await scope.resolveSettlementUuid(submission.settlementId);
          if (this.requireRegisteredSettlement && !resolvedSettlementId) {
            throw new SettlementNotFoundError(submission.settlementId);
          }

          const contributionId = randomUUID();
          const entity = new GameplayContribution({
            id: contributionId,
            processedEventId: claim.eventUuid,
            externalEventId: submission.externalEventId,
            contractVersion: submission.contractVersion,
            simulationId: submission.simulationId,
            invasionId: submission.invasionId,
            settlementRef: submission.settlementId,
            resolvedSettlementId,
            playerId: submission.playerId,
            tick: submission.tick,
            damage: submission.damage,
            support: submission.support,
            objectives: submission.objectives,
            eligible: submission.eligible,
            outcome: submission.outcome,
            payloadFingerprint: submission.payloadFingerprint,
            receivedAt,
            recordedAt: receivedAt,
          });

          const persisted = await scope.insertContribution(entity);

          const outboxEventId = randomUUID();
          await scope.enqueueOutboxEvent({
            id: outboxEventId,
            aggregateId: persisted.id,
            correlationUuid: submission.correlationUuid,
            causationEventUuid: claim.eventUuid,
            occurredAt: submission.occurredAt ?? receivedAt,
            payload: {
              contract_version: 1,
              contribution_id: persisted.id,
              external_event_id: persisted.externalEventId,
              simulation_id: persisted.simulationId,
              invasion_id: persisted.invasionId,
              settlement_id: persisted.settlementRef,
              resolved_settlement_id: persisted.resolvedSettlementId,
              player_id: persisted.playerId,
              tick: persisted.tick.toString(),
              damage: persisted.damage.toString(),
              support: persisted.support.toString(),
              objectives: persisted.objectives.toString(),
              eligible: persisted.eligible,
              outcome: persisted.outcome,
            },
          });

          if (this.beforeCommitHook) {
            await this.beforeCommitHook({
              externalEventId: persisted.externalEventId,
              contributionId: persisted.id,
            });
          }

          return {
            status: "applied",
            duplicate: false,
            contribution: persisted,
            outboxEventId,
          };
        },
      );

      if (result.status === "duplicate_idempotent") {
        this.logger.info("Verified idempotent duplicate gameplay contribution", {
          event_id: submission.externalEventId,
          correlation_id: submission.correlationUuid,
          aggregate_id: result.contribution.id,
          operation: "recordContribution",
          result: "duplicate_idempotent",
        });
      } else {
        this.logger.info("Persisted authoritative gameplay contribution", {
          event_id: submission.externalEventId,
          correlation_id: submission.correlationUuid,
          aggregate_id: result.contribution.id,
          operation: "recordContribution",
          result: "applied",
        });
      }

      return result;
    } catch (error) {
      this.logger.error("Rejected or rolled back gameplay contribution", {
        event_id: submission.externalEventId,
        correlation_id: submission.correlationUuid,
        aggregate_id: aggregateDeterministicUuid,
        operation: "recordContribution",
        result: "rolled_back",
        reason: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }
}
