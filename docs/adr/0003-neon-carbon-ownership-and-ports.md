# ADR-0003: Ownership NEON/CARBON, Ports e Estratégia de Contratos

- **Status**: `Proposed` (requer revisão e aprovação explícita do CARBON)
- **Data**: 2026-11-26
- **Owner**: NEON (proposta conjunta NEON ↔ CARBON)

## Contexto

NEON e CARBON desenvolverão o projeto ASCENDRA em paralelo, em branches distintas e sem edição simultânea de arquivos. O NEON é responsável pela simulação em tempo real (IA de criaturas, simulação de mundo, World/Event Director, invasões, combate PvE, bosses e validação de contribuições), enquanto o CARBON é responsável pelos domínios persistentes (raças/povos, linhagens, cidades persistentes, facções, reputação, Bounty, economia regional, títulos, histórico, reconstrução persistente e concessão de recompensas).

Além disso, domínios como núcleo genérico de combate, PvP, Legacy Ranked (MD3), Genesis Ranked (MD3 com preparação PvE temporária e mercador), matchmaking, netcode e rollback ainda precisam de confirmação de ownership.

## Decisão

1. **Separação estrita via Ports & Adapters**:
   - O NEON **nunca** implementa banco de dados, tabelas, migrations, APIs ou regras de negócio pertencentes ao CARBON.
   - Toda leitura ou emissão direcionada ao domínio do CARBON passa por interfaces mínimas em `internal/ports`:
     - `SettlementReader`: consulta somente o snapshot mínimo de gameplay de um `Settlement` (`SettlementID`, `RegionID`, `DefenseState`, `MaxDefenseHP`).
     - `ContributionSink`: recebe `ContributionResult` validado pelo NEON, sem conceder ouro, itens, Bounty, reputação ou títulos.
   - No Ciclo 1, testes e o harness headless utilizam adapters determinísticos in-memory em `internal/adapters/memory`.

2. **Idempotência orientada a `EventID` estável**:
   - Todo evento com potencial consequência persistente futura carrega identidade determinística (`EventID`, `SimulationID`, `Tick`, `SourceEntityID`).
   - O formato determinístico do `EventID` permite ao CARBON deduplicar entregas repetidas (at-least-once delivery / retries seguros) sem aplicar recompensas duas vezes.

3. **Estratégia de contratos de rede/cross-language**:
   - **Não** introduzir Protobuf, gRPC ou event bus externo no Ciclo 1, pois ainda não há transporte de rede nem serviços distribuídos.
   - **Protobuf v3** fica registrado como candidato preferencial caso NEON e CARBON precisem de contratos cross-language ou comunicação entre processos no futuro, obedecendo desde o início às regras:
     - nunca reutilizar field numbers removidos (`reserved`);
     - nunca expor tipos internos de persistência como contrato de rede;
     - versionar schemas explicitamente.

4. **Domínios fora de escopo do Ciclo 1**:
   - Legacy Ranked, Genesis Ranked, Glicko-2, atributos não confirmados (além dos 6 citados), 26 povos/raças e economia persistente **não** são congelados nem implementados neste ciclo.

## Alternativas

- **Implementar tabelas/stubs de persistência do Carbon para "adiantar"**: descartada por violar ownership, criar duas fontes de verdade e gerar alto risco de merge conflict.
- **Introduzir Protobuf/gRPC + Docker + PostgreSQL desde o dia 1**: descartada por overengineering prematuro (YAGNI) antes da confirmação da stack e dos contratos reais com o CARBON.

## Consequências

- **Positivas**:
  - NEON consegue evoluir e testar 100% da simulação headless sem bloquear ou sobrescrever o CARBON.
  - CARBON mantém liberdade total de modelagem interna (SQL, NoSQL, schema, regras de recompensa/economia/Bounty).
- **Negativas / Trade-offs**:
  - Exige sessão curta de alinhamento de contratos (`NEON_TO_CARBON_CONTRACT_REQUEST.md`) antes de plugar persistência real.

## Reversibilidade

**Alta.** Interfaces pequenas em `internal/ports` são fáceis de adaptar sem quebrar o núcleo puro de simulação.

## Questões abertas

1. CARBON confirma os campos mínimos propostos para `SettlementSnapshot` e `ContributionResult`?
2. Qual será a divisão final de ownership para núcleo de combate, PvP, Legacy Ranked / Genesis Ranked e netcode?
3. Os módulos NEON e CARBON viverão no mesmo monorepo/processo inicialmente (monólito modular) ou em processos separados desde o início?
