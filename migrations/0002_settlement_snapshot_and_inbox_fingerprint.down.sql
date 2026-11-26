-- Migration: 0002_settlement_snapshot_and_inbox_fingerprint (DOWN)
-- Reverts Session 02 additions on processed_events and settlements while preserving 0001 schema.

DROP TRIGGER IF EXISTS trg_processed_events_expand_defaults ON processed_events;
DROP FUNCTION IF EXISTS fn_processed_events_expand_defaults();

UPDATE processed_events
SET occurred_at = COALESCE(occurred_at, received_at, processed_at)
WHERE occurred_at IS NULL;

ALTER TABLE processed_events
    ALTER COLUMN occurred_at SET NOT NULL,
    DROP CONSTRAINT IF EXISTS chk_processed_events_fingerprint_format,
    DROP CONSTRAINT IF EXISTS chk_processed_events_external_event_id_not_blank,
    DROP CONSTRAINT IF EXISTS uq_processed_events_external_event_id,
    DROP COLUMN IF EXISTS canonical_payload,
    DROP COLUMN IF EXISTS payload_fingerprint,
    DROP COLUMN IF EXISTS received_at,
    DROP COLUMN IF EXISTS external_event_id;

DROP TRIGGER IF EXISTS trg_settlements_expand_defaults ON settlements;
DROP FUNCTION IF EXISTS fn_settlements_expand_defaults();

ALTER TABLE settlements
    DROP CONSTRAINT IF EXISTS chk_settlements_lifecycle_defense_coherence,
    DROP CONSTRAINT IF EXISTS chk_settlements_positive_max_defense_hp,
    DROP CONSTRAINT IF EXISTS chk_settlements_valid_defense_state,
    DROP CONSTRAINT IF EXISTS chk_settlements_external_id_not_blank,
    DROP CONSTRAINT IF EXISTS uq_settlements_external_id,
    DROP COLUMN IF EXISTS max_defense_hp,
    DROP COLUMN IF EXISTS defense_state,
    DROP COLUMN IF EXISTS external_id;
