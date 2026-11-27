# ADR CARBON-0008 — Habilidades Versionadas, Maestria de Armas, Árvores DAG e Builds Emergentes

- **Status:** Accepted (CARBON Internal Persistence) / Proposed (Joint Wire `AbilitySnapshotV1`)
- **Data:** 2026-11-27
- **Owner:** CARBON (Persistence, Progression, Economy & Identity Bounded Contexts)

---

## 1. Contexto

O ASCENDRA combina mundo aberto persistente em 2D com combate técnico inspirado em *fighting games*, sem classes tradicionais obrigatórias. Após entregar identidade/atributos (Session 03), inventário/equipamentos procedurais e *loadouts* (Session 04), e reputação/criminalidade/títulos (Session 05), precisávamos estabelecer:
1. Um modelo persistente e versionado de escolas de combate, habilidades ativas/passivas/reativas/*supers* e árvores de especialização sem executar lógica de combate no TypeScript nem usar `eval`.
2. Progressão independente de maestria nas **22 famílias de armas** já cadastradas na Session 04 (`WEAPON_SUBCATEGORIES`) mais combate desarmado (`unarmed`), protegida contra *alt-farming* e duplicação por múltiplas armas no mesmo evento.
3. Separação rigorosa entre **elegibilidade de aprendizado** e **elegibilidade de uso em tempo de execução**, preservando progresso histórico durante trocas de arma, quebra de durabilidade (`0`) ou *respec*.
4. Preenchimento compatível de `CharacterSnapshotV1.equipped_abilities` e criação do contrato complementar `AbilitySnapshotV1` para futura execução determinística em Go pelo **NEON**.

---

## 2. Decisão

1. **Catálogo Versionado e Passivas Declarativas (`0010`):**
   - `ability_definitions` usa chave primária composta imutável `(ability_code, ability_version)`. Novas revisões coexistem sem corromper aprendizados anteriores.
   - Passivas armazenam exclusivamente mapas numéricos declarativos validados (`declarative_passive_params`) e referências simbólicas versionadas (`gameplay_effect_ref`), com zero código executável no banco.
2. **Maestria Independente nas 22 Famílias + `unarmed` (`0011`):**
   - `MASTERY_WEAPON_FAMILIES` reutiliza integralmente `WEAPON_SUBCATEGORIES` sem mutá-lo, acrescentando `'unarmed'` para artes marciais.
   - `mastery_experience_grants` exige `internal_system_authority`, bloqueia contraparte da mesma conta e impõe `UNIQUE (source_event_id, character_id)` para impedir duplicação da mesma recompensa em múltiplas famílias.
3. **Orçamento Separado de Especialização e Árvores DAG:**
   - `character_specialization_points` mantém lei de conservação no PostgreSQL (`spent_points + unspent_points = earned_points`), independente de `earned_attribute_points`.
   - `validateSpecializationDag` valida ausência de ciclos via DFS tricolor, profundidade máxima (`<= 5`), limite por escola (`<= 24`) e coerência de grupos exclusivos antes de persistir nós.
4. **Requisitos Não Circulares e Supressão Não Destrutiva:**
   - Requisitos de atributos verificam exclusivamente atributos intrínsecos (`base + allocated`), eliminando ciclos entre bônus de itens, passivas e habilidades.
   - Trocar para arma incompatível, zerar durabilidade da arma ou executar *respec* **suprime** a habilidade equipada (`isEligible = false` com `suppressionReason` explícita em `AbilitySnapshotV1` e omissão em `CharacterSnapshotV1.equipped_abilities`) sem apagar `character_learned_abilities` nem `max_rank_ever_reached`.
5. **Unificação com `equipment_loadouts` e Ordem Canônica de Locks:**
   - `character_ability_loadout_slots` referencia diretamente `equipment_loadouts(id)`, permitindo que `InventoryEngineService.activateLoadout` alterne equipamentos e habilidades atomicamente.
   - Todas as mutações em Character, Inventory, Social e Skill Engines adquirem `SELECT ... FROM characters WHERE id = $1 FOR UPDATE OF c` primeiro, eliminando *deadlocks* em trocas concorrentes de arma + equipagem/*respec*.

---

## 3. Consequências

- **Positivas:** Liberdade total para builds híbridas (*Cavaleiro Arcano*, *Assassino Híbrido*, *Guardião*, *Monge*); zero quebra em consumidores `CharacterSnapshotWireV1`; rastreabilidade completa em `character_skill_history` e `outbox_events`.
- **Limitações Conhecidas:** A execução real de *startup/active/recovery frames*, *hitboxes*, recursos de combate e fórmulas competitivas permanece sob responsabilidade do **NEON** em Go e exige ratificação conjunta de `AbilitySnapshotV1`.
