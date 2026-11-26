-- Migration: 0002_settlement_snapshot_and_inbox_fingerprint (UP)
-- Incremental migration for CARBON Session 02:
--   1. Adds external_id, defense_state, and max_defense_hp to settlements for NEON SettlementSnapshot projection.
--   2. Upgrades processed_events to store verbatim external_event_id, received_at, and canonical payload fingerprints
--      so duplicate deliveries are distinguished from conflicting payload mutations.
--   3. Installs expand-phase BEFORE INSERT triggers so legacy v1 SQL writers omitting 0002 columns continue
--      working seamlessly while strict NOT NULL, UNIQUE, and CHECK constraints remain enforced in PostgreSQL.

-- 1. Settlements: add external_id, defense_state, and max_defense_hp
ALTER TABLE settlements
    ADD COLUMN external_id VARCHAR(128) NULL,
    ADD COLUMN defense_state VARCHAR(32) NULL,
    ADD COLUMN max_defense_hp BIGINT NULL;

-- Explicit backfill for pre-existing Session 01 rows:
--   * external_id defaults to canonical UUID text when not explicitly assigned.
--   * defense_state derives conservatively from current lifecycle state without conflating the two concepts.
--   * max_defense_hp = 1000 is an explicit provisional development parameter (matches NEON fixture baseline),
--     NOT final gameplay balance.
UPDATE settlements
SET external_id = COALESCE(external_id, id::text),
    defense_state = COALESCE(
        defense_state,
        CASE
            WHEN state = 'occupied' THEN 'Captured'
            WHEN state = 'rebuilding' THEN 'Damaged'
            ELSE 'Secure'
        END
    ),
    max_defense_hp = COALESCE(max_defense_hp, 1000)
WHERE external_id IS NULL
   OR defense_state IS NULL
   OR max_defense_hp IS NULL;

ALTER TABLE settlements
    ALTER COLUMN defense_state SET NOT NULL,
    ALTER COLUMN max_defense_hp SET NOT NULL;

ALTER TABLE settlements
    ADD CONSTRAINT uq_settlements_external_id
        UNIQUE (external_id),
    ADD CONSTRAINT chk_settlements_external_id_not_blank
        CHECK (external_id IS NULL OR char_length(btrim(external_id)) > 0),
    ADD CONSTRAINT chk_settlements_valid_defense_state
        CHECK (defense_state IN ('Secure', 'Fortified', 'Damaged', 'Captured')),
    ADD CONSTRAINT chk_settlements_positive_max_defense_hp
        CHECK (max_defense_hp > 0),
    ADD CONSTRAINT chk_settlements_lifecycle_defense_coherence
        CHECK (
            (state = 'occupied' AND defense_state = 'Captured')
            OR (state <> 'occupied' AND defense_state IN ('Secure', 'Fortified', 'Damaged'))
        );

CREATE OR REPLACE FUNCTION fn_settlements_expand_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.external_id IS NULL AND NEW.id IS NOT NULL THEN
        NEW.external_id := NEW.id::text;
    END IF;
    IF NEW.defense_state IS NULL THEN
        NEW.defense_state := CASE
            WHEN NEW.state = 'occupied' THEN 'Captured'
            WHEN NEW.state = 'rebuilding' THEN 'Damaged'
            ELSE 'Secure'
        END;
    END IF;
    IF NEW.max_defense_hp IS NULL THEN
        NEW.max_defense_hp := 1000;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_settlements_expand_defaults
BEFORE INSERT ON settlements
FOR EACH ROW
EXECUTE FUNCTION fn_settlements_expand_defaults();

-- 2. Processed Events (Inbox): support deterministic opaque external IDs + canonical payload fingerprints
ALTER TABLE processed_events
    ADD COLUMN external_event_id VARCHAR(255) NULL,
    ADD COLUMN received_at TIMESTAMPTZ NULL,
    ADD COLUMN payload_fingerprint VARCHAR(80) NULL,
    ADD COLUMN canonical_payload JSONB NULL;

-- Backfill legacy Session 01 rows conservatively (payload_fingerprint remains NULL to denote pre-v2 legacy record)
UPDATE processed_events
SET external_event_id = COALESCE(external_event_id, event_id::text),
    received_at = COALESCE(received_at, processed_at)
WHERE external_event_id IS NULL
   OR received_at IS NULL;

ALTER TABLE processed_events
    ALTER COLUMN external_event_id SET NOT NULL,
    ALTER COLUMN received_at SET NOT NULL,
    ALTER COLUMN received_at SET DEFAULT NOW(),
    ALTER COLUMN occurred_at DROP NOT NULL;

ALTER TABLE processed_events
    ADD CONSTRAINT uq_processed_events_external_event_id
        UNIQUE (external_event_id),
    ADD CONSTRAINT chk_processed_events_external_event_id_not_blank
        CHECK (char_length(btrim(external_event_id)) > 0),
    ADD CONSTRAINT chk_processed_events_fingerprint_format
        CHECK (payload_fingerprint IS NULL OR char_length(btrim(payload_fingerprint)) >= 16);

CREATE OR REPLACE FUNCTION fn_processed_events_expand_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.external_event_id IS NULL AND NEW.event_id IS NOT NULL THEN
        NEW.external_event_id := NEW.event_id::text;
    END IF;
    IF NEW.received_at IS NULL THEN
        NEW.received_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_processed_events_expand_defaults
BEFORE INSERT ON processed_events
FOR EACH ROW
EXECUTE FUNCTION fn_processed_events_expand_defaults();
