import pg from "pg";

const { Pool } = pg;
export type PgPool = pg.Pool;
export type PgPoolClient = pg.PoolClient;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number | undefined;
  readonly idleTimeoutMillis?: number | undefined;
  readonly connectionTimeoutMillis?: number | undefined;
}

export function createPgPool(options: PoolOptions): PgPool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
  });
}

/**
 * Executes work atomically inside a single PostgreSQL READ COMMITTED transaction.
 * Guarantees automatic ROLLBACK on any thrown error and safe client release.
 */
export async function withPgTransaction<T>(
  pool: PgPool,
  work: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure if connection dropped during rollback.
    }
    throw error;
  } finally {
    client.release();
  }
}
