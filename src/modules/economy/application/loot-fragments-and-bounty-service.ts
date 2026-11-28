import {
  computeCanonicalFingerprintV1,
  deriveDeterministicEventUuid,
} from "../../../shared/contracts/canonical-fingerprint.js";
import type { PgPool } from "../../../shared/db/pool.js";
import type { Logger } from "../../../shared/observability/logger.js";
import type { IdempotentCommandOutcome } from "../../characters/application/character-engine-service.js";
import {
  assertAccountActive,
  assertNotGenesisContext,
  type AuthorityPrincipal,
} from "../../characters/domain/character.js";
import { CharacterCompetitiveLockedError } from "../../characters/domain/errors.js";
import {
  InventoryCapacityExceededError,
  ItemDefinitionNotFoundError,
} from "../../inventory/domain/errors.js";
import {
  buildStackEquivalenceKey,
  resolveInitialBindingOnGrant,
} from "../../inventory/domain/equipment-and-stack-rules.js";
import type { ItemInstance, ItemRarityCode } from "../../inventory/domain/item-types.js";
import { generateProceduralItemProperties } from "../../inventory/domain/procedural-generator.js";
import { SplitMix64Rng } from "../../inventory/domain/splitmix64-rng.js";
import type { CompetitiveNormalizationProfile } from "../../peoples/domain/character-snapshot-proposal.js";
import {
  assertCriminalBountyClaimEligible,
  type CriminalBounty,
  type CriminalBountyClaim,
} from "../../social/domain/criminality-and-bounties.js";
import { CriminalBountyInvalidError, SocialReferenceNotFoundError } from "../../social/domain/errors.js";
import type {
  AuthoritativeRewardGrantRecord,
  CharacterFragmentBalance,
  FragmentRedeemableOption,
  LootTableDefinition,
  LootTableEntryDefinition,
} from "../domain/economy-types.js";
import {
  CurrencyOperationForbiddenError,
  EscrowReservationStateError,
  LootOrRewardInvalidError,
} from "../domain/errors.js";
import {
  selectDeterministicLootEntry,
  validateLootTableDefinition,
} from "../domain/monetary-and-tax-rules.js";
import {
  PostgresEconomyUnitOfWork,
  type PgEconomyTransactionScope,
} from "../infrastructure/postgres-economy-unit-of-work.js";

export interface GrantAuthoritativeBossLootCommand {
  readonly rewardEventId: string;
  readonly principal: AuthorityPrincipal;
  readonly sourceEntityId: string;
  readonly characterId: string;
  readonly lootTableCode: string;
  readonly lootTableVersion?: number | undefined;
  readonly eligibilityReference: string;
  readonly rewardSlotIndex?: number | undefined;
  readonly serverEntropySecret: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantAntiBadLuckFragmentsCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly fragmentCode: string;
  readonly quantity: number;
  readonly progressReference: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface RedeemAntiBadLuckFragmentsCommand {
  readonly redemptionId: string;
  readonly principal: AuthorityPrincipal;
  readonly characterId: string;
  readonly fragmentCode: string;
  readonly selectedOptionCode: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface GrantContributionEconomicRewardCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly contributionEventId: string;
  readonly serverEntropySecret: string;
  readonly includeLootRoll?: boolean | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface FundDraftCriminalBountyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly bountyId: string;
  readonly reservationId: string;
  readonly issuerCharacterId?: string | undefined;
  readonly issuerSettlementId?: string | undefined;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface ClaimAndSettleVerifiedCriminalBountyCommand {
  readonly commandId: string;
  readonly principal: AuthorityPrincipal;
  readonly bountyId: string;
  readonly claimantCharacterId: string;
  readonly resolutionKind: "confirmed_capture" | "authorized_defeat";
  readonly authorityConfirmationRef: string;
  readonly executionProfile?: CompetitiveNormalizationProfile | undefined;
}

export interface SettledCriminalBountyOutcome {
  readonly bounty: CriminalBounty;
  readonly claim: CriminalBountyClaim & {
    readonly settlementLedgerTxId: string;
    readonly settledAt: Date;
  };
  readonly reservationId: string;
  readonly ledgerTxId: string;
}

function requireSystemPrincipal(principal: AuthorityPrincipal, operation: string): string {
  if (principal.kind !== "internal_system_authority") {
    throw new CurrencyOperationForbiddenError(
      `Operation '${operation}' requires internal_system_authority.`,
    );
  }
  return principal.actorId;
}

export class LootFragmentsAndBountyService {
  private readonly pool: PgPool;
  private readonly uow: PostgresEconomyUnitOfWork;
  private readonly logger: Logger;

  constructor(deps: { readonly pool: PgPool; readonly logger: Logger }) {
    this.pool = deps.pool;
    this.uow = new PostgresEconomyUnitOfWork(deps.pool);
    this.logger = deps.logger;
  }

  private async loadLootTable(
    scope: PgEconomyTransactionScope,
    code: string,
    version?: number,
  ): Promise<LootTableDefinition> {
    const tRes =
      version !== undefined
        ? await scope.client.query<Record<string, unknown>>(
            "SELECT * FROM loot_tables WHERE loot_table_code = $1 AND loot_table_version = $2",
            [code, version],
          )
        : await scope.client.query<Record<string, unknown>>(
            `SELECT * FROM loot_tables
             WHERE loot_table_code = $1 AND is_enabled = TRUE
             ORDER BY loot_table_version DESC LIMIT 1`,
            [code],
          );
    const t = tRes.rows[0];
    if (!t || !t["is_enabled"]) {
      throw new LootOrRewardInvalidError(`Loot table '${code}' not found or disabled.`);
    }
    const ver = Number(t["loot_table_version"]);
    const eRes = await scope.client.query<Record<string, unknown>>(
      `SELECT * FROM loot_table_entries
       WHERE loot_table_code = $1 AND loot_table_version = $2
       ORDER BY entry_code ASC`,
      [code, ver],
    );
    const entries: LootTableEntryDefinition[] = eRes.rows.map((e) => ({
      entryCode: String(e["entry_code"]),
      entryKind: e["entry_kind"] as LootTableEntryDefinition["entryKind"],
      itemDefinitionCode: (e["item_definition_code"] as string | null) ?? null,
      itemDefinitionVersion:
        e["item_definition_version"] === null ? null : Number(e["item_definition_version"]),
      currencyCode: (e["currency_code"] as string | null) ?? null,
      weight: Number(e["weight"]),
      minQuantity: Number(e["min_quantity"]),
      maxQuantity: Number(e["max_quantity"]),
      allowedRarities: e["allowed_rarities"] as ReadonlyArray<ItemRarityCode>,
      rarityWeights: e["rarity_weights"] as Readonly<Partial<Record<ItemRarityCode, number>>>,
      minItemLevel: Number(e["min_item_level"]),
      maxItemLevel: Number(e["max_item_level"]),
    }));

    const table: LootTableDefinition = {
      lootTableCode: String(t["loot_table_code"]),
      lootTableVersion: ver,
      displayName: String(t["display_name"]),
      sourceCategory: t["source_category"] as LootTableDefinition["sourceCategory"],
      guaranteedFragmentCode: (t["guaranteed_fragment_code"] as string | null) ?? null,
      guaranteedFragmentQty: Number(t["guaranteed_fragment_qty"]),
      rollsCount: Number(t["rolls_count"]),
      isEnabled: Boolean(t["is_enabled"]),
      rulesVersion: Number(t["rules_version"]),
      entries,
    };
    validateLootTableDefinition(table);
    return table;
  }

  private async reconstructRewardGrantRecord(
    scope: PgEconomyTransactionScope,
    rewardEventId: string,
  ): Promise<AuthoritativeRewardGrantRecord> {
    const res = await scope.client.query<Record<string, unknown>>(
      "SELECT * FROM reward_grants WHERE reward_event_id = $1",
      [rewardEventId],
    );
    const r = res.rows[0]!;
    const raw = r["reward_result"] as {
      itemInstanceIds: string[];
      grantedStacks: Array<{ definitionCode: string; quantity: number }>;
      mintedCurrency: { currencyCode: string; amount: string; ledgerTxId: string } | null;
      grantedFragments: { fragmentCode: string; quantity: number; newBalance: number } | null;
    };
    const items: ItemInstance[] = [];
    for (const iid of raw.itemInstanceIds) {
      const found = await scope.inventory.findItemInstanceById(iid);
      if (found) {
        items.push(found);
      }
    }
    return {
      id: String(r["id"]),
      rewardEventId: String(r["reward_event_id"]),
      sourceType: r["source_type"] as AuthoritativeRewardGrantRecord["sourceType"],
      sourceEntityId: String(r["source_entity_id"]),
      characterId: String(r["character_id"]),
      lootTableCode: (r["loot_table_code"] as string | null) ?? null,
      lootTableVersion: r["loot_table_version"] === null ? null : Number(r["loot_table_version"]),
      eligibilityReference: String(r["eligibility_reference"]),
      rewardSlotIndex: Number(r["reward_slot_index"]),
      generationSeedHash: String(r["generation_seed_hash"]),
      grantedItems: items,
      grantedStacks: raw.grantedStacks,
      mintedCurrency: raw.mintedCurrency
        ? {
            currencyCode: raw.mintedCurrency.currencyCode,
            amount: BigInt(raw.mintedCurrency.amount),
            ledgerTxId: raw.mintedCurrency.ledgerTxId,
          }
        : null,
      grantedFragments: raw.grantedFragments,
      rulesVersion: Number(r["rules_version"]),
      grantedAt: r["granted_at"] as Date,
    };
  }

  /**
   * Grants authoritative individual boss loot to a single eligible character.
   * Two players defeating the same `sourceEntityId` receive independent deterministic rolls
   * without sharing or stealing drops, and retries return the exact persisted reward without re-rolling.
   */
  public async grantAuthoritativeBossLoot(
    cmd: GrantAuthoritativeBossLootCommand,
  ): Promise<IdempotentCommandOutcome<AuthoritativeRewardGrantRecord>> {
    assertNotGenesisContext("grantAuthoritativeBossLoot", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "grantAuthoritativeBossLoot");
    if (!cmd.serverEntropySecret.trim() || cmd.serverEntropySecret.trim().length < 8) {
      throw new LootOrRewardInvalidError(
        "serverEntropySecret must be at least 8 non-blank characters.",
      );
    }
    if (!cmd.eligibilityReference.trim()) {
      throw new LootOrRewardInvalidError("eligibilityReference cannot be blank.");
    }

    const rewardEventKey = cmd.rewardEventId.trim();
    const rewardSlotIndex = cmd.rewardSlotIndex ?? 0;
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(rewardEventKey);
    const grantRecordId = deriveDeterministicEventUuid(`reward-grant:${rewardEventKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantAuthoritativeBossLoot",
      reward_event_id: rewardEventKey,
      source_entity_id: cmd.sourceEntityId.trim(),
      character_id: cmd.characterId.toLowerCase(),
      loot_table_code: cmd.lootTableCode,
      loot_table_version: cmd.lootTableVersion ?? null,
      eligibility_reference: cmd.eligibilityReference.trim(),
      reward_slot_index: rewardSlotIndex,
      server_entropy_secret: cmd.serverEntropySecret.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const recipient = characters.get(cmd.characterId.toLowerCase())!;
      recipient.assertActiveStatus();
      assertAccountActive(accounts.get(recipient.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: rewardEventKey,
        idempotencyKey: rewardEventKey,
        eventType: "LootGranted",
        eventVersion: 1,
        source: `carbon.economy.loot:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: recipient.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const prev = await this.reconstructRewardGrantRecord(scope, rewardEventKey);
        return { status: "duplicate_idempotent", duplicate: true, data: prev };
      }

      const table = await this.loadLootTable(scope, cmd.lootTableCode, cmd.lootTableVersion);
      const genRules = (await scope.inventory.loadGenerationRules(1))!;
      const { bag } = await scope.inventory.ensureAndLockPrimaryContainers(
        recipient.id,
        genRules.defaultInventoryCapacity,
      );

      const masterSeed = [
        "ascendra:loot:v1",
        cmd.serverEntropySecret.trim(),
        cmd.sourceEntityId.trim(),
        recipient.id.toLowerCase(),
        String(rewardSlotIndex),
        table.lootTableCode,
        String(table.lootTableVersion),
      ].join("|");
      const rng = new SplitMix64Rng(masterSeed);

      const grantedItems: ItemInstance[] = [];
      const grantedStacks: Array<{ definitionCode: string; quantity: number }> = [];
      let totalCoinToMint = 0n;
      let mintCurrencyCode: string | null = null;

      for (let rollIdx = 0; rollIdx < table.rollsCount; rollIdx++) {
        const chosen = selectDeterministicLootEntry(table.entries, rng);
        const qty = rng.nextIntInclusive(chosen.minQuantity, chosen.maxQuantity);

        if (chosen.entryKind === "currency_mint") {
          mintCurrencyCode = chosen.currencyCode!;
          totalCoinToMint += BigInt(qty);
        } else if (chosen.entryKind === "material_stack") {
          const def = await scope.inventory.findItemDefinition(
            chosen.itemDefinitionCode!,
            chosen.itemDefinitionVersion ?? undefined,
          );
          if (!def) {
            throw new ItemDefinitionNotFoundError(
              chosen.itemDefinitionCode!,
              chosen.itemDefinitionVersion ?? 1,
            );
          }
          const bind = resolveInitialBindingOnGrant({
            policy: def.bindingPolicy,
            recipientAccountId: recipient.accountId,
            recipientCharacterId: recipient.id,
          });
          const eqKey = buildStackEquivalenceKey({
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            qualityBp: 5000,
            bindingState: bind.bindingState === "bind_on_equip" ? "unbound" : bind.bindingState,
            boundAccountId: bind.boundAccountId,
            boundCharacterId: bind.boundCharacterId,
          });
          const placed = await scope.deliverStackQuantityToCharacterContainers({
            recipient,
            primaryBag: bag,
            definition: def,
            quantity: qty,
            qualityBp: 5000,
            bindingState: bind.bindingState === "bind_on_equip" ? "unbound" : bind.bindingState,
            boundAccountId: bind.boundAccountId,
            boundCharacterId: bind.boundCharacterId,
            equivalenceKey: eqKey,
            allowPersonalStorageFallback: false,
            seedPrefix: `${rewardEventKey}:roll-${rollIdx}`,
          });
          await scope.inventory.appendLedger({
            operationId: `${rewardEventKey}:roll-${rollIdx}`,
            operationType: "grant",
            characterId: recipient.id,
            stackId: placed[0]?.id ?? null,
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            sourceLocation: `loot:${table.lootTableCode}`,
            destinationLocation: `container:${bag.id}`,
            quantity: qty,
            entityVersion: placed[0]?.version ?? 1,
            causeReference: rewardEventKey,
          });
          grantedStacks.push({ definitionCode: def.definitionCode, quantity: qty });
        } else {
          const def = await scope.inventory.findItemDefinition(
            chosen.itemDefinitionCode!,
            chosen.itemDefinitionVersion ?? undefined,
          );
          if (!def) {
            throw new ItemDefinitionNotFoundError(
              chosen.itemDefinitionCode!,
              chosen.itemDefinitionVersion ?? 1,
            );
          }
          // Weighted rarity selection within entry's allowedRarities
          let rTotal = 0;
          const rWeighted = chosen.allowedRarities.map((rc) => {
            const w = Math.max(1, chosen.rarityWeights[rc] ?? 100);
            rTotal += w;
            return { rc, w };
          });
          const rTicket = rng.nextIntInclusive(1, rTotal);
          let rAcc = 0;
          let pickedRarity: ItemRarityCode = rWeighted[rWeighted.length - 1]!.rc;
          for (const rw of rWeighted) {
            rAcc += rw.w;
            if (rTicket <= rAcc) {
              pickedRarity = rw.rc;
              break;
            }
          }

          const rarity = (await scope.inventory.findRarity(pickedRarity))!;
          const itemLevel = rng.nextIntInclusive(chosen.minItemLevel, chosen.maxItemLevel);
          const affixes = await scope.inventory.listAffixesForPools(def.allowedAffixPools);

          const freeSlots = await scope.inventory.findFreeContainerSlots(bag, 1);
          if (freeSlots.length < 1) {
            throw new InventoryCapacityExceededError(
              `Recipient '${recipient.id}' inventory is full for boss loot equipment.`,
            );
          }

          const gen = generateProceduralItemProperties({
            definition: def,
            rarity,
            rules: genRules,
            candidateAffixes: affixes,
            itemLevel,
            serverSeed: `${masterSeed}:equip:${rollIdx}`,
            originReference: cmd.sourceEntityId.trim(),
          });

          const bind = resolveInitialBindingOnGrant({
            policy: def.bindingPolicy,
            recipientAccountId: recipient.accountId,
            recipientCharacterId: recipient.id,
          });
          const instId = deriveDeterministicEventUuid(`loot-item:${rewardEventKey}:${rollIdx}`);
          const inst: ItemInstance = {
            id: instId,
            definitionCode: def.definitionCode,
            definitionVersion: def.definitionVersion,
            ownerAccountId: recipient.accountId,
            ownerCharacterId: recipient.id,
            locationState: "in_container",
            containerId: bag.id,
            containerSlotIndex: freeSlots[0]!,
            itemLevel: gen.itemLevel,
            rarityCode: gen.rarityCode,
            qualityBp: gen.qualityBp,
            powerBudgetTotal: gen.powerBudgetTotal,
            powerBudgetSpent: gen.powerBudgetSpent,
            implicitAttributes: gen.implicitAttributes,
            generatedAttributes: gen.generatedAttributes,
            affixes: gen.affixes,
            currentDurability: gen.currentDurability,
            maxDurability: gen.maxDurability,
            bindingState: bind.bindingState,
            boundAccountId: bind.boundAccountId,
            boundCharacterId: bind.boundCharacterId,
            generationRulesVersion: genRules.rulesVersion,
            generationSeedHash: gen.generationSeedHash,
            originType: table.sourceCategory === "boss" ? "boss_drop" : "world_event_reward",
            originReference: cmd.sourceEntityId.trim(),
            instanceVersion: 1,
            createdAt: now,
            updatedAt: now,
          };
          await scope.inventory.insertItemInstance(inst);
          await scope.inventory.appendLedger({
            operationId: `${rewardEventKey}:roll-${rollIdx}`,
            operationType: "grant",
            characterId: recipient.id,
            itemInstanceId: inst.id,
            definitionCode: inst.definitionCode,
            definitionVersion: inst.definitionVersion,
            sourceLocation: `loot:${table.lootTableCode}`,
            destinationLocation: `container:${bag.id}:slot:${freeSlots[0]!}`,
            quantity: 1,
            entityVersion: 1,
            causeReference: rewardEventKey,
          });
          grantedItems.push(inst);
        }
      }

      let mintedCurrency: AuthoritativeRewardGrantRecord["mintedCurrency"] = null;
      if (totalCoinToMint > 0n && mintCurrencyCode) {
        const mintAccId = await scope.ensureCanonicalTechnicalAccountId(
          "system_mint",
          mintCurrencyCode,
        );
        const walletId = await scope.ensurePlayerWalletId(recipient.id, mintCurrencyCode);
        const tx = await scope.executeBalancedLedgerTransaction({
          idempotencyKey: `${rewardEventKey}:loot-mint`,
          processedEventId: claim.eventUuid,
          operationType: "currency_mint",
          currencyCode: mintCurrencyCode,
          correlationId: eventUuid,
          sourceEventId: rewardEventKey,
          actorType: "system_authority",
          actorId,
          legs: [
            {
              debitAccountId: mintAccId,
              creditAccountId: walletId,
              amount: totalCoinToMint,
              memo: `Boss loot currency drop (${cmd.sourceEntityId.trim()})`,
            },
          ],
        });
        mintedCurrency = {
          currencyCode: mintCurrencyCode,
          amount: totalCoinToMint,
          ledgerTxId: tx.id,
        };
      }

      let grantedFragments: AuthoritativeRewardGrantRecord["grantedFragments"] = null;
      if (table.guaranteedFragmentCode && table.guaranteedFragmentQty > 0) {
        const fBal = await this.creditFragmentsInScope(scope, {
          characterId: recipient.id,
          fragmentCode: table.guaranteedFragmentCode,
          quantity: table.guaranteedFragmentQty,
          now,
        });
        grantedFragments = {
          fragmentCode: table.guaranteedFragmentCode,
          quantity: table.guaranteedFragmentQty,
          newBalance: fBal.balance,
        };
      }

      const serializedResult = {
        itemInstanceIds: grantedItems.map((i) => i.id),
        grantedStacks,
        mintedCurrency: mintedCurrency
          ? {
              currencyCode: mintedCurrency.currencyCode,
              amount: mintedCurrency.amount.toString(),
              ledgerTxId: mintedCurrency.ledgerTxId,
            }
          : null,
        grantedFragments,
      };

      await scope.client.query(
        `INSERT INTO reward_grants (
           id, processed_event_id, reward_event_id, source_type, source_entity_id,
           character_id, loot_table_code, loot_table_version, eligibility_reference,
           reward_slot_index, generation_seed_hash, reward_result, rules_version, granted_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, 'boss_kill', $4,
           $5::uuid, $6, $7, $8,
           $9, $10, $11::jsonb, $12, $13
         )`,
        [
          grantRecordId,
          claim.eventUuid,
          rewardEventKey,
          cmd.sourceEntityId.trim(),
          recipient.id,
          table.lootTableCode,
          table.lootTableVersion,
          cmd.eligibilityReference.trim(),
          rewardSlotIndex,
          rng.seedHashHex,
          JSON.stringify(serializedResult),
          table.rulesVersion,
          now,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "RewardGrant",
        aggregateId: grantRecordId,
        eventType: "LootGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          reward_grant_id: grantRecordId,
          reward_event_id: rewardEventKey,
          character_id: recipient.id,
          source_entity_id: cmd.sourceEntityId.trim(),
          items_count: grantedItems.length,
          stacks_count: grantedStacks.length,
        },
      });

      this.logger.info("Granted individual authoritative boss loot", {
        event_id: rewardEventKey,
        aggregate_id: grantRecordId,
        operation: "grantAuthoritativeBossLoot",
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          id: grantRecordId,
          rewardEventId: rewardEventKey,
          sourceType: "boss_kill",
          sourceEntityId: cmd.sourceEntityId.trim(),
          characterId: recipient.id,
          lootTableCode: table.lootTableCode,
          lootTableVersion: table.lootTableVersion,
          eligibilityReference: cmd.eligibilityReference.trim(),
          rewardSlotIndex,
          generationSeedHash: rng.seedHashHex,
          grantedItems,
          grantedStacks,
          mintedCurrency,
          grantedFragments,
          rulesVersion: table.rulesVersion,
          grantedAt: now,
        },
      };
    });
  }

  private async creditFragmentsInScope(
    scope: PgEconomyTransactionScope,
    params: {
      readonly characterId: string;
      readonly fragmentCode: string;
      readonly quantity: number;
      readonly now: Date;
    },
  ): Promise<CharacterFragmentBalance> {
    const fDef = await scope.client.query<{ is_enabled: boolean }>(
      "SELECT is_enabled FROM anti_bad_luck_fragments WHERE fragment_code = $1",
      [params.fragmentCode],
    );
    if (!fDef.rows[0] || !fDef.rows[0].is_enabled) {
      throw new LootOrRewardInvalidError(
        `Anti-bad-luck fragment '${params.fragmentCode}' not found or disabled.`,
      );
    }

    const res = await scope.client.query<{
      balance: number;
      total_earned: number;
      total_redeemed: number;
      version: number;
    }>(
      `INSERT INTO character_fragment_balances (
         character_id, fragment_code, balance, total_earned, total_redeemed, version, updated_at
       )
       VALUES ($1::uuid, $2, $3, $3, 0, 1, $4)
       ON CONFLICT (character_id, fragment_code) DO UPDATE
         SET balance = character_fragment_balances.balance + $3,
             total_earned = character_fragment_balances.total_earned + $3,
             version = character_fragment_balances.version + 1,
             updated_at = $4
       RETURNING balance, total_earned, total_redeemed, version`,
      [params.characterId, params.fragmentCode, params.quantity, params.now],
    );
    const r = res.rows[0]!;
    return {
      characterId: params.characterId,
      fragmentCode: params.fragmentCode,
      balance: r.balance,
      totalEarned: r.total_earned,
      totalRedeemed: r.total_redeemed,
      version: r.version,
    };
  }

  public async grantAntiBadLuckFragments(
    cmd: GrantAntiBadLuckFragmentsCommand,
  ): Promise<IdempotentCommandOutcome<CharacterFragmentBalance>> {
    assertNotGenesisContext("grantAntiBadLuckFragments", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "grantAntiBadLuckFragments");
    if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0) {
      throw new LootOrRewardInvalidError("Fragment quantity must be a positive integer.");
    }
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantAntiBadLuckFragments",
      character_id: cmd.characterId.toLowerCase(),
      fragment_code: cmd.fragmentCode,
      quantity: cmd.quantity,
      progress_reference: cmd.progressReference.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const recipient = characters.get(cmd.characterId.toLowerCase())!;
      recipient.assertActiveStatus();
      assertAccountActive(accounts.get(recipient.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "FragmentsGranted",
        eventVersion: 1,
        source: `carbon.economy.fragments:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: recipient.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const cur = await scope.client.query<{
          balance: number;
          total_earned: number;
          total_redeemed: number;
          version: number;
        }>(
          `SELECT balance, total_earned, total_redeemed, version
           FROM character_fragment_balances
           WHERE character_id = $1::uuid AND fragment_code = $2`,
          [recipient.id, cmd.fragmentCode],
        );
        const r = cur.rows[0]!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            characterId: recipient.id,
            fragmentCode: cmd.fragmentCode,
            balance: r.balance,
            totalEarned: r.total_earned,
            totalRedeemed: r.total_redeemed,
            version: r.version,
          },
        };
      }

      const bal = await this.creditFragmentsInScope(scope, {
        characterId: recipient.id,
        fragmentCode: cmd.fragmentCode,
        quantity: cmd.quantity,
        now,
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "RewardGrant",
        aggregateId: recipient.id,
        eventType: "FragmentsGranted",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          character_id: recipient.id,
          fragment_code: cmd.fragmentCode,
          quantity: cmd.quantity,
          new_balance: bal.balance,
        },
      });

      return { status: "applied", duplicate: false, data: bal };
    });
  }

  public async getCharacterFragmentBalances(
    characterId: string,
  ): Promise<ReadonlyArray<CharacterFragmentBalance>> {
    const res = await this.pool.query<{
      character_id: string;
      fragment_code: string;
      balance: number;
      total_earned: number;
      total_redeemed: number;
      version: number;
    }>(
      `SELECT * FROM character_fragment_balances
       WHERE character_id = $1::uuid
       ORDER BY fragment_code ASC`,
      [characterId],
    );
    return res.rows.map((r) => ({
      characterId: r.character_id,
      fragmentCode: r.fragment_code,
      balance: r.balance,
      totalEarned: r.total_earned,
      totalRedeemed: r.total_redeemed,
      version: r.version,
    }));
  }

  public async redeemAntiBadLuckFragments(
    cmd: RedeemAntiBadLuckFragmentsCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly remainingBalance: number;
      readonly rewardGrant: AuthoritativeRewardGrantRecord;
    }>
  > {
    assertNotGenesisContext("redeemAntiBadLuckFragments", cmd.executionProfile);
    const redemptionKey = cmd.redemptionId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(redemptionKey);
    const grantRecordId = deriveDeterministicEventUuid(`frag-reward-grant:${redemptionKey}`);
    const redemptionRowId = deriveDeterministicEventUuid(`frag-redemption:${redemptionKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "RedeemAntiBadLuckFragments",
      redemption_id: redemptionKey,
      character_id: cmd.characterId.toLowerCase(),
      fragment_code: cmd.fragmentCode,
      selected_option_code: cmd.selectedOptionCode,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.characterId,
      ]);
      const character = characters.get(cmd.characterId.toLowerCase())!;
      character.assertOwnedByOrSystem(cmd.principal);
      character.assertActiveStatus();
      assertAccountActive(accounts.get(character.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: redemptionKey,
        idempotencyKey: redemptionKey,
        eventType: "RewardRedeemed",
        eventVersion: 1,
        source: "carbon.economy.fragments",
        correlationUuid: eventUuid,
        aggregateUuid: character.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const balRes = await scope.client.query<{ balance: number }>(
          `SELECT balance FROM character_fragment_balances
           WHERE character_id = $1::uuid AND fragment_code = $2`,
          [character.id, cmd.fragmentCode],
        );
        const grant = await this.reconstructRewardGrantRecord(scope, redemptionKey);
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: { remainingBalance: balRes.rows[0]?.balance ?? 0, rewardGrant: grant },
        };
      }

      if (character.competitiveLockState === "in_ranked_series") {
        throw new CharacterCompetitiveLockedError(character.id);
      }

      const fDefRes = await scope.client.query<{
        redemption_cost: number;
        reward_pool: ReadonlyArray<FragmentRedeemableOption>;
        is_enabled: boolean;
        rules_version: number;
      }>(
        "SELECT redemption_cost, reward_pool, is_enabled, rules_version FROM anti_bad_luck_fragments WHERE fragment_code = $1",
        [cmd.fragmentCode],
      );
      const fDef = fDefRes.rows[0];
      if (!fDef || !fDef.is_enabled) {
        throw new LootOrRewardInvalidError(`Fragment '${cmd.fragmentCode}' unavailable.`);
      }

      const option = fDef.reward_pool.find((o) => o.optionCode === cmd.selectedOptionCode);
      if (!option) {
        throw new LootOrRewardInvalidError(
          `Redemption option '${cmd.selectedOptionCode}' not in reward pool for '${cmd.fragmentCode}'.`,
        );
      }

      const balRes = await scope.client.query<{
        balance: number;
        total_redeemed: number;
        version: number;
      }>(
        `SELECT balance, total_redeemed, version
         FROM character_fragment_balances
         WHERE character_id = $1::uuid AND fragment_code = $2
         FOR UPDATE`,
        [character.id, cmd.fragmentCode],
      );
      const curBal = balRes.rows[0];
      if (!curBal || curBal.balance < fDef.redemption_cost) {
        throw new LootOrRewardInvalidError(
          `Insufficient '${cmd.fragmentCode}' fragments: required ${fDef.redemption_cost}, available ${curBal?.balance ?? 0}.`,
        );
      }

      const nextBalance = curBal.balance - fDef.redemption_cost;
      const updBal = await scope.client.query(
        `UPDATE character_fragment_balances
         SET balance = $1,
             total_redeemed = $2,
             version = version + 1,
             updated_at = $3
         WHERE character_id = $4::uuid AND fragment_code = $5 AND version = $6`,
        [
          nextBalance,
          curBal.total_redeemed + fDef.redemption_cost,
          now,
          character.id,
          cmd.fragmentCode,
          curBal.version,
        ],
      );
      if (updBal.rowCount !== 1) {
        throw new LootOrRewardInvalidError("Concurrent fragment redemption conflict.");
      }

      const genRules = (await scope.inventory.loadGenerationRules(1))!;
      const { bag } = await scope.inventory.ensureAndLockPrimaryContainers(
        character.id,
        genRules.defaultInventoryCapacity,
      );
      const def = await scope.inventory.findItemDefinition(
        option.itemDefinitionCode,
        option.itemDefinitionVersion,
      );
      if (!def) {
        throw new ItemDefinitionNotFoundError(
          option.itemDefinitionCode,
          option.itemDefinitionVersion,
        );
      }

      const grantedItems: ItemInstance[] = [];
      const grantedStacks: Array<{ definitionCode: string; quantity: number }> = [];
      let producedItemId: string | null = null;
      let producedStackId: string | null = null;
      let seedHash: string;

      // Fragment redemptions bind to the character (`character_bound`) to preserve progression linkage!
      if (option.rewardKind === "material_stack") {
        const eqKey = buildStackEquivalenceKey({
          definitionCode: def.definitionCode,
          definitionVersion: def.definitionVersion,
          qualityBp: 5000,
          bindingState: "character_bound",
          boundAccountId: character.accountId,
          boundCharacterId: character.id,
        });
        const placed = await scope.deliverStackQuantityToCharacterContainers({
          recipient: character,
          primaryBag: bag,
          definition: def,
          quantity: option.quantity,
          qualityBp: 5000,
          bindingState: "character_bound",
          boundAccountId: character.accountId,
          boundCharacterId: character.id,
          equivalenceKey: eqKey,
          allowPersonalStorageFallback: false,
          seedPrefix: `${redemptionKey}:frag-stack`,
        });
        producedStackId = placed[0]?.id ?? null;
        seedHash = new SplitMix64Rng(`frag-redeem:${redemptionKey}`).seedHashHex;
        grantedStacks.push({ definitionCode: def.definitionCode, quantity: option.quantity });
        await scope.inventory.appendLedger({
          operationId: redemptionKey,
          operationType: "grant",
          characterId: character.id,
          stackId: producedStackId,
          definitionCode: def.definitionCode,
          definitionVersion: def.definitionVersion,
          sourceLocation: `fragment_redemption:${cmd.fragmentCode}`,
          destinationLocation: `container:${bag.id}`,
          quantity: option.quantity,
          entityVersion: placed[0]?.version ?? 1,
          causeReference: redemptionKey,
        });
      } else {
        const freeSlots = await scope.inventory.findFreeContainerSlots(bag, 1);
        if (freeSlots.length < 1) {
          throw new InventoryCapacityExceededError(
            "Character inventory is full; cannot redeem anti-bad-luck equipment.",
          );
        }
        const rarity = (await scope.inventory.findRarity(option.rarityCode))!;
        const affixes = await scope.inventory.listAffixesForPools(def.allowedAffixPools);
        const gen = generateProceduralItemProperties({
          definition: def,
          rarity,
          rules: genRules,
          candidateAffixes: affixes,
          itemLevel: option.itemLevel,
          serverSeed: `frag-redeem:${redemptionKey}:${character.id}`,
          originReference: `fragment:${cmd.fragmentCode}:${option.optionCode}`,
        });
        seedHash = gen.generationSeedHash;
        producedItemId = deriveDeterministicEventUuid(`frag-item:${redemptionKey}`);
        const inst: ItemInstance = {
          id: producedItemId,
          definitionCode: def.definitionCode,
          definitionVersion: def.definitionVersion,
          ownerAccountId: character.accountId,
          ownerCharacterId: character.id,
          locationState: "in_container",
          containerId: bag.id,
          containerSlotIndex: freeSlots[0]!,
          itemLevel: gen.itemLevel,
          rarityCode: gen.rarityCode,
          qualityBp: gen.qualityBp,
          powerBudgetTotal: gen.powerBudgetTotal,
          powerBudgetSpent: gen.powerBudgetSpent,
          implicitAttributes: gen.implicitAttributes,
          generatedAttributes: gen.generatedAttributes,
          affixes: gen.affixes,
          currentDurability: gen.currentDurability,
          maxDurability: gen.maxDurability,
          bindingState: "character_bound",
          boundAccountId: character.accountId,
          boundCharacterId: character.id,
          generationRulesVersion: genRules.rulesVersion,
          generationSeedHash: gen.generationSeedHash,
          originType: "boss_drop",
          originReference: `fragment:${cmd.fragmentCode}:${option.optionCode}`,
          instanceVersion: 1,
          createdAt: now,
          updatedAt: now,
        };
        await scope.inventory.insertItemInstance(inst);
        await scope.inventory.appendLedger({
          operationId: redemptionKey,
          operationType: "grant",
          characterId: character.id,
          itemInstanceId: inst.id,
          definitionCode: inst.definitionCode,
          definitionVersion: inst.definitionVersion,
          sourceLocation: `fragment_redemption:${cmd.fragmentCode}`,
          destinationLocation: `container:${bag.id}:slot:${freeSlots[0]!}`,
          quantity: 1,
          entityVersion: 1,
          causeReference: redemptionKey,
        });
        grantedItems.push(inst);
      }

      const serializedResult = {
        itemInstanceIds: grantedItems.map((i) => i.id),
        grantedStacks,
        mintedCurrency: null,
        grantedFragments: null,
      };

      await scope.client.query(
        `INSERT INTO reward_grants (
           id, processed_event_id, reward_event_id, source_type, source_entity_id,
           character_id, loot_table_code, loot_table_version, eligibility_reference,
           reward_slot_index, generation_seed_hash, reward_result, rules_version, granted_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, 'fragment_redemption', $4,
           $5::uuid, NULL, NULL, $6,
           0, $7, $8::jsonb, $9, $10
         )`,
        [
          grantRecordId,
          claim.eventUuid,
          redemptionKey,
          cmd.fragmentCode,
          character.id,
          option.optionCode,
          seedHash,
          JSON.stringify(serializedResult),
          fDef.rules_version,
          now,
        ],
      );

      await scope.client.query(
        `INSERT INTO fragment_redemptions (
           id, processed_event_id, redemption_id, character_id, fragment_code,
           fragments_consumed, selected_reward_code, item_instance_id, stack_id,
           reward_grant_id, rules_version, redeemed_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5,
           $6, $7, $8::uuid, $9::uuid,
           $10::uuid, $11, $12
         )`,
        [
          redemptionRowId,
          claim.eventUuid,
          redemptionKey,
          character.id,
          cmd.fragmentCode,
          fDef.redemption_cost,
          option.optionCode,
          producedItemId,
          producedStackId,
          grantRecordId,
          fDef.rules_version,
          now,
        ],
      );

      await scope.enqueueEconomyOutbox({
        aggregateType: "RewardGrant",
        aggregateId: grantRecordId,
        eventType: "RewardRedeemed",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          redemption_id: redemptionKey,
          character_id: character.id,
          fragment_code: cmd.fragmentCode,
          fragments_consumed: fDef.redemption_cost,
          remaining_balance: nextBalance,
          selected_option_code: option.optionCode,
        },
      });

      return {
        status: "applied",
        duplicate: false,
        data: {
          remainingBalance: nextBalance,
          rewardGrant: {
            id: grantRecordId,
            rewardEventId: redemptionKey,
            sourceType: "fragment_redemption",
            sourceEntityId: cmd.fragmentCode,
            characterId: character.id,
            lootTableCode: null,
            lootTableVersion: null,
            eligibilityReference: option.optionCode,
            rewardSlotIndex: 0,
            generationSeedHash: seedHash,
            grantedItems,
            grantedStacks,
            mintedCurrency: null,
            grantedFragments: null,
            rulesVersion: fDef.rules_version,
            grantedAt: now,
          },
        },
      };
    });
  }

  /**
   * Rewards an eligible persisted NEON `gameplay_contributions` record (`damage`, `support`, `objectives`),
   * strictly resolving `player_id -> character_id` via `external_identity_links` without guessing!
   */
  public async grantContributionEconomicReward(
    cmd: GrantContributionEconomicRewardCommand,
  ): Promise<
    IdempotentCommandOutcome<{
      readonly characterId: string;
      readonly commendationMinted: bigint;
      readonly coinStipendMinted: bigint;
    }>
  > {
    assertNotGenesisContext("grantContributionEconomicReward", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "grantContributionEconomicReward");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "GrantContributionEconomicReward",
      contribution_event_id: cmd.contributionEventId.trim(),
      include_loot_roll: cmd.includeLootRoll ?? false,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const contribRes = await scope.client.query<{
        id: string;
        player_id: string;
        damage: string;
        support: string;
        objectives: string;
        eligible: boolean;
        outcome: "Defended" | "Captured";
      }>("SELECT * FROM gameplay_contributions WHERE external_event_id = $1", [
        cmd.contributionEventId.trim(),
      ]);
      const contrib = contribRes.rows[0];
      if (!contrib) {
        throw new LootOrRewardInvalidError(
          `Contribution '${cmd.contributionEventId}' not found.`,
        );
      }
      if (!contrib.eligible) {
        throw new LootOrRewardInvalidError(
          `Contribution '${cmd.contributionEventId}' is marked eligible=false and cannot be rewarded.`,
        );
      }

      const linkRes = await scope.client.query<{ character_id: string }>(
        `SELECT character_id FROM external_identity_links
         WHERE source_namespace = 'neon_player'
           AND external_subject_id = $1
           AND link_status = 'active'`,
        [contrib.player_id],
      );
      const resolvedCharId = linkRes.rows[0]?.character_id;
      if (!resolvedCharId) {
        throw new LootOrRewardInvalidError(
          `No active authoritative external_identity_link for NEON player_id '${contrib.player_id}'.`,
        );
      }

      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        resolvedCharId,
      ]);
      const ch = characters.get(resolvedCharId.toLowerCase())!;
      ch.assertActiveStatus();
      assertAccountActive(accounts.get(ch.accountId.toLowerCase())!);

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "LootGranted",
        eventVersion: 1,
        source: `carbon.economy.contrib:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: contrib.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      const existingRew = await scope.client.query<{
        character_id: string;
        commendation_minted: string;
        coin_stipend_minted: string;
      }>("SELECT * FROM contribution_economic_rewards WHERE contribution_id = $1::uuid", [
        contrib.id,
      ]);
      if (claim.status === "duplicate_verified") {
        const er = existingRew.rows[0]!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            characterId: er.character_id,
            commendationMinted: BigInt(er.commendation_minted),
            coinStipendMinted: BigInt(er.coin_stipend_minted),
          },
        };
      }
      if (existingRew.rows[0]) {
        throw new LootOrRewardInvalidError(
          `Contribution '${cmd.contributionEventId}' has already received an economic reward.`,
        );
      }

      // Provisional multi-dimensional formula: damage + 2*support + 50*objectives!
      const dmg = BigInt(contrib.damage);
      const sup = BigInt(contrib.support);
      const obj = BigInt(contrib.objectives);
      const compositeScore = dmg + sup * 2n + obj * 50n;
      if (compositeScore <= 0n) {
        throw new LootOrRewardInvalidError("Contribution has zero composite participation score.");
      }

      const commendations = 5n + (compositeScore > 500n ? 10n : compositeScore / 50n);
      const coinStipend = contrib.outcome === "Defended" ? 100n + (compositeScore > 1000n ? 150n : compositeScore / 10n) : 0n;

      const commMintAcc = await scope.ensureCanonicalTechnicalAccountId(
        "system_mint",
        "world_event_commendation",
      );
      const commWallet = await scope.ensurePlayerWalletId(ch.id, "world_event_commendation");
      const commTx = await scope.executeBalancedLedgerTransaction({
        idempotencyKey: `${commandKey}:commendation`,
        processedEventId: claim.eventUuid,
        operationType: "world_event_reward_mint",
        currencyCode: "world_event_commendation",
        correlationId: eventUuid,
        sourceEventId: commandKey,
        actorType: "system_authority",
        actorId,
        legs: [
          {
            debitAccountId: commMintAcc,
            creditAccountId: commWallet,
            amount: commendations,
            memo: `World event commendation (${cmd.contributionEventId.trim()})`,
          },
        ],
      });

      let stipendTxId: string | null = null;
      if (coinStipend > 0n) {
        const coinMintAcc = await scope.ensureCanonicalTechnicalAccountId(
          "system_mint",
          "ascendra_coin",
        );
        const coinWallet = await scope.ensurePlayerWalletId(ch.id, "ascendra_coin");
        const stTx = await scope.executeBalancedLedgerTransaction({
          idempotencyKey: `${commandKey}:stipend`,
          processedEventId: null,
          operationType: "world_event_reward_mint",
          currencyCode: "ascendra_coin",
          correlationId: eventUuid,
          sourceEventId: commandKey,
          actorType: "system_authority",
          actorId,
          legs: [
            {
              debitAccountId: coinMintAcc,
              creditAccountId: coinWallet,
              amount: coinStipend,
              memo: `Settlement defense stipend (${cmd.contributionEventId.trim()})`,
            },
          ],
        });
        stipendTxId = stTx.id;
      }

      await scope.client.query(
        `INSERT INTO contribution_economic_rewards (
           contribution_id, character_id, policy_code, rules_version,
           commendation_minted, coin_stipend_minted, commendation_tx_id, stipend_tx_id, reward_grant_id, rewarded_at
         )
         VALUES ($1::uuid, $2::uuid, 'dev_contrib_econ_v1', 1, $3::bigint, $4::bigint, $5::uuid, $6::uuid, NULL, $7)`,
        [
          contrib.id,
          ch.id,
          commendations.toString(),
          coinStipend.toString(),
          commTx.id,
          stipendTxId,
          now,
        ],
      );

      return {
        status: "applied",
        duplicate: false,
        data: {
          characterId: ch.id,
          commendationMinted: commendations,
          coinStipendMinted: coinStipend,
        },
      };
    });
  }

  /**
   * Activates a `Draft` (`planned_unfunded`) criminal bounty ONLY after verifying an existing,
   * unconsumed, ledger-backed `currency_reservations` row matching issuer, bounty, currency, and amount (Section 24).
   */
  public async fundDraftCriminalBountyWithEscrow(
    cmd: FundDraftCriminalBountyCommand,
  ): Promise<IdempotentCommandOutcome<CriminalBounty>> {
    assertNotGenesisContext("fundDraftCriminalBountyWithEscrow", cmd.executionProfile);
    if (Boolean(cmd.issuerCharacterId) === Boolean(cmd.issuerSettlementId)) {
      throw new CriminalBountyInvalidError(
        "Specify exactly one of issuerCharacterId or issuerSettlementId.",
      );
    }

    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "FundDraftCriminalBountyWithEscrow",
      bounty_id: cmd.bountyId.toLowerCase(),
      reservation_id: cmd.reservationId.toLowerCase(),
      issuer_character_id: cmd.issuerCharacterId?.toLowerCase() ?? null,
      issuer_settlement_id: cmd.issuerSettlementId?.toLowerCase() ?? null,
    });

    return this.uow.executeInTransaction(async (scope) => {
      const bounty = await scope.social.lockCriminalBounty(cmd.bountyId);
      if (!bounty) {
        throw new SocialReferenceNotFoundError("CriminalBounty", cmd.bountyId);
      }

      if (cmd.issuerCharacterId) {
        const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
          cmd.issuerCharacterId,
          bounty.targetCharacterId,
        ]);
        const issuer = characters.get(cmd.issuerCharacterId.toLowerCase())!;
        issuer.assertOwnedByOrSystem(cmd.principal);
        issuer.assertActiveStatus();
        assertAccountActive(accounts.get(issuer.accountId.toLowerCase())!);
      } else {
        requireSystemPrincipal(cmd.principal, "fundDraftCriminalBountyWithEscrow");
        await scope.lockCharactersAndAccountsCanonical([bounty.targetCharacterId]);
      }

      const claim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CriminalBountyFunded",
        eventVersion: 1,
        source: "carbon.economy.bounties",
        correlationUuid: eventUuid,
        aggregateUuid: bounty.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (claim.status === "duplicate_verified") {
        const refreshed = (await scope.social.lockCriminalBounty(bounty.id))!;
        return { status: "duplicate_idempotent", duplicate: true, data: refreshed };
      }

      if (bounty.status !== "Draft" || bounty.fundingStatus !== "planned_unfunded") {
        throw new CriminalBountyInvalidError(
          `Criminal bounty '${bounty.id}' is in status '${bounty.status}'/${bounty.fundingStatus}; expected 'Draft'/planned_unfunded.`,
        );
      }

      const resvMap = await scope.lockReservationsCanonical([cmd.reservationId]);
      const resv = resvMap.get(cmd.reservationId.toLowerCase());
      if (!resv) {
        throw new EscrowReservationStateError(
          `Monetary reservation '${cmd.reservationId}' does not exist.`,
        );
      }
      if (resv.status !== "Reserved") {
        throw new EscrowReservationStateError(
          `Monetary reservation '${resv.id}' is '${resv.status}', expected 'Reserved'.`,
        );
      }
      if (resv.purpose !== "criminal_bounty" || resv.referenceId.toLowerCase() !== bounty.id.toLowerCase()) {
        throw new EscrowReservationStateError(
          `Reservation '${resv.id}' purpose/reference ('${resv.purpose}:${resv.referenceId}') does not bind to bounty '${bounty.id}'.`,
        );
      }
      if (resv.currencyCode !== bounty.currencyCode) {
        throw new EscrowReservationStateError(
          `Reservation currency '${resv.currencyCode}' mismatches bounty currency '${bounty.currencyCode}'.`,
        );
      }
      const unconsumed = resv.reservedAmount - resv.consumedAmount - resv.releasedAmount;
      if (unconsumed !== bounty.rewardAmount) {
        throw new EscrowReservationStateError(
          `Reservation available amount (${unconsumed.toString()}) mismatches bounty rewardAmount (${bounty.rewardAmount.toString()}).`,
        );
      }

      if (cmd.issuerCharacterId) {
        if (!resv.ownerCharacterId || resv.ownerCharacterId.toLowerCase() !== cmd.issuerCharacterId.toLowerCase()) {
          throw new EscrowReservationStateError(
            `Reservation '${resv.id}' does not belong to issuer character '${cmd.issuerCharacterId}'.`,
          );
        }
      } else {
        const trId = await scope.ensureSettlementTreasuryId(
          cmd.issuerSettlementId!,
          bounty.currencyCode,
        );
        if (resv.ownerWalletId.toLowerCase() !== trId.toLowerCase()) {
          throw new EscrowReservationStateError(
            `Reservation '${resv.id}' does not belong to settlement treasury '${trId}'.`,
          );
        }
      }

      // Verify the reserve ledger transaction physically exists in currency_ledger_transactions!
      const txVerify = await scope.client.query<{ id: string }>(
        "SELECT id FROM currency_ledger_transactions WHERE id = $1::uuid",
        [resv.reserveLedgerTxId],
      );
      if (!txVerify.rows[0]) {
        throw new EscrowReservationStateError(
          `Reservation '${resv.id}' lacks a verified monetary ledger transaction.`,
        );
      }

      const fundingRef = `verified_reservation:${resv.id}`;
      const upd = await scope.client.query(
        `UPDATE criminal_bounties
         SET funding_status = 'escrow_committed',
             funding_reference = $1,
             reservation_id = $2::uuid,
             issuer_character_id = $3::uuid,
             issuer_settlement_id = $4::uuid,
             status = 'Active',
             version = version + 1,
             updated_at = $5
         WHERE id = $6::uuid AND status = 'Draft' AND version = $7`,
        [
          fundingRef,
          resv.id,
          cmd.issuerCharacterId ?? null,
          cmd.issuerSettlementId ?? null,
          now,
          bounty.id,
          bounty.version,
        ],
      );
      if (upd.rowCount !== 1) {
        throw new CriminalBountyInvalidError(`Concurrent modification funding bounty '${bounty.id}'.`);
      }

      await scope.enqueueEconomyOutbox({
        aggregateType: "CriminalBounty",
        aggregateId: bounty.id,
        eventType: "CriminalBountyFunded",
        correlationUuid: eventUuid,
        causationEventUuid: claim.eventUuid,
        occurredAt: now,
        payload: {
          bounty_id: bounty.id,
          reservation_id: resv.id,
          reward_amount: bounty.rewardAmount.toString(),
          currency_code: bounty.currencyCode,
        },
      });

      const updated = (await scope.social.lockCriminalBounty(bounty.id))!;
      return { status: "applied", duplicate: false, data: updated };
    });
  }

  /**
   * Claims and atomically settles a verified funded criminal bounty in a SINGLE PostgreSQL transaction:
   * - Quarantines & rejects legacy rows that have `escrow_committed` without a verified `reservation_id`!
   * - Enforces anti-self and anti-same-account restrictions, jurisdiction eligibility, and single-claim uniqueness.
   * - Consumes the monetary reservation and credits the claimant's wallet (`bounty_payout_settlement`).
   */
  public async claimAndSettleVerifiedCriminalBounty(
    cmd: ClaimAndSettleVerifiedCriminalBountyCommand,
  ): Promise<IdempotentCommandOutcome<SettledCriminalBountyOutcome>> {
    assertNotGenesisContext("claimAndSettleVerifiedCriminalBounty", cmd.executionProfile);
    const actorId = requireSystemPrincipal(cmd.principal, "claimAndSettleVerifiedCriminalBounty");
    const commandKey = cmd.commandId.trim();
    const now = new Date();
    const eventUuid = deriveDeterministicEventUuid(commandKey);
    const claimId = deriveDeterministicEventUuid(`verified-bounty-claim:${commandKey}`);

    const { fingerprint, canonicalJson } = computeCanonicalFingerprintV1({
      operation: "ClaimAndSettleVerifiedCriminalBounty",
      bounty_id: cmd.bountyId.toLowerCase(),
      claimant_character_id: cmd.claimantCharacterId.toLowerCase(),
      resolution_kind: cmd.resolutionKind,
      authority_confirmation_ref: cmd.authorityConfirmationRef.trim(),
    });

    return this.uow.executeInTransaction(async (scope) => {
      // Step 1: Lock bounty row FIRST (prevents competing hunters from racing!)
      const rawBountyRes = await scope.client.query<{ reservation_id: string | null }>(
        "SELECT reservation_id FROM criminal_bounties WHERE id = $1::uuid FOR UPDATE",
        [cmd.bountyId],
      );
      if (!rawBountyRes.rows[0]) {
        throw new SocialReferenceNotFoundError("CriminalBounty", cmd.bountyId);
      }
      const verifiedReservationId = rawBountyRes.rows[0].reservation_id;
      const bounty = (await scope.social.lockCriminalBounty(cmd.bountyId))!;

      // Step 2 & 3: Lock claimant & target characters and their accounts in canonical ascending UUID order
      const { characters, accounts } = await scope.lockCharactersAndAccountsCanonical([
        cmd.claimantCharacterId,
        bounty.targetCharacterId,
      ]);
      const claimant = characters.get(cmd.claimantCharacterId.toLowerCase())!;
      const target = characters.get(bounty.targetCharacterId.toLowerCase())!;
      claimant.assertActiveStatus();
      assertAccountActive(accounts.get(claimant.accountId.toLowerCase())!);

      // Step 4: Transactional Inbox
      const inboxClaim = await scope.claimOrVerifyEvent({
        eventUuid,
        externalEventId: commandKey,
        idempotencyKey: commandKey,
        eventType: "CriminalBountySettled",
        eventVersion: 1,
        source: `carbon.economy.bounties:${actorId}`,
        correlationUuid: eventUuid,
        aggregateUuid: bounty.id,
        occurredAt: now,
        receivedAt: now,
        payloadFingerprint: fingerprint,
        canonicalPayload: canonicalJson,
      });

      if (inboxClaim.status === "duplicate_verified") {
        const exClaimRes = await scope.client.query<Record<string, unknown>>(
          "SELECT * FROM criminal_bounty_claims WHERE id = $1::uuid",
          [claimId],
        );
        const r = exClaimRes.rows[0]!;
        return {
          status: "duplicate_idempotent",
          duplicate: true,
          data: {
            bounty,
            claim: {
              id: String(r["id"]),
              bountyId: String(r["bounty_id"]),
              claimantCharacterId: String(r["claimant_character_id"]),
              claimantAccountId: String(r["claimant_account_id"]),
              targetCharacterId: String(r["target_character_id"]),
              targetAccountId: String(r["target_account_id"]),
              resolutionKind: r["resolution_kind"] as CriminalBountyClaim["resolutionKind"],
              authorityEventId: String(r["authority_event_id"]),
              payoutCommitmentStatus: "pending_economy_settlement",
              settlementLedgerTxId: String(r["settlement_ledger_tx_id"]),
              settledAt: r["settled_at"] as Date,
              claimedAt: r["claimed_at"] as Date,
            },
            reservationId: verifiedReservationId!,
            ledgerTxId: String(r["settlement_ledger_tx_id"]),
          },
        };
      }

      // CRITICAL SECTION 24 GUARD: Legacy `escrow_committed` rows WITHOUT a verified `reservation_id` MUST NEVER be settled!
      if (!verifiedReservationId) {
        throw new EscrowReservationStateError(
          `Legacy or unverified criminal bounty '${bounty.id}' lacks a verified currency_reservations link and cannot be settled.`,
        );
      }

      const targetJur = await scope.social.ensureAndLockJurisdictionStatus(
        target.id,
        bounty.jurisdictionId,
      );

      assertCriminalBountyClaimEligible({
        bounty,
        claimantCharacterId: claimant.id,
        claimantAccountId: claimant.accountId,
        targetCharacterId: target.id,
        targetAccountId: target.accountId,
        targetJurisdictionState: targetJur.criminalState,
      });

      const claimantWalletId = await scope.ensurePlayerWalletId(claimant.id, bounty.currencyCode);
      const { ledgerTx } = await scope.consumeReservationInScope({
        reservationId: verifiedReservationId,
        idempotencyKey: `${commandKey}:bounty-payout`,
        processedEventId: inboxClaim.eventUuid,
        operationType: "bounty_payout_settlement",
        payouts: [
          {
            creditAccountId: claimantWalletId,
            amount: bounty.rewardAmount,
            memo: `Criminal bounty payout on ${bounty.id} (target ${target.id})`,
          },
        ],
        correlationId: eventUuid,
        actorType: "system_authority",
        actorId,
      });

      const updBounty = await scope.client.query(
        `UPDATE criminal_bounties
         SET status = 'Fulfilled', version = version + 1, updated_at = $1
         WHERE id = $2::uuid AND status = 'Active' AND version = $3`,
        [now, bounty.id, bounty.version],
      );
      if (updBounty.rowCount !== 1) {
        throw new CriminalBountyInvalidError(
          `Concurrent modification prevented fulfilling bounty '${bounty.id}'.`,
        );
      }

      await scope.client.query(
        `INSERT INTO criminal_bounty_claims (
           id, bounty_id, claimant_character_id, claimant_account_id,
           target_character_id, target_account_id, resolution_kind,
           authority_event_id, payout_commitment_status, settlement_ledger_tx_id, settled_at, claimed_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7,
           $8, 'settled', $9::uuid, $10, $10
         )`,
        [
          claimId,
          bounty.id,
          claimant.id,
          claimant.accountId,
          target.id,
          target.accountId,
          cmd.resolutionKind,
          cmd.authorityConfirmationRef.trim(),
          ledgerTx.id,
          now,
        ],
      );

      const hunterSocial = await scope.social.ensureAndLockSocialStanding(claimant.id);
      await scope.social.updateSocialStanding(
        {
          ...hunterSocial,
          bountiesFulfilledCount: hunterSocial.bountiesFulfilledCount + 1,
          socialVersion: hunterSocial.socialVersion + 1,
          updatedAt: now,
        },
        hunterSocial.socialVersion,
      );

      if (cmd.resolutionKind === "confirmed_capture" && targetJur.criminalState !== "Captured") {
        await scope.social.updateJurisdictionStatus(
          {
            ...targetJur,
            criminalState: "Captured",
            safeZoneAccess: "monitored",
            activeWarrantsCount: 0,
            version: targetJur.version + 1,
            updatedAt: now,
          },
          targetJur.version,
        );
        await scope.client.query(
          `UPDATE criminal_warrants
           SET status = 'captured', resolved_at = $1, resolution_reference = $2, version = version + 1
           WHERE target_character_id = $3::uuid AND jurisdiction_id = $4 AND status = 'active'`,
          [now, cmd.authorityConfirmationRef.trim(), target.id, bounty.jurisdictionId],
        );
      }

      await scope.social.appendSocialLedger({
        characterId: claimant.id,
        counterpartyAccountId: target.accountId,
        counterpartyCharacterId: target.id,
        domainKind: "criminal_bounty",
        actionCode: "bounty_settled_escrow_verified",
        scopeKey: `bounty:${bounty.id}`,
        deltaValue: bounty.rewardAmount,
        newValue: bounty.rewardAmount,
        rulesVersion: bounty.rulesVersion,
        sourceEventId: commandKey,
        metadata: {
          reservation_id: verifiedReservationId,
          settlement_ledger_tx_id: ledgerTx.id,
          currency_code: bounty.currencyCode,
        },
        occurredAt: now,
      });

      await scope.enqueueEconomyOutbox({
        aggregateType: "CriminalBounty",
        aggregateId: bounty.id,
        eventType: "CriminalBountySettled",
        correlationUuid: eventUuid,
        causationEventUuid: inboxClaim.eventUuid,
        occurredAt: now,
        payload: {
          bounty_id: bounty.id,
          claim_id: claimId,
          claimant_character_id: claimant.id,
          target_character_id: target.id,
          reward_amount: bounty.rewardAmount.toString(),
          currency_code: bounty.currencyCode,
          reservation_id: verifiedReservationId,
          settlement_ledger_tx_id: ledgerTx.id,
        },
      });

      const fulfilledBounty = (await scope.social.lockCriminalBounty(bounty.id))!;
      return {
        status: "applied",
        duplicate: false,
        data: {
          bounty: fulfilledBounty,
          claim: {
            id: claimId,
            bountyId: bounty.id,
            claimantCharacterId: claimant.id,
            claimantAccountId: claimant.accountId,
            targetCharacterId: target.id,
            targetAccountId: target.accountId,
            resolutionKind: cmd.resolutionKind,
            authorityEventId: cmd.authorityConfirmationRef.trim(),
            payoutCommitmentStatus: "pending_economy_settlement",
            settlementLedgerTxId: ledgerTx.id,
            settledAt: now,
            claimedAt: now,
          },
          reservationId: verifiedReservationId,
          ledgerTxId: ledgerTx.id,
        },
      };
    });
  }
}
