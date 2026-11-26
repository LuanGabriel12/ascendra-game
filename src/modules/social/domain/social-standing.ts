/**
 * CARBON — Social Standing Preparatory Contracts
 *
 * NOTE: Reputation, Bounty, Fame, and CriminalRecord are distinct domain concepts
 * and MUST NOT be collapsed into a single numeric score.
 * Formulas and thresholds remain open for future design sessions.
 */

export interface ReputationStanding {
  readonly playerId: string;
  readonly factionId: string;
  readonly value: number;
  readonly updatedAt: Date;
}

/**
 * Signed bounty standing:
 * - score > 0: recognized positive standing / heroic warrant
 * - score < 0: hostile / criminal bounty target
 */
export interface BountyStanding {
  readonly playerId: string;
  readonly regionId: string;
  readonly signedAmount: bigint;
  readonly updatedAt: Date;
}

export interface FameStanding {
  readonly playerId: string;
  readonly renownPoints: bigint;
  readonly updatedAt: Date;
}

export interface CriminalRecordEntry {
  readonly id: string;
  readonly playerId: string;
  readonly settlementId: string | null;
  readonly factionId: string | null;
  readonly offenseCode: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}
