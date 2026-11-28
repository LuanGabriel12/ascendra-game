import assert from "node:assert/strict";
import { test } from "node:test";
import { assertConsistentCombatSnapshots } from "../../src/modules/skills/application/ability-snapshot-query.js";

type Inputs = Parameters<typeof assertConsistentCombatSnapshots>[0];
const character = { identity: { characterId: "c" }, buildVersion: 2, snapshotVersion: 3, normalizationProfile: "open_world_persistent" } as Inputs["characterSnapshot"];
const ability = { characterId: "c", buildVersion: 2, snapshotVersion: 3, activeLoadoutId: "l", normalizationProfile: "open_world_persistent" } as Inputs["abilitySnapshot"];
const equipment = { characterId: "c", buildVersion: 2, snapshotVersion: 3, activeLoadoutId: "l", normalizationProfile: "open_world_persistent" } as NonNullable<Inputs["equipmentSnapshot"]>;

test("combat snapshots reject profile and active-loadout mismatches", () => {
  assert.doesNotThrow(() => assertConsistentCombatSnapshots({ characterSnapshot: character, abilitySnapshot: ability, equipmentSnapshot: equipment }));
  assert.throws(() => assertConsistentCombatSnapshots({ characterSnapshot: character, abilitySnapshot: { ...ability, normalizationProfile: "legacy_ranked_md3" }, equipmentSnapshot: equipment }));
  assert.throws(() => assertConsistentCombatSnapshots({ characterSnapshot: character, abilitySnapshot: ability, equipmentSnapshot: { ...equipment, normalizationProfile: "legacy_ranked_md3" } }));
  assert.throws(() => assertConsistentCombatSnapshots({ characterSnapshot: character, abilitySnapshot: ability, equipmentSnapshot: { ...equipment, activeLoadoutId: "other" } }));
});