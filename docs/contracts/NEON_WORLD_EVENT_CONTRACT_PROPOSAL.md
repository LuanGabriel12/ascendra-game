# NEON → CARBON World Event Contract Proposal (Cycle 04)

- **Status:** `Proposed — Aligned Draft for Joint Review` (NÃO congela contratos unilateralmente; preserva integralmente `internal/ports/carbon.go` existente)
- **Origem:** NEON (`neon/world-event-director`, Go 1.27.4 — Simulação Autoritativa Determinística)
- **Destino:** CARBON (`feature/carbon-initial-persistence`, TypeScript / Node.js / PostgreSQL — Persistência, Transactional Inbox/Outbox, Economia, Reputação, Bounty)
- **Referência CARBON inspecionada (somente leitura):** `origin/feature/carbon-initial-persistence` @ `36ef459423be343b037f1145bb6dd608d0030f52`

---

## 1. Alinhamento Explícito com Contratos Já Publicados pelo CARBON

Na inspeção somente leitura do repositório remoto do CARBON (`36ef459`), confirmamos que CARBON já publicou:
1. **Envelope compartilhado** (`contracts/events/envelope.v1.schema.json`, `src/shared/contracts/world-events.ts`):
   - `AscendraSharedEventEnvelopeV1`: `event_id` (UUID), `idempotency_key` (opcional `1..128` chars), `event_type`, `version: 1`, `occurred_at` (ISO-8601 UTC), `correlation_id` (UUID), `source`, `payload`.
2. **Eventos já definidos pelo CARBON (NÃO duplicados aqui)**:
   - `SettlementCaptured` (`contracts/events/settlement-captured.v1.schema.json`): `settlement_id` (UUID), `capturing_faction_id` (UUID), `invasion_id?` (UUID), `expected_settlement_version?`.
   - `SettlementLiberated` (`contracts/events/settlement-liberated.v1.schema.json`).
   - `SettlementStateChanged` (`contracts/events/settlement-state-changed.v1.schema.json`).
3. **Pré-condição explícita do CARBON observada**:
   - O handler de `SettlementCaptured` do CARBON exige que o assentamento esteja previamente em estado de conflito (`threatened`, `under_attack` ou `occupied`) e solicitou alinhamento de eventos prévios (`InvasionStarted` / `SettlementThreatened`).

Este documento propõe o mapeamento entre os fatos autoritativos produzidos pelo Ciclo 04 do NEON e o envelope `AscendraSharedEventEnvelopeV1`, **reutilizando diretamente** `SettlementCaptured` e propondo os eventos complementares de campanha/invasão/defesa.

---

## 2. Regras de Mapeamento de Plataforma (Go ↔ TypeScript/PostgreSQL)

| Tipo no NEON (Go) | Representação no JSON de Transporte | Motivo |
|---|---|---|
| `event_id` interno (`out:sim:000001`) | `idempotency_key` (string estável) + `event_id` UUIDv5 determinístico derivado no adapter de borda | Preserva determinismo no núcleo Go sem importar UUID/clock e satisfaz validação UUID do Zod/JSON Schema no CARBON |
| `simulation_id`, `campaign_id`, `invasion_id`, `settlement_id`, `region_id`, `faction_id` | Mapeamento UUIDv5 determinístico (namespace ASCENDRA) ou tabela `external_key` no adapter de borda | Evita acoplamento de UUIDs no motor determinístico puro |
| `uint64` / `int64` (`tick`, `started_tick`, `completed_tick`, `damage`, `support`, `objectives`) | **Strings decimais** (`"12000"`) no JSON de transporte (ou Protobuf futuro) | Evita perda silenciosa de precisão acima de `Number.MAX_SAFE_INTEGER` (`2^53 - 1`) em JavaScript/Node.js |
| `occurred_at` (ISO-8601 UTC exigido no envelope) | Preenchido **exclusivamente** no adapter de emissão/transporte fora do núcleo determinístico | Núcleo determinístico NEON permanece 100% livre de `time.Now()` |

---

## 3. Fatos Autoritativos NEON → CARBON

### 3.1 Eventos de Preparação e Início (satisfazendo pré-condição de conflito do CARBON)

1. **`WorldCampaignScheduled` / `SettlementWarningIssued`** (proposto, `event_type: "SettlementThreatened"` ou `"WorldCampaignWarning"`):
   - Emitido quando a campanha transiciona `Preparing -> Warning` e `World.Invasion` entra em `Threatened`.
   - Payload mínimo: `campaign_id`, `settlement_id`, `region_id`, `invading_faction_id`, `template_id`, `tick` (decimal string), `rules_version`.
   - Permite ao CARBON mover o assentamento para `threatened` antes do combate.

2. **`SettlementInvasionStarted`** (proposto, alinha com `WorldCampaignStarted` + `EventInvasionStarted`):
   - Emitido quando a campanha entra em `Active` (`World.Invasion == UnderAttack`).
   - Payload mínimo: `campaign_id`, `invasion_id`, `settlement_id`, `region_id`, `invading_faction_id`, `started_tick` (decimal string), `rules_version`.
   - Permite ao CARBON registrar `under_attack` de forma idempotente antes do desfecho.

3. **`WorldCampaignCancelled`** (proposto):
   - Emitido se a campanha for cancelada ou expirada durante `Warning` (`Threatened -> Peace`), permitindo ao CARBON reverter o estado de alerta do assentamento caso aplicável.

### 3.2 Fato Global Terminal (Emitido Estritamente Uma Vez — Mesmo com 0 Jogadores)

O `worldevents.TerminalSettlementOutcome` mapeia-se para dois desfechos mutuamente exclusivos:

- **Quando `Outcome == "Captured"` → Reutiliza `SettlementCaptured` v1 do CARBON**:
  - `settlement_id`, `capturing_faction_id` (`InvadingFactionID`), `invasion_id`, mais metadados opcionais (`campaign_id`, `region_id`, `started_tick`, `completed_tick`, `rules_version`, `eligible_contributors`).
  - **Garantia crítica**: é emitido mesmo quando `eligible_contributors == 0` (nenhum jogador presente), assegurando que capturas em mundo aberto sejam persistidas.
- **Quando `Outcome == "Defended"` → Proposta `SettlementDefended` v1**:
  - `campaign_id`, `invasion_id`, `settlement_id`, `region_id`, `invading_faction_id`, `started_tick`, `completed_tick`, `rules_version`, `eligible_contributors`.

### 3.3 Fatos Individuais de Contribuição (`GameplayContributionRecorded`)

- Continua utilizando o contrato mínimo já validado em `internal/ports/carbon.go` (`ContributionResult`): `event_id`, `simulation_id`, `invasion_id`, `settlement_id`, `tick`, `player_id`, `damage`, `support`, `objectives`, `eligible`, `outcome`.
- **Separação rigorosa**: fatos individuais de contribuição só são emitidos para jogadores que participaram; o fato global `TerminalSettlementOutcome` é independente e sempre emitido.
- **Fora de escopo NEON**: cálculo de moeda, saque, Bounty, pontos de reputação, títulos, inventário e reconstrução persistente pertencem 100% ao CARBON.

---

## 4. Projeções Somente-Leitura (CARBON → NEON Bootstrap Futuro)

Além de `ports.SettlementReader` (`SettlementSnapshot`), futuras sessões de integração poderão alimentar o NEON via snapshot inicial de leitura contendo estado persistente de ocupação/defesa (`SettlementDefenseState`, `MaxDefenseHP`) e políticas de regiões protegidas — sem nunca permitir que o núcleo determinístico consulte PostgreSQL diretamente durante o loop de simulação.

## 5. Questões Abertas para Alinhamento com CARBON

1. CARBON prefere receber o aviso prévio de conflito via evento dedicado `SettlementThreatened` / `SettlementInvasionStarted` ou via `SettlementStateChanged` existente?
2. CARBON aprova o mapeamento via UUIDv5 determinístico (namespace fixo) no adapter de borda Go para preencher `event_id`, `correlation_id`, `settlement_id`, `invasion_id` e `capturing_faction_id` mantendo o núcleo Go agnóstico a UUID?
3. CARBON confirma o uso de strings decimais para `uint64`/`int64` (`tick`, `damage`, `support`, `objectives`) no payload JSON v1?
