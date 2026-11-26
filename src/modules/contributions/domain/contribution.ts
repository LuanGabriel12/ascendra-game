import {
  MAX_INT64,
  MAX_UINT64,
  MIN_UINT64,
} from "../../../shared/contracts/int64-wire.js";
import { InvalidContributionError } from "./errors.js";

export const TERMINAL_INVASION_OUTCOMES = ["Defended", "Captured"] as const;
export type TerminalInvasionOutcome = (typeof TERMINAL_INVASION_OUTCOMES)[number];

export interface GameplayContributionProps {
  readonly id: string;
  readonly processedEventId: string;
  readonly externalEventId: string;
  readonly contractVersion: number;
  readonly simulationId: string;
  readonly invasionId: string;
  readonly settlementRef: string;
  readonly resolvedSettlementId: string | null;
  readonly playerId: string;
  readonly tick: bigint;
  readonly damage: bigint;
  readonly support: bigint;
  readonly objectives: bigint;
  readonly eligible: boolean;
  readonly outcome: TerminalInvasionOutcome;
  readonly payloadFingerprint: string;
  readonly receivedAt: Date;
  readonly recordedAt: Date;
}

/**
 * Authoritative record of a player's validated gameplay participation in a resolved invasion.
 * Represents an immutable gameplay fact from NEON — NOT an authorization for arbitrary currency,
 * item, title, or reputation grants.
 */
export class GameplayContribution {
  public readonly id: string;
  public readonly processedEventId: string;
  public readonly externalEventId: string;
  public readonly contractVersion: number;
  public readonly simulationId: string;
  public readonly invasionId: string;
  public readonly settlementRef: string;
  public readonly resolvedSettlementId: string | null;
  public readonly playerId: string;
  public readonly tick: bigint;
  public readonly damage: bigint;
  public readonly support: bigint;
  public readonly objectives: bigint;
  public readonly eligible: boolean;
  public readonly outcome: TerminalInvasionOutcome;
  public readonly payloadFingerprint: string;
  public readonly receivedAt: Date;
  public readonly recordedAt: Date;

  constructor(props: GameplayContributionProps) {
    if (!props.externalEventId.trim() || props.externalEventId.length > 255) {
      throw new InvalidContributionError("externalEventId must be 1..255 non-blank characters.");
    }
    if (!props.simulationId.trim() || props.simulationId.length > 128) {
      throw new InvalidContributionError("simulationId must be 1..128 non-blank characters.");
    }
    if (!props.invasionId.trim() || props.invasionId.length > 128) {
      throw new InvalidContributionError("invasionId must be 1..128 non-blank characters.");
    }
    if (!props.settlementRef.trim() || props.settlementRef.length > 128) {
      throw new InvalidContributionError("settlementRef must be 1..128 non-blank characters.");
    }
    if (!props.playerId.trim() || props.playerId.length > 128) {
      throw new InvalidContributionError("playerId must be 1..128 non-blank characters.");
    }
    if (!Number.isInteger(props.contractVersion) || props.contractVersion < 1) {
      throw new InvalidContributionError("contractVersion must be an integer >= 1.");
    }
    if (props.tick < MIN_UINT64 || props.tick > MAX_UINT64) {
      throw new InvalidContributionError(
        `tick ${props.tick.toString()} is outside uint64 bounds [0, ${MAX_UINT64.toString()}].`,
      );
    }
    if (props.damage < 0n || props.damage > MAX_INT64) {
      throw new InvalidContributionError(
        `damage ${props.damage.toString()} must be in [0, ${MAX_INT64.toString()}].`,
      );
    }
    if (props.support < 0n || props.support > MAX_INT64) {
      throw new InvalidContributionError(
        `support ${props.support.toString()} must be in [0, ${MAX_INT64.toString()}].`,
      );
    }
    if (props.objectives < 0n || props.objectives > MAX_INT64) {
      throw new InvalidContributionError(
        `objectives ${props.objectives.toString()} must be in [0, ${MAX_INT64.toString()}].`,
      );
    }
    if (!TERMINAL_INVASION_OUTCOMES.includes(props.outcome)) {
      throw new InvalidContributionError(`Non-terminal or invalid outcome '${String(props.outcome)}'.`);
    }
    if (!props.payloadFingerprint.trim() || props.payloadFingerprint.length < 16) {
      throw new InvalidContributionError("payloadFingerprint must be non-empty.");
    }

    this.id = props.id;
    this.processedEventId = props.processedEventId;
    this.externalEventId = props.externalEventId.trim();
    this.contractVersion = props.contractVersion;
    this.simulationId = props.simulationId.trim();
    this.invasionId = props.invasionId.trim();
    this.settlementRef = props.settlementRef.trim();
    this.resolvedSettlementId = props.resolvedSettlementId;
    this.playerId = props.playerId.trim();
    this.tick = props.tick;
    this.damage = props.damage;
    this.support = props.support;
    this.objectives = props.objectives;
    this.eligible = props.eligible;
    this.outcome = props.outcome;
    this.payloadFingerprint = props.payloadFingerprint;
    this.receivedAt = props.receivedAt;
    this.recordedAt = props.recordedAt;
  }
}
