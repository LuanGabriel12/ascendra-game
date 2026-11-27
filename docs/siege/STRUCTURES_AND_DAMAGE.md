# Defensive Structures, Damage Formulas & Limited Repair (`internal/siege/combat.go`)

## 1. Estruturas Defensivas com Comportamento Real

Todas as cinco classes de estrutura possuem comportamento ativo integrado à simulação — nenhuma é meramente decorativa:

| Estrutura (`StructureKind`) | Valewatch HP | Ironford HP | Armadura / Resistência | Comportamento Ativo | Quando Destruída (`HP == 0`) |
|---|---:|---:|---|---|---|
| **Portão (`Gate`)** | `240` | `360` | `10` / `2000 BP` (20%) | Bloqueia passagem `MainGate -> OuterDistrict` para invasores; reparável enquanto vivo | Abre rota do portão (`PhaseBreach`); objetivo `ObjDefendGate` falha |
| **Muralha (`Wall`)** | `260` | `400` | `15` / `3000 BP` (30%) | Alta resistência; abre brecha flanqueadora em `<= 50%` HP (`BreachThresholdBP = 5000`) | Mantém brecha permanente `WallApproach -> OuterDistrict` |
| **Torre (`Tower`)** | `140` | `220` | `8` / `1500 BP` (15%) | Dispara saraivadas determinísticas (`40` dano, cooldown `10` ticks) em invasores até `1` hop | Para imediatamente de disparar (`FireCooldownTicks = 0`) |
| **Depósito (`SupplyDepot`)** | `120` | `160` | `5` / `1000 BP` (10%) | Concede `+25%` de eficácia de reparo e regeneração finita de suprimentos (`+10` / `20` ticks, teto `100`) | Penalidade imediata (`-40` suprimentos), bônus cai a `0%` e regeneração cessa |
| **Cidadela (`Citadel`)** | `240` | `360` | `12` / `2500 BP` (25%) | Objetivo estratégico final em `ZoneCitadel`; exige brecha prévia para assalto | Condição terminal de captura (`PhaseCaptured`) |
| **Total (`SettlementMaxDefenseHP`)** | **`1000`** | **`1500`** | — | **Fonte única de verdade sincronizada com `WorldState.SettlementDefenseHP`** | — |

---

## 2. Fórmulas de Dano e Resistência (Inteiros / Fixed-Point)

Sem ponto flutuante, com proteção 128-bit (`bits.Mul64`/`bits.Div64`) contra overflow e divisão por zero:

1. **Ataque escalado por arquétipo/família e comandante:**
   $$\text{scaled} = \max\left(1,\ \left\lfloor \frac{\text{baseDamage} \times \text{attackerModBP}}{10000} \right\rfloor\right)$$
   - Goblins: `goblin-skirmisher` `9000 BP` (`12000 BP` contra `SupplyDepot`), `goblin-raider-pack` `10500 BP` (`11500 BP` contra `Gate`/`SupplyDepot`), `goblin-taskmaster` `11500 BP`.
   - Orcs: `orc-vanguard` `12500 BP` (`13500 BP` contra `Gate`/`Wall`), `orc-berserker` `14000 BP` (`15000 BP` contra `Wall`/`Citadel`), `orc-warchief` `15000 BP`.
   - Comandante vivo da mesma família soma `CommanderState.SiegeDamageBonusBP` (`+1500 BP` Goblin / `+2000 BP` Orc).
2. **Redução por armadura plana e resistência percentual (`ResistanceBP <= 7500`):**
   $$\text{afterArmor} = \max(1,\ \text{scaled} - \text{armorFlat})$$
   $$\text{effective} = \min\left(\text{target.HP},\ \max\left(1,\ \left\lfloor \frac{\text{afterArmor} \times (10000 - \text{resistanceBP})}{10000} \right\rfloor\right)\right)$$
3. **Invariantes rígidas:** HP nunca fica negativo; estruturas inexistentes ou destruídas (`HP == 0`) e entidades mortas são rejeitadas atomicamente.

---

## 3. Suprimentos Táticos e Reparação Limitada

- **Suprimentos táticos (`SiegeSupplies`):** recursos efêmeros de batalha — **não** representam inventário persistente nem moeda (domínio CARBON).
- **Política de estruturas destruídas:** `AllowDestroyedStructureRepairInBattle = false` por padrão — estruturas com `HP == 0` **não** podem ser reconstruídas em combate; sua reconstrução pertence ao período pós-batalha.
- **Impossibilidade de reparação infinita:** toda reparação (`CmdPlayerRepairStructure` ou NPC `RoleRepairUnit`) exige simultaneamente:
  1. Invasão em `UnderAttack`, entidade viva e em zona adjacente (`AreAdjacent`) à estrutura;
  2. Estrutura viva (`HP > 0`) e danificada (`HP < MaxHP`, proibindo overheal e reparo sem efeito);
  3. `Supplies.Current >= RepairSupplyCost` (`25`);
  4. Cooldown respeitado (`RepairCooldownTicks = 12`);
  5. `Structure.RepairsApplied < MaxRepairsPerStructure` (`6`) e `EntityRepairs < MaxRepairsPerEntity` (`4`);
  6. Regeneração do depósito estritamente finita (`TotalRegenerated <= MaxSupplyRegenTotal = 100`) e interrompida imediatamente se o Depósito cair.
- **Cura efetiva:** $\text{heal} = \min\left(\text{MaxHP}-\text{HP},\ \left\lfloor \frac{\text{RepairBaseAmount} \times (10000 + \text{depotBonusBP})}{10000} \right\rfloor\right)$. A contribuição `Support` do jogador credita **estritamente** `heal` (nunca overheal).
