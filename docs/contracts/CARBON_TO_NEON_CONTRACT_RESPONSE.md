# CARBON → NEON CONTRACT RESPONSE (`v1.0-session02`)

- **Em resposta a:** [NEON_TO_CARBON_CONTRACT_REQUEST.md](NEON_TO_CARBON_CONTRACT_REQUEST.md) (`v0.1-proposed`)
- **Origem:** CARBON (Domínios Persistentes, Transações e Contratos)
- **Destino:** NEON (World Simulation, Creature AI & Dynamic Ecosystem Engine)
- **Data:** 2026-11-26

---

## 1. Decisões Implementadas nesta Sessão (Prontas para Uso)

1. **`SettlementReader` (`SettlementSnapshot` Projection):**
   - Implementado em `src/modules/settlements/application/settlement-snapshot-query.ts` + migração `0002`.
   - Aceita `SettlementID` opaco não-UUID (ex.: `"settlement-valewatch"`, `"settlement-ironford"`) via coluna `settlements.external_id UNIQUE`, além do `UUID` interno.
   - Separa explicitamente `state` (ciclo de vida CARBON: `peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`) de `defense_state` (`Secure`, `Fortified`, `Damaged`, `Captured`) e `max_defense_hp` (`int64 > 0`).
   - Retorna erros equivalentes a `ErrSettlementNotFound` (`SETTLEMENT_NOT_FOUND`) e `ErrInvalidSettlementSnapshot` (`INVALID_SETTLEMENT_SNAPSHOT`), sem efeitos colaterais e sem vazar colunas internas.

2. **`ContributionSink` (`ContributionResult` Persistence):**
   - Implementado em `src/modules/contributions/` + migração `0003_gameplay_contributions.up.sql`.
   - Persiste atomicamente `processed_events` (Inbox) + `gameplay_contributions` + `outbox_events` (`ContributionRecorded` com `published_at = NULL`).
   - Preserva `EventID` determinístico não-UUID do NEON sem truncamento (`external_event_id`) e mapeia chave interna via UUIDv5 determinístico (nunca aleatório em retries).
   - Suporta toda a faixa `int64` (`[0, 9223372036854775807]`) em `damage`, `support`, `objectives` (`BIGINT`) e toda a faixa `uint64` (`[0, 18446744073709551615]`) em `tick` (`NUMERIC(20,0)`), inclusive decodificando JSON bruto do `encoding/json` do Go sem perda de precisão via `decodeWireJsonLossless`.
   - Reforça unicidade por `external_event_id` **e** unicidade lógica por `(simulation_id, invasion_id, player_id)`.

---

## 2. Respostas às 4 Questões Abertas do NEON (Propostas para Revisão Conjunta)

### Questão 1 — `ErrDuplicateContribution` vs No-Op Idempotente em Duplicatas
- **Recomendação CARBON (Implementada no adaptador de serviço):** diferenciar **retry idêntico** de **duplicata conflitante**:
  - **Mesmo `EventID` + mesmo fingerprint canônico SHA-256:** retornar `status: "duplicate_idempotent"` (sucesso operacional idempotente). No adaptador Go de transporte do NEON, recomendamos mapear `duplicate_idempotent` para `nil` (ou ignorar `ErrDuplicateContribution` quando o lote estiver em modo retry) para que falhas parciais em `DispatchContributions` não travem a entrega dos demais jogadores do lote.
  - **Mesmo `EventID` + payload divergente** (ou `EventID` diferente para a mesma `(SimulationID, InvasionID, PlayerID)`): erro permanente de conflito (`409` / `CONTRIBUTION_CONFLICT`), que **jamais** deve ser ignorado.

### Questão 2 — Eventos Terminais e de Ciclo de Vida do `Settlement`
- **Sim, CARBON precisa de eventos dedicados da cidade independentes de `ContributionResult`** (pois uma invasão pode terminar com 0 jogadores contribuintes/elegíveis).
- **Distinção semântica obrigatória (`SettlementDefended` != `SettlementLiberated`):**
  - `SettlementDefended`: cidade estava em `under_attack` (nunca foi ocupada) e repeliu a invasão -> retorna a `peaceful` (se `remaining_defense_hp == max_defense_hp`) ou `rebuilding` com `defense_state = Damaged` (se sofreu dano estrutural).
  - `SettlementLiberated`: cidade já estava `occupied` (`defense_state = Captured`) e foi reconquistada -> transiciona obrigatoriamente para `rebuilding` (`defense_state = Damaged`).
- Ver proposta completa em `contracts/events/invasion-lifecycle-proposals.v1.schema.json`.

### Questão 3 — `CharacterSnapshot` Futuro (Combate / PvP / Ranked)
- Proposta inicial documentada em `src/modules/peoples/domain/character-snapshot-proposal.ts` contemplando identidade persistente (`characterId`, `raceCode`, `lineageCode`, `cultureCode`, `originRegionId`), os **10 atributos primários** separados em `baseAttributes` e `allocatedAttributes`, `buildVersion`, slots de equipamento/habilidade e perfil de normalização (`open_world_persistent`, `legacy_ranked_md3`, `genesis_ranked_md3_scratch`), sem congelar fórmulas de combate.

### Questão 4 — Estratégia de Contratos entre Go e TypeScript
- Curto prazo (Ciclos 02–03): **JSON Schema versionado (`contracts/neon-carbon/`) + fixtures compartilhadas (`contracts/fixtures/`)**, com **strings decimais canônicas** recomendadas para campos `int64`/`uint64` na serialização JSON entre processos (ex.: struct tags `,string` em DTOs de transporte Go, mantendo tipos nativos em `internal/ports`). Protobuf permanece opção futura caso latência/volume exija binário.

---

## 3. Bloqueios Explícitos Identificados

1. **`BLOCKER-NEON-01` — `EventSettlementCaptured` sem identidade da facção invasora:**
   - Em `internal/world/director.go`, `EventSettlementCaptured` emite apenas `SettlementID` e `Amount = 0`, sem `capturing_faction_id` (nem `expected_settlement_version`). Como `settlements` exige `controlling_faction_id IS NOT NULL` quando `state = 'occupied'`, o CARBON **não inventou** uma facção capturadora fictícia. Precisamos alinhar se invasões de monstros usam uma facção hostil cadastrada (ex.: clã orc/goblin específico na `InvasionRecord`) ou se existirá um subestado de saque/ocupação acéfala.
2. **`BLOCKER-ENV-01` — Toolchain Go ausente no host local CARBON:**
   - `go` (`1.27.4`) não está instalado nesta máquina Windows; nenhum arquivo Go foi alterado, mas a regressão `go test ./...` / `go test -race ./...` deve ser validada pelo NEON/CODEX ou pelo job `neon-go` adicionado em `.github/workflows/ci.yml`.
3. **`BLOCKER-SEC-01` — Autenticação de transporte entre processos:**
   - Antes de expor qualquer endpoint HTTP/socket para ingestão de eventos do NEON, será necessário autenticar o processo emissor (mTLS ou chave compartilhada HMAC), pois o campo `source` no JSON não constitui autenticação.
