import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../shared/config/env.js";
import { createPgPool } from "../shared/db/pool.js";
import { listAppliedMigrations, migrateDown, migrateUp } from "../shared/db/migrator.js";
import { StructuredLogger } from "../shared/observability/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new StructuredLogger(env.LOG_LEVEL);
  const command = process.argv[2] ?? "status";

  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Configure DATABASE_URL (see .env.example) to run standalone CLI migrations.",
    );
  }

  const pool = createPgPool({
    connectionString: env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    if (command === "up") {
      const applied = await migrateUp(pool, DEFAULT_MIGRATIONS_DIR);
      logger.info("Migrations applied", {
        operation: "migrate:up",
        result: "ok",
        applied_count: applied.length,
        migrations: applied,
      });
    } else if (command === "down") {
      const rolledBack = await migrateDown(pool, DEFAULT_MIGRATIONS_DIR, 1);
      logger.info("Migrations rolled back", {
        operation: "migrate:down",
        result: "ok",
        rolled_back_count: rolledBack.length,
        migrations: rolledBack,
      });
    } else if (command === "status") {
      const current = await listAppliedMigrations(pool);
      logger.info("Migration status", {
        operation: "migrate:status",
        result: "ok",
        applied_count: current.length,
        migrations: current.map((m) => `${m.version}_${m.name}`),
      });
    } else {
      throw new Error(`Unknown migrate command '${command}'. Expected 'up', 'down', or 'status'.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Migration CLI failed: ${message}\n`);
  process.exitCode = 1;
});
