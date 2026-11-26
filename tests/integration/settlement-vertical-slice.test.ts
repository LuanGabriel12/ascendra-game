import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { FakeWorldEventSource } from "../../src/adapters/neon/fake-world-event-source.js";
import { PostgresFactionRepository } from "../../src/modules/factions/infrastructure/postgres-faction-repository.js";
import {
  InvalidSettlementStateTransitionError,
  SettlementConcurrencyConflictError,
} from "../../src/modules/settlements/domain/errors.js";
import { SettlementEventHandler } from "../../src/modules/settlements/application/settlement-event-handler.js";
import {
  PostgresSettlementRepository,
  PostgresSettlementUnitOfWork,
} from "../../src/modules/settlements/infrastructure/postgres-settlement-unit-of-work.js";
import { BoundaryValidationError } from "../../src/shared/contracts/world-events.js";
import {
  listAppliedMigrations,
  migrateDown,
  migrateUp,
} from "../../src/shared/db/migrator.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPgErrorCode(error: unknown, expectedSqlState: string): void {
  assert.ok(error instanceof pg.DatabaseError, `Expected pg.DatabaseError, got ${String(error)}`);
  assert.equal(error.code, expectedSqlState);
}

describe("CARBON Vertical Slice 01 — Settlement State Persistence (Real PostgreSQL)", () => {
  let pgCtx: RunningPostgresTestContext;
  let factionRepo: PostgresFactionRepository;
  let settlementRepo: PostgresSettlementRepository;
  let unitOfWork: PostgresSettlementUnitOfWork;
  let neonFake: FakeWorldEventSource;

  before(async () => {
    pgCtx = await startPostgresTestContext();
    factionRepo = new PostgresFactionRepository(pgCtx.pool);
    settlementRepo = new PostgresSettlementRepository(pgCtx.pool);
    unitOfWork = new PostgresSettlementUnitOfWork(pgCtx.pool);
    neonFake = new FakeWorldEventSource();
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("1. Migration lifecycle: applies cleanly on empty DB, supports rollback (down), and re-applies idempotently", async () => {
    // Ensure clean starting point if running against pre-populated external DB
    const preExisting = await listAppliedMigrations(pgCtx.pool);
    if (preExisting.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, preExisting.length);
    }

    const firstApply = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(firstApply, ["0001_carbon_settlement_slice"]);

    const tablesAfterUp = await pgCtx.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('factions', 'settlements', 'processed_events', 'settlement_history', 'outbox_events')
       ORDER BY table_name ASC`,
    );
    assert.deepEqual(
      tablesAfterUp.rows.map((r) => r.table_name),
      ["factions", "outbox_events", "processed_events", "settlement_history", "settlements"],
    );

    // Rollback (down) must cleanly drop slice tables
    const rolledBack = await migrateDown(pgCtx.pool, MIGRATIONS_DIR, 1);
    assert.deepEqual(rolledBack, ["0001_carbon_settlement_slice"]);

    const tablesAfterDown = await pgCtx.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('factions', 'settlements', 'processed_events', 'settlement_history', 'outbox_events')`,
    );
    assert.equal(tablesAfterDown.rowCount, 0);

    // Re-apply on empty schema + verify idempotent second migrateUp over existing schema
    const secondApply = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(secondApply, ["0001_carbon_settlement_slice"]);

    const noopApply = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.deepEqual(noopApply, []);
  });

  it("2. Happy path: persists SettlementCaptured and SettlementLiberated atomically with history and outbox", async () => {
    const logLines: string[] = [];
    const logger = new StructuredLogger("info", (line) => logLines.push(line));
    const handler = new SettlementEventHandler({ unitOfWork, logger });

    const defenderFaction = await factionRepo.create({
      id: randomUUID(),
      code: `iron_wardens_${randomUUID().slice(0, 8)}`,
      name: "Iron Wardens",
      isPlayable: true,
    });
    const invaderFaction = await factionRepo.create({
      id: randomUUID(),
      code: `cinder_clan_${randomUUID().slice(0, 8)}`,
      name: "Cinder Clan",
      isPlayable: false,
    });

    const settlement = await settlementRepo.create({
      id: randomUUID(),
      name: "Vaelgard Crossing",
      regionId: "ashen-march",
      state: "under_attack",
      controllingFactionId: defenderFaction.id,
    });

    const captureEvent = neonFake.buildSettlementCaptured({
      settlementId: settlement.id,
      capturingFactionId: invaderFaction.id,
      occurredAt: new Date("2026-11-26T12:00:00.000Z"),
    });

    const captureResult = await handler.handle(captureEvent);
    assert.equal(captureResult.status, "applied");
    if (captureResult.status !== "applied") {
      assert.fail("Expected applied status");
    }
    assert.equal(captureResult.newState, "occupied");
    assert.equal(captureResult.newVersion, 2);
    assert.equal(captureResult.controllingFactionId, invaderFaction.id);

    const liberateEvent = neonFake.buildSettlementLiberated({
      settlementId: settlement.id,
      liberatingFactionId: defenderFaction.id,
      occurredAt: new Date("2026-11-26T13:00:00.000Z"),
    });

    const liberateResult = await handler.handle(liberateEvent);
    assert.equal(liberateResult.status, "applied");
    if (liberateResult.status !== "applied") {
      assert.fail("Expected applied status");
    }
    assert.equal(liberateResult.newState, "rebuilding");
    assert.equal(liberateResult.newVersion, 3);
    assert.equal(liberateResult.controllingFactionId, defenderFaction.id);

    const persisted = await settlementRepo.findById(settlement.id);
    assert.ok(persisted);
    assert.equal(persisted.state, "rebuilding");
    assert.equal(persisted.version, 3);
    assert.equal(persisted.controllingFactionId, defenderFaction.id);

    const history = await settlementRepo.listHistory(settlement.id);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.settlementVersion, 2);
    assert.equal(history[0]?.previousState, "under_attack");
    assert.equal(history[0]?.newState, "occupied");
    assert.equal(history[0]?.causeEventId, captureEvent.event_id);

    assert.equal(history[1]?.settlementVersion, 3);
    assert.equal(history[1]?.previousState, "occupied");
    assert.equal(history[1]?.newState, "rebuilding");
    assert.equal(history[1]?.causeEventId, liberateEvent.event_id);

    const outbox = await settlementRepo.listOutboxByAggregate(settlement.id);
    assert.equal(outbox.length, 2);
    assert.equal(outbox[0]?.eventType, "SettlementStateChanged");
    assert.equal(outbox[0]?.payload.settlement_version, 2);
    assert.equal(outbox[0]?.publishedAt, null);
    assert.equal(outbox[1]?.payload.settlement_version, 3);

    // Verify structured observability output
    assert.equal(logLines.length, 2);
    const parsedFirstLog = JSON.parse(logLines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsedFirstLog["event_id"], captureEvent.event_id);
    assert.equal(parsedFirstLog["correlation_id"], captureEvent.correlation_id);
    assert.equal(parsedFirstLog["aggregate_id"], settlement.id);
    assert.equal(parsedFirstLog["result"], "applied");
  });

  it("3. Idempotency: duplicate deliveries (sequential 3x and parallel 5x) apply state transition exactly once", async () => {
    const logger = new StructuredLogger("silent");
    const handler = new SettlementEventHandler({ unitOfWork, logger });

    const factionA = await factionRepo.create({
      id: randomUUID(),
      code: `dawn_accord_${randomUUID().slice(0, 8)}`,
      name: "Dawn Accord",
    });
    const factionB = await factionRepo.create({
      id: randomUUID(),
      code: `thorn_legion_${randomUUID().slice(0, 8)}`,
      name: "Thorn Legion",
    });

    const settlement = await settlementRepo.create({
      id: randomUUID(),
      name: "Mirewatch",
      regionId: "sunken-fen",
      state: "threatened",
      controllingFactionId: factionA.id,
    });

    const sharedKey = `capture:${settlement.id}:wave-01`;
    const event = neonFake.buildSettlementCaptured({
      settlementId: settlement.id,
      capturingFactionId: factionB.id,
      idempotencyKey: sharedKey,
    });

    // Sequential 1st, 2nd, 3rd delivery
    const r1 = await handler.handle(event);
    const r2 = await handler.handle(event);
    const r3 = await handler.handle(event);

    assert.equal(r1.status, "applied");
    assert.equal(r2.status, "duplicate_noop");
    assert.equal(r3.status, "duplicate_noop");

    // Different event_id carrying the same logical idempotency_key must also no-op safely
    const rewrappedDuplicate = neonFake.buildSettlementCaptured({
      settlementId: settlement.id,
      capturingFactionId: factionB.id,
      eventId: randomUUID(),
      idempotencyKey: sharedKey,
    });
    const r4 = await handler.handle(rewrappedDuplicate);
    assert.equal(r4.status, "duplicate_noop");

    const afterCapture = await settlementRepo.findById(settlement.id);
    assert.equal(afterCapture?.version, 2);
    assert.equal((await settlementRepo.listHistory(settlement.id)).length, 1);
    assert.equal((await settlementRepo.listOutboxByAggregate(settlement.id)).length, 1);

    // Parallel 5x simultaneous delivery of the exact same liberation event across pool clients
    const liberateEvent = neonFake.buildSettlementLiberated({
      settlementId: settlement.id,
      liberatingFactionId: factionA.id,
    });

    const parallelResults = await Promise.all([
      handler.handle(liberateEvent),
      handler.handle(liberateEvent),
      handler.handle(liberateEvent),
      handler.handle(liberateEvent),
      handler.handle(liberateEvent),
    ]);

    const appliedCount = parallelResults.filter((r) => r.status === "applied").length;
    const noopCount = parallelResults.filter((r) => r.status === "duplicate_noop").length;
    assert.equal(appliedCount, 1);
    assert.equal(noopCount, 4);

    const finalSettlement = await settlementRepo.findById(settlement.id);
    assert.equal(finalSettlement?.version, 3);
    assert.equal(finalSettlement?.state, "rebuilding");
    assert.equal((await settlementRepo.listHistory(settlement.id)).length, 2);
    assert.equal((await settlementRepo.listOutboxByAggregate(settlement.id)).length, 2);
  });

  it("4. Rollback atomicity: forced error before commit leaves zero partial state and allows clean retry", async () => {
    const logger = new StructuredLogger("silent");

    const defender = await factionRepo.create({
      id: randomUUID(),
      code: `stone_oath_${randomUUID().slice(0, 8)}`,
      name: "Stone Oath",
    });
    const attacker = await factionRepo.create({
      id: randomUUID(),
      code: `void_reavers_${randomUUID().slice(0, 8)}`,
      name: "Void Reavers",
    });

    const settlement = await settlementRepo.create({
      id: randomUUID(),
      name: "Craghold",
      regionId: "granite-peaks",
      state: "under_attack",
      controllingFactionId: defender.id,
    });

    const failingHandler = new SettlementEventHandler({
      unitOfWork,
      logger,
      beforeCommitHook: async () => {
        throw new Error("Simulated mid-transaction failure after SQL writes");
      },
    });

    const captureEvent = neonFake.buildSettlementCaptured({
      settlementId: settlement.id,
      capturingFactionId: attacker.id,
    });

    await assert.rejects(
      () => failingHandler.handle(captureEvent),
      /Simulated mid-transaction failure/,
    );

    // Verify zero partial state across all 4 tables
    const unchanged = await settlementRepo.findById(settlement.id);
    assert.ok(unchanged);
    assert.equal(unchanged.state, "under_attack");
    assert.equal(unchanged.version, 1);
    assert.equal(unchanged.controllingFactionId, defender.id);
    assert.equal(await settlementRepo.countProcessedEvents(captureEvent.event_id), 0);
    assert.equal((await settlementRepo.listHistory(settlement.id)).length, 0);
    assert.equal((await settlementRepo.listOutboxByAggregate(settlement.id)).length, 0);

    // Retry the exact same event on healthy handler -> must succeed because processed_events rolled back
    const healthyHandler = new SettlementEventHandler({ unitOfWork, logger });
    const retryResult = await healthyHandler.handle(captureEvent);
    assert.equal(retryResult.status, "applied");
    assert.equal((await settlementRepo.findById(settlement.id))?.version, 2);
  });

  it("5. Concurrency: simultaneous Capture vs Liberate contends safely on row lock (SELECT ... FOR UPDATE) without corruption", async () => {
    const logger = new StructuredLogger("silent");

    const defender = await factionRepo.create({
      id: randomUUID(),
      code: `silver_watch_${randomUUID().slice(0, 8)}`,
      name: "Silver Watch",
    });
    const invader = await factionRepo.create({
      id: randomUUID(),
      code: `blood_tusk_${randomUUID().slice(0, 8)}`,
      name: "Blood Tusk",
    });
    const rivalInvader = await factionRepo.create({
      id: randomUUID(),
      code: `frost_maw_${randomUUID().slice(0, 8)}`,
      name: "Frost Maw",
    });

    // Sub-case 5a: Process A (Capture) acquires row lock first while Process B (Liberate) arrives concurrently
    const contestedSettlementA = await settlementRepo.create({
      id: randomUUID(),
      name: "Sunspire Outpost",
      regionId: "red-dunes",
      state: "under_attack",
      controllingFactionId: defender.id,
    });

    let captureEnteredRowLock!: () => void;
    const captureLockedSignal = new Promise<void>((resolve) => {
      captureEnteredRowLock = resolve;
    });

    const captureEventA = neonFake.buildSettlementCaptured({
      settlementId: contestedSettlementA.id,
      capturingFactionId: invader.id,
      occurredAt: new Date("2026-11-26T14:00:00.000Z"),
    });
    const liberateEventA = neonFake.buildSettlementLiberated({
      settlementId: contestedSettlementA.id,
      liberatingFactionId: defender.id,
      occurredAt: new Date("2026-11-26T14:00:01.000Z"),
    });

    const handlerCaptureHoldingLock = new SettlementEventHandler({
      unitOfWork,
      logger,
      beforeCommitHook: async ({ eventId }) => {
        if (eventId === captureEventA.event_id) {
          captureEnteredRowLock();
          await delay(80);
        }
      },
    });
    const concurrentHandler = new SettlementEventHandler({ unitOfWork, logger });

    const processAPromise = handlerCaptureHoldingLock.handle(captureEventA);
    await captureLockedSignal;
    const processBPromise = concurrentHandler.handle(liberateEventA);

    const [outcomeA, outcomeB] = await Promise.all([processAPromise, processBPromise]);
    assert.equal(outcomeA.status, "applied");
    assert.equal(outcomeB.status, "applied");

    const finalA = await settlementRepo.findById(contestedSettlementA.id);
    assert.ok(finalA);
    assert.equal(finalA.version, 3);
    assert.equal(finalA.state, "rebuilding");
    assert.equal(finalA.controllingFactionId, defender.id);

    const historyA = await settlementRepo.listHistory(contestedSettlementA.id);
    assert.equal(historyA.length, 2);
    assert.equal(historyA[0]?.settlementVersion, 2);
    assert.equal(historyA[0]?.newState, "occupied");
    assert.equal(historyA[1]?.settlementVersion, 3);
    assert.equal(historyA[1]?.previousState, "occupied");
    assert.equal(historyA[1]?.newState, "rebuilding");

    // Sub-case 5b: Reversed race — Liberate locks first (under_attack -> peaceful), Capture wakes up and rejects cleanly
    const contestedSettlementB = await settlementRepo.create({
      id: randomUUID(),
      name: "amberbrook",
      regionId: "green-hollow",
      state: "under_attack",
      controllingFactionId: defender.id,
    });

    let liberateEnteredRowLock!: () => void;
    const liberateLockedSignal = new Promise<void>((resolve) => {
      liberateEnteredRowLock = resolve;
    });

    const liberateFirstEvent = neonFake.buildSettlementLiberated({
      settlementId: contestedSettlementB.id,
      liberatingFactionId: defender.id,
    });
    const staleCaptureEvent = neonFake.buildSettlementCaptured({
      settlementId: contestedSettlementB.id,
      capturingFactionId: invader.id,
    });

    const handlerLiberateHoldingLock = new SettlementEventHandler({
      unitOfWork,
      logger,
      beforeCommitHook: async ({ eventId }) => {
        if (eventId === liberateFirstEvent.event_id) {
          liberateEnteredRowLock();
          await delay(80);
        }
      },
    });

    const pLib = handlerLiberateHoldingLock.handle(liberateFirstEvent);
    await liberateLockedSignal;
    const pCap = concurrentHandler.handle(staleCaptureEvent);

    const [settledLib, settledCap] = await Promise.allSettled([pLib, pCap]);
    assert.equal(settledLib.status, "fulfilled");
    assert.equal(settledCap.status, "rejected");
    assert.ok(settledCap.reason instanceof InvalidSettlementStateTransitionError);

    const finalB = await settlementRepo.findById(contestedSettlementB.id);
    assert.equal(finalB?.version, 2);
    assert.equal(finalB?.state, "peaceful");
    assert.equal(await settlementRepo.countProcessedEvents(staleCaptureEvent.event_id), 0);

    // Sub-case 5c: Two rival captures both pinning expected_settlement_version = 1 -> deterministic conflict
    const contestedSettlementC = await settlementRepo.create({
      id: randomUUID(),
      name: "Duskwatch Keep",
      regionId: "storm-coast",
      state: "under_attack",
      controllingFactionId: defender.id,
    });

    const rivalEvent1 = neonFake.buildSettlementCaptured({
      settlementId: contestedSettlementC.id,
      capturingFactionId: invader.id,
      expectedSettlementVersion: 1,
    });
    const rivalEvent2 = neonFake.buildSettlementCaptured({
      settlementId: contestedSettlementC.id,
      capturingFactionId: rivalInvader.id,
      expectedSettlementVersion: 1,
    });

    const rivalOutcomes = await Promise.allSettled([
      concurrentHandler.handle(rivalEvent1),
      concurrentHandler.handle(rivalEvent2),
    ]);

    const fulfilled = rivalOutcomes.filter((o) => o.status === "fulfilled");
    const rejected = rivalOutcomes.filter(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof SettlementConcurrencyConflictError);
    assert.equal((await settlementRepo.findById(contestedSettlementC.id))?.version, 2);
  });

  it("6. Structural DB constraints & boundary security: enforces UNIQUE, FOREIGN KEY, CHECK, and strict input validation", async () => {
    // 6a. Duplicate idempotency_key in processed_events (SQLSTATE 23505)
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const duplicateKey = `idem-constraint-${randomUUID()}`;

    await pgCtx.pool.query(
      `INSERT INTO processed_events (
         event_id, idempotency_key, event_type, event_version, source, correlation_id, aggregate_id, occurred_at
       ) VALUES ($1, $2, 'SettlementCaptured', 1, 'test', $3, $4, NOW())`,
      [firstEventId, duplicateKey, randomUUID(), randomUUID()],
    );

    let uniqueErr: unknown;
    try {
      await pgCtx.pool.query(
        `INSERT INTO processed_events (
           event_id, idempotency_key, event_type, event_version, source, correlation_id, aggregate_id, occurred_at
         ) VALUES ($1, $2, 'SettlementCaptured', 1, 'test', $3, $4, NOW())`,
        [secondEventId, duplicateKey, randomUUID(), randomUUID()],
      );
    } catch (err) {
      uniqueErr = err;
    }
    assertPgErrorCode(uniqueErr, "23505");

    // 6b. Invalid controlling_faction_id FOREIGN KEY on settlements (SQLSTATE 23503)
    let fkErr: unknown;
    try {
      await pgCtx.pool.query(
        `INSERT INTO settlements (id, name, region_id, state, controlling_faction_id, version)
         VALUES ($1, 'Ghost Town', 'nowhere', 'peaceful', $2, 1)`,
        [randomUUID(), randomUUID()],
      );
    } catch (err) {
      fkErr = err;
    }
    assertPgErrorCode(fkErr, "23503");

    // 6c. CHECK constraint: occupied settlement without controlling_faction_id (SQLSTATE 23514)
    let checkErr: unknown;
    try {
      await pgCtx.pool.query(
        `INSERT INTO settlements (id, name, region_id, state, controlling_faction_id, version)
         VALUES ($1, 'Broken Hold', 'nowhere', 'occupied', NULL, 1)`,
        [randomUUID()],
      );
    } catch (err) {
      checkErr = err;
    }
    assertPgErrorCode(checkErr, "23514");

    // 6d. Strict boundary rejection & sensitive log redaction
    const capturedLogs: string[] = [];
    const logger = new StructuredLogger("info", (line) => capturedLogs.push(line));
    logger.info("Boot check", {
      operation: "boot",
      database_url: "postgresql://secret_user:super_secret_pw@localhost:5432/db",
      token: "bearer-secret-token",
    });
    const loggedObj = JSON.parse(capturedLogs[0] ?? "{}") as Record<string, unknown>;
    assert.equal(loggedObj["database_url"], "[REDACTED]");
    assert.equal(loggedObj["token"], "[REDACTED]");

    const handler = new SettlementEventHandler({ unitOfWork, logger });
    await assert.rejects(
      () =>
        handler.handle({
          event_id: randomUUID(),
          event_type: "SettlementCaptured",
          version: 1,
          occurred_at: new Date().toISOString(),
          correlation_id: randomUUID(),
          source: "untrusted-client",
          payload: {
            settlement_id: randomUUID(),
            capturing_faction_id: randomUUID(),
            untrusted_gold_bonus: 999999, // Must be rejected by strict schema
          },
        }),
      BoundaryValidationError,
    );
  });
});
