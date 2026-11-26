import type { ClaimProcessedEventInput, ClaimProcessedEventResult } from "../../../shared/db/processed-events-inbox.js";
import type { ContributionRecordedOutboxPayloadV1 } from "../contracts/contribution-contracts.js";
import type { GameplayContribution } from "../domain/contribution.js";

export interface EnqueueContributionOutboxInput {
  readonly id: string;
  readonly aggregateId: string;
  readonly correlationUuid: string;
  readonly causationEventUuid: string;
  readonly payload: ContributionRecordedOutboxPayloadV1;
  readonly occurredAt: Date;
}

export interface ContributionTransactionScope {
  claimOrVerifyEvent(input: ClaimProcessedEventInput): Promise<ClaimProcessedEventResult>;

  findByExternalEventId(externalEventId: string): Promise<GameplayContribution | null>;

  findByLogicalIdentity(params: {
    readonly simulationId: string;
    readonly invasionId: string;
    readonly playerId: string;
  }): Promise<GameplayContribution | null>;

  resolveSettlementUuid(settlementIdentifier: string): Promise<string | null>;

  insertContribution(contribution: GameplayContribution): Promise<GameplayContribution>;

  enqueueOutboxEvent(input: EnqueueContributionOutboxInput): Promise<void>;
}

export interface ContributionUnitOfWork {
  executeInTransaction<T>(
    work: (scope: ContributionTransactionScope) => Promise<T>,
  ): Promise<T>;
}
