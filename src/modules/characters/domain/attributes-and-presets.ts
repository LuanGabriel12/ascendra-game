import {
  PRIMARY_ATTRIBUTE_KEYS,
  type AttributeBlock,
  type PrimaryAttributeKey,
  type SecondaryResourcePreview,
} from "../../peoples/domain/character-snapshot-proposal.js";
import { AttributeAllocationInvalidError } from "./errors.js";

export interface ProgressionRulesConfig {
  readonly rulesVersion: number;
  readonly code: string;
  readonly basePointsPerAttribute: number;
  readonly creationAllocatablePoints: number;
  readonly pointsPerLevel: number;
  readonly maxEffectiveBeforeEquipment: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly xpCurveType: "quadratic_polynomial_v1";
  readonly xpCurveBase: bigint;
  readonly xpCurveLinear: bigint;
  readonly xpCurveQuadratic: bigint;
  readonly maxCharactersPerAccount: number;
}

/**
 * Provisional development ruleset (v1):
 * - 10 attributes * 5 base = 50 base points
 * - 50 creation allocatable points = 100 initial total budget
 * - +2 points per level up (Lv 1 -> Lv 100 grants +198 points => 298 total <= 10 * 30 cap!)
 * - Max 30 per effective attribute before equipment
 */
export const DEFAULT_DEV_PROGRESSION_RULES_V1: ProgressionRulesConfig = {
  rulesVersion: 1,
  code: "dev_standard_v1",
  basePointsPerAttribute: 5,
  creationAllocatablePoints: 50,
  pointsPerLevel: 2,
  maxEffectiveBeforeEquipment: 30,
  minLevel: 1,
  maxLevel: 100,
  xpCurveType: "quadratic_polynomial_v1",
  xpCurveBase: 100n,
  xpCurveLinear: 50n,
  xpCurveQuadratic: 25n,
  maxCharactersPerAccount: 6,
};

export type PartialAttributeMap = Partial<Record<PrimaryAttributeKey, number>>;

const KNOWN_KEY_SET: ReadonlySet<string> = new Set<string>(PRIMARY_ATTRIBUTE_KEYS);

export function createUniformAttributeBlock(valuePerAttribute: number): AttributeBlock {
  return {
    strength: valuePerAttribute,
    fortitude: valuePerAttribute,
    vigor: valuePerAttribute,
    agility: valuePerAttribute,
    dexterity: valuePerAttribute,
    intelligence: valuePerAttribute,
    wisdom: valuePerAttribute,
    determination: valuePerAttribute,
    luck: valuePerAttribute,
    charisma: valuePerAttribute,
  };
}

export function createZeroAttributeBlock(): AttributeBlock {
  return createUniformAttributeBlock(0);
}

export function sumAttributeBlock(block: AttributeBlock): number {
  let total = 0;
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    total += block[key];
  }
  return total;
}

export function computeEffectiveAttributesBeforeEquipment(
  base: AttributeBlock,
  allocated: AttributeBlock,
): AttributeBlock {
  return {
    strength: base.strength + allocated.strength,
    fortitude: base.fortitude + allocated.fortitude,
    vigor: base.vigor + allocated.vigor,
    agility: base.agility + allocated.agility,
    dexterity: base.dexterity + allocated.dexterity,
    intelligence: base.intelligence + allocated.intelligence,
    wisdom: base.wisdom + allocated.wisdom,
    determination: base.determination + allocated.determination,
    luck: base.luck + allocated.luck,
    charisma: base.charisma + allocated.charisma,
  };
}

/**
 * Validates an incoming raw object representing non-negative integer deltas or initial allocations
 * across the 10 primary attributes. Rejects unknown keys, fractional numbers, and negatives.
 */
export function parseStrictAttributeDeltaObject(
  raw: Record<string, unknown>,
  requirePositiveTotal: boolean,
): AttributeBlock {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AttributeAllocationInvalidError("Attribute map must be a non-null plain object.");
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEY_SET.has(key)) {
      throw new AttributeAllocationInvalidError(
        `Unknown attribute '${key}'; allowed attributes are [${PRIMARY_ATTRIBUTE_KEYS.join(", ")}].`,
      );
    }
  }

  const mutable: Record<PrimaryAttributeKey, number> = {
    strength: 0,
    fortitude: 0,
    vigor: 0,
    agility: 0,
    dexterity: 0,
    intelligence: 0,
    wisdom: 0,
    determination: 0,
    luck: 0,
    charisma: 0,
  };

  let sum = 0;
  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const val = raw[key];
    if (val === undefined) {
      continue;
    }
    if (typeof val !== "number" || !Number.isInteger(val) || !Number.isSafeInteger(val)) {
      throw new AttributeAllocationInvalidError(
        `Attribute '${key}' must be an exact integer, got '${String(val)}'.`,
      );
    }
    if (val < 0) {
      throw new AttributeAllocationInvalidError(
        `Attribute '${key}' allocation cannot be negative (got ${val}).`,
      );
    }
    mutable[key] = val;
    sum += val;
  }

  if (requirePositiveTotal && sum <= 0) {
    throw new AttributeAllocationInvalidError(
      "Attribute allocation delta must distribute at least 1 point.",
    );
  }

  return mutable;
}

export function applyAndValidateAttributeAllocation(params: {
  readonly baseAttributes: AttributeBlock;
  readonly currentAllocated: AttributeBlock;
  readonly deltaToAdd: AttributeBlock;
  readonly currentUnspentPoints: number;
  readonly earnedAttributePoints: number;
  readonly rules: ProgressionRulesConfig;
}): {
  readonly nextAllocated: AttributeBlock;
  readonly nextAllocatedTotal: number;
  readonly nextUnspentPoints: number;
} {
  const deltaSum = sumAttributeBlock(params.deltaToAdd);
  if (deltaSum > params.currentUnspentPoints) {
    throw new AttributeAllocationInvalidError(
      `Cannot allocate ${deltaSum} points; only ${params.currentUnspentPoints} unspent attribute points available.`,
    );
  }

  const nextAllocated: Record<PrimaryAttributeKey, number> = {
    strength: 0,
    fortitude: 0,
    vigor: 0,
    agility: 0,
    dexterity: 0,
    intelligence: 0,
    wisdom: 0,
    determination: 0,
    luck: 0,
    charisma: 0,
  };

  for (const key of PRIMARY_ATTRIBUTE_KEYS) {
    const nextAllocVal = params.currentAllocated[key] + params.deltaToAdd[key];
    const effectiveBeforeEquip = params.baseAttributes[key] + nextAllocVal;
    if (effectiveBeforeEquip > params.rules.maxEffectiveBeforeEquipment) {
      throw new AttributeAllocationInvalidError(
        `Attribute '${key}' would reach ${effectiveBeforeEquip}, exceeding the pre-equipment cap of ${params.rules.maxEffectiveBeforeEquipment}.`,
      );
    }
    nextAllocated[key] = nextAllocVal;
  }

  const nextAllocatedTotal = sumAttributeBlock(nextAllocated);
  const nextUnspentPoints = params.currentUnspentPoints - deltaSum;

  if (nextAllocatedTotal + nextUnspentPoints !== params.earnedAttributePoints) {
    throw new AttributeAllocationInvalidError(
      `Attribute budget conservation violated: allocated(${nextAllocatedTotal}) + unspent(${nextUnspentPoints}) != earned(${params.earnedAttributePoints}).`,
    );
  }

  return {
    nextAllocated,
    nextAllocatedTotal,
    nextUnspentPoints,
  };
}

export interface ArchetypePresetDefinition {
  readonly presetCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly allocatedAttributes: AttributeBlock;
}

/**
 * Optional emergent build presets for testing and player convenience.
 * Every preset strictly obeys the exact same 50-point creation budget and 30-point cap
 * with zero extra hidden bonuses and zero race/class lock-in.
 */
export const BUILD_ARCHETYPE_PRESETS: Readonly<Record<string, ArchetypePresetDefinition>> = {
  berserker: {
    presetCode: "berserker",
    displayName: "Berserker",
    description: "Foco emergente em Força e Vigor para pressão física sustentada.",
    allocatedAttributes: {
      strength: 20,
      fortitude: 12,
      vigor: 18,
      agility: 0,
      dexterity: 0,
      intelligence: 0,
      wisdom: 0,
      determination: 0,
      luck: 0,
      charisma: 0,
    },
  },
  paladin: {
    presetCode: "paladin",
    displayName: "Paladino",
    description: "Foco emergente em Fortitude, Sabedoria e Determinação.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 18,
      vigor: 0,
      agility: 0,
      dexterity: 0,
      intelligence: 0,
      wisdom: 18,
      determination: 14,
      luck: 0,
      charisma: 0,
    },
  },
  assassin: {
    presetCode: "assassin",
    displayName: "Assassino",
    description: "Foco emergente em Agilidade, Destreza e precisão tática.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 0,
      vigor: 0,
      agility: 20,
      dexterity: 20,
      intelligence: 0,
      wisdom: 0,
      determination: 0,
      luck: 10,
      charisma: 0,
    },
  },
  arcanist: {
    presetCode: "arcanist",
    displayName: "Arcanista",
    description: "Foco emergente em Inteligência e Sabedoria.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 0,
      vigor: 0,
      agility: 0,
      dexterity: 0,
      intelligence: 22,
      wisdom: 18,
      determination: 10,
      luck: 0,
      charisma: 0,
    },
  },
  necromancer: {
    presetCode: "necromancer",
    displayName: "Necromante",
    description: "Foco emergente em Inteligência e Determinação.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 0,
      vigor: 0,
      agility: 0,
      dexterity: 0,
      intelligence: 20,
      wisdom: 10,
      determination: 20,
      luck: 0,
      charisma: 0,
    },
  },
  monk: {
    presetCode: "monk",
    displayName: "Monge",
    description: "Foco emergente em Vigor, Determinação e Agilidade.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 0,
      vigor: 18,
      agility: 14,
      dexterity: 0,
      intelligence: 0,
      wisdom: 0,
      determination: 18,
      luck: 0,
      charisma: 0,
    },
  },
  blacksmith: {
    presetCode: "blacksmith",
    displayName: "Ferreiro",
    description: "Foco emergente em Força, Destreza e Sorte de fabricação.",
    allocatedAttributes: {
      strength: 18,
      fortitude: 0,
      vigor: 0,
      agility: 0,
      dexterity: 18,
      intelligence: 0,
      wisdom: 0,
      determination: 0,
      luck: 14,
      charisma: 0,
    },
  },
  merchant: {
    presetCode: "merchant",
    displayName: "Mercador",
    description: "Foco emergente em Carisma e Sorte para comércio e diplomacia.",
    allocatedAttributes: {
      strength: 0,
      fortitude: 0,
      vigor: 0,
      agility: 0,
      dexterity: 0,
      intelligence: 0,
      wisdom: 8,
      determination: 0,
      luck: 20,
      charisma: 22,
    },
  },
  arcane_knight: {
    presetCode: "arcane_knight",
    displayName: "Cavaleiro Arcano",
    description: "Foco híbrido emergente em Força, Inteligência e Fortitude.",
    allocatedAttributes: {
      strength: 18,
      fortitude: 14,
      vigor: 0,
      agility: 0,
      dexterity: 0,
      intelligence: 18,
      wisdom: 0,
      determination: 0,
      luck: 0,
      charisma: 0,
    },
  },
};

/**
 * Isolated, versioned development preview for secondary resource capacities.
 * NEVER persisted as authoritative SQL truth; final combat scaling belongs to joint NEON contracts.
 */
export function computeDevPreviewSecondaryResources(
  effectiveAttributes: AttributeBlock,
): SecondaryResourcePreview {
  return {
    rulesProfile: "dev_preview_v1",
    maxHealth: 200 + effectiveAttributes.fortitude * 18 + effectiveAttributes.strength * 4,
    maxMana: 80 + effectiveAttributes.wisdom * 14 + effectiveAttributes.intelligence * 8,
    maxStamina: 100 + effectiveAttributes.vigor * 12 + effectiveAttributes.agility * 4,
    maxGuard: 60 + effectiveAttributes.fortitude * 8 + effectiveAttributes.determination * 8,
    maxFocus: 50 + effectiveAttributes.determination * 6 + effectiveAttributes.charisma * 4,
  };
}
