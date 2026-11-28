# CARBON Regional Market, Tax Policies & NPC Merchants (`REGIONAL_MARKET.md`)

## 1. Mercados Regionais Independentes (`market_listings` & `market_sales`)

Cada anúncio está vinculado a um `settlement_id` específico (ex.: Valewatch em Ashvale, Forte Ironfang em Granite Peaks, Entreposto de Thornveil), permitindo liquidez e preços independentes por cidade/região.

- **Escopo da Vertical Slice:** anúncios de venda com preço unitário fixo (`unit_price > 0`), suportando equipamentos únicos (`quantity = 1`, protegidos por `uq_market_listings_active_instance`) e pilhas de materiais com preenchimento parcial (`Open -> PartiallyFilled -> Filled`) ou integral. Ordens de compra (*buy orders*) e leilões permanecem planejados para etapas futuras.
- **Concorrência Compra vs Cancelamento/Expiração:** `buyMarketListing`, `cancelMarketListing` e `expireMarketListing` travam a linha de `market_listings FOR UPDATE` no Passo 1 e validam `status IN ('Open', 'PartiallyFilled')`, eliminando duplicação de item ou moeda em corridas simultâneas.

---

## 2. Políticas Tributárias Regionais (`regional_tax_policies`)

Taxas configuradas em *basis points* (`0..2500 bp` sob teto `max_tax_rate_bp`), com arredondamento inteiro explícito por piso (`floor_integer`) e conservação exata (`seller_net_amount + treasury_tax_amount + sink_burned_amount === gross_amount`):
- **Valewatch (provisório v1):** taxa de anúncio `100 bp` (`1%`), imposto sobre venda `500 bp` (`5%`), `sink_burn_share_bp = 0` (`100%` da taxa vai para o `settlement_treasury` de Valewatch: em uma venda de `1.000`, comprador paga `1.000`, vendedor recebe `950` e tesouro recebe `50`).
- **Forte Ironfang (provisório v1):** venda `400 bp` (`4%`), com `20%` queimado em `system_sink` e `80%` enviado ao tesouro local.
- **Thornveil (provisório v1):** venda `700 bp` (`7%`), com `25%` queimado em `system_sink`.

---

## 3. Estatísticas Regionais de Preços (`getRegionalMarketPriceStats`)

Diferencia rigorosamente **preço anunciado** (`lowestActiveAskPrice`, `availableListedQuantity`) de **preço efetivamente negociado** em `market_sales` (`lastTradedUnitPrice`, `totalTradedQuantity`, `totalGrossVolume`, média ponderada por volume inteira `VWAP` e mediana inferior exata no período observado). Anúncios não vendidos nunca contaminam o preço médio ou mediano negociado.

---

## 4. Comerciantes NPC (`npc_merchants` & `npc_merchant_offers`)

Suporta dois modos explícitos de financiamento:
1. **`treasury_backed` (ex.: `valewatch_quartermaster`):** vendas ao jogador creditam o `settlement_treasury` local; recompras do jogador debitam o `settlement_treasury` local (falhando se o tesouro não possuir saldo) e respeitam tanto `max_stock` quanto `daily_buyback_budget_cap`.
2. **`controlled_system_faucet_sink` (ex.: `ironfang_master_anvil`):** vendas e serviços de reparo de durabilidade drenam moedas para `system_sink` (e parcela configurável ao tesouro), enquanto eventuais recompras ficam estritamente limitadas por `daily_buyback_budget_cap` (impedindo emissão monetária ilimitada).
