import type { PgPool, PgPoolClient } from "../../../shared/db/pool.js";
import {
  INITIAL_BACKGROUNDS_CATALOG,
  INITIAL_CULTURES_CATALOG,
  INITIAL_LINEAGES_CATALOG,
  INITIAL_PEOPLES_CATALOG,
} from "../catalog/initial-peoples-catalog.js";
import type {
  BackgroundDefinition,
  CultureDefinition,
  CustomizationProfile,
  LineageDefinition,
  PlayablePeopleDefinition,
} from "../domain/people-contracts.js";

interface PeopleRow {
  race_code: string;
  display_name: string;
  description: string;
  is_playable: boolean;
  is_enabled: boolean;
  catalog_version: number;
  attribute_budget_profile: "standard_100";
  customization_profile: CustomizationProfile;
  planned_traits_notes: string;
}

interface LineageRow {
  lineage_code: string;
  race_code: string;
  display_name: string;
  description: string;
  is_enabled: boolean;
  catalog_version: number;
}

interface CultureRow {
  culture_code: string;
  display_name: string;
  description: string;
  default_region_id: string | null;
  traditions: ReadonlyArray<string>;
  languages: ReadonlyArray<string>;
  is_enabled: boolean;
  catalog_version: number;
}

interface BackgroundRow {
  background_code: string;
  display_name: string;
  description: string;
  narrative_tags: ReadonlyArray<string>;
  is_enabled: boolean;
  catalog_version: number;
}

export class PostgresCatalogRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  /**
   * Idempotently seeds all 26 planned peoples (6 enabled), lineages, cultures, and 10 backgrounds.
   */
  public async seedInitialCatalogs(client?: PgPoolClient): Promise<void> {
    const executor = client ?? this.pool;

    for (const people of INITIAL_PEOPLES_CATALOG) {
      await executor.query(
        `INSERT INTO playable_peoples (
           race_code,
           display_name,
           description,
           is_playable,
           is_enabled,
           catalog_version,
           attribute_budget_profile,
           customization_profile,
           planned_traits_notes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (race_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               is_playable = EXCLUDED.is_playable,
               is_enabled = EXCLUDED.is_enabled,
               catalog_version = EXCLUDED.catalog_version,
               attribute_budget_profile = EXCLUDED.attribute_budget_profile,
               customization_profile = EXCLUDED.customization_profile,
               planned_traits_notes = EXCLUDED.planned_traits_notes,
               updated_at = NOW()`,
        [
          people.raceCode,
          people.displayName,
          people.description,
          people.isPlayable,
          people.isEnabled,
          people.catalogVersion,
          people.attributeBudgetProfile,
          JSON.stringify(people.customizationProfile),
          people.plannedTraitsNotes,
        ],
      );
    }

    for (const lineage of INITIAL_LINEAGES_CATALOG) {
      await executor.query(
        `INSERT INTO lineages (
           lineage_code,
           race_code,
           display_name,
           description,
           is_enabled,
           catalog_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (lineage_code) DO UPDATE
           SET race_code = EXCLUDED.race_code,
               display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               is_enabled = EXCLUDED.is_enabled,
               catalog_version = EXCLUDED.catalog_version,
               updated_at = NOW()`,
        [
          lineage.lineageCode,
          lineage.raceCode,
          lineage.displayName,
          lineage.description,
          lineage.isEnabled,
          lineage.catalogVersion,
        ],
      );
    }

    for (const culture of INITIAL_CULTURES_CATALOG) {
      await executor.query(
        `INSERT INTO cultures (
           culture_code,
           display_name,
           description,
           default_region_id,
           traditions,
           languages,
           is_enabled,
           catalog_version
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         ON CONFLICT (culture_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               default_region_id = EXCLUDED.default_region_id,
               traditions = EXCLUDED.traditions,
               languages = EXCLUDED.languages,
               is_enabled = EXCLUDED.is_enabled,
               catalog_version = EXCLUDED.catalog_version,
               updated_at = NOW()`,
        [
          culture.cultureCode,
          culture.displayName,
          culture.description,
          culture.defaultRegionId,
          JSON.stringify(culture.traditions),
          JSON.stringify(culture.languages),
          culture.isEnabled,
          culture.catalogVersion,
        ],
      );
    }

    for (const bg of INITIAL_BACKGROUNDS_CATALOG) {
      await executor.query(
        `INSERT INTO backgrounds (
           background_code,
           display_name,
           description,
           narrative_tags,
           is_enabled,
           catalog_version
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (background_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               narrative_tags = EXCLUDED.narrative_tags,
               is_enabled = EXCLUDED.is_enabled,
               catalog_version = EXCLUDED.catalog_version,
               updated_at = NOW()`,
        [
          bg.backgroundCode,
          bg.displayName,
          bg.description,
          JSON.stringify(bg.narrativeTags),
          bg.isEnabled,
          bg.catalogVersion,
        ],
      );
    }
  }

  public async findPeople(
    raceCode: string,
    client?: PgPoolClient,
  ): Promise<PlayablePeopleDefinition | null> {
    const executor = client ?? this.pool;
    const res = await executor.query<PeopleRow>(
      `SELECT
         race_code,
         display_name,
         description,
         is_playable,
         is_enabled,
         catalog_version,
         attribute_budget_profile,
         customization_profile,
         planned_traits_notes
       FROM playable_peoples
       WHERE race_code = $1`,
      [raceCode],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      raceCode: row.race_code,
      displayName: row.display_name,
      description: row.description,
      isPlayable: row.is_playable,
      isEnabled: row.is_enabled,
      catalogVersion: row.catalog_version,
      attributeBudgetProfile: row.attribute_budget_profile,
      customizationProfile: row.customization_profile,
      plannedTraitsNotes: row.planned_traits_notes,
    };
  }

  public async findLineage(
    lineageCode: string,
    client?: PgPoolClient,
  ): Promise<LineageDefinition | null> {
    const executor = client ?? this.pool;
    const res = await executor.query<LineageRow>(
      `SELECT lineage_code, race_code, display_name, description, is_enabled, catalog_version
       FROM lineages
       WHERE lineage_code = $1`,
      [lineageCode],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      lineageCode: row.lineage_code,
      raceCode: row.race_code,
      displayName: row.display_name,
      description: row.description,
      isEnabled: row.is_enabled,
      catalogVersion: row.catalog_version,
    };
  }

  public async findCulture(
    cultureCode: string,
    client?: PgPoolClient,
  ): Promise<CultureDefinition | null> {
    const executor = client ?? this.pool;
    const res = await executor.query<CultureRow>(
      `SELECT
         culture_code,
         display_name,
         description,
         default_region_id,
         traditions,
         languages,
         is_enabled,
         catalog_version
       FROM cultures
       WHERE culture_code = $1`,
      [cultureCode],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      cultureCode: row.culture_code,
      displayName: row.display_name,
      description: row.description,
      defaultRegionId: row.default_region_id,
      traditions: row.traditions,
      languages: row.languages,
      isEnabled: row.is_enabled,
      catalogVersion: row.catalog_version,
    };
  }

  public async findBackground(
    backgroundCode: string,
    client?: PgPoolClient,
  ): Promise<BackgroundDefinition | null> {
    const executor = client ?? this.pool;
    const res = await executor.query<BackgroundRow>(
      `SELECT background_code, display_name, description, narrative_tags, is_enabled, catalog_version
       FROM backgrounds
       WHERE background_code = $1`,
      [backgroundCode],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      backgroundCode: row.background_code,
      displayName: row.display_name,
      description: row.description,
      narrativeTags: row.narrative_tags,
      isEnabled: row.is_enabled,
      catalogVersion: row.catalog_version,
    };
  }

  public async countPeoples(): Promise<{ total: number; enabled: number }> {
    const res = await this.pool.query<{ total: string; enabled: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE is_enabled)::text AS enabled
       FROM playable_peoples`,
    );
    return {
      total: Number(res.rows[0]?.total ?? "0"),
      enabled: Number(res.rows[0]?.enabled ?? "0"),
    };
  }
}
