-- Migration: 0011_character_mastery_skills_loadouts_and_history (DOWN)

DROP TABLE IF EXISTS character_skill_history;
DROP TABLE IF EXISTS character_ability_loadout_slots;
DROP TABLE IF EXISTS character_learned_abilities;
DROP TABLE IF EXISTS character_specialization_unlocks;
DROP TABLE IF EXISTS character_specialization_point_grants;
DROP TABLE IF EXISTS character_specialization_points;
DROP TABLE IF EXISTS mastery_experience_grants;
DROP TABLE IF EXISTS character_weapon_masteries;
