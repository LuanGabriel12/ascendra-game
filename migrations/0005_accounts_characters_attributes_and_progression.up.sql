-- Migration: 0005_accounts_characters_attributes_and_progression (UP)
-- CARBON Session 03: Persistent Accounts, Characters, Modular Appearance,
-- Ten Primary Attributes (Base vs Allocated), Validated Experience Grants, and Build History.

CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    external_subject VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    max_characters_override INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_accounts_external_subject
        UNIQUE (external_subject),
    CONSTRAINT chk_accounts_external_subject_not_blank
        CHECK (external_subject IS NULL OR char_length(btrim(external_subject)) > 0),
    CONSTRAINT chk_accounts_status
        CHECK (status IN ('active', 'suspended', 'closed')),
    CONSTRAINT chk_accounts_max_chars_override
        CHECK (max_characters_override IS NULL OR (max_characters_override >= 1 AND max_characters_override <= 50))
);

CREATE TABLE characters (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL,
    display_name VARCHAR(24) NOT NULL,
    canonical_name VARCHAR(24) NOT NULL,
    race_code VARCHAR(64) NOT NULL,
    lineage_code VARCHAR(64) NOT NULL,
    culture_code VARCHAR(64) NOT NULL,
    background_code VARCHAR(64) NOT NULL,
    origin_region_id VARCHAR(64) NOT NULL,
    hometown_settlement_ref VARCHAR(128) NULL,
    rules_version INTEGER NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    experience_total BIGINT NOT NULL DEFAULT 0,
    earned_attribute_points INTEGER NOT NULL,
    allocated_attribute_points INTEGER NOT NULL DEFAULT 0,
    unspent_attribute_points INTEGER NOT NULL,
    build_version INTEGER NOT NULL DEFAULT 1,
    snapshot_version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    competitive_lock_state VARCHAR(32) NOT NULL DEFAULT 'none',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_characters_account
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_characters_race
        FOREIGN KEY (race_code) REFERENCES playable_peoples(race_code) ON DELETE RESTRICT,
    CONSTRAINT fk_characters_race_lineage
        FOREIGN KEY (race_code, lineage_code) REFERENCES lineages(race_code, lineage_code) ON DELETE RESTRICT,
    CONSTRAINT fk_characters_culture
        FOREIGN KEY (culture_code) REFERENCES cultures(culture_code) ON DELETE RESTRICT,
    CONSTRAINT fk_characters_background
        FOREIGN KEY (background_code) REFERENCES backgrounds(background_code) ON DELETE RESTRICT,
    CONSTRAINT fk_characters_rules_version
        FOREIGN KEY (rules_version) REFERENCES progression_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT uq_characters_canonical_name
        UNIQUE (canonical_name),
    CONSTRAINT chk_characters_display_name_len
        CHECK (char_length(btrim(display_name)) BETWEEN 3 AND 24),
    CONSTRAINT chk_characters_canonical_name_len
        CHECK (char_length(btrim(canonical_name)) BETWEEN 3 AND 24),
    CONSTRAINT chk_characters_origin_region_not_blank
        CHECK (char_length(btrim(origin_region_id)) > 0),
    CONSTRAINT chk_characters_hometown_not_blank
        CHECK (hometown_settlement_ref IS NULL OR char_length(btrim(hometown_settlement_ref)) > 0),
    CONSTRAINT chk_characters_level_bounds
        CHECK (level >= 1 AND level <= 1000),
    CONSTRAINT chk_characters_experience_non_negative
        CHECK (experience_total >= 0),
    CONSTRAINT chk_characters_points_non_negative
        CHECK (
            earned_attribute_points >= 0
            AND allocated_attribute_points >= 0
            AND unspent_attribute_points >= 0
        ),
    CONSTRAINT chk_characters_budget_conservation
        CHECK (allocated_attribute_points + unspent_attribute_points = earned_attribute_points),
    CONSTRAINT chk_characters_versions_positive
        CHECK (build_version >= 1 AND snapshot_version >= 1),
    CONSTRAINT chk_characters_status
        CHECK (status IN ('active', 'locked_for_transfer', 'archived')),
    CONSTRAINT chk_characters_competitive_lock
        CHECK (competitive_lock_state IN ('none', 'in_ranked_series'))
);

CREATE INDEX idx_characters_account_id ON characters(account_id);
CREATE INDEX idx_characters_race_code ON characters(race_code);

CREATE TABLE character_appearance (
    character_id UUID PRIMARY KEY,
    appearance_catalog_version INTEGER NOT NULL DEFAULT 1,
    body_preset VARCHAR(64) NOT NULL,
    skin_tone VARCHAR(64) NOT NULL,
    hair_style VARCHAR(64) NULL,
    hair_color VARCHAR(64) NULL,
    eye_style VARCHAR(64) NOT NULL,
    eye_color VARCHAR(64) NOT NULL,
    facial_features VARCHAR(64) NULL,
    beard_style VARCHAR(64) NULL,
    ear_style VARCHAR(64) NULL,
    horn_style VARCHAR(64) NULL,
    tail_style VARCHAR(64) NULL,
    scale_pattern VARCHAR(64) NULL,
    tattoos JSONB NOT NULL DEFAULT '[]'::jsonb,
    scars JSONB NOT NULL DEFAULT '[]'::jsonb,
    cosmetic_accessories JSONB NOT NULL DEFAULT '[]'::jsonb,
    voice_profile VARCHAR(64) NULL,
    appearance_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_appearance_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT chk_character_appearance_versions
        CHECK (appearance_catalog_version >= 1 AND appearance_version >= 1),
    CONSTRAINT chk_character_appearance_required_tokens
        CHECK (
            body_preset ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
            AND skin_tone ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
            AND eye_style ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
            AND eye_color ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
        )
);

CREATE TABLE character_attributes (
    character_id UUID PRIMARY KEY,
    base_strength INTEGER NOT NULL,
    base_fortitude INTEGER NOT NULL,
    base_vigor INTEGER NOT NULL,
    base_agility INTEGER NOT NULL,
    base_dexterity INTEGER NOT NULL,
    base_intelligence INTEGER NOT NULL,
    base_wisdom INTEGER NOT NULL,
    base_determination INTEGER NOT NULL,
    base_luck INTEGER NOT NULL,
    base_charisma INTEGER NOT NULL,
    alloc_strength INTEGER NOT NULL DEFAULT 0,
    alloc_fortitude INTEGER NOT NULL DEFAULT 0,
    alloc_vigor INTEGER NOT NULL DEFAULT 0,
    alloc_agility INTEGER NOT NULL DEFAULT 0,
    alloc_dexterity INTEGER NOT NULL DEFAULT 0,
    alloc_intelligence INTEGER NOT NULL DEFAULT 0,
    alloc_wisdom INTEGER NOT NULL DEFAULT 0,
    alloc_determination INTEGER NOT NULL DEFAULT 0,
    alloc_luck INTEGER NOT NULL DEFAULT 0,
    alloc_charisma INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_attributes_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT chk_character_attributes_base_non_negative
        CHECK (
            base_strength >= 0
            AND base_fortitude >= 0
            AND base_vigor >= 0
            AND base_agility >= 0
            AND base_dexterity >= 0
            AND base_intelligence >= 0
            AND base_wisdom >= 0
            AND base_determination >= 0
            AND base_luck >= 0
            AND base_charisma >= 0
        ),
    CONSTRAINT chk_character_attributes_alloc_non_negative
        CHECK (
            alloc_strength >= 0
            AND alloc_fortitude >= 0
            AND alloc_vigor >= 0
            AND alloc_agility >= 0
            AND alloc_dexterity >= 0
            AND alloc_intelligence >= 0
            AND alloc_wisdom >= 0
            AND alloc_determination >= 0
            AND alloc_luck >= 0
            AND alloc_charisma >= 0
        )
);

CREATE TABLE experience_grants (
    id UUID PRIMARY KEY,
    processed_event_id UUID NOT NULL,
    external_grant_id VARCHAR(255) NOT NULL,
    character_id UUID NOT NULL,
    source_type VARCHAR(64) NOT NULL,
    source_reference VARCHAR(128) NOT NULL,
    rules_version INTEGER NOT NULL,
    validated_amount BIGINT NOT NULL,
    previous_xp BIGINT NOT NULL,
    new_xp BIGINT NOT NULL,
    previous_level INTEGER NOT NULL,
    new_level INTEGER NOT NULL,
    attribute_points_awarded INTEGER NOT NULL,
    payload_fingerprint VARCHAR(80) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_experience_grants_processed_event
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT fk_experience_grants_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_experience_grants_rules_version
        FOREIGN KEY (rules_version) REFERENCES progression_rules(rules_version) ON DELETE RESTRICT,
    CONSTRAINT uq_experience_grants_processed_event
        UNIQUE (processed_event_id),
    CONSTRAINT uq_experience_grants_external_grant_id
        UNIQUE (external_grant_id),
    CONSTRAINT chk_experience_grants_ids_not_blank
        CHECK (
            char_length(btrim(external_grant_id)) > 0
            AND char_length(btrim(source_reference)) > 0
            AND char_length(btrim(payload_fingerprint)) >= 16
        ),
    CONSTRAINT chk_experience_grants_source_type
        CHECK (
            source_type IN (
                'quest',
                'boss',
                'exploration',
                'world_event',
                'invasion_reward_policy',
                'discovery',
                'achievement',
                'dev_authorized'
            )
        ),
    CONSTRAINT chk_experience_grants_monotonic_values
        CHECK (
            validated_amount > 0
            AND previous_xp >= 0
            AND new_xp >= previous_xp
            AND previous_level >= 1
            AND new_level >= previous_level
            AND attribute_points_awarded >= 0
        )
);

CREATE INDEX idx_experience_grants_character_id ON experience_grants(character_id, granted_at ASC);

CREATE TABLE character_build_history (
    id UUID PRIMARY KEY,
    character_id UUID NOT NULL,
    build_version INTEGER NOT NULL,
    operation_type VARCHAR(32) NOT NULL,
    cause_event_id UUID NOT NULL,
    preset_code VARCHAR(64) NULL,
    previous_allocated JSONB NOT NULL,
    new_allocated JSONB NOT NULL,
    unspent_after INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_character_build_history_character
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_character_build_history_cause_event
        FOREIGN KEY (cause_event_id) REFERENCES processed_events(event_id) ON DELETE RESTRICT,
    CONSTRAINT uq_character_build_history_version
        UNIQUE (character_id, build_version),
    CONSTRAINT uq_character_build_history_cause_event
        UNIQUE (cause_event_id),
    CONSTRAINT chk_character_build_history_op
        CHECK (operation_type IN ('initial_creation', 'allocate_points', 'respec_reset')),
    CONSTRAINT chk_character_build_history_bounds
        CHECK (build_version >= 1 AND unspent_after >= 0)
);

CREATE INDEX idx_character_build_history_character
    ON character_build_history(character_id, build_version DESC);
