# Procedural Item Generation & Power Budget

## 1. Determinismo e RNG (`SplitMix64Rng`)

A geração procedural é implementada como função pura e determinística em `src/modules/inventory/domain/procedural-generator.ts` apoiada por `src/modules/inventory/domain/splitmix64-rng.ts`:

- **Zero `Math.random()` e zero ponto flutuante:** toda aritmética utiliza `BigInt` de 64 bits (`uint64`) e inteiros exatos em *basis points* (`10000 = 100.00%`).
- **Derivação de Seed no Servidor:**
  ```text
  canonicalSeedMaterial = "ascendra:itemgen:v1|definitionCode|definitionVersion|rulesVersion|itemLevel|rarityCode|originReference|serverSeed"
  ```
  O SHA-256 dessa string fornece os primeiros 64 bits de estado para o `SplitMix64` e os 16 primeiros caracteres hexadecimais para `generation_seed_hash` persistido na instância.
- **Amostragem Uniforme sem Viés (*Rejection Sampling*):** `nextUint64Bounded(bound)` descarta valores acima de `MAX_UINT64 - ((MAX_UINT64 + 1) % bound)`, eliminando *modulo bias*.
- **Independência de Ordem de Entrada:** os afixos candidatos são ordenados canonicamente por `(affixCode ASC, affixVersion ASC)` antes de qualquer sorteio.

---

## 2. Modelo de Orçamento de Poder (*Power Budget*)

Configurado na tabela versionada `item_generation_rules` (`dev_itemgen_v1`):

1. **Orçamento Bruto por Nível do Item:**
   `rawBaseBudget = basePowerBudget + (itemLevel * levelBudgetPerItemLevel)` (padrão provisório: `levelBudgetPerItemLevel = 4`).
2. **Escalonamento por Raridade:**
   `rarityScaledBudget = (rawBaseBudget * rarity.powerBudgetMultiplierBp) / 10000`
3. **Bônus Controlado de Qualidade:**
   `qualityBonusBp = (qualityBp * qualityBonusMaxBp) / 10000` (padrão provisório: até `+2000 bp` = `+20%` com `qualityBp = 10000`).
4. **Orçamento Total Final:**
   `powerBudgetTotal = (rarityScaledBudget * (10000 + qualityBonusBp)) / 10000`

Durante o laço estritamente limitado (`step < targetAffixCount`), cada afixo candidato só é elegível se `affix.powerBudgetCost <= (powerBudgetTotal - powerBudgetSpent)`. É estruturalmente impossível gerar `powerBudgetSpent > powerBudgetTotal` (validado também por `CHECK (power_budget_spent <= power_budget_total)` no PostgreSQL).

---

## 3. Rolagem de Magnitude e Influência da Qualidade

Para afixos numéricos (`prefix` e `suffix` com `[minModifier, maxModifier]`):
- Sorteia-se `rngBp` em `0..10000`.
- Combina-se `blendedBp = floor((rngBp + qualityBp) / 2)`.
- Calcula-se `rolledMagnitude = clamp(minModifier + floor((span * blendedBp) / 10000), minModifier, maxModifier)`.

Isso garante que a qualidade individual (`qualityBp`) desloque positivamente a distribuição das rolagens sem jamais violar os limites `[minModifier, maxModifier]` do tier do afixo.

---

## 4. Simulador Estatístico (`procedural-item-simulator.ts`)

O harness `runStandardSession04Simulations()` executa lotes determinísticos de **1.000**, **10.000** e **100.000** gerações com *seeds* fixas (`carbon-s04-sim-1k`, `carbon-s04-sim-10k`, `carbon-s04-sim-100k`), verificando:
- Frequência por raridade, código de afixo e *tier*.
- Estatísticas de `qualityBp` (mínimo, máximo, média inteira e quartis).
- Contagem de combinações únicas de afixos e teto de orçamento observado.
- Zero violações de orçamento (`budgetViolations = 0`), zero afixos duplicados (`duplicateAffixViolations = 0`), zero grupos exclusivos repetidos (`exclusiveGroupViolations = 0`) e zero vazamentos de *pool* (`forbiddenPoolViolations = 0`).
- Reprodutibilidade exata por *checksum* FNV-1a de 64 bits.

> **Nota Importante:** Os parâmetros `dev_itemgen_v1` são provisórios para validação arquitetural. A simulação comprova correção matemática, determinismo e disciplina de *pools*, não substituindo balanceamento econômico de produção.
