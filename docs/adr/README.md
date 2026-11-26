# Architecture Decision Records (ADR Index)

Durante o ciclo inicial paralelo, **NEON** e **CARBON** criaram ADRs independentes com numeração sequencial `0001+` em arquivos distintos. Todos os documentos originais foram preservados integralmente na conciliação de históricos.

A partir do **Ciclo 02 / Session 02**, novos ADRs utilizam prefixos explícitos de domínio (`NEON-XXXX-*`, `CARBON-XXXX-*` ou `JOINT-XXXX-*`) para evitar qualquer ambiguidade numérica.

## Série Inicial NEON (Simulação Determinística & IA em Go)
- [0001-gameplay-backend-runtime.md](0001-gameplay-backend-runtime.md) — Runtime Go 1.27.x (Proposed)
- [0002-deterministic-simulation-boundary.md](0002-deterministic-simulation-boundary.md) — Fronteira determinística e unidades fixed-point (Proposed)
- [0003-neon-carbon-ownership-and-ports.md](0003-neon-carbon-ownership-and-ports.md) — Ownership NEON/CARBON e Ports (Proposed)
- [0004-headless-world-vertical-slice.md](0004-headless-world-vertical-slice.md) — Vertical slice headless de mundo (Proposed)
- [0005-creature-ai-engine.md](0005-creature-ai-engine.md) — Creature AI Engine (Proposed)

## Série Inicial CARBON (Persistência & Consistência em TypeScript + PostgreSQL)
- [0001-modular-monolith-and-stack.md](0001-modular-monolith-and-stack.md) — Stack TypeScript/Node 24 e PostgreSQL real (Accepted — CARBON Session 01)
- [0002-settlement-concurrency-and-idempotency.md](0002-settlement-concurrency-and-idempotency.md) — Concorrência `SELECT FOR UPDATE`, Inbox e Outbox (Accepted — CARBON Session 01)
