-- Migration: 0008_social_standing_fame_reputation_and_identity_links (UP)
-- CARBON Session 05: Versioned Social Rules, World Regions Catalog, Faction Relations,
-- Authoritative External Identity Links (PlayerID <-> CharacterID), Independent Moral Bounty,
-- Fame, Contextual Reputations, and Immutable Social Standing Audit Ledger.

CREATE TABLE social_rules_versions (
    rules_version INTEGER PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    moral_bounty_min BIGINT NOT NULL,
    moral_bounty_max BIGINT NOT NULL,
    moral_band_hysteresis BIGINT NOT NULL DEFAULT 25,
    severe_crime_cap_band VARCHAR(32) NOT NULL DEFAULT 'well_regarded',
    fame_max BIGINT NOT NULL,
    reputation_min INTEGER NOT NULL,
    reputation_max INTEGER NOT NULL,
    moral_bands JSONB NOT NULL,
    anti_abuse_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
    anti_abuse_window_seconds INTEGER NOT NULL DEFAULT 3600,
    anti_abuse_max_events_per_window INTEGER NOT NULL DEFAULT 5,
    diminishing_returns_step_bp INTEGER NOT NULL DEFAULT 2500,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_social_rules_versions_code UNIQUE (code),
    CONSTRAINT chk_social_rules_bounds CHECK (
        rules_version >= 1
        AND moral_bounty_min < 0
        AND moral_bounty_max > 0
        AND moral_band_hysteresis >= 0
        AND fame_max > 0
        AND reputation_min < 0
        AND reputation_max > 0
        AND anti_abuse_cooldown_seconds >= 0
        AND anti_abuse_window_seconds > 0
        AND anti_abuse_max_events_per_window >= 1
        AND diminishing_returns_step_bp BETWEEN 0 AND 10000
    )
);

CREATE TABLE social_regions (
    region_id VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    lawfulness_profile VARCHAR(32) NOT NULL,
    description TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_social_regions_id CHECK (char_length(btrim(region_id)) BETWEEN 2 AND 64),
    CONSTRAINT chk_social_regions_name CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT chk_social_regions_lawfulness CHECK (
        lawfulness_profile IN ('guarded_civil', 'frontier_mixed', 'lawless_wilds')
    )
);

CREATE TABLE faction_relations (
    source_faction_id UUID NOT NULL,
    target_faction_id UUID NOT NULL,
    relation_state VARCHAR(32) NOT NULL,
    propagation_bp INTEGER NOT NULL DEFAULT 0,
    rules_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_faction_id, target_faction_id),
    CONSTRAINT fk_faction_relations_source
        FOREIGN KEY (source_faction_id) REFERENCES factions(id) ON DELETE CASCADE,
    CONSTRAINT fk_faction_relations_target
        FOREIGN KEY (target_faction_id) REFERENCES factions(id) ON DELETE CASCADE,
    CONSTRAINT chk_faction_relations_distinct
        CHECK (source_faction_id <> target_faction_id),
    CONSTRAINT chk_faction_relations_state
        CHECK (relation_state IN ('allied', 'friendly', 'neutral', 'unfriendly', 'hostile')),
    CONSTRAINT chk_faction_relations_propagation_bounds
        CHECK (propagation_bp BETWEEN -10000 AND 10000 AND rules_version >= 1)
);

CREATE TABLE external_identity_links (
    id UUID PRIMARY KEY,
    source_namespace VARCHAR(64) NOT NULL,
    external_subject_id VARCHAR(128) NOT NULL,
    character_id UUID NOT NULL,
    link_status VARCHAR(32) NOT NULL DEFAULT 'active',
    linked_by_actor VARCHAR(128) NOT NULL,
    revocation_reason VARCHAR(255) NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_external_identity_links_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT chk_external_identity_links_fields
        CHECK (
            char_length(btrim(source_namespace)) > 0
            AND char_length(btrim(external_subject_id)) > 0
            AND char_length(btrim(linked_by_actor)) > 0
            AND link_status IN ('active', 'revoked')
            AND version >= 1
        )
);

CREATE UNIQUE INDEX uq_external_identity_active_subject
    ON external_identity_links(source_namespace, external_subject_id)
    WHERE link_status = 'active';

CREATE INDEX idx_external_identity_character
    ON external_identity_links(character_id, link_status);

CREATE TABLE external_identity_link_history (
    id UUID PRIMARY KEY,
    link_id UUID NOT NULL,
    source_namespace VARCHAR(64) NOT NULL,
    external_subject_id VARCHAR(128) NOT NULL,
    character_id UUID NOT NULL,
    action VARCHAR(32) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    cause_event_id VARCHAR(255) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_ext_id_history_link
        FOREIGN KEY (link_id) REFERENCES external_identity_links(id) ON DELETE RESTRICT,
    CONSTRAINT chk_ext_id_history_action
        CHECK (action IN ('linked', 'revoked'))
);

CREATE TABLE character_social_standing (
    character_id UUID PRIMARY KEY,
    moral_bounty BIGINT NOT NULL DEFAULT 0,
    moral_band VARCHAR(32) NOT NULL DEFAULT 'neutral',
    severe_crime_count INTEGER NOT NULL DEFAULT 0,
    global_fame BIGINT NOT NULL DEFAULT 0,
    settlement_defenses_count INTEGER NOT NULL DEFAULT 0,
    settlement_liberations_count INTEGER NOT NULL DEFAULT 0,
    validated_crimes_count INTEGER NOT NULL DEFAULT 0,
    bounties_fulfilled_count INTEGER NOT NULL DEFAULT 0,
    equipped_title_code VARCHAR(64) NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    social_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_social_standing_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT chk_character_social_standing_bands
        CHECK (
            moral_band IN (
                'heroic_legend',
                'revered_hero',
                'protector',
                'respected',
                'well_regarded',
                'neutral',
                'suspected',
                'dishonored',
                'criminal',
                'public_menace',
                'legendary_enemy'
            )
        ),
    CONSTRAINT chk_character_social_standing_non_negative_counters
        CHECK (
            global_fame >= 0
            AND severe_crime_count >= 0
            AND settlement_defenses_count >= 0
            AND settlement_liberations_count >= 0
            AND validated_crimes_count >= 0
            AND bounties_fulfilled_count >= 0
            AND rules_version >= 1
            AND social_version >= 1
        )
);

CREATE INDEX idx_character_social_fame_desc
    ON character_social_standing(global_fame DESC, character_id ASC);

CREATE TABLE character_regional_standing (
    character_id UUID NOT NULL,
    region_id VARCHAR(64) NOT NULL,
    regional_moral_bounty BIGINT NOT NULL DEFAULT 0,
    regional_fame BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (character_id, region_id),
    CONSTRAINT fk_char_regional_standing_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_regional_standing_region
        FOREIGN KEY (region_id) REFERENCES social_regions(region_id) ON DELETE RESTRICT,
    CONSTRAINT chk_char_regional_standing_bounds
        CHECK (regional_fame >= 0 AND version >= 1)
);

CREATE TABLE character_reputations (
    id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    scope_type VARCHAR(32) NOT NULL,
    scope_id VARCHAR(128) NOT NULL,
    faction_id UUID NULL,
    settlement_id UUID NULL,
    region_id VARCHAR(64) NULL,
    standing_value INTEGER NOT NULL DEFAULT 0,
    rules_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_char_reputations_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_char_reputations_faction
        FOREIGN KEY (faction_id) REFERENCES factions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_char_reputations_settlement
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE RESTRICT,
    CONSTRAINT fk_char_reputations_region
        FOREIGN KEY (region_id) REFERENCES social_regions(region_id) ON DELETE RESTRICT,
    CONSTRAINT uq_char_reputations_scope
        UNIQUE (character_id, scope_type, scope_id),
    CONSTRAINT chk_char_reputations_scope_coherence
        CHECK (
            (scope_type = 'faction' AND faction_id IS NOT NULL AND settlement_id IS NULL AND region_id IS NULL AND scope_id = faction_id::text)
            OR (scope_type = 'settlement' AND settlement_id IS NOT NULL AND faction_id IS NULL AND region_id IS NULL AND scope_id = settlement_id::text)
            OR (scope_type = 'region' AND region_id IS NOT NULL AND faction_id IS NULL AND settlement_id IS NULL AND scope_id = region_id)
        ),
    CONSTRAINT chk_char_reputations_version
        CHECK (rules_version >= 1 AND version >= 1)
);

CREATE INDEX idx_character_reputations_character
    ON character_reputations(character_id, scope_type);

CREATE TABLE social_standing_ledger (
    id UUID PRIMARY KEY,
    ledger_seq BIGSERIAL NOT NULL,
    character_id UUID NOT NULL,
    counterparty_account_id UUID NULL,
    counterparty_character_id UUID NULL,
    domain_kind VARCHAR(32) NOT NULL,
    action_code VARCHAR(64) NOT NULL,
    scope_key VARCHAR(160) NOT NULL,
    previous_value BIGINT NULL,
    delta_value BIGINT NULL,
    new_value BIGINT NULL,
    rules_version INTEGER NOT NULL DEFAULT 1,
    source_event_id VARCHAR(255) NOT NULL,
    is_compensated BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_social_ledger_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_social_ledger_counterparty_account
        FOREIGN KEY (counterparty_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_social_ledger_counterparty_char
        FOREIGN KEY (counterparty_character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT chk_social_ledger_domain
        CHECK (
            domain_kind IN (
                'moral_bounty',
                'fame',
                'reputation',
                'crime',
                'warrant',
                'criminal_bounty',
                'title',
                'contribution_recognition',
                'rehabilitation'
            )
        ),
    CONSTRAINT chk_social_ledger_fields
        CHECK (
            char_length(btrim(action_code)) > 0
            AND char_length(btrim(scope_key)) > 0
            AND char_length(btrim(source_event_id)) > 0
            AND rules_version >= 1
        )
);

CREATE INDEX idx_social_ledger_char_seq
    ON social_standing_ledger(character_id, ledger_seq ASC);
CREATE INDEX idx_social_ledger_anti_abuse_window
    ON social_standing_ledger(character_id, domain_kind, scope_key, occurred_at DESC);

-- Backfill any pre-existing regions already present in `settlements` + canonical ASCENDRA regions
INSERT INTO social_regions (region_id, display_name, lawfulness_profile, description)
VALUES
    ('region-ashvale', 'Vale de Cinzas (Ashvale)', 'guarded_civil', 'Região cívica murada e rotas agrícolas protegidas.'),
    ('region-thornreach', 'Fronteira de Thornreach', 'frontier_mixed', 'Fronteira disputada entre bosques antigos, enclaves arcanos e sombras.'),
    ('granite-peaks', 'Picos de Granito', 'guarded_civil', 'Cordilheira de guildas metalúrgicas e fortalezas de pedra.'),
    ('red-dunes', 'Dunas Vermelhas', 'frontier_mixed', 'Rotas mercantes de caravanas e oásis independentes.'),
    ('green-hollow', 'Bosque Fundo (Green Hollow)', 'frontier_mixed', 'Matas ancestrais sob vigília comunitária.'),
    ('ashen-march', 'Marca Cinzenta', 'frontier_mixed', 'Território marcial de clãs fronteiriços.'),
    ('shadowfen-depths', 'Pântanos Sombrios (Ermos Sem Lei)', 'lawless_wilds', 'Zona periférica sem jurisdição cívica formal.')
ON CONFLICT (region_id) DO NOTHING;

INSERT INTO social_regions (region_id, display_name, lawfulness_profile, description)
SELECT DISTINCT s.region_id, s.region_id, 'frontier_mixed', 'Região importada automaticamente de settlements existentes.'
FROM settlements s
ON CONFLICT (region_id) DO NOTHING;

-- Backfill neutral social standing row for pre-existing Session 03/04 characters
INSERT INTO character_social_standing (character_id)
SELECT c.id FROM characters c
ON CONFLICT (character_id) DO NOTHING;
