import type {
  AttributeBlock,
  PrimaryAttributeKey,
} from "../../peoples/domain/character-snapshot-proposal.js";

export const ITEM_CATEGORIES = [
  "weapons",
  "armor",
  "accessories",
  "consumables",
  "materials",
  "quest_items",
  "cosmetics",
  "tools",
  "miscellaneous",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Supports all 22 planned weapon families plus armor, accessory, material, tool,
 * consumable, quest, cosmetic, and miscellaneous subcategories.
 */
export const WEAPON_SUBCATEGORIES = [
  "short_sword",
  "longsword",
  "greatsword_2h",
  "dagger",
  "axe",
  "heavy_axe_2h",
  "hammer",
  "mace",
  "spear",
  "halberd_2h",
  "scythe_2h",
  "katana",
  "staff_2h",
  "wand",
  "grimoire",
  "gauntlets",
  "claws",
  "bow_2h",
  "crossbow_2h",
  "shield",
  "dual_blades_2h",
  "magic_catalyst",
] as const;

export type WeaponSubcategory = (typeof WEAPON_SUBCATEGORIES)[number];

export const COMBAT_EQUIPMENT_SLOTS = [
  "main_hand",
  "off_hand",
  "head",
  "chest",
  "hands",
  "legs",
  "feet",
  "waist",
  "neck",
  "ring_1",
  "ring_2",
  "back",
  "trinket_1",
  "trinket_2",
] as const;

export type CombatEquipmentSlot = (typeof COMBAT_EQUIPMENT_SLOTS)[number];

export const ITEM_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "relic",
] as const;

export type ItemRarityCode = (typeof ITEM_RARITIES)[number];

export const EQUIP_SLOT_POLICIES = [
  "none",
  "single_slot",
  "two_handed",
  "either_hand",
  "ring_any",
  "trinket_any",
  "cosmetic_only",
] as const;

export type EquipSlotPolicy = (typeof EQUIP_SLOT_POLICIES)[number];

export const BINDING_POLICIES = [
  "unbound",
  "bind_on_equip",
  "bind_on_pickup",
  "account_bound",
  "character_bound",
] as const;

export type BindingPolicy = (typeof BINDING_POLICIES)[number];

export const INSTANCE_BINDING_STATES = [
  "unbound",
  "bind_on_equip",
  "account_bound",
  "character_bound",
] as const;

export type InstanceBindingState = (typeof INSTANCE_BINDING_STATES)[number];

export const ITEM_ORIGIN_TYPES = [
  "boss_drop",
  "world_event_reward",
  "dungeon_reward",
  "quest_reward",
  "crafting",
  "gathering",
  "merchant_purchase",
  "exploration",
  "trade",
  "administrative_grant",
  "dev_authorized",
] as const;

export type ItemOriginType = (typeof ITEM_ORIGIN_TYPES)[number];

export type ContainerType = "character_inventory" | "personal_storage";
export type ItemLocationState = "in_container" | "equipped_active" | "destroyed";
export type AffixKind = "prefix" | "suffix" | "special_effect";

export interface RarityDefinition {
  readonly rarityCode: ItemRarityCode;
  readonly displayName: string;
  readonly ordinal: number;
  readonly minExplicitAffixes: number;
  readonly maxExplicitAffixes: number;
  readonly powerBudgetMultiplierBp: number;
  readonly minQualityBp: number;
  readonly maxQualityBp: number;
  readonly allowsSpecialEffects: boolean;
  readonly rulesVersion: number;
}

export interface SpecialEffectDefinition {
  readonly effectCode: string;
  readonly effectVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly triggerCategory: "on_hit" | "on_guard" | "aura" | "threshold" | "stance";
  readonly parameterSchema: Readonly<Record<string, number>>;
  readonly powerBudgetCost: number;
  readonly isEnabled: boolean;
}

export interface AffixDefinition {
  readonly affixCode: string;
  readonly affixVersion: number;
  readonly affixKind: AffixKind;
  readonly poolCode: string;
  readonly displayName: string;
  readonly tier: number;
  readonly weight: number;
  readonly allowedCategories: ReadonlyArray<ItemCategory>;
  readonly minItemLevel: number;
  readonly allowedRarities: ReadonlyArray<ItemRarityCode>;
  readonly attributeKey: PrimaryAttributeKey | null;
  readonly minModifier: number;
  readonly maxModifier: number;
  readonly specialEffectCode: string | null;
  readonly specialEffectParams: Readonly<Record<string, number>> | null;
  readonly powerBudgetCost: number;
  readonly exclusiveGroup: string;
  readonly isEnabled: boolean;
}

export interface ItemDefinition {
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly category: ItemCategory;
  readonly subcategory: string;
  readonly equipSlotPolicy: EquipSlotPolicy;
  readonly allowedSlots: ReadonlyArray<CombatEquipmentSlot>;
  readonly stackable: boolean;
  readonly maxStackSize: number;
  readonly baseItemLevel: number;
  readonly basePowerBudget: number;
  readonly implicitModifiers: Partial<Record<PrimaryAttributeKey, number>>;
  readonly allowedRarities: ReadonlyArray<ItemRarityCode>;
  readonly allowedAffixPools: ReadonlyArray<string>;
  readonly maxDurability: number | null;
  readonly requiredLevel: number;
  readonly requiredAttributes: Partial<Record<PrimaryAttributeKey, number>>;
  readonly bindingPolicy: BindingPolicy;
  readonly craftingTags: ReadonlyArray<string>;
  readonly tradeCategory: "standard" | "restricted" | "non_tradable";
  readonly isEnabled: boolean;
}

export interface ItemGenerationRulesConfig {
  readonly rulesVersion: number;
  readonly code: string;
  readonly levelBudgetPerItemLevel: number;
  readonly qualityBonusMaxBp: number;
  readonly maxPrefixes: number;
  readonly maxSuffixes: number;
  readonly maxSpecialEffects: number;
  readonly emptyPoolPolicy: "allow_fewer_affixes" | "reject_if_below_min";
  readonly maxEquippedAttributeBonusCap: number;
  readonly defaultInventoryCapacity: number;
  readonly maxLoadoutsPerCharacter: number;
}

export interface RolledItemAffix {
  readonly affixCode: string;
  readonly affixVersion: number;
  readonly affixKind: AffixKind;
  readonly exclusiveGroup: string;
  readonly rolledMagnitude: number;
  readonly attributeKey: PrimaryAttributeKey | null;
  readonly specialEffectCode: string | null;
  readonly specialEffectParams: Readonly<Record<string, number>> | null;
  readonly powerBudgetCost: number;
  readonly slotOrdinal: number;
}

export interface ItemInstance {
  readonly id: string;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly ownerAccountId: string;
  readonly ownerCharacterId: string;
  readonly locationState: ItemLocationState;
  readonly containerId: string | null;
  readonly containerSlotIndex: number | null;
  readonly itemLevel: number;
  readonly rarityCode: ItemRarityCode;
  readonly qualityBp: number;
  readonly powerBudgetTotal: number;
  readonly powerBudgetSpent: number;
  readonly implicitAttributes: AttributeBlock;
  readonly generatedAttributes: AttributeBlock;
  readonly affixes: ReadonlyArray<RolledItemAffix>;
  readonly currentDurability: number | null;
  readonly maxDurability: number | null;
  readonly bindingState: InstanceBindingState;
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
  readonly generationRulesVersion: number;
  readonly generationSeedHash: string;
  readonly originType: ItemOriginType;
  readonly originReference: string;
  readonly instanceVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InventoryContainer {
  readonly id: string;
  readonly ownerCharacterId: string;
  readonly containerType: ContainerType;
  readonly capacity: number;
  readonly version: number;
}

export interface InventoryStack {
  readonly id: string;
  readonly containerId: string;
  readonly ownerCharacterId: string;
  readonly containerSlotIndex: number;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly quantity: number;
  readonly qualityBp: number;
  readonly bindingState: "unbound" | "account_bound" | "character_bound";
  readonly boundAccountId: string | null;
  readonly boundCharacterId: string | null;
  readonly stackEquivalenceKey: string;
  readonly version: number;
}

export interface EquippedSlotAssignment {
  readonly slotCode: CombatEquipmentSlot;
  readonly itemInstanceId: string;
  readonly occupiesOffHand: boolean;
}

export interface EquipmentLoadout {
  readonly id: string;
  readonly characterId: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly slots: ReadonlyArray<EquippedSlotAssignment>;
}
