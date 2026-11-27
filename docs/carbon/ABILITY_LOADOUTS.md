# Loadouts de Habilidades, Orçamento de Build e Elegibilidade de Uso

## 1. Unificação com `equipment_loadouts`

Para evitar duas fontes concorrentes ou incompatíveis de build, `character_ability_loadout_slots` referencia diretamente `equipment_loadouts(id) ON DELETE CASCADE` (criado na Session 04):
- Um *loadout* representa uma configuração integrada de **equipamentos + habilidades** (ex.: *Principal — Cavaleiro Arcano*, *Arcanista Astral*, *PvE Defesa*).
- Quando `InventoryEngineService.activateLoadout` alterna `is_active = TRUE` entre loadouts, tanto `CharacterSnapshotV1.equipped_items` quanto `CharacterSnapshotV1.equipped_abilities` (e `AbilitySnapshotV1`) passam atomicamente a refletir o novo *loadout* ativo, incrementando `build_version` e `snapshot_version`.

---

## 2. Limites Configuráveis de Slots e Orçamento de Build (`max_build_equipment_cost`)

Embora o contrato *wire* `CharacterSnapshotV1` aceite `slotIndex` entre `0` e `31`, a regra inicial `dev_skills_mastery_v1` utiliza limites menores como *fixture* estratégica:
- **Habilidades Ativas / Reativas / Mobilidade / Defensivas (`slot_group = 'active'`):** máximo `4` slots.
- **Habilidades Passivas Declarativas (`slot_group = 'passive'`):** máximo `2` slots.
- **Técnicas Ultimate / Super (`slot_group = 'ultimate'`):** máximo `1` slot.
- **Total simultâneo:** máximo `7` slots.
- **Orçamento de Configuração (`max_build_equipment_cost`):** máximo `12` pontos de `equipment_cost` somados no *loadout* (impedindo equipar simultaneamente múltiplas passivas pesadas, técnicas especializadas e *supers* sem escolhas táticas).
- **Grupos Exclusivos (`exclusive_group`):** impede equipar simultaneamente duas posturas ou doutrinas mutuamente exclusivas (ex.: `unwavering_stance` e `arcane_barrier` compartilham `active_defensive_posture`; `blade_discipline` e `guardian_resilience` compartilham `passive_combat_doctrine`).

---

## 3. Separação entre Aprendizado e Elegibilidade de Uso em Runtime

### A. Elegibilidade de Aprendizado (`assertCanLearnAbility`)
Verifica apenas estado intrínseco e persistente: conta ativa, personagem não bloqueado em série ranqueada, escola e habilidade habilitadas, nível do personagem, **atributos intrínsecos (`base + allocated`)** — sem bônus de itens ou passivas para impedir dependências circulares —, nível de maestria, habilidades pré-requisito e nós DAG ativos.

### B. Elegibilidade de Uso (`evaluateRuntimeAbilityUsageEligibility`)
Avaliada em tempo de leitura/equipagem sobre o *loadout* ativo sem jamais apagar aprendizado histórico:
1. Habilidade desabilitada no catálogo -> `ability_disabled`.
2. Inativa após *respec* de especialização -> `inactive_after_specialization_reset`.
3. Nó pré-requisito inativo -> `inactive_prerequisite_node`.
4. Nível intrínseco insuficiente -> `insufficient_character_level`.
5. Atributos intrínsecos insuficientes (ex.: após `respecAttributes`) -> `insufficient_attributes`.
6. Maestria insuficiente -> `insufficient_weapon_mastery`.
7. Arma compatível equipada com `currentDurability === 0` -> `equipped_weapon_broken`.
8. Nenhuma arma ativa compatível em `main_hand`/`off_hand` (ou `main_hand` ocupada quando a técnica exige `unarmed`) -> `incompatible_equipped_weapon`.

Quando uma arma é trocada (ex.: espada longa -> cajado de duas mãos) ou quebra em combate, as técnicas incompatíveis permanecem salvas no *loadout* e aprendidas em `character_learned_abilities`, sendo omitidas de `CharacterSnapshotV1.equipped_abilities` e reportadas com `is_eligible: false` + `suppression_reason` em `AbilitySnapshotV1` até que uma arma compatível íntegra seja reequipada.
