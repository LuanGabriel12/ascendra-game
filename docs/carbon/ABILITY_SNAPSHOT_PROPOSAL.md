# Projeção `CharacterSnapshotV1.equipped_abilities`, Proposta `AbilitySnapshotV1` e Guia de Contratos para o Motor de Combate NEON

## 1. Evolução Compatível de `CharacterSnapshotV1`

Na Session 06, `PostgresCharacterSnapshotReader.getCharacterSnapshot` (`src/modules/characters/application/character-snapshot-query.ts`) passa a preencher `equipped_abilities` dentro da **mesma transação `REPEATABLE READ READ ONLY`** que lê personagem, atributos e equipamentos:
- Preserva 100% do schema `contracts/neon-carbon/character-snapshot.v1.schema.json` (`{ slotIndex, abilityCode, rank }`).
- Projeta **apenas habilidades ativas e elegíveis para uso** (`isEligible === true`), ordenadas canonicamente por `slotIndex ASC`, validando ausência de slots ou códigos duplicados.

---

## 2. Contrato Complementar Proposto: `AbilitySnapshotV1`

- **Implementação:** `PostgresAbilitySnapshotReader` (`src/modules/skills/application/ability-snapshot-query.ts`)
- **JSON Schema:** `contracts/neon-carbon/ability-snapshot.v1.schema.json`
- **Campos que dependem de ratificação conjunta CARBON <-> NEON:** formato final de `gameplay_effect_reference`, catálogo compartilhado de parâmetros em `declarative_passive_params`, política de `effective_competitive_rank` no modo `legacy_ranked_md3` e decisão entre manter endpoint complementar ou consolidar em um futuro `CharacterSnapshotV2`.

---

## 3. Resposta Específica de Contratos para o Futuro Motor de Combate NEON (Seção 44)

1. **Como consultar a build persistente:**
   Consultar `PostgresCharacterSnapshotReader.getCharacterSnapshot(characterId, { principal, normalizationProfile })` para identidade, atributos base/alocados, itens ativos e slots de habilidades elegíveis, e `PostgresAbilitySnapshotReader.getAbilitySnapshot(...)` + `PostgresEquipmentSnapshotReader.getEquipmentSnapshot(...)` quando o simulador precisar de versões de definição, referências de efeito, maestrias e diagnósticos de supressão.
2. **Como identificar habilidades equipadas:**
   Em `CharacterSnapshotV1.equipped_abilities`, todos os itens retornados já estão filtrados para uso imediato (`slotIndex` `0..31`, `abilityCode`, `rank`). Em `AbilitySnapshotV1.equipped_abilities`, filtrar por `is_eligible === true` (slots com `is_eligible === false` trazem `suppression_reason` para UI/telemetria).
3. **Como identificar versões de habilidades:**
   Cada item em `AbilitySnapshotV1.equipped_abilities` informa `ability_definition_version` imutável e `gameplay_effect_reference` (ex.: `neon.ability.sword.rising_slash.v1`), permitindo ao NEON resolver o comportamento exato em seu catálogo Go sem ambiguidade quando existir `v2`.
4. **Como consultar maestria:**
   Ler `AbilitySnapshotV1.weapon_masteries`, ordenado por `weapon_family_code` (22 famílias `WEAPON_SUBCATEGORIES` + `'unarmed'`), contendo `mastery_experience` (string decimal `int64`), `mastery_level` (`1..100`) e `proficiency_rank`. Além disso, cada habilidade equipada já traz `mastery_level` resolvido para a família ativa.
5. **Como resolver requisitos:**
   O CARBON resolve requisitos de aprendizado e de elegibilidade intrínseca usando exclusivamente `base_attributes + allocated_attributes` (sem circularidade com bônus de itens ou passivas). O NEON nunca deve confiar em parâmetros enviados pelo cliente; deve validar custos dinâmicos de combate (mana, stamina, *focus*, *cooldowns*, janelas de *cancel*) em sua própria simulação Go.
6. **Como validar compatibilidade de equipamentos:**
   O CARBON valida `main_hand`/`off_hand` contra `required_weapon_families` e `current_durability > 0` na projeção do snapshot. Caso a durabilidade zere durante uma instância de combate em tempo real no NEON antes do próximo *checkpoint* persistente, o NEON deve suprimir localmente técnicas dependentes daquela arma e emitir `ApplyDurabilityLossCommand` ao CARBON.
7. **Como congelar uma build competitiva (Legacy Ranked MD3):**
   Antes de iniciar uma série MD3, o orquestrador transiciona `characters.competitive_lock_state = 'in_ranked_series'` e lê o par consistente `(build_version, snapshot_version)` com `normalizationProfile = 'legacy_ranked_md3'`. Enquanto bloqueado, Character, Inventory e Skill Engines rejeitam qualquer `equip`, `unequip`, `activateLoadout`, `learn`, `upgrade` ou `respec` com `CharacterCompetitiveLockedError`.
8. **Como conceder XP de maestria autoritativamente:**
   Somente o serviço interno autorizado invocando `SkillEngineService.grantWeaponMasteryExperience` com `AuthorityPrincipal = { kind: 'internal_system_authority', actorId }`, informando `grantId` determinístico, `sourceEventId` único do encontro/evento validado pelo NEON, `weaponFamilyCode`, `sourceType`, `experienceAmount` positivo (`int64`) e `counterpartyCharacterId` opcional.
9. **Como reconhecer retries:**
   Reenviar exatamente o mesmo `grantId` e payload canônico retorna `{ status: 'duplicate_idempotent', duplicate: true }` sem duplicar XP, níveis ou eventos no Outbox. Se o mesmo `grantId` chegar com payload divergente, o Inbox levanta `InboxIdempotencyConflictError`. Se um segundo `grantId` tentar reutilizar o mesmo `(source_event_id, character_id)` em outra família de arma, o banco rejeita com `MasteryAntiFarmingRejectedError`.
10. **Como separar estado persistente e temporário (Genesis Ranked):**
    Toda operação persistente do CARBON e os leitores de snapshot persistentes rejeitam `genesis_ranked_md3_scratch` com `GenesisTemporaryStatePersistenceForbiddenError`. Partidas Genesis devem instanciar `EphemeralGenesisAbilityBuildV1` exclusivamente em memória do NEON referenciando `(abilityCode, abilityDefinitionVersion)` do catálogo, usando o personagem apenas para aparência cosmética.
11. **Como lidar com snapshots de versões diferentes:**
    Se `CharacterSnapshotV1`, `EquipmentSnapshotProposalV1` e `AbilitySnapshotV1` forem lidos em consultas separadas, chamar `assertConsistentCombatSnapshots` (ou comparar `character_id`, `build_version` e `snapshot_version` em Go). Se houver qualquer divergência, descartar o conjunto e refazer a leitura; nunca combinar equipamentos da `build_version = N` com habilidades da `build_version = N + 1`.
12. **Quais efeitos exigem implementação no NEON:**
    Todas as 28 referências `gameplay_effect_ref` (`neon.ability.*`, `neon.passive.*`, `neon.super.*`), incluindo *startup/active/recovery frames*, *hitboxes/hurtboxes*, *hitstun/blockstun*, janelas reativas (`duelist_counter`, `shield_retaliation`), deslocamentos (`shadow_step`, `colossus_charge`), consumo de recursos, *supers* e aplicação determinística dos parâmetros declarativos das 6 passivas.
