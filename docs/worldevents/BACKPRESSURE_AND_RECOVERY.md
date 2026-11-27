# Backpressure, Confirmable Queues & Recovery — ASCENDRA (Cycle 04.1 / 04.2)

Este documento consolida a arquitetura final das filas confirmáveis, paginação, política de admissão, reservas sequenciais, compatibilidade de snapshots **v5** e integração futura com o CARBON, combinando o trabalho da Recuperação 04.1 (CODEX) com as correções e validações concluídas pelo NEON na Recuperação 04.2.

---

## 1. Causa Raiz dos Bloqueios Anteriores (`BLOCKED — REQUIRES FIXES`)

Na entrega inicial `f757f47`, a auditoria independente identificou quatro bloqueios estruturais de *safety* e *liveness*:
1. **Descarte silencioso e ausência de confirmação:** eventos excedendo `MaxEventsPerUpdate` eram truncados e `TerminalOutcomes` era apenas um anel histórico sem garantia de entrega.
2. **Saturação irrecuperável:** ao rejeitar ticks quando uma fila enchia, não existia operação confiável fora de `Step` para consultar, confirmar e liberar capacidade, podendo travar permanentemente a progressão.
3. **Colisão entre reservas legadas e limite de chaves aposentadas:** chaves arbitrárias externas não permitem deduplicação permanente com memória finita; retê-las fechadas podia esgotar `MaxReservations`.
4. **Capacidade de follow-up obrigatório disputada com admissão opcional:** eventos opcionais podiam encher `PendingEvents` e impedir o agendamento obrigatório pós-resolução.

---

## 2. Taxonomia de Dados e Filas Confirmáveis

O motor diferencia estritamente cinco categorias que **não** são tratadas como equivalentes:

| Categoria | Estrutura (`DirectorState`) | Semântica | Liberação |
|---|---|---|---|
| **Fatos de evento do diretor (lote por tick)** | `PendingDirectorBatches` (`DirectorBatchSeq` / `DirectorBatchAckSeq`) | Entrega obrigatória paginada (`PendingDirectorEventPage`) | Somente via `AcknowledgeDirectorBatch` ou `AcknowledgeDirectorBatchVerified` |
| **Fato global terminal de invasão** | `PendingOutcomes` (`OutcomeSeq` / `OutcomeAckSeq`) | Entrega obrigatória (mesmo com 0 jogadores) | Somente via `AcknowledgeTerminalOutcome` ou `AcknowledgeTerminalOutcomeVerified` |
| **Contribuição individual de jogador** | `PendingContributions` (`ContributionSeq` / `ContributionAckSeq`) | Entrega obrigatória para CARBON | Somente via `AcknowledgeContribution` ou `AcknowledgeContributionVerified` |
| **Trabalho futuro agendado** | `PendingEvents` | Não é entrega; possui vagas reservadas para follow-ups obrigatórios | Despacho no escalonador, expiração ou `ReleaseCancelledEvents` fora de `Step` |
| **Histórico diagnóstico consultivo** | `CompletedHistory`, `TerminalOutcomes` | Anel FIFO limitado apenas para inspeção local; **não** é fila de entrega | Poda automática pelo teto histórico |

**Regras invariantes das filas confirmáveis:**
- Consultar (`PendingDirectorEventPage`, `PendingTerminalOutcomes`, `PendingContributionResults`, `PendingQueueStats`) retorna cópias defensivas e **nunca** remove fatos.
- Todas as operações de confirmação (`Acknowledge*`) são fronteiras internas confiáveis — **jamais** acessíveis por `GameplayCommand` de jogador — e operam fora de `Step`, permitindo recuperação mesmo com `Step` bloqueado.
- Nenhuma operação `Acknowledge*` altera qualquer compartimento populacional (`Free`, `Reserved`, `Materialized`).

---

## 3. Paginação, Limites de Armazenamento e Saturação

A arquitetura separa explicitamente **tamanho de página** de **limites reais de armazenamento**:

| Parâmetro (`worldevents.Config`) | Default | Papel |
|---|---:|---|
| `MaxEventsPerUpdate` | `64` | Tamanho da página de leitura em `PendingDirectorEventPage`; um lote de tick pode exceder uma página |
| `MaxEventsPerBatch` | `128` | Teto rígido de eventos produzidos por um único tick |
| `MaxPendingDirectorEvents` | `1024` | Teto rígido do total de eventos somados em todos os lotes pendentes (`>= MaxEventsPerBatch`) |
| `MaxPendingDirectorBatches` | `256` | Teto de lotes pendentes simultâneos |
| `MaxPendingOutcomes` | `64` | Teto de resultados terminais aguardando confirmação |
| `MaxPendingContributions` | `256` | Teto de contribuições aguardando confirmação (`>= World.MaxContributions = 128`, default `2×`) |
| `MaxSnapshotBytes` | `2 MiB` | Orçamento total de bytes verificado pré-decodificação e antes de commitar filas em `Step` |

### Diferenciação entre Saturação Acumulada e Excesso de Um Único Tick

- **Saturação acumulada (`ErrDirectorBackpressure`, `ErrOutcomeBackpressure`, `ErrContributionBackpressure`):** filas contêm fatos de ticks anteriores aguardando consumidor. O `Step` falha atomicamente sem mutar estado; o consumidor consulta, processa e confirma os fatos mais antigos fora de `Step`, e o próximo `Step` volta a avançar imediatamente.
- **Excesso de um único tick (`ErrTickEventCapacity`):** ocorre se um único tick produzir `> MaxEventsPerBatch` eventos, ou se o estado + novo lote não couberem em `MaxSnapshotBytes` mesmo com **todas** as filas anteriores vazias. Indica configuração incompatível e exige ajuste explícito de limites (não retry fútil).
- **Validação antecipada de configurações incompatíveis (`Config.Validate` / `OrchestratedConfig.Validate`):** rejeita upfront `MaxChainDepth > 0 && MaxPendingEvents < 2`, `MaxPendingDirectorEvents < MaxEventsPerBatch` e `MaxPendingContributions < World.MaxContributions`.

---

## 4. Confirmações, Ordem Contígua e Idempotência

- **Ordem contígua estrita:** cada fila aceita confirmação **somente** da sequência mais antiga pendente (`AckSeq + 1`). Confirmações futuras, saltadas ou fora de ordem retornam `ErrInvalidCommand` sem mutar estado nem eliminar fatos anteriores não processados.
- **Repetição idempotente:** repetir a confirmação da última sequência já confirmada (`sequence == AckSeq`) é no-op idempotente que preserva o checksum; sequências mais antigas já ultrapassadas (`< AckSeq`) são rejeitadas.
- **Detecção de conflito e lote parcial (`Acknowledge*Verified`):**
  - `AcknowledgeDirectorBatchVerified(state, seq, expectedEventCount, cfg)` rejeita confirmação quando o consumidor não leu todas as páginas do lote (`expectedEventCount != len(batch.Events)`).
  - `AcknowledgeTerminalOutcomeVerified(state, seq, eventID, cfg)` e `AcknowledgeContributionVerified(state, seq, eventID, cfg)` rejeitam `EventID` divergente atomicamente.
- **Garantia real:** entrega repetível (*at-least-once* com identidade `EventID` estável) + proteção contra efeitos duplicados dentro das fronteiras do motor. **Não** declara *exactly-once* distribuído de transporte.

---

## 5. Política de Admissão e Taxonomia de Pausas

`campaignAdmissionError` diferencia claramente os níveis de controle de fluxo:

1. **Pausa de admissão opcional (máximo progresso seguro):** antes de enfileirar ou lançar uma **nova** campanha opcional, o Diretor verifica:
   - `PendingDirectorBatches < MaxPendingDirectorBatches` e `totalPendingDirectorEvents < MaxPendingDirectorEvents`;
   - `len(PendingOutcomes) + inFlightUnresolved < MaxPendingOutcomes`;
   - `MaxPendingContributions - len(PendingContributions) >= (inFlightUnresolved + 1) * World.MaxContributions`;
   - `len(PendingEvents) + max(1, reservedFollowupSlots) < MaxPendingEvents` (quando `MaxChainDepth > 0`).
   - Com default `MaxPendingContributions = 256` (`2 × 128`), um consumidor lento segurando até `128` contribuições da Campanha 1 **não bloqueia** a admissão da Campanha 2 independente; acima disso, a admissão opcional pausa e retoma imediatamente assim que recuperação parcial devolve `>= 128` vagas livres.
2. **Progresso garantido de campanhas já em voo:** campanhas em andamento conservam sua vaga reservada de follow-up (`reservedFollowupSlots`) e continuam avançando e encerrando normalmente durante pausa de admissão opcional.
3. **Pausa tática / pausa do tick (`Step`):** ocorre apenas quando um fato obrigatório produzido no tick atual não cabe na fila saturada ou no orçamento de snapshot. O tick falha atomicamente, permitindo inspeção e confirmação fora de `Step`.
4. **Recuperação de capacidade:** ocorre via `AcknowledgeDirectorBatch[Verified]`, `AcknowledgeTerminalOutcome[Verified]`, `AcknowledgeContribution[Verified]`, `ReleaseCancelledEvents` e `PruneClosedReservationsExcept`.

---

## 6. Reservas Sequenciais, Política de Reservas Antigas e Snapshot v5

- **Reservas sequenciais contíguas (`ecosystem.CreateSequencedReservation`):** toda nova reserva criada pelo World Event Director recebe `sequence = eco.ReservationSeq + 1` e chave interna reservada `ordered-reservation:<seq>` (namespace bloqueado na API legada `CreateReservation`).
  - Enquanto retida: retry com parâmetros idênticos (`CampaignID`, `CampID`, `Amount`, `CreatedTick`, `ExpiryTick`) retorna a reserva existente; qualquer divergência retorna `ErrReservationConflict`.
  - Após encerramento e poda (`PruneClosedReservationsExcept`, protegendo reservas ainda referenciadas por campanhas em voo): qualquer sequência `<= ReservationSeq` é rejeitada com `ErrDuplicateReservation` (fechamento contra replay com memória `O(1)`). Lacunas (`sequence > ReservationSeq + 1`) retornam `ErrInvalidCommand`.
- **Política formal de reservas antigas e Snapshots v5:**
  - `simulation.SnapshotVersion = 5` rejeita explicitamente snapshots `v1`, `v2`, `v3` e `v4` (`ErrUnsupportedSnapshotVersion`).
  - `OrchestratedState.Validate` rejeita qualquer estado v5 que contenha `RetiredReservationKeys` legadas ou reservas fora do formato `ordered-reservation:<seq>`, pois um histórico legado que já descartou chaves arbitrárias não pode comprovar ausência de replay sem um registro durável externo.
  - **Não existe migração automática segura implementada.** Para preservar execuções v4 anteriores, deve-se manter o snapshot e binário v4 originais em backup imutável, concluir/reconciliar saldos e identidades externamente em registro durável confiável e iniciar novas simulações v5 em namespace isolado.

---

## 7. Harness Headless vs Integração Futura com CARBON

O harness headless (`RunOrchestrated` e cenários **J–N** em `cmd/sim`) implementa o ciclo completo de consumidor em memória (**executar tick → consultar páginas/fatos → processar → confirmar somente o processado → liberar capacidade → continuar**). Ele é **exclusivamente um harness de desenvolvimento/validação** e **não** representa persistência durável em PostgreSQL.

### Padrão de Integração Futura com CARBON (TypeScript / PostgreSQL)
1. **Transactional Inbox (deduplicação persistente):** o consumidor CARBON consulta as filas do NEON e grava os fatos (junto ao `EventID` estável como `idempotency_key` + UUIDv5 na borda) em transação PostgreSQL com restrição `UNIQUE` no Inbox **antes** de chamar `Acknowledge*` no NEON.
2. **Confirmação durável e retry:** uma queda entre persistir no PostgreSQL e confirmar no NEON gera reentrega dos mesmos fatos com `EventID` idêntico; o Inbox do CARBON deduplica sem efeitos colaterais e reenvia a confirmação idempotente.
3. **Alinhamento de fatos terminais e contribuições:** `DirEventSettlementOutcomeRecorded` (no lote do diretor) e `PendingOutcomes` carregam o mesmo `TerminalSettlementOutcome.EventID` — o adaptador deve deduplicar por `EventID` e aplicar na ordem preparação → início → desfecho (satisfazendo a pré-condição de conflito do `SettlementCaptured` do CARBON).
4. **Snapshot atômico da camada hospedeira:** o host de produção futuro deverá persistir de forma coordenada o snapshot v5 (ou log de comandos/confirmações) após confirmar no NEON.
