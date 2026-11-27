# Handoff CARBON — Session 04 (`carbon/inventory-equipment-engine`)

- **Branch base (Session 03):** `carbon/character-progression-engine` (`8f39621fe4413671d10dfaa46360efcceb824fd3`)
- **Branch da Session 04:** `carbon/inventory-equipment-engine`
- **Data:** 2026-11-27

---

## 1. Entregas da Session 04

1. **Migrações Incrementais `0006` e `0007`:**
   - `0006`: `item_rarities` (7 raridades), `special_effect_definitions` (efeitos passivos declarativos), `affix_definitions` (pools, pesos, tiers, `exclusive_group`), `item_definitions` (versionamento imutável `(definition_code, definition_version)`, 9 categorias, suporte às 22 famílias de armas) e `item_generation_rules`.
   - `0007`: `inventory_containers` (`character_inventory` 40 slots + `personal_storage` 60 slots), `item_instances`, `item_instance_affixes`, `inventory_stacks`, trigger cruzada `fn_enforce_container_slot_integrity`, `equipment_loadouts`, `equipment_loadout_slots`, `item_grants` (`UNIQUE (source_event_id, recipient_character_id, reward_slot_index)`), `item_operation_ledger` (`BIGSERIAL`) e *backfill* seguro para personagens pré-existentes da Session 03.
2. **Gerador Procedural Determinístico (`SplitMix64Rng`) + Simulador Estatístico:**
   - Geração 100% inteira sem ponto flutuante e sem `Math.random`, separando raridade (`common..relic`) de qualidade individual (`quality_bp` `0..10000`) sob orçamento de poder estrito.
   - Catálogo inicial original com 20 definições, 7 raridades, 7 efeitos declarativos e 14 afixos distribuídos em 6 *pools*.
   - Harness estatístico `runStandardSession04Simulations` validado em lotes de `1.000`, `10.000` e `100.000` itens.
3. **Motor Transacional de Inventário, Equipamentos, Loadouts, Durabilidade e Anti-Duping:**
   - 14 slots de combate, suporte completo a armas `two_handed` deslocando `main_hand + off_hand`, requisitos intrínsecos não circulares (`Base + Allocated`), supressão segura de itens quebrados (`durability = 0`) ou pós-*respec*, políticas completas de vinculação (`unbound`, `bind_on_equip`, `bind_on_pickup`, `account_bound`, `character_bound`), transferências concorrentes à prova de duplicação e isolamento *Genesis Ranked*.
4. **Projeções `CharacterSnapshotV1` e `EquipmentSnapshotProposalV1` + Demo de 25 Etapas:**
   - `CharacterSnapshotV1.equippedItems` populado via `REPEATABLE READ READ ONLY` e validado por JSON Schema + Zod, acompanhado de `contracts/neon-carbon/equipment-snapshot.v1.schema.json`.
   - Demonstração reproduzível `npm run demo:session04` (25 etapas completas incluindo restart real do PostgreSQL).

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
```

---

## 3. Pendências de Integração Preservadas (CARBON <-> NEON)

- Autenticação pública/transporte entre processos Go e TypeScript.
- Worker de publicação efetiva do `outbox_events` e *retry* automático de contribuições.
- Identidade persistente de facções invasoras, eventos terminais de cidades e mapeamento `PlayerID <-> CharacterID`.
- Contratos definitivos de combate, interpretação de `special_effect_code` no NEON e normalização competitiva.

---

## 4. Recomendações para Session 05 — Reputation, Bounty, Fame & Titles Engine

1. Modelar reputações por facção/assentamento (`settlements` e `factions` da Session 01) vinculadas a `characters(id)` usando eventos idempotentes e histórico auditável.
2. Estruturar *Bounty* (recompensa por captura/derrota), *Fame* regional/global e *Titles* desbloqueáveis sem conceder poder estatístico oculto obrigatório, preservando mérito competitivo.
3. Integrar conquistas de defesa/libertação de assentamentos (`gameplay_contributions` da Session 02) como fontes autoritativas futuras de fama e títulos quando o vínculo `PlayerID <-> CharacterID` estiver ativo.
