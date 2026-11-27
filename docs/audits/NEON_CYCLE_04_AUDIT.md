# Auditoria e Recuperação NEON — Ciclo 04 (`neon/world-event-director`)

> **Transparência de autoria e validação:**
> - As seções **1 a 4** preservam integralmente o registro da **auditoria independente executada pelo CODEX** sobre o commit `f757f47` e o trabalho parcial da **Recuperação 04.1** conduzido pelo CODEX antes de atingir seu limite de utilização.
> - A seção **5** registra as **correções, extensões de testes e revalidação completa executadas pelo NEON (Recuperação 04.2)** ao assumir o handover do CODEX. Esta seção constitui **revisão técnica crítica e validação reproduzida pelo próprio NEON**, **não** uma nova auditoria independente por terceiro agente.

---

## 1. Contexto da Auditoria Independente (CODEX — 26/11/2026)

Base auditada: `b133a62` (`neon/dynamic-ecosystem-engine`), entrega inicial do Ciclo 04: `f757f47` (`neon/world-event-director`). Fetch confirmou PRs #1, #2 e #3 abertos, `origin/main` em `57ac839` e CARBON em `origin/carbon/contribution-integration-engine` (`92f2732`). Portas Go anteriores (`internal/ports/carbon.go`) não sofreram alterações.

**Classificação original do CODEX sobre `f757f47`:** `BLOCKED — REQUIRES FIXES`.

## 2. Achados Originais da Auditoria CODEX e Correções 04.1

### Achados P1 identificados pelo CODEX e estado após Recuperação 04.1
1. **P1 — Replay de chave de reserva aposentada (`internal/ecosystem/reservations.go`):**
   - *Causa original:* o anel FIFO `RetiredReservationKeys` descartava chaves antigas ao ultrapassar `MaxRetiredReservationKeys`, permitindo replay; a mitigação intermediária manteve reservas fechadas com chave, mas podia esgotar `MaxReservations`.
   - *Correção CODEX (04.1):* introdução de `CreateSequencedReservation` com sequência contígua atribuída pelo motor (`ordered-reservation:<seq>` vinculada a `ReservationSeq`), validação estrita de `CreatedTick`/`ExpiryTick` em duplicatas, rejeição de sequências duplicadas/fora de ordem/forjadas em `EcosystemState.Validate`, `PruneClosedReservationsExcept` preservando reservas referenciadas e `SnapshotVersion = 5` rejeitando explicitamente snapshots v4 e estados orquestrados contendo chaves legadas arbitrárias.
   - *Validação reportada pelo CODEX:* 2.000 ciclos com `MaxReservations=2`, conservação exata, replay rejeitado pós-restauração e reutilização de uma única vaga de reserva entre campanhas sucessivas.
2. **P1 — Autorização de dono de campanha e facção em comandos de invasão (`internal/world/director.go`):**
   - *Causa original:* `applyDirectorStartInvasion` aceitava grupo ativo de outra campanha e permitia alterar facção preparada; `applyDirectorAbortPreparedInvasion` aceitava `CampaignID` vazio; `SpawnCampaignReinforcement` não validava chamador vivo/pertencente à mesma campanha e reserva.
   - *Correção CODEX (04.1):* guardas estritos em `applyDirectorStartInvasion`, `applyDirectorAbortPreparedInvasion` e `SpawnCampaignReinforcement`, com regressões em `internal/world/commands_test.go`.
3. **P1 — Truncamento silencioso de eventos, perda de follow-up obrigatório e bloqueio de saturação (`internal/worldevents`):**
   - *Causa original:* truncamento silencioso por `MaxEventsPerUpdate`, descarte de follow-up quando `PendingEvents` estava cheio, ausência de filas confirmáveis com recuperação fora de `Step`.
   - *Correção CODEX (04.1):* três filas confirmáveis persistidas em snapshot v5 (`PendingDirectorBatches` com consulta paginada `PendingDirectorEventPage` e `AcknowledgeDirectorBatch`, `PendingOutcomes` com `AcknowledgeTerminalOutcome`, `PendingContributions` com `AcknowledgeContribution`), `reservedFollowupSlots` preservando vaga obrigatória por campanha em voo, `ReleaseCancelledEvents` para recuperação fora de `Step`, rejeição antecipada de `MaxPendingEvents < 2` quando `MaxChainDepth > 0` e `MaxPendingContributions < World.MaxContributions`, além de orçamento de bytes de snapshot verificado em `Step`.
   - *Ponto de interrupção do CODEX:* adaptação final do harness headless como consumidor real das filas e fechamento das pendências de validação após os ajustes finais de admissão e poda.

### Achados P2 / P3 registrados pelo CODEX
- **P2 — Fronteira de confiança e autenticação:** `StepGameplay` rejeita comandos administrativos/diretor, mas `Step`, `StepWithDirector`, `Acknowledge*` e `ReleaseCancelledEvents` são APIs internas privilegiadas sem autenticação de transporte; `Scope` não substitui autenticação externa.
- **P2 — Entrega durável e integração CARBON:** não existe exactly-once distribuído nem persistência PostgreSQL no NEON; confirmação durável, deduplicação em Transactional Inbox e formato de transporte (UUIDv5, strings decimais para `int64`/`uint64`) dependem de acordo com CARBON.
- **P2 — Cobertura de testes adversos:** faltavam testes independentes para equação completa de conservação populacional, snapshots semanticamente inválidos com checksum recalculado, consumidor lento de longa duração e cenários dedicados de consumidor no harness headless.
- **P3 — Cobertura de `internal/world`:** elevou-se de 72,8% para 75,6% com as regressões de guarda de dono.

## 3. Medições Originais Reportadas pelo CODEX (Antes das Correções 04.2)
- Cobertura reportada pelo CODEX em 04.1: `simulation` 100%, `memory` 97,1%, `ports` 96,8%, `ai` 86,5%, `ecosystem` 85,3%, `worldevents` 85,1%, `cmd/sim` 76,8%, `world` 75,6%.
- Fuzzing 60s (2 workers) reportado pelo CODEX antes do último ajuste de poda: `CampaignSchedulerAndCommands` 669.556 execs, `OrchestratedSnapshotDecode` 20.200 execs, `EcosystemCommandsAndInvariants` 1.060.787 execs (+ novo `FuzzOutcomeAcknowledgements`).
- Benchmark sequencial reportado pelo CODEX (3 amostras × 200ms): mediana 3.185 ns/op, 4.577 B/op, 31 allocs/op.

---

## 4. Recuperação 04.2 — Handover Concluído e Validado pelo NEON

### 4.1 Lacunas Identificadas ao Assumir o Handover do CODEX e Correções Aplicadas

1. **Separação explícita entre tamanho de página e limites de armazenamento de lotes (`internal/worldevents/types.go`, `policy.go`, `director.go`):**
   - *Lacuna encontrada:* `MaxEventsPerUpdate` limitava apenas o tamanho da página de leitura, sem limite explícito de eventos por lote único nem limite total de eventos acumulados entre todos os lotes pendentes.
   - *Correção:* adicionados `MaxEventsPerBatch` (default `128`) e `MaxPendingDirectorEvents` (default `1024`), com rejeição antecipada de configurações impossíveis (`MaxPendingDirectorEvents < MaxEventsPerBatch`), validação em `DirectorState.Validate`, `ErrTickEventCapacity` quando um único tick excede o teto por lote e `ErrDirectorBackpressure` (recuperável por drenagem) quando o total acumulado excede `MaxPendingDirectorEvents`. Estendida a guarda de orçamento de snapshot em `Step` também para contribuições enfileiradas (`contributionsEnqueued > 0`). Inicializados slices vazios não-nulos em `NewDirectorState` e `DirectorState.Clone()`.
2. **Validação semântica cross-layer reforçada contra snapshots adulterados (`internal/worldevents/types.go`, `director.go`):**
   - *Lacuna encontrada:* `DirectorState.Validate` e `OrchestratedState.Validate` não validavam `DirectorEventType.Valid()`, ticks futuros em `PendingOutcomes`/`PendingContributions`, limites de comprimento de `EventID` em filas pendentes nem coerência `CampaignActive ↔ World.Invasion.State/CampaignID`.
   - *Correção:* todas essas invariantes adicionadas e testadas com snapshots forjados (`TestSemanticallyInvalidSnapshotsWithRecalculatedChecksumRejected`), provando rejeição por validação semântica (`ErrInvalidState`/`ErrCapacityExceeded`) e não por erro de hash.
3. **Confirmações estritas com detecção de conflito e lote parcial (`internal/worldevents/outcomes.go`):**
   - *Correção:* preservadas todas as APIs originais do CODEX e adicionadas `PendingQueueStats`, `AcknowledgeDirectorBatchVerified(state, seq, expectedEventCount, cfg)`, `AcknowledgeTerminalOutcomeVerified(state, seq, eventID, cfg)` e `AcknowledgeContributionVerified(state, seq, eventID, cfg)`, rejeitando atomicamente confirmações parciais de lote ou com `EventID` conflitante.
4. **Política de admissão calibrada sob consumidor lento (`internal/worldevents/policy.go`, `director.go`):**
   - *Lacuna encontrada:* com `DefaultConfig().MaxPendingContributions == World.MaxContributions == 128`, apenas 1 contribuição pendente pausava toda nova campanha opcional mesmo sob consumidor lento com 127 vagas livres.
   - *Correção:* `DefaultConfig().MaxPendingContributions` calibrado para `256` (`2 × World.MaxContributions`) e `campaignAdmissionError` contabilizando `(inFlightUnresolved + 1)` piores casos de resultados e contribuições. Campanhas independentes progridem normalmente quando há capacidade segura suficiente (até 128 contribuições pendentes em default) e pausam/retomam imediatamente em recuperação parcial quando o limite seguro é cruzado (`TestSlowConsumerAllowsIndependentCampaignWithinSafeBudget`).
5. **Harness headless como consumidor real + 5 cenários dedicados (`internal/worldevents/director.go`, `scenarios.go`, `cmd/sim/main.go`, `main_test.go`):**
   - *Lacuna encontrada:* `RunOrchestrated` lia internamente `PendingDirectorBatches[0]`/`PendingContributions[0]` sem usar `PendingDirectorEventPage` e parava de confirmar se o estado inicial já contivesse pendências; `cmd/sim` ainda não possuía os cenários específicos de modos de consumidor.
   - *Correção:* `RunOrchestrated` migrado para `drainPendingQueuesVerified` usando exclusivamente as APIs públicas (`PendingQueueStats`, `PendingDirectorEventPage`, `PendingTerminalOutcomes`, `PendingContributionResults`, `Acknowledge*Verified`), e adicionados 5 novos cenários no `cmd/sim` preservando os 19 anteriores intactos (24 cenários totais): **J** (consumidor imediato), **K** (consumidor lento com 3 pausas e recuperação), **L** (parcialmente indisponível + snapshot/restore), **M** (saturação 1-lote/1-evento-por-página + restore + retomada) e **N** (reentrega pós-queda + deduplicação de 25 fatos + ack idempotente).

### 4.2 Evidências Reproduzidas pelo NEON Após TODAS as Correções Finais

- **Determinismo estático:** `0` imports de `time`, `math/rand`, `net/` ou `database/sql` em `internal/...`; `0` ocorrências de `float32`/`float64` em arquivos não-teste de `internal/`.
- **Regressão completa (`go1.27.4 windows/amd64`, AMD Ryzen 7 5800X3D, 16 threads):**
  - `go vet ./...`: **PASS**
  - `go build ./...`: **PASS**
  - `git diff --check`: **PASS** (0 erros)
  - `go test -count=1 -cover ./...`: **PASS** (8/8 pacotes):
    - `internal/simulation`: **100,0%**
    - `internal/adapters/memory`: **97,1%**
    - `internal/ports`: **96,8%**
    - `internal/ai`: **86,5%**
    - `internal/ecosystem`: **85,2%**
    - `internal/worldevents`: **85,1%**
    - `cmd/sim`: **77,8%**
    - `internal/world`: **75,6%**
  - `go test -race -count=1 ./...`: **PASS** (0 data races)
  - `go test -shuffle=on -count=10 ./...`: **PASS** (10 execuções embaralhadas, 0 flakes)
  - `go run ./cmd/sim`: **PASS** (24/24 cenários: 4 táticos + 6 ecossistema + 9 World Event Director A–I + 5 Consumer Harness J–N; snapshots v5 verificados em G: 13.137 B, L: 11.415 B, M: 10.864 B, N: 10.883 B)
- **Simulações prolongadas reproduzidas:**
  - `TestSequencedReservationsRemainBoundedAfterTwoThousandCycles`: **PASS** (2.000 ciclos sob `MaxReservations=2`, 0 vazamentos, replay bloqueado pós-snapshot).
  - `TestLongDurationMultiSeedStabilityAndBoundedMemory`: **PASS** (3 seeds × 1.000 epochs = **12.000 ticks**, **78 campanhas** resolvidas; heap pós-GC: baseline `439.648 B`, pico `669.096 B`, final `586.176 B`).
  - `TestLongDurationSlowConsumerWithSmallCapacities`: **PASS** (3 seeds × 800 ticks = **2.400 ticks** sob capacidades reduzidas e consumidor lento: `139` lotes, `15` resultados, `60` contribuições, `36` pausas recuperadas, 0 perdas, 0 duplicatas; heap pós-GC: baseline `628.048 B`, pico `630.400 B`, final `583.984 B`).
  - `TestIndependentPopulationConservationEquationAndAckIsolation`: **PASS** (verificação independente de `Total == Free + Reserved + Materialized` e `P_final == P_initial + births - deaths + immigration - emigration`, além de isolamento completo da população durante falhas e `Acknowledge*`).
- **Fuzzing final de 60 segundos por alvo (16 workers, 0 falhas — 8.947.667 execuções totais):**
  - `FuzzCampaignSchedulerAndCommands` (60s): **2.654.904** execuções (`+14` interessantes, corpus `178`), **0 falhas**.
  - `FuzzOutcomeAcknowledgements` (60s — cobrindo as 3 filas + conflitos verificados): **137.081** execuções (`+101` interessantes, corpus `190`), **0 falhas**.
  - `FuzzOrchestratedSnapshotDecode` (60s): **388.971** execuções (`+77` interessantes, corpus `344`), **0 falhas**.
  - `FuzzEcosystemCommandsAndInvariants` (60s): **5.766.711** execuções (`+20` interessantes, corpus `225`), **0 falhas**.
- **Benchmarks (`-benchmem -count=5`, medianas):** veja tabela completa em [PERFORMANCE_BASELINE.md](../worldevents/PERFORMANCE_BASELINE.md).

## 5. Riscos Remanescentes e Classificação Final

| Severidade | Item | Status / Escopo |
|---|---|---|
| **P0 / P1 (escopo NEON)** | Todos os bloqueios de replay, conservação, truncamento, saturação sem recuperação, dono de invasão e validação de snapshot v5 | **Resolvidos e validados** |
| **P2 (fronteira de transporte / CARBON)** | Autenticação de chamadores nas APIs privilegiadas internas (`Step`, `StepWithDirector`, `Acknowledge*`, `ReleaseCancelledEvents`) e persistência durável PostgreSQL/Inbox/Outbox com contrato acordado (UUIDv5 + strings decimais) | **Fora do escopo headless NEON; documentado em [BACKPRESSURE_AND_RECOVERY.md](../worldevents/BACKPRESSURE_AND_RECOVERY.md) e [NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md](../contracts/NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md)** |
| **P3 (otimização futura)** | `OrchestratedState.Clone()` por tick e `MarshalSnapshot` de verificação de orçamento em ticks com eventos | **Adequado à vertical slice atual; monitorar no Ciclo 05** |

**Classificação técnica final (baseada em evidências reproduzidas na Recuperação 04.2 — revisão própria NEON, não auditoria independente por terceiro):**

`READY FOR CYCLE 05` *(com fronteiras de produção/CARBON explicitamente preservadas e documentadas)*.
