import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PgPool, PgPoolClient } from "./pool.js";

export class MigrationChecksumMismatchError extends Error {
  public readonly version: string;
  public readonly expectedChecksum: string;
  public readonly actualChecksum: string;

  constructor(version: string, expectedChecksum: string, actualChecksum: string) {
    super(
      `Migration '${version}' checksum mismatch: applied='${expectedChecksum}', on-disk='${actualChecksum}'. Published migrations must never be modified retroactively.`,
    );
    this.name = "MigrationChecksumMismatchError";
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export function computeMigrationChecksumSha256(sqlText: string): string {
  const normalizedLf = sqlText.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalizedLf, "utf8").digest("hex");
}

export interface MigrationFilePair {
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string | undefined;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly applied_at: Date;
  readonly checksum_sha256?: string | null | undefined;
}

const MIGRATION_ADVISORY_LOCK_KEY = 84291001;

async function ensureMigrationsTable(client: PgPoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum_sha256 VARCHAR(64) NULL
    );
  `);
  await client.query(`
    ALTER TABLE schema_migrations
    ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(64) NULL;
  `);
}

export async function discoverMigrations(migrationsDir: string): Promise<ReadonlyArray<MigrationFilePair>> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const upFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".up.sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const fileSet = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));

  return upFiles.map((upFileName) => {
    const baseName = upFileName.slice(0, -".up.sql".length);
    const separatorIdx = baseName.indexOf("_");
    if (separatorIdx <= 0) {
      throw new Error(
        `Invalid migration filename '${upFileName}'. Expected '<version>_<name>.up.sql'.`,
      );
    }
    const version = baseName.slice(0, separatorIdx);
    const name = baseName.slice(separatorIdx + 1);
    const candidateDown = `${baseName}.down.sql`;
    return {
      version,
      name,
      upPath: path.join(migrationsDir, upFileName),
      downPath: fileSet.has(candidateDown) ? path.join(migrationsDir, candidateDown) : undefined,
    };
  });
}

export async function listAppliedMigrations(pool: PgPool): Promise<ReadonlyArray<AppliedMigration>> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const res = await client.query<AppliedMigration>(
      "SELECT version, name, applied_at, checksum_sha256 FROM schema_migrations ORDER BY version ASC",
    );
    return res.rows;
  } finally {
    client.release();
  }
}

export async function migrateUp(
  pool: PgPool,
  migrationsDir: string,
): Promise<ReadonlyArray<string>> {
  const available = await discoverMigrations(migrationsDir);
  const client = await pool.connect();
  const newlyApplied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const appliedRes = await client.query<{ version: string; checksum_sha256: string | null }>(
      "SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version ASC",
    );
    const appliedChecksums = new Map<string, string | null>(
      appliedRes.rows.map((r) => [r.version, r.checksum_sha256]),
    );

    for (const migration of available) {
      const sql = await readFile(migration.upPath, "utf8");
      const checksum = computeMigrationChecksumSha256(sql);

      if (appliedChecksums.has(migration.version)) {
        const storedChecksum = appliedChecksums.get(migration.version) ?? null;
        if (storedChecksum !== null && storedChecksum !== checksum) {
          throw new MigrationChecksumMismatchError(migration.version, storedChecksum, checksum);
        }
        if (storedChecksum === null) {
          await client.query(
            "UPDATE schema_migrations SET checksum_sha256 = $1 WHERE version = $2 AND checksum_sha256 IS NULL",
            [checksum, migration.version],
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum_sha256) VALUES ($1, $2, $3)",
          [migration.version, migration.name, checksum],
        );
        await client.query("COMMIT");
        newlyApplied.push(`${migration.version}_${migration.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return newlyApplied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {
      // Ignore unlock error if connection already closed.
    }
    client.release();
  }
}

/**
 * Rolls back the most recently applied migration (1 step by default, or `steps` steps).
 */
export async function migrateDown(
  pool: PgPool,
  migrationsDir: string,
  steps: number = 1,
): Promise<ReadonlyArray<string>> {
  if (steps < 1) {
    throw new Error("migrateDown steps must be >= 1");
  }

  const available = await discoverMigrations(migrationsDir);
  const byVersion = new Map(available.map((m) => [m.version, m]));
  const client = await pool.connect();
  const rolledBack: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const appliedRes = await client.query<{ version: string; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT $1",
      [steps],
    );

    for (const row of appliedRes.rows) {
      const pair = byVersion.get(row.version);
      if (!pair || !pair.downPath) {
        throw new Error(
          `Cannot rollback migration '${row.version}_${row.name}': missing .down.sql file.`,
        );
      }

      const sql = await readFile(pair.downPath, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("DELETE FROM schema_migrations WHERE version = $1", [row.version]);
        await client.query("COMMIT");
        rolledBack.push(`${row.version}_${row.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return rolledBack;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {
      // Ignore unlock error if connection already closed.
    }
    client.release();
  }
}
