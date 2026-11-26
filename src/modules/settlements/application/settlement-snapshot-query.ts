import { z } from "zod";
import { isCanonicalUuid } from "../../../shared/contracts/canonical-fingerprint.js";
import {
  MAX_INT64,
  PositiveInt64Schema,
} from "../../../shared/contracts/int64-wire.js";
import { BoundaryValidationError } from "../../../shared/contracts/world-events.js";
import type { PgPool } from "../../../shared/db/pool.js";
import {
  InvalidSettlementSnapshotError,
  SettlementNotFoundError,
} from "../domain/errors.js";
import {
  SETTLEMENT_DEFENSE_STATES,
  type SettlementDefenseState,
} from "../domain/settlement.js";

/**
 * Minimal read-only projection consumed by NEON (`ports.SettlementSnapshot` in Go).
 * Intentionally excludes internal DB keys, faction ownership FKs, and audit timestamps.
 */
export interface SettlementSnapshotProjection {
  readonly settlementId: string;
  readonly regionId: string;
  readonly defenseState: SettlementDefenseState;
  readonly maxDefenseHp: bigint;
  readonly version: number;
}

/**
 * Cross-language wire representation (v1) of `SettlementSnapshot`.
 * `max_defense_hp` is serialized as a canonical decimal string to preserve the full int64 range.
 */
export interface SettlementSnapshotWireV1 {
  readonly contract_version: 1;
  readonly settlement_id: string;
  readonly region_id: string;
  readonly defense_state: SettlementDefenseState;
  readonly max_defense_hp: string;
  readonly settlement_version: number;
}

export const SettlementSnapshotWireV1Schema = z
  .object({
    contract_version: z.literal(1).default(1),
    settlement_id: z.string().trim().min(1).max(128),
    region_id: z.string().trim().min(1).max(64),
    defense_state: z.enum(SETTLEMENT_DEFENSE_STATES),
    max_defense_hp: PositiveInt64Schema,
    settlement_version: z.number().int().min(1).optional(),
  })
  .strict();

export function validateSettlementSnapshotProjection(
  snapshot: SettlementSnapshotProjection,
): SettlementSnapshotProjection {
  if (!snapshot.settlementId.trim()) {
    throw new InvalidSettlementSnapshotError("Empty settlementId in SettlementSnapshot.");
  }
  if (!snapshot.regionId.trim()) {
    throw new InvalidSettlementSnapshotError("Empty regionId in SettlementSnapshot.");
  }
  if (!SETTLEMENT_DEFENSE_STATES.includes(snapshot.defenseState)) {
    throw new InvalidSettlementSnapshotError(
      `Unknown defenseState '${String(snapshot.defenseState)}' in SettlementSnapshot.`,
    );
  }
  if (snapshot.maxDefenseHp <= 0n || snapshot.maxDefenseHp > MAX_INT64) {
    throw new InvalidSettlementSnapshotError(
      `maxDefenseHp must be in (0, ${MAX_INT64.toString()}], got ${snapshot.maxDefenseHp.toString()}.`,
    );
  }
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    throw new InvalidSettlementSnapshotError(
      `Invalid settlement version '${String(snapshot.version)}' in SettlementSnapshot.`,
    );
  }
  return snapshot;
}

export function serializeSettlementSnapshotWireV1(
  projection: SettlementSnapshotProjection,
): SettlementSnapshotWireV1 {
  const checked = validateSettlementSnapshotProjection(projection);
  return {
    contract_version: 1,
    settlement_id: checked.settlementId,
    region_id: checked.regionId,
    defense_state: checked.defenseState,
    max_defense_hp: checked.maxDefenseHp.toString(),
    settlement_version: checked.version,
  };
}

export function parseSettlementSnapshotWireV1(raw: unknown): SettlementSnapshotProjection {
  const parsed = SettlementSnapshotWireV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new BoundaryValidationError(
      `Invalid SettlementSnapshot wire payload: ${issues.join("; ")}`,
      issues,
    );
  }
  return validateSettlementSnapshotProjection({
    settlementId: parsed.data.settlement_id,
    regionId: parsed.data.region_id,
    defenseState: parsed.data.defense_state,
    maxDefenseHp: parsed.data.max_defense_hp,
    version: parsed.data.settlement_version ?? 1,
  });
}

interface SnapshotProjectionRow {
  id: string;
  external_id: string | null;
  region_id: string;
  defense_state: string;
  max_defense_hp: string;
  version: number;
}

/**
 * Read-only query service backing NEON's `SettlementReader.GetSettlementSnapshot(settlementID)`.
 * Resolves settlements by stable `external_id` (e.g. `settlement-valewatch`) or canonical UUID.
 */
export class PostgresSettlementSnapshotReader {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async getSettlementSnapshot(
    settlementIdentifier: string,
  ): Promise<SettlementSnapshotProjection> {
    const trimmed = settlementIdentifier.trim();
    if (!trimmed || trimmed.length > 128) {
      throw new InvalidSettlementSnapshotError(
        "Query settlementIdentifier must be a non-empty string up to 128 characters.",
      );
    }

    const uuidCandidate = isCanonicalUuid(trimmed) ? trimmed.toLowerCase() : null;

    const res = await this.pool.query<SnapshotProjectionRow>(
      `SELECT
         id,
         external_id,
         region_id,
         defense_state,
         max_defense_hp::text AS max_defense_hp,
         version
       FROM settlements
       WHERE external_id = $1
          OR ($2::uuid IS NOT NULL AND id = $2::uuid)
       LIMIT 1`,
      [trimmed, uuidCandidate],
    );

    const row = res.rows[0];
    if (!row) {
      throw new SettlementNotFoundError(trimmed);
    }

    let maxHp: bigint;
    try {
      maxHp = BigInt(row.max_defense_hp);
    } catch {
      throw new InvalidSettlementSnapshotError(
        `Corrupted max_defense_hp value '${row.max_defense_hp}' for settlement '${trimmed}'.`,
      );
    }

    return validateSettlementSnapshotProjection({
      settlementId: (row.external_id ?? row.id).trim(),
      regionId: row.region_id,
      defenseState: row.defense_state as SettlementDefenseState,
      maxDefenseHp: maxHp,
      version: row.version,
    });
  }
}
