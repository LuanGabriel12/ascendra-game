# ADR 0001 — Arquitetura Modular Monolith, Stack TypeScript/Node 24 e PostgreSQL Real

- **Status:** Accepted (Session 01 — CARBON)
- **Data:** 2026-11-26
- **Autor:** CARBON

---

## Contexto da Auditoria

Na auditoria inicial do repositório em `ascendra-game` (workspace vazio antes desta branch):
1. Não havia código-fonte de backend, banco de dados, migrações, contratos NEON, ADRs ou pipelines de CI existentes.
2. No ambiente de execução local (Windows):
   - **Disponíveis:** `Node.js v24.22.3`, `npm 11.19.1`, `Python 3.15.2`, `Git 2.55.0`.
   - **Ausentes no host:** `go`, `docker`, `psql` / servidor PostgreSQL instalado globalmente.

Era necessário selecionar uma base mínima, simples e reversível que permitisse validar **transações reais, constraints relacionais e concorrência (`SELECT ... FOR UPDATE`) contra PostgreSQL real** (sem substituir PostgreSQL por SQLite) tanto localmente quanto em CI.

---

## DECISION

Adotar um **Monólito Modular orientado a Bounded Contexts (DDD)** usando:
1. **Linguagem/Runtime:** **TypeScript (`strict: true`) sobre Node.js 24 LTS** (já nativo no ambiente).
2. **Banco de Dados:** **PostgreSQL 16 real** acessado via driver oficial `pg` (`node-postgres`) com SQL parametrizado explícito (sem ORM pesado).
3. **Execução de Testes de Integração:**
   - Em CI (GitHub Actions) ou Docker (`docker-compose.yml`): conecta via `DATABASE_URL` ao container oficial `postgres:16-alpine`.
   - Em ambiente local sem Docker: o harness de testes inicializa automaticamente um processo **PostgreSQL nativo real (`postgres.exe` / `postgres`)** via `embedded-postgres` em porta TCP efêmera, garantindo semântica idêntica de MVCC, `SELECT ... FOR UPDATE`, `ROLLBACK` e constraints (`UNIQUE`, `FOREIGN KEY`, `CHECK`).
4. **Migrações Versionadas:** arquivos SQL puros `.up.sql` e `.down.sql` em `migrations/`, controlados pela tabela `schema_migrations` com `pg_advisory_lock`.
5. **Validação de Fronteira:** `zod` alinhado aos contratos JSON Schema versionados em `contracts/events/`.
6. **Sem Brokers Prematuros:** nenhum Redis, Kafka, RabbitMQ ou Kubernetes foi introduzido; eventos internos pós-commit utilizam tabela `outbox_events` na mesma transação ACID.

---

## WHY

- **Fidelidade Transacional Real:** ao usar binário real do PostgreSQL nos testes locais e `postgres:16-alpine` no GitHub Actions, testamos bloqueios reais de linha (`SELECT ... FOR UPDATE`), isolamento transacional e códigos SQLSTATE (`23505`, `23503`, `23514`), evitando falsos positivos comuns em SQLite ou mocks em memória (`pg-mem`).
- **Zero Fricção Operacional:** `npm install && npm test` funciona imediatamente na máquina de desenvolvimento sem exigir privilégios de administrador, instalação global de runtimes adicionais ou Docker Desktop ativo.
- **Fronteiras Claras de Domínio:** cada contexto delimitado (`settlements`, `factions`, e contratos preparatórios `economy`, `social`, `titles`, `peoples`) possui separação explícita entre `domain`, `application` e `infrastructure`.

---

## ALTERNATIVES

1. **Go + `pgx/v5` + `golang-migrate` + Docker PostgreSQL**
   - *Prós:* excelente performance concorrente e preferência conceitual inicial sugerida.
   - *Motivo da não escolha imediata:* nem o compilador `go` nem o `docker` estavam instalados no ambiente auditado. Instalar toolchains globais fora do workspace adicionaria acoplamento ao host nesta primeira fatia vertical.
2. **Python 3.15 + SQLite (`sqlite3`)**
   - *Prós:* zero dependências externas.
   - *Motivo da rejeição:* SQLite utiliza lock de arquivo/escrita serializada e não suporta `SELECT ... FOR UPDATE` nem o mesmo comportamento de concorrência/isolamento do PostgreSQL, violando diretamente o requisito de testes de concorrência fiéis.
3. **TypeScript + ORM pesado (Prisma / TypeORM)**
   - *Prós:* geração rápida de queries básicas.
   - *Motivo da rejeição:* abstrai controle fino de locks (`FOR UPDATE`), dificulta portabilidade futura do schema e introduz DSL proprietária de migração.

---

## REVERSIBILITY

A decisão possui **alta reversibilidade** (custo de migração baixo caso a equipe opte futuramente por Go na camada de aplicação):
- **Schema 100% SQL Padrão PostgreSQL:** arquivos `.up.sql` / `.down.sql` em `migrations/` são diretamente compatíveis com `golang-migrate` ou `goose` sem qualquer alteração.
- **Contratos Independentes de Linguagem:** todos os contratos compartilhados com NEON estão especificados em JSON Schema (`contracts/events/*.schema.json`).
- **Arquitetura Hexagonal Enxuta:** a lógica da vertical slice está concentrada em menos de ~500 linhas desacopladas por portas (`ports.ts`), sem dependência de frameworks HTTP ou brokers externos.
