/**
 * CARBON — Peoples, Lineages & Playable Cultures Preparatory Contracts
 *
 * NOTE: ASCENDRA maintains strictly original worldbuilding and identity.
 * Competitive combat attributes MUST NOT be embedded here without coordination
 * with the combat bounded context.
 */

export interface Race {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly isPlayable: boolean;
}

export interface Lineage {
  readonly id: string;
  readonly raceId: string;
  readonly code: string;
  readonly displayName: string;
}

export interface Culture {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly homeRegionId: string | null;
}
