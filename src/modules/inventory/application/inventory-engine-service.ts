import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import {
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
  type Character,
} from "../../characters/domain/character.js";
import {
  AccountNotFoundError,
  CharacterBuildConflictError,
  CharacterCompetitiveLockedError,
  CharacterNotFoundError,
  CharacterOwnershipForbiddenError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  DurabilityOperationInvalidError,
  InventoryCapacityExceededError,
  InventorySlotOccupiedError,
  ItemDefinitionNotFoundError,
  ItemGenerationInvalidError,
  ItemInstanceNotFoundError,
  ItemOwnershipForbiddenError,
  LoadoutInvalidError,
  LoadoutLimitReachedError,
  StackOperationInvalidError,
} from "../domain/errors.js";
import {
  assertCharacterCanEquip,
  assertInstanceTransferPermitted,
  buildStackEquivalenceKey,
  resolveBindingAfterEquip,
  resolveEquipmentSlotCompatibility,
  resolveInitialBindingOnGrant,
  validateStackMergeQuantities,
} from "../domain/equipment-and-stack-rules.js";
import type {
  CombatEquipmentSlot,
  ContainerType,
  EquipmentLoadout,
  EquippedSlotAssignment,
  InventoryStack,
  ItemInstance,
  ItemOriginType,
  ItemRarityCode,
} from "../domain/item-types.js";
import { generateProceduralItemProperties } from "../domain/procedural-generator.js";
import { PostgresInventoryUnitOfWork } from "../infrastructure/postgres-inventory-unit-of-work.js";

export interface GrantProceduralEquipmentCommand {
  readonly grantId: string;
  readonly sourceEventId?: string | undefined;
  readonly rewardSlotIndex?: number | undefined;
  readonly principal: AuthorityPrincipal;
  readonly recipientCharacterId: string;
  readonly definitionCode: string;
  readonly definitionVersion?: number | undefined;
  readonly itemLevel?: number | undefined;
  readonly rarityCode: ItemRarityCode;
  readonly originType: ItemOriginType;
  readonly originReference: string;
  readonly serverSeed?: string | undefined;
  readonly rulesVersion?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantStackableMaterialCommand {
  readonly grantId: string;
  readonly sourceEventId?: string | undefined;
  readonly rewardSlotIndex?: number | undefined;
  readonly principal: AuthorityPrincipal;
  readonly recipientCharacterId: string;
  readonly definitionCode: string;
  readonly definitionVersion?: number | undefined;
  readonly quantity: number;
  readonly qualityBp?: number | undefined;
  readonly originType: ItemOriginType;
  readonly originReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SplitStackCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly sourceStackId: string;
  readonly splitQuantity: number;
  readonly targetSlotIndex?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface MergeStacksCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly sourceStackId: string;
  readonly targetStackId: string;
  readonly quantity?: number | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface MoveInventoryEntryCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly itemInstanceId?: string | undefined;
  readonly stackId?: string | undefined;
  readonly targetContainerType: ContainerType;
  readonly targetSlotIndex: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface EquipItemCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly itemInstanceId: string;
  readonly targetSlot: CombatEquipmentSlot;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface UnequipItemCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly slotCode: CombatEquipmentSlot;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SaveLoadoutCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly loadoutName: string;
  readonly assignments: ReadonlyArray<{
    readonly slotCode: CombatEquipmentSlot;
    readonly itemInstanceId: string;
  }>;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ActivateLoadoutCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly loadoutId: string;
  readonly expectedBuildVersion: number;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ApplyDurabilityLossCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly itemInstanceId: string;
  readonly durabilityLoss: number;
  readonly causeReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RepairItemCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly itemInstanceId: string;
  readonly repairAmount: number;
  readonly causeReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface TransferItemInstanceCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly itemInstanceId: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface DestroyItemInstanceCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly itemInstanceId: string;
  readonly reasonReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface InventoryEngineDependencies {
  readonly pool: PgPool;
  readonly logger: Logger;
  readonly beforeCommitHook?:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;
}

async function assertAuthorizedActiveCharacterAndAccount(
  charScope: PgCharacterTransactionScope,
  character: Character,
  principal: AuthorityPrincipal,
): Promise<void> {
  character.assertOwnedByOrSystem(principal);
  character.assertActiveStatus();
  const account = await charScope.lockAccountById(character.accountId);
  if (!account) {
    throw new AccountNotFoundError(character.accountId);
  }
  assertAccountActive(account);
}

export class InventoryEngineService {
  private readonly pool: PgPool;
  private readonly unitOfWork: PostgresInventoryUnitOfWork;
  private readonly logger: Logger;
  private readonly beforeCommitHook:
    | ((context: { operation: string; commandId: string }) => Promise<void>)
    | undefined;

  constructor(deps: InventoryEngineDependencies) {
    this.pool = deps.pool;
    this.unitOfWork = new PostgresInventoryUnitOfWork(deps.pool);
    this.logger = deps.logger;
    this.beforeCommitHook = deps.beforeCommitHook;
  }

  public async grantProceduralEquipment(
    cmd: GrantProceduralEquipmentCommand,
  ): Promise<IdempotentCommandOutcome<ItemInstance>> {
    assertNotGenesisContext("grantProceduralEquipment", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new ItemOwnershipForbiddenError(
        "Only internal_system_authority may execute authoritative item grants.",
      );
    }
    const systemActorId = cmd.principal.actorId;

    const grantKey = cmd.grantId.trim();
    const sourceEventId = (cmd.sourceEventId ?? grantKey).trim();
    const rewardSlotIndex = cmd.rewardSlotIndex ?? 0;
    const rulesVersion = cmd.rulesVersion ?? 1;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(grantKey);
    const deterministicInstanceId = deriveDeterministicEventUuid(`item-instance:${grantKey}`);
    const serverSeed = cmd.serverSeed ?? `grant-seed:${grantKey}`;

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantProceduralEquipment",
      grant_id: grantKey,
      source_event_id: sourceEventId,
      reward_slot_index: rewardSlotIndex,
      recipient_character_id: cmd.recipientCharacterId.toLowerCase(),
      definition_code: cmd.definitionCode,
      definition_version: cmd.definitionVersion ?? null,
      item_level: cmd.itemLevel ?? null,
      rarity_code: cmd.rarityCode,
      origin_type: cmd.originType,
      origin_reference: cmd.originReference.trim(),
      server_seed: serverSeed,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: grantKey,
        idempotencyKey: grantKey,
        eventType: "ItemGranted",
        eventVersion: 1,
        source: `carbon.inventory:${systemActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: deterministicInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const existing = await scope.findItemInstanceById(deterministicInstanceId);
        if (!existing) {
          throw new ItemInstanceNotFoundError(deterministicInstanceId);
        }
        return { status: "duplicate_idempotent", duplicate: true, data: existing };
      }

      const recipient = await charScope.lockCharacterById(cmd.recipientCharacterId);
      if (!recipient) {
        throw new CharacterNotFoundError(cmd.recipientCharacterId);
      }

      const rules = await scope.loadGenerationRules(rulesVersion);
      if (!rules) {
        throw new ItemGenerationInvalidError(`Unknown item_generation_rules v${rulesVersion}.`);
      }

      const definition = await scope.findItemDefinition(
        cmd.definitionCode,
        cmd.definitionVersion,
      );
      if (!definition || !definition.isEnabled) {
        throw new ItemDefinitionNotFoundError(cmd.definitionCode, cmd.definitionVersion);
      }

      const rarity = await scope.findRarity(cmd.rarityCode);
      if (!rarity) {
        throw new ItemGenerationInvalidError(`Unknown rarity '${cmd.rarityCode}'.`);
      }

      const candidateAffixes = await scope.listAffixesForPools(definition.allowedAffixPools);
      const effectiveItemLevel = cmd.itemLevel ?? definition.baseItemLevel;
      const generated = generateProceduralItemProperties({
        definition,
        rarity,
        rules,
        candidateAffixes,
        itemLevel: effectiveItemLevel,
        serverSeed,
        originReference: cmd.originReference,
      });

      const { bag } = await scope.ensureAndLockPrimaryContainers(
        recipient.id,
        rules.defaultInventoryCapacity,
      );
      const freeSlots = await scope.findFreeContainerSlots(bag, 1);
      if (freeSlots.length < 1) {
        throw new InventoryCapacityExceededError(
          `Character '${recipient.id}' inventory is full (${bag.capacity} slots).`,
        );
      }

      const initialBinding = resolveInitialBindingOnGrant({
        policy: definition.bindingPolicy,
        recipientAccountId: recipient.accountId,
        recipientCharacterId: recipient.id,
      });

      const instance: ItemInstance = {
        id: deterministicInstanceId,
        definitionCode: definition.definitionCode,
        definitionVersion: definition.definitionVersion,
        ownerAccountId: recipient.accountId,
        ownerCharacterId: recipient.id,
        locationState: "in_container",
        containerId: bag.id,
        containerSlotIndex: freeSlots[0]!,
        itemLevel: generated.itemLevel,
        rarityCode: generated.rarityCode,
        qualityBp: generated.qualityBp,
        powerBudgetTotal: generated.powerBudgetTotal,
        powerBudgetSpent: generated.powerBudgetSpent,
        implicitAttributes: generated.implicitAttributes,
        generatedAttributes: generated.generatedAttributes,
        affixes: generated.affixes,
        currentDurability: generated.currentDurability,
        maxDurability: generated.maxDurability,
        bindingState: initialBinding.bindingState,
        boundAccountId: initialBinding.boundAccountId,
        boundCharacterId: initialBinding.boundCharacterId,
        generationRulesVersion: rules.rulesVersion,
        generationSeedHash: generated.generationSeedHash,
        originType: cmd.originType,
        originReference: cmd.originReference.trim(),
        instanceVersion: 1,
        createdAt: now,
        updatedAt: now,
      };

      await scope.insertItemInstance(instance);

      try {
        await scope.client.query(
          `INSERT INTO item_grants (
             id, processed_event_id, external_grant_id, source_event_id,
             recipient_character_id, reward_slot_index, grant_kind,
             item_instance_id, definition_code, definition_version,
             quantity, origin_type, origin_reference, payload_fingerprint
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'equipment_instance', $7, $8, $9, 1, $10, $11, $12)`,
          [
            randomUUID(),
            claim.eventUuid,
            grantKey,
            sourceEventId,
            recipient.id,
            rewardSlotIndex,
            instance.id,
            definition.definitionCode,
            definition.definitionVersion,
            cmd.originType,
            cmd.originReference.trim(),
            fingerprint,
          ],
        );
      } catch (err) {
        if (
          err instanceof pg.DatabaseError &&
          err.code === "23505" &&
          err.constraint === "uq_item_grants_boss_reward_slot"
        ) {
          throw new ItemGenerationInvalidError(
            `Duplicate reward slot (${sourceEventId}, ${recipient.id}, ${rewardSlotIndex}) rejected.`,
          );
        }
        throw err;
      }

      await scope.appendLedger({
        operationId: grantKey,
        operationType: "grant",
        characterId: recipient.id,
        itemInstanceId: instance.id,
        definitionCode: instance.definitionCode,
        definitionVersion: instance.definitionVersion,
        sourceLocation: `origin:${cmd.originType}:${cmd.originReference}`,
        destinationLocation: `container:${bag.id}:slot:${freeSlots[0]!}`,
        quantity: 1,
        entityVersion: 1,
        causeReference: sourceEventId,
        metadata: { rarity: instance.rarityCode, quality_bp: instance.qualityBp },
      });

      await scope.enqueueOutbox({
        aggregateType: "ItemInstance",
        aggregateId: instance.id,
        eventType: "ItemGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          item_instance_id: instance.id,
          recipient_character_id: recipient.id,
          definition_code: instance.definitionCode,
          definition_version: instance.definitionVersion,
          rarity_code: instance.rarityCode,
          quality_bp: instance.qualityBp,
          origin_type: instance.originType,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "grantProceduralEquipment",
          commandId: grantKey,
        });
      }

      this.logger.info("Granted procedural item instance", {
        event_id: grantKey,
        aggregate_id: instance.id,
        operation: "grantProceduralEquipment",
        result: "applied",
      });

      return { status: "applied", duplicate: false, data: instance };
    });
  }

  public async grantStackableMaterial(
    cmd: GrantStackableMaterialCommand,
  ): Promise<IdempotentCommandOutcome<ReadonlyArray<InventoryStack>>> {
    assertNotGenesisContext("grantStackableMaterial", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new ItemOwnershipForbiddenError(
        "Only internal_system_authority may grant stackable materials.",
      );
    }
    const materialActorId = cmd.principal.actorId;
    if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0 || cmd.quantity > 99999) {
      throw new StackOperationInvalidError(
        `Material grant quantity must be a positive integer <= 99999, got ${String(cmd.quantity)}.`,
      );
    }

    const grantKey = cmd.grantId.trim();
    const sourceEventId = (cmd.sourceEventId ?? grantKey).trim();
    const rewardSlotIndex = cmd.rewardSlotIndex ?? 0;
    const qualityBp = cmd.qualityBp ?? 5000;
    if (!Number.isInteger(qualityBp) || qualityBp < 0 || qualityBp > 10000) {
      throw new StackOperationInvalidError("qualityBp must be in 0..10000.");
    }

    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(grantKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantStackableMaterial",
      grant_id: grantKey,
      source_event_id: sourceEventId,
      reward_slot_index: rewardSlotIndex,
      recipient_character_id: cmd.recipientCharacterId.toLowerCase(),
      definition_code: cmd.definitionCode,
      definition_version: cmd.definitionVersion ?? null,
      quantity: cmd.quantity,
      quality_bp: qualityBp,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: grantKey,
        idempotencyKey: grantKey,
        eventType: "ItemGranted",
        eventVersion: 1,
        source: `carbon.inventory:${materialActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.recipientCharacterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const recipient = await charScope.lockCharacterById(cmd.recipientCharacterId);
      if (!recipient) {
        throw new CharacterNotFoundError(cmd.recipientCharacterId);
      }

      const rules = (await scope.loadGenerationRules(1))!;
      const { bag } = await scope.ensureAndLockPrimaryContainers(
        recipient.id,
        rules.defaultInventoryCapacity,
      );

      if (claim.status === "duplicate_verified") {
        const currentStacks = await scope.listContainerStacks(bag.id);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: currentStacks,
        };
      }

      const def = await scope.findItemDefinition(cmd.definitionCode, cmd.definitionVersion);
      if (!def || !def.isEnabled) {
        throw new ItemDefinitionNotFoundError(cmd.definitionCode, cmd.definitionVersion);
      }
      if (!def.stackable) {
        throw new StackOperationInvalidError(
          `Item '${def.definitionCode}' is not stackable; use grantProceduralEquipment instead.`,
        );
      }

      const initBind = resolveInitialBindingOnGrant({
        policy: def.bindingPolicy,
        recipientAccountId: recipient.accountId,
        recipientCharacterId: recipient.id,
      });
      const stackBinding =
        initBind.bindingState === "bind_on_equip" ? "unbound" : initBind.bindingState;

      const eqKey = buildStackEquivalenceKey({
        definitionCode: def.definitionCode,
        definitionVersion: def.definitionVersion,
        qualityBp,
        bindingState: stackBinding,
        boundAccountId: initBind.boundAccountId,
        boundCharacterId: initBind.boundCharacterId,
      });

      const existingStacks = await scope.listCompatibleStacksInContainer(bag.id, eqKey);
      let remaining = cmd.quantity;
      const touchedStacks: InventoryStack[] = [];

      for (const st of existingStacks) {
        if (remaining <= 0) {
          break;
        }
        const room = def.maxStackSize - st.quantity;
        if (room <= 0) {
          continue;
        }
        const add = Math.min(remaining, room);
        const updatedStack: InventoryStack = {
          ...st,
          quantity: st.quantity + add,
          version: st.version + 1,
        };
        await scope.updateStack(updatedStack, st.version);
        remaining -= add;
        touchedStacks.push(updatedStack);
      }

      if (remaining > 0) {
        const neededNewSlots = Math.ceil(remaining / def.maxStackSize);
        const freeSlots = await scope.findFreeContainerSlots(bag, neededNewSlots);
        if (freeSlots.length < neededNewSlots) {
          throw new InventoryCapacityExceededError(
            `Not enough free inventory slots to fit ${remaining} units of '${def.definitionCode}'.`,
          );
        }

        for (let i = 0; i < neededNewSlots; i++) {
          const chunk = Math.min(remaining, def.maxStackSize);
          const newStack: InventoryStack = {
            id: randomUUID(),
            containerId: bag.id,
            ownerCharacterId: recipient.id,
            containerSlotIndex: freeSlots[i]!,
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            quantity: chunk,
            qualityBp,
            bindingState: stackBinding,
            boundAccountId: initBind.boundAccountId,
            boundCharacterId: initBind.boundCharacterId,
            stackEquivalenceKey: eqKey,
            version: 1,
          };
          await scope.insertStack(newStack);
          remaining -= chunk;
          touchedStacks.push(newStack);
        }
      }

      try {
        await scope.client.query(
          `INSERT INTO item_grants (
             id, processed_event_id, external_grant_id, source_event_id,
             recipient_character_id, reward_slot_index, grant_kind,
             stack_id, definition_code, definition_version,
             quantity, origin_type, origin_reference, payload_fingerprint
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'material_stack', $7, $8, $9, $10, $11, $12, $13)`,
          [
            randomUUID(),
            claim.eventUuid,
            grantKey,
            sourceEventId,
            recipient.id,
            rewardSlotIndex,
            touchedStacks[0]?.id ?? null,
            def.definitionCode,
            def.definitionVersion,
            cmd.quantity,
            cmd.originType,
            cmd.originReference.trim(),
            fingerprint,
          ],
        );
      } catch (err) {
        if (
          err instanceof pg.DatabaseError &&
          err.code === "23505" &&
          err.constraint === "uq_item_grants_boss_reward_slot"
        ) {
          throw new ItemGenerationInvalidError(
            `Duplicate reward slot (${sourceEventId}, ${recipient.id}, ${rewardSlotIndex}) rejected.`,
          );
        }
        throw err;
      }

      await scope.appendLedger({
        operationId: grantKey,
        operationType: "grant",
        characterId: recipient.id,
        stackId: touchedStacks[0]?.id ?? null,
        definitionCode: def.definitionCode,
        definitionVersion: def.definitionVersion,
        sourceLocation: `origin:${cmd.originType}:${cmd.originReference}`,
        destinationLocation: `container:${bag.id}`,
        quantity: cmd.quantity,
        entityVersion: touchedStacks[0]?.version ?? 1,
        causeReference: sourceEventId,
      });

      await scope.enqueueOutbox({
        aggregateType: "InventoryContainer",
        aggregateId: bag.id,
        eventType: "ItemGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          recipient_character_id: recipient.id,
          definition_code: def.definitionCode,
          quantity: cmd.quantity,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "grantStackableMaterial",
          commandId: grantKey,
        });
      }

      return { status: "applied", duplicate: false, data: touchedStacks };
    });
  }

  public async splitStack(
    cmd: SplitStackCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly updatedSource: InventoryStack;
      readonly createdSplit: InventoryStack;
    }>
  > {
    assertNotGenesisContext("splitStack", cmd.executionProfile);
    if (!Number.isInteger(cmd.splitQuantity) || cmd.splitQuantity <= 0) {
      throw new StackOperationInvalidError("splitQuantity must be a positive integer.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const newStackId = deriveDeterministicEventUuid(`split-stack:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "SplitStack",
      character_id: cmd.characterId.toLowerCase(),
      source_stack_id: cmd.sourceStackId.toLowerCase(),
      split_quantity: cmd.splitQuantity,
      target_slot_index: cmd.targetSlotIndex ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemStackSplit",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const lockedMap = await scope.lockStacksInCanonicalOrder([cmd.sourceStackId, newStackId]);
      if (claim.status === "duplicate_verified") {
        const existingSrc = lockedMap.get(cmd.sourceStackId)!;
        const existingNew = lockedMap.get(newStackId)!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { updatedSource: existingSrc, createdSplit: existingNew },
        };
      }

      const sourceStack = lockedMap.get(cmd.sourceStackId);
      if (!sourceStack) {
        throw new StackOperationInvalidError(`Stack '${cmd.sourceStackId}' not found.`);
      }
      if (sourceStack.ownerCharacterId !== character.id) {
        throw new ItemOwnershipForbiddenError("Stack does not belong to character.");
      }
      if (cmd.splitQuantity >= sourceStack.quantity) {
        throw new StackOperationInvalidError(
          `splitQuantity (${cmd.splitQuantity}) must be strictly less than stack quantity (${sourceStack.quantity}).`,
        );
      }

      const rules = (await scope.loadGenerationRules(1))!;
      const { bag } = await scope.ensureAndLockPrimaryContainers(
        character.id,
        rules.defaultInventoryCapacity,
      );

      let chosenSlot: number;
      if (cmd.targetSlotIndex !== undefined) {
        if (cmd.targetSlotIndex < 0 || cmd.targetSlotIndex >= bag.capacity) {
          throw new InventoryCapacityExceededError("targetSlotIndex out of container bounds.");
        }
        if (await scope.isSlotOccupied(bag.id, cmd.targetSlotIndex)) {
          throw new InventorySlotOccupiedError(bag.id, cmd.targetSlotIndex);
        }
        chosenSlot = cmd.targetSlotIndex;
      } else {
        const free = await scope.findFreeContainerSlots(bag, 1);
        if (free.length < 1) {
          throw new InventoryCapacityExceededError("No free slot available to split stack.");
        }
        chosenSlot = free[0]!;
      }

      const updatedSource: InventoryStack = {
        ...sourceStack,
        quantity: sourceStack.quantity - cmd.splitQuantity,
        version: sourceStack.version + 1,
      };
      const createdSplit: InventoryStack = {
        ...sourceStack,
        id: newStackId,
        containerId: bag.id,
        containerSlotIndex: chosenSlot,
        quantity: cmd.splitQuantity,
        version: 1,
      };

      await scope.updateStack(updatedSource, sourceStack.version);
      await scope.insertStack(createdSplit);

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "split",
        characterId: character.id,
        stackId: createdSplit.id,
        definitionCode: sourceStack.definitionCode,
        definitionVersion: sourceStack.definitionVersion,
        sourceLocation: `stack:${sourceStack.id}:slot:${sourceStack.containerSlotIndex}`,
        destinationLocation: `stack:${createdSplit.id}:slot:${chosenSlot}`,
        quantity: cmd.splitQuantity,
        entityVersion: createdSplit.version,
        causeReference: commandKey,
      });

      await scope.enqueueOutbox({
        aggregateType: "InventoryContainer",
        aggregateId: bag.id,
        eventType: "ItemStackSplit",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          source_stack_id: updatedSource.id,
          new_stack_id: createdSplit.id,
          split_quantity: cmd.splitQuantity,
          remaining_quantity: updatedSource.quantity,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "splitStack", commandId: commandKey });
      }

      return {
        status: "applied",
        duplicate: false,
        data: { updatedSource, createdSplit },
      };
    });
  }

  public async mergeStacks(
    cmd: MergeStacksCommand,
  ): Promise<IdempotentCommandOutcome<InventoryStack>> {
    assertNotGenesisContext("mergeStacks", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "MergeStacks",
      character_id: cmd.characterId.toLowerCase(),
      source_stack_id: cmd.sourceStackId.toLowerCase(),
      target_stack_id: cmd.targetStackId.toLowerCase(),
      quantity: cmd.quantity ?? null,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemStacksMerged",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const locked = await scope.lockStacksInCanonicalOrder([
        cmd.sourceStackId,
        cmd.targetStackId,
      ]);
      if (claim.status === "duplicate_verified") {
        const target = locked.get(cmd.targetStackId)!;
        return { status: "duplicate_idempotent", duplicate: true, data: target };
      }

      const sourceStack = locked.get(cmd.sourceStackId);
      const targetStack = locked.get(cmd.targetStackId);
      if (!sourceStack || !targetStack) {
        throw new StackOperationInvalidError("Source or target stack does not exist.");
      }
      if (
        sourceStack.ownerCharacterId !== character.id ||
        targetStack.ownerCharacterId !== character.id
      ) {
        throw new ItemOwnershipForbiddenError("Both stacks must belong to character.");
      }

      const def = await scope.findItemDefinition(
        targetStack.definitionCode,
        targetStack.definitionVersion,
      );
      if (!def) {
        throw new ItemDefinitionNotFoundError(
          targetStack.definitionCode,
          targetStack.definitionVersion,
        );
      }

      const outcome = validateStackMergeQuantities({
        sourceStack,
        targetStack,
        definition: def,
        requestedQuantity: cmd.quantity,
      });

      const updatedTarget: InventoryStack = {
        ...targetStack,
        quantity: outcome.nextTargetQuantity,
        version: targetStack.version + 1,
      };
      await scope.updateStack(updatedTarget, targetStack.version);

      if (outcome.nextSourceQuantity === 0) {
        await scope.deleteStack(sourceStack.id);
      } else {
        await scope.updateStack(
          {
            ...sourceStack,
            quantity: outcome.nextSourceQuantity,
            version: sourceStack.version + 1,
          },
          sourceStack.version,
        );
      }

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "merge",
        characterId: character.id,
        stackId: updatedTarget.id,
        definitionCode: updatedTarget.definitionCode,
        definitionVersion: updatedTarget.definitionVersion,
        sourceLocation: `stack:${sourceStack.id}`,
        destinationLocation: `stack:${updatedTarget.id}`,
        quantity: outcome.movedQuantity,
        entityVersion: updatedTarget.version,
        causeReference: commandKey,
      });

      await scope.enqueueOutbox({
        aggregateType: "InventoryContainer",
        aggregateId: updatedTarget.containerId,
        eventType: "ItemStacksMerged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          source_stack_id: sourceStack.id,
          target_stack_id: updatedTarget.id,
          moved_quantity: outcome.movedQuantity,
          target_quantity: updatedTarget.quantity,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "mergeStacks", commandId: commandKey });
      }

      return { status: "applied", duplicate: false, data: updatedTarget };
    });
  }

  public async moveInventoryEntry(
    cmd: MoveInventoryEntryCommand,
  ): Promise<IdempotentCommandOutcome<{ readonly destinationSlot: number }>> {
    assertNotGenesisContext("moveInventoryEntry", cmd.executionProfile);
    if ((cmd.itemInstanceId === undefined) === (cmd.stackId === undefined)) {
      throw new StackOperationInvalidError("Specify exactly one of itemInstanceId or stackId.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "MoveInventoryEntry",
      character_id: cmd.characterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId?.toLowerCase() ?? null,
      stack_id: cmd.stackId?.toLowerCase() ?? null,
      target_container_type: cmd.targetContainerType,
      target_slot_index: cmd.targetSlotIndex,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemMoved",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { destinationSlot: cmd.targetSlotIndex },
        };
      }

      const rules = (await scope.loadGenerationRules(1))!;
      const targetCap =
        cmd.targetContainerType === "personal_storage" ? 60 : rules.defaultInventoryCapacity;
      const targetContainer = await scope.ensureAndLockContainerByType(
        character.id,
        cmd.targetContainerType,
        targetCap,
      );

      if (cmd.targetSlotIndex < 0 || cmd.targetSlotIndex >= targetContainer.capacity) {
        throw new InventoryCapacityExceededError("targetSlotIndex out of container capacity.");
      }
      if (await scope.isSlotOccupied(targetContainer.id, cmd.targetSlotIndex)) {
        throw new InventorySlotOccupiedError(targetContainer.id, cmd.targetSlotIndex);
      }

      if (cmd.itemInstanceId) {
        const inst = await scope.lockItemInstanceById(cmd.itemInstanceId);
        if (!inst) {
          throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
        }
        if (inst.ownerCharacterId !== character.id) {
          throw new ItemOwnershipForbiddenError("Item does not belong to character.");
        }
        if (inst.locationState !== "in_container") {
          throw new StackOperationInvalidError("Only container items can be moved directly.");
        }

        const updated: ItemInstance = {
          ...inst,
          containerId: targetContainer.id,
          containerSlotIndex: cmd.targetSlotIndex,
          instanceVersion: inst.instanceVersion + 1,
          updatedAt: now,
        };
        await scope.updateItemInstance(updated, inst.instanceVersion);

        await scope.appendLedger({
          operationId: commandKey,
          operationType: "move",
          characterId: character.id,
          itemInstanceId: updated.id,
          definitionCode: updated.definitionCode,
          definitionVersion: updated.definitionVersion,
          sourceLocation: `container:${inst.containerId}:slot:${inst.containerSlotIndex}`,
          destinationLocation: `container:${targetContainer.id}:slot:${cmd.targetSlotIndex}`,
          quantity: 1,
          entityVersion: updated.instanceVersion,
          causeReference: commandKey,
        });
      } else {
        const stacks = await scope.lockStacksInCanonicalOrder([cmd.stackId!]);
        const st = stacks.get(cmd.stackId!);
        if (!st) {
          throw new StackOperationInvalidError(`Stack '${cmd.stackId}' not found.`);
        }
        if (st.ownerCharacterId !== character.id) {
          throw new ItemOwnershipForbiddenError("Stack does not belong to character.");
        }
        const updated: InventoryStack = {
          ...st,
          containerId: targetContainer.id,
          containerSlotIndex: cmd.targetSlotIndex,
          version: st.version + 1,
        };
        await scope.updateStack(updated, st.version);

        await scope.appendLedger({
          operationId: commandKey,
          operationType: "move",
          characterId: character.id,
          stackId: updated.id,
          definitionCode: updated.definitionCode,
          definitionVersion: updated.definitionVersion,
          sourceLocation: `container:${st.containerId}:slot:${st.containerSlotIndex}`,
          destinationLocation: `container:${targetContainer.id}:slot:${cmd.targetSlotIndex}`,
          quantity: updated.quantity,
          entityVersion: updated.version,
          causeReference: commandKey,
        });
      }

      await scope.enqueueOutbox({
        aggregateType: "InventoryContainer",
        aggregateId: targetContainer.id,
        eventType: "ItemMoved",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          target_container_type: cmd.targetContainerType,
          target_slot_index: cmd.targetSlotIndex,
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: { destinationSlot: cmd.targetSlotIndex },
      };
    });
  }

  public async equipItem(
    cmd: EquipItemCommand,
  ): Promise<IdempotentCommandOutcome<EquipmentLoadout>> {
    assertNotGenesisContext("equipItem", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "EquipItem",
      character_id: cmd.characterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
      target_slot: cmd.targetSlot,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemEquipped",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const rules = (await scope.loadGenerationRules(1))!;
      const { bag, activeLoadout } = await scope.ensureAndLockPrimaryContainers(
        character.id,
        rules.defaultInventoryCapacity,
      );

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: activeLoadout };
      }

      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }
      character.assertExpectedBuildVersion(cmd.expectedBuildVersion);

      const item = await scope.lockItemInstanceById(cmd.itemInstanceId);
      if (!item) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }
      if (item.ownerCharacterId !== character.id) {
        throw new ItemOwnershipForbiddenError(
          `Item '${item.id}' does not belong to character '${character.id}'.`,
        );
      }
      if (item.locationState === "destroyed") {
        throw new ItemInstanceNotFoundError(item.id);
      }

      const def = await scope.findItemDefinition(item.definitionCode, item.definitionVersion);
      if (!def) {
        throw new ItemDefinitionNotFoundError(item.definitionCode, item.definitionVersion);
      }

      const { occupiesOffHand } = resolveEquipmentSlotCompatibility(def, cmd.targetSlot);
      assertCharacterCanEquip(character, def, item);

      // Determine which currently equipped items are displaced by this equip/swap:
      // 1. Any item currently in `targetSlot` (unless same item).
      // 2. If equipping a 2H weapon (`occupiesOffHand === true`), also displaces `off_hand`!
      // 3. If equipping into `off_hand` while `main_hand` holds a 2H weapon (`occupiesOffHand`), also displaces `main_hand`!
      // 4. If `item` was already equipped in another slot (e.g. moving sword from main_hand to off_hand), remove old slot.
      const displacedSlots = new Set<CombatEquipmentSlot>();
      for (const s of activeLoadout.slots) {
        if (s.itemInstanceId === item.id && s.slotCode !== cmd.targetSlot) {
          displacedSlots.add(s.slotCode);
        }
        if (s.slotCode === cmd.targetSlot && s.itemInstanceId !== item.id) {
          displacedSlots.add(s.slotCode);
        }
        if (occupiesOffHand && s.slotCode === "off_hand") {
          displacedSlots.add("off_hand");
        }
        if (cmd.targetSlot === "off_hand" && s.slotCode === "main_hand" && s.occupiesOffHand) {
          displacedSlots.add("main_hand");
        }
      }

      const displacedAssignments = activeLoadout.slots.filter(
        (s) => displacedSlots.has(s.slotCode) && s.itemInstanceId !== item.id,
      );

      // Free the incoming item's bag slot FIRST (if it was in_container) so 1-for-1 swaps work even in a full bag!
      const incomingWasInBag = item.locationState === "in_container";
      const postEquipBind = resolveBindingAfterEquip({
        currentBindingState: item.bindingState,
        boundAccountId: item.boundAccountId,
        boundCharacterId: item.boundCharacterId,
        equippingAccountId: character.accountId,
        equippingCharacterId: character.id,
      });

      const equippedInstance: ItemInstance = {
        ...item,
        locationState: "equipped_active",
        containerId: null,
        containerSlotIndex: null,
        bindingState: postEquipBind.bindingState,
        boundAccountId: postEquipBind.boundAccountId,
        boundCharacterId: postEquipBind.boundCharacterId,
        instanceVersion: item.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(equippedInstance, item.instanceVersion);

      // Now find free slots in bag for all displaced items (must fit 100%, otherwise transaction throws & rolls back!)
      if (displacedAssignments.length > 0) {
        const freeBagSlots = await scope.findFreeContainerSlots(
          bag,
          displacedAssignments.length,
        );
        if (freeBagSlots.length < displacedAssignments.length) {
          throw new InventoryCapacityExceededError(
            `Swap requires ${displacedAssignments.length} free inventory slot(s), but only ${freeBagSlots.length} available.`,
          );
        }

        for (let i = 0; i < displacedAssignments.length; i++) {
          const disp = displacedAssignments[i]!;
          const dispItem = await scope.lockItemInstanceById(disp.itemInstanceId);
          if (!dispItem) {
            continue;
          }
          const returnedToBag: ItemInstance = {
            ...dispItem,
            locationState: "in_container",
            containerId: bag.id,
            containerSlotIndex: freeBagSlots[i]!,
            instanceVersion: dispItem.instanceVersion + 1,
            updatedAt: now,
          };
          await scope.updateItemInstance(returnedToBag, dispItem.instanceVersion);

          await scope.appendLedger({
            operationId: commandKey,
            operationType: "unequip",
            characterId: character.id,
            itemInstanceId: returnedToBag.id,
            definitionCode: returnedToBag.definitionCode,
            definitionVersion: returnedToBag.definitionVersion,
            sourceLocation: `loadout:${activeLoadout.id}:slot:${disp.slotCode}`,
            destinationLocation: `container:${bag.id}:slot:${freeBagSlots[i]!}`,
            quantity: 1,
            entityVersion: returnedToBag.instanceVersion,
            causeReference: commandKey,
          });
        }
      }

      const nextSlots: EquippedSlotAssignment[] = activeLoadout.slots
        .filter((s) => !displacedSlots.has(s.slotCode) && s.slotCode !== cmd.targetSlot)
        .concat([
          {
            slotCode: cmd.targetSlot,
            itemInstanceId: equippedInstance.id,
            occupiesOffHand,
          },
        ])
        .sort((a, b) => (a.slotCode < b.slotCode ? -1 : a.slotCode > b.slotCode ? 1 : 0));

      await scope.replaceLoadoutSlots(activeLoadout.id, nextSlots);

      const nextBuildVersion = character.buildVersion + 1;
      const nextSnapshotVersion = character.snapshotVersion + 1;
      const updCharRes = await scope.client.query(
        `UPDATE characters
         SET build_version = $1, snapshot_version = $2, updated_at = $3
         WHERE id = $4 AND build_version = $5`,
        [nextBuildVersion, nextSnapshotVersion, now, character.id, character.buildVersion],
      );
      if (updCharRes.rowCount !== 1) {
        throw new CharacterBuildConflictError(
          character.id,
          character.buildVersion,
          nextBuildVersion,
        );
      }

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "equip",
        characterId: character.id,
        itemInstanceId: equippedInstance.id,
        definitionCode: equippedInstance.definitionCode,
        definitionVersion: equippedInstance.definitionVersion,
        sourceLocation: incomingWasInBag
          ? `container:${item.containerId}:slot:${item.containerSlotIndex}`
          : `loadout:${activeLoadout.id}`,
        destinationLocation: `loadout:${activeLoadout.id}:slot:${cmd.targetSlot}`,
        quantity: 1,
        entityVersion: equippedInstance.instanceVersion,
        causeReference: commandKey,
        metadata: { bound_transitioned: postEquipBind.transitioned },
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "ItemEquipped",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          item_instance_id: equippedInstance.id,
          slot_code: cmd.targetSlot,
          occupies_off_hand: occupiesOffHand,
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
          operation: "equip_item",
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({ operation: "equipItem", commandId: commandKey });
      }

      return {
        status: "applied",
        duplicate: false,
        data: {
          ...activeLoadout,
          version: activeLoadout.version + 1,
          slots: nextSlots,
        },
      };
    });
  }

  public async unequipItem(
    cmd: UnequipItemCommand,
  ): Promise<IdempotentCommandOutcome<EquipmentLoadout>> {
    assertNotGenesisContext("unequipItem", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "UnequipItem",
      character_id: cmd.characterId.toLowerCase(),
      slot_code: cmd.slotCode,
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemUnequipped",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const rules = (await scope.loadGenerationRules(1))!;
      const { bag, activeLoadout } = await scope.ensureAndLockPrimaryContainers(
        character.id,
        rules.defaultInventoryCapacity,
      );

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: activeLoadout };
      }

      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }
      character.assertExpectedBuildVersion(cmd.expectedBuildVersion);

      const slotEntry = activeLoadout.slots.find((s) => s.slotCode === cmd.slotCode);
      if (!slotEntry) {
        throw new LoadoutInvalidError(`Slot '${cmd.slotCode}' is already empty.`);
      }

      const freeSlots = await scope.findFreeContainerSlots(bag, 1);
      if (freeSlots.length < 1) {
        throw new InventoryCapacityExceededError(
          "Cannot unequip item: character inventory is full.",
        );
      }

      const inst = await scope.lockItemInstanceById(slotEntry.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(slotEntry.itemInstanceId);
      }

      const returned: ItemInstance = {
        ...inst,
        locationState: "in_container",
        containerId: bag.id,
        containerSlotIndex: freeSlots[0]!,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(returned, inst.instanceVersion);

      const nextSlots = activeLoadout.slots.filter((s) => s.slotCode !== cmd.slotCode);
      await scope.replaceLoadoutSlots(activeLoadout.id, nextSlots);

      const nextBuildVersion = character.buildVersion + 1;
      const nextSnapshotVersion = character.snapshotVersion + 1;
      await scope.client.query(
        `UPDATE characters
         SET build_version = $1, snapshot_version = $2, updated_at = $3
         WHERE id = $4 AND build_version = $5`,
        [nextBuildVersion, nextSnapshotVersion, now, character.id, character.buildVersion],
      );

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "unequip",
        characterId: character.id,
        itemInstanceId: returned.id,
        definitionCode: returned.definitionCode,
        definitionVersion: returned.definitionVersion,
        sourceLocation: `loadout:${activeLoadout.id}:slot:${cmd.slotCode}`,
        destinationLocation: `container:${bag.id}:slot:${freeSlots[0]!}`,
        quantity: 1,
        entityVersion: returned.instanceVersion,
        causeReference: commandKey,
      });

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "ItemUnequipped",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          item_instance_id: returned.id,
          slot_code: cmd.slotCode,
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
          operation: "unequip_item",
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: { ...activeLoadout, version: activeLoadout.version + 1, slots: nextSlots },
      };
    });
  }

  public async saveInactiveLoadout(
    cmd: SaveLoadoutCommand,
  ): Promise<IdempotentCommandOutcome<EquipmentLoadout>> {
    assertNotGenesisContext("saveInactiveLoadout", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const loadoutName = cmd.loadoutName.trim();
    if (!loadoutName || loadoutName.length > 64) {
      throw new LoadoutInvalidError("loadoutName must be 1..64 non-blank characters.");
    }

    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const loadoutId = deriveDeterministicEventUuid(`loadout:${cmd.characterId}:${loadoutName}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "SaveLoadout",
      character_id: cmd.characterId.toLowerCase(),
      loadout_name: loadoutName,
      assignments: cmd.assignments.map((a) => `${a.slotCode}:${a.itemInstanceId.toLowerCase()}`),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterLoadoutChanged",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const rules = (await scope.loadGenerationRules(1))!;
      await scope.ensureAndLockPrimaryContainers(character.id, rules.defaultInventoryCapacity);

      if (claim.status === "duplicate_verified") {
        const slots = await scope.listLoadoutSlots(loadoutId);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            id: loadoutId,
            characterId: character.id,
            name: loadoutName,
            isActive: false,
            version: 1,
            slots,
          },
        };
      }

      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }

      // Guard against overwriting ANY currently active loadout (including 'Principal' or a previously activated preset)
      const conflictingLoadoutsRes = await scope.client.query<{
        id: string;
        name: string;
        is_active: boolean;
        version: number;
      }>(
        `SELECT id, name, is_active, version
         FROM equipment_loadouts
         WHERE character_id = $1::uuid
           AND (id = $2::uuid OR name = $3)
         FOR UPDATE`,
        [character.id, loadoutId, loadoutName],
      );

      for (const row of conflictingLoadoutsRes.rows) {
        if (row.is_active) {
          throw new LoadoutInvalidError(
            `Cannot overwrite currently active loadout '${row.name}' via saveInactiveLoadout; use equipItem/unequipItem or activate another loadout first.`,
          );
        }
        if (row.id !== loadoutId && row.name === loadoutName) {
          throw new LoadoutInvalidError(
            `Loadout name '${loadoutName}' is already in use on character '${character.id}'.`,
          );
        }
      }

      const existingCountRes = await scope.client.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM equipment_loadouts WHERE character_id = $1 AND id <> $2",
        [character.id, loadoutId],
      );
      if (Number(existingCountRes.rows[0]?.total ?? "0") >= rules.maxLoadoutsPerCharacter) {
        throw new LoadoutLimitReachedError(character.id, rules.maxLoadoutsPerCharacter);
      }

      const seenSlots = new Set<CombatEquipmentSlot>();
      const seenInstances = new Set<string>();
      const validatedSlots: EquippedSlotAssignment[] = [];
      let mainHandTwoHanded = false;

      for (const a of cmd.assignments) {
        if (seenSlots.has(a.slotCode)) {
          throw new LoadoutInvalidError(`Duplicate slot '${a.slotCode}' in loadout.`);
        }
        if (seenInstances.has(a.itemInstanceId.toLowerCase())) {
          throw new LoadoutInvalidError(
            `Same item instance '${a.itemInstanceId}' cannot occupy multiple loadout slots.`,
          );
        }
        seenSlots.add(a.slotCode);
        seenInstances.add(a.itemInstanceId.toLowerCase());

        const inst = await scope.findItemInstanceById(a.itemInstanceId);
        if (!inst || inst.locationState === "destroyed") {
          throw new LoadoutInvalidError(
            `Referenced item '${a.itemInstanceId}' does not exist or is destroyed.`,
          );
        }
        if (inst.ownerCharacterId !== character.id) {
          throw new ItemOwnershipForbiddenError(
            `Referenced item '${a.itemInstanceId}' is not owned by character '${character.id}'.`,
          );
        }

        const def = await scope.findItemDefinition(inst.definitionCode, inst.definitionVersion);
        if (!def) {
          throw new ItemDefinitionNotFoundError(inst.definitionCode, inst.definitionVersion);
        }

        const { occupiesOffHand } = resolveEquipmentSlotCompatibility(def, a.slotCode);
        if (occupiesOffHand) {
          mainHandTwoHanded = true;
        }

        validatedSlots.push({
          slotCode: a.slotCode,
          itemInstanceId: inst.id,
          occupiesOffHand,
        });
      }

      if (mainHandTwoHanded && seenSlots.has("off_hand")) {
        throw new LoadoutInvalidError(
          "Cannot combine a two-handed main_hand weapon with an off_hand item in the same loadout.",
        );
      }

      await scope.client.query(
        `INSERT INTO equipment_loadouts (id, character_id, name, is_active, version)
         VALUES ($1, $2, $3, FALSE, 1)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
        [loadoutId, character.id, loadoutName],
      );
      await scope.replaceLoadoutSlots(loadoutId, validatedSlots);

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: loadoutId,
          characterId: character.id,
          name: loadoutName,
          isActive: false,
          version: 2,
          slots: validatedSlots,
        },
      };
    });
  }

  public async activateLoadout(
    cmd: ActivateLoadoutCommand,
  ): Promise<IdempotentCommandOutcome<EquipmentLoadout>> {
    assertNotGenesisContext("activateLoadout", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ActivateLoadout",
      character_id: cmd.characterId.toLowerCase(),
      loadout_id: cmd.loadoutId.toLowerCase(),
      expected_build_version: cmd.expectedBuildVersion,
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CharacterLoadoutChanged",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.characterId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const rules = (await scope.loadGenerationRules(1))!;
      const { bag, activeLoadout } = await scope.ensureAndLockPrimaryContainers(
        character.id,
        rules.defaultInventoryCapacity,
      );

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: activeLoadout };
      }

      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }
      character.assertExpectedBuildVersion(cmd.expectedBuildVersion);

      if (activeLoadout.id === cmd.loadoutId) {
        return { status: "applied", duplicate: false, data: activeLoadout };
      }

      const targetLoadoutRes = await scope.client.query<{
        id: string;
        character_id: string;
        name: string;
        is_active: boolean;
        version: number;
      }>(
        "SELECT id, character_id, name, is_active, version FROM equipment_loadouts WHERE id = $1 FOR UPDATE",
        [cmd.loadoutId],
      );
      const targetRow = targetLoadoutRes.rows[0];
      if (!targetRow || targetRow.character_id !== character.id) {
        throw new LoadoutInvalidError(`Loadout '${cmd.loadoutId}' not found for character.`);
      }

      const targetSlots = await scope.listLoadoutSlots(targetRow.id);
      const currentActiveIds = new Set(activeLoadout.slots.map((s) => s.itemInstanceId));
      const targetIds = new Set(targetSlots.map((s) => s.itemInstanceId));

      // Lock all involved item instances in canonical UUID order
      const allInstanceIds = Array.from(new Set([...currentActiveIds, ...targetIds])).sort();
      const lockedInstances = new Map<string, ItemInstance>();
      for (const id of allInstanceIds) {
        const locked = await scope.lockItemInstanceById(id);
        if (locked) {
          lockedInstances.set(id, locked);
        }
      }

      // Validate every target item is still owned, non-destroyed, non-broken, and meets requirements
      for (const s of targetSlots) {
        const inst = lockedInstances.get(s.itemInstanceId);
        if (!inst || inst.locationState === "destroyed" || inst.ownerCharacterId !== character.id) {
          throw new LoadoutInvalidError(
            `Loadout '${targetRow.name}' contains invalid or unowned item reference '${s.itemInstanceId}'.`,
          );
        }
        const def = await scope.findItemDefinition(inst.definitionCode, inst.definitionVersion);
        if (!def) {
          throw new ItemDefinitionNotFoundError(inst.definitionCode, inst.definitionVersion);
        }
        assertCharacterCanEquip(character, def, inst);
      }

      // First transition items entering active state (freeing their bag slots!)
      for (const s of targetSlots) {
        if (!currentActiveIds.has(s.itemInstanceId)) {
          const inst = lockedInstances.get(s.itemInstanceId)!;
          const postBind = resolveBindingAfterEquip({
            currentBindingState: inst.bindingState,
            boundAccountId: inst.boundAccountId,
            boundCharacterId: inst.boundCharacterId,
            equippingAccountId: character.accountId,
            equippingCharacterId: character.id,
          });
          await scope.updateItemInstance(
            {
              ...inst,
              locationState: "equipped_active",
              containerId: null,
              containerSlotIndex: null,
              bindingState: postBind.bindingState,
              boundAccountId: postBind.boundAccountId,
              boundCharacterId: postBind.boundCharacterId,
              instanceVersion: inst.instanceVersion + 1,
              updatedAt: now,
            },
            inst.instanceVersion,
          );
        }
      }

      // Move items leaving active state back into character_inventory
      const leavingIds = Array.from(currentActiveIds).filter((id) => !targetIds.has(id));
      if (leavingIds.length > 0) {
        const freeSlots = await scope.findFreeContainerSlots(bag, leavingIds.length);
        if (freeSlots.length < leavingIds.length) {
          throw new InventoryCapacityExceededError(
            `Activating loadout '${targetRow.name}' requires ${leavingIds.length} bag slot(s), only ${freeSlots.length} free.`,
          );
        }
        for (let i = 0; i < leavingIds.length; i++) {
          const inst = lockedInstances.get(leavingIds[i]!)!;
          await scope.updateItemInstance(
            {
              ...inst,
              locationState: "in_container",
              containerId: bag.id,
              containerSlotIndex: freeSlots[i]!,
              instanceVersion: inst.instanceVersion + 1,
              updatedAt: now,
            },
            inst.instanceVersion,
          );
        }
      }

      // Flip active flag atomically (deactivate old first to satisfy partial unique index!)
      await scope.client.query(
        "UPDATE equipment_loadouts SET is_active = FALSE, version = version + 1, updated_at = NOW() WHERE id = $1",
        [activeLoadout.id],
      );
      await scope.client.query(
        "UPDATE equipment_loadouts SET is_active = TRUE, version = version + 1, updated_at = NOW() WHERE id = $1",
        [targetRow.id],
      );

      const nextBuildVersion = character.buildVersion + 1;
      const nextSnapshotVersion = character.snapshotVersion + 1;
      await scope.client.query(
        `UPDATE characters
         SET build_version = $1, snapshot_version = $2, updated_at = $3
         WHERE id = $4 AND build_version = $5`,
        [nextBuildVersion, nextSnapshotVersion, now, character.id, character.buildVersion],
      );

      if (targetSlots[0]) {
        const sampleInst = lockedInstances.get(targetSlots[0].itemInstanceId)!;
        await scope.appendLedger({
          operationId: commandKey,
          operationType: "loadout_activate",
          characterId: character.id,
          itemInstanceId: sampleInst.id,
          definitionCode: sampleInst.definitionCode,
          definitionVersion: sampleInst.definitionVersion,
          sourceLocation: `loadout:${activeLoadout.id}`,
          destinationLocation: `loadout:${targetRow.id}`,
          quantity: 1,
          entityVersion: targetRow.version + 1,
          causeReference: commandKey,
        });
      }

      await scope.enqueueOutbox({
        aggregateType: "Character",
        aggregateId: character.id,
        eventType: "CharacterLoadoutChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: character.id,
          previous_loadout_id: activeLoadout.id,
          active_loadout_id: targetRow.id,
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
          operation: "activate_loadout",
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: targetRow.id,
          characterId: character.id,
          name: targetRow.name,
          isActive: true,
          version: targetRow.version + 1,
          slots: targetSlots,
        },
      };
    });
  }

  public async applyDurabilityLoss(
    cmd: ApplyDurabilityLossCommand,
  ): Promise<IdempotentCommandOutcome<ItemInstance>> {
    assertNotGenesisContext("applyDurabilityLoss", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new ItemOwnershipForbiddenError(
        "Only internal_system_authority may apply authoritative combat durability loss.",
      );
    }
    const durabilityActorId = cmd.principal.actorId;
    if (!Number.isInteger(cmd.durabilityLoss) || cmd.durabilityLoss <= 0) {
      throw new DurabilityOperationInvalidError("durabilityLoss must be a positive integer.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ApplyDurabilityLoss",
      character_id: cmd.characterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
      durability_loss: cmd.durabilityLoss,
      cause_reference: cmd.causeReference.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemDurabilityChanged",
        eventVersion: 1,
        source: `carbon.inventory:${durabilityActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.itemInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }

      const inst = await scope.lockItemInstanceById(cmd.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }
      if (inst.ownerCharacterId !== character.id) {
        throw new ItemOwnershipForbiddenError("Item does not belong to specified character.");
      }
      if (inst.currentDurability === null || inst.maxDurability === null) {
        throw new DurabilityOperationInvalidError(
          `Item '${inst.id}' does not possess durability.`,
        );
      }

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: inst };
      }

      const nextDurability = Math.max(0, inst.currentDurability - cmd.durabilityLoss);
      const updated: ItemInstance = {
        ...inst,
        currentDurability: nextDurability,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(updated, inst.instanceVersion);

      if (updated.locationState === "equipped_active") {
        await scope.client.query(
          "UPDATE characters SET snapshot_version = snapshot_version + 1, updated_at = $1 WHERE id = $2",
          [now, character.id],
        );
      }

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "durability_loss",
        characterId: character.id,
        itemInstanceId: updated.id,
        definitionCode: updated.definitionCode,
        definitionVersion: updated.definitionVersion,
        sourceLocation: `durability:${inst.currentDurability}`,
        destinationLocation: `durability:${nextDurability}`,
        quantity: 1,
        entityVersion: updated.instanceVersion,
        causeReference: cmd.causeReference.trim(),
      });

      await scope.enqueueOutbox({
        aggregateType: "ItemInstance",
        aggregateId: updated.id,
        eventType: "ItemDurabilityChanged",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          item_instance_id: updated.id,
          character_id: character.id,
          previous_durability: inst.currentDurability,
          current_durability: nextDurability,
          is_broken: nextDurability === 0,
        },
      });

      return { status: "applied", duplicate: false, data: updated };
    });
  }

  public async repairItem(
    cmd: RepairItemCommand,
  ): Promise<IdempotentCommandOutcome<ItemInstance>> {
    assertNotGenesisContext("repairItem", cmd.executionProfile);
    if (cmd.principal.kind !== "internal_system_authority") {
      throw new ItemOwnershipForbiddenError(
        "Only authorized internal repair service may execute repairItem.",
      );
    }
    const repairActorId = cmd.principal.actorId;
    if (!Number.isInteger(cmd.repairAmount) || cmd.repairAmount <= 0) {
      throw new DurabilityOperationInvalidError("repairAmount must be a positive integer.");
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RepairItem",
      character_id: cmd.characterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
      repair_amount: cmd.repairAmount,
      cause_reference: cmd.causeReference.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemRepaired",
        eventVersion: 1,
        source: `carbon.inventory:${repairActorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: cmd.itemInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }

      const inst = await scope.lockItemInstanceById(cmd.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }
      if (inst.ownerCharacterId !== character.id) {
        throw new ItemOwnershipForbiddenError("Item does not belong to specified character.");
      }
      if (inst.currentDurability === null || inst.maxDurability === null) {
        throw new DurabilityOperationInvalidError("Item does not possess durability.");
      }

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: inst };
      }

      const nextDurability = Math.min(
        inst.maxDurability,
        inst.currentDurability + cmd.repairAmount,
      );
      const updated: ItemInstance = {
        ...inst,
        currentDurability: nextDurability,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(updated, inst.instanceVersion);

      if (updated.locationState === "equipped_active") {
        await scope.client.query(
          "UPDATE characters SET snapshot_version = snapshot_version + 1, updated_at = $1 WHERE id = $2",
          [now, character.id],
        );
      }

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "repair",
        characterId: character.id,
        itemInstanceId: updated.id,
        definitionCode: updated.definitionCode,
        definitionVersion: updated.definitionVersion,
        sourceLocation: `durability:${inst.currentDurability}`,
        destinationLocation: `durability:${nextDurability}`,
        quantity: 1,
        entityVersion: updated.instanceVersion,
        causeReference: cmd.causeReference.trim(),
      });

      await scope.enqueueOutbox({
        aggregateType: "ItemInstance",
        aggregateId: updated.id,
        eventType: "ItemRepaired",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          item_instance_id: updated.id,
          character_id: character.id,
          previous_durability: inst.currentDurability,
          current_durability: nextDurability,
        },
      });

      return { status: "applied", duplicate: false, data: updated };
    });
  }

  public async transferItemInstance(
    cmd: TransferItemInstanceCommand,
  ): Promise<IdempotentCommandOutcome<ItemInstance>> {
    assertNotGenesisContext("transferItemInstance", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "TransferItemInstance",
      from_character_id: cmd.fromCharacterId.toLowerCase(),
      to_character_id: cmd.toCharacterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);

      // Canonical ascending UUID lock order across both characters BEFORE inbox claim!
      const orderedCharIds = [cmd.fromCharacterId, cmd.toCharacterId].sort();
      const char1 = await charScope.lockCharacterById(orderedCharIds[0]!);
      const char2 =
        orderedCharIds[0] === orderedCharIds[1]
          ? char1
          : await charScope.lockCharacterById(orderedCharIds[1]!);

      const fromChar = cmd.fromCharacterId === orderedCharIds[0] ? char1 : char2;
      const toChar = cmd.toCharacterId === orderedCharIds[0] ? char1 : char2;

      if (!fromChar) {
        throw new CharacterNotFoundError(cmd.fromCharacterId);
      }
      if (!toChar) {
        throw new CharacterNotFoundError(cmd.toCharacterId);
      }

      fromChar.assertOwnedByOrSystem(cmd.principal);
      fromChar.assertActiveStatus();
      toChar.assertActiveStatus();

      // Lock involved accounts in canonical ascending UUID order to prevent deadlocks
      const orderedAccountIds = Array.from(
        new Set([fromChar.accountId, toChar.accountId]),
      ).sort();
      for (const accId of orderedAccountIds) {
        const acc = await charScope.lockAccountById(accId);
        if (!acc) {
          throw new AccountNotFoundError(accId);
        }
        assertAccountActive(acc);
      }

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemTransferred",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.itemInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const inst = await scope.lockItemInstanceById(cmd.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }

      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: inst };
      }

      if (fromChar.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(fromChar.id);
      }
      if (toChar.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(toChar.id);
      }

      if (inst.ownerCharacterId !== fromChar.id) {
        throw new ItemOwnershipForbiddenError(
          `Item '${inst.id}' is not currently owned by sender '${fromChar.id}'.`,
        );
      }

      assertInstanceTransferPermitted({
        instance: inst,
        fromCharacter: fromChar,
        toCharacter: toChar,
      });

      const rules = (await scope.loadGenerationRules(1))!;
      const orderedContainerOwners = [fromChar.id, toChar.id].sort();
      const bagMap = new Map<string, Awaited<ReturnType<typeof scope.ensureAndLockPrimaryContainers>>["bag"]>();
      for (const ownerId of orderedContainerOwners) {
        const { bag } = await scope.ensureAndLockPrimaryContainers(
          ownerId,
          rules.defaultInventoryCapacity,
        );
        bagMap.set(ownerId, bag);
      }
      const recipientBag = bagMap.get(toChar.id)!;
      const freeSlots = await scope.findFreeContainerSlots(recipientBag, 1);
      if (freeSlots.length < 1) {
        throw new InventoryCapacityExceededError(
          `Recipient character '${toChar.id}' inventory is full.`,
        );
      }

      // Purge any inactive loadout pointer references on sender so sender cannot activate an unowned item later!
      await scope.purgeInactiveLoadoutReferencesForItem(fromChar.id, inst.id);

      const transferred: ItemInstance = {
        ...inst,
        ownerAccountId: toChar.accountId,
        ownerCharacterId: toChar.id,
        locationState: "in_container",
        containerId: recipientBag.id,
        containerSlotIndex: freeSlots[0]!,
        // Binding state is NEVER stripped by transfer!
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(transferred, inst.instanceVersion);

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "transfer",
        characterId: fromChar.id,
        counterpartyCharacterId: toChar.id,
        itemInstanceId: transferred.id,
        definitionCode: transferred.definitionCode,
        definitionVersion: transferred.definitionVersion,
        sourceLocation: `char:${fromChar.id}:container:${inst.containerId}:slot:${inst.containerSlotIndex}`,
        destinationLocation: `char:${toChar.id}:container:${recipientBag.id}:slot:${freeSlots[0]!}`,
        quantity: 1,
        entityVersion: transferred.instanceVersion,
        causeReference: commandKey,
      });

      await scope.enqueueOutbox({
        aggregateType: "ItemInstance",
        aggregateId: transferred.id,
        eventType: "ItemTransferred",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          item_instance_id: transferred.id,
          from_character_id: fromChar.id,
          to_character_id: toChar.id,
          binding_state: transferred.bindingState,
        },
      });

      if (this.beforeCommitHook) {
        await this.beforeCommitHook({
          operation: "transferItemInstance",
          commandId: commandKey,
        });
      }

      return { status: "applied", duplicate: false, data: transferred };
    });
  }

  public async destroyItemInstance(
    cmd: DestroyItemInstanceCommand,
  ): Promise<IdempotentCommandOutcome<ItemInstance>> {
    assertNotGenesisContext("destroyItemInstance", cmd.executionProfile);
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "DestroyItemInstance",
      character_id: cmd.characterId.toLowerCase(),
      item_instance_id: cmd.itemInstanceId.toLowerCase(),
      reason_reference: cmd.reasonReference.trim(),
    });

    return this.unitOfWork.executeInTransaction(async (scope) => {
      const charScope = new PgCharacterTransactionScope(this.pool, scope.client);
      const character = await charScope.lockCharacterById(cmd.characterId);
      if (!character) {
        throw new CharacterNotFoundError(cmd.characterId);
      }
      await assertAuthorizedActiveCharacterAndAccount(charScope, character, cmd.principal);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "ItemDestroyed",
        eventVersion: 1,
        source: "carbon.inventory",
        correlationUuid: eventUuid,
        aggregateUuid: cmd.itemInstanceId,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const inst = await scope.lockItemInstanceById(cmd.itemInstanceId);
      if (!inst) {
        throw new ItemInstanceNotFoundError(cmd.itemInstanceId);
      }
      if (claim.status === "duplicate_verified") {
        return { status: "duplicate_idempotent", duplicate: true, data: inst };
      }
      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }
      if (inst.ownerCharacterId !== character.id) {
        throw new ItemOwnershipForbiddenError("Item does not belong to character.");
      }
      if (inst.locationState === "equipped_active") {
        throw new LoadoutInvalidError("Equipped item must be unequipped before destruction.");
      }

      await scope.purgeInactiveLoadoutReferencesForItem(character.id, inst.id);

      const destroyed: ItemInstance = {
        ...inst,
        locationState: "destroyed",
        containerId: null,
        containerSlotIndex: null,
        instanceVersion: inst.instanceVersion + 1,
        updatedAt: now,
      };
      await scope.updateItemInstance(destroyed, inst.instanceVersion);

      await scope.appendLedger({
        operationId: commandKey,
        operationType: "destroy",
        characterId: character.id,
        itemInstanceId: destroyed.id,
        definitionCode: destroyed.definitionCode,
        definitionVersion: destroyed.definitionVersion,
        sourceLocation: `container:${inst.containerId}:slot:${inst.containerSlotIndex}`,
        destinationLocation: "destroyed",
        quantity: 1,
        entityVersion: destroyed.instanceVersion,
        causeReference: cmd.reasonReference.trim(),
      });

      await scope.enqueueOutbox({
        aggregateType: "ItemInstance",
        aggregateId: destroyed.id,
        eventType: "ItemDestroyed",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          item_instance_id: destroyed.id,
          character_id: character.id,
          reason_reference: cmd.reasonReference.trim(),
        },
      });

      return { status: "applied", duplicate: false, data: destroyed };
    });
  }
}
