# NEON → CARBON Siege & Settlement Battle Contract Proposal (Cycle 05)

- **Status:** `Proposed — Aligned Draft for Joint Review` (NÃO congela contratos unilateralmente; preserva integralmente [carbon.go](../../internal/ports/carbon.go) sem modificações)
- **Origem:** NEON (`neon/invasion-siege-engine`, Go 1.27.4 — Simulação Autoritativa Determinística)
- **Destino:** CARBON (`carbon/contribution-integration-engine` @ `92f2732` / `carbon/character-progression-engine` @ `8f39621`, TypeScript / Node.js / PostgreSQL)

---

## 1. Preservação Total dos Contratos Existentes (`v1`)

1. **`ports.SettlementSnapshot` (`settlement-snapshot.v1.schema.json`):** inalterado. Os layouts provisórios do NEON (`settlement-valewatch`: `1000` HP, `settlement-ironford`: `1500` HP) derivam `WorldState.SettlementMaxDefenseHP` e `WorldState.SettlementDefenseHP` diretamente da soma estrutural, mantendo paridade exata com `MaxDefenseHP`.
2. **`ports.ContributionResult` (`contribution-result.v1.schema.json`):** inalterado. `Outcome` continua restrito estritamente a `"Defended" | "Captured"`.
   - `Damage`, `Support` (incluindo reparos efetivos de fortificação e cura efetiva de aliados — nunca overheal) e `Objectives` (conclusões autoritativas validadas pelo mundo) mapeiam-se diretamente nos campos existentes.
   - **Defensores NPCs (`IsNPC: true`) jamais emitem `ContributionResult`.**
3. **Mapeamento conservador de `SiegePhase: Withdrawn`:** retiradas táticas por colapso de moral ou política anti-stall mapeiam-se para `ports.InvasionOutcomeDefended` em `ContributionResult`, evitando introduzir um terceiro enum incompatível com os schemas Zod/JSON Schema já publicados pelo CARBON.

---

## 2. Extensões Propostas para `TerminalSettlementOutcome` (`v1.1` / `v2` Conjunta)

Alinhado explicitamente à resposta do CARBON (`CARBON_TO_NEON_CONTRACT_RESPONSE.md`, Questão 2 — distinção entre `SettlementDefended`, `SettlementCaptured` e `SettlementLiberated`):

```json
{
  "event_id": "out:sim-01:000001",
  "simulation_id": "sim-01",
  "campaign_id": "cmp:sim-01:000001",
  "invasion_id": "sim-01-inv-1",
  "settlement_id": "settlement-valewatch",
  "region_id": "region-ashvale",
  "invading_faction_id": "faction-ironfang-orcs",
  "outcome": "Captured",
  "siege_phase": "Captured",
  "started_tick": "34",
  "completed_tick": "182",
  "rules_version": 1,
  "eligible_contributors": 0,
  "structures_destroyed": ["str-01-main-gate", "str-05-citadel-keep"],
  "districts_captured": ["zone-04-outer-district", "zone-07-central-square", "zone-08-citadel"],
  "invader_casualties": "4",
  "defender_casualties": "5",
  "is_reconquest": false
}
```

### Regras de Mapeamento Propostas na Borda Go → TypeScript
- `Outcome == "Defended"` e `IsReconquest == false` → **`SettlementDefended`** (preservando `siege_phase: "Defended" | "Withdrawn"` como detalhe auditável).
- `Outcome == "Captured"` e `IsReconquest == false` → **`SettlementCaptured`** (com `capturing_faction_id = invading_faction_id`, resolvendo a dependência sinalizada pelo CARBON de não haver facção capturadora nula).
- `Outcome == "Captured"` e `IsReconquest == true` → **`SettlementLiberated`** (nova campanha com novo `campaign_id` e novo `invasion_id`, jamais reutilizando IDs anteriores).
- Todos os campos `int64`/`uint64` continuam trafegando como **strings decimais canônicas** no JSON de borda, e a entrega externa permanece *at-least-once* exigindo deduplicação por `event_id` no Transactional Inbox do CARBON antes da confirmação (`AcknowledgeTerminalOutcomeVerified`).

---

## 3. Projeções Futuras Somente-Leitura (CARBON → NEON)

Quando o CARBON persistir geometria/upgrades de cidades, propõe-se uma projeção opcional `SettlementLayoutSnapshot` (lida apenas no bootstrap da arena, nunca dentro de `Step`) contendo:
- `layout_id`, `settlement_id`, `region_id`, lista de estruturas persistidas (ou estado inicial `Intact`/`Damaged`) e `controlling_faction_id` atual.
- Suprimentos táticos de batalha (`SiegeSupplies`) **não** viram moeda nem inventário persistente do jogador; permanecem recursos efêmeros de combate.
