import {
  PRIMARY_ATTRIBUTE_KEYS,
  type AttributeBlock,
  type PrimaryAttributeKey,
} from "../../peoples/domain/character-snapshot-proposal.js";
import { createZeroAttributeBlock } from "../../characters/domain/attributes-and-presets.js";
import type { Character } from "../../characters/domain/character.js";
import {
  EquipmentRequirementNotMetError,
  EquipmentSlotIncompatibleError,
  ItemBindingViolationError,
  ItemDefinitionInvalidError,
  StackIncompatibilityError,
  StackOperationInvalidError,
} from "./errors.js";
import {
  BINDING_POLICIES,
  COMBAT_EQUIPMENT_SLOTS,
  EQUIP_SLOT_POLICIES,
  ITEM_CATEGORIES,
  ITEM_RARITIES,
  type BindingPolicy,
  type CombatEquipmentSlot,
  type InstanceBindingState,
  type InventoryStack,
  type ItemDefinition,
  type ItemGenerationRulesConfig,
  type ItemInstance,
} from "./item-types.js";

const CODE_REGEX = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Validates all structural, economic, slot-policy, and stack invariants of an `ItemDefinition`.
 */
export function validateItemDefinition(def: ItemDefinition): void {
  if (!CODE_REGEX.test(def.definitionCode)) {
    throw new ItemDefinitionInvalidError(
      `Invalid definitionCode '${def.definitionCode}'; must match /^[a-z][a-z0-9_]{1,63}$/.`,
    );
  }
  if (!Number.isInteger(def.definitionVersion) || def.definitionVersion < 1) {
    throw new ItemDefinitionInvalidError(
      `Invalid definitionVersion '${String(def.definitionVersion)}' for '${def.definitionCode}'.`,
    );
  }
  if (!def.displayName.trim() || !def.description.trim() || !def.subcategory.trim()) {
    throw new ItemDefinitionInvalidError(
      `ItemDefinition '${def.definitionCode}' requires non-blank displayName, description, and subcategory.`,
    );
  }
  if (!(ITEM_CATEGORIES as ReadonlyArray<string>).includes(def.category)) {
    throw new ItemDefinitionInvalidError(`Invalid item category '${def.category}'.`);
  }
  if (!(EQUIP_SLOT_POLICIES as ReadonlyArray<string>).includes(def.equipSlotPolicy)) {
    throw new ItemDefinitionInvalidError(`Invalid equipSlotPolicy '${def.equipSlotPolicy}'.`);
  }
  if (!(BINDING_POLICIES as ReadonlyArray<string>).includes(def.bindingPolicy)) {
    throw new ItemDefinitionInvalidError(`Invalid bindingPolicy '${def.bindingPolicy}'.`);
  }
  if (
    !Number.isInteger(def.baseItemLevel) ||
    def.baseItemLevel < 1 ||
    def.baseItemLevel > 1000 ||
    !Number.isInteger(def.requiredLevel) ||
    def.requiredLevel < 1 ||
    def.requiredLevel > 1000
  ) {
    throw new ItemDefinitionInvalidError(
      `Invalid level bounds on '${def.definitionCode}': baseItemLevel=${def.baseItemLevel}, requiredLevel=${def.requiredLevel}.`,
    );
  }
  if (!Number.isInteger(def.basePowerBudget) || def.basePowerBudget < 0) {
    throw new ItemDefinitionInvalidError(
      `Invalid basePowerBudget '${String(def.basePowerBudget)}' on '${def.definitionCode}'.`,
    );
  }
  if (
    def.maxDurability !== null &&
    (!Number.isInteger(def.maxDurability) || def.maxDurability <= 0)
  ) {
    throw new ItemDefinitionInvalidError(
      `maxDurability must be null or a positive integer on '${def.definitionCode}'.`,
    );
  }
  if (def.allowedRarities.length === 0) {
    throw new ItemDefinitionInvalidError(
      `ItemDefinition '${def.definitionCode}' must allow at least one rarity.`,
    );
  }
  for (const r of def.allowedRarities) {
    if (!(ITEM_RARITIES as ReadonlyArray<string>).includes(r)) {
      throw new ItemDefinitionInvalidError(`Unknown rarity '${r}' on '${def.definitionCode}'.`);
    }
  }
  for (const s of def.allowedSlots) {
    if (!(COMBAT_EQUIPMENT_SLOTS as ReadonlyArray<string>).includes(s)) {
      throw new ItemDefinitionInvalidError(`Unknown combat slot '${s}' on '${def.definitionCode}'.`);
    }
  }

  if (def.stackable) {
    if (
      !Number.isInteger(def.maxStackSize) ||
      def.maxStackSize < 2 ||
      def.maxStackSize > 9999 ||
      def.equipSlotPolicy !== "none" ||
      def.allowedSlots.length > 0 ||
      def.maxDurability !== null
    ) {
      throw new ItemDefinitionInvalidError(
        `Stackable item '${def.definitionCode}' must have maxStackSize in 2..9999, equipSlotPolicy='none', empty allowedSlots, and null maxDurability.`,
      );
    }
  } else if (def.maxStackSize !== 1) {
    throw new ItemDefinitionInvalidError(
      `Non-stackable item '${def.definitionCode}' must have maxStackSize === 1.`,
    );
  }

  if (def.equipSlotPolicy === "none" || def.equipSlotPolicy === "cosmetic_only") {
    if (def.allowedSlots.length !== 0) {
      throw new ItemDefinitionInvalidError(
        `Policy '${def.equipSlotPolicy}' on '${def.definitionCode}' cannot declare combat allowedSlots.`,
      );
    }
  } else if (def.equipSlotPolicy === "two_handed") {
    if (def.allowedSlots.length !== 1 || def.allowedSlots[0] !== "main_hand") {
      throw new ItemDefinitionInvalidError(
        `Two-handed item '${def.definitionCode}' must declare allowedSlots=['main_hand'].`,
      );
    }
  } else if (def.allowedSlots.length === 0) {
    throw new ItemDefinitionInvalidError(
      `Equippable item '${def.definitionCode}' must declare at least one allowed combat slot.`,
    );
  }
}

/**
 * Validates that `targetSlot` is legal for `definition` and returns whether equipping it
 * also reserves `off_hand` (`occupiesOffHand === true` for two-handed weapons).
 */
export function resolveEquipmentSlotCompatibility(
  definition: ItemDefinition,
  targetSlot: CombatEquipmentSlot,
): { readonly occupiesOffHand: boolean } {
  if (definition.stackable || definition.equipSlotPolicy === "none") {
    throw new EquipmentSlotIncompatibleError(
      `Item '${definition.definitionCode}' (category '${definition.category}') is not equippable.`,
    );
  }
  if (definition.equipSlotPolicy === "cosmetic_only") {
    throw new EquipmentSlotIncompatibleError(
      `Cosmetic item '${definition.definitionCode}' cannot be placed into combat equipment slot '${targetSlot}'.`,
    );
  }

  switch (definition.equipSlotPolicy) {
    case "two_handed":
      if (targetSlot !== "main_hand") {
        throw new EquipmentSlotIncompatibleError(
          `Two-handed weapon '${definition.definitionCode}' must be equipped in 'main_hand', not '${targetSlot}'.`,
        );
      }
      return { occupiesOffHand: true };

    case "either_hand":
      if (targetSlot !== "main_hand" && targetSlot !== "off_hand") {
        throw new EquipmentSlotIncompatibleError(
          `Hand weapon '${definition.definitionCode}' can only be equipped in 'main_hand' or 'off_hand', not '${targetSlot}'.`,
        );
      }
      return { occupiesOffHand: false };

    case "ring_any":
      if (targetSlot !== "ring_1" && targetSlot !== "ring_2") {
        throw new EquipmentSlotIncompatibleError(
          `Ring '${definition.definitionCode}' can only be equipped in 'ring_1' or 'ring_2', not '${targetSlot}'.`,
        );
      }
      return { occupiesOffHand: false };

    case "trinket_any":
      if (targetSlot !== "trinket_1" && targetSlot !== "trinket_2") {
        throw new EquipmentSlotIncompatibleError(
          `Trinket '${definition.definitionCode}' can only be equipped in 'trinket_1' or 'trinket_2', not '${targetSlot}'.`,
        );
      }
      return { occupiesOffHand: false };

    case "single_slot":
      if (!definition.allowedSlots.includes(targetSlot)) {
        throw new EquipmentSlotIncompatibleError(
          `Item '${definition.definitionCode}' is only compatible with [${definition.allowedSlots.join(", ")}], not '${targetSlot}'.`,
        );
      }
      return { occupiesOffHand: false };
  }
}

/**
 * Evaluates whether `character` meets `definition`'s level and attribute requirements.
 *
 * CRITICAL ANTI-CIRCULARITY RULE:
 * Attribute requirements are checked strictly against `character.baseAttributes + character.allocatedAttributes`,
 * NEVER including bonuses from currently equipped items!
 */
export function checkIntrinsicCharacterEligibility(
  character: Character,
  definition: ItemDefinition,
  instance: ItemInstance,
): { readonly eligible: boolean; readonly failureReason: string | null } {
  if (instance.currentDurability !== null && instance.currentDurability <= 0) {
    return {
      eligible: false,
      failureReason: `Item '${instance.id}' (${definition.definitionCode}) has 0 durability (broken) and cannot provide active combat equipment properties.`,
    };
  }

  if (character.level < definition.requiredLevel) {
    return {
      eligible: false,
      failureReason: `Character level ${character.level} is below required level ${definition.requiredLevel} for '${definition.definitionCode}'.`,
    };
  }

  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const req = definition.requiredAttributes[key];
    if (req !== undefined && req > 0) {
      const intrinsic = character.baseAttributes[key] + character.allocatedAttributes[key];
      if (intrinsic < req) {
        return {
          eligible: false,
          failureReason: `Intrinsic '${key}' (${intrinsic}) is below required ${req} for '${definition.definitionCode}' (equipment bonuses cannot self-satisfy requirements).`,
        };
      }
    }
  }

  return { eligible: true, failureReason: null };
}

export function assertCharacterCanEquip(
  character: Character,
  definition: ItemDefinition,
  instance: ItemInstance,
): void {
  const check = checkIntrinsicCharacterEligibility(character, definition, instance);
  if (!check.eligible) {
    throw new EquipmentRequirementNotMetError(check.failureReason ?? "Equipment requirements not met.");
  }
}

/**
 * Computes aggregated equipment attribute modifiers for active equipped items:
 * - Excludes broken items (`currentDurability === 0`).
 * - Excludes items whose intrinsic `Base + Allocated` requirements are no longer met (e.g. after respec).
 * - Clamps total equipment bonus per attribute to `rules.maxEquippedAttributeBonusCap`.
 */
export function computeActiveEquipmentModifiers(params: {
  readonly character: Character;
  readonly equippedEntries: ReadonlyArray<{
    readonly instance: ItemInstance;
    readonly definition: ItemDefinition;
  }>;
  readonly rules: ItemGenerationRulesConfig;
}): {
  readonly equipmentModifiers: AttributeBlock;
  readonly aggregatedEffectiveAttributes: AttributeBlock;
  readonly suppressedInstanceIds: ReadonlyArray<string>;
} {
  const bonus: Record<PrimaryAttributeKey, number> = {
    ...createZeroAttributeBlock(),
  };
  const suppressedInstanceIds: string[] = [];

  for (const entry of params.equippedEntries) {
    const check = checkIntrinsicCharacterEligibility(
      params.character,
      entry.definition,
      entry.instance,
    );
    if (!check.eligible) {
      suppressedInstanceIds.push(entry.instance.id);
      continue;
    }

    for (const key of PRIMARY_ATTRIBUTE_KEYS) {
      bonus[key] +=
        entry.instance.implicitAttributes[key] + entry.instance.generatedAttributes[key];
    }
  }

  const effective: Record<PrimaryAttributeKey, number> = {
    ...createZeroAttributeBlock(),
  };
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    bonus[key] = Math.min(bonus[key], params.rules.maxEquippedAttributeBonusCap);
    effective[key] =
      params.character.baseAttributes[key] +
      params.character.allocatedAttributes[key] +
      bonus[key];
  }

  return {
    equipmentModifiers: bonus,
    aggregatedEffectiveAttributes: effective,
    suppressedInstanceIds,
  };
}

export function resolveInitialBindingOnGrant(params: {
  readonly policy: BindingPolicy;
  readonly recipientAccountId: string;
  readonly recipientCharacterId: string;
}): {
  readonly bindingState: InstanceBindingState;
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
} {
  switch (params.policy) {
    case "unbound":
      return { bindingState: "unbound", boundAccountId: null, boundCharacterId: null };
    case "bind_on_equip":
      return { bindingState: "bind_on_equip", boundAccountId: null, boundCharacterId: null };
    case "account_bound":
      return {
        bindingState: "account_bound",
        boundAccountId: params.recipientAccountId,
        boundCharacterId: null,
      };
    case "bind_on_pickup":
    case "character_bound":
      return {
        bindingState: "character_bound",
        boundAccountId: params.recipientAccountId,
        boundCharacterId: params.recipientCharacterId,
      };
  }
}

export function resolveBindingAfterEquip(params: {
  readonly currentBindingState: InstanceBindingState;
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
  readonly equippingAccountId: string;
  readonly equippingCharacterId: string;
}): {
  readonly bindingState: InstanceBindingState;
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
  readonly transitioned: boolean;
} {
  if (params.currentBindingState === "bind_on_equip") {
    return {
      bindingState: "character_bound",
      boundAccountId: params.equippingAccountId,
      boundCharacterId: params.equippingCharacterId,
      transitioned: true,
    };
  }
  return {
    bindingState: params.currentBindingState,
    boundAccountId: params.boundAccountId,
    boundCharacterId: params.boundCharacterId,
    transitioned: false,
  };
}

export function assertInstanceTransferPermitted(params: {
  readonly instance: ItemInstance;
  readonly fromCharacter: Character;
  readonly toCharacter: Character;
}): void {
  if (params.fromCharacter.id === params.toCharacter.id) {
    throw new ItemBindingViolationError("Source and destination character cannot be identical.");
  }
  if (params.instance.locationState === "equipped_active") {
    throw new ItemBindingViolationError(
      `Equipped item '${params.instance.id}' must be unequipped before transfer.`,
    );
  }
  if (params.instance.locationState !== "in_container") {
    throw new ItemBindingViolationError(
      `Item '${params.instance.id}' in location '${params.instance.locationState}' is not available in inventory for transfer.`,
    );
  }
  if (params.instance.bindingState === "character_bound") {
    throw new ItemBindingViolationError(
      `Item '${params.instance.id}' is character_bound to '${params.instance.boundCharacterId}' and cannot be transferred.`,
    );
  }
  if (params.instance.bindingState === "account_bound") {
    if (params.fromCharacter.accountId.toLowerCase() !== params.toCharacter.accountId.toLowerCase()) {
      throw new ItemBindingViolationError(
        `Item '${params.instance.id}' is account_bound to account '${params.instance.boundAccountId}' and cannot cross accounts.`,
      );
    }
  }
}

export function buildStackEquivalenceKey(params: {
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly qualityBp: number;
  readonly bindingState: "unbound" | "account_bound" | "character_bound";
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
}): string {
  const boundTarget =
    params.bindingState === "character_bound"
      ? params.boundCharacterId ?? ""
      : params.bindingState === "account_bound"
        ? params.boundAccountId ?? ""
        : "none";
  return `${params.definitionCode}:v${params.definitionVersion}:q${params.qualityBp}:b_${params.bindingState}:${boundTarget}`;
}

export function validateStackMergeQuantities(params: {
  readonly sourceStack: InventoryStack;
  readonly targetStack: InventoryStack;
  readonly definition: ItemDefinition;
  readonly requestedQuantity?: number | undefined;
}): {
  readonly movedQuantity: number;
  readonly nextSourceQuantity: number;
  readonly nextTargetQuantity: number;
} {
  if (params.sourceStack.id === params.targetStack.id) {
    throw new StackOperationInvalidError("Cannot merge a stack into itself.");
  }
  if (params.sourceStack.stackEquivalenceKey !== params.targetStack.stackEquivalenceKey) {
    throw new StackIncompatibilityError(
      `Stacks '${params.sourceStack.id}' and '${params.targetStack.id}' have incompatible equivalence keys and cannot merge.`,
    );
  }

  const requested = params.requestedQuantity ?? params.sourceStack.quantity;
  if (!Number.isInteger(requested) || requested <= 0 || requested > params.sourceStack.quantity) {
    throw new StackOperationInvalidError(
      `Invalid merge quantity ${String(requested)} (source has ${params.sourceStack.quantity}).`,
    );
  }

  const roomInTarget = params.definition.maxStackSize - params.targetStack.quantity;
  if (roomInTarget <= 0 || requested > roomInTarget) {
    throw new StackOperationInvalidError(
      `Target stack (${params.targetStack.quantity}/${params.definition.maxStackSize}) cannot fit ${requested} units.`,
    );
  }

  const nextSourceQuantity = params.sourceStack.quantity - requested;
  const nextTargetQuantity = params.targetStack.quantity + requested;

  // Strict conservation check
  if (
    nextSourceQuantity + nextTargetQuantity !==
    params.sourceStack.quantity + params.targetStack.quantity
  ) {
    throw new StackOperationInvalidError("Stack quantity conservation invariant violated.");
  }

  return {
    movedQuantity: requested,
    nextSourceQuantity,
    nextTargetQuantity,
  };
}
