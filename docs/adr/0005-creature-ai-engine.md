# ADR-0005: Creature AI Engine Determinístico (Ciclo 02 — Goblins, Orcs, Coordenação, Moral, Territorialidade e Reforços)

- **Status**: `Proposed` (sujeito a alinhamento conjunto com CARBON para contratos futuros de criaturas/regiões)
- **Data**: 2026-11-26
- **Owner**: NEON

## Contexto

Com a fundação determinística do Ciclo 01 auditada (`READY WITH LIMITATIONS` em `9d7cd2c`), o Ciclo 02 evolui o núcleo de comportamento de criaturas (`internal/ai`) e sua integração com o World Director (`internal/world`) para suportar comportamentos emergentes e taticamente distintos entre famílias de criaturas sem abrir mão de determinismo, autoridade ou limites de capacidade.

Requisitos prioritários do Ciclo 02:
1. Percepção explícita baseada em dados puros (`VisionRange`, `AlertRange`, alvos e aliados ordenados);
2. Seleção determinística de alvos com pesos inteiros e desempate canônico;
3. Perfis diferenciados de **goblins** e **orcs** (com identidade original de ASCENDRA);
4. Coordenação coletiva (comandantes com aura de moral, `FocusTarget`, `Rally`, flanqueamento de matilha);
5. Moral com quebra para retirada e histerese de reagrupamento (`BreakMoraleBP < RallyMoraleBP`);
6. Territorialidade (`HomePosition`, `TerritoryRadius`, `LeashRadius` e retorno `StateReturnHome`);
7. Reforços determinísticos com cooldown, orçamento por grupo e limite global de ondas/entidades.

## Decisão

1. **Arquitetura de IA em duas fases puras por tick**:
   - **Fase 1 — Coordenação coletiva (`ai.Coordinate`)**: recebe o snapshot canonicamente ordenado (`GroupID`) de todos os grupos e os alvos percebíveis, produzindo um `CoordinationOrder` determinístico por grupo (aura de moral limitada por `MaxCommanderAuraBP = 2400`, ordens de `FocusTarget`, `Rally` e `FlankWeak` para matilhas goblin sem comandante).
   - **Fase 2 — Avaliação individual (`ai.Evaluate`)**: função pura recebendo `Perception` (incluindo `Profile`, `MoraleBP`, `HomePosition`, `Targets`, `Order` e dano recente) e `*simulation.DeterministicRNG`, retornando `Decision` com próximo estado, ação, deslocamento em `WorldUnit`, alvo selecionado, nova moral e solicitação opcional de reforços.

2. **Perfis de dados puros para Goblins e Orcs (`internal/ai/profiles.go`)**:
   - **Goblins** (`goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster`): maior velocidade, menor HP, seleção oportunista (`WeightLowHP` alto), alta dependência de números (`PackMoraleBonusBP` alto e penalidade de isolamento sob combate), pedido antecipado de reforços e menor tolerância a contágio de retirada.
   - **Orcs** (`orc-vanguard`, `orc-warchief`): maior HP e dano, marcha constante, seleção confrontacional (`WeightThreat` e `WeightObjective` altos), moral inicial alta com `BreakMoraleBP` baixo, resistência ao contágio de fuga e `orc-warchief` com aura de comando forte (`1600 BP`) e ondas de reforço estruturadas.

3. **Aritmética 100% inteira e desempate determinístico**:
   - Razões percentuais (`BasisPoints` e `permille`) usam multiplicação/divisão de 128 bits (`math/bits.Mul64` / `bits.Div64`), eliminando floats e overflow de `int64`.
   - Desempate de seleção de alvo: maior `Score` → menor `Distance` → menor `TargetID` lexicográfico.

4. **Ordenação canônica de entradas e limites explícitos de capacidade (achados da auditoria do Ciclo 01)**:
   - `world.CanonicalizeCommands` ordena comandos do mesmo tick deterministicamente por prioridade e IDs estáveis, tornando o resultado independente da ordem de chegada na rede.
   - `Config` (versão `2`) impõe limites explícitos: `MaxActiveGroups`, `MaxReinforcementWaves`, `MaxDefenders`, `MaxObjectives` e `MaxContributions`, rejeitando excessos com `ErrCapacityExceeded`.
   - `simulation.SnapshotVersion` atualizado para `2` para refletir o novo estado lógico completo no checksum canônico e rejeitar snapshots incompatíveis da v1.

## Alternativas

- **Behavior Tree / GOAP completo neste ciclo**: descartada por complexidade prematura e maior dificuldade de auditar determinismo e cobertura de transições nesta fase; a arquitetura em duas fases (`Coordinate` + `Evaluate`) é pequena, componível e extensível.
- **Manter `SnapshotVersion = 1` com campos opcionais**: descartada porque ignorar campos novos silenciosamente poderia mascarar incompatibilidade de replay; bump explícito para `v2` falha rápido (`ErrUnsupportedSnapshotVersion`).
- **Permitir reforços ilimitados**: descartada diretamente pela recomendação `P2 capacidade` da auditoria do Ciclo 01.

## Consequências

- **Positivas**:
  - Comportamentos emergentes distintos entre goblins e orcs sem código duplicado por espécie.
  - Determinismo preservado com replay independente para IA, independência da ordem de comandos no tick e cobertura de snapshot/restore no meio de coordenação e ondas de reforço.
  - Crescimento de entidades e ondas estritamente limitado sob carga.
- **Negativas / Trade-offs**:
  - O modelo espacial atual é unidimensional (`DistanceToSettlement` ao longo do eixo de aproximação); mapas 2D completos exigirão evolução futura para coordenadas `(X, Y)` inteiras mantendo o mesmo contrato de `WorldUnit`.
  - O aumento do estado por grupo eleva o custo de serialização JSON de snapshot (~1,5–2 KB em cenários médios), ainda bem dentro de margens confortáveis.

## Reversibilidade

**Alta.** Todos os perfis são dados puros e isolados em `internal/ai`; a troca por coordenadas 2D ou adição de novas famílias (mortos-vivos, elementais, construtos) não quebra o contrato externo com o CARBON.

## Questões abertas

1. Em ciclos futuros, CARBON fornecerá definições persistentes de acampamentos/regiões (`RegionPopulationSnapshot`) para calibrar orçamentos regionais de reforços e territorialidade?
2. Quando o espaço evoluir de 1D para 2D `(X, Y)` em `WorldUnit`, o cálculo de distância utilizará distância Euclidiana inteira (`isqrt`) ou distância ao quadrado para manter custo mínimo por tick?
3. Comandos administrativos (`SpawnHostileGroup`, `IncreaseThreat`, `ForceInvasionTransition`) deverão ser separados em uma interface/porta distinta dos comandos de jogador antes da exposição em transporte de rede?
