import { z } from "zod";
import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import {
  NonNegativeInt64Schema,
  Uint64Schema,
  decodeWireJsonLossless,
} from "../../../shared/contracts/int64-wire.js";
import { IsoDateTimeSchema } from "../../../shared/contracts/world-events.js";
import {
  TERMINAL_INVASION_OUTCOMES,
  type GameplayContribution,
  type TerminalInvasionOutcome,
} from "../domain/contribution.js";
import { InvalidContributionError } from "../domain/errors.js";

const NonBlankIdentifier128Schema = z
  .string()
  .max(128)
  .refine((s) => s.trim().length > 0, { message: "Identifier cannot be blank." })
  .transform((s) => s.trim());

const NonBlankEventId255Schema = z
  .string()
  .max(255)
  .refine((s) => s.trim().length > 0, { message: "event_id cannot be blank." })
  .transform((s) => s.trim());

/**
 * Matches NEON's `ports.ContributionResult` struct in `internal/ports/carbon.go`.
 * 64-bit integer fields (`tick`, `damage`, `support`, `objectives`) accept canonical decimal
 * strings, BigInt, or safe JS integers (raw Go JSON integers > 2^53-1 are preserved via
 * `decodeWireJsonLossless` before validation).
 */
export const NeonContributionResultPayloadV1Schema = z
  .object({
    event_id: NonBlankEventId255Schema,
    simulation_id: NonBlankIdentifier128Schema,
    invasion_id: NonBlankIdentifier128Schema,
    settlement_id: NonBlankIdentifier128Schema,
    tick: Uint64Schema,
    player_id: NonBlankIdentifier128Schema,
    damage: NonNegativeInt64Schema,
    support: NonNegativeInt64Schema,
    objectives: NonNegativeInt64Schema,
    eligible: z.boolean(),
    outcome: z.enum(TERMINAL_INVASION_OUTCOMES),
  })
  .strict();

/**
 * Optional versioned transport wrapper around `ContributionResult`.
 */
export const EnvelopedContributionSubmissionV1Schema = z
  .object({
    contract_version: z.literal(1),
    idempotency_key: NonBlankEventId255Schema.optional(),
    correlation_id: NonBlankEventId255Schema.optional(),
    source: NonBlankIdentifier128Schema.optional(),
    occurred_at: IsoDateTimeSchema.optional(),
    contribution: NeonContributionResultPayloadV1Schema,
  })
  .strict();

/**
 * Direct `ContributionResult` wire format with optional `contract_version: 1`.
 */
export const DirectContributionSubmissionV1Schema = NeonContributionResultPayloadV1Schema.extend({
  contract_version: z.literal(1).optional(),
}).strict();

export interface ValidatedContributionSubmission {
  readonly contractVersion: 1;
  readonly externalEventId: string;
  readonly deterministicEventUuid: string;
  readonly idempotencyKey: string;
  readonly correlationUuid: string;
  readonly source: string;
  readonly occurredAt: Date | null;
  readonly simulationId: string;
  readonly invasionId: string;
  readonly settlementId: string;
  readonly tick: bigint;
  readonly playerId: string;
  readonly damage: bigint;
  readonly support: bigint;
  readonly objectives: bigint;
  readonly eligible: boolean;
  readonly outcome: TerminalInvasionOutcome;
  readonly payloadFingerprint: string;
  readonly canonicalPayload: Record<string, unknown>;
}

export interface ContributionRecordedOutboxPayloadV1 {
  readonly contract_version: 1;
  readonly contribution_id: string;
  readonly external_event_id: string;
  readonly simulation_id: string;
  readonly invasion_id: string;
  readonly settlement_id: string;
  readonly resolved_settlement_id: string | null;
  readonly player_id: string;
  readonly tick: string;
  readonly damage: string;
  readonly support: string;
  readonly objectives: string;
  readonly eligible: boolean;
  readonly outcome: TerminalInvasionOutcome;
}

export interface ContributionResultWireV1 {
  readonly contract_version: 1;
  readonly event_id: string;
  readonly simulation_id: string;
  readonly invasion_id: string;
  readonly settlement_id: string;
  readonly tick: string;
  readonly player_id: string;
  readonly damage: string;
  readonly support: string;
  readonly objectives: string;
  readonly eligible: boolean;
  readonly outcome: TerminalInvasionOutcome;
}

export function serializeContributionWireV1(
  contribution: GameplayContribution,
): ContributionResultWireV1 {
  return {
    contract_version: 1,
    event_id: contribution.externalEventId,
    simulation_id: contribution.simulationId,
    invasion_id: contribution.invasionId,
    settlement_id: contribution.settlementRef,
    tick: contribution.tick.toString(),
    player_id: contribution.playerId,
    damage: contribution.damage.toString(),
    support: contribution.support.toString(),
    objectives: contribution.objectives.toString(),
    eligible: contribution.eligible,
    outcome: contribution.outcome,
  };
}

export function parseContributionWireJson(rawJsonText: string): ValidatedContributionSubmission {
  let decoded: unknown;
  try {
    decoded = decodeWireJsonLossless(rawJsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidContributionError(`Malformed or oversized contribution JSON: ${msg}`);
  }
  return parseContributionSubmission(decoded);
}

export function parseContributionSubmission(raw: unknown): ValidatedContributionSubmission {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidContributionError("Contribution submission must be a JSON object.");
  }

  const record = raw as Record<string, unknown>;
  const isEnveloped = "contribution" in record;

  if (
    "contract_version" in record &&
    record["contract_version"] !== undefined &&
    record["contract_version"] !== 1
  ) {
    throw new InvalidContributionError(
      `Unsupported contribution contract_version '${String(record["contract_version"])}'; expected 1.`,
    );
  }

  const parsed = isEnveloped
    ? EnvelopedContributionSubmissionV1Schema.safeParse(raw)
    : DirectContributionSubmissionV1Schema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new InvalidContributionError(
      `Invalid ContributionResult payload: ${issues.join("; ")}`,
      issues,
    );
  }

  const core = isEnveloped
    ? (parsed.data as z.infer<typeof EnvelopedContributionSubmissionV1Schema>).contribution
    : (parsed.data as z.infer<typeof DirectContributionSubmissionV1Schema>);

  const envelopeMeta = isEnveloped
    ? (parsed.data as z.infer<typeof EnvelopedContributionSubmissionV1Schema>)
    : undefined;

  const externalEventId = core.event_id;
  const idempotencyKey = envelopeMeta?.idempotency_key ?? externalEventId;
  const correlationSource =
    envelopeMeta?.correlation_id ?? `sim:${core.simulation_id}:inv:${core.invasion_id}`;
  const source = envelopeMeta?.source ?? "neon.contribution-sink";
  const occurredAt = envelopeMeta?.occurred_at ? new Date(envelopeMeta.occurred_at) : null;

  const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
    contract_version: 1,
    event_type: "ContributionRecorded",
    event_id: externalEventId,
    simulation_id: core.simulation_id,
    invasion_id: core.invasion_id,
    settlement_id: core.settlement_id,
    tick: core.tick,
    player_id: core.player_id,
    damage: core.damage,
    support: core.support,
    objectives: core.objectives,
    eligible: core.eligible,
    outcome: core.outcome,
  });

  return {
    contractVersion: 1,
    externalEventId,
    deterministicEventUuid: deriveDeterministicEventUuid(externalEventId),
    idempotencyKey,
    correlationUuid: deriveDeterministicEventUuid(correlationSource),
    source,
    occurredAt,
    simulationId: core.simulation_id,
    invasionId: core.invasion_id,
    settlementId: core.settlement_id,
    tick: core.tick,
    playerId: core.player_id,
    damage: core.damage,
    support: core.support,
    objectives: core.objectives,
    eligible: core.eligible,
    outcome: core.outcome,
    payloadFingerprint: fingerprint,
    canonicalPayload: canonicalJson,
  };
}
