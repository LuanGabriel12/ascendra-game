# Deterministic World Event Scheduler — ASCENDRA (NEON Cycle 04)

## 1. Separação entre Eventos Agendados e Fatos Emitidos

Para eliminar ambiguidade de domínio e garantir contratos limpos com o CARBON:
- **`ScheduledEvent`** (`DirectorState.PendingEvents`): intenção futura pendente na fila do escalonador (`EventID`, `ScheduledTick`, `DeadlineTick`, `Priority`, `AgeTicks`, `ChainDepth`, `Cancelled`).
- **`DirectorEvent`** (`StepOutput.DirectorEvents`): fato histórico imutável já ocorrido em um tick específico (`EventID`, `Tick`, `Type`, `CampaignID`, `TerminalOutcome?`).

## 2. Prioridade de Agendamento vs Ameaça Ecológica

`ThreatScore` (escala `[0, MaxRegionalThreat]`) mede pressão ecológica da região; `Priority` (`int64`) mede a urgência operacional do escalonador (`computeCandidatePriority` em `internal/worldevents/policy.go`):

```text
Priority = ThreatScore
         + min(FreePopulation * 2, 800)
         + min(Camp.Capacity + Camp.Reserves, 400)
         + (FactionInfluenceBP * Template.PriorityWeightTerritory) / 10000
         + AdjacencyBonus (250 mesma regiao, 150 adjacente, 0 distante)
         + Template.PriorityWeightLeadership
         + CriticalBonus (200 se ThreatLevel == Critical)
```

Toda aritmética utiliza soma segura (`safeAddInt64`) sem ponto flutuante.

## 3. Envelhecimento Anti-Starvation (`effectivePriority`)

Quando um evento devido (`Tick >= ScheduledTick`) é bloqueado por limite de concorrência ou cooldown, o escalonador incrementa `AgeTicks++` (com saturação segura em `MaxUint64`). A prioridade efetiva usada na ordenação é:

```text
EffectivePriority = clampInt64(Priority + AgeTicks * PriorityAgingPerTick)
```

Com `PriorityAgingPerTick = 5` (default), eventos de menor prioridade base acumulam prioridade determinística enquanto aguardam liberação de slot, impedindo starvation crônico por facções mais fortes.

## 4. Ordenação e Desempate Canônico Total

Eventos devidos são ordenados por:
1. Maior `EffectivePriority` (descendente);
2. Menor `ScheduledTick` (ascendente);
3. Menor `EventID` lexicograficamente (ascendente — chave única monotônica).

## 5. Limites Operacionais e Concorrência

| Limite (`worldevents.Config`) | Default | Garantia |
|---|---:|---|
| `MaxActiveCampaignsGlobal` | `3` | Teto global de campanhas planejadas/ativas em voo |
| `MaxActiveCampaignsPerRegion` | `1` | No máximo 1 campanha em voo por região |
| `MaxActiveCampaignsPerSettlement` | `1` | No máximo 1 campanha em voo por assentamento |
| Combate tático simultâneo | `1` (hard) | `DirectorState.Validate` proíbe `> 1` campanha em `Active`/`Resolving` |
| `MaxPendingEvents` | `32` | Fila limitada contra backpressure/explosão de RAM |
| `MaxCandidatesPerUpdate` | `16` | Limite por ciclo de avaliação |
| `MaxChainDepth` | `2` | Impede cadeias infinitas de eventos |
| `MaxEventsPerUpdate` | `64` | Limite de eventos por página da consulta do lote de um tick (`PendingDirectorEventPage`); um tick pode conter várias páginas |
| `MaxEventsPerBatch` | `128` | Teto rígido de eventos emitidos por um único lote de tick |
| `MaxPendingDirectorEvents` | `1024` | Teto rígido de eventos armazenados somados entre todos os lotes pendentes (`>= MaxEventsPerBatch`) |
| `MaxPendingDirectorBatches` | `256` | Teto de lotes pendentes aguardando confirmação |
| `MaxPendingOutcomes` | `64` | Teto de resultados terminais aguardando confirmação |
| `MaxPendingContributions` | `256` | Teto de contribuições aguardando confirmação (`2 × World.MaxContributions`) |
| `MaxCompletedHistory` / `MaxOutcomesHistory` | `64` / `64` | Retenção histórica consultiva em anel FIFO limitado (não é fila de entrega) |
| `MaxCooldownEntries` | `64` | Cooldowns expirados podados a cada tick |

## 6. Validação de Deadlines e Expiração

- `EnqueueScheduledEvent` rejeita `DeadlineTick < ScheduledTick` com `ErrInvalidCommand`, `ChainDepth > MaxChainDepth` com `ErrCapacityExceeded` e `ScheduledEventSeq == MaxUint64` com `ErrNumericOverflow`.
- Eventos pendentes com `Tick > DeadlineTick` são removidos deterministicamente emitindo `DirEventCampaignExpired`.
- Eventos com `Cancelled == true` são descartados na varredura seguinte sem disparar campanhas.
