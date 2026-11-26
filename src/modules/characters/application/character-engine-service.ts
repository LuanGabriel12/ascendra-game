import { randomUUID } from "node:crypto";
import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
  type CanonicalizableValue,
} from "../../../shared/contracts/canonical-fingerprint.js";
import { PositiveInt64Schema } from "../../../shared/contracts/int64-wire.js";
import type { Logger } from "../../../shared/observability/logger.js";
import {
  validateCharacterAppearance,
  type CharacterAppearanceInput,
} from "../../peoples/domain/appearance.js";
import type {
  AttributeBlock,
  CompetitiveNormalizationProfile,
} from "../../peoples/domain/character-snapshot-proposal.js";
import {
  BUILD_ARCHETYPE_PRESETS,
  createZeroAttributeBlock,
  parseStrictAttributeDeltaObject,
  sumAttributeBlock,
} from "../domain/attributes-and-presets.js";
import {
  Character,
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
  type RespecAuthorizationPolicy,
} from "../domain/character.js";
import {
  AccountCharacterLimitReachedError,
  AccountNotFoundError,
  AttributeAllocationInvalidError,
  BackgroundInvalidError,
  CharacterNotFoundError,
  CharacterOwnershipForbiddenError,
  CultureInvalidError,
  ExperienceGrantInvalidError,
  LineageIncompatibleError,
  PeopleDisabledError,
} from "../domain/errors.js";
import {
  DefaultOfflineNameModerationPolicy,
  validateAndNormalizeCharacterName,
  type NameModerationPolicy,
} from "../domain/naming.js";
import {
  AUTHORIZED_EXPERIENCE_SOURCE_TYPES,
  type ExperienceSourceType,
} from "../domain/progression.js";
import type {
  ExperienceGrantRecord,
  PostgresCharacterUnitOfWork,
} from "../infrastructure/postgres-character-unit-of-work.js";

export type IdempotentCommandOutcome<T> =
  | { readonly status: "applied"; readonly duplicate: false; readonly data: T }
  | { readonly status: "duplicate_idempotent"; readonly duplicate: true; readonly data: T };

export interface CreateCharacterCommand {
  readonly commandId?: string | undefined;
  readonly characterId?: string | undefined;
  readonly principal: AuthorityPrincipal;
  readonly accountId: string;
  readonly characterName: string;
  readonly raceCode: string;
  readonly lineageCode: string;
  readonly cultureCode: string;
  readonly backgroundCode: string;
  readonly originRegionId: string;
  readonly hometownSettlementRef?: string | null | undefined;
  readonly appearance: CharacterAppearanceInput;
  readonly initialAttributeAllocation?: Record<string, unknown> | undefined;
  readonly presetCode?: string | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface AllocateAttributesCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly expectedBuildVersion: number;
  readonly attributeDeltas: Record<string, unknown>;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RespecAttributesCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantExperienceCommand {
  readonly grantId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly sourceType: ExperienceSourceType;
  readonly sourceReference: string;
  readonly rulesVersion?: number | undefined;
  readonly amount: bigint | string | number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UpdateAppearanceCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly expectedAppearanceVersion?: number | undefined;
  readonly appearance: CharacterAppearanceInput;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CharacterEngineDependencies {
  readonly unitOfWork: PostgresCharacterUnitOfWork;
  readonly logger: Logger;
  readonly nameModerationPolicy?: NameModerationPolicy | undefined;
  readonly respecPolicy?: RespecAuthorizationPolicy | undefined;
  readonly beforeCommitHook?:
    | ((context: { operation: string; characterId: string; commandId: string }) => Promise<void>)
    | undefined;
}

function attributeBlockToCanonical(block: AttributeBlock): Record<string, CanonicalizableValue> {
  return {
    strength: block.strength,
    fortitude: block.fortitude,
    vigor: block.vigor,
    agility: block.agility,
    dexterity: block.dexterity,
    intelligence: block.intelligence,
    wisdom: block.wisdom,
    determination: block.determination,
    luck: block.luck,
    charisma: block.charisma,
  };
}

export class CharacterEngineService {
  private readonly unitOfWork: PostgresCharacterUnitOfWork;
  private readonly logger: Logger;
  private readonly nameModerationPolicy: NameModerationPolicy;
  private readonly respecPolicy: RespecAuthorizationPolicy | undefined;
  private readonly beforeCommitHook:
    | ((context: { operation: string; characterId: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: CharacterEngineDependencies) {
    this.unitOfWork = deps.unitOfWork;
    this.logger = deps.logger;
    this.nameModerationPolicy =
      deps.nameModerationPolicy ?? new DefaultOfflineNameModerationPolicy();
    this.respecPolicy = deps.respecPolicy;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async createCharacter(
    cmd: CreateCharacterCommand,
  ): Promise<IdempotentCommandOutcome<Character>> {
    assertNotGenesisContext("createCharacter", cmd.executionProfile);

    if (
      cmd.principal.kind === "authenticated_account" &&
      cmd.principal.accountId.toLowerCase() !== cmd.accountId.toLowerCase()
    ) {
      throw new CharacterOwnershipForbiddenError(
        cmd.characterId ?? "<new-character>",
        cmd.principal.accountId,
      );
    }

    const normalizedName = validateAndNormalizeCharacterName(
      cmd.characterName,
      this.nameModerationPolicy,
    );
    const originRegionId = cmd.originRegionId.trim();
    if (!originRegionId || originRegionId.length > 64) {
      throw new AttributeAllocationInvalidError("originRegionId must be 1..64 non-blank characters.");
    }

    if (cmd.initialAttributeAllocation && cmd.presetCode) {
      throw new AttributeAllocationInvalidError(
        "Specify either initialAttributeAllocation or presetCode, not both.",
      );
    }

    let initialDelta: AttributeBlock | null = null;
    if (cmd.presetCode !== undefined) {
      const preset = BUILD_ARCHETYPE_PRESETS[cmd.presetCode];
      if (!preset) {
        throw new AttributeAllocationInvalidError(`Unknown build preset '${cmd.presetCode}'.`);
      }
      initialDelta = preset.allocatedAttributes;
    } else if (cmd.initialAttributeAllocation !== undefined) {
      initialDelta = parseStrictAttributeDeltaObject(cmd.initialAttributeAllocation, false);
    }

    const now = new Date();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const commandKey = cmd.commandId ?? `create-char:${cmd.characterId ?? randomUUID()}`;
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const targetCharacterId = cmd.characterId ?? deriveDeterministicEventUuid(`char:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CreateCharacter",
      account_id: cmd.accountId.toLowerCase(),
      canonical_name: normalizedName.canonicalName,
      race_code: cmd.raceCode,
      lineage_code: cmd.lineageCode,
      culture_code: cmd.cultureCode,
      background_code: cmd.backgroundCode,
      origin_region_id: originRegionId,
      preset_code: cmd.presetCode ?? null,
      initial_alloc: initialDelta
        ? attributeBlockToCanonical(initialDelta)
        : attributeBlockToCanonical(createZeroAttributeBlock()),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterCreated",
        eventVersion: 1,
        source: "carbon.character-engine",
        correlationUuid: eventUuid,
        aggregateUuid: targetCharacterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const existing = await scope.findCharacterById(targetCharacterId);
        if (!existing) {
          throw new CharacterNotFoundError(targetCharacterId);
        }
        return { status: "duplicate_idempotent", duplicate: true, data: existing };
      }

      const account = await scope.lockAccountById(cmd.accountId);
      if (!account) {
        throw new AccountNotFoundError(cmd.accountId);
      }
      assertAccountActive(account);

      const rules = await scope.loadProgressionRules(rulesVersion);
      if (!rules) {
        throw new ExperienceGrantInvalidError(`Unknown progression rules_version ${rulesVersion}.`);
      }

      const maxAllowedChars = account.maxCharactersOverride ?? rules.maxCharactersPerAccount;
      const existingCount = await scope.countCharactersForAccount(account.id);
      if (existingCount >= maxAllowedChars) {
        throw new AccountCharacterLimitReachedError(account.id, maxAllowedChars);
      }

      const people = await scope.catalogs.findPeople(cmd.raceCode, scope.client);
      if (!people || !people.isPlayable || !people.isEnabled) {
        throw new PeopleDisabledError(cmd.raceCode);
      }

      const lineage = await scope.catalogs.findLineage(cmd.lineageCode, scope.client);
      if (!lineage || !lineage.isEnabled || lineage.raceCode !== people.raceCode) {
        throw new LineageIncompatibleError(cmd.lineageCode, cmd.raceCode);
      }

      const culture = await scope.catalogs.findCulture(cmd.cultureCode, scope.client);
      if (!culture || !culture.isEnabled) {
        throw new CultureInvalidError(cmd.cultureCode);
      }

      const background = await scope.catalogs.findBackground(cmd.backgroundCode, scope.client);
      if (!background || !background.isEnabled) {
        throw new BackgroundInvalidError(cmd.backgroundCode);
      }

      const validatedAppearance = validateCharacterAppearance(
        cmd.appearance,
        people.customizationProfile,
      );

      const character = Character.createInitial({
        id: targetCharacterId,
        accountId: account.id,
        displayName: normalizedName.displayName,
        canonicalName: normalizedName.canonicalName,
        raceCode: people.raceCode,
        lineageCode: lineage.lineageCode,
        cultureCode: culture.cultureCode,
        backgroundCode: background.backgroundCode,
        originRegionId,
        hometownSettlementRef: cmd.hometownSettlementRef?.trim() || null,
        appearance: validatedAppearance,
        initialAllocationDelta: initialDelta,
        rules,
        now,
      });

      await scope.insertCharacterGraph(character);

      await scope.insertBuildHistory({
        id: randomUUID(),
        characterId: character.id,
        buildVersion: character.buildVersion,
        operationType: "initial_creation",
        causeEventId: claim.eventUuid,
        presetCode: cmd.presetCode ?? null,
        previousAllocated: createZeroAttributeBlock(),
        newAllocated: character.allocatedAttributes,
        unspentAfter: character.unspentAttributePoints,
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: character.id,
        eventType: "CharacterCreated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          race_code: character.raceCode,
          lineage_code: character.lineageCode,
          culture_code: character.cultureCode,
          background_code: character.backgroundCode,
          origin_region_id: character.originRegionId,
          level: character.level,
          build_version: character.buildVersion,
        },
      });

      if (sumAttributeBlock(character.allocatedAttributes) > 0) {
        await scope.enqueueOutbox({
          id: randomUUID(),
          characterId: character.id,
          eventType: "CharacterBuildChanged",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: character.id,
            build_version: character.buildVersion,
            operation: "initial_creation",
            allocated_attributes: character.allocatedAttributes,
            unspent_attribute_points: character.unspentAttributePoints,
          },
        });
      }

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "createCharacter",
          characterId: character.id,
          commandId: commandKey,
        });
      }

      this.logger.info("Created persistent character", {
        event_id: commandKey,
        aggregate_id: character.id,
        operation: "createCharacter",
        result: "applied",
      });

      return { status: "applied", duplicate: false, data: character };
    });
  }

  public async allocateAttributes(
    cmd: AllocateAttributesCommand,
  ): Promise<IdempotentCommandOutcome<Character>> {
    assertNotGenesisContext("allocateAttributes", cmd.executionProfile);
    if (!cmd.commandId.trim()) {
      throw new AttributeAllocationInvalidError("commandId cannot be blank.");
    }

    const delta = parseStrictAttributeDeltaObject(cmd.attributeDeltas, true);
    const now = new Date();
    const commandKey = cmd.commandId.trim();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "AllocateAttributes",
      character_id: cmd.characterId.toLowerCase(),
      expected_build_version: cmd.expectedBuildVersion,
      deltas: attributeBlockToCanonical(delta),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterAttributesAllocated",
        eventVersion: 1,
        source: "carbon.character-engine",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const current = await scope.lockCharacterById(cmd.characterId);
      if (!current) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      current.assertOwnedByOrSystem(cmd.principal);

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: current };
      }

      const rules = await scope.loadProgressionRules(current.rulesVersion);
      if (!rules) {
        throw new ExperienceGrantInvalidError(
          `Missing progression rules_version ${current.rulesVersion}.`,
        );
      }

      const updated = current.allocateAttributes({
        principal: cmd.principal,
        deltaToAdd: delta,
        expectedBuildVersion: cmd.expectedBuildVersion,
        rules,
        executionProfile: cmd.executionProfile,
        now,
      });

      await scope.updateBuildAndAttributes(updated, current.buildVersion);

      await scope.insertBuildHistory({
        id: randomUUID(),
        characterId: updated.id,
        buildVersion: updated.buildVersion,
        operationType: "allocate_points",
        causeEventId: claim.eventUuid,
        presetCode: null,
        previousAllocated: current.allocatedAttributes,
        newAllocated: updated.allocatedAttributes,
        unspentAfter: updated.unspentAttributePoints,
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterAttributesAllocated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          build_version: updated.buildVersion,
          deltas: delta,
          unspent_attribute_points: updated.unspentAttributePoints,
        },
      });

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          build_version: updated.buildVersion,
          operation: "allocate_points",
          allocated_attributes: updated.allocatedAttributes,
          unspent_attribute_points: updated.unspentAttributePoints,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "allocateAttributes",
          characterId: updated.id,
          commandId: commandKey,
        });
      }

      return { status: "applied", duplicate: false, data: updated };
    });
  }

  public async respecAttributes(
    cmd: RespecAttributesCommand,
  ): Promise<IdempotentCommandOutcome<Character>> {
    assertNotGenesisContext("respecAttributes", cmd.executionProfile);
    if (!cmd.commandId.trim()) {
      throw new AttributeAllocationInvalidError("commandId cannot be blank.");
    }

    const now = new Date();
    const commandKey = cmd.commandId.trim();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RespecAttributes",
      character_id: cmd.characterId.toLowerCase(),
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterAttributesReset",
        eventVersion: 1,
        source: "carbon.character-engine",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const current = await scope.lockCharacterById(cmd.characterId);
      if (!current) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      current.assertOwnedByOrSystem(cmd.principal);

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: current };
      }

      const updated = current.respecAttributes({
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
        policy: this.respecPolicy,
        executionProfile: cmd.executionProfile,
        now,
      });

      await scope.updateBuildAndAttributes(updated, current.buildVersion);

      await scope.insertBuildHistory({
        id: randomUUID(),
        characterId: updated.id,
        buildVersion: updated.buildVersion,
        operationType: "respec_reset",
        causeEventId: claim.eventUuid,
        presetCode: null,
        previousAllocated: current.allocatedAttributes,
        newAllocated: updated.allocatedAttributes,
        unspentAfter: updated.unspentAttributePoints,
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterAttributesReset",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          build_version: updated.buildVersion,
          recovered_points: current.allocatedAttributePoints,
          unspent_attribute_points: updated.unspentAttributePoints,
        },
      });

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          build_version: updated.buildVersion,
          operation: "respec_reset",
          allocated_attributes: updated.allocatedAttributes,
          unspent_attribute_points: updated.unspentAttributePoints,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "respecAttributes",
          characterId: updated.id,
          commandId: commandKey,
        });
      }

      return { status: "applied", duplicate: false, data: updated };
    });
  }

  /**
   * Authoritative internal-only XP grant operation.
   * Rejects direct unverified account/player principals so clients can never grant themselves XP.
   */
  public async grantExperience(cmd: GrantExperienceCommand): Promise<
    IdempotentCommandOutcome<{
      readonly character: Character;
      readonly grant: ExperienceGrantRecord;
    }>
  > {
    assertNotGenesisContext("grantExperience", cmd.executionProfile);

    if (cmd.principal.kind !== "internal_system_authority") {
      throw new CharacterOwnershipForbiddenError(cmd.characterId, cmd.principal.accountId);
    }
    const systemActorId = cmd.principal.actorId;

    const grantKey = cmd.grantId.trim();
    const sourceRef = cmd.sourceReference.trim();
    if (!grantKey || grantKey.length > 255 || !sourceRef || sourceRef.length > 128) {
      throw new ExperienceGrantInvalidError(
        "grantId (1..255) and sourceReference (1..128) must be non-blank.",
      );
    }
    if (!AUTHORIZED_EXPERIENCE_SOURCE_TYPES.includes(cmd.sourceType)) {
      throw new ExperienceGrantInvalidError(`Unauthorized XP sourceType '${String(cmd.sourceType)}'.`);
    }

    const parsedAmount = PositiveInt64Schema.safeParse(cmd.amount);
    if (!parsedAmount.success) {
      const msg = parsedAmount.error.issues.map((i) => i.message).join("; ");
      throw new ExperienceGrantInvalidError(`Invalid experience amount: ${msg}`);
    }
    const validatedAmount = parsedAmount.data;

    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(grantKey);
    const requestedRulesVersion = cmd.rulesVersion ?? 1;

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantExperience",
      grant_id: grantKey,
      character_id: cmd.characterId.toLowerCase(),
      source_type: cmd.sourceType,
      source_reference: sourceRef,
      rules_version: requestedRulesVersion,
      validated_amount: validatedAmount,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: grantKey,
        idempotencyKey: grantKey,
        eventType: "CharacterExperienceGranted",
        eventVersion: 1,
        source: `carbon.xp:${systemActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const current = await scope.lockCharacterById(cmd.characterId);
      if (!current) {
        throw new CharacterNotFoundError(cmd.characterId);
      }

      if (claim.status === "duplicate_verified") {
        const existingGrant = await scope.findExperienceGrantByExternalId(grantKey);
        if (!existingGrant) {
          throw new Error(`Missing experience_grants row for verified duplicate '${grantKey}'.`);
        }
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { character: current, grant: existingGrant },
        };
      }

      if (current.rulesVersion !== requestedRulesVersion) {
        throw new ExperienceGrantInvalidError(
          `Character '${current.id}' uses rulesVersion ${current.rulesVersion}, but grant requested ${requestedRulesVersion}.`,
        );
      }

      const rules = await scope.loadProgressionRules(current.rulesVersion);
      if (!rules) {
        throw new ExperienceGrantInvalidError(
          `Missing progression rules_version ${current.rulesVersion}.`,
        );
      }

      const { updated, advancement } = current.applyExperienceGrant({
        validatedAmount,
        rules,
        executionProfile: cmd.executionProfile,
        now,
      });

      await scope.updateProgression(updated);

      const grantRecord: ExperienceGrantRecord = {
        id: randomUUID(),
        processedEventId: claim.eventUuid,
        externalGrantId: grantKey,
        characterId: updated.id,
        sourceType: cmd.sourceType,
        sourceReference: sourceRef,
        rulesVersion: updated.rulesVersion,
        validatedAmount,
        previousXp: advancement.previousXp,
        newXp: advancement.newXp,
        previousLevel: advancement.previousLevel,
        newLevel: advancement.newLevel,
        attributePointsAwarded: advancement.attributePointsAwarded,
        payloadFingerprint: fingerprint,
        grantedAt: now,
      };

      await scope.insertExperienceGrant(grantRecord);

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterExperienceGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          grant_id: grantRecord.externalGrantId,
          source_type: grantRecord.sourceType,
          source_reference: grantRecord.sourceReference,
          validated_amount: grantRecord.validatedAmount.toString(),
          new_experience_total: updated.experienceTotal.toString(),
          level: updated.level,
        },
      });

      if (advancement.levelsGained > 0) {
        await scope.enqueueOutbox({
          id: randomUUID(),
          characterId: updated.id,
          eventType: "CharacterLevelUp",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: updated.id,
            previous_level: advancement.previousLevel,
            new_level: advancement.newLevel,
            levels_gained: advancement.levelsGained,
            attribute_points_awarded: advancement.attributePointsAwarded,
            unspent_attribute_points: updated.unspentAttributePoints,
          },
        });
      }

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "grantExperience",
          characterId: updated.id,
          commandId: grantKey,
        });
      }

      return {
        status: "applied",
        duplicate: false,
        data: { character: updated, grant: grantRecord },
      };
    });
  }

  public async updateAppearance(
    cmd: UpdateAppearanceCommand,
  ): Promise<IdempotentCommandOutcome<Character>> {
    assertNotGenesisContext("updateAppearance", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    if (!commandKey) {
      throw new AttributeAllocationInvalidError("commandId cannot be blank.");
    }

    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "UpdateAppearance",
      character_id: cmd.characterId.toLowerCase(),
      expected_appearance_version: cmd.expectedAppearanceVersion ?? null,
      body_preset: cmd.appearance.bodyPreset,
      skin_tone: cmd.appearance.skinTone,
      eye_style: cmd.appearance.eyeStyle,
      eye_color: cmd.appearance.eyeColor,
      hair_style: cmd.appearance.hairStyle ?? null,
      hair_color: cmd.appearance.hairColor ?? null,
      beard_style: cmd.appearance.beardStyle ?? null,
      ear_style: cmd.appearance.earStyle ?? null,
      horn_style: cmd.appearance.hornStyle ?? null,
      tail_style: cmd.appearance.tailStyle ?? null,
      scale_pattern: cmd.appearance.scalePattern ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterAppearanceChanged",
        eventVersion: 1,
        source: "carbon.character-engine",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const current = await scope.lockCharacterById(cmd.characterId);
      if (!current) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      current.assertOwnedByOrSystem(cmd.principal);

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: current };
      }

      const people = await scope.catalogs.findPeople(current.raceCode, scope.client);
      if (!people) {
        throw new PeopleDisabledError(current.raceCode);
      }

      const validatedAppearance = validateCharacterAppearance(
        cmd.appearance,
        people.customizationProfile,
      );

      const updated = current.updateAppearance({
        principal: cmd.principal,
        validatedAppearance,
        expectedAppearanceVersion: cmd.expectedAppearanceVersion,
        executionProfile: cmd.executionProfile,
        now,
      });

      await scope.updateAppearance(updated, current.appearanceVersion);

      await scope.enqueueOutbox({
        id: randomUUID(),
        characterId: updated.id,
        eventType: "CharacterAppearanceChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: updated.id,
          appearance_version: updated.appearanceVersion,
          body_preset: validatedAppearance.bodyPreset,
          skin_tone: validatedAppearance.skinTone,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "updateAppearance",
          characterId: updated.id,
          commandId: commandKey,
        });
      }

      return { status: "applied", duplicate: false, data: updated };
    });
  }
}
