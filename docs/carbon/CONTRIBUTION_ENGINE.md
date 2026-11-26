# CARBON — Contribution Engine, SettlementSnapshot & CharacterSnapshot Proposal

## 1. Visão Geral do Contribution Engine (`src/modules/contributions/`)

O bounded context `contributions` persiste de forma autoritativa e idempotente os registros `ContributionResult` emitidos pelo motor determinístico do NEON (`internal/ports/carbon.go`) quando uma invasão atinge o estado terminal `Resolved`.

### Princípio Fundamental de Domínio
Um `GameplayContribution` representa **exclusivamente o fato validado da participação de um jogador em uma invasão encerrada**. Ele **não** concede nem autoriza quantidades arbitrárias de ouro, itens, *Bounty*, títulos ou reputação na entrada — essas consequências pertencerão a políticas próprias dos domínios econômicos/sociais do CARBON consumindo o evento interno `ContributionRecorded` a partir de `outbox_events`.

---

## 2. Modelo Persistente (`migrations/0003_gameplay_contributions.up.sql`)

Tabela `gameplay_contributions`:
- `id` (`UUID PRIMARY KEY`): identificador persistente interno do CARBON.
- `processed_event_id` (`UUID NOT NULL UNIQUE REFERENCES processed_events(event_id)`): vínculo transacional estrito com o Inbox.
- `external_event_id` (`VARCHAR(255) NOT NULL UNIQUE`): `EventID` original do NEON preservado sem truncamento (ex.: `sim:s1:inv:inv1:contrib:player-kael`).
- `contract_version` (`INTEGER NOT NULL DEFAULT 1`, `>= 1`).
- `simulation_id`, `invasion_id`, `settlement_ref`, `player_id` (`VARCHAR(128) NOT NULL`, não vazios).
- `resolved_settlement_id` (`UUID NULL REFERENCES settlements(id) ON DELETE RESTRICT`): preenchido quando o assentamento já existe no cadastro persistente do CARBON.
- `simulation_tick` (`NUMERIC(20, 0) NOT NULL`): preserva toda a faixa `uint64` (`0 .. 18446744073709551615`, `scale = 0`).
- `damage`, `support`, `objectives` (`BIGINT NOT NULL`): preservam a faixa não negativa `int64` (`0 .. 9223372036854775807`).
- `eligible` (`BOOLEAN NOT NULL`).
- `outcome` (`VARCHAR(32) NOT NULL CHECK (outcome IN ('Defended', 'Captured'))`).
- `payload_fingerprint` (`VARCHAR(80) NOT NULL`): hash canônico `fp:v1:<sha256>`.
- `received_at`, `recorded_at` (`TIMESTAMPTZ NOT NULL`): carimbos de parede do CARBON, estritamente separados do `simulation_tick` determinístico do NEON.
- **Unicidade lógica:** `UNIQUE (simulation_id, invasion_id, player_id)` impede que dois `EventID`s distintos registrem duas contribuições terminais para o mesmo jogador na mesma invasão.

### Dependências de Identidade Ainda Não Implementadas
Conforme diretriz de arquitetura, **não foram criadas tabelas fictícias de contas ou personagens** apenas para satisfazer chaves estrangeiras:
- `player_id` permanece um identificador estável opaco (`VARCHAR(128)`) até a implementação dos agregados `Account` e `Character` no próximo ciclo do CARBON.
- `invasion_id` e `simulation_id` são chaves de correlação da simulação do NEON.

---

## 3. Projeção `SettlementSnapshot` (`migrations/0002` + `settlement-snapshot-query.ts`)

Para atender `SettlementReader.GetSettlementSnapshot(settlementID)` sem expor entidades internas do CARBON:
- A migração incremental `0002` adiciona `external_id`, `defense_state` (`Secure | Fortified | Damaged | Captured`) e `max_defense_hp` (`BIGINT > 0`) em `settlements`.
- **Backfill explícito:** registros pré-existentes da Session 01 recebem `external_id = id::text`, `defense_state` coerente com o estado atual (`occupied -> Captured`, `rebuilding -> Damaged`, demais `-> Secure`) e `max_defense_hp = 1000` (identificado explicitamente como **parâmetro provisório de desenvolvimento** alinhado às fixtures do NEON, não balanceamento final).
- `PostgresSettlementSnapshotReader.getSettlementSnapshot` executa consulta parametrizada somente leitura (por `external_id` ou `UUID`), valida invariáveis e projeta apenas `{ settlementId, regionId, defenseState, maxDefenseHp, version }`.

---

## 4. Proposta Preparatória: `CharacterSnapshot` (Cycle 03+)

Definida em `src/modules/peoples/domain/character-snapshot-proposal.ts` exclusivamente para alinhamento futuro com o NEON (sem congelar fórmulas de combate):
- **Identidade persistente:** `characterId`, `accountId`, `raceCode`, `lineageCode`, `cultureCode`, `originRegionId` (visão futura para ~26 povos originais; raça/linhagem/cultura **não** determinam moralidade, facção ou especialização).
- **10 Atributos Primários** (separados em `baseAttributes` e `allocatedAttributes`):
  `strength` (Força), `fortitude` (Fortitude), `vigor` (Vigor), `agility` (Agilidade), `dexterity` (Destreza), `intelligence` (Inteligência), `wisdom` (Sabedoria), `determination` (Determinação), `luck` (Sorte) e `charisma` (Carisma).
- **Metadados de progressão e competitividade:** `level`, `experienceTotal` (`bigint`), `buildVersion`, `snapshotVersion`, slots resumidos de equipamentos/habilidades futuras e perfil de normalização (`open_world_persistent`, `legacy_ranked_md3`, `genesis_ranked_md3_scratch`).
