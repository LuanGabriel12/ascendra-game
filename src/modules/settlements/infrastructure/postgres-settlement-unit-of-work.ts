import { deriveDeterministicEventUuid } from "../../../shared/contracts/canonical-fingerprint.js";
import type { SettlementStateChangedOutboxPayloadV1 } from "../../../shared/contracts/world-events.js";
import {
  withPgTransaction,
  type PgPool,
  type PgPoolClient,
} from "../../../shared/db/pool.js";
import { claimOrVerifyProcessedEvent } from "../../../shared/db/processed-events-inbox.js";
import { SettlementConcurrencyConflictError } from "../domain/errors.js";
import {
  PROVISIONAL_DEFAULT_MAX_DEFENSE_HP,
  Settlement,
  defaultDefenseStateForLifecycle,
  type SettlementDefenseState,
  type SettlementState,
} from "../domain/settlement.js";
import type { SettlementHistoryRecord } from "../domain/settlement-history.js";
import type {
  AppendSettlementHistoryInput,
  EnqueueSettlementOutboxInput,
  RegisterProcessedEventInput,
  SettlementTransactionScope,
  SettlementUnitOfWork,
} from "../application/ports.js";

interface SettlementRow {
  id: string;
  external_id: string | null;
  name: string;
  region_id: string;
  state: SettlementState;
  defense_state: SettlementDefenseState;
  max_defense_hp: string;
  controlling_faction_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface SettlementHistoryRow {
  id: string;
  settlement_id: string;
  settlement_version: number;
  previous_state: SettlementState;
  new_state: SettlementState;
  previous_faction_id: string | null;
  new_faction_id: string | null;
  cause_event_id: string;
  cause_event_type: string;
  correlation_id: string;
  occurred_at: Date;
  recorded_at: Date;
}

export interface PersistedOutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly correlationId: string;
  readonly causationEventId: string;
  readonly payload: SettlementStateChangedOutboxPayloadV1 | Record<string, unknown>;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  correlation_id: string;
  causation_event_id: string;
  payload: SettlementStateChangedOutboxPayloadV1 | Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
  published_at: Date | null;
}

function mapSettlementRow(row: SettlementRow): Settlement {
  return new Settlement({
    id: row.id,
    externalId: row.external_id ?? row.id,
    name: row.name,
    regionId: row.region_id,
    state: row.state,
    defenseState: row.defense_state,
    maxDefenseHp: BigInt(row.max_defense_hp),
    controllingFactionId: row.controlling_faction_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapHistoryRow(row: SettlementHistoryRow): SettlementHistoryRecord {
  return {
    id: row.id,
    settlementId: row.settlement_id,
    settlementVersion: row.settlement_version,
    previousState: row.previous_state,
    newState: row.new_state,
    previousFactionId: row.previous_faction_id,
    newFactionId: row.new_faction_id,
    causeEventId: row.cause_event_id,
    causeEventType: row.cause_event_type,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

class PgSettlementTransactionScope implements SettlementTransactionScope {
  private readonly client: PgPoolClient;

  constructor(client: PgPoolClient) {
    this.client = client;
  }

  public async tryRegisterProcessedEvent(input: RegisterProcessedEventInput): Promise<boolean> {
    const externalEventId = (input.externalEventId ?? input.eventId).trim();
    const eventUuid = deriveDeterministicEventUuid(input.eventId);

    const claim = await claimOrVerifyProcessedEvent(this.client, {
      eventUuid,
      externalEventId,
      idempotencyKey: input.idempotencyKey,
      eventType: input.eventType,
      eventVersion: input.eventVersion,
      source: input.source,
      correlationUuid: input.correlationId,
      aggregateUuid: input.aggregateId,
      occurredAt: input.occurredAt,
      receivedAt: input.receivedAt ?? new Date(),
      payloadFingerprint: input.payloadFingerprint,
      canonicalPayload: input.canonicalPayload,
    });

    return claim.status === "claimed";
  }

  public async lockSettlementById(settlementId: string): Promise<Settlement | null> {
    const res = await this.client.query<SettlementRow>(
      `SELECT
         id,
         external_id,
         name,
         region_id,
         state,
         defense_state,
         max_defense_hp::text AS max_defense_hp,
         controlling_faction_id,
         version,
         created_at,
         updated_at
       FROM settlements
       WHERE id = $1
       FOR UPDATE`,
      [settlementId],
    );
    const row = res.rows[0];
    return row ? mapSettlementRow(row) : null;
  }

  public async factionExists(factionId: string): Promise<boolean> {
    const res = await this.client.query<{ ok: number }>(
      "SELECT 1 AS ok FROM factions WHERE id = $1",
      [factionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async updateSettlement(
    settlement: Settlement,
    expectedPreviousVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE settlements
       SET state = $1,
           defense_state = $2,
           max_defense_hp = $3,
           controlling_faction_id = $4,
           version = $5,
           updated_at = $6
       WHERE id = $7
         AND version = $8`,
      [
        settlement.state,
        settlement.defenseState,
        settlement.maxDefenseHp.toString(),
        settlement.controllingFactionId,
        settlement.version,
        settlement.updatedAt,
        settlement.id,
        expectedPreviousVersion,
      ],
    );

    if (res.rowCount !== 1) {
      throw new SettlementConcurrencyConflictError(
        settlement.id,
        expectedPreviousVersion,
        settlement.version,
      );
    }
  }

  public async appendHistory(input: AppendSettlementHistoryInput): Promise<void> {
    await this.client.query(
      `INSERT INTO settlement_history (
         id,
         settlement_id,
         settlement_version,
         previous_state,
         new_state,
         previous_faction_id,
         new_faction_id,
         cause_event_id,
         cause_event_type,
         correlation_id,
         occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.id,
        input.settlementId,
        input.settlementVersion,
        input.previousState,
        input.newState,
        input.previousFactionId,
        input.newFactionId,
        input.causeEventId,
        input.causeEventType,
        input.correlationId,
        input.occurredAt,
      ],
    );
  }

  public async enqueueOutboxEvent(input: EnqueueSettlementOutboxInput): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_events (
         id,
         aggregate_type,
         aggregate_id,
         event_type,
         event_version,
         correlation_id,
         causation_event_id,
         payload,
         occurred_at
       )
       VALUES ($1, 'Settlement', $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        input.id,
        input.aggregateId,
        input.eventType,
        input.eventVersion,
        input.correlationId,
        input.causationEventId,
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    );
  }
}

export class PostgresSettlementUnitOfWork implements SettlementUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: SettlementTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgSettlementTransactionScope(client);
      return work(scope);
    });
  }
}

export interface CreateSettlementInput {
  readonly id: string;
  readonly externalId?: string | undefined;
  readonly name: string;
  readonly regionId: string;
  readonly state: SettlementState;
  readonly defenseState?: SettlementDefenseState | undefined;
  readonly maxDefenseHp?: bigint | undefined;
  readonly controllingFactionId: string | null;
}

export class PostgresSettlementRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async create(input: CreateSettlementInput): Promise<Settlement> {
    const externalId = (input.externalId ?? input.id).trim();
    const defenseState = input.defenseState ?? defaultDefenseStateForLifecycle(input.state);
    const maxDefenseHp = input.maxDefenseHp ?? PROVISIONAL_DEFAULT_MAX_DEFENSE_HP;

    const res = await this.pool.query<SettlementRow>(
      `INSERT INTO settlements (
         id,
         external_id,
         name,
         region_id,
         state,
         defense_state,
         max_defense_hp,
         controlling_faction_id,
         version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
       RETURNING
         id,
         external_id,
         name,
         region_id,
         state,
         defense_state,
         max_defense_hp::text AS max_defense_hp,
         controlling_faction_id,
         version,
         created_at,
         updated_at`,
      [
        input.id,
        externalId,
        input.name.trim(),
        input.regionId.trim(),
        input.state,
        defenseState,
        maxDefenseHp.toString(),
        input.controllingFactionId,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("Failed to insert settlement row.");
    }
    return mapSettlementRow(row);
  }

  public async findById(settlementId: string): Promise<Settlement | null> {
    const res = await this.pool.query<SettlementRow>(
      `SELECT
         id,
         external_id,
         name,
         region_id,
         state,
         defense_state,
         max_defense_hp::text AS max_defense_hp,
         controlling_faction_id,
         version,
         created_at,
         updated_at
       FROM settlements
       WHERE id = $1`,
      [settlementId],
    );
    const row = res.rows[0];
    return row ? mapSettlementRow(row) : null;
  }

  public async findByExternalId(externalId: string): Promise<Settlement | null> {
    const res = await this.pool.query<SettlementRow>(
      `SELECT
         id,
         external_id,
         name,
         region_id,
         state,
         defense_state,
         max_defense_hp::text AS max_defense_hp,
         controlling_faction_id,
         version,
         created_at,
         updated_at
       FROM settlements
       WHERE external_id = $1`,
      [externalId.trim()],
    );
    const row = res.rows[0];
    return row ? mapSettlementRow(row) : null;
  }

  public async listHistory(settlementId: string): Promise<ReadonlyArray<SettlementHistoryRecord>> {
    const res = await this.pool.query<SettlementHistoryRow>(
      `SELECT
         id,
         settlement_id,
         settlement_version,
         previous_state,
         new_state,
         previous_faction_id,
         new_faction_id,
         cause_event_id,
         cause_event_type,
         correlation_id,
         occurred_at,
         recorded_at
       FROM settlement_history
       WHERE settlement_id = $1
       ORDER BY settlement_version ASC`,
      [settlementId],
    );
    return res.rows.map(mapHistoryRow);
  }

  public async listOutboxByAggregate(
    settlementId: string,
  ): Promise<ReadonlyArray<PersistedOutboxEvent>> {
    const res = await this.pool.query<OutboxRow>(
      `SELECT
         id,
         aggregate_type,
         aggregate_id,
         event_type,
         event_version,
         correlation_id,
         causation_event_id,
         payload,
         occurred_at,
         created_at,
         published_at
       FROM outbox_events
       WHERE aggregate_id = $1
       ORDER BY created_at ASC`,
      [settlementId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      correlationId: row.correlation_id,
      causationEventId: row.causation_event_id,
      payload: row.payload,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      publishedAt: row.published_at,
    }));
  }

  public async countProcessedEvents(eventId: string): Promise<number> {
    const res = await this.pool.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM processed_events WHERE event_id = $1",
      [eventId],
    );
    return Number(res.rows[0]?.total ?? "0");
  }
}
