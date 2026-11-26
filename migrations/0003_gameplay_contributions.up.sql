-- Migration: 0003_gameplay_contributions (UP)
-- Bounded Context: CARBON Gameplay Contributions (Authoritative NEON ContributionResult Persistence)
-- Stores validated gameplay participation facts without granting arbitrary currency, items, or reputation.

CREATE TABLE gameplay_contributions (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    external_event_id VARCHAR(255) NOT NULL,
    contract_version INTEGER NOT NULL DEFAULT 1,
    simulation_id VARCHAR(128) NOT NULL,
    invasion_id VARCHAR(128) NOT NULL,
    settlement_ref VARCHAR(128) NOT NULL,
    resolved_settlement_id UUID NULL,
    player_id VARCHAR(128) NOT NULL,
    simulation_tick NUMERIC(20, 0) NOT NULL,
    damage BIGINT NOT NULL,
    support BIGINT NOT NULL,
    objectives BIGINT NOT NULL,
    eligible BOOLEAN NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    payload_fingerprint VARCHAR(80) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_gameplay_contributions_processed_event
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_gameplay_contributions_resolved_settlement
        FOREIGN KEY (resolved_settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT uq_gameplay_contributions_processed_event
        UNIQUE (processed_event_id),
    CONSTRAINT uq_gameplay_contributions_external_event_id
        UNIQUE (external_event_id),
    CONSTRAINT uq_gameplay_contributions_logical_identity
        UNIQUE (simulation_id, invasion_id, player_id),
    CONSTRAINT chk_gameplay_contributions_ids_not_blank
        CHECK (
            char_length(btrim(external_event_id)) > 0
            AND char_length(btrim(simulation_id)) > 0
            AND char_length(btrim(invasion_id)) > 0
            AND char_length(btrim(settlement_ref)) > 0
            AND char_length(btrim(player_id)) > 0
        ),
    CONSTRAINT chk_gameplay_contributions_tick_uint64
        CHECK (
            simulation_tick >= 0
            AND simulation_tick <= 18446744073709551615
            AND scale(simulation_tick) = 0
        ),
    CONSTRAINT chk_gameplay_contributions_non_negative_metrics
        CHECK (damage >= 0 AND support >= 0 AND objectives >= 0),
    CONSTRAINT chk_gameplay_contributions_terminal_outcome
        CHECK (outcome IN ('Defended', 'Captured')),
    CONSTRAINT chk_gameplay_contributions_contract_version
        CHECK (contract_version >= 1),
    CONSTRAINT chk_gameplay_contributions_fingerprint_not_blank
        CHECK (char_length(btrim(payload_fingerprint)) >= 16)
);

CREATE INDEX idx_gameplay_contributions_settlement_ref
    ON gameplay_contributions(settlement_ref);
CREATE INDEX idx_gameplay_contributions_player_id
    ON gameplay_contributions(player_id);
CREATE INDEX idx_gameplay_contributions_invasion
    ON gameplay_contributions(simulation_id, invasion_id);
