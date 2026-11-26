# ASCENDRA — Gameplay Simulation (NEON) & Persistent Domains (CARBON)

Multiplayer RPG — **ASCENDRA**

Este repositório reúne os dois componentes de backend do projeto **ASCENDRA**, desenvolvidos com fronteiras explícitas de *ownership* e contratos independentes de linguagem:

- **NEON (`Go` — `cmd/sim/`, `internal/`)**: núcleo determinístico headless de simulação de mundo em tempo real, World/Event Director, motor de invasões, validação autoritativa de contribuições e Creature AI Engine.
- **CARBON (`TypeScript` / `PostgreSQL` — `src/`, `migrations/`, `tests/`)**: persistência transacional autoritativa de cidades (`Settlement`), facções (`Faction`), memória histórica, contribuições persistidas, inbox/outbox transacional e domínios sociais/econômicos.
- **Contratos Compartilhados (`contracts/`, `docs/contracts/`)**: especificações e schemas versionados entre simulação e persistência.
- **Pesquisa & Prototipação (`notebooks/Ascendra_Development.ipynb`)**: caderno de desenvolvimento preservado da `main`.

> **Nota importante de identidade:** `NEON` é exclusivamente o identificador da frente de engenharia responsável pela simulação em tempo real — este projeto **não** utiliza Neon Database nem qualquer serviço externo homônimo.

---

## 1. Fundação NEON (Go — Cycles 01 & 02)

### Ciclo 01 — Fundação Headless Determinística (`9d7cd2c`)
- **Núcleo de simulação determinístico (`internal/simulation`)**: PRNG serializável (`SplitMix64`), serialização canônica e checksum SHA-256, snapshots versionados (`SchemaVersion = 2`).
- **World / Event Director & Motor de Invasões (`internal/world`)**: FSM explícita (`Peace -> Threatened -> UnderAttack -> Resolved`), ticks lógicos (`uint64`) sem `time.Now()` nem ponto flutuante, emissão de `ContributionResult` com `EventID` estável.
- **Ports para CARBON (`internal/ports`, `internal/adapters/memory`)**: interfaces `SettlementReader` e `ContributionSink` com fakes determinísticos em memória.

### Ciclo 02 — Creature AI Engine (`349fe69`)
- **Perfis inteiros (`internal/ai/profiles.go`)**: `goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster`, `orc-vanguard`, `orc-warchief`.
- **Percepção, seleção e coordenação (`internal/ai/`)**: `VisionRange`, `AlertRange`, `LeashRadius`, aura de moral de comandantes, ordens `FocusTarget` / `Rally` / `FlankWeak`, quebra de moral + histerese e ondas limitadas de reforço.
- **Limites de capacidade e ordenação canônica (`internal/world/`)**: `CanonicalizeCommands`, entidades `DefenderEntity` e tetos explícitos (`MaxActiveGroups`, `MaxReinforcementWaves`, `MaxDefenders`, `MaxObjectives`, `MaxContributions`).

### Comandos Reprodutíveis — NEON (Go `1.27.x`)

```powershell
go test -v ./...
go test -race ./...
go test -fuzz=FuzzSnapshotDecode -fuzztime=3s ./internal/simulation
go test -fuzz=FuzzCommandValidation -fuzztime=3s ./internal/world
go test '-run=^$' '-bench=.' -benchmem ./internal/world
go run ./cmd/sim
```

---

## 2. Fundação CARBON (TypeScript & PostgreSQL)

### Session 01 — Persistência Transacional de Assentamentos
- **Agregados `Faction` e `Settlement` (`src/modules/`)**: estados de ciclo de vida (`peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`), histórico auditável (`settlement_history`), deduplicação via inbox (`processed_events`) e outbox transacional (`outbox_events`).
- **Concorrência e Integridade Relacional (`migrations/`)**: `SELECT ... FOR UPDATE` por linha, incremento monotônico de `version`, `PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY` e `CHECK` diretamente no PostgreSQL.
- **Testes de Integração com PostgreSQL Real (`tests/`)**: executa contra `postgres:16-alpine` via `DATABASE_URL` (Docker/CI) ou inicia automaticamente um servidor PostgreSQL nativo real (`embedded-postgres`) localmente.

### Comandos Reprodutíveis — CARBON (Node.js `22+` / `24 LTS`)

```powershell
npm ci
npm run typecheck
npm test
npm run build

# Opcional — migrações manuais contra banco via DATABASE_URL / Docker Compose:
docker compose up -d
npm run migrate:up
npm run migrate:status
npm run migrate:down
```

---

## 3. Estrutura Integrada do Repositório

```text
cmd/sim/                        [NEON] Harness CLI headless com logs estruturados
internal/ports/                 [NEON] Interfaces Go de fronteira NEON <-> CARBON
internal/adapters/memory/       [NEON] Fakes in-memory determinísticos
internal/simulation/            [NEON] PRNG determinístico, checksum SHA-256 e snapshots
internal/ai/                    [NEON] Creature AI Engine (percepção, moral, coordenação)
internal/world/                 [NEON] World Director, Invasion FSM e validação de contribuições
src/modules/                    [CARBON] Bounded contexts persistentes (factions, settlements, ...)
src/shared/                     [CARBON] Pool transacional PostgreSQL, migrator, contratos e logger
migrations/                     [CARBON] Migrações SQL versionadas (.up.sql / .down.sql)
tests/                          [CARBON] Testes de integração contra PostgreSQL real
contracts/                      [SHARED] Schemas JSON e fixtures entre linguagens
docs/                           [SHARED] Ownership, ADRs, auditorias, contratos e handoffs
notebooks/                      [SHARED] Notebook de desenvolvimento da main
```

---

## 4. Documentação de Arquitetura e Colaboração

- Ownership: [docs/OWNERSHIP.md](docs/OWNERSHIP.md) e [docs/architecture/ownership-matrix.md](docs/architecture/ownership-matrix.md)
- Observabilidade NEON: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)
- Contratos: [NEON → CARBON Contract Request](docs/contracts/NEON_TO_CARBON_CONTRACT_REQUEST.md) e schemas em `contracts/events/`
- Handoffs: [NEON Cycle 01](docs/handoff/NEON_CYCLE1_HANDOFF.md), [NEON Cycle 02](docs/handoff/NEON_CYCLE2_HANDOFF.md), [CARBON Session 01](docs/handoff/carbon-session-01.md)
- Auditorias: [NEON Cycle 01 Audit](docs/audits/NEON_CYCLE_01_AUDIT.md), [NEON Cycle 02 Audit](docs/audits/NEON_CYCLE_02_AUDIT.md)
- Índice de ADRs: [docs/adr/README.md](docs/adr/README.md)
