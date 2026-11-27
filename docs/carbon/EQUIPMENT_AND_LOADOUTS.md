# Equipment Slots, Requirements & Loadouts

## 1. Quatorze Slots de Combate (`COMBAT_EQUIPMENT_SLOTS`)

`main_hand`, `off_hand`, `head`, `chest`, `hands`, `legs`, `feet`, `waist`, `neck`, `ring_1`, `ring_2`, `back`, `trinket_1`, `trinket_2`.

### Políticas de Compatibilidade (`equip_slot_policy`)
- **`none`:** Recursos, consumíveis e itens de missão — não equipáveis.
- **`cosmetic_only`:** Cosméticos puros (ex.: `ashvale_ceremonial_cloak`) — proibidos em slots de combate (`EquipmentSlotIncompatibleError`), garantindo zero vantagem competitiva por item cosmético.
- **`single_slot`:** Compatível apenas com os slots listados em `allowed_slots` (ex.: `chest`, `head`, `feet`, `off_hand` para escudos/grimórios).
- **`either_hand`:** Armas de uma mão versáteis (`main_hand` ou `off_hand`).
- **`two_handed`:** Armas de duas mãos (`heavy_axe_2h`, `staff_2h`, `bow_2h`, `gauntlets`). Equipáveis exclusivamente em `main_hand` com `occupies_off_hand = TRUE`, reservando `off_hand`:
  - Ao equipar uma arma `two_handed`, quaisquer itens atualmente em `main_hand` **e** `off_hand` (ex.: espada + escudo) são desequipados atomicamente para slots livres em `character_inventory`.
  - Se o inventário não possuir slots livres suficientes para receber ambos os itens deslocados, a transação inteira sofre *rollback* (`InventoryCapacityExceededError`) sem estado parcial.
  - Ao equipar um item em `off_hand` enquanto `main_hand` contém uma arma `two_handed`, a arma de duas mãos é automaticamente recolhida ao inventário.
- **`ring_any` / `trinket_any`:** Permitem equipar duas instâncias distintas em `ring_1`/`ring_2` ou `trinket_1`/`trinket_2`, bloqueando que a mesma `item_instance_id` ocupe dois slots (`UNIQUE (loadout_id, item_instance_id)`).

---

## 2. Requisitos Intrínsecos Não Circulares e Durabilidade Zero

Implementado em `checkIntrinsicCharacterEligibility` (`src/modules/inventory/domain/equipment-and-stack-rules.ts`):
1. **Regra Anti-Circularidade:** `required_attributes` é avaliado estritamente contra `character.baseAttributes[k] + character.allocatedAttributes[k]`. Bônus concedidos por outros equipamentos ativos **jamais** contam para satisfazer requisitos de equipagem, eliminando ciclos de auto-sustentação (*stat bootstrapping*).
2. **Pós-Respec:** Caso o personagem realize um *respec* de atributos na Session 03 e deixe de cumprir o requisito intrínseco de um item já equipado, o item permanece equipado/pertencente ao personagem sem perda patrimonial, mas torna-se inativo para combate (`isActiveForCombat = false`), sendo omitido de `CharacterSnapshotV1.equippedItems` e `equipmentModifiers`.
3. **Equipamento Quebrado (`current_durability = 0`):** Não pode ser recém-equipado e, se quebrar enquanto vestido, permanece no slot porém com `isActiveForCombat = false` até ser reparado via `repairItem`.

---

## 3. Múltiplos Loadouts Persistentes

- Cada personagem comporta até `max_loadouts_per_character = 5` *loadouts* nomeados (`equipment_loadouts`), com índice único parcial `uq_equipment_loadouts_single_active` garantindo no máximo um *loadout* ativo por personagem.
- **`saveInactiveLoadout`:** Valida propriedade de todas as instâncias, compatibilidade de slots, unicidade de instância e proibição de `two_handed + off_hand`.
- **`activateLoadout`:** Executa troca atômica: trava todas as instâncias envolvidas em ordem canônica de UUID, revalida propriedade/durabilidade/requisitos, move itens entrantes para `equipped_active`, devolve itens saintes para `character_inventory`, alterna `is_active`, incrementa `character.build_version` e `snapshot_version` e emite `CharacterLoadoutChanged` + `CharacterBuildChanged`.

---

## 4. Bloqueio Competitivo e Isolamento Genesis
- Se `character.competitive_lock_state = 'in_ranked_series'`, `equipItem`, `unequipItem` e `activateLoadout` são bloqueados com `CharacterCompetitiveLockedError`.
- Qualquer operação com `executionProfile = 'genesis_ranked_md3_scratch'` é rejeitada imediatamente com `GenesisTemporaryStatePersistenceForbiddenError`.
