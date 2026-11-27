# NEON — Cycle 05 Engineering Handoff (`neon/invasion-siege-engine`)

- **Base validada (Recovery 04.2 — revisão própria NEON, não auditoria independente):** `b0a2088bfa23f57eb5ada1958d8b7ce3911a7099` (`neon/world-event-director`)
- **Branch de trabalho:** `neon/invasion-siege-engine`
- **Referência CARBON inspecionada (somente leitura):** `origin/carbon/contribution-integration-engine` (`92f2732`) e `origin/carbon/character-progression-engine` (`8f39621`)
- **Contratos preservados intactos:** [internal/ports/carbon.go](../../internal/ports/carbon.go) sem modificações; nenhum arquivo TypeScript/PostgreSQL alterado.

---

## 1. Resumo das Entregas do Ciclo 05

1. **Novo Pacote Acíclico `internal/siege`** ([NEON-ADR-0008](../adr/NEON-ADR-0008-invasion-siege-engine.md)):
   - Grafo determinístico de 8 zonas conectadas com regras explícitas de acessibilidade (`AlwaysOpen`, `RequiresStructureCompromised`, `DefenderOnly`) e bloqueio anti-teletransporte (`CanTraverse`, `NextStepToward`, `ZoneHopDistance`).
   - Layouts provisórios data-driven (`DefaultValewatchLayout` = `1000` HP, `DefaultIronfordLayout` = `1500` HP, `LookupProvisionalLayout`) preservando paridade exata com `ports.SettlementSnapshot.MaxDefenseHP`.
   - 5 estruturas defensivas ativas (`Gate`, `Wall`, `Tower`, `SupplyDepot`, `Citadel`) com dano inteiro/fixed-point (128-bit seguro contra overflow), brecha em muralha (`<= 50%` HP), fogo de torre com alcance em hops e perda imediata de bônus/regeneração ao destruir o Depósito de Suprimentos.
   - 9 fases explícitas de cerco (`Approach -> Assault -> Breach -> DistrictCombat -> CitadelAssault -> Resolving -> Defended | Captured | Withdrawn`) subordinadas à única autoridade tática (`world.Step`).
   - 10 objetivos estratégicos autoritativos (5 Defesa + 5 Invasão) com pré-requisitos acíclicos e verificação rigorosa do estado do mundo em `CmdCompleteObjective` (fim da conclusão cega por ID em cerco).
   - Captura territorial de distritos com histerese (`DistrictHysteresisTicks = 3`), suprimentos táticos finitos e reparação limitada (`AllowDestroyedStructureRepairInBattle = false`).
   - Comandantes táticos (`Skarv, o Rompe-Portões` goblin; `Ghorvak, Punho de Ferro` orc — nomes provisórios) vinculados 1-para-1 a `CreatureGroup` reais conservados na população, ondas populacionais (`SiegeWave`), e 5 funções de defensores NPCs (`Guard`, `GateDefender`, `Archer`, `GuardCaptain`, `RepairUnit`) que nunca emitem `ContributionResult`.
2. **Eliminação de Bloqueio Permanente por `ErrTickEventCapacity` (`internal/worldevents`)**:
   - `MinEventsPerBatch(cfg)` verificado antecipadamente em `Config.Validate()` + reserva obrigatória de margem para eventos mandatórios + limitação determinística de operações opcionais por tick.
3. **Ocupação, Reconquista Simplificada e Snapshot v6**:
   - `DirectorState.OccupiedSettlements` (`siege.OccupationRecord`) + extensões opcionais em `TerminalSettlementOutcome` + reconquista demonstrada sobre a **mesma** infraestrutura `SiegeEngine` usando novos IDs monotônicos (`CampaignID`, `InvasionID`) sem reusar IDs antigos.
   - `simulation.SnapshotVersion = 6` rejeitando explicitamente v1–v5 e snapshots semanticamente inválidos mesmo com checksum recalculado.
4. **34 Cenários Headless no `cmd/sim`**:
   - Todos os 24 cenários anteriores (4 táticos + 6 ecossistema + 9 Director A–I + 5 Consumer J–N) preservados 100% verdes + **10 novos cenários de cerco A–J**.

---

## 2. Evidências Reproduzidas Pós-Edições Finais (Revisão Própria NEON)

- **Determinismo estático:** `0` imports proibidos (`time`, `math/rand`, `net/`, `database/sql`) e `0` `float32`/`float64` em `internal/` (não-teste).
- **Suites obrigatórias:** `go vet ./...`, `go build ./...`, `git diff --check`, `go test -count=1 ./...`, `go test -race -count=1 ./...`, `go test -shuffle=on -count=10 ./...`, `go run ./cmd/sim` (34/34 cenários) — **100% PASS**.
- **Cobertura (`go test -count=1 -cover ./...`)**:
  - `internal/simulation`: **100,0%** | `internal/adapters/memory`: **97,1%** | `internal/ports`: **96,8%** | `internal/ai`: **86,5%** | **`internal/siege`: 85,8%** | `internal/ecosystem`: **85,1%** | **`internal/worldevents`: 85,0%** | `cmd/sim`: **78,8%** | `internal/world`: **76,8%**.
- **Fuzzing (6 alvos × 60s, 16 workers):** **16.173.290** execuções totais, **0 falhas/panics**.
- **Benchmarks (`-benchmem -count=5`):** detalhes em [PERFORMANCE_BASELINE.md](../siege/PERFORMANCE_BASELINE.md).

---

## 3. Recomendações para Próximo Ciclo (Cycle 06 — Combat Engine)

1. Introduzir o núcleo de combate competitivo (atributos, hitboxes, frame data, estados de ação, cancelamentos, parry e resoluções determinísticas 2D) integrando-se sobre `Zone.PositionHint` / futuras coordenadas 2D sem quebrar o grafo de zonas nem a autoridade única de `world.Step`.
2. Manter a fronteira limpa com o `CharacterSnapshot` proposto pelo CARBON (`origin/carbon/character-progression-engine`).
3. Submeter a branch `neon/invasion-siege-engine` à auditoria independente do **CODEX** antes de integração final.
