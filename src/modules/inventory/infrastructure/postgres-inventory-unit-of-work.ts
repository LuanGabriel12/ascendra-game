import { randomUUID } from "node:crypto";
import { deriveDeterministicEventUuid } from "../../../shared/contracts/canonical-fingerprint.js";
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
import type {
  AttributeBlock,
  PrimaryAttributeKey,
} from "../../peoples/domain/character-snapshot-proposal.js";
import {
  DEFAULT_ITEM_GENERATION_RULES_V1,
  INITIAL_AFFIXES_CATALOG,
  INITIAL_ITEM_DEFINITIONS_CATALOG,
  INITIAL_RARITIES_CATALOG,
  INITIAL_SPECIAL_EFFECTS_CATALOG,
} from "../catalog/initial-item-catalog.js";
import {
  EquipmentVersionConflictError,
  ItemDefinitionInvalidError,
} from "../domain/errors.js";
import { validateItemDefinition } from "../domain/equipment-and-stack-rules.js";
import type {
  AffixDefinition,
  AffixKind,
  BindingPolicy,
  CombatEquipmentSlot,
  ContainerType,
  EquipSlotPolicy,
  EquipmentLoadout,
  EquippedSlotAssignment,
  InstanceBindingState,
  InventoryContainer,
  InventoryStack,
  ItemCategory,
  ItemDefinition,
  ItemGenerationRulesConfig,
  ItemInstance,
  ItemLocationState,
  ItemOriginType,
  ItemRarityCode,
  RarityDefinition,
  RolledItemAffix,
  SpecialEffectDefinition,
} from "../domain/item-types.js";

export type InventoryOutboxEventType =
  | "ItemGranted"
  | "ItemMoved"
  | "ItemEquipped"
  | "ItemUnequipped"
  | "ItemStackSplit"
  | "ItemStacksMerged"
  | "ItemDurabilityChanged"
  | "ItemRepaired"
  | "ItemTransferred"
  | "ItemDestroyed"
  | "CharacterLoadoutChanged"
  | "CharacterBuildChanged";

export type LedgerOperationType =
  | "grant"
  | "move"
  | "equip"
  | "unequip"
  | "split"
  | "merge"
  | "transfer"
  | "destroy"
  | "durability_loss"
  | "repair"
  | "loadout_activate";

export interface ItemLedgerEntryInput {
  readonly operationId: string;
  readonly operationType: LedgerOperationType;
  readonly characterId: string;
  readonly counterpartyCharacterId?: string | null | undefined;
  readonly itemInstanceId?: string | null | undefined;
  readonly stackId?: string | null | undefined;
  readonly definitionCode: string;
  readonly definitionVersion: number;
  readonly sourceLocation: string | null;
  readonly destinationLocation: string | null;
  readonly quantity: number;
  readonly entityVersion: number;
  readonly causeReference: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ItemLedgerRecord extends ItemLedgerEntryInput {
  readonly id: string;
  readonly ledgerSeq: bigint;
  readonly recordedAt: Date;
}

interface ItemInstanceRow {
  id: string;
  definition_code: string;
  definition_version: number;
  owner_account_id: string;
  owner_character_id: string;
  location_state: ItemLocationState;
  container_id: string | null;
  container_slot_index: number | null;
  item_level: number;
  rarity_code: ItemRarityCode;
  quality_bp: number;
  power_budget_total: number;
  power_budget_spent: number;
  implicit_attributes: AttributeBlock;
  generated_attributes: AttributeBlock;
  current_durability: number | null;
  max_durability: number | null;
  binding_state: InstanceBindingState;
  bound_account_id: string | null;
  bound_character_id: string | null;
  generation_rules_version: number;
  generation_seed_hash: string;
  origin_type: ItemOriginType;
  origin_reference: string;
  instance_version: number;
  created_at: Date;
  updated_at: Date;
}

interface AffixRow {
  affix_code: string;
  affix_version: number;
  affix_kind: AffixKind;
  exclusive_group: string;
  rolled_magnitude: number;
  attribute_key: PrimaryAttributeKey | null;
  special_effect_code: string | null;
  special_effect_params: Readonly<Record<string, number>> | null;
  power_budget_cost: number;
  slot_ordinal: number;
}

interface StackRow {
  id: string;
  container_id: string;
  owner_character_id: string;
  container_slot_index: number;
  definition_code: string;
  definition_version: number;
  quantity: number;
  quality_bp: number;
  binding_state: "unbound" | "account_bound" | "character_bound";
  bound_account_id: string | null;
  bound_character_id: string | null;
  stack_equivalence_key: string;
  version: number;
}

function mapStackRow(row: StackRow): InventoryStack {
  return {
    id: row.id,
    containerId: row.container_id,
    ownerCharacterId: row.owner_character_id,
    containerSlotIndex: row.container_slot_index,
    definitionCode: row.definition_code,
    definitionVersion: row.definition_version,
    quantity: row.quantity,
    qualityBp: row.quality_bp,
    bindingState: row.binding_state,
    boundAccountId: row.bound_account_id,
    boundCharacterId: row.bound_character_id,
    stackEquivalenceKey: row.stack_equivalence_key,
    version: row.version,
  };
}

function mapAffixRow(row: AffixRow): RolledItemAffix {
  return {
    affixCode: row.affix_code,
    affixVersion: row.affix_version,
    affixKind: row.affix_kind,
    exclusiveGroup: row.exclusive_group,
    rolledMagnitude: row.rolled_magnitude,
    attributeKey: row.attribute_key,
    specialEffectCode: row.special_effect_code,
    specialEffectParams: row.special_effect_params,
    powerBudgetCost: row.power_budget_cost,
    slotOrdinal: row.slot_ordinal,
  };
}

function mapInstanceRow(
  row: ItemInstanceRow,
  affixes: ReadonlyArray<RolledItemAffix>,
): ItemInstance {
  return {
    id: row.id,
    definitionCode: row.definition_code,
    definitionVersion: row.definition_version,
    ownerAccountId: row.owner_account_id,
    ownerCharacterId: row.owner_character_id,
    locationState: row.location_state,
    containerId: row.container_id,
    containerSlotIndex: row.container_slot_index,
    itemLevel: row.item_level,
    rarityCode: row.rarity_code,
    qualityBp: row.quality_bp,
    powerBudgetTotal: row.power_budget_total,
    powerBudgetSpent: row.power_budget_spent,
    implicitAttributes: row.implicit_attributes,
    generatedAttributes: row.generated_attributes,
    affixes,
    currentDurability: row.current_durability,
    maxDurability: row.max_durability,
    bindingState: row.binding_state,
    boundAccountId: row.bound_account_id,
    boundCharacterId: row.bound_character_id,
    generationRulesVersion: row.generation_rules_version,
    generationSeedHash: row.generation_seed_hash,
    originType: row.origin_type,
    originReference: row.origin_reference,
    instanceVersion: row.instance_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgInventoryTransactionScope {
  public readonly client: PgPoolClient;

  constructor(client: PgPoolClient) {
    this.client = client;
  }

  public async claimOrVerifyEvent(
    input: ClaimProcessedEventInput,
  ): Promise<ClaimProcessedEventResult> {
    return claimOrVerifyProcessedEvent(this.client, input);
  }

  public async loadGenerationRules(
    rulesVersion: number,
  ): Promise<ItemGenerationRulesConfig | null> {
    const res = await this.client.query<{
      rules_version: number;
      code: string;
      level_budget_per_item_level: number;
      quality_bonus_max_bp: number;
      max_prefixes: number;
      max_suffixes: number;
      max_special_effects: number;
      empty_pool_policy: "allow_fewer_affixes" | "reject_if_below_min";
      max_equipped_attribute_bonus_cap: number;
      default_inventory_capacity: number;
      max_loadouts_per_character: number;
    }>(
      `SELECT
         rules_version,
         code,
         level_budget_per_item_level,
         quality_bonus_max_bp,
         max_prefixes,
         max_suffixes,
         max_special_effects,
         empty_pool_policy,
         max_equipped_attribute_bonus_cap,
         default_inventory_capacity,
         max_loadouts_per_character
       FROM item_generation_rules
       WHERE rules_version = $1 AND is_active = TRUE`,
      [rulesVersion],
    );
    const r = res.rows[0];
    if (!r) {
      return null;
    }
    return {
      rulesVersion: r.rules_version,
      code: r.code,
      levelBudgetPerItemLevel: r.level_budget_per_item_level,
      qualityBonusMaxBp: r.quality_bonus_max_bp,
      maxPrefixes: r.max_prefixes,
      maxSuffixes: r.max_suffixes,
      maxSpecialEffects: r.max_special_effects,
      emptyPoolPolicy: r.empty_pool_policy,
      maxEquippedAttributeBonusCap: r.max_equipped_attribute_bonus_cap,
      defaultInventoryCapacity: r.default_inventory_capacity,
      maxLoadoutsPerCharacter: r.max_loadouts_per_character,
    };
  }

  public async findItemDefinition(
    definitionCode: string,
    definitionVersion?: number,
  ): Promise<ItemDefinition | null> {
    const res =
      definitionVersion !== undefined
        ? await this.client.query(
            `SELECT * FROM item_definitions
             WHERE definition_code = $1 AND definition_version = $2`,
            [definitionCode, definitionVersion],
          )
        : await this.client.query(
            `SELECT * FROM item_definitions
             WHERE definition_code = $1 AND is_enabled = TRUE
             ORDER BY definition_version DESC
             LIMIT 1`,
            [definitionCode],
          );

    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      return null;
    }
    return {
      definitionCode: String(r["definition_code"]),
      definitionVersion: Number(r["definition_version"]),
      displayName: String(r["display_name"]),
      description: String(r["description"]),
      category: r["category"] as ItemCategory,
      subcategory: String(r["subcategory"]),
      equipSlotPolicy: r["equip_slot_policy"] as EquipSlotPolicy,
      allowedSlots: r["allowed_slots"] as ReadonlyArray<CombatEquipmentSlot>,
      stackable: Boolean(r["stackable"]),
      maxStackSize: Number(r["max_stack_size"]),
      baseItemLevel: Number(r["base_item_level"]),
      basePowerBudget: Number(r["base_power_budget"]),
      implicitModifiers: r["implicit_modifiers"] as Partial<Record<PrimaryAttributeKey, number>>,
      allowedRarities: r["allowed_rarities"] as ReadonlyArray<ItemRarityCode>,
      allowedAffixPools: r["allowed_affix_pools"] as ReadonlyArray<string>,
      maxDurability: r["max_durability"] === null ? null : Number(r["max_durability"]),
      requiredLevel: Number(r["required_level"]),
      requiredAttributes: r["required_attributes"] as Partial<Record<PrimaryAttributeKey, number>>,
      bindingPolicy: r["binding_policy"] as BindingPolicy,
      craftingTags: r["crafting_tags"] as ReadonlyArray<string>,
      tradeCategory: r["trade_category"] as "standard" | "restricted" | "non_tradable",
      isEnabled: Boolean(r["is_enabled"]),
    };
  }

  public async findRarity(rarityCode: string): Promise<RarityDefinition | null> {
    const res = await this.client.query(
      "SELECT * FROM item_rarities WHERE rarity_code = $1",
      [rarityCode],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      return null;
    }
    return {
      rarityCode: r["rarity_code"] as ItemRarityCode,
      displayName: String(r["display_name"]),
      ordinal: Number(r["ordinal"]),
      minExplicitAffixes: Number(r["min_explicit_affixes"]),
      maxExplicitAffixes: Number(r["max_explicit_affixes"]),
      powerBudgetMultiplierBp: Number(r["power_budget_multiplier_bp"]),
      minQualityBp: Number(r["min_quality_bp"]),
      maxQualityBp: Number(r["max_quality_bp"]),
      allowsSpecialEffects: Boolean(r["allows_special_effects"]),
      rulesVersion: Number(r["rules_version"]),
    };
  }

  public async listAffixesForPools(
    poolCodes: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<AffixDefinition>> {
    if (poolCodes.length === 0) {
      return [];
    }
    const res = await this.client.query(
      `SELECT * FROM affix_definitions
       WHERE pool_code = ANY($1::varchar[]) AND is_enabled = TRUE
       ORDER BY affix_code ASC, affix_version ASC`,
      [poolCodes],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      affixCode: String(r["affix_code"]),
      affixVersion: Number(r["affix_version"]),
      affixKind: r["affix_kind"] as AffixKind,
      poolCode: String(r["pool_code"]),
      displayName: String(r["display_name"]),
      tier: Number(r["tier"]),
      weight: Number(r["weight"]),
      allowedCategories: r["allowed_categories"] as ReadonlyArray<ItemCategory>,
      minItemLevel: Number(r["min_item_level"]),
      allowedRarities: r["allowed_rarities"] as ReadonlyArray<ItemRarityCode>,
      attributeKey: (r["attribute_key"] as PrimaryAttributeKey | null) ?? null,
      minModifier: Number(r["min_modifier"]),
      maxModifier: Number(r["max_modifier"]),
      specialEffectCode: (r["special_effect_code"] as string | null) ?? null,
      specialEffectParams:
        (r["special_effect_params"] as Readonly<Record<string, number>> | null) ?? null,
      powerBudgetCost: Number(r["power_budget_cost"]),
      exclusiveGroup: String(r["exclusive_group"]),
      isEnabled: Boolean(r["is_enabled"]),
    }));
  }

  public async ensureAndLockPrimaryContainers(
    characterId: string,
    defaultCapacity: number,
  ): Promise<{
    readonly bag: InventoryContainer;
    readonly activeLoadout: EquipmentLoadout;
  }> {
    const initBagId = deriveDeterministicEventUuid(`init-inv:${characterId.toLowerCase()}`);
    const initLoadoutId = deriveDeterministicEventUuid(`init-loadout:${characterId.toLowerCase()}`);

    await this.client.query(
      `INSERT INTO inventory_containers (id, owner_character_id, container_type, capacity, version)
       VALUES ($1, $2, 'character_inventory', $3, 1)
       ON CONFLICT (owner_character_id, container_type) DO NOTHING`,
      [initBagId, characterId, defaultCapacity],
    );

    await this.client.query(
      `INSERT INTO equipment_loadouts (id, character_id, name, is_active, version)
       SELECT $1::uuid, $2::uuid, 'Principal', TRUE, 1
       WHERE NOT EXISTS (
         SELECT 1 FROM equipment_loadouts WHERE character_id = $2::uuid AND is_active = TRUE
       )
       ON CONFLICT DO NOTHING`,
      [initLoadoutId, characterId],
    );

    const bagRes = await this.client.query<{
      id: string;
      owner_character_id: string;
      container_type: ContainerType;
      capacity: number;
      version: number;
    }>(
      `SELECT id, owner_character_id, container_type, capacity, version
       FROM inventory_containers
       WHERE owner_character_id = $1 AND container_type = 'character_inventory'
       FOR UPDATE`,
      [characterId],
    );
    const bagRow = bagRes.rows[0]!;

    const loadoutRes = await this.client.query<{
      id: string;
      character_id: string;
      name: string;
      is_active: boolean;
      version: number;
    }>(
      `SELECT id, character_id, name, is_active, version
       FROM equipment_loadouts
       WHERE character_id = $1 AND is_active = TRUE
       FOR UPDATE`,
      [characterId],
    );
    const loadoutRow = loadoutRes.rows[0]!;
    const slots = await this.listLoadoutSlots(loadoutRow.id);

    return {
      bag: {
        id: bagRow.id,
        ownerCharacterId: bagRow.owner_character_id,
        containerType: bagRow.container_type,
        capacity: bagRow.capacity,
        version: bagRow.version,
      },
      activeLoadout: {
        id: loadoutRow.id,
        characterId: loadoutRow.character_id,
        name: loadoutRow.name,
        isActive: loadoutRow.is_active,
        version: loadoutRow.version,
        slots,
      },
    };
  }

  public async ensureAndLockContainerByType(
    characterId: string,
    containerType: ContainerType,
    capacity: number,
  ): Promise<InventoryContainer> {
    const detContainerId = deriveDeterministicEventUuid(
      `${containerType}:${characterId.toLowerCase()}`,
    );
    await this.client.query(
      `INSERT INTO inventory_containers (id, owner_character_id, container_type, capacity, version)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (owner_character_id, container_type) DO NOTHING`,
      [detContainerId, characterId, containerType, capacity],
    );

    const res = await this.client.query<{
      id: string;
      owner_character_id: string;
      container_type: ContainerType;
      capacity: number;
      version: number;
    }>(
      `SELECT id, owner_character_id, container_type, capacity, version
       FROM inventory_containers
       WHERE owner_character_id = $1 AND container_type = $2
       FOR UPDATE`,
      [characterId, containerType],
    );
    const r = res.rows[0]!;
    return {
      id: r.id,
      ownerCharacterId: r.owner_character_id,
      containerType: r.container_type,
      capacity: r.capacity,
      version: r.version,
    };
  }

  public async findFreeContainerSlots(
    container: InventoryContainer,
    requiredCount: number,
  ): Promise<ReadonlyArray<number>> {
    const occupiedRes = await this.client.query<{ slot_idx: number }>(
      `SELECT container_slot_index AS slot_idx
       FROM item_instances
       WHERE container_id = $1 AND location_state = 'in_container'
       UNION ALL
       SELECT container_slot_index AS slot_idx
       FROM inventory_stacks
       WHERE container_id = $1`,
      [container.id],
    );
    const occupied = new Set(occupiedRes.rows.map((r) => r.slot_idx));
    const free: number[] = [];
    for (let idx = 0; idx < container.capacity && free.length < requiredCount; idx++) {
      if (!occupied.has(idx)) {
        free.push(idx);
      }
    }
    return free;
  }

  public async isSlotOccupied(containerId: string, slotIndex: number): Promise<boolean> {
    const res = await this.client.query<{ ok: number }>(
      `SELECT 1 AS ok FROM item_instances
       WHERE container_id = $1 AND container_slot_index = $2 AND location_state = 'in_container'
       UNION ALL
       SELECT 1 AS ok FROM inventory_stacks
       WHERE container_id = $1 AND container_slot_index = $2
       LIMIT 1`,
      [containerId, slotIndex],
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async insertItemInstance(instance: ItemInstance): Promise<void> {
    await this.client.query(
      `INSERT INTO item_instances (
         id, definition_code, definition_version,
         owner_account_id, owner_character_id,
         location_state, container_id, container_slot_index,
         item_level, rarity_code, quality_bp,
         power_budget_total, power_budget_spent,
         implicit_attributes, generated_attributes,
         current_durability, max_durability,
         binding_state, bound_account_id, bound_character_id,
         generation_rules_version, generation_seed_hash,
         origin_type, origin_reference,
         instance_version, created_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13,
         $14::jsonb, $15::jsonb,
         $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26, $27
       )`,
      [
        instance.id,
        instance.definitionCode,
        instance.definitionVersion,
        instance.ownerAccountId,
        instance.ownerCharacterId,
        instance.locationState,
        instance.containerId,
        instance.containerSlotIndex,
        instance.itemLevel,
        instance.rarityCode,
        instance.qualityBp,
        instance.powerBudgetTotal,
        instance.powerBudgetSpent,
        JSON.stringify(instance.implicitAttributes),
        JSON.stringify(instance.generatedAttributes),
        instance.currentDurability,
        instance.maxDurability,
        instance.bindingState,
        instance.boundAccountId,
        instance.boundCharacterId,
        instance.generationRulesVersion,
        instance.generationSeedHash,
        instance.originType,
        instance.originReference,
        instance.instanceVersion,
        instance.createdAt,
        instance.updatedAt,
      ],
    );

    for (const af of instance.affixes) {
      await this.client.query(
        `INSERT INTO item_instance_affixes (
           id, item_instance_id, affix_code, affix_version, affix_kind,
           exclusive_group, rolled_magnitude, attribute_key,
           special_effect_code, special_effect_params,
           power_budget_cost, slot_ordinal
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          randomUUID(),
          instance.id,
          af.affixCode,
          af.affixVersion,
          af.affixKind,
          af.exclusiveGroup,
          af.rolledMagnitude,
          af.attributeKey,
          af.specialEffectCode,
          af.specialEffectParams ? JSON.stringify(af.specialEffectParams) : null,
          af.powerBudgetCost,
          af.slotOrdinal,
        ],
      );
    }
  }

  public async lockItemInstanceById(instanceId: string): Promise<ItemInstance | null> {
    const res = await this.client.query<ItemInstanceRow>(
      "SELECT * FROM item_instances WHERE id = $1 FOR UPDATE",
      [instanceId],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const affixes = await this.loadInstanceAffixes(row.id);
    return mapInstanceRow(row, affixes);
  }

  public async findItemInstanceById(instanceId: string): Promise<ItemInstance | null> {
    const res = await this.client.query<ItemInstanceRow>(
      "SELECT * FROM item_instances WHERE id = $1",
      [instanceId],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const affixes = await this.loadInstanceAffixes(row.id);
    return mapInstanceRow(row, affixes);
  }

  private async loadInstanceAffixes(instanceId: string): Promise<ReadonlyArray<RolledItemAffix>> {
    const res = await this.client.query<AffixRow>(
      `SELECT
         affix_code, affix_version, affix_kind, exclusive_group,
         rolled_magnitude, attribute_key, special_effect_code,
         special_effect_params, power_budget_cost, slot_ordinal
       FROM item_instance_affixes
       WHERE item_instance_id = $1
       ORDER BY slot_ordinal ASC`,
      [instanceId],
    );
    return res.rows.map(mapAffixRow);
  }

  public async updateItemInstance(
    updated: ItemInstance,
    expectedPreviousVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE item_instances
       SET owner_account_id = $1,
           owner_character_id = $2,
           location_state = $3,
           container_id = $4,
           container_slot_index = $5,
           current_durability = $6,
           binding_state = $7,
           bound_account_id = $8,
           bound_character_id = $9,
           instance_version = $10,
           updated_at = $11
       WHERE id = $12 AND instance_version = $13`,
      [
        updated.ownerAccountId,
        updated.ownerCharacterId,
        updated.locationState,
        updated.containerId,
        updated.containerSlotIndex,
        updated.currentDurability,
        updated.bindingState,
        updated.boundAccountId,
        updated.boundCharacterId,
        updated.instanceVersion,
        updated.updatedAt,
        updated.id,
        expectedPreviousVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new EquipmentVersionConflictError(
        `ItemInstance(${updated.id})`,
        expectedPreviousVersion,
        updated.instanceVersion,
      );
    }
  }

  public async lockStacksInCanonicalOrder(
    stackIds: ReadonlyArray<string>,
  ): Promise<Map<string, InventoryStack>> {
    const uniqueSorted = Array.from(new Set(stackIds)).sort();
    const res = await this.client.query<StackRow>(
      `SELECT * FROM inventory_stacks
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR UPDATE`,
      [uniqueSorted],
    );
    const map = new Map<string, InventoryStack>();
    for (const r of res.rows) {
      map.set(r.id, mapStackRow(r));
    }
    return map;
  }

  public async listCompatibleStacksInContainer(
    containerId: string,
    equivalenceKey: string,
  ): Promise<ReadonlyArray<InventoryStack>> {
    const res = await this.client.query<StackRow>(
      `SELECT * FROM inventory_stacks
       WHERE container_id = $1 AND stack_equivalence_key = $2
       ORDER BY container_slot_index ASC
       FOR UPDATE`,
      [containerId, equivalenceKey],
    );
    return res.rows.map(mapStackRow);
  }

  public async listContainerStacks(containerId: string): Promise<ReadonlyArray<InventoryStack>> {
    const res = await this.client.query<StackRow>(
      `SELECT * FROM inventory_stacks
       WHERE container_id = $1
       ORDER BY container_slot_index ASC`,
      [containerId],
    );
    return res.rows.map(mapStackRow);
  }

  public async insertStack(stack: InventoryStack): Promise<void> {
    await this.client.query(
      `INSERT INTO inventory_stacks (
         id, container_id, owner_character_id, container_slot_index,
         definition_code, definition_version, quantity, quality_bp,
         binding_state, bound_account_id, bound_character_id,
         stack_equivalence_key, version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        stack.id,
        stack.containerId,
        stack.ownerCharacterId,
        stack.containerSlotIndex,
        stack.definitionCode,
        stack.definitionVersion,
        stack.quantity,
        stack.qualityBp,
        stack.bindingState,
        stack.boundAccountId,
        stack.boundCharacterId,
        stack.stackEquivalenceKey,
        stack.version,
      ],
    );
  }

  public async updateStack(
    stack: InventoryStack,
    expectedPreviousVersion: number,
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE inventory_stacks
       SET container_id = $1,
           container_slot_index = $2,
           quantity = $3,
           version = $4,
           updated_at = NOW()
       WHERE id = $5 AND version = $6`,
      [
        stack.containerId,
        stack.containerSlotIndex,
        stack.quantity,
        stack.version,
        stack.id,
        expectedPreviousVersion,
      ],
    );
    if (res.rowCount !== 1) {
      throw new EquipmentVersionConflictError(
        `InventoryStack(${stack.id})`,
        expectedPreviousVersion,
        stack.version,
      );
    }
  }

  public async deleteStack(stackId: string): Promise<void> {
    await this.client.query("DELETE FROM inventory_stacks WHERE id = $1", [stackId]);
  }

  public async listLoadoutSlots(
    loadoutId: string,
  ): Promise<ReadonlyArray<EquippedSlotAssignment>> {
    const res = await this.client.query<{
      slot_code: CombatEquipmentSlot;
      item_instance_id: string;
      occupies_off_hand: boolean;
    }>(
      `SELECT slot_code, item_instance_id, occupies_off_hand
       FROM equipment_loadout_slots
       WHERE loadout_id = $1
       ORDER BY slot_code ASC`,
      [loadoutId],
    );
    return res.rows.map((r) => ({
      slotCode: r.slot_code,
      itemInstanceId: r.item_instance_id,
      occupiesOffHand: r.occupies_off_hand,
    }));
  }

  public async replaceLoadoutSlots(
    loadoutId: string,
    slots: ReadonlyArray<EquippedSlotAssignment>,
  ): Promise<void> {
    await this.client.query("DELETE FROM equipment_loadout_slots WHERE loadout_id = $1", [
      loadoutId,
    ]);
    for (const s of slots) {
      await this.client.query(
        `INSERT INTO equipment_loadout_slots (loadout_id, slot_code, item_instance_id, occupies_off_hand)
         VALUES ($1, $2, $3, $4)`,
        [loadoutId, s.slotCode, s.itemInstanceId, s.occupiesOffHand],
      );
    }
    await this.client.query(
      "UPDATE equipment_loadouts SET version = version + 1, updated_at = NOW() WHERE id = $1",
      [loadoutId],
    );
  }

  public async purgeInactiveLoadoutReferencesForItem(
    characterId: string,
    itemInstanceId: string,
  ): Promise<void> {
    await this.client.query(
      `DELETE FROM equipment_loadout_slots
       WHERE item_instance_id = $1
         AND loadout_id IN (
           SELECT id FROM equipment_loadouts WHERE character_id = $2 AND is_active = FALSE
         )`,
      [itemInstanceId, characterId],
    );
  }

  public async appendLedger(entry: ItemLedgerEntryInput): Promise<void> {
    await this.client.query(
      `INSERT INTO item_operation_ledger (
         id, operation_id, operation_type, character_id, counterparty_character_id,
         item_instance_id, stack_id, definition_code, definition_version,
         source_location, destination_location, quantity, entity_version,
         cause_reference, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
      [
        randomUUID(),
        entry.operationId,
        entry.operationType,
        entry.characterId,
        entry.counterpartyCharacterId ?? null,
        entry.itemInstanceId ?? null,
        entry.stackId ?? null,
        entry.definitionCode,
        entry.definitionVersion,
        entry.sourceLocation,
        entry.destinationLocation,
        entry.quantity,
        entry.entityVersion,
        entry.causeReference,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  public async enqueueOutbox(params: {
    readonly aggregateType: "ItemInstance" | "InventoryContainer" | "Character";
    readonly aggregateId: string;
    readonly eventType: InventoryOutboxEventType;
    readonly correlationUuid: string;
    readonly causationEventUuid: string;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_events (
         id, aggregate_type, aggregate_id, event_type, event_version,
         correlation_id, causation_event_id, payload, occurred_at
       )
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8)`,
      [
        randomUUID(),
        params.aggregateType,
        params.aggregateId,
        params.eventType,
        params.correlationUuid,
        params.causationEventUuid,
        JSON.stringify(params.payload),
        params.occurredAt,
      ],
    );
  }
}

export class PostgresInventoryUnitOfWork {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async executeInTransaction<T>(
    work: (scope: PgInventoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(this.pool, async (client) => {
      const scope = new PgInventoryTransactionScope(client);
      return work(scope);
    });
  }
}

export class PostgresInventoryRepository {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  public async seedInitialItemCatalogs(
    rules: ItemGenerationRulesConfig = DEFAULT_ITEM_GENERATION_RULES_V1,
  ): Promise<void> {
    for (const r of INITIAL_RARITIES_CATALOG) {
      await this.pool.query(
        `INSERT INTO item_rarities (
           rarity_code, display_name, ordinal, min_explicit_affixes, max_explicit_affixes,
           power_budget_multiplier_bp, min_quality_bp, max_quality_bp, allows_special_effects, rules_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (rarity_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               ordinal = EXCLUDED.ordinal,
               min_explicit_affixes = EXCLUDED.min_explicit_affixes,
               max_explicit_affixes = EXCLUDED.max_explicit_affixes,
               power_budget_multiplier_bp = EXCLUDED.power_budget_multiplier_bp,
               min_quality_bp = EXCLUDED.min_quality_bp,
               max_quality_bp = EXCLUDED.max_quality_bp,
               allows_special_effects = EXCLUDED.allows_special_effects`,
        [
          r.rarityCode,
          r.displayName,
          r.ordinal,
          r.minExplicitAffixes,
          r.maxExplicitAffixes,
          r.powerBudgetMultiplierBp,
          r.minQualityBp,
          r.maxQualityBp,
          r.allowsSpecialEffects,
          r.rulesVersion,
        ],
      );
    }

    for (const se of INITIAL_SPECIAL_EFFECTS_CATALOG) {
      await this.pool.query(
        `INSERT INTO special_effect_definitions (
           effect_code, effect_version, display_name, description,
           trigger_category, parameter_schema, power_budget_cost, is_enabled
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (effect_code) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               trigger_category = EXCLUDED.trigger_category,
               parameter_schema = EXCLUDED.parameter_schema,
               power_budget_cost = EXCLUDED.power_budget_cost`,
        [
          se.effectCode,
          se.effectVersion,
          se.displayName,
          se.description,
          se.triggerCategory,
          JSON.stringify(se.parameterSchema),
          se.powerBudgetCost,
          se.isEnabled,
        ],
      );
    }

    for (const af of INITIAL_AFFIXES_CATALOG) {
      await this.pool.query(
        `INSERT INTO affix_definitions (
           affix_code, affix_version, affix_kind, pool_code, display_name,
           tier, weight, allowed_categories, min_item_level, allowed_rarities,
           attribute_key, min_modifier, max_modifier, special_effect_code,
           special_effect_params, power_budget_cost, exclusive_group, is_enabled
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb,
           $11, $12, $13, $14, $15::jsonb, $16, $17, $18
         )
         ON CONFLICT (affix_code, affix_version) DO NOTHING`,
        [
          af.affixCode,
          af.affixVersion,
          af.affixKind,
          af.poolCode,
          af.displayName,
          af.tier,
          af.weight,
          JSON.stringify(af.allowedCategories),
          af.minItemLevel,
          JSON.stringify(af.allowedRarities),
          af.attributeKey,
          af.minModifier,
          af.maxModifier,
          af.specialEffectCode,
          af.specialEffectParams ? JSON.stringify(af.specialEffectParams) : null,
          af.powerBudgetCost,
          af.exclusiveGroup,
          af.isEnabled,
        ],
      );
    }

    for (const def of INITIAL_ITEM_DEFINITIONS_CATALOG) {
      await this.upsertItemDefinition(def);
    }

    await this.pool.query(
      `INSERT INTO item_generation_rules (
         rules_version, code, level_budget_per_item_level, quality_bonus_max_bp,
         max_prefixes, max_suffixes, max_special_effects, empty_pool_policy,
         max_equipped_attribute_bonus_cap, default_inventory_capacity, max_loadouts_per_character, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
       ON CONFLICT (rules_version) DO UPDATE
         SET level_budget_per_item_level = EXCLUDED.level_budget_per_item_level,
             quality_bonus_max_bp = EXCLUDED.quality_bonus_max_bp,
             max_prefixes = EXCLUDED.max_prefixes,
             max_suffixes = EXCLUDED.max_suffixes,
             max_special_effects = EXCLUDED.max_special_effects,
             empty_pool_policy = EXCLUDED.empty_pool_policy`,
      [
        rules.rulesVersion,
        rules.code,
        rules.levelBudgetPerItemLevel,
        rules.qualityBonusMaxBp,
        rules.maxPrefixes,
        rules.maxSuffixes,
        rules.maxSpecialEffects,
        rules.emptyPoolPolicy,
        rules.maxEquippedAttributeBonusCap,
        rules.defaultInventoryCapacity,
        rules.maxLoadoutsPerCharacter,
      ],
    );
  }

  public async upsertItemDefinition(def: ItemDefinition): Promise<void> {
    validateItemDefinition(def);
    await this.pool.query(
      `INSERT INTO item_definitions (
         definition_code, definition_version, display_name, description,
         category, subcategory, equip_slot_policy, allowed_slots,
         stackable, max_stack_size, base_item_level, base_power_budget,
         implicit_modifiers, allowed_rarities, allowed_affix_pools,
         max_durability, required_level, required_attributes,
         binding_policy, crafting_tags, trade_category, is_enabled
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
         $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb,
         $16, $17, $18::jsonb, $19, $20::jsonb, $21, $22
       )
       ON CONFLICT (definition_code, definition_version) DO NOTHING`,
      [
        def.definitionCode,
        def.definitionVersion,
        def.displayName,
        def.description,
        def.category,
        def.subcategory,
        def.equipSlotPolicy,
        JSON.stringify(def.allowedSlots),
        def.stackable,
        def.maxStackSize,
        def.baseItemLevel,
        def.basePowerBudget,
        JSON.stringify(def.implicitModifiers),
        JSON.stringify(def.allowedRarities),
        JSON.stringify(def.allowedAffixPools),
        def.maxDurability,
        def.requiredLevel,
        JSON.stringify(def.requiredAttributes),
        def.bindingPolicy,
        JSON.stringify(def.craftingTags),
        def.tradeCategory,
        def.isEnabled,
      ],
    );
  }

  /**
   * Registers a new immutable `ItemDefinition` version.
   * Rejects duplicate `(definitionCode, definitionVersion)` so existing versions can never be silently mutated.
   */
  public async registerItemDefinition(def: ItemDefinition): Promise<ItemDefinition> {
    validateItemDefinition(def);
    const res = await this.pool.query(
      `INSERT INTO item_definitions (
         definition_code, definition_version, display_name, description,
         category, subcategory, equip_slot_policy, allowed_slots,
         stackable, max_stack_size, base_item_level, base_power_budget,
         implicit_modifiers, allowed_rarities, allowed_affix_pools,
         max_durability, required_level, required_attributes,
         binding_policy, crafting_tags, trade_category, is_enabled
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
         $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb,
         $16, $17, $18::jsonb, $19, $20::jsonb, $21, $22
       )
       ON CONFLICT (definition_code, definition_version) DO NOTHING
       RETURNING definition_code`,
      [
        def.definitionCode,
        def.definitionVersion,
        def.displayName,
        def.description,
        def.category,
        def.subcategory,
        def.equipSlotPolicy,
        JSON.stringify(def.allowedSlots),
        def.stackable,
        def.maxStackSize,
        def.baseItemLevel,
        def.basePowerBudget,
        JSON.stringify(def.implicitModifiers),
        JSON.stringify(def.allowedRarities),
        JSON.stringify(def.allowedAffixPools),
        def.maxDurability,
        def.requiredLevel,
        JSON.stringify(def.requiredAttributes),
        def.bindingPolicy,
        JSON.stringify(def.craftingTags),
        def.tradeCategory,
        def.isEnabled,
      ],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new ItemDefinitionInvalidError(
        `ItemDefinition '${def.definitionCode}' v${def.definitionVersion} already exists; publish version ${def.definitionVersion + 1} instead.`,
      );
    }
    return def;
  }

  public async listCharacterItems(characterId: string): Promise<ReadonlyArray<ItemInstance>> {
    const res = await this.pool.query<ItemInstanceRow>(
      "SELECT * FROM item_instances WHERE owner_character_id = $1 AND location_state <> 'destroyed' ORDER BY created_at ASC",
      [characterId],
    );
    const out: ItemInstance[] = [];
    for (const row of res.rows) {
      const affRes = await this.pool.query<AffixRow>(
        `SELECT
           affix_code, affix_version, affix_kind, exclusive_group,
           rolled_magnitude, attribute_key, special_effect_code,
           special_effect_params, power_budget_cost, slot_ordinal
         FROM item_instance_affixes
         WHERE item_instance_id = $1
         ORDER BY slot_ordinal ASC`,
        [row.id],
      );
      out.push(mapInstanceRow(row, affRes.rows.map(mapAffixRow)));
    }
    return out;
  }

  public async listCharacterStacks(characterId: string): Promise<ReadonlyArray<InventoryStack>> {
    const res = await this.pool.query<StackRow>(
      "SELECT * FROM inventory_stacks WHERE owner_character_id = $1 ORDER BY container_slot_index ASC",
      [characterId],
    );
    return res.rows.map(mapStackRow);
  }

  public async listCharacterLedger(
    characterId: string,
    options?: { readonly limit?: number | undefined },
  ): Promise<ReadonlyArray<ItemLedgerRecord>> {
    const rawLimit = options?.limit ?? 1000;
    const safeLimit = Math.max(1, Math.min(5000, Math.trunc(rawLimit)));
    const res = await this.pool.query<{
      id: string;
      ledger_seq: string;
      operation_id: string;
      operation_type: LedgerOperationType;
      character_id: string;
      counterparty_character_id: string | null;
      item_instance_id: string | null;
      stack_id: string | null;
      definition_code: string;
      definition_version: number;
      source_location: string | null;
      destination_location: string | null;
      quantity: number;
      entity_version: number;
      cause_reference: string;
      metadata: Record<string, unknown>;
      recorded_at: Date;
    }>(
      `SELECT * FROM item_operation_ledger
       WHERE character_id = $1 OR counterparty_character_id = $1
       ORDER BY ledger_seq ASC
       LIMIT $2`,
      [characterId, safeLimit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      ledgerSeq: BigInt(r.ledger_seq),
      operationId: r.operation_id,
      operationType: r.operation_type,
      characterId: r.character_id,
      counterpartyCharacterId: r.counterparty_character_id,
      itemInstanceId: r.item_instance_id,
      stackId: r.stack_id,
      definitionCode: r.definition_code,
      definitionVersion: r.definition_version,
      sourceLocation: r.source_location,
      destinationLocation: r.destination_location,
      quantity: r.quantity,
      entityVersion: r.entity_version,
      causeReference: r.cause_reference,
      metadata: r.metadata,
      recordedAt: r.recorded_at,
    }));
  }
}
