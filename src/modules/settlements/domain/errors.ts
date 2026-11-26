export class SettlementDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SettlementNotFoundError extends SettlementDomainError {
  constructor(settlementId: string) {
    super("SETTLEMENT_NOT_FOUND", `Settlement '${settlementId}' does not exist.`);
  }
}

export class InvalidSettlementSnapshotError extends SettlementDomainError {
  constructor(message: string) {
    super("INVALID_SETTLEMENT_SNAPSHOT", message);
  }
}

export class FactionNotFoundError extends SettlementDomainError {
  constructor(factionId: string) {
    super("FACTION_NOT_FOUND", `Faction '${factionId}' is not registered.`);
  }
}

export class InvalidSettlementStateTransitionError extends SettlementDomainError {
  constructor(message: string) {
    super("INVALID_SETTLEMENT_STATE_TRANSITION", message);
  }
}

export class SettlementConcurrencyConflictError extends SettlementDomainError {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  constructor(settlementId: string, expectedVersion: number, actualVersion: number) {
    super(
      "SETTLEMENT_CONCURRENCY_CONFLICT",
      `Settlement '${settlementId}' version mismatch: expected ${expectedVersion}, actual ${actualVersion}.`,
    );
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
