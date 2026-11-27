# Strategic Objectives, District Capture & Victory Rules (`internal/siege/phases.go`)

## 1. Objetivos Estratégicos Autoritativos

Em modo de cerco (`WorldState.Siege != nil`), o comando `CmdCompleteObjective` **jamais aceita conclusão cega pelo identificador**. Cada objetivo possui lado (`Defense` / `Invasion`), zona, estrutura opcional, pré-requisitos acíclicos (`PrerequisiteIDs`), estado (`Locked -> Active -> Completed | Failed`) e verificação autoritativa do estado real do mundo:

| Objetivo | Lado | Pré-requisito | Condição Autoritativa de Conclusão |
|---|---|---|---|
| `obj-def-01-defend-gate` (`DefendGate`) | Defesa | — | Portão de pé (`HP > 0`), pressão de assalto já iniciada e 0 invasores na zona do Portão (jogador adjacente) |
| `obj-def-02-repair-fortification` (`RepairFortification`) | Defesa | — | Jogador realizou reparo válido com consumo de suprimentos **e** a fortificação alvo tem `RepairsApplied > 0` |
| `obj-def-03-protect-supplies` (`ProtectSupplies`) | Defesa | — | Depósito intacto (`HP > 0`), brecha externa ocorrida e 0 invasores em `ZoneSupplyDistrict` |
| `obj-def-04-hold-outer-district` (`HoldDistrict`) | Defesa | — | Brecha externa ocorrida, distrito sob `DefenderControlled` e 0 invasores presentes |
| `obj-def-05-defeat-commander` (`DefeatCommander`) | Defesa | — | Todos os comandantes de cerco implantados foram derrotados (`Alive == false`) — também auto-conclui na queda |
| `obj-inv-01-destroy-gate` (`DestroyGate`) | Invasão | — | `str-01-main-gate` alcança `StructureDestroyed` |
| `obj-inv-02-open-breach` (`OpenBreach`) | Invasão | — | `HasOuterBreach() == true` (Portão destruído ou Muralha `<= 50%` HP) |
| `obj-inv-03-capture-outer-district` (`CaptureDistrict`) | Invasão | `obj-inv-02-open-breach` | `zone-04-outer-district` atinge `DistrictInvaderControlled` |
| `obj-inv-04-disrupt-supplies` (`DisruptSupplies`) | Invasão | `obj-inv-02-open-breach` | `str-04-supply-depot` alcança `StructureDestroyed` |
| `obj-inv-05-assault-citadel` (`AssaultCitadel`) | Invasão | `obj-inv-03-capture-outer-district` | `str-05-citadel-keep` destruída **ou** `zone-08-citadel` capturada |

**Proteções aplicadas:** objetivos inexistentes, duplicados (`ErrDuplicateObjective`), lado incorreto, fase terminal, entidade morta, entidade não implantada, distância fora de zona adjacente (`ErrZoneBlocked`) e condições não cumpridas (`ErrObjectiveConditionNotMet`) são rejeitados atomicamente sem gerar contribuição.

---

## 2. Captura Territorial de Distritos e Histerese

- Distritos capturáveis: `ZoneOuterDistrict`, `ZoneSupplyDistrict`, `ZoneCivilDistrict`, `ZoneCentralSquare` (`threshold = 100`) e `ZoneCitadel` (`threshold = 120`).
- **Pré-requisito de acessibilidade:** distritos internos (`Depth >= 3`) não acumulam progresso de captura enquanto não houver brecha nas fortificações externas.
- **Progresso por presença:**
  - Invasores sem defensores: `+DistrictControlStep * min(inv, 3)` (`20` por grupo, máx. `60`/tick).
  - Contestado (`inv > 0 && def > 0`): lado com superioridade numérica move `±max(1, DistrictControlStep/2)`.
  - Defensores sem invasores: recuperam `-DistrictControlStep` até `0` (`DefenderControlled`).
- **Histerese (`DistrictHysteresisTicks = 3`):** impede alternância rápida de titularidade em disputas oscilantes.
- **Sem vitória prematura:** capturar distritos externos destrava objetivos e rota, mas **nunca** encerra o cerco automaticamente até a Cidadela ser comprometida.

---

## 3. Condições de Vitória, Derrota, Retirada e Anti-Stall

1. **`Captured` → `ports.InvasionOutcomeCaptured`:** brecha externa confirmada **e** (`Citadel.HP == 0` **ou** `ZoneCitadel == InvaderControlled`).
2. **`Defended` → `ports.InvasionOutcomeDefended`:** zero invasores vivos e zero ondas `WaveScheduled` pendentes.
3. **`Withdrawn` → `ports.InvasionOutcomeDefended` (retirada tática):**
   - Moral média dos invasores cai até/abaixo do limiar da família (`GoblinWithdrawMoraleBP = 2800`, `OrcWithdrawMoraleBP = 1400`) após baixas ou queda de comandante (sem ondas pendentes); **ou**
   - **Política determinística anti-stall:** `tick - LastProgressTick >= NoProgressTimeoutTicks` (`160`, sem ondas pendentes) **ou** `tick - StartedTick >= SiegeMaxDurationTicks` (`480`). Garante que nenhum cerco permaneça travado indefinidamente.
