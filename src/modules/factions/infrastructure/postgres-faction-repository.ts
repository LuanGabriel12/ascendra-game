import type { PgPool, PgPoolClient } from "../../../shared/db/pool.js";
import type { CreateFactionInput, Faction } from "../domain/faction.js";

interface FactionRow {
  id: string;
  code: string;
  name: string;
  is_playable: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapFactionRow(row: FactionRow): Faction {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isPlayable: row.is_playable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresFactionRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async create(input: CreateFactionInput, client?: PgPoolClient): Promise<Faction> {
    const executor = client ?? this.pool;
    const res = await executor.query<FactionRow>(
      `INSERT INTO factions (id, code, name, is_playable)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, is_playable, created_at, updated_at`,
      [input.id, input.code.trim(), input.name.trim(), input.isPlayable ?? false],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("Failed to insert faction row.");
    }
    return mapFactionRow(row);
  }

  public async findById(id: string, client?: PgPoolClient): Promise<Faction | null> {
    const executor = client ?? this.pool;
    const res = await executor.query<FactionRow>(
      `SELECT id, code, name, is_playable, created_at, updated_at
       FROM factions
       WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapFactionRow(row) : null;
  }
}
