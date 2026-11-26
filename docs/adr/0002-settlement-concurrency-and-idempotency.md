# ADR 0002 — Estratégia de Idempotência, Concorrência e Transactional Outbox (Settlement State)

- **Status:** Accepted (Session 01 — CARBON)
- **Data:** 2026-11-26
- **Autor:** CARBON

---

## DECISION

Para processar eventos externos do NEON que alteram estado de `Settlement` (`SettlementCaptured`, `SettlementLiberated`), toda execução ocorre em **uma única transação PostgreSQL (`READ COMMITTED`)** combinando:

1. **Idempotência no Banco via Inbox (`processed_events`):**
   - `INSERT INTO processed_events (...) VALUES (...) ON CONFLICT DO NOTHING RETURNING event_id` executado **dentro da mesma transação** da mudança de domínio.
   - Constraints estruturais no PostgreSQL: `PRIMARY KEY (event_id)` e `UNIQUE (idempotency_key)`.
   - Se `RETURNING` não retornar linha, o evento já foi processado com sucesso anteriormente (ou por transação concorrente que acabou de confirmar) e o handler retorna `duplicate_noop` sem efeitos colaterais.
   - Se qualquer passo subsequente falhar, o `ROLLBACK` desfaz também o registro em `processed_events`, permitindo reprocessamento seguro.

2. **Controle de Concorrência por Linha (`SELECT ... FOR UPDATE` + `version` monotônica):**
   - Ao atualizar um `Settlement`, a transação executa `SELECT ... FROM settlements WHERE id = $1 FOR UPDATE`.
   - Múltiplas transações concorrentes visando o **mesmo** `settlement_id` (ex.: `SettlementCaptured` vs `SettlementLiberated`) são serializadas no nível da linha pelo PostgreSQL, sem lock global de tabela.
   - A segunda transação desbloqueia enxergando o estado e `version` já confirmados pela primeira, validando invariáveis de transição de estado sobre dados frescos e incrementando `version = version + 1`.
   - Como defesa adicional em profundidade:
     - `UPDATE settlements ... WHERE id = $1 AND version = $expected_version`
     - `UNIQUE (settlement_id, settlement_version)` em `settlement_history`
     - suporte opcional a `expected_version` no payload caso o emissor exija optimistic concurrency explícita.

3. **Memória Histórica + Transactional Outbox na Mesma Transação:**
   - Toda transição válida persiste atomicamente:
     1. `processed_events` (inbox de deduplicação)
     2. `settlements` (novo `state`, `controlling_faction_id`, `version`, `updated_at`)
     3. `settlement_history` (registro imutável com `FOREIGN KEY` para `settlements`, `factions` e `processed_events`)
     4. `outbox_events` (evento `SettlementStateChanged` v1 pronto para consumo assíncrono pelos futuros módulos de Economia Regional, Contratos de Reconstrução e Títulos/Reputação, eliminando dual-write).

---

## WHY

- **Menor mecanismo suficiente:** `READ COMMITTED` + `SELECT ... FOR UPDATE` na linha do agregado resolve disputas sobre o mesmo assentamento de forma determinística sem abortar transações não relacionadas e sem exigir loops globais de retry por `serialization_failure` (`40001`).
- **Invariáveis reforçadas pelo SGBD:** nenhuma regra crítica depende apenas de `if not exists` na aplicação.

---

## ALTERNATIVES

1. **Apenas Optimistic Locking (`WHERE version = X`) sem `FOR UPDATE`:** rejeitaria desnecessariamente eventos legítimos consecutivos do NEON (ex.: captura seguida imediatamente de libertação) que podem ser avaliados em sequência sobre o estado atualizado.
2. **`SERIALIZABLE` em todas as transações:** descartado como padrão geral pelo custo de contenção e necessidade obrigatória de retry para `40001` mesmo quando um lock de linha pontual no agregado resolve 100% da invariável.
