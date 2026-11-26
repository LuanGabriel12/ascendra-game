# NEON — Cycle 04 Engineering Handoff (`neon/world-event-director`)

- **Base auditada:** `b133a62724072d1815c71bcd08c49c3f23a51e00` (`neon/dynamic-ecosystem-engine`, PR #3)
- **Branch atual:** `neon/world-event-director`
- **Pull Request base sugerido:** `neon/dynamic-ecosystem-engine` (enquanto PR #3 ainda não estiver integrado à `main`; não realizar merge automático nem alterar PRs #1, #2 ou #3)
- **Referência CARBON inspecionada (somente leitura):** `origin/feature/carbon-initial-persistence` @ `36ef459423be343b037f1145bb6dd608d0030f52`

---

## 1. Entregas do Ciclo 04

1. **World Event Director & Dynamic Campaign Engine (`internal/worldevents`)**:
   - FSM explícita de 14 estados (`Candidate -> Scheduled -> Reconnaissance -> Preparing -> Warning -> Mobilizing -> Active -> Resolving -> Defended/Captured/Cancelled/Expired -> Recovering -> Completed`) com `ValidateCampaignTransition`, rejeitando transições ilegais, cancelamento após `Active` e reexecução de campanhas terminais.
   - Políticas data-driven divergentes para Goblins (`goblin-raid-campaign`) e Orcs (`orc-warband-campaign`); facções neutras/aliadas (`HostileToSettlement == false`) **nunca** iniciam invasões.
   - Escalonador determinístico baseado em ticks com prioridade inteira separada de `ThreatScore`, anti-starvation aging (`PriorityAgingPerTick`), desempate canônico total, limites de concorrência (`3` globais, `1` por região, `1` por assentamento, máx. `1` combate tático ativo), cooldowns, expiração por deadline, regras de proteção de assentamento e eventos encadeados com teto `MaxChainDepth = 2`.
   - Fato global autoritativo `TerminalSettlementOutcome` emitido estritamente uma vez por invasão resolvida — **inclusive quando `EligibleContributors == 0`**.
2. **Reservas Idempotentes de População em 3 Compartimentos (`internal/ecosystem/reservations.go`)** *(resolve achado P2 da auditoria do Ciclo 03)*:
   - `FreePopulation + ReservedPopulation + MaterializedPopulation` conservados exatamente em `EcosystemState.Validate` e `OrchestratedState.Validate`.
   - `CreateReservation`, `MaterializeFromReservation`, `ReconcileReservationContingent`, `CancelReservation`, `CompleteReservation` e `PruneClosedReservations` com `ReservationID` monotônico, `IdempotencyKey`, `AppliedOps` e `RetiredReservationKeys` limitados.
3. **Autoridade Única de Invasões & Separação de Comandos (`internal/world/commands.go`, `director.go`, `types.go`)**:
   - `world.OrchestrationCampaignDirector` desabilita transições automáticas de invasão por limiar/decaimento em `world.Step` (preservando `OrchestrationLegacyThreat` para regressão dos Ciclos 01–03).
   - `GameplayCommand` / `DirectorCommand` / `AdminCommand` isolados por escopo (`world.ErrUnauthorizedCommand`).
   - IDs monotônicos duráveis (`GroupSeq`, `InvasionSeq`, `CampaignSeq`, `ScheduledEventSeq`, `OutcomeSeq`, `ReservationSeq`) persistidos em snapshots e checksums com proteção contra overflow.
   - Reforços ecológicos via `EventReinforcementRequested` debitados estritamente do buffer reservado da campanha (`SpawnCampaignReinforcement`), mantendo intacto o bloqueio contra criação fantasma de população.
4. **Snapshot v4 (`internal/simulation/snapshot.go`)**:
   - `SnapshotVersion = 4` (rejeitando explicitamente `v1`, `v2`, `v3`), enforcement pré-decodificação de `MaxSnapshotBytes` e validação cross-layer completa.
5. **Harness Headless CLI (`cmd/sim`)**:
   - Todos os 10 cenários anteriores (4 táticos + 6 ecossistema) preservados intactos + **9 cenários novos do Ciclo 04 (A–I)** com logs estruturados `log/slog` e verificação de equivalência mid-campaign em Snapshot v4 (`Scenario G`).

---

## 2. Evidências Reais de Verificação

- **Determinismo estático:** `0` imports de `time`, `math/rand`, `net/` ou `database/sql` em `internal/`; `0` usos de `float32`/`float64` em arquivos não-teste de `internal/`.
- **Build, Vet, Race e Shuffle:** `go vet ./...`, `go build ./...`, `go test -race -count=1 ./...`, `go test -shuffle=on -count=10 ./...`, `go run ./cmd/sim` e `git diff --check` **100% verdes**.
- **Cobertura (`go test -count=1 -cover ./...`)**:
  - `internal/simulation`: **100,0%**
  - `internal/adapters/memory`: **97,1%**
  - `internal/ports`: **96,8%**
  - `internal/ai`: **86,5%**
  - `internal/ecosystem`: **85,3%** *(alvo ≥ 85% atingido)*
  - `internal/worldevents`: **85,1%** *(alvo ≥ 85% atingido)*
  - `internal/world`: **72,8%**
  - `cmd/sim`: **76,8%**
- **Longa duração multi-seed:** `3` seeds × `1.000` epochs (`12.000` ticks, `78` campanhas resolvidas) com heap retido estável (`438.936 B -> 423.992 B`, pico `461.776 B`).
- **Fuzzing (30s por alvo, 0 falhas):** `2.496.055` execuções totais (`368.013` em `FuzzCampaignSchedulerAndCommands`, `288.422` em `FuzzOrchestratedSnapshotDecode`, `1.839.620` em `FuzzEcosystemCommandsAndInvariants`).
- **Benchmarks (`-count=5`, Ryzen 7 5800X3D):** `EvaluateCandidates` **9,75 µs**, `ReservationLifecycle` **10,82 µs**, `CampaignProgressionStep` **93,68 µs**, `OrchestratedStepIntegrated` **121,84 µs**, `OrchestratedSnapshotRoundTrip` **490,65 µs** (~12,9 KB).

---

## 3. Fronteira com CARBON e Próximos Passos

- Nenhum arquivo TypeScript/PostgreSQL do CARBON foi modificado; `internal/ports/carbon.go` não sofreu breaking changes.
- Proposta de contratos alinhada ao `AscendraSharedEventEnvelopeV1` e `SettlementCaptured` já publicados pelo CARBON (`36ef459`) documentada em [NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md](../contracts/NEON_WORLD_EVENT_CONTRACT_PROPOSAL.md).
- Próximo passo natural após auditoria CODEX: **Ciclo 05** (sistema completo de combate técnico, bosses e cerco / evolução espacial 2D) + alinhamento conjunto com CARBON sobre o adapter de borda de eventos (UUIDv5 + strings decimais).
