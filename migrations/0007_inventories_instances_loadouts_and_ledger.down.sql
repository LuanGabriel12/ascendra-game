-- Migration: 0007_inventories_instances_loadouts_and_ledger (DOWN)
-- Reverts Session 04 containers, item instances, stacks, loadouts, grants, and item ledger.

DROP TABLE IF EXISTS item_operation_ledger;
DROP TABLE IF EXISTS item_grants;
DROP TABLE IF EXISTS equipment_loadout_slots;
DROP TABLE IF EXISTS equipment_loadouts;

DROP TRIGGER IF EXISTS trg_inventory_stacks_slot_integrity ON inventory_stacks;
DROP TRIGGER IF EXISTS trg_item_instances_slot_integrity ON item_instances;
DROP FUNCTION IF EXISTS fn_enforce_container_slot_integrity();

DROP TABLE IF EXISTS inventory_stacks;
DROP TABLE IF EXISTS item_instance_affixes;
DROP TABLE IF EXISTS item_instances;
DROP TABLE IF EXISTS inventory_containers;
