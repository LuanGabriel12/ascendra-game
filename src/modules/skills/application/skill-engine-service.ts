import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import { PositiveInt64Schema } from "../../../shared/contracts/int64-wire.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  assertNotGenesisContext,
  type AuthorityPrincipal,
  type Character,
} from "../../characters/domain/character.js";
import {
  AccountInactiveError,
  CharacterBuildConflictError,
  CharacterCompetitiveLockedError,
  CharacterNotFoundError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import { PgInventoryTransactionScope } from "../../inventory/infrastructure/postgres-inventory-unit-of-work.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import {
  AbilityLoadoutInvalidError,
  AbilityRankLimitExceededError,
  MasteryAntiFarmingRejectedError,
  MasteryNumericOverflowError,
  SkillAuthorizationForbiddenError,
  SkillCatalogDisabledOrNotFoundError,
  SkillPrerequisiteUnmetError,
  SpecializationBudgetInsufficientError,
} from "../domain/errors.js";
import {
  applyMasteryDiminishingReturns,
  assertCanLearnAbility,
  assertCanUnlockSpecializationNode,
  assertValidMasteryWeaponFamily,
  evaluateMasteryAdvancement,
  evaluateRuntimeAbilityUsageEligibility,
  validateAbilityLoadoutConfiguration,
  type DesiredAbilitySlotInput,
  type EquippedHandItemContext,
} from "../domain/mastery-and-dag-rules.js";
import {
  MASTERY_EXPERIENCE_SOURCE_TYPES,
  SPECIALIZATION_POINT_SOURCE_TYPES,
  type AbilityDefinition,
  type CharacterLearnedAbility,
  type CharacterSpecializationPoints,
  type CharacterSpecializationUnlock,
  type CharacterWeaponMastery,
  type EquippedAbilityLoadoutSlot,
  type MasteryExperienceGrantRecord,
  type MasteryExperienceSourceType,
  type MasteryWeaponFamilyCode,
  type SpecializationNodeDefinition,
  type SpecializationPointSourceType,
} from "../domain/skill-and-mastery-types.js";
import {
  PostgresSkillUnitOfWork,
  type PgSkillTransactionScope,
} from "../infrastructure/postgres-skill-unit-of-work.js";

function assertSystemAuthority(principal: AuthorityPrincipal, operation: string): string {
  if (principal.kind !== "internal_system_authority") {
    throw new SkillAuthorizationForbiddenError(
      `Operation '${operation}' requires internal_system_authority; client/account principals cannot self-grant progression.`,
    );
  }
  return principal.actorId;
}

function parsePositiveMasteryBigInt(raw: bigint | string | number, label: string): bigint {
  const parsed = PositiveInt64Schema.safeParse(raw);
  if (!parsed.success) {
    throw new MasteryNumericOverflowError(
      `Invalid or overflowing ${label}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export interface GrantWeaponMasteryExperienceCommand {
  readonly grantId: string;
  readonly sourceEventId?: string | undefined;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly weaponFamilyCode: MasteryWeaponFamilyCode;
  readonly sourceType: MasteryExperienceSourceType;
  readonly experienceAmount: bigint | string | number;
  readonly counterpartyCharacterId?: string | undefined;
  readonly enforceAntiFarmingCooldown?: boolean | undefined;
  readonly applyDiminishingReturns?: boolean | undefined;
  readonly occurredAt?: Date | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantSpecializationPointsCommand {
  readonly grantId: string;
  readonly sourceEventId?: string | undefined;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly sourceType: SpecializationPointSourceType;
  readonly pointsAmount: number;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UnlockSpecializationNodeCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly nodeCode: string;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface LearnAbilityCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly abilityCode: string;
  readonly abilityVersion?: number | undefined;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UpgradeAbilityRankCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly abilityCode: string;
  readonly ranksToGain?: number | undefined;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface EquipAbilityCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly slotIndex: number;
  readonly abilityCode: string;
  readonly targetLoadoutId?: string | undefined;
  readonly allowSuppressedConfiguration?: boolean | undefined;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UnequipAbilityCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly slotIndex: number;
  readonly targetLoadoutId?: string | undefined;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SaveLoadoutAbilitiesCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly loadoutId: string;
  readonly assignments: ReadonlyArray<DesiredAbilitySlotInput>;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ResetSpecializationCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SkillEngineDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; characterId: string; commandId: string }) => Promise<void>)
    | undefined;
}

async function assertCharacterMutableByPrincipal(params: {
  readonly scope: PgSkillTransactionScope;
  readonly character: Character;
  readonly principal: AuthorityPrincipal;
  readonly expectedBuildVersion?: number | undefined;
}): Promise<void> {
  params.character.assertOwnedByOrSystem(params.principal);
  const accStatus = await params.scope.findAccountStatus(params.character.accountId);
  if (accStatus && accStatus !== "active") {
    throw new AccountInactiveError(params.character.accountId, accStatus);
  }
  if (params.character.competitiveLockState === "in_ranked_series") {
    throw new CharacterCompetitiveLockedError(params.character.id);
  }
  if (params.expectedBuildVersion !== undefined) {
    params.character.assertExpectedBuildVersion(params.expectedBuildVersion);
  }
}

async function bumpCharacterBuildAndSnapshotVersion(params: {
  readonly scope: PgSkillTransactionScope;
  readonly character: Character;
  readonly now: Date;
}): Promise<{ readonly nextBuildVersion: number; readonly nextSnapshotVersion: number }> {
  const nextBuildVersion = params.character.buildVersion + 1;
  const nextSnapshotVersion = params.character.snapshotVersion + 1;
  const res = await params.scope.client.query(
    `UPDATE characters
     SET build_version = $1,
         snapshot_version = $2,
         updated_at = $3
     WHERE id = $4::uuid AND build_version = $5`,
    [
      nextBuildVersion,
      nextSnapshotVersion,
      params.now,
      params.character.id,
      params.character.buildVersion,
    ],
  );
  if (res.rowCount !== 1) {
    throw new CharacterBuildConflictError(
      params.character.id,
      params.character.buildVersion,
      nextBuildVersion,
    );
  }
  return { nextBuildVersion, nextSnapshotVersion };
}

async function loadEquippedHandItemsForLoadout(
  invScope: PgInventoryTransactionScope,
  loadoutId: string,
): Promise<ReadonlyArray<EquippedHandItemContext>> {
  const eqSlots = await invScope.listLoadoutSlots(loadoutId);
  const handContexts: EquippedHandItemContext[] = [];
  for (const s of eqSlots) {
    if (s.slotCode !== "main_hand" && s.slotCode !== "off_hand") {
      continue;
    }
    const inst = await invScope.findItemInstanceById(s.itemInstanceId);
    if (!inst || inst.locationState !== "equipped_active") {
      continue;
    }
    const def = await invScope.findItemDefinition(inst.definitionCode, inst.definitionVersion);
    if (!def) {
      continue;
    }
    handContexts.push({ slotCode: s.slotCode, instance: inst, definition: def });
  }
  return handContexts;
}

export class SkillEngineService {
  private readonly pool: PgPool;
  private readonly unitOfWork: PostgresSkillUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; characterId: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: SkillEngineDependencies) {
    this.pool = deps.pool;
    this.unitOfWork = new PostgresSkillUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  /**
   * Authoritative, idempotent weapon mastery XP grant with anti-farming protections:
   * - Requires `internal_system_authority` (rejects client self-grants).
   * - Rejects same-account counterparty farming (`counterpartyAccountId === character.accountId`).
   * - Enforces single-grant-per-source-event (`UNIQUE (source_event_id, character_id)`) so multi-weapon swaps cannot duplicate XP.
   * - Enforces optional cooldown, window cap, and diminishing returns.
   */
  public async grantWeaponMasteryExperience(
    cmd: GrantWeaponMasteryExperienceCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly mastery: CharacterWeaponMastery;
      readonly grant: MasteryExperienceGrantRecord;
    }>
  > {
    assertNotGenesisContext("grantWeaponMasteryExperience", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "grantWeaponMasteryExperience");
    assertValidMasteryWeaponFamily(cmd.weaponFamilyCode);
    if (
      !(MASTERY_EXPERIENCE_SOURCE_TYPES as ReadonlyArray<string>).includes(cmd.sourceType)
    ) {
      throw new MasteryAntiFarmingRejectedError(`Unsupported mastery sourceType '${cmd.sourceType}'.`);
    }

    const requestedAmount = parsePositiveMasteryBigInt(cmd.experienceAmount, "experienceAmount");
    const grantKey = cmd.grantId.trim();
    const sourceEventId = (cmd.sourceEventId ?? grantKey).trim();
    if (!grantKey || !sourceEventId) {
      throw new MasteryAntiFarmingRejectedError("grantId and sourceEventId must be non-blank.");
    }

    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = cmd.occurredAt ?? new Date();
    const eventUuid = deriveDeterministicEventUuid(grantKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantWeaponMasteryExperience",
      grant_id: grantKey,
      source_event_id: sourceEventId,
      character_id: cmd.characterId.toLowerCase(),
      weapon_family_code: cmd.weaponFamilyCode,
      source_type: cmd.sourceType,
      experience_amount: requestedAmount.toString(),
      counterparty_character_id: cmd.counterpartyCharacterId?.toLowerCase() ?? null,
      rules_version: rulesVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: grantKey,
        idempotencyKey: grantKey,
        eventType: "WeaponMasteryExperienceGranted",
        eventVersion: 1,
        source: `carbon.skills:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      // Canonical lock order: characters FIRST!
      const orderedCharIds = cmd.counterpartyCharacterId
        ? [cmd.characterId, cmd.counterpartyCharacterId].sort()
        : [cmd.characterId];
      const c0 = await charScope.lockCharacterById(orderedCharIds[0]!);
      const c1 =
        orderedCharIds.length > 1 && orderedCharIds[1] !== orderedCharIds[0]
          ? await charScope.lockCharacterById(orderedCharIds[1]!)
          : c0;

      const character = cmd.characterId === orderedCharIds[0] ? c0 : c1;
      const counterparty =
        cmd.counterpartyCharacterId !== undefined
          ? cmd.counterpartyCharacterId === orderedCharIds[0]
            ? c0
            : c1
          : null;

      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      if (cmd.counterpartyCharacterId !== undefined && !counterparty) {
        throw new CharacterNotFoundError(cmd.counterpartyCharacterId);
      }

      const rules = await scope.loadRules(rulesVersion);
      const currentMastery = await scope.ensureAndLockWeaponMastery(
        character.id,
        cmd.weaponFamilyCode,
        rules.rulesVersion,
      );

      if (claim.status === "duplicate_verified") {
        const existingGrant = await scope.findMasteryGrantByExternalId(grantKey);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { mastery: currentMastery, grant: existingGrant! },
        };
      }

      // Anti-farming: block self or same-account alt-character combat farming
      if (counterparty) {
        if (
          counterparty.id === character.id ||
          counterparty.accountId.toLowerCase() === character.accountId.toLowerCase()
        ) {
          throw new MasteryAntiFarmingRejectedError(
            "Mastery XP rejected: counterparty belongs to the same account (alt-farming forbidden).",
          );
        }
      }

      const windowStats = await scope.countMasteryGrantsInWindow({
        characterId: character.id,
        weaponFamilyCode: cmd.weaponFamilyCode,
        sourceType: cmd.sourceType,
        windowSeconds: rules.antiFarmWindowSeconds,
        now,
      });

      if (cmd.enforceAntiFarmingCooldown === true) {
        if (
          windowStats.latestGrantedAt &&
          now.getTime() - windowStats.latestGrantedAt.getTime() <
            rules.antiFarmCooldownSeconds * 1000
        ) {
          throw new MasteryAntiFarmingRejectedError(
            `Mastery XP rejected: anti-farming cooldown (${rules.antiFarmCooldownSeconds}s) active for '${cmd.weaponFamilyCode}'.`,
          );
        }
        if (windowStats.countInWindow >= rules.antiFarmMaxGrantsPerWindow) {
          throw new MasteryAntiFarmingRejectedError(
            `Mastery XP rejected: window cap (${rules.antiFarmMaxGrantsPerWindow}) reached for '${cmd.weaponFamilyCode}'.`,
          );
        }
      }

      const validatedAmount =
        cmd.applyDiminishingReturns === true
          ? applyMasteryDiminishingReturns({
              baseAmount: requestedAmount,
              priorGrantsInWindow: windowStats.countInWindow,
              stepBp: rules.diminishingReturnsStepBp,
            })
          : requestedAmount;

      const adv = evaluateMasteryAdvancement({
        currentXp: currentMastery.masteryExperience,
        currentLevel: currentMastery.masteryLevel,
        validatedGrantAmount: validatedAmount,
        rules,
      });

      const updatedMastery: CharacterWeaponMastery = {
        ...currentMastery,
        masteryExperience: adv.newXp,
        masteryLevel: adv.newLevel,
        proficiencyRank: adv.newRank,
        rulesVersion: rules.rulesVersion,
        version: currentMastery.version + 1,
        updatedAt: now,
      };
      await scope.updateWeaponMastery(updatedMastery, currentMastery.version);

      const grantRecordId = deriveDeterministicEventUuid(`mastery-grant:${grantKey}`);
      const grantRecord: MasteryExperienceGrantRecord = {
        id: grantRecordId,
        processedEventId: claim.eventUuid,
        externalGrantId: grantKey,
        sourceEventId,
        characterId: character.id,
        counterpartyCharacterId: counterparty?.id ?? null,
        counterpartyAccountId: counterparty?.accountId ?? null,
        weaponFamilyCode: cmd.weaponFamilyCode,
        sourceType: cmd.sourceType,
        requestedAmount,
        validatedAmount,
        previousXp: adv.previousXp,
        newXp: adv.newXp,
        previousLevel: adv.previousLevel,
        newLevel: adv.newLevel,
        rulesVersion: rules.rulesVersion,
        payloadFingerprint: fingerprint,
        grantedAt: now,
      };

      try {
        await scope.client.query(
          `INSERT INTO mastery_experience_grants (
             id, processed_event_id, external_grant_id, source_event_id,
             character_id, counterparty_character_id, counterparty_account_id,
             weapon_family_code, source_type, requested_amount, validated_amount,
             previous_xp, new_xp, previous_level, new_level,
             rules_version, payload_fingerprint, granted_at
           )
           VALUES (
             $1::uuid, $2::uuid, $3, $4,
             $5::uuid, $6::uuid, $7::uuid,
             $8, $9, $10::bigint, $11::bigint,
             $12::bigint, $13::bigint, $14, $15,
             $16, $17, $18
           )`,
          [
            grantRecord.id,
            grantRecord.processedEventId,
            grantRecord.externalGrantId,
            grantRecord.sourceEventId,
            grantRecord.characterId,
            grantRecord.counterpartyCharacterId,
            grantRecord.counterpartyAccountId,
            grantRecord.weaponFamilyCode,
            grantRecord.sourceType,
            grantRecord.requestedAmount.toString(),
            grantRecord.validatedAmount.toString(),
            grantRecord.previousXp.toString(),
            grantRecord.newXp.toString(),
            grantRecord.previousLevel,
            grantRecord.newLevel,
            grantRecord.rulesVersion,
            grantRecord.payloadFingerprint,
            grantRecord.grantedAt,
          ],
        );
      } catch (err) {
        if (
          err instanceof pg.DatabaseError &&
          err.code === "23505" &&
          err.constraint === "uq_mastery_grants_single_family_per_source_event"
        ) {
          throw new MasteryAntiFarmingRejectedError(
            `Source event '${sourceEventId}' already awarded weapon mastery to character '${character.id}'; multi-weapon reward duplication forbidden.`,
          );
        }
        throw err;
      }

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "mastery_xp_granted",
        weaponFamilyCode: cmd.weaponFamilyCode,
        previousMasteryLevel: adv.previousLevel,
        newMasteryLevel: adv.newLevel,
        sourceEventId,
        rulesVersion: rules.rulesVersion,
        metadata: {
          requested_amount: requestedAmount.toString(),
          validated_amount: validatedAmount.toString(),
          new_xp: adv.newXp.toString(),
          source_type: cmd.sourceType,
        },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "WeaponMasteryExperienceGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          weapon_family_code: cmd.weaponFamilyCode,
          validated_amount: validatedAmount.toString(),
          new_xp: adv.newXp.toString(),
          previous_level: adv.previousLevel,
          new_level: adv.newLevel,
        },
      });

      if (adv.levelsGained > 0) {
        await scope.client.query(
          "UPDATE characters SET snapshot_version = snapshot_version + 1, updated_at = $1 WHERE id = $2::uuid",
          [now, character.id],
        );

        await scope.appendSkillHistory({
          characterId: character.id,
          operationType: "mastery_level_up",
          weaponFamilyCode: cmd.weaponFamilyCode,
          previousMasteryLevel: adv.previousLevel,
          newMasteryLevel: adv.newLevel,
          sourceEventId,
          rulesVersion: rules.rulesVersion,
          metadata: {
            previous_rank: adv.previousRank,
            new_rank: adv.newRank,
            crossed_milestones: adv.crossedMilestones,
          },
          recordedAt: now,
        });

        await scope.enqueueOutbox({
          aggregateType: "CharacterSkillProgression",
          aggregateId: character.id,
          eventType: "WeaponMasteryLevelUp",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: character.id,
            weapon_family_code: cmd.weaponFamilyCode,
            previous_level: adv.previousLevel,
            new_level: adv.newLevel,
            proficiency_rank: adv.newRank,
          },
        });

        if (adv.crossedMilestones.length > 0 || adv.previousRank !== adv.newRank) {
          await scope.enqueueOutbox({
            aggregateType: "CharacterSkillProgression",
            aggregateId: character.id,
            eventType: "MasteryAchievementRecorded",
            correlationUuid: eventUuid,
            causationEventUuid: claim.eventUuid,
            occurredAt: now,
            payload: {
              character_id: character.id,
              weapon_family_code: cmd.weaponFamilyCode,
              mastery_level: adv.newLevel,
              proficiency_rank: adv.newRank,
              crossed_milestones: adv.crossedMilestones,
            },
          });
        }
      }

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "grantWeaponMasteryExperience",
          characterId: character.id,
          commandId: grantKey,
        });
      }

      this.logger.info("Granted authoritative weapon mastery experience", {
        event_id: grantKey,
        aggregate_id: character.id,
        operation: "grantWeaponMasteryExperience",
        result: "applied",
        weapon_family_code: cmd.weaponFamilyCode,
        previous_level: adv.previousLevel,
        new_level: adv.newLevel,
      });

      return {
        status: "applied",
        duplicate: false,
        data: { mastery: updatedMastery, grant: grantRecord },
      };
    });
  }

  public async grantSpecializationPoints(
    cmd: GrantSpecializationPointsCommand,
  ): Promise<IdempotentCommandOutcome<CharacterSpecializationPoints>> {
    assertNotGenesisContext("grantSpecializationPoints", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "grantSpecializationPoints");
    if (
      !(SPECIALIZATION_POINT_SOURCE_TYPES as ReadonlyArray<string>).includes(cmd.sourceType)
    ) {
      throw new SpecializationBudgetInsufficientError(
        `Unsupported specialization point sourceType '${cmd.sourceType}'.`,
      );
    }
    if (!Number.isInteger(cmd.pointsAmount) || cmd.pointsAmount <= 0 || cmd.pointsAmount > 500) {
      throw new SpecializationBudgetInsufficientError(
        `pointsAmount (${cmd.pointsAmount}) must be an integer within 1..500.`,
      );
    }

    const grantKey = cmd.grantId.trim();
    const sourceEventId = (cmd.sourceEventId ?? grantKey).trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(grantKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantSpecializationPoints",
      grant_id: grantKey,
      source_event_id: sourceEventId,
      character_id: cmd.characterId.toLowerCase(),
      source_type: cmd.sourceType,
      points_amount: cmd.pointsAmount,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: grantKey,
        idempotencyKey: grantKey,
        eventType: "SpecializationPointsGranted",
        eventVersion: 1,
        source: `carbon.skills:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const rules = await scope.loadRules(rulesVersion);
      const specPts = await scope.ensureAndLockSpecializationPoints(
        character.id,
        character.level,
        rules,
      );

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: specPts };
      }

      const updated: CharacterSpecializationPoints = {
        ...specPts,
        earnedPoints: specPts.earnedPoints + cmd.pointsAmount,
        unspentPoints: specPts.unspentPoints + cmd.pointsAmount,
        version: specPts.version + 1,
        updatedAt: now,
      };
      await scope.updateSpecializationPoints(updated, specPts.version);

      try {
        await scope.client.query(
          `INSERT INTO character_specialization_point_grants (
             id, processed_event_id, external_grant_id, source_event_id,
             character_id, source_type, points_awarded, payload_fingerprint, granted_at
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9)`,
          [
            deriveDeterministicEventUuid(`spec-pt-grant:${grantKey}`),
            claim.eventUuid,
            grantKey,
            sourceEventId,
            character.id,
            cmd.sourceType,
            cmd.pointsAmount,
            fingerprint,
            now,
          ],
        );
      } catch (err) {
        if (err instanceof pg.DatabaseError && err.code === "23505") {
          throw new SpecializationBudgetInsufficientError(
            `Specialization points were already awarded for sourceEventId '${sourceEventId}'.`,
          );
        }
        throw err;
      }

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "spec_points_granted",
        pointsDelta: cmd.pointsAmount,
        sourceEventId,
        rulesVersion: rules.rulesVersion,
        metadata: {
          source_type: cmd.sourceType,
          earned_points: updated.earnedPoints,
          unspent_points: updated.unspentPoints,
        },
        recordedAt: now,
      });

      return { status: "applied", duplicate: false, data: updated };
    });
  }

  public async unlockSpecializationNode(
    cmd: UnlockSpecializationNodeCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly unlock: CharacterSpecializationUnlock;
      readonly specializationPoints: CharacterSpecializationPoints;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("unlockSpecializationNode", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "UnlockSpecializationNode",
      character_id: cmd.characterId.toLowerCase(),
      node_code: cmd.nodeCode,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "SpecializationNodeUnlocked",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const rules = await scope.loadRules(1);
      const specPts = await scope.ensureAndLockSpecializationPoints(
        character.id,
        character.level,
        rules,
      );
      const masteryMap = await scope.listCharacterMasteriesMap(character.id, true);
      const allUnlocks = await scope.listSpecializationUnlocks(character.id, true);

      if (claim.status === "duplicate_verified") {
        const ex = allUnlocks.find((u) => u.nodeCode === cmd.nodeCode)!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            unlock: ex,
            specializationPoints: specPts,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const node = await scope.findSpecializationNode(cmd.nodeCode);
      if (!node || !node.isEnabled) {
        throw new SkillCatalogDisabledOrNotFoundError("SpecializationNode", cmd.nodeCode);
      }
      const school = await scope.findCombatSchool(node.schoolCode);
      if (!school || !school.isEnabled) {
        throw new SkillCatalogDisabledOrNotFoundError("CombatSchool", node.schoolCode);
      }

      const existingUnlock = allUnlocks.find((u) => u.nodeCode === node.nodeCode);
      if (existingUnlock && existingUnlock.isActive) {
        throw new SkillPrerequisiteUnmetError(
          `Specialization node '${node.nodeCode}' is already unlocked and active.`,
        );
      }

      if (specPts.unspentPoints < node.pointCost) {
        throw new SpecializationBudgetInsufficientError(
          `Insufficient specialization points to unlock '${node.nodeCode}': requires ${node.pointCost}, unspent ${specPts.unspentPoints}.`,
        );
      }

      const allNodeDefs = await scope.listAllSpecializationNodes();
      const defMap = new Map<string, SpecializationNodeDefinition>(
        allNodeDefs.map((d) => [d.nodeCode, d]),
      );
      const activeUnlockedNodeCodes = new Set(
        allUnlocks.filter((u) => u.isActive).map((u) => u.nodeCode),
      );
      const activeUnlockedNodes = Array.from(activeUnlockedNodeCodes)
        .map((c) => defMap.get(c))
        .filter((d): d is SpecializationNodeDefinition => d !== undefined);

      assertCanUnlockSpecializationNode({
        character,
        node,
        masteryMap,
        activeUnlockedNodeCodes,
        activeUnlockedNodes,
      });

      const updatedPts: CharacterSpecializationPoints = {
        ...specPts,
        spentPoints: specPts.spentPoints + node.pointCost,
        unspentPoints: specPts.unspentPoints - node.pointCost,
        version: specPts.version + 1,
        updatedAt: now,
      };
      await scope.updateSpecializationPoints(updatedPts, specPts.version);

      const nextVer = existingUnlock ? existingUnlock.version + 1 : 1;
      await scope.client.query(
        `INSERT INTO character_specialization_unlocks (
           character_id, node_code, is_active, points_invested, unlocked_at, updated_at, version
         )
         VALUES ($1::uuid, $2, TRUE, $3, $4, $4, 1)
         ON CONFLICT (character_id, node_code) DO UPDATE
           SET is_active = TRUE,
               points_invested = EXCLUDED.points_invested,
               updated_at = EXCLUDED.updated_at,
               version = character_specialization_unlocks.version + 1`,
        [character.id, node.nodeCode, node.pointCost, now],
      );

      const { nextBuildVersion } = await bumpCharacterBuildAndSnapshotVersion({
        scope,
        character,
        now,
      });

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "spec_node_unlocked",
        nodeCode: node.nodeCode,
        pointsDelta: -node.pointCost,
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        metadata: { school_code: node.schoolCode, unspent_after: updatedPts.unspentPoints },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "SpecializationNodeUnlocked",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          node_code: node.nodeCode,
          school_code: node.schoolCode,
          point_cost: node.pointCost,
          build_version: nextBuildVersion,
        },
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          build_version: nextBuildVersion,
          operation: "unlock_specialization_node",
        },
      });

      const unlockRecord: CharacterSpecializationUnlock = {
        characterId: character.id,
        nodeCode: node.nodeCode,
        isActive: true,
        pointsInvested: node.pointCost,
        unlockedAt: existingUnlock?.unlockedAt ?? now,
        updatedAt: now,
        version: nextVer,
      };

      return {
        status: "applied",
        duplicate: false,
        data: {
          unlock: unlockRecord,
          specializationPoints: updatedPts,
          buildVersion: nextBuildVersion,
        },
      };
    });
  }

  public async learnAbility(
    cmd: LearnAbilityCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly learned: CharacterLearnedAbility;
      readonly specializationPoints: CharacterSpecializationPoints;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("learnAbility", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "LearnAbility",
      character_id: cmd.characterId.toLowerCase(),
      ability_code: cmd.abilityCode,
      ability_version: cmd.abilityVersion ?? null,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "AbilityLearned",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const rules = await scope.loadRules(1);
      const specPts = await scope.ensureAndLockSpecializationPoints(
        character.id,
        character.level,
        rules,
      );
      const masteryMap = await scope.listCharacterMasteriesMap(character.id, true);
      const allUnlocks = await scope.listSpecializationUnlocks(character.id, true);
      const allLearned = await scope.listLearnedAbilities(character.id, true);

      if (claim.status === "duplicate_verified") {
        const ex = allLearned.find((l) => l.abilityCode === cmd.abilityCode)!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            learned: ex,
            specializationPoints: specPts,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const def = await scope.findAbilityDefinition(cmd.abilityCode, cmd.abilityVersion);
      if (!def || !def.isEnabled) {
        throw new SkillCatalogDisabledOrNotFoundError("AbilityDefinition", cmd.abilityCode);
      }
      const school = await scope.findCombatSchool(def.schoolCode);
      if (!school || !school.isEnabled) {
        throw new SkillCatalogDisabledOrNotFoundError("CombatSchool", def.schoolCode);
      }

      const existing = allLearned.find((l) => l.abilityCode === def.abilityCode);
      if (existing && existing.isActive) {
        throw new SkillPrerequisiteUnmetError(
          `Ability '${def.abilityCode}' is already learned and active on character '${character.id}'.`,
        );
      }

      if (specPts.unspentPoints < def.unlockCost) {
        throw new SpecializationBudgetInsufficientError(
          `Insufficient specialization points to learn '${def.abilityCode}': requires ${def.unlockCost}, unspent ${specPts.unspentPoints}.`,
        );
      }

      const activeUnlockedNodeCodes = new Set(
        allUnlocks.filter((u) => u.isActive).map((u) => u.nodeCode),
      );
      const activeLearnedAbilityCodes = new Set(
        allLearned.filter((l) => l.isActive).map((l) => l.abilityCode),
      );

      assertCanLearnAbility({
        character,
        ability: def,
        masteryMap,
        activeLearnedAbilityCodes,
        activeUnlockedNodeCodes,
      });

      const updatedPts: CharacterSpecializationPoints = {
        ...specPts,
        spentPoints: specPts.spentPoints + def.unlockCost,
        unspentPoints: specPts.unspentPoints - def.unlockCost,
        version: specPts.version + 1,
        updatedAt: now,
      };
      await scope.updateSpecializationPoints(updatedPts, specPts.version);

      const preservedVersion = existing ? existing.abilityVersion : def.abilityVersion;
      const nextMaxEver = existing ? Math.max(existing.maxRankEverReached, 1) : 1;
      const nextRowVer = existing ? existing.version + 1 : 1;

      await scope.client.query(
        `INSERT INTO character_learned_abilities (
           character_id, ability_code, ability_version, current_rank,
           max_rank_ever_reached, is_active, points_invested, learned_at, updated_at, version
         )
         VALUES ($1::uuid, $2, $3, 1, $4, TRUE, $5, $6, $6, 1)
         ON CONFLICT (character_id, ability_code) DO UPDATE
           SET current_rank = 1,
               is_active = TRUE,
               points_invested = EXCLUDED.points_invested,
               updated_at = EXCLUDED.updated_at,
               version = character_learned_abilities.version + 1`,
        [character.id, def.abilityCode, preservedVersion, nextMaxEver, def.unlockCost, now],
      );

      const { nextBuildVersion } = await bumpCharacterBuildAndSnapshotVersion({
        scope,
        character,
        now,
      });

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "ability_learned",
        abilityCode: def.abilityCode,
        previousRank: existing ? existing.currentRank : null,
        newRank: 1,
        pointsDelta: -def.unlockCost,
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        metadata: { ability_version: preservedVersion, school_code: def.schoolCode },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "AbilityLearned",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          ability_code: def.abilityCode,
          ability_version: preservedVersion,
          rank: 1,
          build_version: nextBuildVersion,
        },
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          build_version: nextBuildVersion,
          operation: "learn_ability",
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "learnAbility",
          characterId: character.id,
          commandId: commandKey,
        });
      }

      return {
        status: "applied",
        duplicate: false,
        data: {
          learned: {
            characterId: character.id,
            abilityCode: def.abilityCode,
            abilityVersion: preservedVersion,
            currentRank: 1,
            maxRankEverReached: nextMaxEver,
            isActive: true,
            pointsInvested: def.unlockCost,
            learnedAt: existing?.learnedAt ?? now,
            updatedAt: now,
            version: nextRowVer,
          },
          specializationPoints: updatedPts,
          buildVersion: nextBuildVersion,
        },
      };
    });
  }

  public async upgradeAbilityRank(
    cmd: UpgradeAbilityRankCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly learned: CharacterLearnedAbility;
      readonly specializationPoints: CharacterSpecializationPoints;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("upgradeAbilityRank", cmd.executionProfile);
    const ranksToGain = cmd.ranksToGain ?? 1;
    if (!Number.isInteger(ranksToGain) || ranksToGain < 1 || ranksToGain > 98) {
      throw new AbilityRankLimitExceededError(cmd.abilityCode, ranksToGain, 99);
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "UpgradeAbilityRank",
      character_id: cmd.characterId.toLowerCase(),
      ability_code: cmd.abilityCode,
      ranks_to_gain: ranksToGain,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "AbilityRankIncreased",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const rules = await scope.loadRules(1);
      const specPts = await scope.ensureAndLockSpecializationPoints(
        character.id,
        character.level,
        rules,
      );
      const allLearned = await scope.listLearnedAbilities(character.id, true);

      if (claim.status === "duplicate_verified") {
        const ex = allLearned.find((l) => l.abilityCode === cmd.abilityCode)!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            learned: ex,
            specializationPoints: specPts,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const learned = allLearned.find((l) => l.abilityCode === cmd.abilityCode);
      if (!learned || !learned.isActive) {
        throw new SkillPrerequisiteUnmetError(
          `Cannot upgrade '${cmd.abilityCode}': ability is not learned or is inactive after specialization reset.`,
        );
      }

      const def = await scope.findAbilityDefinition(learned.abilityCode, learned.abilityVersion);
      if (!def || !def.isEnabled) {
        throw new SkillCatalogDisabledOrNotFoundError("AbilityDefinition", learned.abilityCode);
      }

      const nextRank = learned.currentRank + ranksToGain;
      if (nextRank > def.maxRank) {
        throw new AbilityRankLimitExceededError(def.abilityCode, nextRank, def.maxRank);
      }

      const cost = ranksToGain * def.rankUpgradeCost;
      if (specPts.unspentPoints < cost) {
        throw new SpecializationBudgetInsufficientError(
          `Insufficient specialization points to upgrade '${def.abilityCode}' by ${ranksToGain} rank(s): requires ${cost}, unspent ${specPts.unspentPoints}.`,
        );
      }

      const updatedPts: CharacterSpecializationPoints = {
        ...specPts,
        spentPoints: specPts.spentPoints + cost,
        unspentPoints: specPts.unspentPoints - cost,
        version: specPts.version + 1,
        updatedAt: now,
      };
      await scope.updateSpecializationPoints(updatedPts, specPts.version);

      const nextMaxEver = Math.max(learned.maxRankEverReached, nextRank);
      const updatedLearned: CharacterLearnedAbility = {
        ...learned,
        currentRank: nextRank,
        maxRankEverReached: nextMaxEver,
        pointsInvested: learned.pointsInvested + cost,
        updatedAt: now,
        version: learned.version + 1,
      };

      await scope.client.query(
        `UPDATE character_learned_abilities
         SET current_rank = $1,
             max_rank_ever_reached = $2,
             points_invested = $3,
             updated_at = $4,
             version = $5
         WHERE character_id = $6::uuid AND ability_code = $7 AND version = $8`,
        [
          updatedLearned.currentRank,
          updatedLearned.maxRankEverReached,
          updatedLearned.pointsInvested,
          now,
          updatedLearned.version,
          character.id,
          learned.abilityCode,
          learned.version,
        ],
      );

      const { nextBuildVersion } = await bumpCharacterBuildAndSnapshotVersion({
        scope,
        character,
        now,
      });

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "ability_rank_upgraded",
        abilityCode: def.abilityCode,
        previousRank: learned.currentRank,
        newRank: nextRank,
        pointsDelta: -cost,
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "AbilityRankIncreased",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          ability_code: def.abilityCode,
          previous_rank: learned.currentRank,
          new_rank: nextRank,
          build_version: nextBuildVersion,
        },
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          build_version: nextBuildVersion,
          operation: "upgrade_ability_rank",
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          learned: updatedLearned,
          specializationPoints: updatedPts,
          buildVersion: nextBuildVersion,
        },
      };
    });
  }

  public async equipAbility(
    cmd: EquipAbilityCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly loadoutId: string;
      readonly slots: ReadonlyArray<EquippedAbilityLoadoutSlot>;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("equipAbility", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "EquipAbility",
      character_id: cmd.characterId.toLowerCase(),
      slot_index: cmd.slotIndex,
      ability_code: cmd.abilityCode,
      target_loadout_id: cmd.targetLoadoutId?.toLowerCase() ?? null,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const invScope = new PgInventoryTransactionScope(scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "AbilityEquipped",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const { activeLoadout } = await invScope.ensureAndLockPrimaryContainers(character.id, 40);
      const targetLoadoutId = cmd.targetLoadoutId ?? activeLoadout.id;

      if (targetLoadoutId !== activeLoadout.id) {
        const loRes = await scope.client.query<{ character_id: string }>(
          "SELECT character_id FROM equipment_loadouts WHERE id = $1::uuid FOR UPDATE",
          [targetLoadoutId],
        );
        if (!loRes.rows[0] || loRes.rows[0].character_id !== character.id) {
          throw new AbilityLoadoutInvalidError(
            `Loadout '${targetLoadoutId}' does not exist or belong to character '${character.id}'.`,
          );
        }
      }

      const existingSlots = await scope.listLoadoutAbilitySlots(targetLoadoutId, true);
      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            loadoutId: targetLoadoutId,
            slots: existingSlots,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const rules = await scope.loadRules(1);
      const masteryMap = await scope.listCharacterMasteriesMap(character.id, false);
      const unlocks = await scope.listSpecializationUnlocks(character.id, false);
      const learnedList = await scope.listLearnedAbilities(character.id, true);

      if (existingSlots.some((s) => s.slotIndex === cmd.slotIndex)) {
        throw new AbilityLoadoutInvalidError(
          `Ability slot ${cmd.slotIndex} is already occupied on loadout '${targetLoadoutId}'.`,
        );
      }

      const learnedByCode = new Map<string, CharacterLearnedAbility>(
        learnedList.map((l) => [l.abilityCode, l]),
      );
      const defsByCode = new Map<string, AbilityDefinition>();
      for (const l of learnedList) {
        const d = await scope.findAbilityDefinition(l.abilityCode, l.abilityVersion);
        if (d) {
          defsByCode.set(l.abilityCode, d);
        }
      }

      const desired: DesiredAbilitySlotInput[] = [
        ...existingSlots.map((s) => ({ slotIndex: s.slotIndex, abilityCode: s.abilityCode })),
        { slotIndex: cmd.slotIndex, abilityCode: cmd.abilityCode },
      ];

      const summary = validateAbilityLoadoutConfiguration({
        assignments: desired,
        learnedByCode,
        definitionsByCode: defsByCode,
        rules,
      });

      // When equipping directly onto the ACTIVE loadout without `allowSuppressedConfiguration`,
      // require current equipped weapon & durability compatibility!
      if (targetLoadoutId === activeLoadout.id && cmd.allowSuppressedConfiguration !== true) {
        const handItems = await loadEquippedHandItemsForLoadout(invScope, activeLoadout.id);
        const targetDef = defsByCode.get(cmd.abilityCode)!;
        const targetLearned = learnedByCode.get(cmd.abilityCode)!;
        const activeUnlockedSet = new Set(unlocks.filter((u) => u.isActive).map((u) => u.nodeCode));

        const elig = evaluateRuntimeAbilityUsageEligibility({
          character,
          learned: targetLearned,
          definition: targetDef,
          masteryMap,
          activeUnlockedNodeCodes: activeUnlockedSet,
          equippedHandItems: handItems,
        });
        if (!elig.isEligible) {
          throw new AbilityLoadoutInvalidError(
            `Cannot equip '${cmd.abilityCode}' into active combat loadout: ${elig.suppressionReason}.`,
          );
        }
      }

      await scope.replaceLoadoutAbilitySlots({
        loadoutId: targetLoadoutId,
        characterId: character.id,
        slots: summary.orderedSlots,
        now,
      });

      await scope.client.query(
        "UPDATE equipment_loadouts SET version = version + 1, updated_at = $1 WHERE id = $2::uuid",
        [now, targetLoadoutId],
      );

      let finalBuildVersion = character.buildVersion;
      if (targetLoadoutId === activeLoadout.id) {
        const bumped = await bumpCharacterBuildAndSnapshotVersion({ scope, character, now });
        finalBuildVersion = bumped.nextBuildVersion;
      }

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "ability_equipped",
        abilityCode: cmd.abilityCode,
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        metadata: {
          loadout_id: targetLoadoutId,
          slot_index: cmd.slotIndex,
          total_equipment_cost: summary.totalEquipmentCost,
        },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "AbilityEquipped",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          loadout_id: targetLoadoutId,
          slot_index: cmd.slotIndex,
          ability_code: cmd.abilityCode,
          build_version: finalBuildVersion,
        },
      });

      if (targetLoadoutId === activeLoadout.id) {
        await scope.enqueueOutbox({
          aggregateType: "Character",
          aggregateId: character.id,
          eventType: "CharacterBuildChanged",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: character.id,
            build_version: finalBuildVersion,
            operation: "equip_ability",
          },
        });
      }

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "equipAbility",
          characterId: character.id,
          commandId: commandKey,
        });
      }

      const updatedSlots = await scope.listLoadoutAbilitySlots(targetLoadoutId, false);
      return {
        status: "applied",
        duplicate: false,
        data: {
          loadoutId: targetLoadoutId,
          slots: updatedSlots,
          buildVersion: finalBuildVersion,
        },
      };
    });
  }

  public async unequipAbility(
    cmd: UnequipAbilityCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly loadoutId: string;
      readonly slots: ReadonlyArray<EquippedAbilityLoadoutSlot>;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("unequipAbility", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "UnequipAbility",
      character_id: cmd.characterId.toLowerCase(),
      slot_index: cmd.slotIndex,
      target_loadout_id: cmd.targetLoadoutId?.toLowerCase() ?? null,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const invScope = new PgInventoryTransactionScope(scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "AbilityUnequipped",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const { activeLoadout } = await invScope.ensureAndLockPrimaryContainers(character.id, 40);
      const targetLoadoutId = cmd.targetLoadoutId ?? activeLoadout.id;

      const existingSlots = await scope.listLoadoutAbilitySlots(targetLoadoutId, true);
      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            loadoutId: targetLoadoutId,
            slots: existingSlots,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const targetSlot = existingSlots.find((s) => s.slotIndex === cmd.slotIndex);
      if (!targetSlot) {
        throw new AbilityLoadoutInvalidError(
          `Ability slot ${cmd.slotIndex} is already empty on loadout '${targetLoadoutId}'.`,
        );
      }

      const remaining = existingSlots
        .filter((s) => s.slotIndex !== cmd.slotIndex)
        .map((s) => ({
          slotIndex: s.slotIndex,
          abilityCode: s.abilityCode,
          slotGroup: s.slotGroup,
        }));

      await scope.replaceLoadoutAbilitySlots({
        loadoutId: targetLoadoutId,
        characterId: character.id,
        slots: remaining,
        now,
      });

      await scope.client.query(
        "UPDATE equipment_loadouts SET version = version + 1, updated_at = $1 WHERE id = $2::uuid",
        [now, targetLoadoutId],
      );

      let finalBuildVersion = character.buildVersion;
      if (targetLoadoutId === activeLoadout.id) {
        const bumped = await bumpCharacterBuildAndSnapshotVersion({ scope, character, now });
        finalBuildVersion = bumped.nextBuildVersion;
      }

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "ability_unequipped",
        abilityCode: targetSlot.abilityCode,
        sourceEventId: commandKey,
        rulesVersion: 1,
        metadata: { loadout_id: targetLoadoutId, slot_index: cmd.slotIndex },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "AbilityUnequipped",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          loadout_id: targetLoadoutId,
          slot_index: cmd.slotIndex,
          ability_code: targetSlot.abilityCode,
          build_version: finalBuildVersion,
        },
      });

      if (targetLoadoutId === activeLoadout.id) {
        await scope.enqueueOutbox({
          aggregateType: "Character",
          aggregateId: character.id,
          eventType: "CharacterBuildChanged",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: character.id,
            build_version: finalBuildVersion,
            operation: "unequip_ability",
          },
        });
      }

      const updatedSlots = await scope.listLoadoutAbilitySlots(targetLoadoutId, false);
      return {
        status: "applied",
        duplicate: false,
        data: {
          loadoutId: targetLoadoutId,
          slots: updatedSlots,
          buildVersion: finalBuildVersion,
        },
      };
    });
  }

  public async saveLoadoutAbilities(
    cmd: SaveLoadoutAbilitiesCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly loadoutId: string;
      readonly slots: ReadonlyArray<EquippedAbilityLoadoutSlot>;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("saveLoadoutAbilities", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "SaveLoadoutAbilities",
      character_id: cmd.characterId.toLowerCase(),
      loadout_id: cmd.loadoutId.toLowerCase(),
      assignments: cmd.assignments.map((a) => `${a.slotIndex}:${a.abilityCode}`),
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "AbilityLoadoutChanged",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }

      const loRes = await scope.client.query<{ character_id: string; is_active: boolean }>(
        "SELECT character_id, is_active FROM equipment_loadouts WHERE id = $1::uuid FOR UPDATE",
        [cmd.loadoutId],
      );
      const loadoutRow = loRes.rows[0];
      if (!loadoutRow || loadoutRow.character_id !== character.id) {
        throw new AbilityLoadoutInvalidError(
          `Loadout '${cmd.loadoutId}' does not exist or belong to character '${character.id}'.`,
        );
      }

      if (claim.status === "duplicate_verified") {
        const slots = await scope.listLoadoutAbilitySlots(cmd.loadoutId, false);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            loadoutId: cmd.loadoutId,
            slots,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const rules = await scope.loadRules(1);
      const learnedList = await scope.listLearnedAbilities(character.id, true);
      const learnedByCode = new Map<string, CharacterLearnedAbility>(
        learnedList.map((l) => [l.abilityCode, l]),
      );
      const defsByCode = new Map<string, AbilityDefinition>();
      for (const l of learnedList) {
        const d = await scope.findAbilityDefinition(l.abilityCode, l.abilityVersion);
        if (d) {
          defsByCode.set(l.abilityCode, d);
        }
      }

      const summary = validateAbilityLoadoutConfiguration({
        assignments: cmd.assignments,
        learnedByCode,
        definitionsByCode: defsByCode,
        rules,
      });

      await scope.replaceLoadoutAbilitySlots({
        loadoutId: cmd.loadoutId,
        characterId: character.id,
        slots: summary.orderedSlots,
        now,
      });

      await scope.client.query(
        "UPDATE equipment_loadouts SET version = version + 1, updated_at = $1 WHERE id = $2::uuid",
        [now, cmd.loadoutId],
      );

      let finalBuildVersion = character.buildVersion;
      if (loadoutRow.is_active) {
        const bumped = await bumpCharacterBuildAndSnapshotVersion({ scope, character, now });
        finalBuildVersion = bumped.nextBuildVersion;
      }

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "loadout_abilities_saved",
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        metadata: {
          loadout_id: cmd.loadoutId,
          slot_count: summary.orderedSlots.length,
          total_equipment_cost: summary.totalEquipmentCost,
        },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "AbilityLoadoutChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          loadout_id: cmd.loadoutId,
          is_active_loadout: loadoutRow.is_active,
          slot_count: summary.orderedSlots.length,
          build_version: finalBuildVersion,
        },
      });

      if (loadoutRow.is_active) {
        await scope.enqueueOutbox({
          aggregateType: "Character",
          aggregateId: character.id,
          eventType: "CharacterBuildChanged",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            character_id: character.id,
            build_version: finalBuildVersion,
            operation: "save_loadout_abilities",
          },
        });
      }

      const updatedSlots = await scope.listLoadoutAbilitySlots(cmd.loadoutId, false);
      return {
        status: "applied",
        duplicate: false,
        data: {
          loadoutId: cmd.loadoutId,
          slots: updatedSlots,
          buildVersion: finalBuildVersion,
        },
      };
    });
  }

  /**
   * Redistributes specialization investments (`ResetSpecialization` — Section 29):
   * - Preserves ALL historical `character_weapon_masteries` XP/levels/ranks.
   * - Preserves historical `character_learned_abilities` (`learned_at`, `max_rank_ever_reached`)
   *   and `character_specialization_unlocks` (`unlocked_at`) without deleting rows!
   * - Refunds 100% of `spentPoints` -> `unspentPoints = earnedPoints, spentPoints = 0`.
   * - Marks unlocked specialization nodes `is_active = FALSE, points_invested = 0` and
   *   deactivates specialization-funded/dependent abilities (`is_active = FALSE, points_invested = 0`),
   *   causing equipped loadout references to be cleanly suppressed until re-specialized!
   */
  public async resetSpecialization(
    cmd: ResetSpecializationCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly specializationPoints: CharacterSpecializationPoints;
      readonly refundedPoints: number;
      readonly deactivatedNodesCount: number;
      readonly deactivatedAbilitiesCount: number;
      readonly buildVersion: number;
    }>
  > {
    assertNotGenesisContext("resetSpecialization", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ResetSpecialization",
      character_id: cmd.characterId.toLowerCase(),
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "SpecializationReset",
        eventVersion: 1,
        source: "carbon.skills",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      const rules = await scope.loadRules(1);
      const specPts = await scope.ensureAndLockSpecializationPoints(
        character.id,
        character.level,
        rules,
      );
      const unlocks = await scope.listSpecializationUnlocks(character.id, true);
      const learned = await scope.listLearnedAbilities(character.id, true);

      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            specializationPoints: specPts,
            refundedPoints: 0,
            deactivatedNodesCount: 0,
            deactivatedAbilitiesCount: 0,
            buildVersion: character.buildVersion,
          },
        };
      }

      await assertCharacterMutableByPrincipal({
        scope,
        character,
        principal: cmd.principal,
        expectedBuildVersion: cmd.expectedBuildVersion,
      });

      const refundedPoints = specPts.spentPoints;
      const updatedPts: CharacterSpecializationPoints = {
        ...specPts,
        spentPoints: 0,
        unspentPoints: specPts.earnedPoints,
        version: specPts.version + 1,
        updatedAt: now,
      };
      await scope.updateSpecializationPoints(updatedPts, specPts.version);

      const deactNodesRes = await scope.client.query(
        `UPDATE character_specialization_unlocks
         SET is_active = FALSE,
             points_invested = 0,
             updated_at = $1,
             version = version + 1
         WHERE character_id = $2::uuid AND is_active = TRUE`,
        [now, character.id],
      );
      const deactivatedNodesCount = deactNodesRes.rowCount ?? 0;

      // Deactivate any active learned ability that required specialization points or specialization nodes,
      // while preserving `max_rank_ever_reached` and `learned_at`!
      let deactivatedAbilitiesCount = 0;
      for (const ab of learned) {
        if (!ab.isActive) {
          continue;
        }
        const def = await scope.findAbilityDefinition(ab.abilityCode, ab.abilityVersion);
        const dependsOnNodes = (def?.prerequisiteNodes.length ?? 0) > 0;
        if (ab.pointsInvested > 0 || dependsOnNodes) {
          await scope.client.query(
            `UPDATE character_learned_abilities
             SET is_active = FALSE,
                 current_rank = 1,
                 points_invested = 0,
                 updated_at = $1,
                 version = version + 1
             WHERE character_id = $2::uuid AND ability_code = $3`,
            [now, character.id, ab.abilityCode],
          );
          deactivatedAbilitiesCount++;
        }
      }

      const { nextBuildVersion } = await bumpCharacterBuildAndSnapshotVersion({
        scope,
        character,
        now,
      });

      await scope.appendSkillHistory({
        characterId: character.id,
        operationType: "specialization_reset",
        pointsDelta: refundedPoints,
        sourceEventId: commandKey,
        rulesVersion: rules.rulesVersion,
        metadata: {
          refunded_points: refundedPoints,
          deactivated_nodes_count: deactivatedNodesCount,
          deactivated_abilities_count: deactivatedAbilitiesCount,
          preserved_unlock_records: unlocks.length,
          preserved_learned_records: learned.length,
        },
        recordedAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSkillProgression",
        aggregateId: character.id,
        eventType: "SpecializationReset",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          refunded_points: refundedPoints,
          unspent_points: updatedPts.unspentPoints,
          deactivated_nodes_count: deactivatedNodesCount,
          deactivated_abilities_count: deactivatedAbilitiesCount,
          build_version: nextBuildVersion,
        },
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "CharacterBuildChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          build_version: nextBuildVersion,
          operation: "reset_specialization",
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "resetSpecialization",
          characterId: character.id,
          commandId: commandKey,
        });
      }

      return {
        status: "applied",
        duplicate: false,
        data: {
          specializationPoints: updatedPts,
          refundedPoints,
          deactivatedNodesCount,
          deactivatedAbilitiesCount,
          buildVersion: nextBuildVersion,
        },
      };
    });
  }
}
