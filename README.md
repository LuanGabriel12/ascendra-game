# ASCENDRA — Real-Time Gameplay Backend Foundation (NEON Cycle 1)

Multiplayer RPG - Ascendra Game

Este repositório contém a fundação técnica inicial do backend de simulação em tempo real do projeto **ASCENDRA**, entregue no **Ciclo 1** sob responsabilidade de **NEON**.

> **Nota importante de identidade:** `NEON` é exclusivamente o nome do papel/desenvolvedor responsável pelo núcleo de simulação de gameplay. Este projeto **não** usa Neon Database nem qualquer serviço externo chamado Neon.

## Objetivo deste ciclo

Provar uma fundação pequena, determinística, headless, autoritativa e desacoplada de persistência/UI/engine gráfica, respeitando estritamente o boundary de ownership entre **NEON** e **CARBON**.

### O que está implementado (Vertical Slice — Prioridade B: World Simulation Harness)

- **Núcleo de simulação determinístico (`internal/simulation`)**:
  - PRNG determinístico com estado serializável (`SplitMix64` — sem `math/rand` global).
  - Serialização canônica e checksum SHA-256 independente de ordem de `map`, ponteiros, timestamps ou logs.
  - Snapshot/restore versionado com validação explícita de schema e invariantes.
- **IA determinística de grupos de criaturas (`internal/ai`)**:
  - Máquina de estados explícita (`Idle`, `Patrol`, `Advance`, `Attack`, `Retreat`, `Dead`).
  - Recebe percepção explicitamente como dados puros (sem estado global oculto).
- **World / Event Director & Motor de Invasões (`internal/world`)**:
  - Máquina de estados explícita de invasão (`Peace -> Threatened -> UnderAttack -> Resolved`), rejeitando transições inválidas.
  - Simulação por ticks lógicos (`uint64`) sem dependência de relógio de parede (`time.Now()`) nem aritmética de ponto flutuante (`float32`/`float64`).
  - Validação autoritativa de contribuição em eventos (`ContributionResult`) com `EventID` estável para idempotência futura.
- **Boundary com o domínio do Carbon (`internal/ports` e `internal/adapters/memory`)**:
  - Interfaces mínimas `SettlementReader` e `ContributionSink`.
  - Adapters in-memory determinísticos + fixtures para testes headless.
  - **Nenhuma** regra de economia, Bounty, reputação, títulos ou persistência de cidades foi implementada pelo NEON.

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
- ADRs:
  - [ADR-0001: Gameplay Backend Runtime (Go 1.27.x — Proposed)](docs/adr/0001-gameplay-backend-runtime.md)
  - [ADR-0002: Deterministic Simulation Boundary & Fixed-Point Units](docs/adr/0002-deterministic-simulation-boundary.md)
  - [ADR-0003: Ownership NEON/CARBON & Contract Strategy](docs/adr/0003-neon-carbon-ownership-and-ports.md)
  - [ADR-0004: Headless World Simulation Vertical Slice](docs/adr/0004-headless-world-vertical-slice.md)
