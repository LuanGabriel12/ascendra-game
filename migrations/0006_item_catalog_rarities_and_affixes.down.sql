-- Migration: 0006_item_catalog_rarities_and_affixes (DOWN)
-- Reverts Session 04 catalog, affix, rarity, and generation rule tables.

DROP TABLE IF EXISTS item_generation_rules;
DROP TABLE IF EXISTS item_definitions;
DROP TABLE IF EXISTS affix_definitions;
DROP TABLE IF EXISTS special_effect_definitions;
DROP TABLE IF EXISTS item_rarities;
