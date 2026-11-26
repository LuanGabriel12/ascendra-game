import pg from "pg";
import { isCanonicalUuid } from "../../../shared/contracts/canonical-fingerprint.js";
import {
  withPgTransaction,
  type PgPool,
  type PgPoolClient,
} from "../../../shared/db/pool.js";
import {
  claimOrVerifyProcessedEvent,
  type ClaimProcessedEventInput,
  type ClaimProcessedEventResult,
} from "../../../shared/db/processed-events-inbox.js";
import type { ContributionRecordedOutboxPayloadV1 } from "../contracts/contribution-contracts.js";
import {
  GameplayContribution,
  type TerminalInvasionOutcome,
} from "../domain/contribution.js";
import { LogicalContributionConflictError } from "../domain/errors.js";
import type {
  ContributionTransactionScope,
  ContributionUnitOfWork,
  EnqueueContributionOutboxInput,
} from "../application/ports.js";

interface ContributionRow {
  id: string;
  processed_event_id: string;
  external_event_id: string;
  contract_version: number;
  simulation_id: string;
  invasion_id: string;
  settlement_ref: string;
  resolved_settlement_id: string | null;
  player_id: string;
  simulation_tick: string;
  damage: string;
  support: string;
  objectives: string;
  eligible: boolean;
  outcome: TerminalInvasionOutcome;
  payload_fingerprint: string;
  received_at: Date;
  recorded_at: Date;
}

const SELECT_CONTRIBUTION_COLUMNS = `
  id,
  processed_event_id,
  external_event_id,
  contract_version,
  simulation_id,
  invasion_id,
  settlement_ref,
  resolved_settlement_id,
  player_id,
  simulation_tick::text AS simulation_tick,
  damage::text AS damage,
  support::text AS support,
  objectives::text AS objectives,
  eligible,
  outcome,
  payload_fingerprint,
  received_at,
  recorded_at
`;

function mapContributionRow(row: ContributionRow): GameplayContribution {
  return new GameplayContribution({
    id: row.id,
    processedEventId: row.processed_event_id,
    externalEventId: row.external_event_id,
    contractVersion: row.contract_version,
    simulationId: row.simulation_id,
    invasionId: row.invasion_id,
    settlementRef: row.settlement_ref,
    resolvedSettlementId: row.resolved_settlement_id,
    playerId: row.player_id,
    tick: BigInt(row.simulation_tick),
    damage: BigInt(row.damage),
    support: BigInt(row.support),
    objectives: BigInt(row.objectives),
    eligible: row.eligible,
    outcome: row.outcome,
    payloadFingerprint: row.payload_fingerprint,
    receivedAt: row.received_at,
    recordedAt: row.recorded_at,
  });
}

class PgContributionTransactionScope implements ContributionTransactionScope {
  private readonly client: PgPoolClient;

  constructor(client: PgPoolClient) {
    this.client = client;
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async findByExternalEventId(
    externalEventId: string,
  ): Promise<GameplayContribution | null> {
    const res = await this.client.query<ContributionRow>(
      `SELECT ${SELECT_CONTRIBUTION_COLUMNS}
       FROM gameplay_contributions
       WHERE external_event_id = $1`,
      [externalEventId.trim()],
    );
    const row = res.rows[0];
    return row ? mapContributionRow(row) : null;
  }

  public async findByLogicalIdentity(params: {
    readonly simulationId: string;
    readonly invasionId: string;
    readonly playerId: string;
  }): Promise<GameplayContribution | null> {
    const res = await this.client.query<ContributionRow>(
      `SELECT ${SELECT_CONTRIBUTION_COLUMNS}
       FROM gameplay_contributions
       WHERE simulation_id = $1
         AND invasion_id = $2
         AND player_id = $3`,
      [params.simulationId, params.invasionId, params.playerId],
    );
    const row = res.rows[0];
    return row ? mapContributionRow(row) : null;
  }

  public async resolveSettlementUuid(settlementIdentifier: string): Promise<string | null> {
    const trimmed = settlementIdentifier.trim();
    const uuidCandidate = isCanonicalUuid(trimmed) ? trimmed.toLowerCase() : null;
    const res = await this.client.query<{ id: string }>(
      `SELECT id
       FROM settlements
       WHERE external_id = $1
          OR ($2::uuid IS NOT NULL AND id = $2::uuid)
       LIMIT 1`,
      [trimmed, uuidCandidate],
    );
    return res.rows[0]?.id ?? null;
  }

  public async insertContribution(
    contribution: GameplayContribution,
  ): Promise<GameplayContribution> {
    try {
      const res = await this.client.query<ContributionRow>(
        `INSERT INTO gameplay_contributions (
           id,
           processed_event_id,
           external_event_id,
           contract_version,
           simulation_id,
           invasion_id,
           settlement_ref,
           resolved_settlement_id,
           player_id,
           simulation_tick,
           damage,
           support,
           objectives,
           eligible,
           outcome,
           payload_fingerprint,
           received_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10::numeric(20, 0),
           $11::bigint,
           $12::bigint,
           $13::bigint,
           $14, $15, $16, $17
         )
         RETURNING ${SELECT_CONTRIBUTION_COLUMNS}`,
        [
          contribution.id,
          contribution.processedEventId,
          contribution.externalEventId,
          contribution.contractVersion,
          contribution.simulationId,
          contribution.invasionId,
          contribution.settlementRef,
          contribution.resolvedSettlementId,
          contribution.playerId,
          contribution.tick.toString(),
          contribution.damage.toString(),
          contribution.support.toString(),
          contribution.objectives.toString(),
          contribution.eligible,
          contribution.outcome,
          contribution.payloadFingerprint,
          contribution.receivedAt,
        ],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error("Failed to insert gameplay_contributions row.");
      }
      return mapContributionRow(row);
    } catch (error) {
      // Translate concurrent race on UNIQUE(simulation_id, invasion_id, player_id) into domain conflict
      if (
        error instanceof pg.DatabaseError &&
        error.code === "23505" &&
        error.constraint === "uq_gameplay_contributions_logical_identity"
      ) {
        throw new LogicalContributionConflictError({
          simulationId: contribution.simulationId,
          invasionId: contribution.invasionId,
          playerId: contribution.playerId,
          existingExternalEventId: "<committed-concurrently>",
          incomingExternalEventId: contribution.externalEventId,
        });
      }
      throw error;
    }
  }

  public async enqueueOutboxEvent(input: EnqueueContributionOutboxInput): Promise<void> {
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
       VALUES ($1, 'GameplayContribution', $2, 'ContributionRecorded', 1, $3, $4, $5::jsonb, $6)`,
      [
        input.id,
        input.aggregateId,
        input.correlationUuid,
        input.causationEventUuid,
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    );
  }
}

export class PostgresContributionUnitOfWork implements ContributionUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: ContributionTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgContributionTransactionScope(client);
      return work(scope);
    });
  }
}

export interface PersistedContributionOutboxEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly causationEventId: string;
  readonly payload: ContributionRecordedOutboxPayloadV1;
  readonly publishedAt: Date | null;
}

export class PostgresContributionRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async findByExternalEventId(
    externalEventId: string,
  ): Promise<GameplayContribution | null> {
    const res = await this.pool.query<ContributionRow>(
      `SELECT ${SELECT_CONTRIBUTION_COLUMNS}
       FROM gameplay_contributions
       WHERE external_event_id = $1`,
      [externalEventId.trim()],
    );
    const row = res.rows[0];
    return row ? mapContributionRow(row) : null;
  }

  public async listByInvasion(
    simulationId: string,
    invasionId: string,
  ): Promise<ReadonlyArray<GameplayContribution>> {
    const res = await this.pool.query<ContributionRow>(
      `SELECT ${SELECT_CONTRIBUTION_COLUMNS}
       FROM gameplay_contributions
       WHERE simulation_id = $1
         AND invasion_id = $2
       ORDER BY player_id ASC`,
      [simulationId, invasionId],
    );
    return res.rows.map(mapContributionRow);
  }

  public async countAll(): Promise<number> {
    const res = await this.pool.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM gameplay_contributions",
    );
    return Number(res.rows[0]?.total ?? "0");
  }

  public async listOutboxByContributionId(
    contributionId: string,
  ): Promise<ReadonlyArray<PersistedContributionOutboxEvent>> {
    const res = await this.pool.query<{
      id: string;
      aggregate_id: string;
      event_type: string;
      causation_event_id: string;
      payload: ContributionRecordedOutboxPayloadV1;
      published_at: Date | null;
    }>(
      `SELECT id, aggregate_id, event_type, causation_event_id, payload, published_at
       FROM outbox_events
       WHERE aggregate_type = 'GameplayContribution'
         AND aggregate_id = $1
       ORDER BY created_at ASC`,
      [contributionId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      causationEventId: r.causation_event_id,
      payload: r.payload,
      publishedAt: r.published_at,
    }));
  }
}
