# ASCENDRA — Real-Time Gameplay Backend Foundation (NEON Cycles 01–05)

Multiplayer RPG - Ascendra Game

Este repositório contém a fundação técnica, o motor de IA de criaturas, o motor de ecossistema regional dinâmico, o World Event Director & Campaign Engine e o Invasion, Siege & Settlement Battle Engine do backend de simulação em tempo real do projeto **ASCENDRA**, sob responsabilidade de **NEON**.

> **Nota importante de identidade:** `NEON` é exclusivamente o nome do papel/desenvolvedor responsável pelo núcleo de simulação de gameplay. Este projeto **não** usa Neon Database nem qualquer serviço externo chamado Neon.

## O que está implementado

### Ciclo 01 — Fundação Headless Determinística (Auditada — `9d7cd2c`)
- **Núcleo de simulação determinístico (`internal/simulation`)**:
  - PRNG determinístico com estado serializável (`SplitMix64` — sem `math/rand` global).
  - Serialização canônica e checksum SHA-256 independente de ordem de `map`, ponteiros, timestamps ou logs.
  - Snapshot/restore versionado (`SchemaVersion = 5`) com limite pré-decodificação de bytes (`MaxBytes`) e validação explícita de schema e invariantes (versões `v1`/`v2`/`v3`/`v4` rejeitadas com `ErrUnsupportedSnapshotVersion`).
- **World / Event Director & Motor de Invasões (`internal/world`)**:
  - Máquina de estados explícita de invasão (`Peace -> Threatened -> UnderAttack -> Resolved`), rejeitando transições inválidas.
  - Simulação por ticks lógicos (`uint64`) sem dependência de relógio de parede (`time.Now()`) nem aritmética de ponto flutuante (`float32`/`float64`).
  - Validação autoritativa de contribuição em eventos (`ContributionResult`) com `EventID` estável para idempotência futura.
- **Boundary com o domínio do Carbon (`internal/ports` e `internal/adapters/memory`)**:
  - Interfaces mínimas `SettlementReader` e `ContributionSink`, testadas com fakes in-memory determinísticos.
  - **Nenhuma** regra de economia, Bounty, reputação, títulos ou persistência de cidades foi implementada pelo NEON.

### Ciclo 02 — Creature AI Engine (Auditado — `349fe69`)
- **Perfis de goblins e orcs (`internal/ai/profiles.go`)**: `goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster`, `orc-berserker`, `orc-vanguard`, `orc-warchief` em inteiros/fixed-point.
- **Percepção e seleção tipada de alvos (`internal/ai/targeting.go`)**: `TargetRef{Kind, ID}`, alcance de visão (`VisionRange`), alerta coletivo (`AlertRange`), retenção de alvo (`TargetMemoryTicks`), pesos táticos diferenciados e desempate canônico.
- **Coordenação coletiva otimizada (`internal/ai/coordination.go`)**: índice espacial 1D + somas de prefixo + busca binária (`O(G log G)`), aura de moral de comandantes, `FocusTarget`, `Rally` e `FlankWeak`.
- **Moral, territorialidade e reforços (`internal/ai/policy.go`, `internal/world/director.go`)**: quebra de moral + histerese de reagrupamento, choque explícito de morte de comandante (`CommanderFallen`), retorno por leash territorial (`StateReturnHome`), reforços com cooldown e limites explícitos de capacidade.

### Ciclo 03 — Dynamic Ecosystem & Population Simulation Engine (Auditado — `b133a62`)
- **Simulação em duas escalas (`internal/ecosystem` + `internal/world/ecosystem_bridge.go`)**: ticks táticos (Escala A) integrados a epochs ecológicos (Escala B, padrão `20 ticks/epoch`) com fonte única de verdade (`FreePopulation` + `MaterializedPopulation`).
- **3 regiões conectadas (fixtures)**: Vale de Valewatch, Floresta de Thornveil e Fronteira de Ironfang.
- **Modelo populacional discreto inteiro**: logística com `K`, acumuladores seriais de resíduos, `K == 0` seguro e zero geração espontânea de populações extintas.
- **Recursos naturais conservados**: `Food`, `Wood`, `Stone`, `Ore`, `Water` com consumo proporcional conservado ao inteiro exato e regeneração limitada.
- **Acampamentos dinâmicos, migração em duas fases, competição territorial e ameaça regional com histerese**.
- **Materialização controlada e limpeza de entidades**: reconciliação única de baixas/sobreviventes sem duplicação nem ressurreição, limpeza pós-retenção liberando `MaxActiveGroups = 32` e anel FIFO `RetiredGroupIDs`.

### Ciclo 04 — World Event Director & Dynamic Campaign Engine (`neon/world-event-director`)
- **World Event Director & Campaign Engine (`internal/worldevents`)**: transforma alterações ecológicas em campanhas dinâmicas determinísticas com FSM explícita de 14 estados (`Candidate -> Scheduled -> Reconnaissance -> Preparing -> Warning -> Mobilizing -> Active -> Resolving -> Defended/Captured/Cancelled/Expired -> Recovering -> Completed`), políticas data-driven para Goblins e Orcs, regras de proteção de assentamento e eventos encadeados com teto `MaxChainDepth`.
- **Escalonador determinístico baseado em ticks**: prioridade inteira separada da ameaça ecológica, envelhecimento anti-starvation (`PriorityAgingPerTick`), desempate canônico total, cooldowns e limites de concorrência (3 globais, 1 por região, 1 por assentamento, máx. 1 combate tático ativo).
- **Reservas sequenciais idempotentes de população em 3 compartimentos (`internal/ecosystem/reservations.go`)**: `Free + Reserved + Materialized` com sequência contígua (`CreateSequencedReservation`), `PruneClosedReservationsExcept`, poda `O(1)` imune a replay antigo e zero ressurreição.
- **Filas confirmáveis e backpressure recuperável (`internal/worldevents/outcomes.go`)**: lotes de eventos do diretor paginados (`PendingDirectorEventPage`, `MaxEventsPerBatch`, `MaxPendingDirectorEvents`), fila de resultados terminais (`PendingOutcomes`) e fila de contribuições (`PendingContributions`) com `Acknowledge*` e `Acknowledge*Verified` fora de `Step`.
- **Autoridade única de invasões e separação de comandos (`internal/world/commands.go`)**: `OrchestrationCampaignDirector` desabilita transições automáticas de ameaça em `world.Step`; `GameplayCommand` / `DirectorCommand` / `AdminCommand` isolados por escopo (`ErrUnauthorizedCommand`) com validação estrita de dono/facção/chamador.
- **Reforços ecológicos com débito real e Fato Global com Zero Jogadores**: `EventReinforcementRequested` debitado exclusivamente da reserva da campanha; `TerminalSettlementOutcome` emitido estritamente uma vez mesmo quando `EligibleContributors == 0`.
- **Snapshot v5 (`OrchestratedState`) e 24 cenários headless em `cmd/sim`**: 4 táticos + 6 ecossistema + 9 World Event Director (A–I) + 5 cenários de consumidor headless (J–N).

### Ciclo 05 — Invasion, Siege & Settlement Battle Engine (`neon/invasion-siege-engine`)
- **Siege Engine puro e acíclico (`internal/siege`)**: grafo determinístico de 8 zonas conectadas com bloqueio de portão/muralha e proteção anti-teletransporte, layouts provisórios data-driven (`layout-valewatch-bastion`, `layout-ironford-citadel`), 5 estruturas defensivas ativas (`Gate`, `Wall`, `Tower`, `SupplyDepot`, `Citadel`), dano inteiro/fixed-point com armadura/resistência e brecha em muralha (`<= 50%` HP).
- **Autoridade tática única & Fonte única de verdade (`internal/world/siege_integration.go`)**: `WorldState.Siege` integrado a `world.Step`; `SettlementDefenseHP == Siege.TotalStructureHP()` verificado em `Validate()`; 9 fases explícitas de cerco (`Approach -> Assault -> Breach -> DistrictCombat -> CitadelAssault -> Resolving -> Defended | Captured | Withdrawn`) mapeadas sem quebra para `ports.InvasionOutcome`.
- **Objetivos autoritativos, distritos, suprimentos e reparação limitada**: `CmdCompleteObjective` valida condições reais do mundo em modo cerco; captura de distritos com histerese; suprimentos táticos finitos (`AllowDestroyedStructureRepairInBattle = false`); `CmdPlayerRepairStructure` e `CmdMoveDefenderZone` com contribuição efetiva sem overheal.
- **Comandantes, ondas conservadas na população e defensores NPCs**: `Skarv, o Rompe-Portões` (goblin) e `Ghorvak, Punho de Ferro` (orc) vinculados 1-para-1 a `CreatureGroup` reais; ondas `SiegeWave` debitadas de `CreateSequencedReservation`/`MaterializeFromReservation`; 5 papéis NPCs (`Guard`, `GateDefender`, `Archer`, `GuardCaptain`, `RepairUnit`) sem emissão de `ContributionResult`.
- **Liveness de backpressure (`MinEventsPerBatch`), ocupação/reconquista e Snapshot v6**: `SnapshotVersion = 6` rejeitando v1–v5; `OccupiedSettlements` + reconquista simplificada na mesma infraestrutura; **34 cenários headless** em `cmd/sim` (24 anteriores + 10 cercos A–J).

## Pré-requisitos

- Go `1.27.x` (default reversível documentado em [ADR-0001](docs/adr/0001-gameplay-backend-runtime.md))
- Compilador C (ex.: `gcc` / MinGW-W64 no Windows) para executar o `-race` detector

## Comandos reprodutíveis

```powershell
# Executar toda a suíte de testes unitários, determinismo, snapshot/restore e contratos
go test -v ./...

# Executar com race detector (verifica ausência de shared mutable state e data races)
go test -race ./...

# Executar fuzzing com tempo limitado e reproduzível
go test '-fuzz=^FuzzCampaignSchedulerAndCommands$' '-fuzztime=30s' '-run=^$' ./internal/worldevents
go test '-fuzz=^FuzzOrchestratedSnapshotDecode$' '-fuzztime=30s' '-run=^$' ./internal/worldevents
go test '-fuzz=^FuzzEcosystemCommandsAndInvariants$' '-fuzztime=30s' '-run=^$' ./internal/ecosystem

# Executar benchmarks de baseline (custo por tick, allocations, checksum e tamanho de snapshot)
go test '-run=^$' '-bench=.' -benchmem -count=5 ./internal/worldevents

# Executar o harness headless CLI (34 cenários determinísticos + verificação de snapshot/restore)
go run ./cmd/sim
```

## Estrutura do projeto

```text
cmd/sim/                        Harness CLI headless com logs estruturados (log/slog) — 34 cenários
internal/ports/                 Interfaces de fronteira NEON <-> CARBON
internal/adapters/memory/       Fakes in-memory e fixtures determinísticas para testes
internal/simulation/            PRNG determinístico, checksum canônico SHA-256 e snapshots v6
internal/ai/                    Política determinística de IA de grupos hostis (FSM + 1D O(G log G))
internal/siege/                 Siege Engine: grafo de zonas, estruturas, brechas, objetivos, distritos, fases, ondas
internal/ecosystem/             Motor de ecossistema regional, populações, recursos, acampamentos e reservas idempotentes
internal/world/                 World Director tático, Invasion FSM, integração de cerco, comandos e contribuições
internal/worldevents/           World Event Director, Campaign FSM, escalonador, filas confirmáveis e cenários A-N + Cercos A-J
docs/OWNERSHIP.md               Matriz de ownership NEON / CARBON / A confirmar
docs/OBSERVABILITY.md           Schema de logs estruturados e métricas futuras
docs/adr/                       Architecture Decision Records (status Proposed até alinhamento)
docs/contracts/                 Propostas de contratos NEON -> CARBON
docs/siege/                     Documentação técnica do Ciclo 5 (Siege Engine, Layouts, Estruturas, Objetivos, Baseline)
docs/worldevents/               Documentação técnica do Ciclo 4 (Diretor, Campanhas, Escalonador, Reservas, Baseline)
docs/handoff/                   Notas de handoff por ciclo
```

## Documentação de arquitetura e colaboração

- [Ownership NEON / CARBON](docs/OWNERSHIP.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [NEON → CARBON Contract Request](docs/contracts/NEON_TO_CARBON_CONTRACT_REQUEST.md)
- [Handoff do Ciclo 1](docs/handoff/NEON_CYCLE1_HANDOFF.md)
- [Handoff do Ciclo 2](docs/handoff/NEON_CYCLE2_HANDOFF.md)
- [Handoff do Ciclo 3](docs/handoff/NEON_CYCLE3_HANDOFF.md)
- [Handoff do Ciclo 4](docs/handoff/NEON_CYCLE4_HANDOFF.md)
- [Handoff do Ciclo 5](docs/handoff/NEON_CYCLE5_HANDOFF.md)
- [Auditoria CODEX — Ciclo 1](docs/audits/NEON_CYCLE_01_AUDIT.md)
- [Auditoria CODEX — Ciclo 2](docs/audits/NEON_CYCLE_02_AUDIT.md)
- [Auditoria CODEX — Ciclo 3](docs/audits/NEON_CYCLE_03_AUDIT.md)
- [Auditoria & Recuperação 04.2 — Ciclo 4](docs/audits/NEON_CYCLE_04_AUDIT.md)
- [Proposta de Contratos de Ecossistema (NEON → CARBON)](docs/contracts/NEON_ECOSYSTEM_CONTRACT_PROPOSAL.md)
- [Proposta de Contratos de World Events (NEON → CARBON)](docs/contracts/NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md)
- [Proposta de Contratos de Cerco (NEON → CARBON)](docs/contracts/NEON_SIEGE_CONTRACT_PROPOSAL.md)
- Documentação do Ecossistema (Ciclo 3):
  - [Ecosystem Engine](docs/ecosystem/ECOSYSTEM_ENGINE.md)
  - [Population Model](docs/ecosystem/POPULATION_MODEL.md)
  - [Resource Dynamics](docs/ecosystem/RESOURCE_DYNAMICS.md)
  - [Territory & Migration](docs/ecosystem/TERRITORY_AND_MIGRATION.md)
  - [Performance Baseline](docs/ecosystem/PERFORMANCE_BASELINE.md)
- Documentação do World Event Director (Ciclo 4):
  - [World Event Director](docs/worldevents/WORLD_EVENT_DIRECTOR.md)
  - [Campaign Engine](docs/worldevents/CAMPAIGN_ENGINE.md)
  - [Event Scheduler](docs/worldevents/EVENT_SCHEDULER.md)
  - [Population Reservations](docs/worldevents/POPULATION_RESERVATIONS.md)
  - [Backpressure & Recovery](docs/worldevents/BACKPRESSURE_AND_RECOVERY.md)
  - [Performance Baseline (Ciclo 4)](docs/worldevents/PERFORMANCE_BASELINE.md)
- Documentação do Siege Engine (Ciclo 5):
  - [Siege Engine](docs/siege/SIEGE_ENGINE.md)
  - [Settlement Layout & Zone Graph](docs/siege/SETTLEMENT_LAYOUT.md)
  - [Structures, Damage & Repair](docs/siege/STRUCTURES_AND_DAMAGE.md)
  - [Strategic Objectives & Districts](docs/siege/SIEGE_OBJECTIVES.md)
  - [Commanders, Waves & NPC Defenders](docs/siege/COMMANDERS_AND_WAVES.md)
  - [Performance Baseline (Ciclo 5)](docs/siege/PERFORMANCE_BASELINE.md)
- ADRs:
  - [ADR-0001: Gameplay Backend Runtime (Go 1.27.x — Proposed)](docs/adr/0001-gameplay-backend-runtime.md)
  - [ADR-0002: Deterministic Simulation Boundary & Fixed-Point Units](docs/adr/0002-deterministic-simulation-boundary.md)
  - [ADR-0003: Ownership NEON/CARBON & Contract Strategy](docs/adr/0003-neon-carbon-ownership-and-ports.md)
  - [ADR-0004: Headless World Simulation Vertical Slice](docs/adr/0004-headless-world-vertical-slice.md)
  - [ADR-0005: Creature AI Engine (Proposed)](docs/adr/0005-creature-ai-engine.md)
  - [NEON-ADR-0006: Dynamic Ecosystem Engine, Safe Snapshots v3 & 1D Spatial Coordination (Proposed)](docs/adr/NEON-ADR-0006-dynamic-ecosystem-engine.md)
  - [NEON-ADR-0007: World Event Director, Campaign Engine, Idempotent Population Reservations & Snapshot v4 (Proposed)](docs/adr/NEON-ADR-0007-world-event-director.md)
  - [NEON-ADR-0008: Invasion, Siege & Settlement Battle Engine, Single Tactical Authority & Snapshot v6 (Proposed)](docs/adr/NEON-ADR-0008-invasion-siege-engine.md)
