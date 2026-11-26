import {
  CharacterNameInvalidError,
  CharacterNameReservedError,
} from "./errors.js";

export const MIN_CHARACTER_NAME_LENGTH = 3;
export const MAX_CHARACTER_NAME_LENGTH = 24;

/**
 * Matches control characters (\p{Cc}), format/invisible characters (\p{Cf}),
 * surrogates (\p{Cs}), private-use (\p{Co}), plus soft-hyphen, Hangul fillers, and Braille blank.
 */
const INVISIBLE_OR_CONTROL_CHAR_RE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0]/u;

/**
 * Valid NFC display name: Unicode letters separated at most by single internal space,
 * hyphen, or apostrophe. No leading/trailing separators, no consecutive separators, no digits/HTML.
 */
const VALID_DISPLAY_NAME_STRUCTURE_RE = /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u;

const RESERVED_EXACT_CANONICAL_NAMES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "administrador",
  "gm",
  "gamemaster",
  "game master",
  "moderator",
  "moderador",
  "mod",
  "developer",
  "dev",
  "staff",
  "support",
  "suporte",
  "system",
  "sistema",
  "server",
  "ascendra",
  "carbon",
  "neon",
  "owner",
  "root",
  "official",
  "console",
]);

const RESERVED_IMPERSONATION_PREFIXES: ReadonlyArray<string> = [
  "gm ",
  "gm-",
  "gm'",
  "admin ",
  "admin-",
  "dev ",
  "dev-",
  "mod ",
  "mod-",
  "staff ",
  "staff-",
  "system ",
  "official ",
];

const DEFAULT_OFFLINE_BLOCKED_SUBSTRINGS: ReadonlyArray<string> = [
  "sysadmin",
  "moderacao",
];

export interface NameModerationPolicy {
  isAllowed(displayName: string, canonicalName: string): boolean;
}

export class DefaultOfflineNameModerationPolicy implements NameModerationPolicy {
  public isAllowed(_displayName: string, canonicalName: string): boolean {
    if (RESERVED_EXACT_CANONICAL_NAMES.has(canonicalName)) {
      return false;
    }
    for (const prefix of RESERVED_IMPERSONATION_PREFIXES) {
      if (canonicalName.startsWith(prefix)) {
        return false;
      }
    }
    for (const blocked of DEFAULT_OFFLINE_BLOCKED_SUBSTRINGS) {
      if (canonicalName.includes(blocked)) {
        return false;
      }
    }
    return true;
  }
}

export interface NormalizedCharacterName {
  readonly displayName: string;
  readonly canonicalName: string;
}

/**
 * Validates and normalizes a character name:
 * - Rejects control, zero-width, and invisible characters before trimming.
 * - Rejects leading/trailing whitespace and consecutive internal separators.
 * - Preserves `NFC` `displayName` while computing diacritic-stripped lowercase `canonicalName`
 *   for database-level `UNIQUE (canonical_name)` enforcement.
 */
export function validateAndNormalizeCharacterName(
  rawName: string,
  moderationPolicy: NameModerationPolicy = new DefaultOfflineNameModerationPolicy(),
): NormalizedCharacterName {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new CharacterNameInvalidError("Character name cannot be empty.");
  }

  if (INVISIBLE_OR_CONTROL_CHAR_RE.test(rawName)) {
    throw new CharacterNameInvalidError(
      "Character name contains forbidden control or invisible Unicode characters.",
    );
  }

  if (rawName !== rawName.trim()) {
    throw new CharacterNameInvalidError(
      "Character name cannot have leading or trailing whitespace.",
    );
  }

  const displayName = rawName.normalize("NFC");
  const codePointLength = Array.from(displayName).length;
  if (
    codePointLength < MIN_CHARACTER_NAME_LENGTH ||
    codePointLength > MAX_CHARACTER_NAME_LENGTH
  ) {
    throw new CharacterNameInvalidError(
      `Character name must be between ${MIN_CHARACTER_NAME_LENGTH} and ${MAX_CHARACTER_NAME_LENGTH} characters (got ${codePointLength}).`,
    );
  }

  if (!VALID_DISPLAY_NAME_STRUCTURE_RE.test(displayName)) {
    throw new CharacterNameInvalidError(
      "Character name may only contain letters and single internal spaces, hyphens, or apostrophes.",
    );
  }

  // Canonical form: NFKD -> strip combining marks -> NFC -> lowercase
  const canonicalName = displayName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .toLowerCase();

  if (
    canonicalName.length < MIN_CHARACTER_NAME_LENGTH ||
    canonicalName.length > MAX_CHARACTER_NAME_LENGTH
  ) {
    throw new CharacterNameInvalidError(
      "Canonicalized character name falls outside valid length bounds.",
    );
  }

  if (!moderationPolicy.isAllowed(displayName, canonicalName)) {
    throw new CharacterNameReservedError(displayName);
  }

  return { displayName, canonicalName };
}
