# Handoff CARBON — Session 03 (`carbon/character-progression-engine`)

- **Branch base (Session 02):** `carbon/contribution-integration-engine` (`92f2732315fc4be0bd59d507f402c3ae2589372b`)
- **Branch da Session 03:** `carbon/character-progression-engine`
- **Data:** 2026-11-26

---

## 1. Entregas da Session 03

1. **Migrações Incrementais `0004` e `0005`:**
   - `playable_peoples` (26 povos cadastrados; 6 habilitados com orçamento equivalente `standard_100`), `lineages` (FK composta `(race_code, lineage_code)`), `cultures` (desacopladas de raça), `backgrounds` (10 origens) e `progression_rules`.
   - `accounts`, `characters` (`UNIQUE (canonical_name)` e conservação `allocated + unspent = earned`), `character_appearance`, `character_attributes`, `experience_grants` e `character_build_history` (`UNIQUE (character_id, build_version)`).
2. **`CharacterEngineService` Transacional e Concorrente:**
   - Criação de conta e múltiplos personagens por conta, normalização Unicode `NFC`/`NFKD` e proteção contra nomes reservados/invisíveis.
   - Alocação dos 10 atributos fundamentais, 9 *presets* de classes emergentes, *respec* auditado com bloqueio em série competitiva ativa (`in_ranked_series`) e concessão autoritativa idempotente de XP em `BigInt`.
   - Bloqueio estrutural contra persistência de builds/XP temporários do modo *Genesis Ranked*.
3. **`CharacterSnapshotV1` + Simulador de Progressão + Demonstração de 20 Etapas:**
   - Projeção somente leitura validada por JSON Schema e Zod (`contracts/neon-carbon/character-snapshot.v1.schema.json`).
   - Harness `runProgressionSimulationHarness` (`src/modules/characters/simulation/progression-simulator.ts`).
   - Demonstração headless executável `npm run demo:session03` (20 etapas, incluindo Goblin Paladino, Orc Arcanista, Draconiana Agricultora/Mercadora e restart real do PostgreSQL).

---

## 2. Comandos de Reprodução

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run demo:session02
npm run demo:session03
```

---

## 3. Recomendações para Session 04 — Inventory & Equipment Engine

1. Modelar `item_definitions` (catálogo versionado) separado de `item_instances` (instâncias únicas com durabilidade/afixos futuros e `owner_character_id` referenciando `characters(id)`).
2. Implementar containers e *loadouts* persistentes com prevenção de duplicação de itens via constraints `UNIQUE` de slot equipado `(character_id, loadout_id, slot_code)` e ledger de transferência atômica.
3. Preencher `equipped_items` em `CharacterSnapshotV1` a partir do *loadout* ativo sem quebrar a versão `v1` do contrato.
4. Manter inventário temporário do *Genesis Ranked* em estrutura efêmera isolada das tabelas de inventário do mundo aberto.
