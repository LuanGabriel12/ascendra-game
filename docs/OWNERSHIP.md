# ASCENDRA — Ownership & Collaboration Boundaries

Este documento define as responsabilidades iniciais entre **NEON** e **CARBON** para desenvolvimento paralelo seguro via branches e Pull Requests, sem edição simultânea nem duplicação de fontes de verdade.

> **Nota:** "NEON" é apenas o identificador do engenheiro/agente responsável pela fundação de gameplay/backend em tempo real. Não implica adoção do banco de dados Neon.

## Matriz de Ownership

| Domínio / Módulo | Owner Atual | Status | Regras de Integração |
|---|---|---|---|
| Comportamento de criaturas e IA de gameplay (`internal/ai`) | **NEON** | Ativo | Política pura orientada a dados e determinística |
| Simulação de mundo, World/Event Director e motor de invasões (`internal/world`) | **NEON** | Ativo | Headless, sem wall-clock, sem persistência direta |
| Combate PvE, bosses e comandantes | **NEON** | Futuro | Requer alinhamento prévio de contrato de combate |
| Validação autoritativa de contribuições em eventos | **NEON** | Ativo (slice) | Emite `ContributionResult` via port; não concede recompensas |
| Núcleo determinístico de simulação (`internal/simulation`) | **NEON** | Ativo | Sem dependências de transporte, DB ou engine gráfica |
| Contratos de boundary consumidos pelo NEON (`internal/ports`) | **NEON** (proposta) / **Conjunto** | `Proposed` | Qualquer quebra de contrato exige alinhamento com CARBON |
| Núcleo genérico de combate e simulação PvP | **A confirmar (NEON ↔ CARBON)** | Pendente | Não assumir ownership unilateralmente |
| Sistema competitivo (Legacy Ranked MD3, Genesis Ranked MD3, MMR/Glicko-2, matchmaking) | **A confirmar (NEON ↔ CARBON)** | Pendente / Protótipo futuro | Não congelar regras ou constantes neste ciclo |
| Netcode, rollback de produção e protocolos compartilhados | **A confirmar (NEON ↔ CARBON)** | Pendente | Fundação preparada para tick/snapshot/restore; sem GGPO/rede agora |
| Cadastro persistente de raças/povos e linhagens | **CARBON** | Fora do escopo NEON | NEON consome apenas snapshots mínimos de gameplay quando necessário |
| Persistência de cidades (`Settlement`), facções, reputação, Bounty, títulos | **CARBON** | Fora do escopo NEON | NEON lê via `SettlementReader` (fake in-memory no Ciclo 1) |
| Economia regional, histórico, reconstrução persistente e concessão de recompensas | **CARBON** | Fora do escopo NEON | NEON entrega apenas `ContributionResult` via `ContributionSink` |

## Regras operacionais de colaboração

1. **Nunca trabalhar diretamente em `main`**: toda entrega do NEON ocorre em branch dedicada (`neon/backend-foundation` neste ciclo).
2. **Fonte única de verdade**: o NEON nunca cria tabelas, schemas ou APIs definitivas pertencentes ao domínio do CARBON.
3. **Ports & Fakes**: qualquer dependência de dados do CARBON passa por interface mínima em `internal/ports`, testada com adapters in-memory determinísticos em `internal/adapters/memory`.
4. **Propriedade intelectual original**: nenhum texto, lore, nome proprietário ou asset de obras de terceiros (como D&D/BG3) deve ser copiado para o repositório.
5. **Dados de design pendentes**: apenas os 6 atributos citados (Fortitude, Agilidade, Força, Inteligência, Sorte, Sabedoria) estão registrados como referência preliminar; os demais atributos, raças, famílias de criaturas e regras de Ranked permanecem pendentes de especificação conjunta.
