# ADR CARBON-0004 — Identificadores Opacos, Inteiros de 64 Bits e Idempotência com Fingerprint Canônico

- **Status:** Accepted (CARBON Internal) / Proposed (Wire Serialization Alignment with NEON)
- **Data:** 2026-11-26
- **Autor:** CARBON

---

## Contexto

A inspeção de `internal/ports/carbon.go` e `internal/world/director.go` revelou quatro divergências concretas entre os contratos de Session 01 do CARBON e a implementação Go do NEON:
1. **Identificadores:** NEON usa strings determinísticas não-UUID (`settlement-valewatch`, `sim:s1:inv:inv1:contrib:player-kael`); CARBON usava `UUID` estrito.
2. **Estados de Cidade:** CARBON modela ciclo de vida político/social (`peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`); NEON modela condição defensiva (`Secure`, `Fortified`, `Damaged`, `Captured`).
3. **Inteiros de 64 bits:** NEON usa `int64` e `uint64`; `number` em JavaScript perde precisão acima de $2^{53}-1$ (`9007199254740991`).
4. **Idempotência cega:** `INSERT ... ON CONFLICT DO NOTHING` sem comparação de conteúdo aceitava silenciosamente reentregas com mesmo `event_id` porém payload adulterado/divergente.

---

## Decisões

1. **Dupla representação estável de identificadores (sem truncamento nem UUID aleatório em retry):**
   - `settlements` recebe `external_id VARCHAR(128) UNIQUE` (retropreenchido com `id::text` para registros legados). Consultas e projeções resolvem tanto `external_id` quanto `UUID`.
   - `processed_events` e `gameplay_contributions` armazenam `external_event_id VARCHAR(255) NOT NULL UNIQUE` **exatamente como emitido pelo NEON**. A chave primária interna `UUID` em `processed_events` é derivada deterministicamente via **RFC 9562 UUIDv5** (ou o próprio UUID normalizado quando já for UUID), garantindo estabilidade absoluta em retries e verificação explícita contra colisões.

2. **Ortogonalidade entre Ciclo de Vida e Condição Defensiva:**
   - `settlements` mantém `state` (ciclo de vida CARBON) e adiciona `defense_state` (`Secure | Fortified | Damaged | Captured`) + `max_defense_hp BIGINT` (`> 0`), com constraint de coerência: `occupied <-> Captured`, e demais estados livres entre `Secure`, `Fortified` e `Damaged`.

3. **Precisão Numérica de 64 Bits ponta a ponta:**
   - Domínio TypeScript utiliza `bigint` exclusivamente para `tick`, `damage`, `support`, `objectives` e `maxDefenseHp`.
   - Serialização JSON proposta entre linguagens utiliza **strings decimais canônicas** (`"18446744073709551615"`). Adicionalmente, `decodeWireJsonLossless` intercepta JSON bruto do `encoding/json` do Go antes do `JSON.parse`, preservando literais inteiros acima de `MAX_SAFE_INTEGER` sem arredondamento IEEE-754.
   - No PostgreSQL: `BIGINT` para métricas `int64` e `NUMERIC(20, 0)` com `CHECK (0 .. 18446744073709551615 AND scale = 0)` para `uint64` (`simulation_tick`).

4. **Idempotência verificada por Fingerprint SHA-256 Canônico (`fp:v1:<hex>`):**
   - `processed_events` armazena `payload_fingerprint` calculado sobre árvore canônica com chaves ordenadas lexicograficamente.
   - Mesmo `EventID` + mesmo fingerprint = `duplicate_idempotent` / `duplicate_noop`.
   - Mesmo `EventID` + fingerprint divergente, mesma `idempotency_key` + evento incompatível, ou `EventID` distinto para a mesma tupla lógica `(simulation_id, invasion_id, player_id)` = conflito permanente de integridade (`ROLLBACK`).
