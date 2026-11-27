-- Migration: 0012_audit_hardening_triggers_constraints_and_indexes (DOWN)

DROP INDEX IF EXISTS idx_processed_events_aggregate_processed;
DROP INDEX IF EXISTS idx_criminal_bounties_target_status;
DROP INDEX IF EXISTS idx_item_operation_ledger_counterparty;
DROP INDEX IF EXISTS idx_outbox_events_aggregate_created;

CREATE OR REPLACE FUNCTION fn_enforce_container_slot_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_capacity INTEGER;
    v_owner UUID;
BEGIN
    IF TG_TABLE_NAME = 'item_instances' THEN
        IF NEW.location_state <> 'in_container' THEN
            RETURN NEW;
        END IF;
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers WHERE id = NEW.container_id;

        IF v_capacity IS NULL THEN
            RAISE EXCEPTION 'Container % not found', NEW.container_id USING ERRCODE = '23503';
        END IF;
        IF v_owner <> NEW.owner_character_id THEN
            RAISE EXCEPTION 'Item owner % does not match container owner %', NEW.owner_character_id, v_owner USING ERRCODE = '23514';
        END IF;
        IF NEW.container_slot_index >= v_capacity THEN
            RAISE EXCEPTION 'Slot index % exceeds container capacity %', NEW.container_slot_index, v_capacity USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1 FROM inventory_stacks
            WHERE container_id = NEW.container_id AND container_slot_index = NEW.container_slot_index
        ) THEN
            RAISE EXCEPTION 'Container slot (%, %) already occupied by an inventory stack', NEW.container_id, NEW.container_slot_index USING ERRCODE = '23505';
        END IF;
    ELSIF TG_TABLE_NAME = 'inventory_stacks' THEN
        SELECT capacity, owner_character_id INTO v_capacity, v_owner
        FROM inventory_containers WHERE id = NEW.container_id;

        IF v_capacity IS NULL THEN
            RAISE EXCEPTION 'Container % not found', NEW.container_id USING ERRCODE = '23503';
        END IF;
        IF v_owner <> NEW.owner_character_id THEN
            RAISE EXCEPTION 'Stack owner % does not match container owner %', NEW.owner_character_id, v_owner USING ERRCODE = '23514';
        END IF;
        IF NEW.container_slot_index >= v_capacity THEN
            RAISE EXCEPTION 'Slot index % exceeds container capacity %', NEW.container_slot_index, v_capacity USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1 FROM item_instances
            WHERE container_id = NEW.container_id
              AND container_slot_index = NEW.container_slot_index
              AND location_state = 'in_container'
        ) THEN
            RAISE EXCEPTION 'Container slot (%, %) already occupied by an item instance', NEW.container_id, NEW.container_slot_index USING ERRCODE = '23505';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
