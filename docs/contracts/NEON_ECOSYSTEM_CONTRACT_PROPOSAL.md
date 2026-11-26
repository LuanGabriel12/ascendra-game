# NEON → CARBON ECOSYSTEM CONTRACT PROPOSAL (Cycle 03)

**Status:** `Proposed — Draft for Joint Review` (NÃO congelado unilateralmente; contratos existentes em `internal/ports/carbon.go` permanecem intactos)  
**Origem:** NEON (Go 1.27.4 — Simulação Autoritativa Determinística)  
**Destino:** CARBON (TypeScript / Node.js / PostgreSQL — Persistência, Economia, Reputação, Bounty, Inbox/Outbox)

---

## 1. Contexto e diferenças de plataforma reconhecidas

O CARBON já opera em `feature/carbon-initial-persistence` com TypeScript, PostgreSQL, Zod, JSON Schema e Transactional Inbox/Outbox. Diferenças estruturais conhecidas que precisam de acordo explícito antes de integrar transporte real:

| Aspecto | NEON (Go) | CARBON (TypeScript/PostgreSQL) | Mitigação Proposta (a acordar) |
|---|---|---|---|
| Identificadores | `string` estável (`region-valewatch-vale`) | `UUID` nos contratos persistentes | Tabela/mapa de referência ou adoção de UUID determinístico (UUIDv5) na camada de adapter |
| Inteiros 64-bit | `int64` / `uint64` | JS `number` seguro apenas até `2^53 - 1` | Serializar inteiros 64-bit potencialmente grandes (ex.: `tick`, `epoch`, `event_seq`, acumulados) como **strings decimais** em JSON ou usar Protobuf |
| Tempo | `tick` / `epoch` lógicos (`uint64`) | Timestamps persistentes (`timestamptz`) | NEON emite `tick`/`epoch` + `event_id` determinístico; camada de ingestão/CARBON registra `recorded_at` no banco |
| Semântica de entrega | Eventos determinísticos com `event_id` estável | Transactional Inbox/Outbox idempotente | Deduplicação estrita por `event_id` no Inbox do CARBON |

---

## 2. Projeções propostas (somente leitura ou handoff assíncrono — sem prescrever schema SQL)

### 2.1 `RegionSnapshot` (CARBON → NEON bootstrap opcional)
- `region_id`, `biome`, `carrying_capacity`, `adjacent_region_ids[]`, `has_settlement`, `settlement_id?`.

### 2.2 `FactionSnapshot` (CARBON → NEON bootstrap opcional)
- `faction_id`, `hostile_to_settlement`, `default_stance`, `relations[]` (`target_faction_id`, `stance`).

### 2.3 `PopulationSnapshot` (NEON → CARBON projeção resumida)
- `population_id`, `region_id`, `species_id`, `family_id`, `faction_id`, `free_population`, `materialized_population`, `carrying_capacity`, `scarcity_bp`, `active_camp_count`, `epoch`.

### 2.4 `CampSnapshot` (NEON → CARBON projeção resumida)
- `camp_id`, `region_id`, `faction_id`, `family_id`, `population_id`, `state`, `capacity`, `threat_contribution`, `epoch`.

### 2.5 `SettlementDefenseSnapshot` (CARBON ↔ NEON)
- Extensão futura opcional sobre `SettlementSnapshot` existente (`settlement_id`, `region_id`, `defense_state`, `max_defense_hp`), mantendo compatibilidade total com o contrato do Ciclo 01.

### 2.6 `WorldEventResult` (NEON → CARBON entrega idempotente futura)
- `event_id` (chave de idempotência para Inbox), `simulation_id`, `region_id`, `event_type` (ex.: `RegionalThreatCritical`, `CampDestroyed`, `SettlementOutcome`), `epoch` (string decimal em JSON), `tick` (string decimal em JSON), `summary` mínimo.

---

## 3. O que NÃO atravessa a fronteira automaticamente

- Micro-flutuações internas de recursos ecológicos a cada epoch (`ResourceDepleted` / `ResourceRegenerated` internos não representam estoque comercial nem economia do CARBON).
- Estados intermediários de ticks táticos e resíduos fracionários internos (`GrowthResidualBP`, `MortalityResidualBP`).

## 4. Questões abertas para CARBON

1. CARBON aprova serialização de `uint64`/`int64` críticos como strings decimais no envelope JSON (validado por Zod/JSON Schema), ou prefere Protobuf desde a primeira integração?
2. Para IDs de região/facção/acampamento, adotamos UUIDv5 determinístico derivado dos slugs do NEON ou um campo `external_key` no domínio do CARBON?
3. Quais projeções acima CARBON deseja receber na Session 03 (após fechar `Settlement` + `Contribution` na Session 02)?
