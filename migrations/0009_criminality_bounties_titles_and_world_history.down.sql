-- Migration: 0009_criminality_bounties_titles_and_world_history (DOWN)

DROP TABLE IF EXISTS contribution_recognitions;
DROP TABLE IF EXISTS historical_social_records;
DROP TABLE IF EXISTS title_exclusivity_claims;
DROP TABLE IF EXISTS character_title_history;
DROP TABLE IF EXISTS character_titles;
ALTER TABLE character_social_standing
    DROP CONSTRAINT IF EXISTS fk_character_social_equipped_title;
DROP TABLE IF EXISTS title_definitions;
DROP TABLE IF EXISTS criminal_bounty_claims;
DROP TABLE IF EXISTS criminal_bounties;
DROP TABLE IF EXISTS criminal_warrants;
DROP TABLE IF EXISTS character_jurisdiction_status;
DROP TABLE IF EXISTS criminal_records;
DROP TABLE IF EXISTS criminal_jurisdictions;
