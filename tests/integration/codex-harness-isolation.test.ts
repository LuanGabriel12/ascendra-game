import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { startPostgresTestContext } from "../helpers/postgres-test-harness.js";
import { migrateDown, migrateUp } from "../../src/shared/db/migrator.js";
import { createPgPool } from "../../src/shared/db/pool.js";

test("external contexts isolate migrations, data, reconnect and cleanup", async () => {
  const original = process.env["DATABASE_URL"];
  let server: Awaited<ReturnType<typeof startPostgresTestContext>> | undefined;
  if (!original) {
    server = await startPostgresTestContext();
    process.env["DATABASE_URL"] = server.connectionString;
  }
  const controlUrl = process.env["DATABASE_URL"]!;
  const control = createPgPool({ connectionString: controlUrl });
  let a: Awaited<ReturnType<typeof startPostgresTestContext>> | undefined;
  let b: Awaited<ReturnType<typeof startPostgresTestContext>> | undefined;
  const migrations = path.resolve("migrations");
  try {
    [a, b] = await Promise.all([startPostgresTestContext(), startPostgresTestContext()]);
    const aName = new URL(a.connectionString).pathname.slice(1);
    const bName = new URL(b.connectionString).pathname.slice(1);
    assert.notEqual(aName, bName);
    assert.notEqual(aName, new URL(controlUrl).pathname.slice(1));
    await Promise.all([migrateUp(a.pool, migrations), migrateUp(b.pool, migrations)]);
    await a.pool.query("CREATE TABLE harness_marker (value integer)");
    await a.pool.query("INSERT INTO harness_marker VALUES (42)");
    const missing = await b.pool.query("SELECT to_regclass('public.harness_marker') AS name");
    assert.equal(missing.rows[0].name, null);
    await migrateDown(a.pool, migrations, 12);
    assert.equal((await b.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 12);
    await a.restartAndReconnect();
    assert.equal((await a.pool.query("SELECT value FROM harness_marker")).rows[0].value, 42);
    await a.pool.query("DROP TABLE harness_marker");
    await a.stop();
    a = undefined;
    assert.equal((await b.pool.query("SELECT 1 AS n")).rows[0].n, 1);
    const names = await control.query("SELECT datname FROM pg_database WHERE datname = ANY($1::text[])", [[aName, bName]]);
    assert.deepEqual(names.rows.map((row) => row.datname), [bName]);
    await b.stop();
    b = undefined;
    assert.equal((await control.query("SELECT count(*)::int AS n FROM pg_database WHERE datname = ANY($1::text[])", [[aName, bName]])).rows[0].n, 0);
    assert.equal((await control.query("SELECT 1 AS n")).rows[0].n, 1);
  } finally {
    if (a) await a.stop();
    if (b) await b.stop();
    await control.end();
    if (original === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = original;
    if (server) await server.stop();
  }
});