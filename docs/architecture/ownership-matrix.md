# Matriz de Ownership — Backend ASCENDRA

Este documento define as fronteiras de responsabilidade entre os agentes/desenvolvedores **CARBON** e **NEON**, os artefatos compartilhados que exigem coordenação explícita via PR/contrato versionado e os subsistemas cujo ownership permanece não confirmado.

> **Importante:** `NEON` refere-se exclusivamente ao segundo agente/desenvolvedor do backend ASCENDRA — **não** a qualquer provedor de banco de dados (como Neon Database).

---

## 1. CARBON

Responsável pela persistência autoritativa de estado de mundo social/político, integridade transacional, memória histórica e sistemas de progressão social/econômica:

- **Dados persistentes** do domínio político, social e regional
- **Raças, linhagens raciais, culturas jogáveis e cadastro de povos** (identidade original ASCENDRA; sem cópia de lore/nomes protegidos de terceiros)
- **Cidades e estados de assentamentos** (`Settlement` e transições atômicas de estado)
- **Facções e relações persistentes entre facções** (`Faction`, `FactionRelation`)
- **Reputação** (`Reputation` — separada de Bounty, Fame e CriminalRecord)
- **Bounty positivo/negativo** (`Bounty`) e **histórico criminal/social** (`CriminalRecord`)
- **Títulos e histórico de títulos** (`TitleDefinition`, `PlayerTitleUnlock`, `TitleHistory`)
- **Memória histórica do servidor** (`HistoricalRecord` / histórico auditável de eventos persistidos)
- **Economia regional** e **contratos de reconstrução** (`RegionalEconomy`, `ReconstructionContract`, ledger auditável)
- **Recompensas persistentes** (`RewardGrant`) e integridade de inventário/recompensas associadas ao domínio CARBON

---

## 2. NEON

Responsável pela simulação ativa de mundo, IA, motor de invasões e orquestração de eventos PvE/mundiais:

- **Simulação** ativa do mundo e ecossistema dinâmico
- **IA** de monstros e **comportamento de criaturas**
- **Diretor de eventos** e **orquestração de eventos mundiais**
- **Invasões** (motor de invasões, ataques, cercos)
- **Combate PvE**, **bosses** e **comandantes**
- **Validação de contribuições** de jogadores em eventos PvE/mundiais

Exemplos de eventos de domínio produzidos pelo NEON (consumíveis pelo CARBON mediante contrato acordado):
- `InvasionStarted`
- `SettlementCaptured`
- `SettlementLiberated`
- `WorldBossDefeated`
- `PlayerContributionRecorded`
- `CreaturePopulationChanged`
- `FactionInfluenceChanged`

> **Regra de fronteira:** CARBON pode criar *fakes/stubs* de teste (`FakeWorldEventSource`, `FakeContributionValidator`) para validar persistência e contratos, mas **jamais** implementa motores internos do NEON (`WorldEventDirector`, `InvasionEngine`, `BossSimulation`, IAs de criaturas).

---

## 3. SHARED / REQUIRES COORDINATION

Qualquer alteração nos itens abaixo exige documentação prévia, preferência por evolução retrocompatível (versionamento de schema) e revisão conjunta entre CARBON e NEON:

- **`event schemas`**: estrutura dos payloads JSON e contratos em `contracts/events/`
- **`IDs globais`**: formato canônico de identificadores entre módulos (`UUID` v4/v7 para entidades e eventos, códigos estáveis quando aplicável)
- **`versionamento de eventos`**: envelope compartilhado (`event_id`, `event_type`, `version`, `occurred_at`, `correlation_id`, `source`)
- **`contratos de recompensa`**: critérios e chaves de idempotência para `RewardGrant`
- **`estado de cidades`**: conjunto canônico de estados de `Settlement` (`peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`) e semântica de transição
- **`contribuições de jogadores`**: payload validado emitido por NEON (`PlayerContributionRecorded`) para consumo futuro de reputação/recompensas no CARBON

---

## 4. Ownership Ainda Não Confirmado (Fora de Escopo Atual)

Nenhum agente deve assumir ownership unilateral sobre os sistemas abaixo até definição explícita nos contratos do repositório:

- Combate principal (fighting game core)
- Netcode e rollback networking
- Matchmaking e MMR
- Modo competitivo `Legacy Ranked` (MD3)
- Modo competitivo `Genesis Ranked` (MD3)
- Simulação de batalha competitiva
