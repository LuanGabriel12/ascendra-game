# NEON-ADR-0007: World Event Director, Campaign Engine, Idempotent Population Reservations e Snapshot v4

- **Status**: `Proposed` (aguarda auditoria independente CODEX e alinhamento de transporte com CARBON)
- **Data**: 2026-11-26
- **Owner**: NEON
- **Identificador exclusivo**: `NEON-ADR-0007` (prefixo `NEON-` garantindo ausência de colisão com ADRs do CARBON)

## Contexto

Ao final do Ciclo 03 (`b133a62`), o ASCENDRA possuía:
- Motor tático de invasões e IA de criaturas (`internal/world` + `internal/ai`), com coordenação espacial `O(G log G)` e teto `MaxActiveGroups = 32`;
- Motor de ecossistema regional (`internal/ecosystem`), com populações abstratas, recursos conservados, acampamentos dinâmicos, migração e ameaça regional com histerese.

Porém faltava a ponte estratégica autoritativa entre ecologia e eventos jogáveis, e a auditoria do Ciclo 03 (`NEON_CYCLE_03_AUDIT.md`) destacou riscos residuais importantes:
1. Tickets agregados de materialização sem identidade única (`ReservationID`) permitiam risco teórico de reaplicação/contaminação cruzada em integrações concorrentes (P2);
2. Existência de dois potenciais gatilhos de invasão caso o novo diretor coexistisse com as transições automáticas por `RegionalThreat` em `world.Step`;
3. Mistura de comandos de gameplay de jogadores e comandos administrativos/fixture no mesmo tipo `world.Command`;
4. Ausência de emissão explícita de fato global terminal quando `0` jogadores participam de uma invasão;
5. Necessidade de IDs monotônicos duráveis para campanhas, reservas, eventos agendados, invasões e grupos táticos, persistidos em snapshot.

## Decisão

1. **Novo pacote `internal/worldevents` (Camada Orquestradora Acíclica)**:
   - Consome `internal/simulation`, `internal/ports`, `internal/ai`, `internal/ecosystem` e `internal/world` sem ciclos de dependência e sem I/O/rede/DB/ponto flutuante.
   - Implementa `CampaignState` FSM explícita de 14 estados com `ValidateCampaignTransition`, proibindo saltos arbitrários, cancelamento após `Active` e reexecução de campanhas terminais.
   - Implementa políticas data-driven para Goblins (`goblin-raid-campaign`) e Orcs (`orc-warband-campaign`), filtrando estritamente facções `HostileToSettlement == true`.
   - Implementa escalonador determinístico baseado em ticks com prioridade separada da ameaça ecológica, envelhecimento anti-starvation (`PriorityAgingPerTick`), desempate canônico total, limites de concorrência (3 globais planejadas, 1 por região, 1 por assentamento, máx. 1 combate tático ativo), cooldowns, regras de proteção de assentamento e profundidade máxima de eventos encadeados (`MaxChainDepth`).
2. **Reservas Idempotentes de População em 3 Compartimentos (`internal/ecosystem/reservations.go`)**:
   - Introduz `ReservedPopulation` ao lado de `FreePopulation` e `MaterializedPopulation`.
   - `PopulationReservation` com `ReservationID` monotônico (`ReservationSeq`), `IdempotencyKey`, `AppliedOps` ordenados e `RetiredReservationKeys` limitados após poda (`PruneClosedReservations`).
   - Operações `CreateReservation`, `MaterializeFromReservation`, `ReconcileReservationContingent`, `CancelReservation` e `CompleteReservation` garantindo idempotência, isolamento entre reservas e zero ressurreição.
3. **Autoridade Única de Invasões e Separação de Comandos (`internal/world/commands.go`, `director.go`)**:
   - `world.OrchestrationMode`: `OrchestrationCampaignDirector` desabilita transições automáticas por limiar/decaimento de ameaça em `world.Step`; `OrchestrationLegacyThreat` preserva integralmente os testes de regressão dos Ciclos 01–03.
   - Separação estrita `GameplayCommand` (`ScopeGameplay`) / `DirectorCommand` (`ScopeDirector`) / `AdminCommand` (`ScopeAdmin`), rejeitando comandos fora do escopo com `world.ErrUnauthorizedCommand`.
   - `EventReinforcementRequested` para grupos vinculados em modo `CampaignDirector`: o Diretor valida acampamento, limites e debita do buffer pré-reservado antes de chamar `world.SpawnCampaignReinforcement`, preservando integralmente o bloqueio contra criação fantasma de população.
4. **Fato Global `TerminalSettlementOutcome` Independente de Jogadores**:
   - Emitido estritamente uma vez por invasão resolvida — inclusive quando `EligibleContributors == 0` — e alinhado em proposta de contrato com `AscendraSharedEventEnvelopeV1` e `SettlementCaptured` já publicados pelo CARBON (`36ef459`).
5. **Snapshot v4 (`simulation.SnapshotVersion = 4`)**:
   - Quebra explícita e intencional de formato (`v1`, `v2`, `v3` rejeitados com `ErrUnsupportedSnapshotVersion`), mantendo enforcement pré-decodificação de `MaxSnapshotBytes` e adicionando validação cross-layer de conservação em `OrchestratedState.Validate`.

## Alternativas Consideradas

- **Manter gatilho automático de `RegionalThreat` em `world.Step` em paralelo ao Diretor**: descartada; criaria dupla autoridade, condições de corrida lógicas e campanhas órfãs sem `CampaignID`/`ReservationID`.
- **Evoluir `IntegratedState` sem criar `internal/worldevents`**: descartada; acoplaria escalonamento de campanhas e FSM estratégica dentro do pacote tático `internal/world`, violando coesão e dificultando evolução futura.
- **Persistir campanhas concluídas infinitamente em `DirectorState.Campaigns`**: descartada; causaria crescimento linear ilimitado de RAM e tamanho de snapshot em simulações de longa duração. O arquivamento em anel FIFO limitado (`CompletedHistory`, `TerminalOutcomes`) + `PruneClosedReservations` + poda de cooldowns expirados garante memória retida `O(1)`.
- **Adicionar stubs de eventos lendários/climáticos sem comportamento real**: descartada; `EventCategory` e `CampaignPolicyTemplate` já permitem extensão limpa por dados sem código morto.

## Consequências

- **Positivas**: eliminação do risco P2 do Ciclo 03 (reservas idempotentes com conservação provada em 3 compartimentos), autoridade única clara para invasões, separação defensiva de comandos de jogador vs diretor vs admin, fato terminal confiável com 0 jogadores e memória retida estável ao longo de milhares de epochs.
- **Negativas / Trade-offs**: quebra intencional de compatibilidade de snapshots antigos (`v3 -> v4`, sem migrador); o motor tático atual continua suportando no máximo 1 arena de combate ativo por assentamento por vez (multi-arena paralela fica para ciclos futuros).

## Reversibilidade

**Alta** para políticas de campanha, pesos de prioridade, cadências e limites operacionais; **Média** para o contrato de `SnapshotVersion = 4` e interface `StepInput`/`OrchestratedState`.

## Questões Abertas

1. Alinhamento com CARBON sobre `SettlementThreatened` / `SettlementInvasionStarted` vs `SettlementStateChanged`, UUIDv5 determinístico na borda e strings decimais para `uint64`/`int64` em JSON.
2. Quando o Ciclo 05 introduzir combate completo, bosses e cerco, como o `CampaignPolicyTemplate` incorporará fases de cerco e estágios de boss sem violar a separação entre World Event Director e Tactical Combat Engine?
3. Política definitiva de justiça para comandos concorrentes de jogadores no mesmo tick antes da exposição em rede competitiva.
