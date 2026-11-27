import { z } from "zod";
import {
  NonNegativeInt64Schema,
  SignedInt64Schema,
} from "../../../shared/contracts/int64-wire.js";
import { BoundaryValidationError } from "../../../shared/contracts/world-events.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import type { AuthorityPrincipal } from "../../characters/domain/character.js";
import {
  CharacterNotFoundError,
  GenesisTemporaryStatePersistenceForbiddenError,
} from "../../characters/domain/errors.js";
import { PgCharacterTransactionScope } from "../../characters/infrastructure/postgres-character-unit-of-work.js";
import type { CriminalState, SafeZoneAccessDecision } from "../domain/criminality-and-bounties.js";
import { SocialAuthorizationForbiddenError } from "../domain/errors.js";
import { MORAL_BAND_CODES, type MoralBandCode } from "../domain/social-standing.js";
import { TITLE_CATEGORIES, TITLE_RARITIES, type TitleCategory, type TitleRarity } from "../../titles/domain/title-contracts.js";

export type SocialProjectionScope =
  | "public_limited"
  | "self_character"
  | "internal_authorized"
  | "judicial_authority";

export interface SocialStandingSnapshotV1 {
  readonly contractVersion: 1;
  readonly projectionScope: SocialProjectionScope;
  readonly characterId: string;
  readonly displayName: string;
  readonly socialVersion: number;
  readonly moralBand: MoralBandCode;
  /** Included in self_character, internal_authorized, judicial_authority; omitted in public_limited */
  readonly moralBounty?: bigint | undefined;
  readonly globalFame: bigint;
  readonly regionalFame: ReadonlyArray<{
    readonly regionId: string;
    readonly fame: bigint;
    readonly regionalMoralBounty: bigint;
  }>;
  readonly factionReputations: ReadonlyArray<{
    readonly factionId: string;
    readonly factionCode: string;
    readonly standingValue: number;
  }>;
  readonly settlementReputations: ReadonlyArray<{
    readonly settlementId: string;
    readonly settlementExternalId: string;
    readonly standingValue: number;
  }>;
  readonly criminalStatusSummary: ReadonlyArray<{
    readonly jurisdictionId: string;
    readonly criminalState: CriminalState;
    readonly safeZoneAccess: SafeZoneAccessDecision;
    readonly activeWarrantsCount: number;
  }>;
  readonly activeWarrantSummary: ReadonlyArray<{
    readonly warrantId: string;
    readonly jurisdictionId: string;
    readonly issuingAuthorityId: string;
  }>;
  readonly equippedTitle: {
    readonly titleCode: string;
    readonly displayName: string;
    readonly category: TitleCategory;
    readonly rarity: TitleRarity;
  } | null;
  readonly recognitionFlags: ReadonlyArray<string>;
}

export const SocialStandingSnapshotWireV1Schema = z
  .object({
    contract_version: z.literal(1),
    projection_scope: z.enum([
      "public_limited",
      "self_character",
      "internal_authorized",
      "judicial_authority",
    ]),
    character_id: z.string().uuid(),
    display_name: z.string().min(3).max(24),
    social_version: z.number().int().min(1),
    moral_band: z.enum(MORAL_BAND_CODES),
    moral_bounty: SignedInt64Schema.optional(),
    global_fame: NonNegativeInt64Schema,
    regional_fame: z.array(
      z
        .object({
          region_id: z.string().min(2).max(64),
          fame: NonNegativeInt64Schema,
          regional_moral_bounty: SignedInt64Schema,
        })
        .strict(),
    ),
    faction_reputations: z.array(
      z
        .object({
          faction_id: z.string().uuid(),
          faction_code: z.string().min(1).max(64),
          standing_value: z.number().int(),
        })
        .strict(),
    ),
    settlement_reputations: z.array(
      z
        .object({
          settlement_id: z.string().uuid(),
          settlement_external_id: z.string().min(1).max(128),
          standing_value: z.number().int(),
        })
        .strict(),
    ),
    criminal_status_summary: z.array(
      z
        .object({
          jurisdiction_id: z.string().min(2).max(64),
          criminal_state: z.enum([
            "Clear",
            "Suspected",
            "Wanted",
            "Fugitive",
            "Captured",
            "ServingSentence",
            "Pardoned",
          ]),
          safe_zone_access: z.enum([
            "permitted",
            "monitored",
            "restricted_arrest_on_sight",
          ]),
          active_warrants_count: z.number().int().min(0),
        })
        .strict(),
    ),
    active_warrant_summary: z.array(
      z
        .object({
          warrant_id: z.string().uuid(),
          jurisdiction_id: z.string().min(2).max(64),
          issuing_authority_id: z.string().min(1).max(128),
        })
        .strict(),
    ),
    equipped_title: z
      .object({
        title_code: z.string().min(2).max(64),
        display_name: z.string().min(1).max(120),
        category: z.enum(TITLE_CATEGORIES),
        rarity: z.enum(TITLE_RARITIES),
      })
      .strict()
      .nullable(),
    recognition_flags: z.array(z.string().min(1).max(64)),
  })
  .strict();

export type SocialStandingSnapshotWireV1 = {
  readonly contract_version: 1;
  readonly projection_scope: SocialProjectionScope;
  readonly character_id: string;
  readonly display_name: string;
  readonly social_version: number;
  readonly moral_band: MoralBandCode;
  readonly moral_bounty?: string;
  readonly global_fame: string;
  readonly regional_fame: ReadonlyArray<{
    readonly region_id: string;
    readonly fame: string;
    readonly regional_moral_bounty: string;
  }>;
  readonly faction_reputations: ReadonlyArray<{
    readonly faction_id: string;
    readonly faction_code: string;
    readonly standing_value: number;
  }>;
  readonly settlement_reputations: ReadonlyArray<{
    readonly settlement_id: string;
    readonly settlement_external_id: string;
    readonly standing_value: number;
  }>;
  readonly criminal_status_summary: ReadonlyArray<{
    readonly jurisdiction_id: string;
    readonly criminal_state: CriminalState;
    readonly safe_zone_access: SafeZoneAccessDecision;
    readonly active_warrants_count: number;
  }>;
  readonly active_warrant_summary: ReadonlyArray<{
    readonly warrant_id: string;
    readonly jurisdiction_id: string;
    readonly issuing_authority_id: string;
  }>;
  readonly equipped_title: {
    readonly title_code: string;
    readonly display_name: string;
    readonly category: TitleCategory;
    readonly rarity: TitleRarity;
  } | null;
  readonly recognition_flags: ReadonlyArray<string>;
};

export function serializeSocialStandingSnapshotWireV1(
  snap: SocialStandingSnapshotV1,
): SocialStandingSnapshotWireV1 {
  return {
    contract_version: 1,
    projection_scope: snap.projectionScope,
    character_id: snap.characterId,
    display_name: snap.displayName,
    social_version: snap.socialVersion,
    moral_band: snap.moralBand,
    ...(snap.moralBounty !== undefined ? { moral_bounty: snap.moralBounty.toString() } : {}),
    global_fame: snap.globalFame.toString(),
    regional_fame: snap.regionalFame.map((r) => ({
      region_id: r.regionId,
      fame: r.fame.toString(),
      regional_moral_bounty: r.regionalMoralBounty.toString(),
    })),
    faction_reputations: snap.factionReputations.map((f) => ({
      faction_id: f.factionId,
      faction_code: f.factionCode,
      standing_value: f.standingValue,
    })),
    settlement_reputations: snap.settlementReputations.map((s) => ({
      settlement_id: s.settlementId,
      settlement_external_id: s.settlementExternalId,
      standing_value: s.standingValue,
    })),
    criminal_status_summary: snap.criminalStatusSummary.map((c) => ({
      jurisdiction_id: c.jurisdictionId,
      criminal_state: c.criminalState,
      safe_zone_access: c.safeZoneAccess,
      active_warrants_count: c.activeWarrantsCount,
    })),
    active_warrant_summary: snap.activeWarrantSummary.map((w) => ({
      warrant_id: w.warrantId,
      jurisdiction_id: w.jurisdictionId,
      issuing_authority_id: w.issuingAuthorityId,
    })),
    equipped_title: snap.equippedTitle
      ? {
          title_code: snap.equippedTitle.titleCode,
          display_name: snap.equippedTitle.displayName,
          category: snap.equippedTitle.category,
          rarity: snap.equippedTitle.rarity,
        }
      : null,
    recognition_flags: snap.recognitionFlags,
  };
}

export function parseSocialStandingSnapshotWireV1(raw: unknown): SocialStandingSnapshotV1 {
  const parsed = SocialStandingSnapshotWireV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new BoundaryValidationError(
      `Invalid SocialStandingSnapshotWireV1: ${issues.join("; ")}`,
      issues,
    );
  }
  const d = parsed.data;
  return {
    contractVersion: 1,
    projectionScope: d.projection_scope,
    characterId: d.character_id,
    displayName: d.display_name,
    socialVersion: d.social_version,
    moralBand: d.moral_band,
    ...(d.moral_bounty !== undefined ? { moralBounty: d.moral_bounty } : {}),
    globalFame: d.global_fame,
    regionalFame: d.regional_fame.map((r) => ({
      regionId: r.region_id,
      fame: r.fame,
      regionalMoralBounty: r.regional_moral_bounty,
    })),
    factionReputations: d.faction_reputations.map((f) => ({
      factionId: f.faction_id,
      factionCode: f.faction_code,
      standingValue: f.standing_value,
    })),
    settlementReputations: d.settlement_reputations.map((s) => ({
      settlementId: s.settlement_id,
      settlementExternalId: s.settlement_external_id,
      standingValue: s.standing_value,
    })),
    criminalStatusSummary: d.criminal_status_summary.map((c) => ({
      jurisdictionId: c.jurisdiction_id,
      criminalState: c.criminal_state,
      safeZoneAccess: c.safe_zone_access,
      activeWarrantsCount: c.active_warrants_count,
    })),
    activeWarrantSummary: d.active_warrant_summary.map((w) => ({
      warrantId: w.warrant_id,
      jurisdictionId: w.jurisdiction_id,
      issuingAuthorityId: w.issuing_authority_id,
    })),
    equippedTitle: d.equipped_title
      ? {
          titleCode: d.equipped_title.title_code,
          displayName: d.equipped_title.display_name,
          category: d.equipped_title.category,
          rarity: d.equipped_title.rarity,
        }
      : null,
    recognitionFlags: d.recognition_flags,
  };
}

export interface GetSocialStandingSnapshotOptions {
  readonly principal: AuthorityPrincipal;
  readonly projectionScope: SocialProjectionScope;
  readonly jurisdictionFilterId?: string | undefined;
  readonly normalizationProfile?: CompetitiveNormalizationProfile | undefined;
}

export class PostgresSocialSnapshotReader {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  /**
   * Projects a read-only `SocialStandingSnapshotV1` from a consistent `REPEATABLE READ` snapshot,
   * enforcing strict visibility & privacy rules across the 4 projection scopes without exposing
   * account IDs, unconfirmed investigation details to third parties, or full audit ledgers.
   */
  public async getSocialStandingSnapshot(
    characterId: string,
    options: GetSocialStandingSnapshotOptions,
  ): Promise<SocialStandingSnapshotV1> {
    if (options.normalizationProfile === "genesis_ranked_md3_scratch") {
      throw new GenesisTemporaryStatePersistenceForbiddenError("getSocialStandingSnapshot");
    }

    // Validate caller authorization for requested projectionScope BEFORE exposing sensitive state
    if (
      options.projectionScope === "internal_authorized" ||
      options.projectionScope === "judicial_authority"
    ) {
      if (options.principal.kind !== "internal_system_authority") {
        throw new SocialAuthorizationForbiddenError(
          `Projection scope '${options.projectionScope}' requires internal_system_authority.`,
        );
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const charScope = new PgCharacterTransactionScope(this.pool, client);
      const character = await charScope.findCharacterById(characterId);
      if (!character) {
        throw new CharacterNotFoundError(characterId);
      }

      if (options.projectionScope === "self_character") {
        character.assertOwnedByOrSystem(options.principal);
      }

      const socRes = await client.query<{
        moral_bounty: string;
        moral_band: MoralBandCode;
        global_fame: string;
        settlement_defenses_count: number;
        settlement_liberations_count: number;
        bounties_fulfilled_count: number;
        equipped_title_code: string | null;
        social_version: number;
      }>(
        "SELECT * FROM character_social_standing WHERE character_id = $1::uuid",
        [character.id],
      );

      const soc = socRes.rows[0] ?? {
        moral_bounty: "0",
        moral_band: "neutral" as const,
        global_fame: "0",
        settlement_defenses_count: 0,
        settlement_liberations_count: 0,
        bounties_fulfilled_count: 0,
        equipped_title_code: null,
        social_version: 1,
      };

      const moralBounty = BigInt(soc.moral_bounty);
      const globalFame = BigInt(soc.global_fame);

      let equippedTitle: SocialStandingSnapshotV1["equippedTitle"] = null;
      if (soc.equipped_title_code) {
        const tdRes = await client.query<{
          title_code: string;
          display_name: string;
          category: TitleCategory;
          rarity: TitleRarity;
        }>(
          "SELECT title_code, display_name, category, rarity FROM title_definitions WHERE title_code = $1",
          [soc.equipped_title_code],
        );
        const td = tdRes.rows[0];
        if (td) {
          equippedTitle = {
            titleCode: td.title_code,
            displayName: td.display_name,
            category: td.category,
            rarity: td.rarity,
          };
        }
      }

      const flags: string[] = [];
      if (soc.settlement_defenses_count > 0) {
        flags.push("city_defender");
      }
      if (soc.settlement_liberations_count > 0) {
        flags.push("settlement_liberator");
      }
      if (soc.bounties_fulfilled_count > 0) {
        flags.push("bounty_hunter");
      }
      if (globalFame >= 1000n) {
        flags.push("renowned_figure");
      }

      const isPublicLimited = options.projectionScope === "public_limited";

      const regRes = isPublicLimited
        ? { rows: [] as Array<{ region_id: string; regional_fame: string; regional_moral_bounty: string }> }
        : await client.query<{
            region_id: string;
            regional_fame: string;
            regional_moral_bounty: string;
          }>(
            "SELECT region_id, regional_fame, regional_moral_bounty FROM character_regional_standing WHERE character_id = $1::uuid ORDER BY region_id ASC",
            [character.id],
          );

      const facRepsRes = isPublicLimited
        ? { rows: [] as Array<{ faction_id: string; code: string; standing_value: number }> }
        : await client.query<{
            faction_id: string;
            code: string;
            standing_value: number;
          }>(
            `SELECT cr.faction_id, f.code, cr.standing_value
             FROM character_reputations cr
             INNER JOIN factions f ON f.id = cr.faction_id
             WHERE cr.character_id = $1::uuid AND cr.scope_type = 'faction'
             ORDER BY f.code ASC`,
            [character.id],
          );

      const setRepsRes = isPublicLimited
        ? { rows: [] as Array<{ settlement_id: string; external_id: string | null; standing_value: number }> }
        : await client.query<{
            settlement_id: string;
            external_id: string | null;
            standing_value: number;
          }>(
            `SELECT cr.settlement_id, s.external_id, cr.standing_value
             FROM character_reputations cr
             INNER JOIN settlements s ON s.id = cr.settlement_id
             WHERE cr.character_id = $1::uuid AND cr.scope_type = 'settlement'
             ORDER BY cr.settlement_id ASC`,
            [character.id],
          );

      // Criminal status & warrants:
      // - `public_limited` NEVER exposes private 'Suspected' state; only public 'Wanted'/'Fugitive' notices!
      // - `judicial_authority` optionally scopes to `jurisdictionFilterId`.
      const jurStatusesRes = await client.query<{
        jurisdiction_id: string;
        criminal_state: CriminalState;
        safe_zone_access: SafeZoneAccessDecision;
        active_warrants_count: number;
      }>(
        `SELECT jurisdiction_id, criminal_state, safe_zone_access, active_warrants_count
         FROM character_jurisdiction_status
         WHERE character_id = $1::uuid
         ORDER BY jurisdiction_id ASC`,
        [character.id],
      );

      const filteredJurStatuses = jurStatusesRes.rows.filter((j) => {
        if (options.jurisdictionFilterId && j.jurisdiction_id !== options.jurisdictionFilterId) {
          return false;
        }
        if (isPublicLimited) {
          return j.criminal_state === "Wanted" || j.criminal_state === "Fugitive";
        }
        return true;
      });

      const warrantsRes = await client.query<{
        id: string;
        jurisdiction_id: string;
        issuing_authority_id: string;
      }>(
        `SELECT id, jurisdiction_id, issuing_authority_id
         FROM criminal_warrants
         WHERE target_character_id = $1::uuid AND status = 'active'
         ORDER BY issued_at ASC`,
        [character.id],
      );

      const filteredWarrants = warrantsRes.rows.filter(
        (w) => !options.jurisdictionFilterId || w.jurisdiction_id === options.jurisdictionFilterId,
      );
      if (filteredWarrants.length > 0) {
        flags.push("wanted_warrant_active");
      }

      await client.query("COMMIT");

      const snap: SocialStandingSnapshotV1 = {
        contractVersion: 1,
        projectionScope: options.projectionScope,
        characterId: character.id,
        displayName: character.displayName,
        socialVersion: soc.social_version,
        moralBand: soc.moral_band,
        ...(isPublicLimited ? {} : { moralBounty }),
        globalFame,
        regionalFame: regRes.rows.map((r) => ({
          regionId: r.region_id,
          fame: BigInt(r.regional_fame),
          regionalMoralBounty: BigInt(r.regional_moral_bounty),
        })),
        factionReputations: facRepsRes.rows.map((f) => ({
          factionId: f.faction_id,
          factionCode: f.code,
          standingValue: f.standing_value,
        })),
        settlementReputations: setRepsRes.rows.map((s) => ({
          settlementId: s.settlement_id,
          settlementExternalId: s.external_id ?? s.settlement_id,
          standingValue: s.standing_value,
        })),
        criminalStatusSummary: filteredJurStatuses.map((c) => ({
          jurisdictionId: c.jurisdiction_id,
          criminalState: c.criminal_state,
          safeZoneAccess: c.safe_zone_access,
          activeWarrantsCount: c.active_warrants_count,
        })),
        activeWarrantSummary: filteredWarrants.map((w) => ({
          warrantId: w.id,
          jurisdictionId: w.jurisdiction_id,
          issuingAuthorityId: w.issuing_authority_id,
        })),
        equippedTitle,
        recognitionFlags: flags,
      };

      const wire = serializeSocialStandingSnapshotWireV1(snap);
      return parseSocialStandingSnapshotWireV1(wire);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
