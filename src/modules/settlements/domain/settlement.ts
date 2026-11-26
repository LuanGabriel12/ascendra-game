import { MAX_INT64 } from "../../../shared/contracts/int64-wire.js";
import {
  InvalidSettlementSnapshotError,
  InvalidSettlementStateTransitionError,
  SettlementConcurrencyConflictError,
} from "./errors.js";

export const SETTLEMENT_STATES = [
  "peaceful",
  "threatened",
  "under_attack",
  "occupied",
  "rebuilding",
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/**
 * NEON defensive condition enum (`ports.SettlementDefenseState` in Go).
 * Kept orthogonal to CARBON's lifecycle `SettlementState`:
 * - Non-occupied settlements (`peaceful`, `threatened`, `under_attack`, `rebuilding`)
 *   may independently be `Secure`, `Fortified`, or `Damaged`.
 * - Occupied settlements (`occupied`) carry `Captured` defensive state.
 */
export const SETTLEMENT_DEFENSE_STATES = [
  "Secure",
  "Fortified",
  "Damaged",
  "Captured",
] as const;

export type SettlementDefenseState = (typeof SETTLEMENT_DEFENSE_STATES)[number];

/**
 * Provisional development baseline matching NEON's DefaultSettlementFixtures (1000 HP).
 * Explicitly NOT final gameplay balance.
 */
export const PROVISIONAL_DEFAULT_MAX_DEFENSE_HP = 1000n;

export function defaultDefenseStateForLifecycle(state: SettlementState): SettlementDefenseState {
  if (state === "occupied") {
    return "Captured";
  }
  if (state === "rebuilding") {
    return "Damaged";
  }
  return "Secure";
}

export interface SettlementProps {
  readonly id: string;
  readonly externalId?: string | null | undefined;
  readonly name: string;
  readonly regionId: string;
  readonly state: SettlementState;
  readonly defenseState?: SettlementDefenseState | undefined;
  readonly maxDefenseHp?: bigint | undefined;
  readonly controllingFactionId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SettlementTransitionResult {
  readonly updated: Settlement;
  readonly previousState: SettlementState;
  readonly newState: SettlementState;
  readonly previousFactionId: string | null;
  readonly newFactionId: string | null;
}

const CAPTURABLE_STATES: ReadonlySet<SettlementState> = new Set<SettlementState>([
  "threatened",
  "under_attack",
  "occupied",
]);

const LIBERATABLE_STATES: ReadonlySet<SettlementState> = new Set<SettlementState>([
  "occupied",
  "under_attack",
]);

export class Settlement {
  public readonly id: string;
  public readonly externalId: string;
  public readonly name: string;
  public readonly regionId: string;
  public readonly state: SettlementState;
  public readonly defenseState: SettlementDefenseState;
  public readonly maxDefenseHp: bigint;
  public readonly controllingFactionId: string | null;
  public readonly version: number;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  constructor(props: SettlementProps) {
    if (!props.name.trim()) {
      throw new InvalidSettlementStateTransitionError("Settlement name cannot be blank.");
    }
    if (!props.regionId.trim()) {
      throw new InvalidSettlementStateTransitionError("Settlement regionId cannot be blank.");
    }
    if (props.version < 1) {
      throw new InvalidSettlementStateTransitionError("Settlement version must be >= 1.");
    }
    if (props.state === "occupied" && !props.controllingFactionId) {
      throw new InvalidSettlementStateTransitionError(
        "An 'occupied' settlement must have a non-null controllingFactionId.",
      );
    }

    const resolvedExternalId = (props.externalId ?? props.id).trim();
    if (!resolvedExternalId) {
      throw new InvalidSettlementSnapshotError("Settlement externalId cannot be blank.");
    }

    const resolvedDefenseState =
      props.defenseState ?? defaultDefenseStateForLifecycle(props.state);
    if (props.state === "occupied" && resolvedDefenseState !== "Captured") {
      throw new InvalidSettlementStateTransitionError(
        `Occupied settlement '${props.id}' must carry defenseState 'Captured', got '${resolvedDefenseState}'.`,
      );
    }
    if (props.state !== "occupied" && resolvedDefenseState === "Captured") {
      throw new InvalidSettlementStateTransitionError(
        `Non-occupied settlement '${props.id}' (state='${props.state}') cannot carry defenseState 'Captured'.`,
      );
    }

    const resolvedMaxHp = props.maxDefenseHp ?? PROVISIONAL_DEFAULT_MAX_DEFENSE_HP;
    if (resolvedMaxHp <= 0n || resolvedMaxHp > MAX_INT64) {
      throw new InvalidSettlementSnapshotError(
        `Settlement maxDefenseHp must be in (0, ${MAX_INT64.toString()}], got ${resolvedMaxHp.toString()}.`,
      );
    }

    this.id = props.id;
    this.externalId = resolvedExternalId;
    this.name = props.name;
    this.regionId = props.regionId;
    this.state = props.state;
    this.defenseState = resolvedDefenseState;
    this.maxDefenseHp = resolvedMaxHp;
    this.controllingFactionId = props.controllingFactionId;
    this.version = props.version;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public applyCapture(params: {
    readonly capturingFactionId: string;
    readonly occurredAt: Date;
    readonly expectedVersion?: number | undefined;
  }): SettlementTransitionResult {
    this.assertExpectedVersion(params.expectedVersion);

    if (!CAPTURABLE_STATES.has(this.state)) {
      throw new InvalidSettlementStateTransitionError(
        `Cannot capture settlement '${this.id}' from state '${this.state}'; expected active threat, attack, or rival occupation.`,
      );
    }

    if (this.state === "occupied" && this.controllingFactionId === params.capturingFactionId) {
      throw new InvalidSettlementStateTransitionError(
        `Settlement '${this.id}' is already occupied by faction '${params.capturingFactionId}'.`,
      );
    }

    const updated = new Settlement({
      id: this.id,
      externalId: this.externalId,
      name: this.name,
      regionId: this.regionId,
      state: "occupied",
      defenseState: "Captured",
      maxDefenseHp: this.maxDefenseHp,
      controllingFactionId: params.capturingFactionId,
      version: this.version + 1,
      createdAt: this.createdAt,
      updatedAt: this.nextTimestamp(params.occurredAt),
    });

    return {
      updated,
      previousState: this.state,
      newState: updated.state,
      previousFactionId: this.controllingFactionId,
      newFactionId: updated.controllingFactionId,
    };
  }

  public applyLiberation(params: {
    readonly liberatingFactionId: string;
    readonly occurredAt: Date;
    readonly resultingState?: "rebuilding" | "peaceful" | undefined;
    readonly expectedVersion?: number | undefined;
  }): SettlementTransitionResult {
    this.assertExpectedVersion(params.expectedVersion);

    if (!LIBERATABLE_STATES.has(this.state)) {
      throw new InvalidSettlementStateTransitionError(
        `Cannot liberate settlement '${this.id}' from state '${this.state}'; settlement must be 'occupied' or 'under_attack'.`,
      );
    }

    const defaultNextState: "rebuilding" | "peaceful" =
      this.state === "occupied" ? "rebuilding" : "peaceful";
    const targetState = params.resultingState ?? defaultNextState;

    if (this.state === "occupied" && targetState === "peaceful") {
      throw new InvalidSettlementStateTransitionError(
        `Occupied settlement '${this.id}' must transition through 'rebuilding' upon liberation, not directly to 'peaceful'.`,
      );
    }

    const nextDefenseState: SettlementDefenseState =
      this.state === "occupied" ? "Damaged" : this.defenseState;

    const updated = new Settlement({
      id: this.id,
      externalId: this.externalId,
      name: this.name,
      regionId: this.regionId,
      state: targetState,
      defenseState: nextDefenseState,
      maxDefenseHp: this.maxDefenseHp,
      controllingFactionId: params.liberatingFactionId,
      version: this.version + 1,
      createdAt: this.createdAt,
      updatedAt: this.nextTimestamp(params.occurredAt),
    });

    return {
      updated,
      previousState: this.state,
      newState: updated.state,
      previousFactionId: this.controllingFactionId,
      newFactionId: updated.controllingFactionId,
    };
  }

  private assertExpectedVersion(expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && expectedVersion !== this.version) {
      throw new SettlementConcurrencyConflictError(this.id, expectedVersion, this.version);
    }
  }

  private nextTimestamp(occurredAt: Date): Date {
    return occurredAt.getTime() >= this.updatedAt.getTime() ? occurredAt : new Date();
  }
}
