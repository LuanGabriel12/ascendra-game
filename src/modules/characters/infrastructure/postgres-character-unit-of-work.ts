import pg from "pg";
import {
  withPgTransaction,
  type PgPool,
  type PgPoolClient,
} from "../../../shared/db/pool.js";
import {
  claimOrVerifyProcessedEvent,
  type ClaimProcessedEventInput,
  type ClaimProcessedEventResult,
} from "../../../shared/db/processed-events-inbox.js";
import type { ValidatedCharacterAppearance } from "../../peoples/domain/appearance.js";
import type { AttributeBlock } from "../../peoples/domain/character-snapshot-proposal.js";
import { PostgresCatalogRepository } from "../../peoples/infrastructure/postgres-catalog-repository.js";
import {
  DEFAULT_DEV_PROGRESSION_RULES_V1,
  type ProgressionRulesConfig,
} from "../domain/attributes-and-presets.js";
import {
  Character,
  type Account,
  type AccountStatus,
  type CharacterStatus,
  type CompetitiveLockState,
} from "../domain/character.js";
import {
  CharacterBuildConflictError,
  CharacterNameTakenError,
} from "../domain/errors.js";
import type { ExperienceSourceType } from "../domain/progression.js";

export type CharacterOutboxEventType =
  | "CharacterCreated"
  | "CharacterAppearanceChanged"
  | "CharacterExperienceGranted"
  | "CharacterLevelUp"
  | "CharacterAttributesAllocated"
  | "CharacterAttributesReset"
  | "CharacterBuildChanged";

export interface ExperienceGrantRecord {
  readonly id: string;
  readonly processedEventId: string;
  readonly externalGrantId: string;
  readonly characterId: string;
  readonly sourceType: ExperienceSourceType;
  readonly sourceReference: string;
  readonly rulesVersion: number;
  readonly validatedAmount: bigint;
  readonly previousXp: bigint;
  readonly newXp: bigint;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly attributePointsAwarded: number;
  readonly payloadFingerprint: string;
  readonly grantedAt: Date;
}

export interface CharacterBuildHistoryRecord {
  readonly id: string;
  readonly characterId: string;
  readonly buildVersion: number;
  readonly operationType: "initial_creation" | "allocate_points" | "respec_reset";
  readonly causeEventId: string;
  readonly presetCode: string | null;
  readonly previousAllocated: AttributeBlock;
  readonly newAllocated: AttributeBlock;
  readonly unspentAfter: number;
  readonly recordedAt: Date;
}

interface AccountRow {
  id: string;
  external_subject: string | null;
  status: AccountStatus;
  max_characters_override: number | null;
  created_at: Date;
  updated_at: Date;
}

interface ProgressionRulesRow {
  rules_version: number;
  code: string;
  base_points_per_attribute: number;
  creation_allocatable_points: number;
  points_per_level: number;
  max_effective_before_equipment: number;
  min_level: number;
  max_level: number;
  xp_curve_type: "quadratic_polynomial_v1";
  xp_curve_base: string;
  xp_curve_linear: string;
  xp_curve_quadratic: string;
  max_characters_per_account: number;
}

interface JoinedCharacterRow {
  id: string;
  account_id: string;
  display_name: string;
  canonical_name: string;
  race_code: string;
  lineage_code: string;
  culture_code: string;
  background_code: string;
  origin_region_id: string;
  hometown_settlement_ref: string | null;
  rules_version: number;
  level: number;
  experience_total: string;
  earned_attribute_points: number;
  allocated_attribute_points: number;
  unspent_attribute_points: number;
  build_version: number;
  snapshot_version: number;
  status: CharacterStatus;
  competitive_lock_state: CompetitiveLockState;
  created_at: Date;
  updated_at: Date;

  base_strength: number;
  base_fortitude: number;
  base_vigor: number;
  base_agility: number;
  base_dexterity: number;
  base_intelligence: number;
  base_wisdom: number;
  base_determination: number;
  base_luck: number;
  base_charisma: number;

  alloc_strength: number;
  alloc_fortitude: number;
  alloc_vigor: number;
  alloc_agility: number;
  alloc_dexterity: number;
  alloc_intelligence: number;
  alloc_wisdom: number;
  alloc_determination: number;
  alloc_luck: number;
  alloc_charisma: number;

  appearance_catalog_version: number;
  body_preset: string;
  skin_tone: string;
  hair_style: string | null;
  hair_color: string | null;
  eye_style: string;
  eye_color: string;
  facial_features: string | null;
  beard_style: string | null;
  ear_style: string | null;
  horn_style: string | null;
  tail_style: string | null;
  scale_pattern: string | null;
  tattoos: ReadonlyArray<string>;
  scars: ReadonlyArray<string>;
  cosmetic_accessories: ReadonlyArray<string>;
  voice_profile: string | null;
  appearance_version: number;
}

const JOINED_CHARACTER_SELECT = `
  SELECT
    c.id,
    c.account_id,
    c.display_name,
    c.canonical_name,
    c.race_code,
    c.lineage_code,
    c.culture_code,
    c.background_code,
    c.origin_region_id,
    c.hometown_settlement_ref,
    c.rules_version,
    c.level,
    c.experience_total::text AS experience_total,
    c.earned_attribute_points,
    c.allocated_attribute_points,
    c.unspent_attribute_points,
    c.build_version,
    c.snapshot_version,
    c.status,
    c.competitive_lock_state,
    c.created_at,
    c.updated_at,
    ca.base_strength,
    ca.base_fortitude,
    ca.base_vigor,
    ca.base_agility,
    ca.base_dexterity,
    ca.base_intelligence,
    ca.base_wisdom,
    ca.base_determination,
    ca.base_luck,
    ca.base_charisma,
    ca.alloc_strength,
    ca.alloc_fortitude,
    ca.alloc_vigor,
    ca.alloc_agility,
    ca.alloc_dexterity,
    ca.alloc_intelligence,
    ca.alloc_wisdom,
    ca.alloc_determination,
    ca.alloc_luck,
    ca.alloc_charisma,
    cp.appearance_catalog_version,
    cp.body_preset,
    cp.skin_tone,
    cp.hair_style,
    cp.hair_color,
    cp.eye_style,
    cp.eye_color,
    cp.facial_features,
    cp.beard_style,
    cp.ear_style,
    cp.horn_style,
    cp.tail_style,
    cp.scale_pattern,
    cp.tattoos,
    cp.scars,
    cp.cosmetic_accessories,
    cp.voice_profile,
    cp.appearance_version
  FROM characters c
  INNER JOIN character_attributes ca ON ca.character_id = c.id
  INNER JOIN character_appearance cp ON cp.character_id = c.id
`;

function mapJoinedCharacter(row: JoinedCharacterRow): Character {
  const appearance: ValidatedCharacterAppearance = {
    appearanceCatalogVersion: row.appearance_catalog_version,
    bodyPreset: row.body_preset,
    skinTone: row.skin_tone,
    hairStyle: row.hair_style,
    hairColor: row.hair_color,
    eyeStyle: row.eye_style,
    eyeColor: row.eye_color,
    facialFeatures: row.facial_features,
    beardStyle: row.beard_style,
    earStyle: row.ear_style,
    hornStyle: row.horn_style,
    tailStyle: row.tail_style,
    scalePattern: row.scale_pattern,
    tattoos: row.tattoos,
    scars: row.scars,
    cosmeticAccessories: row.cosmetic_accessories,
    voiceProfile: row.voice_profile,
  };

  return new Character({
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    canonicalName: row.canonical_name,
    raceCode: row.race_code,
    lineageCode: row.lineage_code,
    cultureCode: row.culture_code,
    backgroundCode: row.background_code,
    originRegionId: row.origin_region_id,
    hometownSettlementRef: row.hometown_settlement_ref,
    rulesVersion: row.rules_version,
    level: row.level,
    experienceTotal: BigInt(row.experience_total),
    earnedAttributePoints: row.earned_attribute_points,
    allocatedAttributePoints: row.allocated_attribute_points,
    unspentAttributePoints: row.unspent_attribute_points,
    baseAttributes: {
      strength: row.base_strength,
      fortitude: row.base_fortitude,
      vigor: row.base_vigor,
      agility: row.base_agility,
      dexterity: row.base_dexterity,
      intelligence: row.base_intelligence,
      wisdom: row.base_wisdom,
      determination: row.base_determination,
      luck: row.base_luck,
      charisma: row.base_charisma,
    },
    allocatedAttributes: {
      strength: row.alloc_strength,
      fortitude: row.alloc_fortitude,
      vigor: row.alloc_vigor,
      agility: row.alloc_agility,
      dexterity: row.alloc_dexterity,
      intelligence: row.alloc_intelligence,
      wisdom: row.alloc_wisdom,
      determination: row.alloc_determination,
      luck: row.alloc_luck,
      charisma: row.alloc_charisma,
    },
    appearance,
    appearanceVersion: row.appearance_version,
    buildVersion: row.build_version,
    snapshotVersion: row.snapshot_version,
    status: row.status,
    competitiveLockState: row.competitive_lock_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapAccountRow(row: AccountRow): Account {
  return {
    id: row.id,
    externalSubject: row.external_subject,
    status: row.status,
    maxCharactersOverride: row.max_characters_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRulesRow(row: ProgressionRulesRow): ProgressionRulesConfig {
  return {
    rulesVersion: row.rules_version,
    code: row.code,
    basePointsPerAttribute: row.base_points_per_attribute,
    creationAllocatablePoints: row.creation_allocatable_points,
    pointsPerLevel: row.points_per_level,
    maxEffectiveBeforeEquipment: row.max_effective_before_equipment,
    minLevel: row.min_level,
    maxLevel: row.max_level,
    xpCurveType: row.xp_curve_type,
    xpCurveBase: BigInt(row.xp_curve_base),
    xpCurveLinear: BigInt(row.xp_curve_linear),
    xpCurveQuadratic: BigInt(row.xp_curve_quadratic),
    maxCharactersPerAccount: row.max_characters_per_account,
  };
}

export class PgCharacterTransactionScope {
  public readonly client: PgPoolClient;
  public readonly catalogs: PostgresCatalogRepository;

  constructor(pool: PgPool, client: PgPoolClient) {
    this.client = client;
    this.catalogs = new PostgresCatalogRepository(pool);
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async loadProgressionRules(rulesVersion: number): Promise<ProgressionRulesConfig | null> {
    const res = await this.client.query<ProgressionRulesRow>(
      `SELECT
         rules_version,
         code,
         base_points_per_attribute,
         creation_allocatable_points,
         points_per_level,
         max_effective_before_equipment,
         min_level,
         max_level,
         xp_curve_type,
         xp_curve_base::text AS xp_curve_base,
         xp_curve_linear::text AS xp_curve_linear,
         xp_curve_quadratic::text AS xp_curve_quadratic,
         max_characters_per_account
       FROM progression_rules
       WHERE rules_version = $1 AND is_active = TRUE`,
      [rulesVersion],
    );
    const row = res.rows[0];
    return row ? mapRulesRow(row) : null;
  }

  public async lockAccountById(accountId: string): Promise<Account | null> {
    const res = await this.client.query<AccountRow>(
      `SELECT id, external_subject, status, max_characters_override, created_at, updated_at
       FROM accounts
       WHERE id = $1
       FOR UPDATE`,
      [accountId],
    );
    const row = res.rows[0];
    return row ? mapAccountRow(row) : null;
  }

  public async countCharactersForAccount(accountId: string): Promise<number> {
    const res = await this.client.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM characters WHERE account_id = $1 AND status <> 'archived'",
      [accountId],
    );
    return Number(res.rows[0]?.total ?? "0");
  }

  public async insertCharacterGraph(character: Character): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO characters (
           id,
           account_id,
           display_name,
           canonical_name,
           race_code,
           lineage_code,
           culture_code,
           background_code,
           origin_region_id,
           hometown_settlement_ref,
           rules_version,
           level,
           experience_total,
           earned_attribute_points,
           allocated_attribute_points,
           unspent_attribute_points,
           build_version,
           snapshot_version,
           status,
           competitive_lock_state,
           created_at,
           updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13::bigint, $14, $15, $16, $17, $18, $19, $20, $21, $22
         )`,
        [
          character.id,
          character.accountId,
          character.displayName,
          character.canonicalName,
          character.raceCode,
          character.lineageCode,
          character.cultureCode,
          character.backgroundCode,
          character.originRegionId,
          character.hometownSettlementRef,
          character.rulesVersion,
          character.level,
          character.experienceTotal.toString(),
          character.earnedAttributePoints,
          character.allocatedAttributePoints,
          character.unspentAttributePoints,
          character.buildVersion,
          character.snapshotVersion,
          character.status,
          character.competitiveLockState,
          character.createdAt,
          character.updatedAt,
        ],
      );
    } catch (error) {
      if (
        error instanceof pg.DatabaseError &&
        error.code === "23505" &&
        error.constraint === "uq_characters_canonical_name"
      ) {
        throw new CharacterNameTakenError(character.displayName);
      }
      throw error;
    }

    const b = character.baseAttributes;
    const a = character.allocatedAttributes;
    await this.client.query(
      `INSERT INTO character_attributes (
         character_id,
         base_strength, base_fortitude, base_vigor, base_agility, base_dexterity,
         base_intelligence, base_wisdom, base_determination, base_luck, base_charisma,
         alloc_strength, alloc_fortitude, alloc_vigor, alloc_agility, alloc_dexterity,
         alloc_intelligence, alloc_wisdom, alloc_determination, alloc_luck, alloc_charisma,
         updated_at
       )
       VALUES (
         $1,
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
         $22
       )`,
      [
        character.id,
        b.strength,
        b.fortitude,
        b.vigor,
        b.agility,
        b.dexterity,
        b.intelligence,
        b.wisdom,
        b.determination,
        b.luck,
        b.charisma,
        a.strength,
        a.fortitude,
        a.vigor,
        a.agility,
        a.dexterity,
        a.intelligence,
        a.wisdom,
        a.determination,
        a.luck,
        a.charisma,
        character.updatedAt,
      ],
    );

    const ap = character.appearance;
    await this.client.query(
      `INSERT INTO character_appearance (
         character_id,
         appearance_catalog_version,
         body_preset,
         skin_tone,
         hair_style,
         hair_color,
         eye_style,
         eye_color,
         facial_features,
         beard_style,
         ear_style,
         horn_style,
         tail_style,
         scale_pattern,
         tattoos,
         scars,
         cosmetic_accessories,
         voice_profile,
         appearance_version,
         updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20
       )`,
      [
        character.id,
        ap.appearanceCatalogVersion,
        ap.bodyPreset,
        ap.skinTone,
        ap.hairStyle,
        ap.hairColor,
        ap.eyeStyle,
        ap.eyeColor,
        ap.facialFeatures,
        ap.beardStyle,
        ap.earStyle,
        ap.hornStyle,
        ap.tailStyle,
        ap.scalePattern,
        JSON.stringify(ap.tattoos),
        JSON.stringify(ap.scars),
        JSON.stringify(ap.cosmeticAccessories),
        ap.voiceProfile,
        character.appearanceVersion,
        character.updatedAt,
      ],
    );
  }

  public async lockCharacterById(characterId: string): Promise<Character | null> {
    const res = await this.client.query<JoinedCharacterRow>(
      `${JOINED_CHARACTER_SELECT}
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [characterId],
    );
    const row = res.rows[0];
    return row ? mapJoinedCharacter(row) : null;
  }

  public async findCharacterById(characterId: string): Promise<Character | null> {
    const res = await this.client.query<JoinedCharacterRow>(
      `${JOINED_CHARACTER_SELECT}
       WHERE c.id = $1`,
      [characterId],
    );
    const row = res.rows[0];
    return row ? mapJoinedCharacter(row) : null;
  }

  public async updateBuildAndAttributes(
    updated: Character,
    expectedPreviousBuildVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE characters
       SET allocated_attribute_points = $1,
           unspent_attribute_points = $2,
           build_version = $3,
           snapshot_version = $4,
           updated_at = $5
       WHERE id = $6
         AND build_version = $7`,
      [
        updated.allocatedAttributePoints,
        updated.unspentAttributePoints,
        updated.buildVersion,
        updated.snapshotVersion,
        updated.updatedAt,
        updated.id,
        expectedPreviousBuildVersion,
      ],
    );

    if (res.rowCount !== 1) {
      throw new CharacterBuildConflictError(
        updated.id,
        expectedPreviousBuildVersion,
        updated.buildVersion,
      );
    }

    const a = updated.allocatedAttributes;
    await this.client.query(
      `UPDATE character_attributes
       SET alloc_strength = $1,
           alloc_fortitude = $2,
           alloc_vigor = $3,
           alloc_agility = $4,
           alloc_dexterity = $5,
           alloc_intelligence = $6,
           alloc_wisdom = $7,
           alloc_determination = $8,
           alloc_luck = $9,
           alloc_charisma = $10,
           updated_at = $11
       WHERE character_id = $12`,
      [
        a.strength,
        a.fortitude,
        a.vigor,
        a.agility,
        a.dexterity,
        a.intelligence,
        a.wisdom,
        a.determination,
        a.luck,
        a.charisma,
        updated.updatedAt,
        updated.id,
      ],
    );
  }

  public async updateProgression(updated: Character): Promise<void> {
    await this.client.query(
      `UPDATE characters
       SET level = $1,
           experience_total = $2::bigint,
           earned_attribute_points = $3,
           unspent_attribute_points = $4,
           snapshot_version = $5,
           updated_at = $6
       WHERE id = $7`,
      [
        updated.level,
        updated.experienceTotal.toString(),
        updated.earnedAttributePoints,
        updated.unspentAttributePoints,
        updated.snapshotVersion,
        updated.updatedAt,
        updated.id,
      ],
    );
  }

  public async updateAppearance(
    updated: Character,
    expectedPreviousAppearanceVersion: number,
  ): Promise<void> {
    const ap = updated.appearance;
    const res = await this.client.query(
      `UPDATE character_appearance
       SET appearance_catalog_version = $1,
           body_preset = $2,
           skin_tone = $3,
           hair_style = $4,
           hair_color = $5,
           eye_style = $6,
           eye_color = $7,
           facial_features = $8,
           beard_style = $9,
           ear_style = $10,
           horn_style = $11,
           tail_style = $12,
           scale_pattern = $13,
           tattoos = $14::jsonb,
           scars = $15::jsonb,
           cosmetic_accessories = $16::jsonb,
           voice_profile = $17,
           appearance_version = $18,
           updated_at = $19
       WHERE character_id = $20
         AND appearance_version = $21`,
      [
        ap.appearanceCatalogVersion,
        ap.bodyPreset,
        ap.skinTone,
        ap.hairStyle,
        ap.hairColor,
        ap.eyeStyle,
        ap.eyeColor,
        ap.facialFeatures,
        ap.beardStyle,
        ap.earStyle,
        ap.hornStyle,
        ap.tailStyle,
        ap.scalePattern,
        JSON.stringify(ap.tattoos),
        JSON.stringify(ap.scars),
        JSON.stringify(ap.cosmeticAccessories),
        ap.voiceProfile,
        updated.appearanceVersion,
        updated.updatedAt,
        updated.id,
        expectedPreviousAppearanceVersion,
      ],
    );

    if (res.rowCount !== 1) {
      throw new CharacterBuildConflictError(
        updated.id,
        expectedPreviousAppearanceVersion,
        updated.appearanceVersion,
      );
    }

    await this.client.query("UPDATE characters SET updated_at = $1 WHERE id = $2", [
      updated.updatedAt,
      updated.id,
    ]);
  }

  public async insertExperienceGrant(record: ExperienceGrantRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO experience_grants (
         id,
         processed_event_id,
         external_grant_id,
         character_id,
         source_type,
         source_reference,
         rules_version,
         validated_amount,
         previous_xp,
         new_xp,
         previous_level,
         new_level,
         attribute_points_awarded,
         payload_fingerprint,
         granted_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::bigint, $9::bigint, $10::bigint,
         $11, $12, $13, $14, $15
       )`,
      [
        record.id,
        record.processedEventId,
        record.externalGrantId,
        record.characterId,
        record.sourceType,
        record.sourceReference,
        record.rulesVersion,
        record.validatedAmount.toString(),
        record.previousXp.toString(),
        record.newXp.toString(),
        record.previousLevel,
        record.newLevel,
        record.attributePointsAwarded,
        record.payloadFingerprint,
        record.grantedAt,
      ],
    );
  }

  public async findExperienceGrantByExternalId(
    externalGrantId: string,
  ): Promise<ExperienceGrantRecord | null> {
    const res = await this.client.query<{
      id: string;
      processed_event_id: string;
      external_grant_id: string;
      character_id: string;
      source_type: ExperienceSourceType;
      source_reference: string;
      rules_version: number;
      validated_amount: string;
      previous_xp: string;
      new_xp: string;
      previous_level: number;
      new_level: number;
      attribute_points_awarded: number;
      payload_fingerprint: string;
      granted_at: Date;
    }>(
      `SELECT
         id,
         processed_event_id,
         external_grant_id,
         character_id,
         source_type,
         source_reference,
         rules_version,
         validated_amount::text AS validated_amount,
         previous_xp::text AS previous_xp,
         new_xp::text AS new_xp,
         previous_level,
         new_level,
         attribute_points_awarded,
         payload_fingerprint,
         granted_at
       FROM experience_grants
       WHERE external_grant_id = $1`,
      [externalGrantId],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      processedEventId: row.processed_event_id,
      externalGrantId: row.external_grant_id,
      characterId: row.character_id,
      sourceType: row.source_type,
      sourceReference: row.source_reference,
      rulesVersion: row.rules_version,
      validatedAmount: BigInt(row.validated_amount),
      previousXp: BigInt(row.previous_xp),
      newXp: BigInt(row.new_xp),
      previousLevel: row.previous_level,
      newLevel: row.new_level,
      attributePointsAwarded: row.attribute_points_awarded,
      payloadFingerprint: row.payload_fingerprint,
      grantedAt: row.granted_at,
    };
  }

  public async insertBuildHistory(entry: CharacterBuildHistoryRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO character_build_history (
         id,
         character_id,
         build_version,
         operation_type,
         cause_event_id,
         preset_code,
         previous_allocated,
         new_allocated,
         unspent_after,
         recorded_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        entry.id,
        entry.characterId,
        entry.buildVersion,
        entry.operationType,
        entry.causeEventId,
        entry.presetCode,
        JSON.stringify(entry.previousAllocated),
        JSON.stringify(entry.newAllocated),
        entry.unspentAfter,
        entry.recordedAt,
      ],
    );
  }

  public async enqueueOutbox(params: {
    readonly id: string;
    readonly characterId: string;
    readonly eventType: CharacterOutboxEventType;
    readonly correlationUuid: string;
    readonly causationEventUuid: string;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_events (
         id,
         aggregate_type,
         aggregate_id,
         event_type,
         event_version,
         correlation_id,
         causation_event_id,
         payload,
         occurred_at
       )
       VALUES ($1, 'Character', $2, $3, 1, $4, $5, $6::jsonb, $7)`,
      [
        params.id,
        params.characterId,
        params.eventType,
        params.correlationUuid,
        params.causationEventUuid,
        JSON.stringify(params.payload),
        params.occurredAt,
      ],
    );
  }
}

export class PostgresCharacterUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: PgCharacterTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgCharacterTransactionScope(this.pool, client);
      return work(scope);
    });
  }
}

export class PostgresCharacterRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async seedProgressionRules(
    rules: ProgressionRulesConfig = DEFAULT_DEV_PROGRESSION_RULES_V1,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO progression_rules (
         rules_version,
         code,
         base_points_per_attribute,
         creation_allocatable_points,
         points_per_level,
         max_effective_before_equipment,
         min_level,
         max_level,
         xp_curve_type,
         xp_curve_base,
         xp_curve_linear,
         xp_curve_quadratic,
         max_characters_per_account,
         is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11::bigint, $12::bigint, $13, TRUE)
       ON CONFLICT (rules_version) DO UPDATE
         SET code = EXCLUDED.code,
             base_points_per_attribute = EXCLUDED.base_points_per_attribute,
             creation_allocatable_points = EXCLUDED.creation_allocatable_points,
             points_per_level = EXCLUDED.points_per_level,
             max_effective_before_equipment = EXCLUDED.max_effective_before_equipment,
             max_level = EXCLUDED.max_level,
             xp_curve_base = EXCLUDED.xp_curve_base,
             xp_curve_linear = EXCLUDED.xp_curve_linear,
             xp_curve_quadratic = EXCLUDED.xp_curve_quadratic,
             max_characters_per_account = EXCLUDED.max_characters_per_account`,
      [
        rules.rulesVersion,
        rules.code,
        rules.basePointsPerAttribute,
        rules.creationAllocatablePoints,
        rules.pointsPerLevel,
        rules.maxEffectiveBeforeEquipment,
        rules.minLevel,
        rules.maxLevel,
        rules.xpCurveType,
        rules.xpCurveBase.toString(),
        rules.xpCurveLinear.toString(),
        rules.xpCurveQuadratic.toString(),
        rules.maxCharactersPerAccount,
      ],
    );
  }

  public async createAccount(params: {
    readonly id: string;
    readonly externalSubject?: string | null | undefined;
    readonly maxCharactersOverride?: number | null | undefined;
  }): Promise<Account> {
    const res = await this.pool.query<AccountRow>(
      `INSERT INTO accounts (id, external_subject, status, max_characters_override)
       VALUES ($1, $2, 'active', $3)
       RETURNING id, external_subject, status, max_characters_override, created_at, updated_at`,
      [params.id, params.externalSubject ?? null, params.maxCharactersOverride ?? null],
    );
    return mapAccountRow(res.rows[0]!);
  }

  public async setCharacterCompetitiveLock(
    characterId: string,
    lockState: CompetitiveLockState,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE characters SET competitive_lock_state = $1, updated_at = NOW() WHERE id = $2",
      [lockState, characterId],
    );
  }

  public async findCharacterById(characterId: string): Promise<Character | null> {
    const res = await this.pool.query<JoinedCharacterRow>(
      `${JOINED_CHARACTER_SELECT}
       WHERE c.id = $1`,
      [characterId],
    );
    const row = res.rows[0];
    return row ? mapJoinedCharacter(row) : null;
  }

  public async listCharactersByAccount(accountId: string): Promise<ReadonlyArray<Character>> {
    const res = await this.pool.query<JoinedCharacterRow>(
      `${JOINED_CHARACTER_SELECT}
       WHERE c.account_id = $1
       ORDER BY c.created_at ASC`,
      [accountId],
    );
    return res.rows.map(mapJoinedCharacter);
  }

  public async listBuildHistory(
    characterId: string,
  ): Promise<ReadonlyArray<CharacterBuildHistoryRecord>> {
    const res = await this.pool.query<{
      id: string;
      character_id: string;
      build_version: number;
      operation_type: "initial_creation" | "allocate_points" | "respec_reset";
      cause_event_id: string;
      preset_code: string | null;
      previous_allocated: AttributeBlock;
      new_allocated: AttributeBlock;
      unspent_after: number;
      recorded_at: Date;
    }>(
      `SELECT
         id,
         character_id,
         build_version,
         operation_type,
         cause_event_id,
         preset_code,
         previous_allocated,
         new_allocated,
         unspent_after,
         recorded_at
       FROM character_build_history
       WHERE character_id = $1
       ORDER BY build_version ASC`,
      [characterId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      characterId: r.character_id,
      buildVersion: r.build_version,
      operationType: r.operation_type,
      causeEventId: r.cause_event_id,
      presetCode: r.preset_code,
      previousAllocated: r.previous_allocated,
      newAllocated: r.new_allocated,
      unspentAfter: r.unspent_after,
      recordedAt: r.recorded_at,
    }));
  }

  public async listCharacterOutboxEvents(characterId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly publishedAt: Date | null;
    }>
  > {
    const res = await this.pool.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      published_at: Date | null;
    }>(
      `SELECT id, event_type, payload, published_at
       FROM outbox_events
       WHERE aggregate_type = 'Character'
         AND aggregate_id = $1
       ORDER BY created_at ASC, id ASC`,
      [characterId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      payload: r.payload,
      publishedAt: r.published_at,
    }));
  }
}
