# Handoff CARBON — Session 06 (`carbon/skills-weapon-mastery-engine`)

- **Branch base (Session 05):** `carbon/reputation-bounty-titles-engine` (`ab54fae9387b5898b35844f35844f359e0224c0023b463` -> `ab54fae9387b5898b35844f359e0224c0023b463`)
- **Branch da Session 06:** `carbon/skills-weapon-mastery-engine`
- **Data:** 2026-11-27

---

## 1. Entregas da Session 06

1. **Migrações Incrementais `0010` e `0011`:**
   - `0010`: `mastery_and_skill_rules`, `combat_schools` (12 escolas: 6 habilitadas + 6 planejadas), `ability_definitions` (28 habilidades versionadas: 27 habilitadas + 1 planejada) e `specialization_nodes` (18 nós DAG validados).
   - `0011`: `character_weapon_masteries` (22 famílias `WEAPON_SUBCATEGORIES` + `unarmed`), `mastery_experience_grants` (com bloqueio `UNIQUE (source_event_id, character_id)`), `character_specialization_points` (`earned = spent + unspent` + *backfill* automático), `character_specialization_point_grants`, `character_specialization_unlocks`, `character_learned_abilities`, `character_ability_loadout_slots` (integrado a `equipment_loadouts`) e `character_skill_history`.
2. **`SkillEngineService`, Supressão Não Destrutiva e Títulos de Maestria:**
   - Concessão autoritativa e idempotente de XP de maestria com proteções contra *alt-farming*, *cooldown*/janela e retornos decrescentes.
   - `unlockSpecializationNode`, `learnAbility`, `upgradeAbilityRank`, `equipAbility`, `unequipAbility`, `saveLoadoutAbilities` e `resetSpecialization` com bloqueio competitivo (`in_ranked_series`) e isolamento estrito do modo *Genesis Ranked*.
   - Habilitação real e testada do título `master_of_blades` (*Mestre das Lâminas*, `v2`) via novos operadores declarativos em `src/modules/titles/`.
3. **`CharacterSnapshotV1.equipped_abilities` + `AbilitySnapshotV1` + 47 Cenários + Demo de 30 Etapas:**
   - Preenchimento canônico de `CharacterSnapshotV1.equipped_abilities` sem quebrar o contrato `v1`.
   - Contrato complementar `contracts/neon-carbon/ability-snapshot.v1.schema.json` + Zod + `assertConsistentCombatSnapshots`.
   - Demonstração reproduzível `npm run demo:session06` (30 etapas completas com restart real do PostgreSQL).

---

## 2. Comandos de Reprodução

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run demo:session02
npm run demo:session03
npm run demo:session04
npm run demo:session05
npm run demo:session06
```

---

## 3. Situação da Cadeia de Branches/PRs do CARBON e Proposta de Revisão Cumulativa (Sessions 01–06)

### Cadeia Atual de Branches Publicadas / Locais
Enquanto `origin/main` (`33003f5`) contém apenas a documentação inicial do projeto e as branches do NEON evoluem de forma independente (`neon/backend-foundation`, `neon/creature-ai-engine`, `neon/world-event-director`, `neon/dynamic-ecosystem-engine`, `neon/invasion-siege-engine`), o CARBON forma uma cadeia linear limpa de ancestralidade direta:
1. `feature/carbon-initial-persistence` (`b9368d5`) — Session 01
2. `carbon/contribution-integration-engine` (`92f2732`) — Session 02
3. `carbon/character-progression-engine` (`8f39621`) — Session 03
4. `carbon/inventory-equipment-engine` (`6e0b843`) — Session 04
5. `carbon/reputation-bounty-titles-engine` (`ab54fae`) — Session 05
6. `carbon/skills-weapon-mastery-engine` (local, pronta para publicação) — Session 06

### Proposta de Auditoria e Integração Acumulada (Sem Merge Automático)
1. **PR Empilhado Imediato:** Abrir o PR de `carbon/skills-weapon-mastery-engine` apontando a base para `carbon/reputation-bounty-titles-engine` para revisão isolada do diff da Session 06.
2. **Auditoria Independente Cumulativa (Sessions 01–06):** Realizar uma revisão dedicada do pacote consolidado (`0001..0011`, contratos `contracts/neon-carbon/*.schema.json` e matriz `docs/OWNERSHIP.md`) junto ao NEON/Codex antes de integrar a pilha na `main`.
3. **Ordem de Merge Recomendada Após Aprovação:** Integrar em ordem topológica estrita (`Session 01 -> 02 -> 03 -> 04 -> 05 -> 06`) com CI verde em cada etapa (incluindo o job `neon-go` no GitHub Actions).

---

## 4. Pendências de Integração Preservadas para Aprovação Conjunta

- Transporte autenticado Go <-> TypeScript, *worker* de publicação do `outbox_events` e *retry* de contribuições.
- Identidade persistente de facções invasoras, eventos terminais de cidades e vínculo de sessão `PlayerID <-> CharacterID`.
- Execução real de combate das referências `gameplay_effect_ref`, efeitos especiais de itens, fórmulas definitivas de combate e normalização competitiva (*Legacy Ranked MD3*).
- Liquidação monetária real de recompensas criminais (`pending_economy_settlement`).
- Divergência de nomenclatura da 7ª raridade de itens (`relic` / *Relíquia* vs *Divino*), mantida inalterada sem migração unilateral.
