# NEON — Cycle 04 & Recovery 04.2 Engineering Handoff (`neon/world-event-director`)

- **Base auditada:** `b133a62724072d1815c71bcd08c49c3f23a51e00` (`neon/dynamic-ecosystem-engine`, PR #3)
- **Branch atual:** `neon/world-event-director`
- **Pull Request base sugerido:** `neon/dynamic-ecosystem-engine` (enquanto PR #3 ainda não estiver integrado à `main`)
- **Referência CARBON inspecionada (somente leitura):** `origin/feature/carbon-initial-persistence` (`36ef459`) e `origin/carbon/contribution-integration-engine` (`92f2732`, observada na auditoria)

---

## 1. Entregas do Ciclo 04 + Recuperação 04.1 (CODEX) + Recuperação 04.2 (NEON)

1. **World Event Director & Dynamic Campaign Engine (`internal/worldevents`)**:
   - FSM explícita de 14 estados com `ValidateCampaignTransition`, políticas data-driven para Goblins e Orcs, regras de proteção de assentamento e follow-ups obrigatórios com vaga reservada (`reservedFollowupSlots`).
   - Escalonador determinístico baseado em ticks com anti-starvation aging, desempate canônico total, limites de concorrência, `ReleaseCancelledEvents` fora de `Step` e admissão calibrada sob consumidor lento (`campaignAdmissionError` com `MaxPendingContributions = 256 = 2 × World.MaxContributions`).
   - Três filas confirmáveis duráveis em estado (`PendingDirectorBatches` paginado via `PendingDirectorEventPage`, `PendingOutcomes`, `PendingContributions`) com `Acknowledge*` e `Acknowledge*Verified` (rejeição de conflito e lote parcial), `MaxEventsPerBatch = 128`, `MaxPendingDirectorEvents = 1024` e orçamento de bytes de snapshot verificado antes de commitar.
   - Fato global autoritativo `TerminalSettlementOutcome` emitido estritamente uma vez — **inclusive quando `EligibleContributors == 0`**.
2. **Reservas Sequenciais Idempotentes em 3 Compartimentos (`internal/ecosystem/reservations.go`)**:
   - `CreateSequencedReservation` com sequência contígua vinculada a `ReservationSeq`, namespace `ordered-reservation:<seq>`, `PruneClosedReservationsExcept` protegendo reservas referenciadas e rejeição de replay antigo com memória `O(1)`.
3. **Autoridade Única de Invasões, Guardas de Dono & Separação de Comandos (`internal/world`)**:
   - `OrchestrationCampaignDirector`, `GameplayCommand`/`DirectorCommand`/`AdminCommand`, e guardas de dono/facção/chamador em `applyDirectorStartInvasion`, `applyDirectorAbortPreparedInvasion` e `SpawnCampaignReinforcement`.
4. **Snapshot v5 (`internal/simulation/snapshot.go`)**:
   - `SnapshotVersion = 5` (rejeitando `v1`–`v4` e reservas legadas arbitrárias em estado orquestrado), pré-checagem de `MaxSnapshotBytes` e validação semântica cross-layer completa.
5. **Harness Headless CLI (`cmd/sim`)**:
   - 19 cenários anteriores preservados intactos (4 táticos + 6 ecossistema + 9 World Event Director A–I) + **5 cenários de consumidor headless (J–N)** cobrindo consumidor imediato, lento, parcialmente indisponível, recuperado e com reentrega/deduplicação (harness de dev em memória, não persistência de produção).

---

## 2. Evidências Reais de Verificação (Recuperação 04.2 — Pós-Correções Finais)

- **Determinismo estático:** `0` imports proibidos (`time`, `math/rand`, `net/`, `database/sql`) e `0` `float32`/`float64` em `internal/` (não-teste).
- **Regressão completa:** `go vet`, `go build`, `go test -race -count=1`, `go test -shuffle=on -count=10`, `go run ./cmd/sim` (24/24 cenários) e `git diff --check` **100% verdes**.
- **Cobertura (`go test -count=1 -cover ./...`)**:
  - `internal/simulation`: **100,0%** | `internal/adapters/memory`: **97,1%** | `internal/ports`: **96,8%** | `internal/ai`: **86,5%** | `internal/ecosystem`: **85,2%** | `internal/worldevents`: **85,1%** | `cmd/sim`: **77,8%** | `internal/world`: **75,6%**.
- **Simulações prolongadas:** 2.000 ciclos sequenciais (`MaxReservations=2`), 12.000 ticks multi-seed (78 campanhas, heap final `586.176 B`) e 2.400 ticks sob consumidor lento e capacidades pequenas (36 pausas recuperadas, heap final `583.984 B`).
- **Fuzzing (60s por alvo, 16 workers, 0 falhas — 8.947.667 execuções totais):**
  - `FuzzCampaignSchedulerAndCommands`: `2.654.904` | `FuzzOutcomeAcknowledgements`: `137.081` | `FuzzOrchestratedSnapshotDecode`: `388.971` | `FuzzEcosystemCommandsAndInvariants`: `5.766.711`.
- **Benchmarks (`-count=5`, Ryzen 7 5800X3D):** detalhes completos em [PERFORMANCE_BASELINE.md](../worldevents/PERFORMANCE_BASELINE.md).

---

## 3. Fronteira com CARBON e Próximos Passos

- Nenhum arquivo TypeScript/PostgreSQL do CARBON foi modificado; `internal/ports/carbon.go` preservado intacto.
- Documentação de filas confirmáveis e acoplamento futuro a Transactional Inbox/Outbox em [BACKPRESSURE_AND_RECOVERY.md](../worldevents/BACKPRESSURE_AND_RECOVERY.md) e [NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md](../contracts/NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md).
- Branch preparada para o próximo ciclo: `neon/invasion-siege-engine` (Cycle 05 — Invasion & Siege Engine).
