# CARBON — Integridade Transacional, Idempotência, Retry e Segurança

## 1. Classificação de Resultados e Política de Idempotência

Toda escrita oriunda do NEON passa pelo mesmo Transactional Inbox (`processed_events` via `claimOrVerifyProcessedEvent`) dentro da transação ACID (`READ COMMITTED`) que persiste o domínio e o Outbox:

| Cenário | Comportamento no CARBON | Código / Erro | Deve sofrer Retry pelo NEON? |
| :--- | :--- | :--- | :--- |
| **Evento novo válido** | Persiste `processed_events` + agregado + `outbox_events` atomicamente | `status: "applied"` | Não (concluído) |
| **Mesmo `EventID` + mesmo conteúdo semântico** | Reconhecido via `payload_fingerprint` SHA-256 canônico; zero novos efeitos | `status: "duplicate_idempotent"` / `"duplicate_noop"` | Não (sucesso operacional idempotente) |
| **Mesmo `EventID` + conteúdo divergente** | Rejeitado permanentemente (`ROLLBACK`) | `InboxIdempotencyConflictError` (`EVENT_ID_PAYLOAD_MISMATCH`) | **NÃO** (conflito permanente de integridade) |
| **Mesma `idempotency_key` + outro evento incompatível** | Rejeitado permanentemente (`ROLLBACK`) | `InboxIdempotencyConflictError` (`IDEMPOTENCY_KEY_CONFLICT`) | **NÃO** (conflito permanente) |
| **`EventID` diferente para mesma `(simulation_id, invasion_id, player_id)`** | Rejeitado antes do commit ou via constraint `UNIQUE` (`23505`), revertendo `processed_events` | `LogicalContributionConflictError` | **NÃO** (violação de emissão única terminal) |
| **Payload fora do schema / limites 64-bit / outcome não terminal** | Rejeitado na fronteira antes de abrir transação | `InvalidContributionError` / `BoundaryValidationError` | **NÃO** (entrada inválida permanente) |
| **Timeout de rede, queda de conexão ou falha transitória de banco antes do commit** | Transação sofre `ROLLBACK` integral (incluindo `processed_events`) | Erro transitório de I/O / `pg.DatabaseError` | **SIM** (com backoff exponencial + jitter) |

### Política para Registros Legados (Session 01)
Registros gravados antes da migração `0002` possuem `payload_fingerprint IS NULL`. Quando reentregues, o CARBON aplica política conservadora: exige igualdade estrita dos metadados estruturais armazenados (`event_type`, `event_version`, `aggregate_id`, `idempotency_key`); qualquer divergência dispara `InboxIdempotencyConflictError`.

---

## 2. Retry sob Entrega Parcial de Lotes (`DispatchContributions`)

Na auditoria do NEON (`internal/world/director.go`), `DispatchContributions` itera sobre `[c1, c2, ..., cn]` e interrompe no primeiro erro. Se `c1` confirmar no PostgreSQL e `c2` falhar por timeout transitório, a retentativa do lote reenviará `c1`:

- No serviço padrão `RecordContributionService.record()`, `c1` retorna `{ status: "duplicate_idempotent", duplicate: true }` sem repetir efeitos nem inserir novo evento no outbox, permitindo que o adaptador de transporte do NEON avance para `c2..cn` e conclua o lote integralmente.
- Caso um consumidor in-process exija estritamente a semântica do fake Go (`ports.ErrDuplicateContribution`), `recordStrictPortSemantics()` permanece disponível como wrapper explícito.

---

## 3. Transactional Outbox (Sem Alegação de *Exactly-Once* de Transporte)

- Eventos internos (`SettlementStateChanged`, `ContributionRecorded`) são inseridos em `outbox_events` com `published_at = NULL` **na mesma transação PostgreSQL** da mudança de estado/contribuição.
- O CARBON **não** declara o evento como publicado na rede apenas por estar gravado no outbox, nem alega entrega *exactly-once* de transporte. A garantia implementada é **persistência atômica livre de dual-write + consumidor idempotente sob entrega *at-least-once***.

---

## 4. Postura de Segurança Revisada

1. **SQL Parametrizado:** 100% das queries utilizam parâmetros posicionais (`$1..$n`) com casts explícitos (`::numeric(20,0)`, `::bigint`, `::jsonb`).
2. **Limites de Payload e Precisão:** `decodeWireJsonLossless` impõe teto de `64 KiB` por mensagem JSON na fronteira e preserva inteiros de 64 bits antes de `JSON.parse`; números JS fora de `Number.isSafeInteger` são rejeitados.
3. **Autenticação de Origem Pendente:** o campo textual `source` no JSON serve apenas para rastreamento/auditoria e **não comprova autenticação**. Endpoints de ingestão de eventos de gameplay **jamais** devem ser expostos a clientes públicos; quando o transporte NEON → CARBON sair de chamadas locais, exigirá canal interno autenticado (mTLS ou assinatura HMAC/token de serviço).
4. **Isolamento do Harness de Testes:** `startPostgresTestContext()` vincula o PostgreSQL embutido exclusivamente em `127.0.0.1` em diretório temporário descartável e bloqueia migrações destrutivas contra `DATABASE_URL` externas cujo nome de banco não termine em `_test` ou `_ci`.
5. **Migrações Concorrentes:** protegidas por `pg_advisory_lock(84291001)` em `migrator.ts`.
