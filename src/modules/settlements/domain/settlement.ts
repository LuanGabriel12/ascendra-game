import {
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

export interface SettlementProps {
  readonly id: string;
  readonly name: string;
  readonly regionId: string;
  readonly state: SettlementState;
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
  public readonly name: string;
  public readonly regionId: string;
  public readonly state: SettlementState;
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

    this.id = props.id;
    this.name = props.name;
    this.regionId = props.regionId;
    this.state = props.state;
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
      name: this.name,
      regionId: this.regionId,
      state: "occupied",
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

    const updated = new Settlement({
      id: this.id,
      name: this.name,
      regionId: this.regionId,
      state: targetState,
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
