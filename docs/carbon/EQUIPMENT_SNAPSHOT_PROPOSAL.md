# Equipment Integration & `EquipmentSnapshotProposalV1`

## 1. Integração Compatível com `CharacterSnapshotV1`

Na Session 03, `CharacterSnapshotV1` já previa o vetor `equipped_items` (`CharacterEquipmentSlotSummary[]`), então vazio (`[]`).

Na Session 04, `PostgresCharacterSnapshotReader.getCharacterSnapshot` (`src/modules/characters/application/character-snapshot-query.ts`) projeta os equipamentos ativos a partir de uma única transação `REPEATABLE READ READ ONLY`:
1. Carrega o personagem, seus atributos e seu *loadout* ativo (`equipment_loadouts WHERE is_active = TRUE`).
2. Filtra apenas instâncias com `location_state = 'equipped_active'` que passem em `checkIntrinsicCharacterEligibility` (`currentDurability > 0`, `level >= requiredLevel` e `base + allocated >= requiredAttributes`).
3. Preenche `equipped_items` com `{ slotCode, itemDefinitionCode, itemInstanceId, schemaVersion }`, validado tanto por Zod (`CharacterSnapshotWireV1Schema`) quanto por JSON Schema (`contracts/neon-carbon/character-snapshot.v1.schema.json`).

Consumidores existentes de `CharacterSnapshotWireV1` permanecem **100% compatíveis** sem quebra de versão (`contract_version: 1`).

---

## 2. Proposta de Contrato Complementar: `EquipmentSnapshotProposalV1`

Como `CharacterSnapshotWireV1` carrega apenas o resumo estrutural dos slots equipados, o CARBON propõe ao NEON o contrato complementar somente leitura `EquipmentSnapshotProposalV1`:
- **Implementação:** `PostgresEquipmentSnapshotReader` (`src/modules/inventory/application/equipment-snapshot-query.ts`).
- **Schema JSON:** `contracts/neon-carbon/equipment-snapshot.v1.schema.json`.

### Campos Projetados
- `contractVersion: 1`, `characterId`, `buildVersion`, `snapshotVersion`, `activeLoadoutId`, `normalizationProfile` (`open_world_persistent` | `legacy_ranked_md3`).
- `equipmentModifiers`: soma dos atributos implícitos + gerados proceduralmente de todos os equipamentos ativos elegíveis, limitada por `maxEquippedAttributeBonusCap` (`500` provisório).
- `aggregatedEffectiveAttributes`: `baseAttributes + allocatedAttributes + equipmentModifiers` (entregue como referência auditável; fórmulas finais de combate pertencem ao NEON).
- `equippedDetails`: lista detalhada por slot contendo `occupiesOffHand`, `rarityCode`, `qualityBp`, `currentDurability`, `maxDurability`, `isActiveForCombat`, `suppressionReason`, `implicitAttributes`, `generatedAttributes` e `specialEffects` declarativos (`{ effectCode, params }`).

---

## 3. Isolamento Estrito do Modo Genesis Ranked

Tanto `PostgresCharacterSnapshotReader` quanto `PostgresEquipmentSnapshotReader` rejeitam `normalizationProfile = 'genesis_ranked_md3_scratch'` com `GenesisTemporaryStatePersistenceForbiddenError`. No modo *Genesis Ranked*, builds e equipamentos da partida nascem do zero em memória efêmera do simulador competitivo e nunca leem ou gravam inventário persistente do CARBON.

---

## 4. Pontos Abertos para Revisão Conjunta CARBON <-> NEON
1. Decidir se o NEON consumirá `EquipmentSnapshotProposalV1` em endpoint/query dedicado ou embutirá os detalhes procedurais em uma futura `CharacterSnapshotWireV2`.
2. Definir o catálogo compartilhado definitivo de `special_effect_code` e suas unidades *fixed-point* em ticks de simulação Go.
3. Definir a política de normalização de afixos procedurais no modo *Legacy Ranked MD3* versus *Open World Persistent*.
