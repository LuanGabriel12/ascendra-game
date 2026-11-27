export class SocialDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SocialAuthorizationForbiddenError extends SocialDomainError {
  constructor(message: string) {
    super("SOCIAL_AUTHORIZATION_FORBIDDEN", message);
  }
}

export class SocialValidationError extends SocialDomainError {
  constructor(message: string) {
    super("SOCIAL_VALIDATION_INVALID", message);
  }
}

export class SocialNumericOverflowError extends SocialDomainError {
  constructor(message: string) {
    super("SOCIAL_NUMERIC_OVERFLOW", message);
  }
}

export class SocialReferenceNotFoundError extends SocialDomainError {
  constructor(entityType: string, identifier: string) {
    super("SOCIAL_REFERENCE_NOT_FOUND", `${entityType} '${identifier}' does not exist or is disabled.`);
  }
}

export class SocialAntiExploitRejectedError extends SocialDomainError {
  public readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super("SOCIAL_ANTI_EXPLOIT_REJECTED", message);
    this.reasonCode = reasonCode;
  }
}

export class ExternalIdentityUnresolvedError extends SocialDomainError {
  constructor(namespace: string, externalSubjectId: string) {
    super(
      "EXTERNAL_IDENTITY_UNRESOLVED",
      `External identity (${namespace}, '${externalSubjectId}') is not mapped to an active CharacterID.`,
    );
  }
}

export class ExternalIdentityConflictError extends SocialDomainError {
  constructor(message: string) {
    super("EXTERNAL_IDENTITY_CONFLICT", message);
  }
}

export class CriminalJurisdictionRuleError extends SocialDomainError {
  constructor(message: string) {
    super("CRIMINAL_JURISDICTION_RULE_ERROR", message);
  }
}

export class CriminalBountyInvalidError extends SocialDomainError {
  constructor(message: string) {
    super("CRIMINAL_BOUNTY_INVALID", message);
  }
}

export class TitleConditionInvalidError extends SocialDomainError {
  constructor(message: string) {
    super("TITLE_CONDITION_INVALID", message);
  }
}

export class TitleOwnershipOrStateError extends SocialDomainError {
  constructor(message: string) {
    super("TITLE_OWNERSHIP_OR_STATE_ERROR", message);
  }
}

export class TitleExclusivityClaimedError extends SocialDomainError {
  constructor(exclusivityKey: string, holderCharacterId?: string) {
    super(
      "TITLE_EXCLUSIVITY_CLAIMED",
      `Exclusive title key '${exclusivityKey}' has already been claimed${holderCharacterId ? ` by '${holderCharacterId}'` : ""}.`,
    );
  }
}

export class ContributionRecognitionInvalidError extends SocialDomainError {
  constructor(message: string) {
    super("CONTRIBUTION_RECOGNITION_INVALID", message);
  }
}

export class SocialVersionConflictError extends SocialDomainError {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  constructor(entityLabel: string, expectedVersion: number, actualVersion: number) {
    super(
      "SOCIAL_VERSION_CONFLICT",
      `${entityLabel} version conflict: expected ${expectedVersion}, actual ${actualVersion}.`,
    );
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
