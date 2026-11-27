import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import {
  PositiveInt64Schema,
  SignedInt64Schema,
} from "../../../shared/contracts/int64-wire.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
} from "../../characters/domain/character.js";
import { AccountNotFoundError, CharacterNotFoundError } from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import {
  evaluateTitleConditionAst,
  type CharacterTitleState,
} from "../../titles/domain/title-contracts.js";
import {
  assertCriminalBountyClaimEligible,
  evaluateIncidentUnderJurisdiction,
  validateCriminalBountyCreation,
  validateCriminalStateTransition,
  type CombatLegalContext,
  type CrimeSeverity,
  type CriminalBounty,
  type CriminalBountyClaim,
  type CriminalBountyFundingStatus,
  type CriminalRecord,
  type CriminalState,
  type CriminalWarrant,
  type OffenseCode,
} from "../domain/criminality-and-bounties.js";
import {
  ContributionRecognitionInvalidError,
  CriminalBountyInvalidError,
  ExternalIdentityConflictError,
  ExternalIdentityUnresolvedError,
  SocialAntiExploitRejectedError,
  SocialAuthorizationForbiddenError,
  SocialNumericOverflowError,
  SocialReferenceNotFoundError,
  SocialValidationError,
  TitleConditionInvalidError,
  TitleExclusivityClaimedError,
  TitleOwnershipOrStateError,
} from "../domain/errors.js";
import {
  applyDiminishingReturnsBigInt,
  checkedAddSignedInt64,
  clampBigInt,
  clampInt32,
  computeSingleHopFactionPropagations,
  evaluateMoralBandWithHysteresis,
  type CharacterScopedReputation,
  type CharacterSocialStandingAggregate,
  type ExternalIdentityLink,
  type ReputationScopeType,
} from "../domain/social-standing.js";
import {
  evaluateContextualWorldRecognition,
  type NpcSocialRole,
  type WorldRecognitionEvaluationResult,
} from "../domain/world-recognition.js";
import {
  PostgresSocialUnitOfWork,
  type HistoricalSocialRecord,
} from "../infrastructure/postgres-social-unit-of-work.js";

function assertSystemAuthority(principal: AuthorityPrincipal, action: string): string {
  if (principal.kind !== "internal_system_authority") {
    throw new SocialAuthorizationForbiddenError(
      `Operation '${action}' requires internal_system_authority; client/account principals cannot self-grant social consequences.`,
    );
  }
  return principal.actorId;
}

function parseSignedBigIntStrict(val: bigint | string | number, label: string): bigint {
  const res = SignedInt64Schema.safeParse(val);
  if (!res.success) {
    throw new SocialNumericOverflowError(
      `Invalid or overflowing ${label}: ${res.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return res.data;
}

function parsePositiveBigIntStrict(val: bigint | string | number, label: string): bigint {
  const res = PositiveInt64Schema.safeParse(val);
  if (!res.success) {
    throw new SocialNumericOverflowError(
      `Invalid or overflowing ${label}: ${res.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return res.data;
}

export interface LinkExternalIdentityCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly sourceNamespace: string;
  readonly externalSubjectId: string;
  readonly characterId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface AdjustMoralBountyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly signedDelta: bigint | string | number;
  readonly actionCode: string;
  readonly regionId?: string | undefined;
  readonly counterpartyCharacterId?: string | undefined;
  readonly enforceAntiAbuseCooldown?: boolean | undefined;
  readonly applyDiminishingReturns?: boolean | undefined;
  readonly occurredAt?: Date | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantFameCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly fameAmount: bigint | string | number;
  readonly sourceCategory:
    | "boss_defeat"
    | "city_defense"
    | "championship"
    | "discovery"
    | "leadership"
    | "exceptional_craft"
    | "historical_event"
    | "notorious_crime";
  readonly sourceReference: string;
  readonly regionId?: string | undefined;
  readonly enforceWindowCap?: boolean | undefined;
  readonly occurredAt?: Date | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface AdjustReputationCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly scopeType: ReputationScopeType;
  readonly scopeId: string;
  readonly delta: number;
  readonly actionCode: string;
  readonly propagateToRelatedFactions?: boolean | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RecordAuthoritativeCrimeCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly offenderCharacterId: string;
  readonly victimCharacterId?: string | undefined;
  readonly victimReference?: string | undefined;
  readonly offenseCode: OffenseCode;
  readonly combatContext?: CombatLegalContext | undefined;
  readonly jurisdictionId: string;
  readonly settlementId?: string | undefined;
  readonly factionId?: string | undefined;
  readonly severity: CrimeSeverity;
  readonly confirmationLevel: "suspected" | "confirmed";
  readonly notorietyFameGrant?: bigint | string | number | undefined;
  readonly reputationPenaltyWithControllingFaction?: number | undefined;
  readonly evidenceReference: string;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface IssueArrestWarrantCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly targetCharacterId: string;
  readonly jurisdictionId: string;
  readonly issuingAuthorityId: string;
  readonly sourceCrimeId: string;
  readonly authorizedExceptions?: ReadonlyArray<string> | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ResolveCriminalStatusCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly jurisdictionId: string;
  readonly targetState: "Captured" | "ServingSentence" | "Pardoned" | "Clear";
  readonly authorityReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface CreateCriminalBountyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly targetCharacterId: string;
  readonly issuingAuthorityId: string;
  readonly jurisdictionId: string;
  readonly warrantId?: string | undefined;
  readonly sourceCrimeId: string;
  readonly rewardAmount: bigint | string | number;
  readonly currencyCode: string;
  readonly fundingStatus: CriminalBountyFundingStatus;
  readonly fundingReference?: string | null | undefined;
  readonly desiredStatus: "Draft" | "Active";
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ClaimCriminalBountyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly bountyId: string;
  readonly claimantCharacterId: string;
  readonly resolutionKind: "confirmed_capture" | "authorized_defeat";
  readonly authorityConfirmationRef: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UnlockTitleCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly titleCode: string;
  readonly exclusivityScopeRef?: string | undefined;
  readonly authoritativeSequence?: bigint | number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RevokeTitleCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly titleCode: string;
  readonly reason: string;
  readonly releaseExclusivityOffice?: boolean | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface EquipTitleCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly titleCode: string | null;
  readonly expectedSocialVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RecordHistoricalAchievementCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly eventReference: string;
  readonly eventType:
    | "SettlementDefended"
    | "SettlementLiberated"
    | "BossFirstDefeated"
    | "CriminalWarrantIssued"
    | "ExclusiveMilestone";
  readonly characterId?: string | undefined;
  readonly settlementId?: string | undefined;
  readonly regionId?: string | undefined;
  readonly factionId?: string | undefined;
  readonly contributionRole: string;
  readonly summary: string;
  readonly visibility?: "public_chronicle" | "regional_lore" | "restricted_archive" | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RecognizeContributionCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly contributionExternalEventId: string;
  readonly sourceNamespace?: string | undefined;
  /** Required when invasion outcome was 'Captured' so CARBON never guesses player moral alignment */
  readonly capturedOutcomeRolePolicy?: "defender_valiant_stand" | "hostile_assault_participant" | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SocialEngineDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;
}

export class SocialEngineService {
  private readonly pool: PgPool;
  private readonly unitOfWork: PostgresSocialUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: SocialEngineDependencies) {
    this.pool = deps.pool;
    this.unitOfWork = new PostgresSocialUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async linkExternalIdentity(
    cmd: LinkExternalIdentityCommand,
  ): Promise<IdempotentCommandOutcome<ExternalIdentityLink>> {
    assertNotGenesisContext("linkExternalIdentity", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "linkExternalIdentity");
    const commandKey = cmd.commandId.trim();
    const ns = cmd.sourceNamespace.trim();
    const subj = cmd.externalSubjectId.trim();
    if (!ns || !subj) {
      throw new SocialValidationError("sourceNamespace and externalSubjectId cannot be blank.");
    }

    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const linkId = deriveDeterministicEventUuid(`ext-link:${ns}:${subj}:${cmd.characterId}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "LinkExternalIdentity",
      source_namespace: ns,
      external_subject_id: subj,
      character_id: cmd.characterId.toLowerCase(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ExternalIdentityLinked",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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

      if (claim.status === "duplicate_verified") {
        const existing = await scope.client.query(
          "SELECT * FROM external_identity_links WHERE id = $1::uuid",
          [linkId],
        );
        const r = existing.rows[0] as Record<string, unknown>;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: String(r["id"]),
            sourceNamespace: String(r["source_namespace"]),
            externalSubjectId: String(r["external_subject_id"]),
            characterId: String(r["character_id"]),
            linkStatus: r["link_status"] as "active" | "revoked",
            linkedByActor: String(r["linked_by_actor"]),
            revocationReason: (r["revocation_reason"] as string | null) ?? null,
            version: Number(r["version"]),
            createdAt: r["created_at"] as Date,
            updatedAt: r["updated_at"] as Date,
          },
        };
      }

      try {
        await scope.client.query(
          `INSERT INTO external_identity_links (
             id, source_namespace, external_subject_id, character_id,
             link_status, linked_by_actor, version, created_at, updated_at
           )
           VALUES ($1::uuid, $2, $3, $4::uuid, 'active', $5, 1, $6, $6)`,
          [linkId, ns, subj, character.id, actorId, now],
        );
      } catch (err) {
        if (err instanceof pg.DatabaseError && err.code === "23505") {
          throw new ExternalIdentityConflictError(
            `External identity (${ns}, '${subj}') is already actively linked; revoke the existing link before remapping.`,
          );
        }
        throw err;
      }

      await scope.client.query(
        `INSERT INTO external_identity_link_history (
           id, link_id, source_namespace, external_subject_id,
           character_id, action, actor_id, cause_event_id, recorded_at
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'linked', $6, $7, $8)`,
        [randomUUID(), linkId, ns, subj, character.id, actorId, commandKey, now],
      );

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: linkId,
          sourceNamespace: ns,
          externalSubjectId: subj,
          characterId: character.id,
          linkStatus: "active",
          linkedByActor: actorId,
          revocationReason: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    });
  }

  public async adjustMoralBounty(
    cmd: AdjustMoralBountyCommand,
  ): Promise<IdempotentCommandOutcome<CharacterSocialStandingAggregate>> {
    assertNotGenesisContext("adjustMoralBounty", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "adjustMoralBounty");
    const rawDelta = parseSignedBigIntStrict(cmd.signedDelta, "signedDelta");
    if (rawDelta === 0n) {
      throw new SocialValidationError("adjustMoralBounty signedDelta cannot be 0.");
    }

    const commandKey = cmd.commandId.trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = cmd.occurredAt ?? new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "AdjustMoralBounty",
      character_id: cmd.characterId.toLowerCase(),
      signed_delta: rawDelta.toString(),
      action_code: cmd.actionCode.trim(),
      region_id: cmd.regionId ?? null,
      counterparty_character_id: cmd.counterpartyCharacterId?.toLowerCase() ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "MoralStandingAdjusted",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const orderedIds = cmd.counterpartyCharacterId
        ? [cmd.characterId, cmd.counterpartyCharacterId].sort()
        : [cmd.characterId];
      for (const cid of orderedIds) {
        const locked = await charScope.lockCharacterById(cid);
        if (!locked) {
          throw new CharacterNotFoundError(cid);
        }
      }
      const actorChar = (await charScope.findCharacterById(cmd.characterId))!;
      let counterpartyAccountId: string | null = null;
      if (cmd.counterpartyCharacterId) {
        const cpChar = (await charScope.findCharacterById(cmd.counterpartyCharacterId))!;
        counterpartyAccountId = cpChar.accountId;
        if (
          actorChar.id === cpChar.id ||
          actorChar.accountId.toLowerCase() === cpChar.accountId.toLowerCase()
        ) {
          throw new SocialAntiExploitRejectedError(
            "SAME_ACCOUNT_FARMING_BLOCKED",
            "Moral bounty cannot be farmed between characters belonging to the same AccountID.",
          );
        }
      }

      const currentSocial = await scope.ensureAndLockSocialStanding(actorChar.id);
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: currentSocial };
      }

      const rules = await scope.loadSocialRules(rulesVersion);
      const scopeKey = cmd.counterpartyCharacterId
        ? `${cmd.actionCode.trim()}:cp:${cmd.counterpartyCharacterId.toLowerCase()}`
        : `${cmd.actionCode.trim()}:region:${cmd.regionId ?? "global"}`;

      const windowCheck = await scope.countWindowEventsAndLatestCooldown({
        characterId: actorChar.id,
        domainKind: "moral_bounty",
        scopeKey,
        windowSeconds: rules.antiAbuseWindowSeconds,
        now,
      });

      if (
        cmd.enforceAntiAbuseCooldown === true &&
        windowCheck.latestOccurredAt !== null &&
        now.getTime() - windowCheck.latestOccurredAt.getTime() <
          rules.antiAbuseCooldownSeconds * 1000
      ) {
        throw new SocialAntiExploitRejectedError(
          "COOLDOWN_ACTIVE",
          `Action '${scopeKey}' is within the ${rules.antiAbuseCooldownSeconds}s anti-abuse cooldown.`,
        );
      }

      if (
        cmd.enforceAntiAbuseCooldown === true &&
        windowCheck.countInWindow >= rules.antiAbuseMaxEventsPerWindow
      ) {
        throw new SocialAntiExploitRejectedError(
          "WINDOW_LIMIT_EXCEEDED",
          `Action '${scopeKey}' exceeded maximum ${rules.antiAbuseMaxEventsPerWindow} occurrences in window.`,
        );
      }

      const effectiveDelta =
        cmd.applyDiminishingReturns === true
          ? applyDiminishingReturnsBigInt({
              rawDelta,
              priorOccurrencesInWindow: windowCheck.countInWindow,
              stepBp: rules.diminishingReturnsStepBp,
            })
          : rawDelta;

      // Overflow-checked int64 addition BEFORE clamping to domain rule bounds
      const uncheckedSum = checkedAddSignedInt64(
        currentSocial.moralBounty,
        effectiveDelta,
        "moralBounty",
      );
      const nextMoralBounty = clampBigInt(
        uncheckedSum,
        rules.moralBountyMin,
        rules.moralBountyMax,
      );
      const nextBand = evaluateMoralBandWithHysteresis({
        nextMoralBounty,
        previousBand: currentSocial.moralBand,
        severeCrimeCount: currentSocial.severeCrimeCount,
        rules,
      });

      let updatedSocial: CharacterSocialStandingAggregate = {
        ...currentSocial,
        moralBounty: nextMoralBounty,
        moralBand: nextBand,
        rulesVersion: rules.rulesVersion,
        socialVersion: currentSocial.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedSocial, currentSocial.socialVersion);

      if (cmd.regionId) {
        const reg = await scope.ensureAndLockRegionalStanding(actorChar.id, cmd.regionId);
        const regSum = checkedAddSignedInt64(
          reg.regionalMoralBounty,
          effectiveDelta,
          "regionalMoralBounty",
        );
        await scope.updateRegionalStanding(
          {
            ...reg,
            regionalMoralBounty: clampBigInt(regSum, rules.moralBountyMin, rules.moralBountyMax),
            version: reg.version + 1,
            updatedAt: now,
          },
          reg.version,
        );
      }

      await scope.appendSocialLedger({
        characterId: actorChar.id,
        counterpartyAccountId,
        counterpartyCharacterId: cmd.counterpartyCharacterId ?? null,
        domainKind: "moral_bounty",
        actionCode: cmd.actionCode.trim(),
        scopeKey,
        previousValue: currentSocial.moralBounty,
        deltaValue: effectiveDelta,
        newValue: nextMoralBounty,
        rulesVersion: rules.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          previous_band: currentSocial.moralBand,
          new_band: nextBand,
          region_id: cmd.regionId ?? null,
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: actorChar.id,
        eventType: "MoralStandingAdjusted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: actorChar.id,
          previous_moral_bounty: currentSocial.moralBounty.toString(),
          new_moral_bounty: nextMoralBounty.toString(),
          moral_band: nextBand,
          action_code: cmd.actionCode.trim(),
        },
      });

      updatedSocial = await scope.reconcileConditionalTitles({
        social: updatedSocial,
        causeEventId: commandKey,
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        now,
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "adjustMoralBounty", commandId: commandKey });
      }

      return { status: "applied", duplicate: false, data: updatedSocial };
    });
  }

  public async grantFame(
    cmd: GrantFameCommand,
  ): Promise<IdempotentCommandOutcome<CharacterSocialStandingAggregate>> {
    assertNotGenesisContext("grantFame", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "grantFame");
    const fameAmount = parsePositiveBigIntStrict(cmd.fameAmount, "fameAmount");

    const commandKey = cmd.commandId.trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = cmd.occurredAt ?? new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantFame",
      character_id: cmd.characterId.toLowerCase(),
      fame_amount: fameAmount.toString(),
      source_category: cmd.sourceCategory,
      source_reference: cmd.sourceReference.trim(),
      region_id: cmd.regionId ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "FameGranted",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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

      const currentSocial = await scope.ensureAndLockSocialStanding(character.id);
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: currentSocial };
      }

      const rules = await scope.loadSocialRules(rulesVersion);
      const scopeKey = `${cmd.sourceCategory}:${cmd.sourceReference.trim()}`;

      if (cmd.enforceWindowCap === true) {
        const wc = await scope.countWindowEventsAndLatestCooldown({
          characterId: character.id,
          domainKind: "fame",
          scopeKey,
          windowSeconds: rules.antiAbuseWindowSeconds,
          now,
        });
        if (wc.countInWindow >= rules.antiAbuseMaxEventsPerWindow) {
          throw new SocialAntiExploitRejectedError(
            "FAME_WINDOW_CAP_EXCEEDED",
            `Fame source '${scopeKey}' exceeded window cap of ${rules.antiAbuseMaxEventsPerWindow}.`,
          );
        }
      }

      const rawSum = checkedAddSignedInt64(currentSocial.globalFame, fameAmount, "globalFame");
      const nextGlobalFame = clampBigInt(rawSum, 0n, rules.fameMax);

      let updatedSocial: CharacterSocialStandingAggregate = {
        ...currentSocial,
        globalFame: nextGlobalFame,
        rulesVersion: rules.rulesVersion,
        socialVersion: currentSocial.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedSocial, currentSocial.socialVersion);

      if (cmd.regionId) {
        const reg = await scope.ensureAndLockRegionalStanding(character.id, cmd.regionId);
        const regFameSum = checkedAddSignedInt64(reg.regionalFame, fameAmount, "regionalFame");
        await scope.updateRegionalStanding(
          {
            ...reg,
            regionalFame: clampBigInt(regFameSum, 0n, rules.fameMax),
            version: reg.version + 1,
            updatedAt: now,
          },
          reg.version,
        );
      }

      await scope.appendSocialLedger({
        characterId: character.id,
        domainKind: "fame",
        actionCode: cmd.sourceCategory,
        scopeKey,
        previousValue: currentSocial.globalFame,
        deltaValue: fameAmount,
        newValue: nextGlobalFame,
        rulesVersion: rules.rulesVersion,
        sourceEventId: commandKey,
        metadata: { region_id: cmd.regionId ?? null },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "FameGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          fame_granted: fameAmount.toString(),
          new_global_fame: nextGlobalFame.toString(),
          source_category: cmd.sourceCategory,
          region_id: cmd.regionId ?? null,
        },
      });

      updatedSocial = await scope.reconcileConditionalTitles({
        social: updatedSocial,
        causeEventId: commandKey,
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        now,
      });

      return { status: "applied", duplicate: false, data: updatedSocial };
    });
  }

  public async adjustReputation(
    cmd: AdjustReputationCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly primary: CharacterScopedReputation;
      readonly propagated: ReadonlyArray<CharacterScopedReputation>;
    }>
  > {
    assertNotGenesisContext("adjustReputation", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "adjustReputation");
    if (!Number.isInteger(cmd.delta) || !Number.isSafeInteger(cmd.delta) || cmd.delta === 0) {
      throw new SocialValidationError("Reputation delta must be a non-zero safe integer.");
    }

    const commandKey = cmd.commandId.trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "AdjustReputation",
      character_id: cmd.characterId.toLowerCase(),
      scope_type: cmd.scopeType,
      scope_id: cmd.scopeId,
      delta: cmd.delta,
      action_code: cmd.actionCode.trim(),
      propagate: cmd.propagateToRelatedFactions ?? true,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ReputationAdjusted",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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
      const currentSocial = await scope.ensureAndLockSocialStanding(character.id);
      const rules = await scope.loadSocialRules(rulesVersion);

      const primaryCur = await scope.lockOrInitializeScopedReputation({
        characterId: character.id,
        scopeType: cmd.scopeType,
        scopeId: cmd.scopeId,
        rulesVersion: rules.rulesVersion,
      });

      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { primary: primaryCur, propagated: [] },
        };
      }

      const nextPrimaryValue = clampInt32(
        primaryCur.standingValue + cmd.delta,
        rules.reputationMin,
        rules.reputationMax,
      );
      const updatedPrimary: CharacterScopedReputation = {
        ...primaryCur,
        standingValue: nextPrimaryValue,
        rulesVersion: rules.rulesVersion,
        version: primaryCur.version + 1,
        updatedAt: now,
      };
      await scope.updateScopedReputation(updatedPrimary, primaryCur.version);

      await scope.appendSocialLedger({
        characterId: character.id,
        domainKind: "reputation",
        actionCode: cmd.actionCode.trim(),
        scopeKey: `${cmd.scopeType}:${cmd.scopeId}`,
        previousValue: BigInt(primaryCur.standingValue),
        deltaValue: BigInt(cmd.delta),
        newValue: BigInt(nextPrimaryValue),
        rulesVersion: rules.rulesVersion,
        sourceEventId: commandKey,
        occurredAt: now,
      });

      // Single-hop (depth=1) non-recursive faction propagation when enabled
      const propagatedList: CharacterScopedReputation[] = [];
      if (cmd.scopeType === "faction" && cmd.propagateToRelatedFactions !== false) {
        const directRelations = await scope.listDirectFactionRelations(cmd.scopeId);
        const propagations = computeSingleHopFactionPropagations({
          sourceFactionId: cmd.scopeId,
          directDelta: cmd.delta,
          directRelations,
        });

        for (const prop of propagations) {
          const neighborCur = await scope.lockOrInitializeScopedReputation({
            characterId: character.id,
            scopeType: "faction",
            scopeId: prop.targetFactionId,
            rulesVersion: rules.rulesVersion,
          });
          const nextNeighborVal = clampInt32(
            neighborCur.standingValue + prop.propagatedDelta,
            rules.reputationMin,
            rules.reputationMax,
          );
          const updatedNeighbor: CharacterScopedReputation = {
            ...neighborCur,
            standingValue: nextNeighborVal,
            rulesVersion: rules.rulesVersion,
            version: neighborCur.version + 1,
            updatedAt: now,
          };
          await scope.updateScopedReputation(updatedNeighbor, neighborCur.version);
          propagatedList.push(updatedNeighbor);

          await scope.appendSocialLedger({
            characterId: character.id,
            domainKind: "reputation",
            actionCode: `propagated:${prop.relationState}:${cmd.actionCode.trim()}`,
            scopeKey: `faction:${prop.targetFactionId}`,
            previousValue: BigInt(neighborCur.standingValue),
            deltaValue: BigInt(prop.propagatedDelta),
            newValue: BigInt(nextNeighborVal),
            rulesVersion: rules.rulesVersion,
            sourceEventId: commandKey,
            metadata: { source_faction_id: cmd.scopeId, depth: 1 },
            occurredAt: now,
          });
        }
      }

      const bumpedSocial: CharacterSocialStandingAggregate = {
        ...currentSocial,
        socialVersion: currentSocial.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(bumpedSocial, currentSocial.socialVersion);

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "ReputationAdjusted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          scope_type: cmd.scopeType,
          scope_id: cmd.scopeId,
          new_standing: nextPrimaryValue,
          propagated_count: propagatedList.length,
        },
      });

      await scope.reconcileConditionalTitles({
        social: bumpedSocial,
        causeEventId: commandKey,
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        now,
      });

      return {
        status: "applied",
        duplicate: false,
        data: { primary: updatedPrimary, propagated: propagatedList },
      };
    });
  }

  public async recordAuthoritativeCrime(
    cmd: RecordAuthoritativeCrimeCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly constitutedCrime: boolean;
      readonly exemptionReason: string | null;
      readonly crimeRecord: CriminalRecord | null;
      readonly autoWarrant: CriminalWarrant | null;
      readonly socialStanding: CharacterSocialStandingAggregate;
    }>
  > {
    assertNotGenesisContext("recordAuthoritativeCrime", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "recordAuthoritativeCrime");
    const commandKey = cmd.commandId.trim();
    const combatContext = cmd.combatContext ?? "unlawful_aggression";
    const notorietyFame =
      cmd.notorietyFameGrant !== undefined
        ? parsePositiveBigIntStrict(cmd.notorietyFameGrant, "notorietyFameGrant")
        : 0n;
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const detCrimeId = deriveDeterministicEventUuid(`crime:${commandKey}`);
    const detWarrantId = deriveDeterministicEventUuid(`auto-warrant:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RecordAuthoritativeCrime",
      offender_character_id: cmd.offenderCharacterId.toLowerCase(),
      offense_code: cmd.offenseCode,
      combat_context: combatContext,
      jurisdiction_id: cmd.jurisdictionId,
      severity: cmd.severity,
      confirmation_level: cmd.confirmationLevel,
      evidence_reference: cmd.evidenceReference.trim(),
      notoriety_fame_grant: notorietyFame.toString(),
      reputation_penalty: cmd.reputationPenaltyWithControllingFaction ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CrimeRecorded",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.offenderCharacterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const offender = await charScope.lockCharacterById(cmd.offenderCharacterId);
      if (!offender) {
        throw new CharacterNotFoundError(cmd.offenderCharacterId);
      }

      const currentSocial = await scope.ensureAndLockSocialStanding(offender.id);
      if (claim.status === "duplicate_verified") {
        const crRes = await scope.client.query<Record<string, unknown>>(
          "SELECT * FROM criminal_records WHERE id = $1::uuid",
          [detCrimeId],
        );
        const crRow = crRes.rows[0];
        if (!crRow) {
          const jur = await scope.findJurisdiction(cmd.jurisdictionId);
          const jurStat = await scope.ensureAndLockJurisdictionStatus(
            offender.id,
            jur.jurisdictionId,
          );
          const evalDup = evaluateIncidentUnderJurisdiction({
            offenseCode: cmd.offenseCode,
            combatContext,
            confirmationLevel: cmd.confirmationLevel,
            severity: cmd.severity,
            currentState: jurStat.criminalState,
            jurisdiction: jur,
          });
          return {
            status: "duplicate_idempotent",
            duplicate: true,
            data: {
              constitutedCrime: false,
              exemptionReason: evalDup.exemptionReason,
              crimeRecord: null,
              autoWarrant: null,
              socialStanding: currentSocial,
            },
          };
        }

        const existingCrime: CriminalRecord = {
          id: String(crRow["id"]),
          offenderCharacterId: String(crRow["offender_character_id"]),
          victimCharacterId: (crRow["victim_character_id"] as string | null) ?? null,
          victimReference: (crRow["victim_reference"] as string | null) ?? null,
          offenseCode: crRow["offense_code"] as OffenseCode,
          combatContext: crRow["combat_context"] as CombatLegalContext,
          jurisdictionId: String(crRow["jurisdiction_id"]),
          settlementId: (crRow["settlement_id"] as string | null) ?? null,
          factionId: (crRow["faction_id"] as string | null) ?? null,
          regionId: String(crRow["region_id"]),
          severity: crRow["severity"] as CrimeSeverity,
          legalStatus: crRow["legal_status"] as CriminalRecord["legalStatus"],
          moralDeltaApplied: BigInt(String(crRow["moral_delta_applied"])),
          notorietyFameGranted: BigInt(String(crRow["notoriety_fame_granted"])),
          sourceEventId: String(crRow["source_event_id"]),
          evidenceReference: String(crRow["evidence_reference"]),
          rulesVersion: Number(crRow["rules_version"]),
          recordedAt: crRow["recorded_at"] as Date,
          updatedAt: crRow["updated_at"] as Date,
        };

        const awRes = await scope.client.query<Record<string, unknown>>(
          "SELECT * FROM criminal_warrants WHERE id = $1::uuid",
          [detWarrantId],
        );
        const awRow = awRes.rows[0];
        const existingAutoWarrant: CriminalWarrant | null = awRow
          ? {
              id: String(awRow["id"]),
              targetCharacterId: String(awRow["target_character_id"]),
              issuingAuthorityId: String(awRow["issuing_authority_id"]),
              jurisdictionId: String(awRow["jurisdiction_id"]),
              sourceCrimeId: String(awRow["source_crime_id"]),
              status: awRow["status"] as CriminalWarrant["status"],
              authorizedExceptions: awRow["authorized_exceptions"] as ReadonlyArray<string>,
              version: Number(awRow["version"]),
              issuedAt: awRow["issued_at"] as Date,
              resolvedAt: (awRow["resolved_at"] as Date | null) ?? null,
              resolutionReference: (awRow["resolution_reference"] as string | null) ?? null,
            }
          : null;

        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            constitutedCrime: true,
            exemptionReason: null,
            crimeRecord: existingCrime,
            autoWarrant: existingAutoWarrant,
            socialStanding: currentSocial,
          },
        };
      }

      const rules = await scope.loadSocialRules(rulesVersion);
      const jurisdiction = await scope.findJurisdiction(cmd.jurisdictionId);
      const jurStatus = await scope.ensureAndLockJurisdictionStatus(
        offender.id,
        jurisdiction.jurisdictionId,
      );

      const evaluation = evaluateIncidentUnderJurisdiction({
        offenseCode: cmd.offenseCode,
        combatContext,
        confirmationLevel: cmd.confirmationLevel,
        severity: cmd.severity,
        currentState: jurStatus.criminalState,
        jurisdiction,
      });

      let updatedSocial = currentSocial;

      // Case 1: Exempt combat (consensual duel / arena / recognized war / self-defense) or lawless zone!
      if (!evaluation.constitutesCrime) {
        if (evaluation.moralDelta !== 0n) {
          const nextMoral = clampBigInt(
            checkedAddSignedInt64(updatedSocial.moralBounty, evaluation.moralDelta, "moralBounty"),
            rules.moralBountyMin,
            rules.moralBountyMax,
          );
          const nextSevere = evaluation.isSevereMoralOffense
            ? updatedSocial.severeCrimeCount + 1
            : updatedSocial.severeCrimeCount;
          const nextBand = evaluateMoralBandWithHysteresis({
            nextMoralBounty: nextMoral,
            previousBand: updatedSocial.moralBand,
            severeCrimeCount: nextSevere,
            rules,
          });
          updatedSocial = {
            ...updatedSocial,
            moralBounty: nextMoral,
            moralBand: nextBand,
            severeCrimeCount: nextSevere,
            socialVersion: updatedSocial.socialVersion + 1,
            updatedAt: now,
          };
          await scope.updateSocialStanding(updatedSocial, currentSocial.socialVersion);
        }

        return {
          status: "applied",
          duplicate: false,
          data: {
            constitutedCrime: false,
            exemptionReason: evaluation.exemptionReason,
            crimeRecord: null,
            autoWarrant: null,
            socialStanding: updatedSocial,
          },
        };
      }

      // Case 2: Constitutes statutory offense in jurisdiction
      const resolvedSettlementId = cmd.settlementId ?? jurisdiction.settlementId;
      const resolvedFactionId = cmd.factionId ?? jurisdiction.controllingFactionId;
      if (resolvedSettlementId) {
        await scope.assertSettlementExists(resolvedSettlementId);
      }
      if (resolvedFactionId) {
        await scope.assertFactionExists(resolvedFactionId);
      }

      const crimeRecord: CriminalRecord = {
        id: detCrimeId,
        offenderCharacterId: offender.id,
        victimCharacterId: cmd.victimCharacterId ?? null,
        victimReference: cmd.victimReference ?? null,
        offenseCode: cmd.offenseCode,
        combatContext,
        jurisdictionId: jurisdiction.jurisdictionId,
        settlementId: resolvedSettlementId,
        factionId: resolvedFactionId,
        regionId: jurisdiction.regionId,
        severity: cmd.severity,
        legalStatus: cmd.confirmationLevel,
        moralDeltaApplied: evaluation.moralDelta,
        notorietyFameGranted: cmd.confirmationLevel === "confirmed" ? notorietyFame : 0n,
        sourceEventId: commandKey,
        evidenceReference: cmd.evidenceReference.trim(),
        rulesVersion: rules.rulesVersion,
        recordedAt: now,
        updatedAt: now,
      };

      await scope.client.query(
        `INSERT INTO criminal_records (
           id, offender_character_id, victim_character_id, victim_reference,
           offense_code, combat_context, jurisdiction_id, settlement_id, faction_id,
           region_id, severity, legal_status, moral_delta_applied, notoriety_fame_granted,
           source_event_id, evidence_reference, rules_version, recorded_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4,
           $5, $6, $7, $8::uuid, $9::uuid,
           $10, $11, $12, $13::bigint, $14::bigint,
           $15, $16, $17, $18, $18
         )`,
        [
          crimeRecord.id,
          crimeRecord.offenderCharacterId,
          crimeRecord.victimCharacterId,
          crimeRecord.victimReference,
          crimeRecord.offenseCode,
          crimeRecord.combatContext,
          crimeRecord.jurisdictionId,
          crimeRecord.settlementId,
          crimeRecord.factionId,
          crimeRecord.regionId,
          crimeRecord.severity,
          crimeRecord.legalStatus,
          crimeRecord.moralDeltaApplied.toString(),
          crimeRecord.notorietyFameGranted.toString(),
          crimeRecord.sourceEventId,
          crimeRecord.evidenceReference,
          crimeRecord.rulesVersion,
          now,
        ],
      );

      let autoWarrant: CriminalWarrant | null = null;
      let nextWarrantCount = jurStatus.activeWarrantsCount;
      if (evaluation.shouldAutoIssueWarrant) {
        autoWarrant = {
          id: detWarrantId,
          targetCharacterId: offender.id,
          issuingAuthorityId: resolvedFactionId ?? jurisdiction.jurisdictionId,
          jurisdictionId: jurisdiction.jurisdictionId,
          sourceCrimeId: crimeRecord.id,
          status: "active",
          authorizedExceptions: [],
          version: 1,
          issuedAt: now,
          resolvedAt: null,
          resolutionReference: null,
        };
        await scope.client.query(
          `INSERT INTO criminal_warrants (
             id, target_character_id, issuing_authority_id, jurisdiction_id,
             source_crime_id, status, authorized_exceptions, version, issued_at
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'active', '[]'::jsonb, 1, $6)`,
          [
            autoWarrant.id,
            autoWarrant.targetCharacterId,
            autoWarrant.issuingAuthorityId,
            autoWarrant.jurisdictionId,
            autoWarrant.sourceCrimeId,
            now,
          ],
        );
        nextWarrantCount++;

        await scope.enqueueOutbox({
          aggregateType: "CharacterSocialStanding",
          aggregateId: offender.id,
          eventType: "WarrantIssued",
          correlationUuid: eventUuid,
          causationEventUuid: claim.eventUuid,
          occurredAt: now,
          payload: {
            warrant_id: autoWarrant.id,
            target_character_id: offender.id,
            jurisdiction_id: jurisdiction.jurisdictionId,
            source_crime_id: crimeRecord.id,
          },
        });
      }

      await scope.updateJurisdictionStatus(
        {
          ...jurStatus,
          criminalState: evaluation.nextCriminalState,
          safeZoneAccess: evaluation.nextSafeZoneAccess,
          activeWarrantsCount: nextWarrantCount,
          version: jurStatus.version + 1,
          updatedAt: now,
        },
        jurStatus.version,
      );

      // Update MoralBounty, criminal notoriety Fame, and validated crime counters when confirmed
      const nextMoral = clampBigInt(
        checkedAddSignedInt64(updatedSocial.moralBounty, evaluation.moralDelta, "moralBounty"),
        rules.moralBountyMin,
        rules.moralBountyMax,
      );
      const nextFame = clampBigInt(
        checkedAddSignedInt64(
          updatedSocial.globalFame,
          crimeRecord.notorietyFameGranted,
          "globalFame",
        ),
        0n,
        rules.fameMax,
      );
      const nextValidatedCrimes =
        cmd.confirmationLevel === "confirmed"
          ? updatedSocial.validatedCrimesCount + 1
          : updatedSocial.validatedCrimesCount;
      const nextSevereCount = evaluation.isSevereMoralOffense
        ? updatedSocial.severeCrimeCount + 1
        : updatedSocial.severeCrimeCount;
      const nextBand = evaluateMoralBandWithHysteresis({
        nextMoralBounty: nextMoral,
        previousBand: updatedSocial.moralBand,
        severeCrimeCount: nextSevereCount,
        rules,
      });

      const prevSocialVer = updatedSocial.socialVersion;
      updatedSocial = {
        ...updatedSocial,
        moralBounty: nextMoral,
        moralBand: nextBand,
        severeCrimeCount: nextSevereCount,
        globalFame: nextFame,
        validatedCrimesCount: nextValidatedCrimes,
        rulesVersion: rules.rulesVersion,
        socialVersion: prevSocialVer + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedSocial, prevSocialVer);

      const regStanding = await scope.ensureAndLockRegionalStanding(
        offender.id,
        jurisdiction.regionId,
      );
      await scope.updateRegionalStanding(
        {
          ...regStanding,
          regionalMoralBounty: clampBigInt(
            regStanding.regionalMoralBounty + evaluation.moralDelta,
            rules.moralBountyMin,
            rules.moralBountyMax,
          ),
          regionalFame: clampBigInt(
            regStanding.regionalFame + crimeRecord.notorietyFameGranted,
            0n,
            rules.fameMax,
          ),
          version: regStanding.version + 1,
          updatedAt: now,
        },
        regStanding.version,
      );

      if (
        cmd.confirmationLevel === "confirmed" &&
        resolvedFactionId &&
        cmd.reputationPenaltyWithControllingFaction !== undefined &&
        cmd.reputationPenaltyWithControllingFaction < 0
      ) {
        const facRep = await scope.lockOrInitializeScopedReputation({
          characterId: offender.id,
          scopeType: "faction",
          scopeId: resolvedFactionId,
          rulesVersion: rules.rulesVersion,
        });
        await scope.updateScopedReputation(
          {
            ...facRep,
            standingValue: clampInt32(
              facRep.standingValue + cmd.reputationPenaltyWithControllingFaction,
              rules.reputationMin,
              rules.reputationMax,
            ),
            version: facRep.version + 1,
            updatedAt: now,
          },
          facRep.version,
        );
      }

      await scope.appendSocialLedger({
        characterId: offender.id,
        domainKind: "crime",
        actionCode: cmd.offenseCode,
        scopeKey: `jurisdiction:${jurisdiction.jurisdictionId}`,
        previousValue: currentSocial.moralBounty,
        deltaValue: evaluation.moralDelta,
        newValue: nextMoral,
        rulesVersion: rules.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          crime_id: crimeRecord.id,
          legal_status: crimeRecord.legalStatus,
          notoriety_fame: crimeRecord.notorietyFameGranted.toString(),
          criminal_state: evaluation.nextCriminalState,
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: offender.id,
        eventType: "CrimeRecorded",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          crime_id: crimeRecord.id,
          offender_character_id: offender.id,
          offense_code: crimeRecord.offenseCode,
          jurisdiction_id: crimeRecord.jurisdictionId,
          legal_status: crimeRecord.legalStatus,
        },
      });

      updatedSocial = await scope.reconcileConditionalTitles({
        social: updatedSocial,
        causeEventId: commandKey,
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        now,
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          constitutedCrime: true,
          exemptionReason: null,
          crimeRecord,
          autoWarrant,
          socialStanding: updatedSocial,
        },
      };
    });
  }

  public async issueArrestWarrant(
    cmd: IssueArrestWarrantCommand,
  ): Promise<IdempotentCommandOutcome<CriminalWarrant>> {
    assertNotGenesisContext("issueArrestWarrant", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "issueArrestWarrant");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const warrantId = deriveDeterministicEventUuid(`warrant:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "IssueArrestWarrant",
      target_character_id: cmd.targetCharacterId.toLowerCase(),
      jurisdiction_id: cmd.jurisdictionId,
      source_crime_id: cmd.sourceCrimeId.toLowerCase(),
      issuing_authority_id: cmd.issuingAuthorityId.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "WarrantIssued",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.targetCharacterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const target = await charScope.lockCharacterById(cmd.targetCharacterId);
      if (!target) {
        throw new CharacterNotFoundError(cmd.targetCharacterId);
      }
      const social = await scope.ensureAndLockSocialStanding(target.id);
      const jurStatus = await scope.ensureAndLockJurisdictionStatus(target.id, cmd.jurisdictionId);

      if (claim.status === "duplicate_verified") {
        const ex = await scope.client.query(
          "SELECT * FROM criminal_warrants WHERE id = $1::uuid",
          [warrantId],
        );
        const r = ex.rows[0] as Record<string, unknown>;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: String(r["id"]),
            targetCharacterId: String(r["target_character_id"]),
            issuingAuthorityId: String(r["issuing_authority_id"]),
            jurisdictionId: String(r["jurisdiction_id"]),
            sourceCrimeId: String(r["source_crime_id"]),
            status: r["status"] as CriminalWarrant["status"],
            authorizedExceptions: r["authorized_exceptions"] as ReadonlyArray<string>,
            version: Number(r["version"]),
            issuedAt: r["issued_at"] as Date,
            resolvedAt: (r["resolved_at"] as Date | null) ?? null,
            resolutionReference: (r["resolution_reference"] as string | null) ?? null,
          },
        };
      }

      const crimeRes = await scope.client.query<{
        offender_character_id: string;
        legal_status: string;
        jurisdiction_id: string;
      }>(
        "SELECT offender_character_id, legal_status, jurisdiction_id FROM criminal_records WHERE id = $1::uuid",
        [cmd.sourceCrimeId],
      );
      const crime = crimeRes.rows[0];
      if (!crime || crime.offender_character_id !== target.id) {
        throw new SocialReferenceNotFoundError("CriminalRecord", cmd.sourceCrimeId);
      }
      if (crime.legal_status !== "confirmed") {
        throw new CriminalBountyInvalidError(
          "Arrest warrant requires a confirmed criminal record; suspected status cannot issue arrest warrant.",
        );
      }

      const warrant: CriminalWarrant = {
        id: warrantId,
        targetCharacterId: target.id,
        issuingAuthorityId: cmd.issuingAuthorityId.trim(),
        jurisdictionId: cmd.jurisdictionId,
        sourceCrimeId: cmd.sourceCrimeId,
        status: "active",
        authorizedExceptions: cmd.authorizedExceptions ?? [],
        version: 1,
        issuedAt: now,
        resolvedAt: null,
        resolutionReference: null,
      };

      await scope.client.query(
        `INSERT INTO criminal_warrants (
           id, target_character_id, issuing_authority_id, jurisdiction_id,
           source_crime_id, status, authorized_exceptions, version, issued_at
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'active', $6::jsonb, 1, $7)`,
        [
          warrant.id,
          warrant.targetCharacterId,
          warrant.issuingAuthorityId,
          warrant.jurisdictionId,
          warrant.sourceCrimeId,
          JSON.stringify(warrant.authorizedExceptions),
          now,
        ],
      );

      const nextState: CriminalState =
        jurStatus.criminalState === "Wanted" || jurStatus.criminalState === "Fugitive"
          ? "Fugitive"
          : "Wanted";
      await scope.updateJurisdictionStatus(
        {
          ...jurStatus,
          criminalState: nextState,
          safeZoneAccess: "restricted_arrest_on_sight",
          activeWarrantsCount: jurStatus.activeWarrantsCount + 1,
          version: jurStatus.version + 1,
          updatedAt: now,
        },
        jurStatus.version,
      );

      await scope.updateSocialStanding(
        { ...social, socialVersion: social.socialVersion + 1, updatedAt: now },
        social.socialVersion,
      );

      await scope.appendSocialLedger({
        characterId: target.id,
        domainKind: "warrant",
        actionCode: "warrant_issued",
        scopeKey: `jurisdiction:${cmd.jurisdictionId}`,
        rulesVersion: social.rulesVersion,
        sourceEventId: commandKey,
        metadata: { warrant_id: warrant.id, crime_id: cmd.sourceCrimeId },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: target.id,
        eventType: "WarrantIssued",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          warrant_id: warrant.id,
          target_character_id: target.id,
          jurisdiction_id: cmd.jurisdictionId,
        },
      });

      return { status: "applied", duplicate: false, data: warrant };
    });
  }

  /**
   * Transitions jurisdictional criminal state (`Captured`, `ServingSentence`, `Pardoned`, `Clear`).
   * IMPORTANT: `Pardoned` resolves active warrants and restores safe-zone access WITHOUT deleting
   * original rows in `criminal_records` (marking them `'pardoned'` so history remains intact).
   */
  public async resolveCriminalStatus(
    cmd: ResolveCriminalStatusCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly criminalState: CriminalState }>> {
    assertNotGenesisContext("resolveCriminalStatus", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "resolveCriminalStatus");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ResolveCriminalStatus",
      character_id: cmd.characterId.toLowerCase(),
      jurisdiction_id: cmd.jurisdictionId,
      target_state: cmd.targetState,
      authority_reference: cmd.authorityReference.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "WarrantResolved",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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
      const social = await scope.ensureAndLockSocialStanding(character.id);
      const jurStatus = await scope.ensureAndLockJurisdictionStatus(
        character.id,
        cmd.jurisdictionId,
      );

      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { criminalState: jurStatus.criminalState },
        };
      }

      const nextSafeZone = validateCriminalStateTransition(
        jurStatus.criminalState,
        cmd.targetState,
      );

      let nextWarrantCount = jurStatus.activeWarrantsCount;
      if (cmd.targetState === "Captured" || cmd.targetState === "Pardoned") {
        const newWarrantStatus = cmd.targetState === "Pardoned" ? "pardoned" : "captured";
        await scope.client.query(
          `UPDATE criminal_warrants
           SET status = $1, resolved_at = $2, resolution_reference = $3, version = version + 1
           WHERE target_character_id = $4::uuid AND jurisdiction_id = $5 AND status = 'active'`,
          [newWarrantStatus, now, cmd.authorityReference.trim(), character.id, cmd.jurisdictionId],
        );
        nextWarrantCount = 0;
      }

      if (cmd.targetState === "Pardoned") {
        // Mark records as pardoned while preserving every single historical row in criminal_records!
        await scope.client.query(
          `UPDATE criminal_records
           SET legal_status = 'pardoned', updated_at = $1
           WHERE offender_character_id = $2::uuid
             AND jurisdiction_id = $3
             AND legal_status IN ('confirmed', 'suspected')`,
          [now, character.id, cmd.jurisdictionId],
        );
      }

      await scope.updateJurisdictionStatus(
        {
          ...jurStatus,
          criminalState: cmd.targetState,
          safeZoneAccess: nextSafeZone,
          activeWarrantsCount: nextWarrantCount,
          version: jurStatus.version + 1,
          updatedAt: now,
        },
        jurStatus.version,
      );

      await scope.updateSocialStanding(
        { ...social, socialVersion: social.socialVersion + 1, updatedAt: now },
        social.socialVersion,
      );

      await scope.appendSocialLedger({
        characterId: character.id,
        domainKind: "warrant",
        actionCode: `status_${cmd.targetState.toLowerCase()}`,
        scopeKey: `jurisdiction:${cmd.jurisdictionId}`,
        rulesVersion: social.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          previous_state: jurStatus.criminalState,
          new_state: cmd.targetState,
          authority_reference: cmd.authorityReference.trim(),
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "WarrantResolved",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          jurisdiction_id: cmd.jurisdictionId,
          resulting_state: cmd.targetState,
        },
      });

      return { status: "applied", duplicate: false, data: { criminalState: cmd.targetState } };
    });
  }

  public async createCriminalBounty(
    cmd: CreateCriminalBountyCommand,
  ): Promise<IdempotentCommandOutcome<CriminalBounty>> {
    assertNotGenesisContext("createCriminalBounty", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "createCriminalBounty");
    const rewardAmount = parsePositiveBigIntStrict(cmd.rewardAmount, "rewardAmount");
    const commandKey = cmd.commandId.trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const bountyId = deriveDeterministicEventUuid(`criminal-bounty:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "CreateCriminalBounty",
      target_character_id: cmd.targetCharacterId.toLowerCase(),
      jurisdiction_id: cmd.jurisdictionId,
      source_crime_id: cmd.sourceCrimeId.toLowerCase(),
      reward_amount: rewardAmount.toString(),
      currency_code: cmd.currencyCode.trim(),
      funding_status: cmd.fundingStatus,
      funding_reference: cmd.fundingReference ?? null,
      desired_status: cmd.desiredStatus,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CriminalBountyCreated",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: bountyId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const target = await charScope.lockCharacterById(cmd.targetCharacterId);
      if (!target) {
        throw new CharacterNotFoundError(cmd.targetCharacterId);
      }

      if (claim.status === "duplicate_verified") {
        const ex = await scope.lockCriminalBounty(bountyId);
        return { status: "duplicate_idempotent", duplicate: true, data: ex! };
      }

      await scope.findJurisdiction(cmd.jurisdictionId);
      const crimeRes = await scope.client.query<{
        offender_character_id: string;
        legal_status: "suspected" | "confirmed" | "pardoned" | "sentence_served";
      }>(
        "SELECT offender_character_id, legal_status FROM criminal_records WHERE id = $1::uuid",
        [cmd.sourceCrimeId],
      );
      const crime = crimeRes.rows[0];
      if (!crime || crime.offender_character_id !== target.id) {
        throw new SocialReferenceNotFoundError("CriminalRecord", cmd.sourceCrimeId);
      }

      validateCriminalBountyCreation({
        rewardAmount,
        fundingStatus: cmd.fundingStatus,
        fundingReference: cmd.fundingReference ?? null,
        desiredStatus: cmd.desiredStatus,
        crimeLegalStatus: crime.legal_status,
      });

      const bounty: CriminalBounty = {
        id: bountyId,
        targetCharacterId: target.id,
        issuingAuthorityId: cmd.issuingAuthorityId.trim(),
        jurisdictionId: cmd.jurisdictionId,
        warrantId: cmd.warrantId ?? null,
        sourceCrimeId: cmd.sourceCrimeId,
        rewardAmount,
        currencyCode: cmd.currencyCode.trim(),
        fundingStatus: cmd.fundingStatus,
        fundingReference: cmd.fundingReference ? cmd.fundingReference.trim() : null,
        status: cmd.desiredStatus,
        rulesVersion,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      await scope.client.query(
        `INSERT INTO criminal_bounties (
           id, target_character_id, issuing_authority_id, jurisdiction_id,
           warrant_id, source_crime_id, reward_amount, currency_code,
           funding_status, funding_reference, status, rules_version, version,
           created_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4,
           $5::uuid, $6::uuid, $7::bigint, $8,
           $9, $10, $11, $12, 1, $13, $13
         )`,
        [
          bounty.id,
          bounty.targetCharacterId,
          bounty.issuingAuthorityId,
          bounty.jurisdictionId,
          bounty.warrantId,
          bounty.sourceCrimeId,
          bounty.rewardAmount.toString(),
          bounty.currencyCode,
          bounty.fundingStatus,
          bounty.fundingReference,
          bounty.status,
          bounty.rulesVersion,
          now,
        ],
      );

      await scope.appendSocialLedger({
        characterId: target.id,
        domainKind: "criminal_bounty",
        actionCode: `bounty_${bounty.status.toLowerCase()}`,
        scopeKey: `bounty:${bounty.id}`,
        deltaValue: bounty.rewardAmount,
        newValue: bounty.rewardAmount,
        rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          funding_status: bounty.fundingStatus,
          currency_code: bounty.currencyCode,
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CriminalBounty",
        aggregateId: bounty.id,
        eventType: "CriminalBountyCreated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          bounty_id: bounty.id,
          target_character_id: bounty.targetCharacterId,
          jurisdiction_id: bounty.jurisdictionId,
          reward_amount: bounty.rewardAmount.toString(),
          currency_code: bounty.currencyCode,
          funding_status: bounty.fundingStatus,
          status: bounty.status,
        },
      });

      return { status: "applied", duplicate: false, data: bounty };
    });
  }

  public async claimCriminalBounty(
    cmd: ClaimCriminalBountyCommand,
  ): Promise<IdempotentCommandOutcome<CriminalBountyClaim>> {
    assertNotGenesisContext("claimCriminalBounty", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "claimCriminalBounty");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const claimId = deriveDeterministicEventUuid(`bounty-claim:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ClaimCriminalBounty",
      bounty_id: cmd.bountyId.toLowerCase(),
      claimant_character_id: cmd.claimantCharacterId.toLowerCase(),
      resolution_kind: cmd.resolutionKind,
      authority_confirmation_ref: cmd.authorityConfirmationRef.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const inboxClaim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CriminalBountyClaimed",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.bountyId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      // Lock bounty row FIRST so concurrent hunters serialize cleanly on the bounty row!
      const bounty = await scope.lockCriminalBounty(cmd.bountyId);
      if (!bounty) {
        throw new SocialReferenceNotFoundError("CriminalBounty", cmd.bountyId);
      }

      if (inboxClaim.status === "duplicate_verified") {
        const ex = await scope.client.query(
          "SELECT * FROM criminal_bounty_claims WHERE id = $1::uuid",
          [claimId],
        );
        const r = ex.rows[0] as Record<string, unknown>;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: String(r["id"]),
            bountyId: String(r["bounty_id"]),
            claimantCharacterId: String(r["claimant_character_id"]),
            claimantAccountId: String(r["claimant_account_id"]),
            targetCharacterId: String(r["target_character_id"]),
            targetAccountId: String(r["target_account_id"]),
            resolutionKind: r["resolution_kind"] as CriminalBountyClaim["resolutionKind"],
            authorityEventId: String(r["authority_event_id"]),
            payoutCommitmentStatus: "pending_economy_settlement",
            claimedAt: r["claimed_at"] as Date,
          },
        };
      }

      // Lock both claimant and target characters in canonical ascending UUID order
      const orderedChars = Array.from(
        new Set([cmd.claimantCharacterId, bounty.targetCharacterId]),
      ).sort();
      for (const cid of orderedChars) {
        const c = await charScope.lockCharacterById(cid);
        if (!c) {
          throw new CharacterNotFoundError(cid);
        }
      }
      const claimant = (await charScope.findCharacterById(cmd.claimantCharacterId))!;
      const target = (await charScope.findCharacterById(bounty.targetCharacterId))!;
      const targetJur = await scope.ensureAndLockJurisdictionStatus(
        target.id,
        bounty.jurisdictionId,
      );

      assertCriminalBountyClaimEligible({
        bounty,
        claimantCharacterId: claimant.id,
        claimantAccountId: claimant.accountId,
        targetCharacterId: target.id,
        targetAccountId: target.accountId,
        targetJurisdictionState: targetJur.criminalState,
      });

      const updRes = await scope.client.query(
        `UPDATE criminal_bounties
         SET status = 'Fulfilled', version = $1, updated_at = $2
         WHERE id = $3::uuid AND version = $4`,
        [bounty.version + 1, now, bounty.id, bounty.version],
      );
      if (updRes.rowCount !== 1) {
        throw new CriminalBountyInvalidError(
          `Criminal bounty '${bounty.id}' was modified concurrently.`,
        );
      }

      const bountyClaim: CriminalBountyClaim = {
        id: claimId,
        bountyId: bounty.id,
        claimantCharacterId: claimant.id,
        claimantAccountId: claimant.accountId,
        targetCharacterId: target.id,
        targetAccountId: target.accountId,
        resolutionKind: cmd.resolutionKind,
        authorityEventId: cmd.authorityConfirmationRef.trim(),
        payoutCommitmentStatus: "pending_economy_settlement",
        claimedAt: now,
      };

      await scope.client.query(
        `INSERT INTO criminal_bounty_claims (
           id, bounty_id, claimant_character_id, claimant_account_id,
           target_character_id, target_account_id, resolution_kind,
           authority_event_id, payout_commitment_status, claimed_at
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'pending_economy_settlement', $9)`,
        [
          bountyClaim.id,
          bountyClaim.bountyId,
          bountyClaim.claimantCharacterId,
          bountyClaim.claimantAccountId,
          bountyClaim.targetCharacterId,
          bountyClaim.targetAccountId,
          bountyClaim.resolutionKind,
          bountyClaim.authorityEventId,
          now,
        ],
      );

      // Increment hunter's bountiesFulfilledCount
      const hunterSocial = await scope.ensureAndLockSocialStanding(claimant.id);
      const updatedHunterSocial: CharacterSocialStandingAggregate = {
        ...hunterSocial,
        bountiesFulfilledCount: hunterSocial.bountiesFulfilledCount + 1,
        socialVersion: hunterSocial.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedHunterSocial, hunterSocial.socialVersion);

      if (cmd.resolutionKind === "confirmed_capture" && targetJur.criminalState !== "Captured") {
        await scope.updateJurisdictionStatus(
          {
            ...targetJur,
            criminalState: "Captured",
            safeZoneAccess: "monitored",
            activeWarrantsCount: 0,
            version: targetJur.version + 1,
            updatedAt: now,
          },
          targetJur.version,
        );
        await scope.client.query(
          `UPDATE criminal_warrants
           SET status = 'captured', resolved_at = $1, resolution_reference = $2, version = version + 1
           WHERE target_character_id = $3::uuid AND jurisdiction_id = $4 AND status = 'active'`,
          [now, cmd.authorityConfirmationRef.trim(), target.id, bounty.jurisdictionId],
        );
      }

      await scope.appendSocialLedger({
        characterId: claimant.id,
        counterpartyAccountId: target.accountId,
        counterpartyCharacterId: target.id,
        domainKind: "criminal_bounty",
        actionCode: "bounty_claimed_pending_settlement",
        scopeKey: `bounty:${bounty.id}`,
        deltaValue: bounty.rewardAmount,
        newValue: bounty.rewardAmount,
        rulesVersion: bounty.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          payout_commitment_status: "pending_economy_settlement",
          currency_code: bounty.currencyCode,
          funding_reference: bounty.fundingReference,
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CriminalBounty",
        aggregateId: bounty.id,
        eventType: "CriminalBountyClaimed",
        correlationUuid: eventUuid,
        causationEventUuid: inboxClaim.eventUuid,
        occurredAt: now,
        payload: {
          bounty_id: bounty.id,
          claim_id: bountyClaim.id,
          claimant_character_id: claimant.id,
          target_character_id: target.id,
          reward_amount: bounty.rewardAmount.toString(),
          currency_code: bounty.currencyCode,
          payout_commitment_status: "pending_economy_settlement",
        },
      });

      return { status: "applied", duplicate: false, data: bountyClaim };
    });
  }

  public async evaluateAndUnlockTitle(
    cmd: UnlockTitleCommand,
  ): Promise<IdempotentCommandOutcome<CharacterTitleState>> {
    assertNotGenesisContext("evaluateAndUnlockTitle", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "evaluateAndUnlockTitle");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "EvaluateAndUnlockTitle",
      character_id: cmd.characterId.toLowerCase(),
      title_code: cmd.titleCode,
      exclusivity_scope_ref: cmd.exclusivityScopeRef ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TitleUnlocked",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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
      const social = await scope.ensureAndLockSocialStanding(character.id);

      const def = await scope.findTitleDefinition(cmd.titleCode);
      if (!def) {
        throw new SocialReferenceNotFoundError("TitleDefinition", cmd.titleCode);
      }
      if (!def.isEnabled) {
        throw new TitleConditionInvalidError(
          `Title '${def.titleCode}' is disabled/planned and cannot be unlocked yet.`,
        );
      }

      const existingRes = await scope.client.query(
        "SELECT * FROM character_titles WHERE character_id = $1::uuid AND title_code = $2 FOR UPDATE",
        [character.id, def.titleCode],
      );
      if (existingRes.rows[0]) {
        const r = existingRes.rows[0] as Record<string, unknown>;
        if (claim.status === "duplicate_verified" || r["state"] === "active") {
          return {
            status: "duplicate_idempotent",
            duplicate: true,
            data: {
              id: String(r["id"]),
              characterId: String(r["character_id"]),
              titleCode: String(r["title_code"]),
              state: r["state"] as CharacterTitleState["state"],
              exclusivityKey: (r["exclusivity_key"] as string | null) ?? null,
              originEventId: String(r["origin_event_id"]),
              unlockedAt: r["unlocked_at"] as Date,
              updatedAt: r["updated_at"] as Date,
              version: Number(r["version"]),
            },
          };
        }
      }

      const evalSnap = await scope.buildTitleEvaluationSnapshot(character.id, social);
      const eligible = evaluateTitleConditionAst(def.requirements, evalSnap);
      if (!eligible) {
        throw new TitleConditionInvalidError(
          `Character '${character.id}' does not satisfy declarative requirements for title '${def.titleCode}'.`,
        );
      }

      let exclusivityKey: string | null = null;
      if (def.exclusivityScope !== "none") {
        const scopeRef =
          def.exclusivityScope === "global"
            ? "global"
            : (cmd.exclusivityScopeRef?.trim() ?? "");
        if (!scopeRef) {
          throw new TitleConditionInvalidError(
            `Exclusive title '${def.titleCode}' (${def.exclusivityScope}) requires exclusivityScopeRef.`,
          );
        }
        exclusivityKey = `${def.exclusivityScope}:${scopeRef}:${def.titleCode}`;
        const authSeq = BigInt(cmd.authoritativeSequence ?? 1);

        try {
          await scope.client.query(
            `INSERT INTO title_exclusivity_claims (
               exclusivity_key, title_code, exclusivity_scope, scope_ref,
               holder_character_id, authoritative_sequence, origin_event_id, claimed_at
             )
             VALUES ($1, $2, $3, $4, $5::uuid, $6::bigint, $7, $8)`,
            [
              exclusivityKey,
              def.titleCode,
              def.exclusivityScope,
              scopeRef,
              character.id,
              authSeq.toString(),
              commandKey,
              now,
            ],
          );
        } catch (err) {
          if (err instanceof pg.DatabaseError && err.code === "23505") {
            throw new TitleExclusivityClaimedError(exclusivityKey);
          }
          throw err;
        }
      }

      const unlockId = deriveDeterministicEventUuid(`char-title:${character.id}:${def.titleCode}`);
      await scope.client.query(
        `INSERT INTO character_titles (
           id, character_id, title_code, state, exclusivity_key,
           origin_event_id, unlocked_at, updated_at, version
         )
         VALUES ($1::uuid, $2::uuid, $3, 'active', $4, $5, $6, $6, 1)
         ON CONFLICT (character_id, title_code) DO UPDATE
           SET state = 'active', exclusivity_key = EXCLUDED.exclusivity_key, version = character_titles.version + 1, updated_at = $6`,
        [unlockId, character.id, def.titleCode, exclusivityKey, commandKey, now],
      );

      await scope.client.query(
        `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
         VALUES ($1::uuid, $2::uuid, $3, 'unlocked', $4, $5::uuid, $6)`,
        [randomUUID(), character.id, def.titleCode, commandKey, eventUuid, now],
      );

      await scope.updateSocialStanding(
        { ...social, socialVersion: social.socialVersion + 1, updatedAt: now },
        social.socialVersion,
      );

      await scope.appendSocialLedger({
        characterId: character.id,
        domainKind: "title",
        actionCode: "title_unlocked",
        scopeKey: `title:${def.titleCode}`,
        rulesVersion: def.rulesVersion,
        sourceEventId: commandKey,
        metadata: { exclusivity_key: exclusivityKey },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "TitleUnlocked",
        correlationUuid: eventUuid,
        causationEventUuid:
          claim.status === "claimed" ? claim.eventUuid : claim.existingEventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          title_code: def.titleCode,
          exclusivity_key: exclusivityKey,
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: unlockId,
          characterId: character.id,
          titleCode: def.titleCode,
          state: "active",
          exclusivityKey,
          originEventId: commandKey,
          unlockedAt: now,
          updatedAt: now,
          version: 1,
        },
      };
    });
  }

  public async revokeTitle(
    cmd: RevokeTitleCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly revoked: boolean }>> {
    assertNotGenesisContext("revokeTitle", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "revokeTitle");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RevokeTitle",
      character_id: cmd.characterId.toLowerCase(),
      title_code: cmd.titleCode,
      reason: cmd.reason.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TitleRevoked",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
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
      const social = await scope.ensureAndLockSocialStanding(character.id);
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: { revoked: true } };
      }

      const def = await scope.findTitleDefinition(cmd.titleCode);
      if (!def) {
        throw new SocialReferenceNotFoundError("TitleDefinition", cmd.titleCode);
      }
      if (!def.revocable) {
        throw new TitleOwnershipOrStateError(
          `Permanent non-revocable title '${def.titleCode}' cannot be revoked.`,
        );
      }

      const ctRes = await scope.client.query<{
        id: string;
        exclusivity_key: string | null;
      }>(
        "SELECT id, exclusivity_key FROM character_titles WHERE character_id = $1::uuid AND title_code = $2 FOR UPDATE",
        [character.id, def.titleCode],
      );
      const ct = ctRes.rows[0];
      if (!ct) {
        throw new TitleOwnershipOrStateError(
          `Character '${character.id}' does not hold title '${def.titleCode}'.`,
        );
      }

      await scope.client.query(
        "UPDATE character_titles SET state = 'revoked', version = version + 1, updated_at = $1 WHERE id = $2::uuid",
        [now, ct.id],
      );
      await scope.client.query(
        `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
         VALUES ($1::uuid, $2::uuid, $3, 'revoked', $4, $5::uuid, $6)`,
        [randomUUID(), character.id, def.titleCode, commandKey, eventUuid, now],
      );

      if (ct.exclusivity_key && cmd.releaseExclusivityOffice === true) {
        await scope.client.query(
          "DELETE FROM title_exclusivity_claims WHERE exclusivity_key = $1 AND holder_character_id = $2::uuid",
          [ct.exclusivity_key, character.id],
        );
      }

      const shouldUnequip = social.equippedTitleCode === def.titleCode;
      await scope.updateSocialStanding(
        {
          ...social,
          equippedTitleCode: shouldUnequip ? null : social.equippedTitleCode,
          socialVersion: social.socialVersion + 1,
          updatedAt: now,
        },
        social.socialVersion,
      );

      if (shouldUnequip) {
        await scope.client.query(
          `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
           VALUES ($1::uuid, $2::uuid, $3, 'unequipped', $4, $5::uuid, $6)`,
          [randomUUID(), character.id, def.titleCode, commandKey, eventUuid, now],
        );
      }

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "TitleRevoked",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          title_code: def.titleCode,
          reason: cmd.reason.trim(),
        },
      });

      return { status: "applied", duplicate: false, data: { revoked: true } };
    });
  }

  public async equipTitle(
    cmd: EquipTitleCommand,
  ): Promise<IdempotentCommandOutcome<CharacterSocialStandingAggregate>> {
    assertNotGenesisContext("equipTitle", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "EquipTitle",
      character_id: cmd.characterId.toLowerCase(),
      title_code: cmd.titleCode,
      expected_social_version: cmd.expectedSocialVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      character.assertOwnedByOrSystem(cmd.principal);
      character.assertActiveStatus();
      const account = await charScope.lockAccountById(character.accountId);
      if (!account) {
        throw new AccountNotFoundError(character.accountId);
      }
      assertAccountActive(account);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "TitleEquipped",
        eventVersion: 1,
        source: "carbon.social",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const social = await scope.ensureAndLockSocialStanding(character.id);
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: social };
      }

      if (social.socialVersion !== cmd.expectedSocialVersion) {
        throw new TitleOwnershipOrStateError(
          `Expected socialVersion ${cmd.expectedSocialVersion}, actual ${social.socialVersion}.`,
        );
      }

      if (cmd.titleCode !== null) {
        const ctRes = await scope.client.query<{ state: string }>(
          "SELECT state FROM character_titles WHERE character_id = $1::uuid AND title_code = $2 FOR UPDATE",
          [character.id, cmd.titleCode],
        );
        const ct = ctRes.rows[0];
        if (!ct) {
          throw new TitleOwnershipOrStateError(
            `Character '${character.id}' has not unlocked title '${cmd.titleCode}'.`,
          );
        }
        if (ct.state !== "active") {
          throw new TitleOwnershipOrStateError(
            `Title '${cmd.titleCode}' is currently '${ct.state}' and cannot be equipped.`,
          );
        }
      }

      const prevEquipped = social.equippedTitleCode;
      const updatedSocial: CharacterSocialStandingAggregate = {
        ...social,
        equippedTitleCode: cmd.titleCode,
        socialVersion: social.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedSocial, social.socialVersion);

      if (prevEquipped && prevEquipped !== cmd.titleCode) {
        await scope.client.query(
          `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
           VALUES ($1::uuid, $2::uuid, $3, 'unequipped', $4, $5::uuid, $6)`,
          [randomUUID(), character.id, prevEquipped, commandKey, eventUuid, now],
        );
      }
      if (cmd.titleCode) {
        await scope.client.query(
          `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
           VALUES ($1::uuid, $2::uuid, $3, 'equipped', $4, $5::uuid, $6)`,
          [randomUUID(), character.id, cmd.titleCode, commandKey, eventUuid, now],
        );
      }

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: character.id,
        eventType: "TitleEquipped",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          equipped_title_code: cmd.titleCode,
          social_version: updatedSocial.socialVersion,
        },
      });

      return { status: "applied", duplicate: false, data: updatedSocial };
    });
  }

  public async recordHistoricalAchievement(
    cmd: RecordHistoricalAchievementCommand,
  ): Promise<IdempotentCommandOutcome<HistoricalSocialRecord>> {
    assertNotGenesisContext("recordHistoricalAchievement", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "recordHistoricalAchievement");
    const commandKey = cmd.commandId.trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const visibility = cmd.visibility ?? "public_chronicle";
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const recId = deriveDeterministicEventUuid(`hist-rec:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RecordHistoricalAchievement",
      event_reference: cmd.eventReference.trim(),
      event_type: cmd.eventType,
      character_id: cmd.characterId?.toLowerCase() ?? null,
      settlement_id: cmd.settlementId?.toLowerCase() ?? null,
      contribution_role: cmd.contributionRole.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "HistoricalRecordCreated",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId ?? recId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (cmd.characterId) {
        const c = await charScope.lockCharacterById(cmd.characterId);
        if (!c) {
          throw new CharacterNotFoundError(cmd.characterId);
        }
      }
      if (cmd.settlementId) {
        await scope.assertSettlementExists(cmd.settlementId);
      }
      if (cmd.regionId) {
        await scope.assertRegionExists(cmd.regionId);
      }
      if (cmd.factionId) {
        await scope.assertFactionExists(cmd.factionId);
      }

      if (claim.status === "duplicate_verified") {
        const ex = await scope.client.query(
          "SELECT * FROM historical_social_records WHERE id = $1::uuid",
          [recId],
        );
        const r = ex.rows[0] as Record<string, unknown>;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: String(r["id"]),
            eventReference: String(r["event_reference"]),
            eventType: String(r["event_type"]),
            characterId: (r["character_id"] as string | null) ?? null,
            settlementId: (r["settlement_id"] as string | null) ?? null,
            regionId: (r["region_id"] as string | null) ?? null,
            factionId: (r["faction_id"] as string | null) ?? null,
            contributionRole: String(r["contribution_role"]),
            visibility: r["visibility"] as HistoricalSocialRecord["visibility"],
            summary: String(r["summary"]),
            rulesVersion: Number(r["rules_version"]),
            recordedAt: r["recorded_at"] as Date,
          },
        };
      }

      const record: HistoricalSocialRecord = {
        id: recId,
        eventReference: cmd.eventReference.trim(),
        eventType: cmd.eventType,
        characterId: cmd.characterId ?? null,
        settlementId: cmd.settlementId ?? null,
        regionId: cmd.regionId ?? null,
        factionId: cmd.factionId ?? null,
        contributionRole: cmd.contributionRole.trim(),
        visibility,
        summary: cmd.summary.trim(),
        rulesVersion,
        recordedAt: now,
      };

      await scope.client.query(
        `INSERT INTO historical_social_records (
           id, event_reference, event_type, character_id, settlement_id,
           region_id, faction_id, contribution_role, visibility, summary,
           rules_version, recorded_at
         )
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9, $10, $11, $12)`,
        [
          record.id,
          record.eventReference,
          record.eventType,
          record.characterId,
          record.settlementId,
          record.regionId,
          record.factionId,
          record.contributionRole,
          record.visibility,
          record.summary,
          record.rulesVersion,
          now,
        ],
      );

      if (cmd.characterId) {
        const social = await scope.ensureAndLockSocialStanding(cmd.characterId);
        const nextDefenses =
          cmd.eventType === "SettlementDefended"
            ? social.settlementDefensesCount + 1
            : social.settlementDefensesCount;
        const nextLiberations =
          cmd.eventType === "SettlementLiberated"
            ? social.settlementLiberationsCount + 1
            : social.settlementLiberationsCount;

        await scope.updateSocialStanding(
          {
            ...social,
            settlementDefensesCount: nextDefenses,
            settlementLiberationsCount: nextLiberations,
            socialVersion: social.socialVersion + 1,
            updatedAt: now,
          },
          social.socialVersion,
        );
      }

      await scope.enqueueOutbox({
        aggregateType: "WorldHistory",
        aggregateId: record.id,
        eventType: "HistoricalRecordCreated",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          historical_record_id: record.id,
          event_type: record.eventType,
          character_id: record.characterId,
          settlement_id: record.settlementId,
          contribution_role: record.contributionRole,
        },
      });

      return { status: "applied", duplicate: false, data: record };
    });
  }

  /**
   * Section 31 — Authoritative Recognition of Session 02 `gameplay_contributions`:
   * - Requires `eligible === true`.
   * - Resolves opaque `player_id` -> `CharacterID` via explicit `external_identity_links` (NEVER guesses by name!).
   * - Never assumes `outcome === 'Captured'` is criminal unless an explicit `capturedOutcomeRolePolicy` is passed.
   * - Never assumes highest `damage` equals event leader (`support` & `objectives` are first-class).
   * - Guarantees idempotent single-recognition via `contribution_recognitions(contribution_id)`.
   */
  public async recognizeEligibleContribution(
    cmd: RecognizeContributionCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly characterId: string;
      readonly moralBountyGranted: bigint;
      readonly fameGranted: bigint;
      readonly settlementReputationGranted: number;
      readonly unlockedTitleCodes: ReadonlyArray<string>;
    }>
  > {
    assertNotGenesisContext("recognizeEligibleContribution", cmd.executionProfile);
    const actorId = assertSystemAuthority(cmd.principal, "recognizeEligibleContribution");
    const commandKey = cmd.commandId.trim();
    const ns = (cmd.sourceNamespace ?? "neon.simulation").trim();
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RecognizeEligibleContribution",
      contribution_external_event_id: cmd.contributionExternalEventId.trim(),
      source_namespace: ns,
      captured_role_policy: cmd.capturedOutcomeRolePolicy ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "HeroicAchievementRecorded",
        eventVersion: 1,
        source: `carbon.social:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: eventUuid,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const contribRes = await scope.client.query<{
        id: string;
        external_event_id: string;
        settlement_ref: string;
        resolved_settlement_id: string | null;
        player_id: string;
        damage: string;
        support: string;
        objectives: string;
        eligible: boolean;
        outcome: "Defended" | "Captured";
      }>(
        "SELECT * FROM gameplay_contributions WHERE external_event_id = $1 FOR UPDATE",
        [cmd.contributionExternalEventId.trim()],
      );
      const contrib = contribRes.rows[0];
      if (!contrib) {
        throw new SocialReferenceNotFoundError(
          "GameplayContribution",
          cmd.contributionExternalEventId,
        );
      }

      if (!contrib.eligible) {
        throw new ContributionRecognitionInvalidError(
          `Contribution '${contrib.external_event_id}' has eligible=false and cannot receive social recognition.`,
        );
      }

      if (contrib.outcome === "Captured" && !cmd.capturedOutcomeRolePolicy) {
        throw new ContributionRecognitionInvalidError(
          `Contribution '${contrib.external_event_id}' ended with outcome='Captured'; explicit capturedOutcomeRolePolicy is required so CARBON does not falsely assume criminal participation.`,
        );
      }

      const linkRes = await scope.client.query<{ character_id: string }>(
        `SELECT character_id FROM external_identity_links
         WHERE source_namespace = $1 AND external_subject_id = $2 AND link_status = 'active'`,
        [ns, contrib.player_id],
      );
      const characterId = linkRes.rows[0]?.character_id;
      if (!characterId) {
        throw new ExternalIdentityUnresolvedError(ns, contrib.player_id);
      }

      const existingRec = await scope.client.query<{
        character_id: string;
        moral_bounty_granted: string;
        fame_granted: string;
        settlement_reputation_granted: number;
      }>(
        "SELECT * FROM contribution_recognitions WHERE contribution_id = $1::uuid",
        [contrib.id],
      );
      if (existingRec.rows[0]) {
        if (claim.status === "duplicate_verified") {
          const er = existingRec.rows[0];
          return {
            status: "duplicate_idempotent",
            duplicate: true,
            data: {
              characterId: er.character_id,
              moralBountyGranted: BigInt(er.moral_bounty_granted),
              fameGranted: BigInt(er.fame_granted),
              settlementReputationGranted: er.settlement_reputation_granted,
              unlockedTitleCodes: [],
            },
          };
        }
        throw new ContributionRecognitionInvalidError(
          `Contribution '${contrib.external_event_id}' has already been recognized.`,
        );
      }

      await charScope.lockCharacterById(characterId);
      const social = await scope.ensureAndLockSocialStanding(characterId);
      const rules = await scope.loadSocialRules(rulesVersion);

      // Resolve settlement by resolved_settlement_id or external_id
      let settlementId = contrib.resolved_settlement_id;
      let regionId: string | null = null;
      let settlementExternalId = contrib.settlement_ref;
      if (settlementId) {
        const stInfo = await scope.assertSettlementExists(settlementId);
        regionId = stInfo.regionId;
        settlementExternalId = stInfo.externalId;
      } else {
        const byExt = await scope.client.query<{
          id: string;
          external_id: string;
          region_id: string;
        }>("SELECT id, external_id, region_id FROM settlements WHERE external_id = $1", [
          contrib.settlement_ref,
        ]);
        if (byExt.rows[0]) {
          settlementId = byExt.rows[0].id;
          settlementExternalId = byExt.rows[0].external_id;
          regionId = byExt.rows[0].region_id;
        }
      }

      const isHeroicDefense =
        contrib.outcome === "Defended" ||
        cmd.capturedOutcomeRolePolicy === "defender_valiant_stand";

      // Balanced role recognition considering damage, support, and objectives equally without crowning "damage leader"
      const hasObjectivesOrSupport =
        BigInt(contrib.objectives) > 0n || BigInt(contrib.support) > 0n;
      const moralDelta = isHeroicDefense ? (hasObjectivesOrSupport ? 180n : 140n) : -220n;
      const fameGrant = isHeroicDefense ? 220n : 180n;
      const settlementRepDelta = isHeroicDefense ? 250 : -300;
      const roleTag = isHeroicDefense
        ? BigInt(contrib.objectives) > 0n
          ? "tactical_objective_defender"
          : BigInt(contrib.support) > BigInt(contrib.damage)
            ? "support_vanguard_defender"
            : "settlement_defender"
        : "hostile_siege_participant";

      const nextMoral = clampBigInt(
        checkedAddSignedInt64(social.moralBounty, moralDelta, "moralBounty"),
        rules.moralBountyMin,
        rules.moralBountyMax,
      );
      const nextFame = clampBigInt(
        checkedAddSignedInt64(social.globalFame, fameGrant, "globalFame"),
        0n,
        rules.fameMax,
      );
      const nextDefenses =
        contrib.outcome === "Defended"
          ? social.settlementDefensesCount + 1
          : social.settlementDefensesCount;
      const nextBand = evaluateMoralBandWithHysteresis({
        nextMoralBounty: nextMoral,
        previousBand: social.moralBand,
        severeCrimeCount: social.severeCrimeCount,
        rules,
      });

      const updatedSocial: CharacterSocialStandingAggregate = {
        ...social,
        moralBounty: nextMoral,
        moralBand: nextBand,
        globalFame: nextFame,
        settlementDefensesCount: nextDefenses,
        socialVersion: social.socialVersion + 1,
        updatedAt: now,
      };
      await scope.updateSocialStanding(updatedSocial, social.socialVersion);

      if (regionId) {
        const reg = await scope.ensureAndLockRegionalStanding(characterId, regionId);
        await scope.updateRegionalStanding(
          {
            ...reg,
            regionalMoralBounty: clampBigInt(
              reg.regionalMoralBounty + moralDelta,
              rules.moralBountyMin,
              rules.moralBountyMax,
            ),
            regionalFame: clampBigInt(reg.regionalFame + fameGrant, 0n, rules.fameMax),
            version: reg.version + 1,
            updatedAt: now,
          },
          reg.version,
        );
      }

      if (settlementId) {
        const stRep = await scope.lockOrInitializeScopedReputation({
          characterId,
          scopeType: "settlement",
          scopeId: settlementId,
          rulesVersion: rules.rulesVersion,
        });
        await scope.updateScopedReputation(
          {
            ...stRep,
            standingValue: clampInt32(
              stRep.standingValue + settlementRepDelta,
              rules.reputationMin,
              rules.reputationMax,
            ),
            version: stRep.version + 1,
            updatedAt: now,
          },
          stRep.version,
        );
      }

      // Record historical chronicle entry
      if (contrib.outcome === "Defended") {
        await scope.client.query(
          `INSERT INTO historical_social_records (
             id, event_reference, event_type, character_id, settlement_id,
             region_id, contribution_role, visibility, summary, rules_version, recorded_at
           )
           VALUES ($1::uuid, $2, 'SettlementDefended', $3::uuid, $4::uuid, $5, $6, 'public_chronicle', $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            contrib.external_event_id,
            characterId,
            settlementId,
            regionId,
            roleTag,
            `Participação elegível na defesa de ${settlementExternalId} (${roleTag}).`,
            rules.rulesVersion,
            now,
          ],
        );
      }

      await scope.client.query(
        `INSERT INTO contribution_recognitions (
           contribution_id, character_id, policy_code, rules_version,
           moral_bounty_granted, fame_granted, settlement_reputation_granted, recognized_at
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::bigint, $6::bigint, $7, $8)`,
        [
          contrib.id,
          characterId,
          isHeroicDefense ? "defense_recognition_v1" : "hostile_siege_v1",
          rules.rulesVersion,
          moralDelta.toString(),
          fameGrant.toString(),
          settlementId ? settlementRepDelta : 0,
          now,
        ],
      );

      // Auto-check `protector_of_valewatch` if Valewatch was defended
      const unlockedTitleCodes: string[] = [];
      if (contrib.outcome === "Defended" && settlementExternalId === "settlement-valewatch") {
        const protectorDef = await scope.findTitleDefinition("protector_of_valewatch");
        if (protectorDef && protectorDef.isEnabled) {
          const snap = await scope.buildTitleEvaluationSnapshot(characterId, updatedSocial);
          if (evaluateTitleConditionAst(protectorDef.requirements, snap)) {
            const unlockId = deriveDeterministicEventUuid(
              `char-title:${characterId}:protector_of_valewatch`,
            );
            const insTitle = await scope.client.query(
              `INSERT INTO character_titles (
                 id, character_id, title_code, state, exclusivity_key,
                 origin_event_id, unlocked_at, updated_at, version
               )
               VALUES ($1::uuid, $2::uuid, 'protector_of_valewatch', 'active', NULL, $3, $4, $4, 1)
               ON CONFLICT (character_id, title_code) DO NOTHING
               RETURNING id`,
              [unlockId, characterId, commandKey, now],
            );
            if ((insTitle.rowCount ?? 0) > 0) {
              unlockedTitleCodes.push("protector_of_valewatch");
              await scope.client.query(
                `INSERT INTO character_title_history (id, character_id, title_code, action, cause_event_id, correlation_id, recorded_at)
                 VALUES ($1::uuid, $2::uuid, 'protector_of_valewatch', 'unlocked', $3, $4::uuid, $5)`,
                [randomUUID(), characterId, commandKey, eventUuid, now],
              );
            }
          }
        }
      }

      await scope.appendSocialLedger({
        characterId,
        domainKind: "contribution_recognition",
        actionCode: roleTag,
        scopeKey: `contrib:${contrib.id}`,
        previousValue: social.moralBounty,
        deltaValue: moralDelta,
        newValue: nextMoral,
        rulesVersion: rules.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          fame_granted: fameGrant.toString(),
          unlocked_titles: unlockedTitleCodes,
        },
        occurredAt: now,
      });

      await scope.enqueueOutbox({
        aggregateType: "CharacterSocialStanding",
        aggregateId: characterId,
        eventType: "HeroicAchievementRecorded",
        correlationUuid: eventUuid,
        causationEventUuid:
          claim.status === "claimed" ? claim.eventUuid : claim.existingEventUuid,
        occurredAt: now,
        payload: {
          character_id: characterId,
          contribution_id: contrib.id,
          moral_bounty_granted: moralDelta.toString(),
          fame_granted: fameGrant.toString(),
          unlocked_titles: unlockedTitleCodes,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "recognizeEligibleContribution",
          commandId: commandKey,
        });
      }

      return {
        status: "applied",
        duplicate: false,
        data: {
          characterId,
          moralBountyGranted: moralDelta,
          fameGranted: fameGrant,
          settlementReputationGranted: settlementId ? settlementRepDelta : 0,
          unlockedTitleCodes,
        },
      };
    });
  }

  public async evaluateCharacterContextualRecognition(params: {
    readonly characterId: string;
    readonly contextRegionId: string;
    readonly contextSettlementId?: string | undefined;
    readonly contextFactionId?: string | undefined;
    readonly contextJurisdictionId?: string | undefined;
    readonly npcSocialRole: NpcSocialRole;
    readonly authoritativePowerStanding?: number | null | undefined;
    readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
  }): Promise<WorldRecognitionEvaluationResult> {
    assertNotGenesisContext("evaluateCharacterContextualRecognition", params.executionProfile);
    const client = await this.pool.connect();
    try {
      const charScope = new PgCharacterTransactionScope(this.pool, client);
      const character = await charScope.findCharacterById(params.characterId);
      if (!character) {
        throw new CharacterNotFoundError(params.characterId);
      }

      const socRes = await client.query<{
        moral_bounty: string;
        moral_band: CharacterSocialStandingAggregate["moralBand"];
        global_fame: string;
        equipped_title_code: string | null;
      }>("SELECT * FROM character_social_standing WHERE character_id = $1::uuid", [
        character.id,
      ]);
      const soc = socRes.rows[0] ?? {
        moral_bounty: "0",
        moral_band: "neutral" as const,
        global_fame: "0",
        equipped_title_code: null,
      };

      const regRes = await client.query<{ regional_fame: string }>(
        "SELECT regional_fame FROM character_regional_standing WHERE character_id = $1::uuid AND region_id = $2",
        [character.id, params.contextRegionId],
      );
      const regionalFame = BigInt(regRes.rows[0]?.regional_fame ?? "0");

      let settlementReputation = 0;
      if (params.contextSettlementId) {
        const sr = await client.query<{ standing_value: number }>(
          "SELECT standing_value FROM character_reputations WHERE character_id = $1::uuid AND scope_type = 'settlement' AND settlement_id = $2::uuid",
          [character.id, params.contextSettlementId],
        );
        settlementReputation = sr.rows[0]?.standing_value ?? 0;
      }

      let factionReputation = 0;
      if (params.contextFactionId) {
        const fr = await client.query<{ standing_value: number }>(
          "SELECT standing_value FROM character_reputations WHERE character_id = $1::uuid AND scope_type = 'faction' AND faction_id = $2::uuid",
          [character.id, params.contextFactionId],
        );
        factionReputation = fr.rows[0]?.standing_value ?? 0;
      }

      let jurisdictionCriminalState: CriminalState = "Clear";
      let safeZoneAccess: "permitted" | "monitored" | "restricted_arrest_on_sight" = "permitted";
      let hasActiveWarrantInJurisdiction = false;

      if (params.contextJurisdictionId) {
        const jr = await client.query<{
          criminal_state: CriminalState;
          safe_zone_access: "permitted" | "monitored" | "restricted_arrest_on_sight";
          active_warrants_count: number;
        }>(
          "SELECT criminal_state, safe_zone_access, active_warrants_count FROM character_jurisdiction_status WHERE character_id = $1::uuid AND jurisdiction_id = $2",
          [character.id, params.contextJurisdictionId],
        );
        if (jr.rows[0]) {
          jurisdictionCriminalState = jr.rows[0].criminal_state;
          safeZoneAccess = jr.rows[0].safe_zone_access;
          hasActiveWarrantInJurisdiction = jr.rows[0].active_warrants_count > 0;
        }
      }

      let equippedTitleCategory: import("../../titles/domain/title-contracts.js").TitleCategory | null =
        null;
      if (soc.equipped_title_code) {
        const tr = await client.query<{
          category: import("../../titles/domain/title-contracts.js").TitleCategory;
        }>("SELECT category FROM title_definitions WHERE title_code = $1", [
          soc.equipped_title_code,
        ]);
        equippedTitleCategory = tr.rows[0]?.category ?? null;
      }

      const histRes = params.contextSettlementId
        ? await client.query<{ contribution_role: string }>(
            `SELECT contribution_role
             FROM historical_social_records
             WHERE character_id = $1::uuid
               AND visibility <> 'restricted_archive'
               AND (settlement_id = $2::uuid OR region_id = $3)
             ORDER BY recorded_at DESC
             LIMIT 200`,
            [character.id, params.contextSettlementId, params.contextRegionId],
          )
        : await client.query<{ contribution_role: string }>(
            `SELECT contribution_role
             FROM historical_social_records
             WHERE character_id = $1::uuid
               AND visibility <> 'restricted_archive'
               AND region_id = $2
             ORDER BY recorded_at DESC
             LIMIT 200`,
            [character.id, params.contextRegionId],
          );

      // Notice: `character.raceCode` is NEVER passed into `evaluateContextualWorldRecognition`!
      return evaluateContextualWorldRecognition({
        moralBounty: BigInt(soc.moral_bounty),
        moralBand: soc.moral_band,
        globalFame: BigInt(soc.global_fame),
        regionalFame,
        settlementReputation,
        factionReputation,
        jurisdictionCriminalState,
        safeZoneAccess,
        hasActiveWarrantInJurisdiction,
        equippedTitleCode: soc.equipped_title_code,
        equippedTitleCategory,
        historicalRolesInContext: histRes.rows.map((r) => r.contribution_role),
        npcSocialRole: params.npcSocialRole,
        authoritativePowerStanding: params.authoritativePowerStanding,
      });
    } finally {
      client.release();
    }
  }
}
