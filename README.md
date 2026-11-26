# ASCENDRA — Real-Time Gameplay Backend Foundation (NEON Cycles 01 & 02)

Multiplayer RPG - Ascendra Game

Este repositório contém a fundação técnica e o motor de IA de criaturas do backend de simulação em tempo real do projeto **ASCENDRA**, sob responsabilidade de **NEON**.

> **Nota importante de identidade:** `NEON` é exclusivamente o nome do papel/desenvolvedor responsável pelo núcleo de simulação de gameplay. Este projeto **não** usa Neon Database nem qualquer serviço externo chamado Neon.

## O que está implementado

### Ciclo 01 — Fundação Headless Determinística (Auditada — `9d7cd2c`)
- **Núcleo de simulação determinístico (`internal/simulation`)**:
  - PRNG determinístico com estado serializável (`SplitMix64` — sem `math/rand` global).
  - Serialização canônica e checksum SHA-256 independente de ordem de `map`, ponteiros, timestamps ou logs.
  - Snapshot/restore versionado (`SchemaVersion = 2`) com validação explícita de schema e invariantes.
- **World / Event Director & Motor de Invasões (`internal/world`)**:
  - Máquina de estados explícita de invasão (`Peace -> Threatened -> UnderAttack -> Resolved`), rejeitando transições inválidas.
  - Simulação por ticks lógicos (`uint64`) sem dependência de relógio de parede (`time.Now()`) nem aritmética de ponto flutuante (`float32`/`float64`).
  - Validação autoritativa de contribuição em eventos (`ContributionResult`) com `EventID` estável para idempotência futura.
- **Boundary com o domínio do Carbon (`internal/ports` e `internal/adapters/memory`)**:
  - Interfaces mínimas `SettlementReader` e `ContributionSink`, testadas com fakes in-memory determinísticos.
  - **Nenhuma** regra de economia, Bounty, reputação, títulos ou persistência de cidades foi implementada pelo NEON.

### Ciclo 02 — Creature AI Engine (`neon/creature-ai-engine`)
- **Perfis de goblins e orcs (`internal/ai/profiles.go`)**: `goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster`, `orc-vanguard`, `orc-warchief` em inteiros/fixed-point.
- **Percepção e seleção de alvos (`internal/ai/targeting.go`)**: alcance de visão (`VisionRange`), alerta coletivo (`AlertRange`), pesos táticos diferenciados (goblins oportunistas em alvos feridos; orcs confrontacionais em ameaça/objetivo) e desempate canônico.
- **Coordenação coletiva (`internal/ai/coordination.go`)**: aura de moral de comandantes, foco coordenado (`FocusTarget`), reagrupamento (`Rally`) e flanqueamento de matilha (`FlankWeak`).
- **Moral, territorialidade e reforços (`internal/ai/policy.go`, `internal/world/director.go`)**: quebra de moral + histerese de reagrupamento, retorno por leash territorial (`StateReturnHome`), reforços com cooldown e limites explícitos de capacidade (`MaxActiveGroups`, `MaxReinforcementWaves`, `MaxDefenders`, `MaxObjectives`, `MaxContributions`), além de ordenação canônica de comandos no mesmo tick (`CanonicalizeCommands`).

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
go test -fuzz=FuzzSnapshotDecode -fuzztime=3s ./internal/simulation
go test -fuzz=FuzzCommandValidation -fuzztime=3s ./internal/world

# Executar benchmarks de baseline (custo por tick, allocations, checksum e tamanho de snapshot)
go test '-run=^$' '-bench=.' -benchmem ./internal/world

# Executar o harness headless CLI (cenários determinísticos + verificação de snapshot/restore)
go run ./cmd/sim
```

## Estrutura do projeto

```text
cmd/sim/                        Harness CLI headless com logs estruturados (log/slog)
internal/ports/                 Interfaces de fronteira NEON <-> CARBON
internal/adapters/memory/       Fakes in-memory e fixtures determinísticas para testes
internal/simulation/            PRNG determinístico, checksum canônico SHA-256 e snapshots
internal/ai/                    Política determinística de IA de grupos hostis (FSM)
internal/world/                 World Director, Invasion FSM, validação de contribuição e harness
docs/OWNERSHIP.md               Matriz de ownership NEON / CARBON / A confirmar
docs/OBSERVABILITY.md           Schema de logs estruturados e métricas futuras
docs/adr/                       Architecture Decision Records (status Proposed até alinhamento)
docs/contracts/                 NEON -> CARBON Contract Request
docs/handoff/                   Notas de handoff do Ciclo 1
```

## Documentação de arquitetura e colaboração

- [Ownership NEON / CARBON](docs/OWNERSHIP.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [NEON → CARBON Contract Request](docs/contracts/NEON_TO_CARBON_CONTRACT_REQUEST.md)
- [Handoff do Ciclo 1](docs/handoff/NEON_CYCLE1_HANDOFF.md)
- [Handoff do Ciclo 2](docs/handoff/NEON_CYCLE2_HANDOFF.md)
- [Auditoria CODEX — Ciclo 1](docs/audits/NEON_CYCLE_01_AUDIT.md)
- ADRs:
  - [ADR-0001: Gameplay Backend Runtime (Go 1.27.x — Proposed)](docs/adr/0001-gameplay-backend-runtime.md)
  - [ADR-0002: Deterministic Simulation Boundary & Fixed-Point Units](docs/adr/0002-deterministic-simulation-boundary.md)
  - [ADR-0003: Ownership NEON/CARBON & Contract Strategy](docs/adr/0003-neon-carbon-ownership-and-ports.md)
  - [ADR-0004: Headless World Simulation Vertical Slice](docs/adr/0004-headless-world-vertical-slice.md)
  - [ADR-0005: Creature AI Engine (Goblins, Orcs, Coordenação, Moral, Territorialidade e Reforços — Proposed)](docs/adr/0005-creature-ai-engine.md)
