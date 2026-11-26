export class ContributionDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidContributionError extends ContributionDomainError {
  public readonly issues: ReadonlyArray<string>;

  constructor(message: string, issues: ReadonlyArray<string> = [message]) {
    super("INVALID_CONTRIBUTION", message);
    this.issues = issues;
  }
}

/**
 * Raised only by the strict Go-port compatibility adapter (`ports.ErrDuplicateContribution`)
 * when an in-process caller explicitly opts out of idempotent no-op retry semantics.
 */
export class DuplicateContributionError extends ContributionDomainError {
  public readonly externalEventId: string;

  constructor(externalEventId: string) {
    super("DUPLICATE_CONTRIBUTION", `duplicate contribution event_id: '${externalEventId}'`);
    this.externalEventId = externalEventId;
  }
}

/**
 * Permanent integrity conflict when two distinct EventIDs attempt to record a terminal
 * contribution for the same `(simulation_id, invasion_id, player_id)` tuple.
 */
export class LogicalContributionConflictError extends ContributionDomainError {
  public readonly simulationId: string;
  public readonly invasionId: string;
  public readonly playerId: string;
  public readonly existingExternalEventId: string;
  public readonly incomingExternalEventId: string;

  constructor(params: {
    readonly simulationId: string;
    readonly invasionId: string;
    readonly playerId: string;
    readonly existingExternalEventId: string;
    readonly incomingExternalEventId: string;
  }) {
    super(
      "LOGICAL_CONTRIBUTION_CONFLICT",
      `Logical contribution (${params.simulationId}, ${params.invasionId}, ${params.playerId}) already recorded under event '${params.existingExternalEventId}'; cannot accept distinct event '${params.incomingExternalEventId}'.`,
    );
    this.simulationId = params.simulationId;
    this.invasionId = params.invasionId;
    this.playerId = params.playerId;
    this.existingExternalEventId = params.existingExternalEventId;
    this.incomingExternalEventId = params.incomingExternalEventId;
  }
}
