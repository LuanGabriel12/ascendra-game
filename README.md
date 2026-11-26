# ASCENDRA — Backend

Backend modular do **ASCENDRA**, um RPG multiplayer online 2D em pixel art de mundo aberto com combate técnico estilo *fighting game*, progressão persistente, cidades dinâmicas, facções, reputação, *bounty*, títulos, economia regional, invasões PvE e modos competitivos planejados (*Legacy Ranked* e *Genesis Ranked*).

O foco central da engenharia do projeto é **profundidade mecânica, consistência transacional, modelagem de domínio explícita e arquitetura evolutiva**.

---

## Sumário

1. [Arquitetura e Princípios](#1-arquitetura-e-princípios)
2. [Matriz de Ownership (CARBON & NEON)](#2-matriz-de-ownership-carbon--neon)
3. [Stack Atual e Reversibilidade](#3-stack-atual-e-reversibilidade)
4. [Estrutura do Repositório](#4-estrutura-do-repositório)
5. [Vertical Slice 01 (CARBON) — Estado Persistente de Assentamentos](#5-vertical-slice-01-carbon--estado-persistente-de-assentamentos)
6. [Como Executar Localmente](#6-como-executar-localmente)
7. [Migrações de Banco de Dados](#7-migrações-de-banco-de-dados)
8. [Contratos de Eventos Compartilhados](#8-contratos-de-eventos-compartilhados)
9. [Fluxo de Trabalho, Branches e Segurança](#9-fluxo-de-trabalho-branches-e-segurança)

---

## 1. Arquitetura e Princípios

O backend segue o padrão de **Monólito Modular orientado a Bounded Contexts (DDD)**:

- **Sem microserviços ou brokers prematuros:** fronteiras claras entre domínios no código (`domain`, `application`, `infrastructure`) sem introduzir Kafka, RabbitMQ, Redis ou Kubernetes antes de necessidade concreta.
- **Invariáveis reforçadas no banco de dados:** regras críticas de integridade (`PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY`, `CHECK`, `NOT NULL`) existem diretamente no PostgreSQL, nunca apenas na aplicação.
- **Idempotência obrigatória na fronteira:** todo evento externo pode ser reentregue sem causar duplicação ou corrupção de estado.
- **Atomicidade e Transactional Outbox:** mutações que alteram estado, memória histórica e eventos de saída ocorrem sempre dentro da mesma transação ACID.

---

## 2. Matriz de Ownership (CARBON & NEON)

O desenvolvimento do backend é dividido em branches independentes e Pull Requests coordenados entre dois agentes/frentes de engenharia (**CARBON** e **NEON**).

> **Nota:** `NEON` é o nome do agente responsável pela simulação e eventos mundiais — não tem relação com provedores externos de banco de dados.

| Frente | Escopo de Responsabilidade |
| :--- | :--- |
| **CARBON** | Persistência de cidades e estados de assentamentos (`Settlement`), facções e relações (`Faction`), memória histórica do servidor, reputação, *bounty* positivo/negativo, histórico criminal/social, títulos e histórico, raças/linhagens/culturas jogáveis (identidade original ASCENDRA), economia regional (ledger auditável), contratos de reconstrução e recompensas persistentes (`RewardGrant`). |
| **NEON** | Simulação ativa do mundo, comportamento de criaturas, IA de monstros, diretor/orquestrador de eventos mundiais, motor de invasões, combate PvE, bosses, comandantes e validação de contribuições de jogadores. |
| **SHARED / COORDENAÇÃO** | Schemas de eventos (`contracts/events/`), versionamento de envelopes, formato de IDs globais (`UUID`), estados canônicos de cidades, contratos de recompensa e payloads de contribuição de jogadores. |
| **Não Confirmado (Fora de Escopo Atual)** | Combate principal (*fighting core*), netcode/rollback, matchmaking, MMR, *Legacy Ranked* (MD3) e *Genesis Ranked* (MD3). |

Documentação detalhada: `docs/architecture/ownership-matrix.md`.

---

## 3. Stack Atual e Reversibilidade

- **Linguagem & Runtime:** TypeScript (`strict: true`) sobre **Node.js >= 22** (validado em Node.js 24 LTS).
- **Banco de Dados:** **PostgreSQL 16** acessado via driver `pg` (`node-postgres`) com SQL parametrizado explícito (sem ORM pesado).
- **Validação de Fronteira:** `zod` alinhado aos contratos JSON Schema (Draft 2020-12).
- **Testes de Integração com PostgreSQL Real:**
  - Em CI (GitHub Actions) ou via Docker Compose: executa contra `postgres:16-alpine` via `DATABASE_URL`.
  - Em desenvolvimento local sem Docker: o harness sobe automaticamente uma instância **PostgreSQL nativa real** em porta efêmera (`embedded-postgres`), garantindo testes fiéis de `SELECT ... FOR UPDATE`, `ROLLBACK` e códigos `SQLSTATE` (sem substituir PostgreSQL por SQLite).
- **Reversibilidade:** todas as migrações são arquivos `.up.sql` / `.down.sql` puros compatíveis com ferramentas como `golang-migrate` ou `goose`, e os contratos de eventos estão em JSON Schema neutro de linguagem (`docs/adr/0001-modular-monolith-and-stack.md`).

---

## 4. Estrutura do Repositório

```text
ascendra-game/
├── .github/workflows/ci.yml              # Pipeline CI com container real PostgreSQL 16
├── contracts/events/                     # JSON Schemas versionados (NEON <-> CARBON)
├── docs/
│   ├── adr/                              # Architecture Decision Records (ADRs)
│   ├── architecture/ownership-matrix.md  # Fronteiras CARBON / NEON / SHARED
│   └── handoff/carbon-session-01.md      # Handoff técnico entre sessões e agentes
├── migrations/                           # Migrações SQL versionadas (.up.sql / .down.sql)
├── src/
│   ├── adapters/neon/                    # Fakes/stubs de teste para eventos do NEON
│   ├── modules/
│   │   ├── factions/                     # Contexto delimitado de Facções
│   │   ├── settlements/                  # Vertical Slice 01: Estado e Histórico de Cidades
│   │   ├── economy/                      # Contrato preparatório de Ledger Auditável
│   │   ├── social/                       # Contratos separados: Reputation, Bounty, Fame, CriminalRecord
│   │   ├── titles/                       # Contratos preparatórios de Títulos
│   │   └── peoples/                      # Contratos preparatórios: Race, Lineage, Culture
│   ├── scripts/migrate.ts                # CLI de migrações (up / down / status)
│   └── shared/                           # Pool transacional, migrator, contratos e logger estruturado
├── tests/
│   ├── helpers/postgres-test-harness.ts  # Inicialização de PostgreSQL real para testes
│   └── integration/                      # Suíte de migração, rollback, idempotência e concorrência
├── .env.example                          # Variáveis de ambiente de exemplo (sem segredos)
├── docker-compose.yml                    # Serviço local opcional PostgreSQL 16
├── package.json
└── tsconfig.json
```

---

## 5. Vertical Slice 01 (CARBON) — Estado Persistente de Assentamentos

Implementa o fluxo autoritativo de mudança de estado político/militar de assentamentos a partir de eventos do NEON (`SettlementCaptured` e `SettlementLiberated`):

- **Estados iniciais suportados:** `peaceful`, `threatened`, `under_attack`, `occupied`, `rebuilding`.
- **Idempotência:** tabela `processed_events` com `PRIMARY KEY (event_id)` e `UNIQUE (idempotency_key)` usando `INSERT ... ON CONFLICT DO NOTHING RETURNING` na mesma transação. Reenvios sequenciais ou paralelos resultam em `duplicate_noop` seguro.
- **Concorrência:** lock pessimista por linha (`SELECT ... FROM settlements WHERE id = $1 FOR UPDATE`) + incremento monotônico de `version` + constraint `UNIQUE (settlement_id, settlement_version)` no histórico + guarda otimista opcional (`expected_settlement_version`).
- **Memória Histórica e Outbox:** cada transição válida persiste atomicamente o novo estado em `settlements`, o registro auditável em `settlement_history` e o evento `SettlementStateChanged` em `outbox_events`.

---

## 6. Como Executar Localmente

### Pré-requisitos
- **Node.js 22+** (recomendado Node.js 24 LTS) e `npm`.
- **Docker** é *opcional* para rodar os testes (se `DATABASE_URL` não estiver definido, os testes sobem um PostgreSQL real isolado automaticamente).

### Instalação, Verificação de Tipos, Testes e Build

```bash
# 1. Instalar dependências
npm install

# 2. Validar tipos TypeScript (modo estrito)
npm run typecheck

# 3. Executar testes de integração contra PostgreSQL real
npm test

# 4. Gerar build em dist/
npm run build
```

---

## 7. Migrações de Banco de Dados

Para rodar o banco persistente de desenvolvimento via Docker e aplicar migrações manualmente:

```bash
# Subir container PostgreSQL 16
docker compose up -d

# Copiar arquivo de exemplo de variáveis de ambiente
cp .env.example .env

# Aplicar migrações pendentes
npm run migrate:up

# Consultar migrações aplicadas
npm run migrate:status

# Reverter última migração (ambiente de desenvolvimento/teste)
npm run migrate:down
```

---

## 8. Contratos de Eventos Compartilhados

Os contratos propostos (v1) em `contracts/events/` utilizam envelope versionado:

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key": "capture:settlement-uuid:wave-01",
  "event_type": "SettlementCaptured",
  "version": 1,
  "occurred_at": "2026-11-26T12:00:00.000Z",
  "correlation_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "source": "neon.invasion-engine",
  "payload": {
    "settlement_id": "2d931510-d99f-494a-8c67-87feb05e1594",
    "capturing_faction_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  }
}
```

Qualquer mudança em schemas compartilhados deve evitar *breaking changes*, priorizar incremento de `version` e registrar impacto em `docs/handoff/`.

---

## 9. Fluxo de Trabalho, Branches e Segurança

- **Branches:** nunca commitar diretamente em `main`, `master` ou `develop`. Utilizar branches dedicadas por frente/funcionalidade (ex.: `feature/carbon-*`, `feature/neon-*`) e integrar via Pull Request.
- **Segurança:**
  - Nunca commitar `.env` reais, credenciais, chaves privadas ou tokens.
  - O servidor é sempre a fonte autoritativa para estado de mundo, moedas, recompensas, *bounty*, reputação, inventário e títulos — valores vindos de clientes nunca são confiáveis sem validação de domínio.
  - Logs estruturados redigem automaticamente campos sensíveis (`password`, `token`, `secret`, `database_url`).
