import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeWorldEventSource } from "../../src/adapters/neon/fake-world-event-source.js";
import { RecordContributionService } from "../../src/modules/contributions/application/record-contribution-service.js";
import {
  parseContributionSubmission,
  serializeContributionWireV1,
} from "../../src/modules/contributions/contracts/contribution-contracts.js";
import {
  DuplicateContributionError,
  InvalidContributionError,
  LogicalContributionConflictError,
} from "../../src/modules/contributions/domain/errors.js";
import {
  PostgresContributionRepository,
  PostgresContributionUnitOfWork,
} from "../../src/modules/contributions/infrastructure/postgres-contribution-unit-of-work.js";
import { PostgresFactionRepository } from "../../src/modules/factions/infrastructure/postgres-faction-repository.js";
import { SettlementEventHandler } from "../../src/modules/settlements/application/settlement-event-handler.js";
import {
  PostgresSettlementSnapshotReader,
  parseSettlementSnapshotWireV1,
  serializeSettlementSnapshotWireV1,
} from "../../src/modules/settlements/application/settlement-snapshot-query.js";
import {
  InvalidSettlementStateTransitionError,
  SettlementNotFoundError,
} from "../../src/modules/settlements/domain/errors.js";
import {
  PostgresSettlementRepository,
  PostgresSettlementUnitOfWork,
} from "../../src/modules/settlements/infrastructure/postgres-settlement-unit-of-work.js";
import { deriveDeterministicEventUuid } from "../../src/shared/contracts/canonical-fingerprint.js";
import { MAX_INT64, MAX_UINT64 } from "../../src/shared/contracts/int64-wire.js";
import { BoundaryValidationError } from "../../src/shared/contracts/world-events.js";
import {
  discoverMigrations,
  listAppliedMigrations,
  migrateDown,
  migrateUp,
} from "../../src/shared/db/migrator.js";
import { InboxIdempotencyConflictError } from "../../src/shared/db/processed-events-inbox.js";
import { StructuredLogger } from "../../src/shared/observability/logger.js";
import {
  validateAgainstJsonSchema,
  type JsonSchemaNode,
} from "../helpers/json-schema-assertion.js";
import {
  startPostgresTestContext,
  type RunningPostgresTestContext,
} from "../helpers/postgres-test-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const FIXTURES_PATH = path.resolve(
  __dirname,
  "../../contracts/fixtures/neon-carbon-contract-vectors.json",
);
const SNAPSHOT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/settlement-snapshot.v1.schema.json",
);
const CONTRIBUTION_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../contracts/neon-carbon/contribution-result.v1.schema.json",
);

interface FixturesFile {
  settlement_snapshots: Record<string, Record<string, unknown>>;
  contributions: Record<string, Record<string, unknown>>;
  raw_go_json_samples: {
    go_encoding_json_max_bounds: string;
  };
}

describe("CARBON Session 02 — SettlementSnapshot, Contribution Engine & Cross-Language Contracts", () => {
  let pgCtx: RunningPostgresTestContext;
  let fixtures: FixturesFile;
  let snapshotJsonSchema: JsonSchemaNode;
  let contributionJsonSchema: JsonSchemaNode;
  const silentLogger = new StructuredLogger("silent");

  before(async () => {
    pgCtx = await startPostgresTestContext();
    fixtures = JSON.parse(await readFile(FIXTURES_PATH, "utf8")) as FixturesFile;
    snapshotJsonSchema = JSON.parse(
      await readFile(SNAPSHOT_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
    contributionJsonSchema = JSON.parse(
      await readFile(CONTRIBUTION_SCHEMA_PATH, "utf8"),
    ) as JsonSchemaNode;
  });

  after(async () => {
    if (pgCtx) {
      await pgCtx.stop();
    }
  });

  it("Cases 2 & 3: Incremental migration over populated 0001 DB backfills safely, and clean empty DB migrates up/down/up across 0001..0003", async () => {
    const existing = await listAppliedMigrations(pgCtx.pool);
    if (existing.length > 0) {
      await migrateDown(pgCtx.pool, MIGRATIONS_DIR, existing.length);
    }

    // Apply ONLY 0001 manually through SQL to simulate an existing Session 01 production database
    const allMigrations = await discoverMigrations(MIGRATIONS_DIR);
    const mig0001 = allMigrations.find((m) => m.version === "0001");
    assert.ok(mig0001);
    const sql0001 = await readFile(mig0001.upPath, "utf8");

    await pgCtx.pool.query("BEGIN");
    await pgCtx.pool.query(sql0001);
    await pgCtx.pool.query(
      "INSERT INTO schema_migrations (version, name) VALUES ('0001', 'carbon_settlement_slice')",
    );
    await pgCtx.pool.query("COMMIT");

    // Seed Session 01 legacy rows (without external_id, defense_state, max_defense_hp, or payload_fingerprint)
    const legacyFactionId = randomUUID();
    const legacyOccupiedId = randomUUID();
    const legacyPeacefulId = randomUUID();
    const legacyEventId = randomUUID();
    const legacyCorrelationId = randomUUID();

    await pgCtx.pool.query(
      "INSERT INTO factions (id, code, name, is_playable) VALUES ($1, 'legacy_wardens', 'Legacy Wardens', TRUE)",
      [legacyFactionId],
    );
    await pgCtx.pool.query(
      "INSERT INTO settlements (id, name, region_id, state, controlling_faction_id, version) VALUES ($1, 'OldBastion', 'old-reach', 'occupied', $2, 2)",
      [legacyOccupiedId, legacyFactionId],
    );
    await pgCtx.pool.query(
      "INSERT INTO settlements (id, name, region_id, state, controlling_faction_id, version) VALUES ($1, 'QuietVale', 'old-reach', 'peaceful', $2, 1)",
      [legacyPeacefulId, legacyFactionId],
    );
    await pgCtx.pool.query(
      `INSERT INTO processed_events (event_id, idempotency_key, event_type, event_version, source, correlation_id, aggregate_id, occurred_at)
       VALUES ($1, $2, 'SettlementCaptured', 1, 'neon.legacy', $3, $4, NOW())`,
      [legacyEventId, legacyEventId, legacyCorrelationId, legacyOccupiedId],
    );

    // Run incremental migrateUp -> applies 0002, 0003, and any newer incremental migrations over existing 0001 data!
    const incrementalApplied = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.ok(incrementalApplied.includes("0002_settlement_snapshot_and_inbox_fingerprint"));
    assert.ok(incrementalApplied.includes("0003_gameplay_contributions"));

    // Verify explicit backfill on pre-existing 0001 settlements
    const snapshotReader = new PostgresSettlementSnapshotReader(pgCtx.pool);
    const snapOccupied = await snapshotReader.getSettlementSnapshot(legacyOccupiedId);
    assert.equal(snapOccupied.defenseState, "Captured");
    assert.equal(snapOccupied.maxDefenseHp, 1000n);
    assert.equal(snapOccupied.version, 2);

    const snapPeaceful = await snapshotReader.getSettlementSnapshot(legacyPeacefulId);
    assert.equal(snapPeaceful.defenseState, "Secure");
    assert.equal(snapPeaceful.maxDefenseHp, 1000n);

    // Verify conservative legacy processed_events duplicate policy (NULL fingerprint):
    // Matching metadata -> safe duplicate_noop; mismatched event_type/aggregate_id -> conflict!
    const settlementHandler = new SettlementEventHandler({
      unitOfWork: new PostgresSettlementUnitOfWork(pgCtx.pool),
      logger: silentLogger,
    });
    const fakeNeon = new FakeWorldEventSource("neon.legacy");
    const legacyMatchingRetry = fakeNeon.buildSettlementCaptured({
      eventId: legacyEventId,
      settlementId: legacyOccupiedId,
      capturingFactionId: legacyFactionId,
      correlationId: legacyCorrelationId,
    });
    const legacyNoop = await settlementHandler.handle(legacyMatchingRetry);
    assert.equal(legacyNoop.status, "duplicate_noop");

    const legacyMismatchedAggregate = fakeNeon.buildSettlementCaptured({
      eventId: legacyEventId,
      settlementId: legacyPeacefulId, // Different aggregate_id on same legacy event_id!
      capturingFactionId: legacyFactionId,
    });
    await assert.rejects(
      () => settlementHandler.handle(legacyMismatchedAggregate),
      InboxIdempotencyConflictError,
    );

    // Rollback all applied migrations dynamically to empty DB and re-apply cleanly from scratch (Case 3)
    const currentlyApplied = await listAppliedMigrations(pgCtx.pool);
    const rolledDownAll = await migrateDown(pgCtx.pool, MIGRATIONS_DIR, currentlyApplied.length);
    assert.ok(rolledDownAll.includes("0003_gameplay_contributions"));
    assert.ok(rolledDownAll.includes("0002_settlement_snapshot_and_inbox_fingerprint"));
    assert.ok(rolledDownAll.includes("0001_carbon_settlement_slice"));

    const cleanApplyAll = await migrateUp(pgCtx.pool, MIGRATIONS_DIR);
    assert.equal(cleanApplyAll.length, currentlyApplied.length);
    assert.ok(cleanApplyAll.includes("0001_carbon_settlement_slice"));
    assert.ok(cleanApplyAll.includes("0002_settlement_snapshot_and_inbox_fingerprint"));
    assert.ok(cleanApplyAll.includes("0003_gameplay_contributions"));
  });

  it("Cases 4, 5, 6 & 24: SettlementSnapshot projection, missing settlement, defense_state orthogonality, and settlement_history preservation", async () => {
    const factionRepo = new PostgresFactionRepository(pgCtx.pool);
    const settlementRepo = new PostgresSettlementRepository(pgCtx.pool);
    const snapshotReader = new PostgresSettlementSnapshotReader(pgCtx.pool);
    const settlementUoW = new PostgresSettlementUnitOfWork(pgCtx.pool);
    const handler = new SettlementEventHandler({ unitOfWork: settlementUoW, logger: silentLogger });
    const fakeNeon = new FakeWorldEventSource();

    const wardens = await factionRepo.create({
      id: randomUUID(),
      code: `ironford_guard_${randomUUID().slice(0, 6)}`,
      name: "Ironford Guard",
    });
    const raiders = await factionRepo.create({
      id: randomUUID(),
      code: `ash_warband_${randomUUID().slice(0, 6)}`,
      name: "Ash Warband",
    });

    // Peaceful settlement with Fortified defense_state and custom 1500 MaxDefenseHP (matching NEON fixture)
    const ironford = await settlementRepo.create({
      id: randomUUID(),
      externalId: "settlement-ironford",
      name: "Ironford",
      regionId: "region-thornreach",
      state: "under_attack",
      defenseState: "Fortified",
      maxDefenseHp: 1500n,
      controllingFactionId: wardens.id,
    });

    // Query by external non-UUID slug AND by internal UUID
    const bySlug = await snapshotReader.getSettlementSnapshot("settlement-ironford");
    const byUuid = await snapshotReader.getSettlementSnapshot(ironford.id);
    assert.deepEqual(bySlug, byUuid);
    assert.equal(bySlug.settlementId, "settlement-ironford");
    assert.equal(bySlug.regionId, "region-thornreach");
    assert.equal(bySlug.defenseState, "Fortified");
    assert.equal(bySlug.maxDefenseHp, 1500n);
    assert.equal(bySlug.version, 1);

    // Ensure internal fields (controllingFactionId, createdAt, name) are not leaked in wire projection
    const wire = serializeSettlementSnapshotWireV1(bySlug);
    assert.equal("controllingFactionId" in wire, false);
    assert.equal("name" in wire, false);

    // Case 5: Missing settlement raises SettlementNotFoundError
    await assert.rejects(
      () => snapshotReader.getSettlementSnapshot("settlement-does-not-exist"),
      SettlementNotFoundError,
    );

    // Case 6: Invalid lifecycle/defense combinations are rejected in domain
    assert.throws(
      () =>
        new (ironford.constructor as typeof import("../../src/modules/settlements/domain/settlement.js").Settlement)({
          id: randomUUID(),
          name: "Contradiction",
          regionId: "region-x",
          state: "peaceful",
          defenseState: "Captured",
          maxDefenseHp: 1000n,
          controllingFactionId: wardens.id,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      InvalidSettlementStateTransitionError,
    );

    // Case 24: Capture -> Occupied/Captured, Liberate -> Rebuilding/Damaged while preserving settlement_history
    const capEv = fakeNeon.buildSettlementCaptured({
      settlementId: ironford.id,
      capturingFactionId: raiders.id,
    });
    await handler.handle(capEv);
    const snapAfterCap = await snapshotReader.getSettlementSnapshot("settlement-ironford");
    assert.equal(snapAfterCap.defenseState, "Captured");
    assert.equal(snapAfterCap.version, 2);

    // Conflicting duplicate on SettlementCaptured (same event_id, different capturing_faction_id) -> rejected!
    await assert.rejects(
      () =>
        handler.handle(
          fakeNeon.buildSettlementCaptured({
            eventId: capEv.event_id,
            settlementId: ironford.id,
            capturingFactionId: wardens.id,
          }),
        ),
      InboxIdempotencyConflictError,
    );

    const libEv = fakeNeon.buildSettlementLiberated({
      settlementId: ironford.id,
      liberatingFactionId: wardens.id,
    });
    await handler.handle(libEv);
    const snapAfterLib = await snapshotReader.getSettlementSnapshot("settlement-ironford");
    assert.equal(snapAfterLib.defenseState, "Damaged");
    assert.equal(snapAfterLib.maxDefenseHp, 1500n);
    assert.equal(snapAfterLib.version, 3);

    const history = await settlementRepo.listHistory(ironford.id);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.newState, "occupied");
    assert.equal(history[1]?.newState, "rebuilding");
  });

  it("Cases 7, 8, 9, 10 & 23: Valid/invalid contributions, full int64 & uint64 precision (including raw Go JSON), and non-UUID deterministic IDs", async () => {
    const contribUoW = new PostgresContributionUnitOfWork(pgCtx.pool);
    const contribRepo = new PostgresContributionRepository(pgCtx.pool);
    const service = new RecordContributionService({ unitOfWork: contribUoW, logger: silentLogger });

    // Case 7 & 23: Valid non-UUID external IDs (`sim:ashvale-01:inv:siege-09:contrib:player-lyra`)
    const nonUuidFixture = fixtures.contributions["valid_non_uuid_external_id"]!;
    const expectedDetUuid1 = deriveDeterministicEventUuid(String(nonUuidFixture["event_id"]));
    const expectedDetUuid2 = deriveDeterministicEventUuid(String(nonUuidFixture["event_id"]));
    assert.equal(expectedDetUuid1, expectedDetUuid2, "Deterministic UUIDv5 must be stable across calls");

    const appliedNonUuid = await service.record(nonUuidFixture);
    assert.equal(appliedNonUuid.status, "applied");
    assert.equal(
      appliedNonUuid.contribution.externalEventId,
      "sim:ashvale-01:inv:siege-09:contrib:player-lyra",
    );
    assert.equal(appliedNonUuid.contribution.processedEventId, expectedDetUuid1);

    // Case 9: Max int64 (`9223372036854775807`)
    const maxI64Res = await service.record(fixtures.contributions["valid_max_int64"]);
    assert.equal(maxI64Res.status, "applied");
    assert.equal(maxI64Res.contribution.damage, MAX_INT64);
    assert.equal(maxI64Res.contribution.support, MAX_INT64);
    assert.equal(maxI64Res.contribution.objectives, MAX_INT64);

    // Case 10: Max uint64 (`18446744073709551615`) stored in PostgreSQL NUMERIC(20,0)
    const maxU64Res = await service.record(fixtures.contributions["valid_max_uint64"]);
    assert.equal(maxU64Res.status, "applied");
    assert.equal(maxU64Res.contribution.tick, MAX_UINT64);
    assert.equal(maxU64Res.contribution.eligible, false);
    assert.equal(maxU64Res.contribution.outcome, "Captured");

    // Raw Go `encoding/json` payload with unquoted 18446744073709551615 and 9223372036854775807
    const goRawRes = await service.recordFromWireJson(
      fixtures.raw_go_json_samples.go_encoding_json_max_bounds,
    );
    assert.equal(goRawRes.status, "applied");
    assert.equal(goRawRes.contribution.tick, 18446744073709551615n);
    assert.equal(goRawRes.contribution.damage, 9223372036854775807n);

    const reloadedGoRaw = await contribRepo.findByExternalEventId("sim:go-raw:inv:1:contrib:p1");
    assert.ok(reloadedGoRaw);
    assert.equal(reloadedGoRaw.tick, 18446744073709551615n);
    assert.equal(reloadedGoRaw.damage, 9223372036854775807n);

    // Case 8: Invalid contributions rejected cleanly
    for (const invalidKey of [
      "invalid_negative_metric",
      "invalid_non_terminal_outcome",
      "invalid_unknown_fields",
      "invalid_unsupported_version",
      "invalid_19digit_int64_overflow_string",
    ]) {
      await assert.rejects(
        () => service.record(fixtures.contributions[invalidKey]),
        InvalidContributionError,
        `Expected ${invalidKey} to fail with InvalidContributionError`,
      );
    }

    // Reject unsafe JavaScript float/integer (> Number.MAX_SAFE_INTEGER) passed directly as JS number
    await assert.rejects(
      () =>
        service.record({
          event_id: "sim:unsafe-num:inv:1:contrib:p1",
          simulation_id: "unsafe-num",
          invasion_id: "1",
          settlement_id: "settlement-valewatch",
          tick: Number.MAX_SAFE_INTEGER + 2,
          player_id: "p1",
          damage: 10,
          support: 0,
          objectives: 0,
          eligible: true,
          outcome: "Defended",
        }),
      InvalidContributionError,
    );

    // Reject uint64 overflow (`18446744073709551616`)
    await assert.rejects(
      () =>
        service.record({
          event_id: "sim:u64-over:inv:1:contrib:p1",
          simulation_id: "u64-over",
          invasion_id: "1",
          settlement_id: "settlement-valewatch",
          tick: "18446744073709551616",
          player_id: "p1",
          damage: "10",
          support: "0",
          objectives: "0",
          eligible: true,
          outcome: "Defended",
        }),
      InvalidContributionError,
    );
  });

  it("Cases 11, 12, 13, 14 & 15: Identical retry, conflicting retry, idempotency_key collision, logical duplicate, and concurrent races", async () => {
    const contribUoW = new PostgresContributionUnitOfWork(pgCtx.pool);
    const contribRepo = new PostgresContributionRepository(pgCtx.pool);
    const service = new RecordContributionService({ unitOfWork: contribUoW, logger: silentLogger });

    // Case 11: First apply + property-order-permuted identical retry -> duplicate_idempotent
    const first = await service.record(fixtures.contributions["valid_contribution_result"]);
    assert.equal(first.status, "applied");

    const second = await service.record(fixtures.contributions["duplicate_identical_reordered"]);
    assert.equal(second.status, "duplicate_idempotent");
    assert.equal(second.contribution.id, first.contribution.id);

    // Strict Go-port wrapper raises DuplicateContributionError on identical duplicate when requested
    await assert.rejects(
      () => service.recordStrictPortSemantics(fixtures.contributions["valid_contribution_result"]),
      DuplicateContributionError,
    );

    // Case 12: Same EventID with altered damage -> InboxIdempotencyConflictError (EVENT_ID_PAYLOAD_MISMATCH)
    await assert.rejects(
      () => service.record(fixtures.contributions["duplicate_conflicting_payload"]),
      (err: unknown) =>
        err instanceof InboxIdempotencyConflictError &&
        err.reason === "EVENT_ID_PAYLOAD_MISMATCH",
    );

    // Case 13: Different EventID reusing the same explicit idempotency_key -> IDEMPOTENCY_KEY_CONFLICT
    const sharedIdemKey = `idem-key-shared-${randomUUID()}`;
    await service.record({
      contract_version: 1,
      idempotency_key: sharedIdemKey,
      contribution: {
        event_id: "sim:idem:inv:1:contrib:p1",
        simulation_id: "idem",
        invasion_id: "1",
        settlement_id: "settlement-valewatch",
        tick: "10",
        player_id: "p1",
        damage: "100",
        support: "0",
        objectives: "0",
        eligible: true,
        outcome: "Defended",
      },
    });

    await assert.rejects(
      () =>
        service.record({
          contract_version: 1,
          idempotency_key: sharedIdemKey,
          contribution: {
            event_id: "sim:idem:inv:1:contrib:p2",
            simulation_id: "idem",
            invasion_id: "1",
            settlement_id: "settlement-valewatch",
            tick: "10",
            player_id: "p2",
            damage: "200",
            support: "0",
            objectives: "0",
            eligible: true,
            outcome: "Defended",
          },
        }),
      (err: unknown) =>
        err instanceof InboxIdempotencyConflictError &&
        err.reason === "IDEMPOTENCY_KEY_CONFLICT",
    );

    // Case 14: Different EventID for the SAME logical contribution (simulation_id, invasion_id, player_id)
    await assert.rejects(
      () =>
        service.record({
          event_id: "sim:s1:inv:inv1:contrib:player-kael:DIFFERENT-EVENT-ID",
          simulation_id: "s1",
          invasion_id: "inv1",
          settlement_id: "settlement-valewatch",
          tick: "71",
          player_id: "player-kael",
          damage: "425",
          support: "0",
          objectives: "0",
          eligible: true,
          outcome: "Defended",
        }),
      LogicalContributionConflictError,
    );

    // Verify rejected logical conflict rolled back its processed_events entry!
    const rolledBackInboxCheck = await pgCtx.pool.query(
      "SELECT 1 FROM processed_events WHERE external_event_id = $1",
      ["sim:s1:inv:inv1:contrib:player-kael:DIFFERENT-EVENT-ID"],
    );
    assert.equal(rolledBackInboxCheck.rowCount, 0);

    // Case 15a: 8x concurrent identical deliveries across pool connections
    const concurrentSamePayload = {
      event_id: `sim:conc:inv:1:contrib:${randomUUID()}`,
      simulation_id: "conc-sim",
      invasion_id: "conc-inv-1",
      settlement_id: "settlement-valewatch",
      tick: "300",
      player_id: "player-burst",
      damage: "500",
      support: "120",
      objectives: "2",
      eligible: true,
      outcome: "Defended",
    };

    const burstOutcomes = await Promise.all(
      Array.from({ length: 8 }, () => service.record(concurrentSamePayload)),
    );
    const appliedBurst = burstOutcomes.filter((o) => o.status === "applied");
    const dupBurst = burstOutcomes.filter((o) => o.status === "duplicate_idempotent");
    assert.equal(appliedBurst.length, 1);
    assert.equal(dupBurst.length, 7);

    // Case 15b: Concurrent race of 2 DISTINCT EventIDs claiming the same (simulation_id, invasion_id, player_id)
    const raceOutcomes = await Promise.allSettled([
      service.record({
        event_id: "sim:conc-logical:inv:9:contrib:p-race:evA",
        simulation_id: "conc-logical",
        invasion_id: "9",
        settlement_id: "settlement-valewatch",
        tick: "88",
        player_id: "p-race",
        damage: "150",
        support: "0",
        objectives: "0",
        eligible: true,
        outcome: "Defended",
      }),
      service.record({
        event_id: "sim:conc-logical:inv:9:contrib:p-race:evB",
        simulation_id: "conc-logical",
        invasion_id: "9",
        settlement_id: "settlement-valewatch",
        tick: "88",
        player_id: "p-race",
        damage: "150",
        support: "0",
        objectives: "0",
        eligible: true,
        outcome: "Defended",
      }),
    ]);

    assert.equal(raceOutcomes.filter((r) => r.status === "fulfilled").length, 1);
    const raceRejected = raceOutcomes.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    assert.equal(raceRejected.length, 1);
    assert.ok(raceRejected[0]?.reason instanceof LogicalContributionConflictError);
    assert.equal((await contribRepo.listByInvasion("conc-logical", "9")).length, 1);
  });

  it("Cases 16, 17, 18, 19, 20 & 25: Pre-commit fault rollback, retry recovery, inbox/outbox consistency, and partial-batch retry without duplicate effects", async () => {
    const contribUoW = new PostgresContributionUnitOfWork(pgCtx.pool);
    const contribRepo = new PostgresContributionRepository(pgCtx.pool);

    const faultEventId = `sim:fault:inv:77:contrib:${randomUUID()}`;
    const faultPayload = {
      event_id: faultEventId,
      simulation_id: "fault-sim",
      invasion_id: "inv-77",
      settlement_id: "settlement-valewatch",
      tick: "99",
      player_id: "player-fault",
      damage: "310",
      support: "45",
      objectives: "1",
      eligible: true,
      outcome: "Defended",
    };

    const failingService = new RecordContributionService({
      unitOfWork: contribUoW,
      logger: silentLogger,
      beforeCommitHook: async () => {
        throw new Error("Simulated pre-commit database/network crash");
      },
    });

    // Cases 16 & 17: Induced failure before commit rolls back inbox, contribution, and outbox
    await assert.rejects(
      () => failingService.record(faultPayload),
      /Simulated pre-commit database\/network crash/,
    );

    assert.equal(await contribRepo.findByExternalEventId(faultEventId), null);
    const inboxCheck = await pgCtx.pool.query(
      "SELECT 1 FROM processed_events WHERE external_event_id = $1",
      [faultEventId],
    );
    assert.equal(inboxCheck.rowCount, 0);

    // Case 18: Subsequent retry after failure succeeds cleanly
    const healthyService = new RecordContributionService({
      unitOfWork: contribUoW,
      logger: silentLogger,
    });
    const recovered = await healthyService.record(faultPayload);
    assert.equal(recovered.status, "applied");

    // Cases 19 & 20: Verify inbox <-> contribution <-> outbox consistency (`published_at === null`)
    const inboxRow = await pgCtx.pool.query<{
      event_id: string;
      external_event_id: string;
      payload_fingerprint: string;
    }>(
      "SELECT event_id, external_event_id, payload_fingerprint FROM processed_events WHERE external_event_id = $1",
      [faultEventId],
    );
    assert.equal(inboxRow.rowCount, 1);
    assert.equal(inboxRow.rows[0]?.event_id, recovered.contribution.processedEventId);
    assert.equal(inboxRow.rows[0]?.payload_fingerprint, recovered.contribution.payloadFingerprint);

    const outboxRows = await contribRepo.listOutboxByContributionId(recovered.contribution.id);
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0]?.eventType, "ContributionRecorded");
    assert.equal(outboxRows[0]?.publishedAt, null, "Outbox event is persisted, NOT falsely marked published");
    assert.equal(outboxRows[0]?.payload.tick, "99");
    assert.equal("gold" in (outboxRows[0]?.payload ?? {}), false);

    // Case 25: Partial batch failure & full batch retry (`[p1, p2, p3]` fails on p2 first time, then full `[p1, p2, p3]` retried)
    const batch = ["p1", "p2", "p3"].map((pid, idx) => ({
      event_id: `sim:batch-sim:inv:batch-inv:contrib:${pid}`,
      simulation_id: "batch-sim",
      invasion_id: "batch-inv",
      settlement_id: "settlement-valewatch",
      tick: "250",
      player_id: pid,
      damage: String((idx + 1) * 100),
      support: "20",
      objectives: "1",
      eligible: true,
      outcome: "Defended" as const,
    }));

    let failOnceOnP2 = true;
    const flakyBatchService = new RecordContributionService({
      unitOfWork: contribUoW,
      logger: silentLogger,
      beforeCommitHook: async ({ externalEventId }) => {
        if (failOnceOnP2 && externalEventId.endsWith(":p2")) {
          failOnceOnP2 = false;
          throw new Error("Transient connection drop on 2nd contribution in batch");
        }
      },
    });

    // Attempt 1: p1 commits, p2 fails and aborts batch dispatch (mirrors NEON's DispatchContributions loop)
    let firstAttemptDispatched = 0;
    await assert.rejects(async () => {
      for (const item of batch) {
        await flakyBatchService.record(item);
        firstAttemptDispatched++;
      }
    }, /Transient connection drop/);
    assert.equal(firstAttemptDispatched, 1);
    assert.equal((await contribRepo.listByInvasion("batch-sim", "batch-inv")).length, 1);

    // Attempt 2: NEON retries the ENTIRE batch [p1, p2, p3] -> p1 is duplicate_idempotent, p2 & p3 apply!
    const retryStatuses: string[] = [];
    for (const item of batch) {
      const res = await flakyBatchService.record(item);
      retryStatuses.push(res.status);
    }
    assert.deepEqual(retryStatuses, ["duplicate_idempotent", "applied", "applied"]);

    const persistedBatch = await contribRepo.listByInvasion("batch-sim", "batch-inv");
    assert.equal(persistedBatch.length, 3);
    for (const c of persistedBatch) {
      const ob = await contribRepo.listOutboxByContributionId(c.id);
      assert.equal(ob.length, 1, `Expected exactly 1 outbox event for ${c.playerId}`);
    }
  });

  it("Cases 21 & 22: JSON Schema <-> Zod parity check and durable recovery across real PostgreSQL restart", async () => {
    // Case 22: Compare static JSON Schema evaluation vs runtime Zod validation across all shared vectors
    for (const [name, snap] of Object.entries(fixtures.settlement_snapshots)) {
      const schemaVerdict = validateAgainstJsonSchema(snapshotJsonSchema, snap);
      assert.equal(schemaVerdict.valid, true, `JSON Schema rejected valid snapshot ${name}`);
      const zodProjected = parseSettlementSnapshotWireV1(snap);
      assert.equal(zodProjected.settlementId, snap["settlement_id"]);
    }

    const validContribKeys = [
      "valid_contribution_result",
      "duplicate_identical_reordered",
      "duplicate_conflicting_payload",
      "valid_non_uuid_external_id",
      "valid_max_int64",
      "valid_max_uint64",
    ];
    for (const key of validContribKeys) {
      const vec = fixtures.contributions[key]!;
      const schemaVerdict = validateAgainstJsonSchema(contributionJsonSchema, vec);
      assert.equal(schemaVerdict.valid, true, `JSON Schema rejected valid vector ${key}`);
      const zodValidated = parseContributionSubmission(vec);
      assert.equal(zodValidated.externalEventId, vec["event_id"]);
    }

    const bothRejectKeys = [
      "invalid_negative_metric",
      "invalid_non_terminal_outcome",
      "invalid_unknown_fields",
      "invalid_unsupported_version",
    ];
    for (const key of bothRejectKeys) {
      const vec = fixtures.contributions[key]!;
      const schemaVerdict = validateAgainstJsonSchema(contributionJsonSchema, vec);
      assert.equal(schemaVerdict.valid, false, `JSON Schema unexpectedly accepted ${key}`);
      assert.throws(() => parseContributionSubmission(vec), InvalidContributionError);
    }

    // Hardened in CARBON Full Audit (CARBON-AUD-008):
    // Static JSON Schema now enforces exact decimal int64 upper bound (9223372036854775807),
    // achieving 100% rejection parity with runtime Zod `NonNegativeInt64Schema` on 19-digit overflows!
    const overflow19Digit = fixtures.contributions["invalid_19digit_int64_overflow_string"]!;
    assert.equal(validateAgainstJsonSchema(contributionJsonSchema, overflow19Digit).valid, false);
    assert.throws(() => parseContributionSubmission(overflow19Digit), InvalidContributionError);

    // Reject Snapshot unknown fields in both JSON Schema and Zod
    const badSnap = {
      ...fixtures.settlement_snapshots["valid_valewatch"],
      extra_secret_field: true,
    };
    assert.equal(validateAgainstJsonSchema(snapshotJsonSchema, badSnap).valid, false);
    assert.throws(() => parseSettlementSnapshotWireV1(badSnap), BoundaryValidationError);

    // Case 21: Restart PostgreSQL server process and verify persisted records + deduplication survive intact
    const poolAfterRestart = await pgCtx.restartAndReconnect();
    const repoAfterRestart = new PostgresContributionRepository(poolAfterRestart);
    const serviceAfterRestart = new RecordContributionService({
      unitOfWork: new PostgresContributionUnitOfWork(poolAfterRestart),
      logger: silentLogger,
    });

    const survivedMaxU64 = await repoAfterRestart.findByExternalEventId(
      "sim:bounds:inv:uint64max:contrib:p-max-u64",
    );
    assert.ok(survivedMaxU64);
    assert.equal(survivedMaxU64.tick, MAX_UINT64);

    const postRestartDup = await serviceAfterRestart.record(
      fixtures.contributions["valid_max_uint64"],
    );
    assert.equal(postRestartDup.status, "duplicate_idempotent");

    const serializedAfterRestart = serializeContributionWireV1(survivedMaxU64);
    assert.equal(serializedAfterRestart.tick, "18446744073709551615");
  });
});
