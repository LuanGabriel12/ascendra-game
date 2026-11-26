# ADR CARBON-0003 — Fronteira Poliglota Go (NEON) + TypeScript/PostgreSQL (CARBON)

- **Status:** Proposed (Joint Review NEON ↔ CARBON)
- **Data:** 2026-11-26
- **Autor:** CARBON

---

## Contexto

Após a conciliação dos históricos no monorepo `ascendra-game`:
- **NEON** opera a simulação determinística headless, World Director e Creature AI Engine em **Go 1.27.x** (`cmd/sim/`, `internal/`), livre de I/O, relógio de parede e ponto flutuante.
- **CARBON** opera os domínios persistentes autoritativos em **TypeScript estrito (Node.js 24)** com **PostgreSQL 16** (`src/`, `migrations/`, `tests/`).

Ambos coexistem no mesmo repositório como processos independentes de runtime. Interfaces Go (`ports.SettlementReader`, `ports.ContributionSink`) não podem ser invocadas por ponteiro em memória a partir de TypeScript.

---

## Decisão Proposta

1. **Preservação das duas fundações sem reescrita:**
   - NEON permanece em Go; CARBON permanece em TypeScript; PostgreSQL é a única fonte de verdade persistente.
2. **Fronteira de integração independente de linguagem baseada em JSON Schema versionado (`v1`):**
   - Contratos formais em `contracts/neon-carbon/*.schema.json` e vetores compartilhados em `contracts/fixtures/neon-carbon-contract-vectors.json`.
   - Adaptadores explícitos de serialização (`serializeSettlementSnapshotWireV1`, `parseContributionWireJson` / `decodeWireJsonLossless`) garantem fidelidade de tipos sem acoplamento interno.
3. **Sem infraestrutura distribuída prematura:**
   - Não introduzimos Kafka, RabbitMQ, Redis, Kubernetes nem gRPC neste ciclo.
   - O transporte definitivo entre processos (ex.: HTTP/Unix domain socket local autenticado por mTLS/HMAC ou fila persistente futura) será decidido conjuntamente antes de operação em rede real.

---

## Consequências

- **Positivas:** zero retrabalho nas fundações auditadas; testes de contrato determinísticos compartilháveis por `go test` e `npm test`; desacoplamento total entre ticks determinísticos de simulação e latência de disco/transação PostgreSQL.
- **Limitações conhecidas:** até a definição do transporte interprocessos autenticado, a interoperabilidade é exercitada via fixtures JSON canônicas e entrypoints locais de aplicação/CLI (`demo-session-02.ts`).
