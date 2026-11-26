# NEON — Cycle 02 Engineering Handoff Notes (`neon/creature-ai-engine`)

**Branch:** `neon/creature-ai-engine` (baseada em `9d7cd2c`, após auditoria CODEX do Ciclo 01)  
**Escopo:** Creature AI Engine determinístico — percepção, seleção de alvos, perfis de goblins e orcs, coordenação coletiva, moral, territorialidade e reforços limitados.

## O que mudou no Ciclo 02

1. **Motor de IA de Criaturas (`internal/ai`)**:
   - **Perfis (`profiles.go`)**: catálogo canônico de goblins (`goblin-skirmisher`, `goblin-raider-pack`, `goblin-taskmaster`) e orcs (`orc-vanguard`, `orc-warchief`) em parâmetros inteiros puros (sem floats, sem lore proprietário externo).
   - **Percepção e seleção de alvos (`targeting.go`)**: filtragem por `VisionRange`, `AlertRange` (foco coletivo) e `LeashRadius` territorial, pontuação inteira 128-bit safe por proximidade, vida baixa, ameaça, objetivo e ordem do comandante, com desempate canônico (`Score -> Distance -> TargetID`).
   - **Coordenação coletiva (`coordination.go`)**: `ai.Coordinate` calcula aura de moral de comandantes (limitada por `MaxCommanderAuraBP`), ordens de `FocusTarget` / `Rally` e táticas descentralizadas (`OrderFlankWeak` para matilhas goblin e `OrderFocusTarget` por ameaça para warbands orc).
   - **Moral, territorialidade e reforços (`policy.go`)**: quebra de moral + histerese de reagrupamento (`BreakMoraleBP < RallyMoraleBP`), defesa/retorno territorial (`StateReturnHome`), solicitações de reforços com cooldown e limite por grupo.
2. **Integração no World Director (`internal/world`)**:
   - Ordenação canônica de comandos dentro do mesmo tick (`CanonicalizeCommands`), garantindo independência da ordem de chegada na rede.
   - Entidades defensivas percebíveis (`DefenderEntity` via `CmdDeployDefender`) com geração e decaimento autoritativo de ameaça (`ThreatScore`).
   - Limites explícitos de capacidade em `Config` v2 (`MaxActiveGroups`, `MaxReinforcementWaves`, `MaxDefenders`, `MaxObjectives`, `MaxContributions`), endereçando o achado `P2 capacidade` da auditoria do Ciclo 01.
   - Novos eventos de domínio com `EventID` estável: `TargetAcquired`, `MoraleChanged`, `ReinforcementsCalled`, `TerritoryAlert`.
   - Bump explícito de `SnapshotVersion` para `2`, com todos os campos do Ciclo 02 cobertos no checksum canônico SHA-256.
3. **Endereçamento de achados do Ciclo 01 (CODEX)**:
   - Preservadas todas as proteções de overflow numérico de `56f99ab`.
   - Adicionados limites explícitos de capacidade (`P2 capacidade`).
   - Adicionados testes de unidade para `internal/ports` e `cmd/sim` (`P3 cobertura`) e teste dedicado de replay para o motor de IA + benchmark multi-grupo (16 grupos ativos + 4 defensores).

## Fronteira com CARBON (inalterada / sem invasão de domínio)

- Nenhuma regra de persistência, economia, Bounty, reputação, títulos ou recompensas foi implementada pelo NEON.
- `internal/ports/carbon.go` permanece compatível com o pedido de contrato do Ciclo 01 ([NEON_TO_CARBON_CONTRACT_REQUEST.md](../contracts/NEON_TO_CARBON_CONTRACT_REQUEST.md)).
- Decisão futura pendente: separar comandos administrativos de comandos de jogador na camada de transporte/autorização antes de abrir rede real.
