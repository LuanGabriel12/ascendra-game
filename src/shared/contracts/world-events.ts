import { z } from "zod";

/**
 * Canonical versioned event envelope proposed between NEON and CARBON (v1).
 * Validated strictly at the system boundary before opening database transactions.
 */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const BaseEventEnvelopeV1Schema = z.object({
  event_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(1).max(128).optional(),
  event_type: z.string().trim().min(1).max(64),
  version: z.literal(1),
  occurred_at: IsoDateTimeSchema,
  correlation_id: z.string().uuid(),
  source: z.string().trim().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
});

export const SettlementCapturedPayloadV1Schema = z
  .object({
    settlement_id: z.string().uuid(),
    capturing_faction_id: z.string().uuid(),
    invasion_id: z.string().uuid().optional(),
    expected_settlement_version: z.number().int().min(1).optional(),
  })
  .strict();

export const SettlementLiberatedPayloadV1Schema = z
  .object({
    settlement_id: z.string().uuid(),
    liberating_faction_id: z.string().uuid(),
    resulting_state: z.enum(["rebuilding", "peaceful"]).optional(),
    expected_settlement_version: z.number().int().min(1).optional(),
  })
  .strict();

export const SettlementCapturedEventV1Schema = BaseEventEnvelopeV1Schema.extend({
  event_type: z.literal("SettlementCaptured"),
  payload: SettlementCapturedPayloadV1Schema,
}).strict();

export const SettlementLiberatedEventV1Schema = BaseEventEnvelopeV1Schema.extend({
  event_type: z.literal("SettlementLiberated"),
  payload: SettlementLiberatedPayloadV1Schema,
}).strict();

export const SupportedNeonSettlementEventV1Schema = z.discriminatedUnion("event_type", [
  SettlementCapturedEventV1Schema,
  SettlementLiberatedEventV1Schema,
]);

export type SettlementCapturedEventV1 = z.infer<typeof SettlementCapturedEventV1Schema>;
export type SettlementLiberatedEventV1 = z.infer<typeof SettlementLiberatedEventV1Schema>;
export type SupportedNeonSettlementEventV1 = z.infer<typeof SupportedNeonSettlementEventV1Schema>;

export interface SettlementStateChangedOutboxPayloadV1 {
  readonly settlement_id: string;
  readonly region_id: string;
  readonly previous_state: string;
  readonly new_state: string;
  readonly previous_faction_id: string | null;
  readonly new_faction_id: string | null;
  readonly settlement_version: number;
  readonly cause_event_id: string;
  readonly cause_event_type: string;
}

export class BoundaryValidationError extends Error {
  public readonly issues: ReadonlyArray<string>;

  constructor(message: string, issues: ReadonlyArray<string>) {
    super(message);
    this.name = "BoundaryValidationError";
    this.issues = issues;
  }
}

export function parseSupportedNeonSettlementEvent(raw: unknown): SupportedNeonSettlementEventV1 {
  const result = SupportedNeonSettlementEventV1Schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new BoundaryValidationError(
      `Invalid NEON world event envelope/payload: ${issues.join("; ")}`,
      issues,
    );
  }
  return result.data;
}
