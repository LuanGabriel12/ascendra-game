-- Migration: 0005_accounts_characters_attributes_and_progression (DOWN)
-- Reverts Session 03 character, appearance, attribute, XP grant, and account tables.

DROP TABLE IF EXISTS character_build_history;
DROP TABLE IF EXISTS experience_grants;
DROP TABLE IF EXISTS character_attributes;
DROP TABLE IF EXISTS character_appearance;
DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS accounts;
