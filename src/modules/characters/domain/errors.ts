export class CharacterDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AccountNotFoundError extends CharacterDomainError {
  constructor(accountId: string) {
    super("ACCOUNT_NOT_FOUND", `Account '${accountId}' does not exist.`);
  }
}

export class AccountInactiveError extends CharacterDomainError {
  constructor(accountId: string, status: string) {
    super("ACCOUNT_INACTIVE", `Account '${accountId}' is '${status}' and cannot mutate characters.`);
  }
}

export class AccountCharacterLimitReachedError extends CharacterDomainError {
  constructor(accountId: string, maxCharacters: number) {
    super(
      "ACCOUNT_CHARACTER_LIMIT_REACHED",
      `Account '${accountId}' has already reached the maximum of ${maxCharacters} characters.`,
    );
  }
}

export class CharacterNotFoundError extends CharacterDomainError {
  constructor(characterId: string) {
    super("CHARACTER_NOT_FOUND", `Character '${characterId}' does not exist.`);
  }
}

export class CharacterOwnershipForbiddenError extends CharacterDomainError {
  constructor(characterId: string, callerAccountId: string) {
    super(
      "CHARACTER_OWNERSHIP_FORBIDDEN",
      `Account '${callerAccountId}' is not authorized to access or mutate character '${characterId}'.`,
    );
  }
}

export class CharacterBuildConflictError extends CharacterDomainError {
  public readonly expectedBuildVersion: number;
  public readonly actualBuildVersion: number;

  constructor(characterId: string, expectedBuildVersion: number, actualBuildVersion: number) {
    super(
      "CHARACTER_BUILD_VERSION_CONFLICT",
      `Character '${characterId}' buildVersion mismatch: expected ${expectedBuildVersion}, actual ${actualBuildVersion}.`,
    );
    this.expectedBuildVersion = expectedBuildVersion;
    this.actualBuildVersion = actualBuildVersion;
  }
}

export class CharacterCompetitiveLockedError extends CharacterDomainError {
  constructor(characterId: string) {
    super(
      "CHARACTER_COMPETITIVE_LOCKED",
      `Character '${characterId}' is currently locked in an active ranked series and cannot respec or reallocate persistent build attributes.`,
    );
  }
}

export class CharacterNameInvalidError extends CharacterDomainError {
  constructor(message: string) {
    super("CHARACTER_NAME_INVALID", message);
  }
}

export class CharacterNameReservedError extends CharacterDomainError {
  constructor(name: string) {
    super("CHARACTER_NAME_RESERVED", `Character name '${name}' is reserved or disallowed by moderation policy.`);
  }
}

export class CharacterNameTakenError extends CharacterDomainError {
  constructor(displayName: string) {
    super("CHARACTER_NAME_ALREADY_TAKEN", `Character name '${displayName}' is already in use.`);
  }
}

export class PeopleDisabledError extends CharacterDomainError {
  constructor(raceCode: string) {
    super(
      "PEOPLE_DISABLED_OR_UNKNOWN",
      `People '${raceCode}' is either unknown or not yet enabled for playable character creation.`,
    );
  }
}

export class LineageIncompatibleError extends CharacterDomainError {
  constructor(lineageCode: string, raceCode: string) {
    super(
      "LINEAGE_INCOMPATIBLE_WITH_PEOPLE",
      `Lineage '${lineageCode}' is disabled, unknown, or incompatible with people '${raceCode}'.`,
    );
  }
}

export class CultureInvalidError extends CharacterDomainError {
  constructor(cultureCode: string) {
    super("CULTURE_INVALID_OR_DISABLED", `Culture '${cultureCode}' is unknown or disabled.`);
  }
}

export class BackgroundInvalidError extends CharacterDomainError {
  constructor(backgroundCode: string) {
    super("BACKGROUND_INVALID_OR_DISABLED", `Background '${backgroundCode}' is unknown or disabled.`);
  }
}

export class AttributeAllocationInvalidError extends CharacterDomainError {
  constructor(message: string) {
    super("ATTRIBUTE_ALLOCATION_INVALID", message);
  }
}

export class ExperienceGrantInvalidError extends CharacterDomainError {
  constructor(message: string) {
    super("EXPERIENCE_GRANT_INVALID", message);
  }
}

export class GenesisTemporaryStatePersistenceForbiddenError extends CharacterDomainError {
  constructor(operation: string) {
    super(
      "GENESIS_TEMPORARY_STATE_FORBIDDEN",
      `Operation '${operation}' rejected: Genesis Ranked temporary match builds, XP, loot, or attributes MUST NEVER be persisted into open-world character tables.`,
    );
  }
}
