import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecordContributionService } from "../modules/contributions/application/record-contribution-service.js";
import { serializeContributionWireV1 } from "../modules/contributions/contracts/contribution-contracts.js";
import {
  PostgresContributionRepository,
  PostgresContributionUnitOfWork,
} from "../modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { PostgresFactionRepository } from "../modules/factions/infrastructure/postgres-faction-repository.js";
import {
  PostgresSettlementSnapshotReader,
  serializeSettlementSnapshotWireV1,
} from "../modules/settlements/application/settlement-snapshot-query.js";
import { PostgresSettlementRepository } from "../modules/settlements/infrastructure/postgres-settlement-unit-of-work.js";
import { migrateUp } from "../shared/db/migrator.js";
import { InboxIdempotencyConflictError } from "../shared/db/processed-events-inbox.js";
import { StructuredLogger } from "../shared/observability/logger.js";
import { startPostgresTestContext } from "../../tests/helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const FIXTURES_PATH = path.resolve(
  __dirname,
  "../../contracts/fixtures/neon-carbon-contract-vectors.json",
);

interface FixturesDocument {
  settlement_snapshots: {
    valid_valewatch: {
      settlement_id: string;
      region_id: string;
      defense_state: "Secure" | "Fortified" | "Damaged" | "Captured";
      max_defense_hp: string;
    };
  };
  contributions: {
    valid_contribution_result: Record<string, unknown>;
    duplicate_identical_reordered: Record<string, unknown>;
    duplicate_conflicting_payload: Record<string, unknown>;
  };
}

async function runIntegratedDemo(): Promise<void> {
  const logger = new StructuredLogger("info");
  logger.info("Starting CARBON Session 02 integrated reproducible demonstration", {
    operation: "demo:start",
    note: "Go toolchain is not installed on this host; NEON payloads are loaded from shared cross-language JSON fixtures matching internal/ports/carbon.go.",
  });

  // 1. Initialize real PostgreSQL
  const pgCtx = await startPostgresTestContext();

  try {
    // 2. Apply migrations (0001, 0002, 0003)
    const appliedMigrations = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    logger.info("Step 2 complete: Migrations ready", {
      operation: "demo:migrate",
      applied: appliedMigrations,
    });

    // 3. Load shared fixtures
    const rawFixtures = await readFile(FIXTURES_PATH, "utf8");
    const fixtures = JSON.parse(rawFixtures) as FixturesDocument;
    const valewatchFixture = fixtures.settlement_snapshots.valid_valewatch;

    // 4. Create or query settlement `settlement-valewatch`
    const factionRepo = new PostgresFactionRepository(pgCtx.pool);
    const settlementRepo = new PostgresSettlementRepository(pgCtx.pool);

    let settlement = await settlementRepo.findByExternalId(valewatchFixture.settlement_id);
    if (!settlement) {
      const wardens = await factionRepo.create({
        id: randomUUID(),
        code: `ashvale_wardens_${randomUUID().slice(0, 6)}`,
        name: "Ashvale Wardens",
        isPlayable: true,
      });
      settlement = await settlementRepo.create({
        id: randomUUID(),
        externalId: valewatchFixture.settlement_id,
        name: "Valewatch",
        regionId: valewatchFixture.region_id,
        state: "peaceful",
        defenseState: valewatchFixture.defense_state,
        maxDefenseHp: BigInt(valewatchFixture.max_defense_hp),
        controllingFactionId: wardens.id,
      });
    }

    // 5. Produce projection consumed by NEON (`SettlementSnapshot`)
    const snapshotReader = new PostgresSettlementSnapshotReader(pgCtx.pool);
    const projection = await snapshotReader.getSettlementSnapshot(valewatchFixture.settlement_id);
    const snapshotWire = serializeSettlementSnapshotWireV1(projection);
    assert.equal(snapshotWire.settlement_id, "settlement-valewatch");
    assert.equal(snapshotWire.defense_state, "Secure");
    assert.equal(snapshotWire.max_defense_hp, "1000");
    logger.info("Step 5 complete: Projected SettlementSnapshot for NEON", {
      operation: "demo:snapshot",
      snapshot: snapshotWire,
    });

    // 6–9. Receive ContributionResult, validate, persist inbox event + contribution + outbox
    let contribUoW = new PostgresContributionUnitOfWork(pgCtx.pool);
    let contribRepo = new PostgresContributionRepository(pgCtx.pool);
    let contribService = new RecordContributionService({
      unitOfWork: contribUoW,
      logger,
      requireRegisteredSettlement: true,
    });

    const firstOutcome = await contribService.record(
      fixtures.contributions.valid_contribution_result,
    );
    assert.equal(firstOutcome.status, "applied");
    assert.equal(firstOutcome.duplicate, false);

    // 10. Query recorded contribution
    const targetEventId = String(fixtures.contributions.valid_contribution_result["event_id"]);
    const queried = await contribRepo.findByExternalEventId(targetEventId);
    assert.ok(queried);
    assert.equal(queried.damage, 425n);
    assert.equal(queried.resolvedSettlementId, settlement.id);
    logger.info("Step 10 complete: Queried persisted contribution", {
      operation: "demo:query_contribution",
      contribution: serializeContributionWireV1(queried),
    });

    // 11–12. Re-deliver original event (with reordered keys) and confirm zero duplication
    const retryOutcome = await contribService.record(
      fixtures.contributions.duplicate_identical_reordered,
    );
    assert.equal(retryOutcome.status, "duplicate_idempotent");
    assert.equal(retryOutcome.duplicate, true);
    const outboxAfterRetry = await contribRepo.listOutboxByContributionId(queried.id);
    assert.equal(outboxAfterRetry.length, 1);
    assert.equal(outboxAfterRetry[0]?.publishedAt, null);

    // 13–14. Send conflicting payload with same EventID and confirm permanent rejection
    let conflictRejected = false;
    try {
      await contribService.record(fixtures.contributions.duplicate_conflicting_payload);
    } catch (err) {
      if (err instanceof InboxIdempotencyConflictError) {
        conflictRejected = true;
      } else {
        throw err;
      }
    }
    assert.equal(conflictRejected, true, "Conflicting duplicate event must be rejected");
    logger.info("Step 14 complete: Conflicting duplicate rejected without mutating stored record", {
      operation: "demo:conflict_verified",
      event_id: targetEventId,
      result: "rejected_conflict",
    });

    // 15. Restart PostgreSQL / reconnect pool and verify durable state survives intact
    const reconnectedPool = await pgCtx.restartAndReconnect();
    const postRestartSnapshotReader = new PostgresSettlementSnapshotReader(reconnectedPool);
    contribUoW = new PostgresContributionUnitOfWork(reconnectedPool);
    contribRepo = new PostgresContributionRepository(reconnectedPool);
    contribService = new RecordContributionService({
      unitOfWork: contribUoW,
      logger,
      requireRegisteredSettlement: true,
    });

    const postRestartSnapshot = await postRestartSnapshotReader.getSettlementSnapshot(
      "settlement-valewatch",
    );
    const postRestartContrib = await contribRepo.findByExternalEventId(targetEventId);
    assert.ok(postRestartContrib);
    assert.equal(postRestartSnapshot.maxDefenseHp, 1000n);
    assert.equal(postRestartContrib.damage, 425n);
    assert.equal(postRestartContrib.outcome, "Defended");

    // Post-restart retry still deduplicates cleanly
    const postRestartRetry = await contribService.record(
      fixtures.contributions.valid_contribution_result,
    );
    assert.equal(postRestartRetry.status, "duplicate_idempotent");

    logger.info("Step 15 complete: Durable state verified after PostgreSQL restart/reconnection", {
      operation: "demo:complete",
      result: "ok",
      embedded_postgres_restarted: pgCtx.isEmbedded,
    });
  } finally {
    await pgCtx.stop();
  }
}

runIntegratedDemo().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Integrated demo failed: ${msg}\n`);
  process.exitCode = 1;
});
