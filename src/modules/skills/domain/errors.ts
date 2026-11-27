export class SkillDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SkillAuthorizationForbiddenError extends SkillDomainError {
  constructor(message: string) {
    super("SKILL_AUTHORIZATION_FORBIDDEN", message);
  }
}

export class SkillCatalogDisabledOrNotFoundError extends SkillDomainError {
  constructor(entityKind: string, identifier: string) {
    super(
      "SKILL_CATALOG_DISABLED_OR_NOT_FOUND",
      `${entityKind} '${identifier}' does not exist or is currently disabled/planned.`,
    );
  }
}

export class SpecializationDagInvalidError extends SkillDomainError {
  constructor(message: string) {
    super("SPECIALIZATION_DAG_INVALID", message);
  }
}

export class SpecializationBudgetInsufficientError extends SkillDomainError {
  constructor(message: string) {
    super("SPECIALIZATION_BUDGET_INSUFFICIENT", message);
  }
}

export class SkillPrerequisiteUnmetError extends SkillDomainError {
  constructor(message: string) {
    super("SKILL_PREREQUISITE_UNMET", message);
  }
}

export class AbilityRankLimitExceededError extends SkillDomainError {
  constructor(abilityCode: string, requestedRank: number, maxRank: number) {
    super(
      "ABILITY_RANK_LIMIT_EXCEEDED",
      `Ability '${abilityCode}' cannot advance to rank ${requestedRank} (maximum configured rank is ${maxRank}).`,
    );
  }
}

export class AbilityLoadoutInvalidError extends SkillDomainError {
  constructor(message: string) {
    super("ABILITY_LOADOUT_INVALID", message);
  }
}

export class MasteryNumericOverflowError extends SkillDomainError {
  constructor(message: string) {
    super("MASTERY_NUMERIC_OVERFLOW", message);
  }
}

export class MasteryAntiFarmingRejectedError extends SkillDomainError {
  constructor(message: string) {
    super("MASTERY_ANTI_FARMING_REJECTED", message);
  }
}

export class SkillVersionConflictError extends SkillDomainError {
  constructor(aggregateLabel: string, expectedVersion: number, actualVersion: number) {
    super(
      "SKILL_VERSION_CONFLICT",
      `Optimistic concurrency conflict on ${aggregateLabel}: expected version ${expectedVersion}, found ${actualVersion}.`,
    );
  }
}
