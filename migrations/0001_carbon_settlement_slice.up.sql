-- Migration: 0001_carbon_settlement_slice (UP)
-- Bounded Contexts: CARBON Factions & Settlements (Vertical Slice 01)
-- Enforces structural invariants (PK, UNIQUE, FK, CHECK, NOT NULL) directly in PostgreSQL.

CREATE TABLE factions (
    id UUID PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    is_playable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_factions_code UNIQUE (code),
    CONSTRAINT chk_factions_code_not_blank CHECK (char_length(btrim(code)) > 0),
    CONSTRAINT chk_factions_name_not_blank CHECK (char_length(btrim(name)) > 0)
);

CREATE TABLE settlements (
    id UUID PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    region_id VARCHAR(64) NOT NULL,
    state VARCHAR(32) NOT NULL,
    controlling_faction_id UUID NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_settlements_controlling_faction
        FOREIGN KEY (controlling_faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT chk_settlements_name_not_blank
        CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT chk_settlements_region_id_not_blank
        CHECK (char_length(btrim(region_id)) > 0),
    CONSTRAINT chk_settlements_valid_state
        CHECK (state IN ('peaceful', 'threatened', 'under_attack', 'occupied', 'rebuilding')),
    CONSTRAINT chk_settlements_occupied_requires_faction
        CHECK (state <> 'occupied' OR controlling_faction_id IS NOT NULL),
    CONSTRAINT chk_settlements_positive_version
        CHECK (version >= 1)
);

CREATE INDEX idx_settlements_region_id ON settlements(region_id);
CREATE INDEX idx_settlements_controlling_faction_id ON settlements(controlling_faction_id);

CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    event_version INTEGER NOT NULL,
    source VARCHAR(64) NOT NULL,
    correlation_id UUID NOT NULL,
    aggregate_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_processed_events_idempotency_key
        UNIQUE (idempotency_key),
    CONSTRAINT chk_processed_events_idempotency_key_not_blank
        CHECK (char_length(btrim(idempotency_key)) > 0),
    CONSTRAINT chk_processed_events_event_type_not_blank
        CHECK (char_length(btrim(event_type)) > 0),
    CONSTRAINT chk_processed_events_source_not_blank
        CHECK (char_length(btrim(source)) > 0),
    CONSTRAINT chk_processed_events_positive_version
        CHECK (event_version >= 1)
);

CREATE INDEX idx_processed_events_aggregate_id ON processed_events(aggregate_id);
CREATE INDEX idx_processed_events_correlation_id ON processed_events(correlation_id);

CREATE TABLE settlement_history (
    id UUID PRIMARY KEY,
    settlement_id UUID NOT NULL,
    settlement_version INTEGER NOT NULL,
    previous_state VARCHAR(32) NOT NULL,
    new_state VARCHAR(32) NOT NULL,
    previous_faction_id UUID NULL,
    new_faction_id UUID NULL,
    cause_event_id UUID NOT NULL,
    cause_event_type VARCHAR(64) NOT NULL,
    correlation_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_settlement_history_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_settlement_history_previous_faction
        FOREIGN KEY (previous_faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_settlement_history_new_faction
        FOREIGN KEY (new_faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_settlement_history_cause_event
        FOREIGN KEY (cause_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT uq_settlement_history_settlement_version
        UNIQUE (settlement_id, settlement_version),
    CONSTRAINT uq_settlement_history_cause_event
        UNIQUE (cause_event_id),
    CONSTRAINT chk_settlement_history_previous_state
        CHECK (previous_state IN ('peaceful', 'threatened', 'under_attack', 'occupied', 'rebuilding')),
    CONSTRAINT chk_settlement_history_new_state
        CHECK (new_state IN ('peaceful', 'threatened', 'under_attack', 'occupied', 'rebuilding')),
    CONSTRAINT chk_settlement_history_version
        CHECK (settlement_version >= 2)
);

CREATE INDEX idx_settlement_history_settlement_id
    ON settlement_history(settlement_id, settlement_version DESC);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    correlation_id UUID NOT NULL,
    causation_event_id UUID NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ NULL,
    CONSTRAINT fk_outbox_events_causation_event
        FOREIGN KEY (causation_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT uq_outbox_events_causation_type
        UNIQUE (causation_event_id, event_type),
    CONSTRAINT chk_outbox_events_positive_version
        CHECK (event_version >= 1)
);

CREATE INDEX idx_outbox_events_unpublished
    ON outbox_events(created_at ASC)
    WHERE published_at IS NULL;
