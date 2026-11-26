/**
 * CARBON — Titles Preparatory Contracts
 *
 * NOTE: Condition evaluation engines and hardcoded title catalogs are out of scope
 * for Session 01.
 */

export type TitleCategory =
  | "achievement"
  | "reputation"
  | "historical"
  | "exclusive"
  | "criminal"
  | "heroic";

export type TitleRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export interface TitleDefinition {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly category: TitleCategory;
  readonly rarity: TitleRarity;
  readonly requirements: Readonly<Record<string, unknown>>;
}

export interface PlayerTitleUnlock {
  readonly id: string;
  readonly playerId: string;
  readonly titleId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly unlockedAt: Date;
}

export interface TitleHistoryEntry {
  readonly id: string;
  readonly playerId: string;
  readonly titleId: string;
  readonly action: "unlocked" | "revoked" | "equipped" | "unequipped";
  readonly correlationId: string;
  readonly recordedAt: Date;
}
