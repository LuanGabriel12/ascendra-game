import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createPgPool, type PgPool } from "../../src/shared/db/pool.js";

export interface RunningPostgresTestContext {
  readonly connectionString: string;
  readonly pool: PgPool;
  readonly isEmbedded: boolean;
  stop(): Promise<void>;
}

async function allocateFreeTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve ephemeral TCP port."));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Provides a real PostgreSQL connection pool for integration tests:
 * - When `DATABASE_URL` is configured (GitHub Actions CI service container or local Docker),
 *   connects directly to that PostgreSQL server.
 * - Otherwise, launches an isolated native PostgreSQL server cluster (`embedded-postgres`)
 *   on an ephemeral local TCP port so tests always execute against real PostgreSQL.
 */
export async function startPostgresTestContext(): Promise<RunningPostgresTestContext> {
  const externalUrl = process.env["DATABASE_URL"];
  if (externalUrl && externalUrl.trim().length > 0) {
    const pool = createPgPool({
      connectionString: externalUrl,
      max: 12,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await pool.query("SELECT 1");
    return {
      connectionString: externalUrl,
      pool,
      isEmbedded: false,
      async stop(): Promise<void> {
        await pool.end();
      },
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ascendra-pg-test-"));
  const dbClusterDir = path.join(tempDir, "cluster");
  const port = await allocateFreeTcpPort();
  const user = "postgres";
  const password = "ephemeral_test_pw";
  const dbName = "ascendra_test";

  const embedded = new EmbeddedPostgres({
    databaseDir: dbClusterDir,
    port,
    user,
    password,
    authMethod: "password",
    persistent: false,
    autoRehydrateSymlinks: true,
    initdbFlags: ["--encoding=UTF8", "--no-locale"],
    onLog: () => {
      // Keep test output clean unless an error occurs.
    },
    onError: (err) => {
      const text = err instanceof Error ? err.message : String(err);
      if (text.trim().length > 0 && process.env["DEBUG_PG"] === "1") {
        process.stderr.write(`[embedded-postgres] ${text}\n`);
      }
    },
  });

  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase(dbName);

  const connectionString = `postgresql://${user}:${password}@127.0.0.1:${port}/${dbName}`;
  const pool = createPgPool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  return {
    connectionString,
    pool,
    isEmbedded: true,
    async stop(): Promise<void> {
      await pool.end();
      await embedded.stop();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
