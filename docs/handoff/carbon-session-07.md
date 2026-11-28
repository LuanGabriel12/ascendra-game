# Handoff CARBON — Session 07 (`carbon/economy-trading-crafting-engine`)

- **Branch base obrigatória:** `origin/carbon/codex-independent-audit` (`d40c3567cfbd93b5dc6412c1a9806cabef77e4b8`)
- **Branch de desenvolvimento:** `carbon/economy-trading-crafting-engine`
- **Data:** 2026-11-28
- **Classificação de desenvolvimento:** `IMPLEMENTED WITH LIMITATIONS` *(ambiente isolado de desenvolvimento; não constitui aprovação da auditoria independente nem prontidão para produção).*

---

## 1. Resumo das Etapas Concluídas (`Etapas A–F`)

1. **Etapa A — Monetary Foundation (`0013`):** catálogo versionado de moedas (`ascendra_coin` em unidades inteiras de cobre + moedas especiais/regionais/eventos + token competitivo planejado desabilitado), carteiras persistentes (`player_wallet`, `settlement_treasury`, `faction_treasury`, `escrow_account`, `merchant_account`, `system_mint`, `system_sink`), ledger imutável de partidas dobradas, emissão/transferência/sink, estorno compensatório e reconciliação `REPEATABLE READ`.
2. **Etapa B — Escrow & Bilateral Trading (`0013`):** reservas monetárias reais (`currency_reservations`), custódia física de equipamentos (`location_state = 'in_escrow'`) e pilhas (`escrow_asset_holdings`), e negociação bilateral atômica (`PlayerTradingService`) com invalidação automática de confirmações ao alterar ofertas e proteção contra inventário cheio.
3. **Etapa C — Regional Market, Taxes & NPC Merchants (`0014`):** anúncios regionais de preço fixo (`Open`, `PartiallyFilled`, `Filled`, `Cancelled`, `Expired`), políticas tributárias versionadas em *basis points*, estatísticas regionais separando ofertas de vendas executadas, e comerciantes NPC financiados por tesouro ou sumidouro/fonte controlada (incluindo reparo pago de durabilidade).
4. **Etapa D — Boss Loot, Anti-Bad-Luck Fragments, World Contributions & Criminal Bounties (`0015`):** concessão individual reprodutível de loot (`grantAuthoritativeBossLoot`), fragmentos vinculados ao personagem com resgate atômico, recompensas econômicas multidimensionais para `gameplay_contributions` elegíveis via `external_identity_links`, e financiamento/liquidação real de `criminal_bounties` via `currency_reservations` (mantendo quarentena sobre registros legados sem reserva verificada).
5. **Etapa E — Crafting, Blacksmithing & Economic Titles (`0015`):** catálogo de 13 profissões (`blacksmithing` ativa), receitas versionadas, consumo atômico de materiais, geração procedural com proveniência do criador (`crafted_by_character_id`) e habilitação verificável dos títulos `legendary_blacksmith` (`v2`) e `imperial_merchant` (`v2`, imune a *wash trading* na mesma conta).
6. **Etapa F — Validation, Simulation & Demo:** suítes unitárias e de integração em PostgreSQL real, harness `economy-simulator.ts`, demonstração `npm run demo:session07` (27 passos com restart/reconexão do PostgreSQL) e documentação completa.

---

## 2. Comandos de Validação e Publicação

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run demo:session02
npm run demo:session03
npm run demo:session04
npm run demo:session05
npm run demo:session06
npm run demo:session07
git diff --check

# Comando seguro de publicação quando desejar (sem force-push e sem merge na main):
git push -u origin carbon/economy-trading-crafting-engine
```

---

## 3. Pendências de Auditoria e Limitações Preservadas

- Os relatórios anteriores (`docs/audits/CARBON_CODEX_INDEPENDENT_AUDIT.md` e `docs/handoff/CARBON_CODEX_AUDIT_HANDOFF.md`) foram **preservados sem qualquer edição**: o gate da auditoria independente permanece pendente de revisão completa do grafo global de locks com barreiras controladas, classificação independente dos achados `001–010`, validação em PostgreSQL 16 + Go no CI remoto e decisão conjunta sobre `relic` (*Relíquia*) vs *Divino*.
- Ordens de compra (*buy orders*), leilões com lances, profissões de coleta em tempo real (mineração/lenhador/agricultura/pesca), transporte autenticado de rede e *worker* do Outbox permanecem fora do escopo desta sessão e recomendados para etapas futuras.
