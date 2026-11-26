# Handoff CARBON → NEON (Sessão 01)

- **Branch:** `feature/carbon-initial-persistence`
- **Data:** 2026-11-26
- **Agente Autor:** CARBON
- **Agente Destinatário:** NEON (Simulação de Mundo, IA, Invasões e Eventos Mundiais)

---

## 1. O que foi implementado

Implementação da **Vertical Slice 01 — Persistência Transacional e Idempotente de Estado de Assentamento (`Settlement State`)** em arquitetura de monólito modular com PostgreSQL real:

- Persistência autoritativa de `Faction` e `Settlement` com transições de estado validadas no domínio e no banco.
- Processamento atômico e idempotente dos eventos `SettlementCaptured` e `SettlementLiberated` (v1).
- Registro imutável na memória histórica do servidor (`settlement_history`) a cada mudança de estado.
- Registro transacional de eventos processados (`processed_events` — Inbox) e publicação atômica em `outbox_events` (`SettlementStateChanged` v1).
- Interfaces preparatórias (apenas contratos de domínio, sem implementação prematura) para Economia Regional (ledger auditável), Reputação/Bounty/Fama/Histórico Criminal separados, Títulos e Povos/Linhagens/Culturas.
- Adaptadores *fake* de teste (`FakeWorldEventSource` e `FakeContributionValidator`) sem implementar qualquer motor interno do NEON.

---

## 2. Arquivos criados

- **Configuração e CI:**
  - `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `docker-compose.yml`
  - `.github/workflows/ci.yml`
- **Documentação e Arquitetura:**
  - `docs/architecture/ownership-matrix.md`
  - `docs/adr/0001-modular-monolith-and-stack.md`
  - `docs/adr/0002-settlement-concurrency-and-idempotency.md`
  - `docs/handoff/carbon-session-01.md`
- **Contratos Compartilhados (Propostas v1):**
  - `contracts/events/envelope.v1.schema.json`
  - `contracts/events/settlement-captured.v1.schema.json`
  - `contracts/events/settlement-liberated.v1.schema.json`
  - `contracts/events/settlement-state-changed.v1.schema.json`
- **Migrações SQL:**
  - `migrations/0001_carbon_settlement_slice.up.sql`
  - `migrations/0001_carbon_settlement_slice.down.sql`
- **Código-fonte (`src/`):**
  - `src/shared/config/env.ts`
  - `src/shared/observability/logger.ts`
  - `src/shared/contracts/world-events.ts`
  - `src/shared/db/pool.ts`
  - `src/shared/db/migrator.ts`
  - `src/scripts/migrate.ts`
  - `src/modules/factions/domain/faction.ts`
  - `src/modules/factions/infrastructure/postgres-faction-repository.ts`
  - `src/modules/settlements/domain/errors.ts`
  - `src/modules/settlements/domain/settlement.ts`
  - `src/modules/settlements/domain/settlement-history.ts`
  - `src/modules/settlements/application/ports.ts`
  - `src/modules/settlements/application/settlement-event-handler.ts`
  - `src/modules/settlements/infrastructure/postgres-settlement-unit-of-work.ts`
  - `src/modules/economy/domain/value-ledger.ts`
  - `src/modules/social/domain/social-standing.ts`
  - `src/modules/titles/domain/title-contracts.ts`
  - `src/modules/peoples/domain/people-contracts.ts`
  - `src/adapters/neon/fake-world-event-source.ts`
  - `src/adapters/neon/fake-contribution-validator.ts`
- **Testes de Integração (`tests/`):**
  - `tests/helpers/postgres-test-harness.ts`
  - `tests/integration/settlement-vertical-slice.test.ts`

---

## 3. Arquivos modificados

Nenhum arquivo pré-existente foi modificado (o repositório não possuía arquivos rastreados antes desta sessão).

---

## 4. Contratos compartilhados

Como o repositório estava vazio e ainda não continha handoff ou contratos prévios do NEON, os contratos em `contracts/events/*.schema.json` estão marcados como **`PROPOSED SHARED CONTRACT (v1) — REQUIRES NEON COORDINATION`**.

Envelope canônico proposto (`v1`):
```json
{
  "event_id": "uuid",
  "idempotency_key": "optional-string-defaults-to-event_id",
  "event_type": "SettlementCaptured",
  "version": 1,
  "occurred_at": "2026-11-26T12:00:00.000Z",
  "correlation_id": "uuid",
  "source": "neon.invasion-engine",
  "payload": {}
}
```

---

## 5. Eventos aceitos (NEON → CARBON)

1. **`SettlementCaptured` (`version: 1`)**
   - `payload.settlement_id` (`UUID`, obrigatório)
   - `payload.capturing_faction_id` (`UUID`, obrigatório — deve existir em `factions`)
   - `payload.invasion_id` (`UUID`, opcional)
   - `payload.expected_settlement_version` (`integer >= 1`, opcional — ativa guarda otimista explícita)
   - *Regra de domínio:* aceito quando o assentamento está em `threatened`, `under_attack` ou `occupied` (por outra facção). Transiciona para `occupied`.

2. **`SettlementLiberated` (`version: 1`)**
   - `payload.settlement_id` (`UUID`, obrigatório)
   - `payload.liberating_faction_id` (`UUID`, obrigatório — deve existir em `factions`)
   - `payload.resulting_state` (`"rebuilding" | "peaceful"`, opcional; default `"rebuilding"` se estava `"occupied"` ou `"peaceful"` se repeliu `"under_attack"`)
   - `payload.expected_settlement_version` (`integer >= 1`, opcional)
   - *Regra de domínio:* aceito quando o assentamento está em `occupied` ou `under_attack`. Um assentamento `occupied` transiciona obrigatoriamente por `rebuilding` antes de voltar a `peaceful`.

---

## 6. Eventos emitidos (CARBON Outbox)

- **`SettlementStateChanged` (`version: 1`)** gravado em `outbox_events` na mesma transação:
  - Contém `settlement_id`, `region_id`, `previous_state`, `new_state`, `previous_faction_id`, `new_faction_id`, `settlement_version`, `cause_event_id`, `cause_event_type`.

---

## 7. Schema criado

Migração `0001_carbon_settlement_slice`:
- `factions` (`id`, `code`, `name`, `is_playable`, `created_at`, `updated_at`)
- `settlements` (`id`, `name`, `region_id`, `state`, `controlling_faction_id`, `version`, `created_at`, `updated_at`)
- `processed_events` (`event_id`, `idempotency_key`, `event_type`, `event_version`, `source`, `correlation_id`, `aggregate_id`, `occurred_at`, `processed_at`)
- `settlement_history` (`id`, `settlement_id`, `settlement_version`, `previous_state`, `new_state`, `previous_faction_id`, `new_faction_id`, `cause_event_id`, `cause_event_type`, `correlation_id`, `occurred_at`, `recorded_at`)
- `outbox_events` (`id`, `aggregate_type`, `aggregate_id`, `event_type`, `event_version`, `correlation_id`, `causation_event_id`, `payload`, `occurred_at`, `created_at`, `published_at`)

---

## 8. Invariáveis garantidas

- Estados permitidos em `settlements.state`: `peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding` (`CHECK` no banco e no domínio).
- Assentamento em estado `occupied` exige obrigatoriamente `controlling_faction_id IS NOT NULL` (`CHECK` no banco).
- `controlling_faction_id` referencia `factions(id)` com `ON DELETE RESTRICT` (`FOREIGN KEY`).
- `settlement_history` exige `UNIQUE (settlement_id, settlement_version)`, `UNIQUE (cause_event_id)` e `FOREIGN KEY (cause_event_id) REFERENCES processed_events(event_id)`.
- Nenhuma operação altera `settlements` sem gravar simultaneamente `processed_events`, `settlement_history` e `outbox_events`.

---

## 9. Estratégia de idempotência

- Na abertura da transação, CARBON executa `INSERT INTO processed_events (...) ON CONFLICT DO NOTHING RETURNING event_id`.
- As constraints `PRIMARY KEY (event_id)` e `UNIQUE (idempotency_key)` garantem no PostgreSQL que reenvios sequenciais ou entregas duplicadas paralelas resultem em `duplicate_noop` seguro a partir da segunda tentativa.
- Em caso de falha e `ROLLBACK`, o registro em `processed_events` é revertido junto com toda a transação, permitindo retentativa futura.

---

## 10. Estratégia de concorrência

- **Row-level locking (`SELECT ... FOR UPDATE`)** sobre a linha alvo em `settlements` dentro da transação `READ COMMITTED`, evitando locks globais.
- Incremento monotônico de `version` verificado no `UPDATE ... WHERE id = $5 AND version = $6` e reforçado por `UNIQUE (settlement_id, settlement_version)` no histórico.
- Suporte adicional a `expected_settlement_version` opcional no payload quando o NEON desejar rejeição otimista explícita (`SettlementConcurrencyConflictError`).

---

## 11. Como rodar testes e migrações

```bash
# Instalar dependências
npm install

# Checagem estrita de tipos TypeScript
npm run typecheck

# Rodar suíte de integração contra PostgreSQL real
# (usa DATABASE_URL se definido, ou sobe PostgreSQL nativo real via embedded-postgres automaticamente)
npm test

# Build de compilação
npm run build

# Com banco externo/Docker (opcional):
docker compose up -d
# Configurar DATABASE_URL conforme .env.example e executar:
npm run migrate:up
npm run migrate:status
npm run migrate:down
```

---

## 12. O que NEON precisa saber

1. Para que `SettlementCaptured` seja aceito, o assentamento precisa estar em estado de conflito (`threatened`, `under_attack` ou `occupied` por facção rival). Precisaremos alinhar o contrato de `InvasionStarted` na próxima sessão para transicionar `peaceful -> threatened / under_attack`.
2. Payloads possuem validação estrita (`additionalProperties: false` / `.strict()`): campos não contratados são rejeitados na fronteira (`BoundaryValidationError`).
3. Todos os IDs de entidades e eventos utilizam `UUID` canônico.

---

## 13. O que NÃO foi implementado nesta sessão

- Motores ou sistemas de ownership do NEON (`InvasionEngine`, `WorldEventDirector`, IA de criaturas, bosses, validação de contribuições).
- Combate principal, netcode/rollback, matchmaking, `Legacy Ranked` e `Genesis Ranked`.
- Persistência completa de `RewardGrant`, Economia Regional ativa, Contratos de Reconstrução, Reputação/Bounty completos, engine de Títulos e catálogo das 26 raças/povos.
- Worker assíncrono de despacho/relay da tabela `outbox_events` (apenas gravação transacional e leitura verificadas nesta sessão).

---

## 14. Questões abertas para alinhamento com NEON

1. O NEON emitirá um evento explícito `InvasionStarted` / `SettlementThreatened` antes de `SettlementCaptured`, ou deseja que `SettlementCaptured` também possa capturar diretamente um assentamento em `peaceful` (ataque surpresa)?
2. Existe possibilidade de um assentamento ser libertado sem facção controladora definida (`liberating_faction_id = null`, cidade livre/neutra)? Se sim, podemos flexibilizar o schema v1 ou criar v2 sem breaking change.
3. Qual formato de transporte entre módulos NEON e CARBON será usado no monólito (chamada direta em processo via interface de aplicação ou fila/bus assíncrono lendo `outbox_events`)?
