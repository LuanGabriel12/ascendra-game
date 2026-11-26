import type { PgPoolClient } from "./pool.js";

export type InboxConflictReason =
  | "EVENT_ID_PAYLOAD_MISMATCH"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "EXTERNAL_EVENT_ID_COLLISION";

export class InboxIdempotencyConflictError extends Error {
  public readonly code = "INBOX_IDEMPOTENCY_CONFLICT";
  public readonly reason: InboxConflictReason;
  public readonly externalEventId: string;
  public readonly idempotencyKey: string;

  constructor(params: {
    readonly reason: InboxConflictReason;
    readonly externalEventId: string;
    readonly idempotencyKey: string;
    readonly detail: string;
  }) {
    super(
      `Idempotency integrity conflict (${params.reason}) for event '${params.externalEventId}' (key '${params.idempotencyKey}'): ${params.detail}`,
    );
    this.name = "InboxIdempotencyConflictError";
    this.reason = params.reason;
    this.externalEventId = params.externalEventId;
    this.idempotencyKey = params.idempotencyKey;
  }
}

export interface ClaimProcessedEventInput {
  readonly eventUuid: string;
  readonly externalEventId: string;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly source: string;
  readonly correlationUuid: string;
  readonly aggregateUuid: string;
  readonly occurredAt: Date | null;
  readonly receivedAt: Date;
  readonly payloadFingerprint: string;
  readonly canonicalPayload: Record<string, unknown>;
}

export type ClaimProcessedEventResult =
  | {
      readonly status: "claimed";
      readonly eventUuid: string;
    }
  | {
      readonly status: "duplicate_verified";
      readonly existingEventUuid: string;
      readonly existingExternalEventId: string;
      readonly isLegacyRecord: boolean;
    };

interface ExistingProcessedEventRow {
  event_id: string;
  external_event_id: string;
  idempotency_key: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  payload_fingerprint: string | null;
}

/**
 * Atomically registers an incoming external event in `processed_events` inside the caller's
 * PostgreSQL transaction, or verifies canonical equivalence when an existing record collides on
 * `event_id`, `external_event_id`, or `idempotency_key`.
 *
 * Conservative Legacy Policy:
 * Pre-Session-02 rows migrated from 0001 have `payload_fingerprint IS NULL`. When encountering
 * a legacy row, structural envelope invariants (`event_type`, `event_version`, `aggregate_id`)
 * must match; any discrepancy raises `InboxIdempotencyConflictError`.
 */
export async function claimOrVerifyProcessedEvent(
  client: PgPoolClient,
  input: ClaimProcessedEventInput,
): Promise<ClaimProcessedEventResult> {
  const insertRes = await client.query<{ event_id: string }>(
    `INSERT INTO processed_events (
       event_id,
       external_event_id,
       idempotency_key,
       event_type,
       event_version,
       source,
       correlation_id,
       aggregate_id,
       occurred_at,
       received_at,
       payload_fingerprint,
       canonical_payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING event_id`,
    [
      input.eventUuid,
      input.externalEventId,
      input.idempotencyKey,
      input.eventType,
      input.eventVersion,
      input.source,
      input.correlationUuid,
      input.aggregateUuid,
      input.occurredAt,
      input.receivedAt,
      input.payloadFingerprint,
      JSON.stringify(input.canonicalPayload),
    ],
  );

  if ((insertRes.rowCount ?? 0) > 0) {
    return {
      status: "claimed",
      eventUuid: insertRes.rows[0]!.event_id,
    };
  }

  const existingRes = await client.query<ExistingProcessedEventRow>(
    `SELECT
       event_id,
       external_event_id,
       idempotency_key,
       event_type,
       event_version,
       aggregate_id,
       payload_fingerprint
     FROM processed_events
     WHERE external_event_id = $1
        OR idempotency_key = $2
        OR event_id = $3`,
    [input.externalEventId, input.idempotencyKey, input.eventUuid],
  );

  if (existingRes.rows.length === 0) {
    throw new InboxIdempotencyConflictError({
      reason: "EXTERNAL_EVENT_ID_COLLISION",
      externalEventId: input.externalEventId,
      idempotencyKey: input.idempotencyKey,
      detail: "Insert conflicted on processed_events but no matching record was readable.",
    });
  }

  // If multiple distinct rows matched (e.g. external_event_id matched row A while idempotency_key matched row B),
  // that is an immediate integrity conflict.
  if (existingRes.rows.length > 1) {
    throw new InboxIdempotencyConflictError({
      reason: "IDEMPOTENCY_KEY_CONFLICT",
      externalEventId: input.externalEventId,
      idempotencyKey: input.idempotencyKey,
      detail: "external_event_id and idempotency_key resolved to different previously processed events.",
    });
  }

  const existing = existingRes.rows[0]!;

  // Guard against theoretical UUIDv5 collision across two distinct external IDs and distinct keys
  if (
    existing.event_id === input.eventUuid &&
    existing.external_event_id !== input.externalEventId &&
    existing.idempotency_key !== input.idempotencyKey
  ) {
    throw new InboxIdempotencyConflictError({
      reason: "EXTERNAL_EVENT_ID_COLLISION",
      externalEventId: input.externalEventId,
      idempotencyKey: input.idempotencyKey,
      detail: `Derived UUID '${input.eventUuid}' collided with distinct external_event_id '${existing.external_event_id}'.`,
    });
  }

  const sameExternalEventId = existing.external_event_id === input.externalEventId;
  const sameIdempotencyKey = existing.idempotency_key === input.idempotencyKey;

  if (sameExternalEventId && !sameIdempotencyKey) {
    throw new InboxIdempotencyConflictError({
      reason: "EVENT_ID_PAYLOAD_MISMATCH",
      externalEventId: input.externalEventId,
      idempotencyKey: input.idempotencyKey,
      detail: `Same external_event_id was previously registered with idempotency_key '${existing.idempotency_key}'.`,
    });
  }

  const metadataMatches =
    existing.event_type === input.eventType &&
    existing.event_version === input.eventVersion &&
    existing.aggregate_id.toLowerCase() === input.aggregateUuid.toLowerCase();

  if (existing.payload_fingerprint === null) {
    // Conservative migration policy for legacy Session 01 rows without stored fingerprint
    if (!metadataMatches) {
      throw new InboxIdempotencyConflictError({
        reason: sameExternalEventId ? "EVENT_ID_PAYLOAD_MISMATCH" : "IDEMPOTENCY_KEY_CONFLICT",
        externalEventId: input.externalEventId,
        idempotencyKey: input.idempotencyKey,
        detail: "Envelope metadata does not match legacy processed_events record.",
      });
    }
    return {
      status: "duplicate_verified",
      existingEventUuid: existing.event_id,
      existingExternalEventId: existing.external_event_id,
      isLegacyRecord: true,
    };
  }

  if (
    existing.event_type !== input.eventType ||
    existing.event_version !== input.eventVersion ||
    existing.payload_fingerprint !== input.payloadFingerprint
  ) {
    throw new InboxIdempotencyConflictError({
      reason: sameExternalEventId ? "EVENT_ID_PAYLOAD_MISMATCH" : "IDEMPOTENCY_KEY_CONFLICT",
      externalEventId: input.externalEventId,
      idempotencyKey: input.idempotencyKey,
      detail: sameExternalEventId
        ? `Payload fingerprint mismatch for duplicate event_id (stored=${existing.payload_fingerprint}, incoming=${input.payloadFingerprint}).`
        : `idempotency_key '${input.idempotencyKey}' is already bound to an incompatible event ('${existing.external_event_id}').`,
    });
  }

  return {
    status: "duplicate_verified",
    existingEventUuid: existing.event_id,
    existingExternalEventId: existing.external_event_id,
    isLegacyRecord: false,
  };
}
