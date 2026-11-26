import type { CustomizationProfile } from "./people-contracts.js";

export const APPEARANCE_CATALOG_VERSION = 1;

const SAFE_OPTION_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const FORBIDDEN_UNSAFE_INPUT_RE = /(https?:\/\/|javascript:|data:|<|>|\/|\\|\.\.|;)/i;

export const GLOBAL_HAIR_STYLES = [
  "short_cropped",
  "braided_crown",
  "windswept_long",
  "topknot_warrior",
  "shaved_sides",
  "wild_mane",
  "coiled_locks",
] as const;

export const GLOBAL_HAIR_COLORS = [
  "raven_black",
  "ash_brown",
  "iron_grey",
  "copper_red",
  "sun_gold",
  "frost_white",
  "midnight_blue",
] as const;

export const GLOBAL_EYE_STYLES = [
  "almond_sharp",
  "round_bright",
  "slit_draconic",
  "deep_set",
  "fierce_narrow",
] as const;

export const GLOBAL_EYE_COLORS = [
  "amber_gold",
  "emerald_green",
  "slate_blue",
  "crimson_ember",
  "obsidian_dark",
  "violet_mist",
  "silver_pale",
] as const;

export const GLOBAL_FACIAL_FEATURES = [
  "clean_visage",
  "weathered_lines",
  "freckled",
  "sharp_cheekbones",
  "broad_jaw",
  "ritual_paint",
] as const;

export const GLOBAL_BEARD_STYLES = [
  "stubble_light",
  "full_trimmed",
  "forgemaster_braids",
  "twin_forks",
  "goatee_sharp",
] as const;

export const GLOBAL_TATTOO_CODES = [
  "ashvale_spiral",
  "iron_runes",
  "lunar_crescent",
  "steppe_windmarks",
  "forge_brands",
] as const;

export const GLOBAL_SCAR_CODES = [
  "left_brow_slash",
  "jawline_nick",
  "cross_cheek",
  "claw_shoulders",
] as const;

export const GLOBAL_COSMETIC_ACCESSORIES = [
  "bronze_ear_ring",
  "leather_headband",
  "scholar_spectacles",
  "bone_tusk_ring",
  "amber_hairpin",
] as const;

export const GLOBAL_VOICE_PROFILES = [
  "voice_calm_low",
  "voice_calm_high",
  "voice_fierce_raspy",
  "voice_resonant_warm",
  "voice_measured_clear",
] as const;

export interface CharacterAppearanceInput {
  readonly bodyPreset: string;
  readonly skinTone: string;
  readonly hairStyle?: string | null | undefined;
  readonly hairColor?: string | null | undefined;
  readonly eyeStyle: string;
  readonly eyeColor: string;
  readonly facialFeatures?: string | null | undefined;
  readonly beardStyle?: string | null | undefined;
  readonly earStyle?: string | null | undefined;
  readonly hornStyle?: string | null | undefined;
  readonly tailStyle?: string | null | undefined;
  readonly scalePattern?: string | null | undefined;
  readonly tattoos?: ReadonlyArray<string> | undefined;
  readonly scars?: ReadonlyArray<string> | undefined;
  readonly cosmeticAccessories?: ReadonlyArray<string> | undefined;
  readonly voiceProfile?: string | null | undefined;
}

export interface ValidatedCharacterAppearance {
  readonly appearanceCatalogVersion: number;
  readonly bodyPreset: string;
  readonly skinTone: string;
  readonly hairStyle: string | null;
  readonly hairColor: string | null;
  readonly eyeStyle: string;
  readonly eyeColor: string;
  readonly facialFeatures: string | null;
  readonly beardStyle: string | null;
  readonly earStyle: string | null;
  readonly hornStyle: string | null;
  readonly tailStyle: string | null;
  readonly scalePattern: string | null;
  readonly tattoos: ReadonlyArray<string>;
  readonly scars: ReadonlyArray<string>;
  readonly cosmeticAccessories: ReadonlyArray<string>;
  readonly voiceProfile: string | null;
}

export class IncompatibleAppearanceError extends Error {
  public readonly code = "INCOMPATIBLE_CHARACTER_APPEARANCE";
  public readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`Invalid or incompatible character appearance: ${issues.join("; ")}`);
    this.name = "IncompatibleAppearanceError";
    this.issues = issues;
  }
}

function checkToken(
  fieldName: string,
  value: string,
  allowed: ReadonlyArray<string>,
  issues: string[],
): string {
  if (FORBIDDEN_UNSAFE_INPUT_RE.test(value) || !SAFE_OPTION_TOKEN_RE.test(value)) {
    issues.push(
      `${fieldName}: rejected unsafe or malformed cosmetic token (URLs, scripts, HTML, and file paths are forbidden).`,
    );
    return value;
  }
  if (!allowed.includes(value)) {
    issues.push(`${fieldName}: option '${value}' is not permitted for this catalog/people.`);
  }
  return value;
}

function checkTokenList(
  fieldName: string,
  values: ReadonlyArray<string> | undefined,
  allowed: ReadonlyArray<string>,
  maxItems: number,
  issues: string[],
): ReadonlyArray<string> {
  if (!values || values.length === 0) {
    return [];
  }
  if (values.length > maxItems) {
    issues.push(`${fieldName}: exceeds maximum of ${maxItems} selections.`);
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of values) {
    checkToken(fieldName, item, allowed, issues);
    if (seen.has(item)) {
      issues.push(`${fieldName}: duplicate option '${item}'.`);
      continue;
    }
    seen.add(item);
    normalized.push(item);
  }
  return normalized.sort();
}

/**
 * Strictly validates modular sprite appearance selections against the versioned global catalog
 * and the selected people's `CustomizationProfile`. Never modifies hitboxes or combat stats.
 */
export function validateCharacterAppearance(
  input: CharacterAppearanceInput,
  profile: CustomizationProfile,
): ValidatedCharacterAppearance {
  const issues: string[] = [];

  const bodyPreset = checkToken("bodyPreset", input.bodyPreset, profile.allowedBodyPresets, issues);
  const skinTone = checkToken("skinTone", input.skinTone, profile.allowedSkinTones, issues);
  const eyeStyle = checkToken("eyeStyle", input.eyeStyle, GLOBAL_EYE_STYLES, issues);
  const eyeColor = checkToken("eyeColor", input.eyeColor, GLOBAL_EYE_COLORS, issues);

  let hairStyle: string | null = input.hairStyle ?? null;
  let hairColor: string | null = input.hairColor ?? null;
  if (!profile.supportsHair) {
    if (hairStyle !== null || hairColor !== null) {
      issues.push("hairStyle/hairColor: not supported by selected people's customization profile.");
    }
    hairStyle = null;
    hairColor = null;
  } else {
    if (hairStyle !== null) {
      checkToken("hairStyle", hairStyle, GLOBAL_HAIR_STYLES, issues);
      if (hairColor === null) {
        issues.push("hairColor: required whenever hairStyle is selected.");
      }
    }
    if (hairColor !== null) {
      checkToken("hairColor", hairColor, GLOBAL_HAIR_COLORS, issues);
      if (hairStyle === null) {
        issues.push("hairStyle: required whenever hairColor is selected.");
      }
    }
  }

  let beardStyle: string | null = input.beardStyle ?? null;
  if (beardStyle !== null) {
    if (!profile.supportsBeard) {
      issues.push("beardStyle: not supported by selected people's customization profile.");
    } else {
      checkToken("beardStyle", beardStyle, GLOBAL_BEARD_STYLES, issues);
    }
  }

  let facialFeatures: string | null = input.facialFeatures ?? null;
  if (facialFeatures !== null) {
    checkToken("facialFeatures", facialFeatures, GLOBAL_FACIAL_FEATURES, issues);
  }

  let earStyle: string | null = input.earStyle ?? null;
  if (earStyle !== null) {
    checkToken("earStyle", earStyle, profile.allowedEarStyles, issues);
  }

  let hornStyle: string | null = input.hornStyle ?? null;
  if (hornStyle !== null) {
    if (!profile.supportsHorns) {
      issues.push("hornStyle: selected people cannot equip horn styles.");
    } else {
      checkToken("hornStyle", hornStyle, profile.allowedHornStyles, issues);
    }
  }

  let tailStyle: string | null = input.tailStyle ?? null;
  if (tailStyle !== null) {
    if (!profile.supportsTail) {
      issues.push("tailStyle: selected people cannot equip tail styles.");
    } else {
      checkToken("tailStyle", tailStyle, profile.allowedTailStyles, issues);
    }
  }

  let scalePattern: string | null = input.scalePattern ?? null;
  if (profile.requiresScales && scalePattern === null) {
    issues.push("scalePattern: required for scaled peoples (e.g. draconians).");
  }
  if (scalePattern !== null) {
    if (!profile.supportsScales) {
      issues.push("scalePattern: selected people does not support scale patterns.");
    } else {
      checkToken("scalePattern", scalePattern, profile.allowedScalePatterns, issues);
    }
  }

  const tattoos = checkTokenList("tattoos", input.tattoos, GLOBAL_TATTOO_CODES, 3, issues);
  const scars = checkTokenList("scars", input.scars, GLOBAL_SCAR_CODES, 3, issues);
  const cosmeticAccessories = checkTokenList(
    "cosmeticAccessories",
    input.cosmeticAccessories,
    GLOBAL_COSMETIC_ACCESSORIES,
    4,
    issues,
  );

  let voiceProfile: string | null = input.voiceProfile ?? null;
  if (voiceProfile !== null) {
    checkToken("voiceProfile", voiceProfile, GLOBAL_VOICE_PROFILES, issues);
  }

  if (issues.length > 0) {
    throw new IncompatibleAppearanceError(issues);
  }

  return {
    appearanceCatalogVersion: APPEARANCE_CATALOG_VERSION,
    bodyPreset,
    skinTone,
    hairStyle,
    hairColor,
    eyeStyle,
    eyeColor,
    facialFeatures,
    beardStyle,
    earStyle,
    hornStyle,
    tailStyle,
    scalePattern,
    tattoos,
    scars,
    cosmeticAccessories,
    voiceProfile,
  };
}
