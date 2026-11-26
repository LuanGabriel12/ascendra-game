# ASCENDRA

**ASCENDRA** é um RPG multiplayer online 2D em pixel art de mundo aberto com combate técnico inspirado em *fighting games*, mundo persistente reativo, facções dinâmicas, economia regional e modos competitivos dedicados.

O projeto prioriza **profundidade mecânica, consistência de sistemas e excelência de arquitetura** acima de complexidade gráfica.

---

## Visão Geral

Em ASCENDRA, o estado do mundo evolui continuamente a partir das ações dos jogadores e da simulação ativa do servidor: cidades podem ser ameaçadas, sitiadas, ocupadas por facções ou hordas invasoras, libertadas e reconstruídas, registrando eventos marcantes na memória histórica permanente do servidor.

### Pilares do Jogo

- **Combate Técnico (*Fighting Game Feel*):** foco em leitura, precisão, posicionamento, *frame data* e expressão de habilidade mecânica.
- **Mundo Aberto Persistente e Cidades Dinâmicas:** assentamentos mudam de estado (`peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`), impactando rotas, contratos e controle territorial.
- **Povos, Linhagens e Culturas Originais:** visão de longo prazo para ~26 povos com identidade própria de mundo, divididos entre raças, linhagens e culturas jogáveis.
- **Facções, Reputação e *Bounty*:** relações políticas persistentes, reputação por facção, sistema de *Bounty* positivo (reconhecimento heroico) e negativo (procurado/hostil), além de histórico social e criminal.
- **Títulos e Memória Histórica:** conquistas, feitos históricos, reputação e eventos únicos registrados de forma auditável no servidor.
- **Ecossistema Vivo e Invasões PvE:** famílias de criaturas com hierarquias próprias, comandantes, *world bosses* e diretor de eventos mundiais.
- **Economia Regional, *Crafting* e Guildas:** economia rastreável baseada em *ledger*, contratos de reconstrução, *crafting*, comércio regional, *loot* individual, guildas, casas e fazendas.

---

## Modos Competitivos Planejados

O cenário competitivo do ASCENDRA prevê duas filas distintas disputadas em formato **MD3 (Melhor de 3)**:

| Modo | Proposta Mecânica |
| :--- | :--- |
| **Legacy Ranked** | Combate competitivo estruturado utilizando a identidade e progressão consolidada do personagem dentro das regras de balanceamento ranqueado. |
| **Genesis Ranked** | Formato competitivo em que a *build* é construída do zero ao longo da série, intercalando mini arenas PvE, *loot* temporário, mercador e progressão tática entre *rounds*. |

---

## Arquitetura do Projeto e Divisão de Domínios

O backend é estruturado como um **Monólito Modular orientado a *Bounded Contexts* (DDD)**, priorizando integridade transacional, idempotência de eventos, migrações versionadas e contratos explícitos entre módulos.

O desenvolvimento ocorre de forma assíncrona por frentes especializadas com fronteiras claras de *ownership*:

### `CARBON` — Persistência de Mundo, Sociedade e Economia
- Cidades, estados de assentamentos e contratos de reconstrução
- Facções e relações diplomáticas persistentes
- Reputação, *Bounty* (+/-), fama e histórico criminal/social
- Títulos, histórico de títulos e memória histórica do servidor
- Cadastro de povos, raças, linhagens e culturas
- Economia regional (*ledger* auditável) e recompensas persistentes

### `NEON` — Simulação, IA e Eventos Mundiais
- Simulação ativa do ecossistema e mundo aberto
- Comportamento de criaturas e IA de monstros
- Motor de invasões, cercos, comandantes e *world bosses*
- Diretor/orquestrador de eventos mundiais e validação de contribuições PvE

### `CORE / COMBAT & NETCODE` *(Em definição de contratos)*
- Motor de combate principal, física/colisão de *hitboxes* e *netcode/rollback*
- *Matchmaking*, MMR e orquestração das partidas *Legacy Ranked* e *Genesis Ranked*

### `SHARED` — Contratos Coordenados
- Envelopes e schemas versionados de eventos (`contracts/`)
- Identificadores globais canônicos e versionamento entre contextos delimitados

---

## Fluxo de Desenvolvimento (Git & Branches)

- **`main`:** branch principal protegida — recebe código exclusivamente via **Pull Request** revisado e com verificações passando.
- **Branches de funcionalidade:** todo desenvolvimento ocorre em branches isoladas por frente/escopo:
  - `feature/carbon-<escopo>`
  - `feature/neon-<escopo>`
  - `docs/<escopo>` / `fix/<escopo>`
- **Contratos compartilhados:** alterações em schemas de eventos ou interfaces entre frentes devem ser retrocompatíveis ou versionadas, acompanhadas de documentação de handoff em `docs/handoff/`.

---

## Segurança e Integridade

- O servidor é a **única autoridade** sobre estado de mundo, moedas, recompensas, *bounty*, inventário, títulos e ranqueamento.
- Nenhum arquivo `.env` real, segredo, chave privada ou credencial deve ser versionado no repositório (utilizar apenas `.env.example` com valores fictícios).

---

## Status do Repositório

🚧 **Em desenvolvimento ativo (Fundação de Arquitetura & Primeiras Vertical Slices)** — Repositório privado.
