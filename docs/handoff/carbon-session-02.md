# Handoff CARBON — Session 02 (`carbon/contribution-integration-engine`)

- **Branch de conciliação (Session 01 + NEON Cycle 02):** `feature/carbon-initial-persistence` (`b9368d5`)
- **Branch da Session 02:** `carbon/contribution-integration-engine`
- **Commit NEON integrado:** `349fe698dba57807bbcd1c674bf6e87afbd2a2f9` (`neon/creature-ai-engine`)
- **Data:** 2026-11-26

---

## 1. Resumo Executivo

1. **Conciliação Git concluída sem perda:** `feature/carbon-initial-persistence` integrou `349fe69` (`neon/creature-ai-engine`), preservando todos os pacotes Go do NEON (`cmd/sim/`, `internal/`, `go.mod`, ADRs `0001..0005`, auditorias e handoffs), o notebook `notebooks/Ascendra_Development.ipynb` da `main` e toda a fundação TypeScript/PostgreSQL da Session 01, sem necessidade de `--force` push.
2. **Projeção `SettlementSnapshot` (`0002`):** adicionados `external_id`, `defense_state` (`Secure | Fortified | Damaged | Captured`) e `max_defense_hp` (`BIGINT > 0`) com backfill explícito e triggers expand-phase compatíveis com Session 01, atendendo `SettlementReader` do NEON sem expor entidades internas.
3. **Contribution Engine (`0003` + `src/modules/contributions/`):** persistência transacional autoritativa de `ContributionResult` com suporte integral a `int64` (`BIGINT`) e `uint64` (`NUMERIC(20,0)`), `EventID` determinístico não-UUID, unicidade lógica `(simulation_id, invasion_id, player_id)` e outbox `ContributionRecorded` (`published_at = NULL`).
4. **Idempotência robusta com Fingerprint SHA-256 (`fp:v1:<hex>`):** diferenciação estrita entre evento inédito, duplicata semântica legítima (independente da ordem de propriedades no JSON) e conflitos permanentes de payload/chave/identidade lógica, aplicada tanto a contribuições quanto aos eventos de assentamento da Session 01.

---

## 2. Documentação de Referência Criada

- [CARBON-0003 — Fronteira Poliglota Go + TypeScript](../adr/CARBON-0003-polyglot-go-typescript-boundary.md)
- [CARBON-0004 — Identificadores Opacos, 64-bit e Fingerprints](../adr/CARBON-0004-canonical-idempotency-and-64bit-identifiers.md)
- [Contribution Engine & CharacterSnapshot Proposal](../carbon/CONTRIBUTION_ENGINE.md)
- [Transactional Integrity, Retry & Security](../carbon/TRANSACTIONAL_INTEGRITY.md)
- [CARBON → NEON Contract Response](../contracts/CARBON_TO_NEON_CONTRACT_RESPONSE.md)

---

## 3. Como Reproduzir e Validar

```powershell
# Instalar dependências conforme package-lock.json
npm ci

# Checagem estrita de tipos TypeScript e build
npm run typecheck
npm run build

# Executar todas as suítes (Session 01 + 25 cenários da Session 02) contra PostgreSQL real
npm test

# Executar demonstração integrada reproduzível (15 etapas, incluindo restart do PostgreSQL)
npm run demo:session02
```

> **Limitação registrada de ambiente:** o compilador `go` não está instalado nesta estação Windows (`GO_NOT_AVAILABLE_ON_HOST`). Nenhum arquivo `.go` do NEON foi modificado; solicita-se execução de `go test -race -count=1 ./...` pelo ambiente NEON/CODEX ou pelo job `neon-go` configurado em `.github/workflows/ci.yml`.
