# NEON — Cycle 1 Engineering Handoff Notes

**Branch:** `neon/backend-foundation`  
**Stack (default reversível):** Go `1.27.x` (stdlib apenas)  
**Escopo:** Fundação determinística headless + Vertical Slice Prioridade B (World Simulation Harness)

## Resumo para CARBON e revisão de PR

1. **Nenhuma regra do domínio do CARBON foi implementada**:
   - Nenhuma tabela, banco de dados, economia regional, Bounty, reputação, título, raça/povo persistente ou concessão de recompensas foi criada.
   - Toda interação prevista com CARBON está isolada em `internal/ports/carbon.go`, testada com fakes in-memory em `internal/adapters/memory/`.
2. **Revisão solicitada ao CARBON**:
   - Validar [NEON_TO_CARBON_CONTRACT_REQUEST.md](../contracts/NEON_TO_CARBON_CONTRACT_REQUEST.md).
   - Validar os 4 ADRs em `docs/adr/` (todos em status `Proposed`).
   - Alinhar ownership conjunto para: núcleo genérico de combate, PvP, Legacy Ranked / Genesis Ranked (MD3), matchmaking e netcode/rollback.
3. **Integridade da fundação**:
   - Simulação 100% headless e independente de `time.Now()`, `float32`/`float64`, `math/rand` global e ordem de `map`.
   - Verificada com testes de determinismo, snapshot/restore em tick `K`, 1.000+ ticks consecutivos, invariantes, inputs inválidos, race detector (`-race`), fuzzing limitado e benchmarks de baseline.
4. **Regras de propriedade intelectual e design pendente**:
   - Nenhum texto, lore ou nome proprietário de terceiros foi incluído.
   - Atributos além dos 6 citados, raças, famílias completas de criaturas e regras de Ranked não foram congelados no código.
