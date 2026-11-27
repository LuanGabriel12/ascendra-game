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
  /**
   * Restarts the underlying embedded PostgreSQL server process (when `isEmbedded === true`)
   * or cycles the connection pool (`isEmbedded === false`) to test durable crash/restart recovery.
   */
  restartAndReconnect(): Promise<PgPool>;
  stop(): Promise<void>;
}

const SAFE_TEST_DB_NAME_RE = /(?:_test|_ci)(?:_[a-z0-9]+)?$/i;
const LOOPBACK_TEST_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertSafeTestDatabaseUrl(connectionString: string): void {
  if (process.env["ALLOW_EXTERNAL_TEST_DB"] === "1") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Invalid DATABASE_URL provided to test harness.");
  }

  const host = parsed.hostname.trim().toLowerCase();
  if (!LOOPBACK_TEST_HOSTS.has(host)) {
    throw new Error(
      `Refusing to execute destructive integration tests against non-loopback host '${host}'. Set ALLOW_EXTERNAL_TEST_DB=1 explicitly only for isolated disposable test containers.`,
    );
  }

  const dbName = parsed.pathname.replace(/^\//, "").trim();
  if (!SAFE_TEST_DB_NAME_RE.test(dbName)) {
    throw new Error(
      `Refusing to execute destructive integration test migrations against non-disposable database '${dbName}'. Database name must end with '_test' or '_ci' (or set ALLOW_EXTERNAL_TEST_DB=1 explicitly).`,
    );
  }
}

export async function allocateFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve ephemeral loopback TCP port."));
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
 * Provides an isolated, disposable real PostgreSQL instance for integration testing:
 * - When `DATABASE_URL` is configured (GitHub Actions CI service container or disposable `_test` DB),
 *   verifies the target database is explicitly marked `_test` / `_ci` before connecting.
 * - Otherwise, launches an isolated native PostgreSQL cluster bound exclusively to `127.0.0.1`
 *   in a disposable temp directory (`persistent: true` during test lifecycle so `restartAndReconnect()`
 *   can test real PostgreSQL server stop/start durability, then deleted in `stop()`).
 */
export async function startPostgresTestContext(): Promise<RunningPostgresTestContext> {
  const externalUrl = process.env["DATABASE_URL"];
  if (externalUrl && externalUrl.trim().length > 0) {
    assertSafeTestDatabaseUrl(externalUrl);
    let currentPool = createPgPool({
      connectionString: externalUrl,
      max: 12,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await currentPool.query("SELECT 1");
    return {
      connectionString: externalUrl,
      get pool(): PgPool {
        return currentPool;
      },
      isEmbedded: false,
      async restartAndReconnect(): Promise<PgPool> {
        await currentPool.end();
        currentPool = createPgPool({
          connectionString: externalUrl,
          max: 12,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 5000,
        });
        await currentPool.query("SELECT 1");
        return currentPool;
      },
      async stop(): Promise<void> {
        await currentPool.end();
      },
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ascendra-pg-test-"));
  const dbClusterDir = path.join(tempDir, "cluster");
  const port = await allocateFreeLoopbackPort();
  const user = "postgres";
  const password = "ephemeral_test_pw";
  const dbName = "ascendra_test";

  const createEmbeddedInstance = (): EmbeddedPostgres =>
    new EmbeddedPostgres({
      databaseDir: dbClusterDir,
      port,
      user,
      password,
      authMethod: "password",
      persistent: true,
      autoRehydrateSymlinks: true,
      initdbFlags: ["--encoding=UTF8", "--no-locale"],
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {
        // Keep test output clean unless debugging.
      },
      onError: (err) => {
        const text = err instanceof Error ? err.message : String(err);
        if (text.trim().length > 0 && process.env["DEBUG_PG"] === "1") {
          process.stderr.write(`[embedded-postgres] ${text}\n`);
        }
      },
    });

  let embedded = createEmbeddedInstance();
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase(dbName);

  const connectionString = `postgresql://${user}:${password}@127.0.0.1:${port}/${dbName}`;
  let currentPool = createPgPool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  return {
    connectionString,
    get pool(): PgPool {
      return currentPool;
    },
    isEmbedded: true,
    async restartAndReconnect(): Promise<PgPool> {
      await currentPool.end();
      await embedded.stop();
      embedded = createEmbeddedInstance();
      await embedded.start();
      currentPool = createPgPool({
        connectionString,
        max: 12,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      });
      await currentPool.query("SELECT 1");
      return currentPool;
    },
    async stop(): Promise<void> {
      await currentPool.end();
      await embedded.stop();
      await rm(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}
