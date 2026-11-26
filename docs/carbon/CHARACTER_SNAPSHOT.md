# CARBON — `CharacterSnapshot` v1 & Alinhamento de Integração com NEON

## 1. Finalidade e Evolução do Contrato

O arquivo `src/modules/peoples/domain/character-snapshot-proposal.ts` foi evoluído em `CharacterSnapshotV1` (mantendo o alias `CharacterSnapshotProposalV1` sem definições duplicadas) e implementado em `PostgresCharacterSnapshotReader` (`src/modules/characters/application/character-snapshot-query.ts`), acompanhado do schema formal `contracts/neon-carbon/character-snapshot.v1.schema.json`.

### Campos Projetados (`CharacterSnapshotWireV1`)
- Metadados de versão: `contract_version` (`1`), `snapshot_version`, `build_version`, `rules_version`.
- Identidade: `character_id` (`UUID`), `account_id` (**omitido por padrão**; incluído somente quando explicitamente solicitado por consumidor interno autorizado), `display_name`, `race_code`, `lineage_code`, `culture_code`, `background_code`, `origin_region_id`.
- Atributos e progressão: `level`, `experience_total` (string decimal canônica `int64`), `earned_attribute_points`, `allocated_attribute_points`, `unspent_attribute_points`, `base_attributes` (10 atributos) e `allocated_attributes` (10 atributos).
- Extensões futuras vazias por padrão (sem inventar dados inexistentes): `equipped_items: []`, `equipped_abilities: []`.
- Contexto competitivo: `normalization_profile` (`open_world_persistent` | `legacy_ranked_md3`).

---

## 2. Separação Arquitetural: *Legacy Ranked* vs *Genesis Ranked*

| Aspecto | Mundo Aberto / *Legacy Ranked* (MD3) | *Genesis Ranked* (MD3) |
| :--- | :--- | :--- |
| **Identidade e Aparência** | Persistentes do `Character` | Lê apenas identidade visual/cosmética original |
| **Atributos e Nível** | Projetados via `CharacterSnapshotV1` (sujeitos a perfil de normalização a acordar com NEON) | Criados do zero em memória na sessão da partida |
| **Itens, Ouro e XP** | Persistentes (CARBON) | Estritamente efêmeros à série MD3 |
| **Persistência de volta no CARBON** | Permitida apenas por eventos autorizados de mundo | **PROIBIDA (`GenesisTemporaryStatePersistenceForbiddenError`)** |

---

## 3. Matriz de Status da Integração NEON ↔ CARBON

- **Implementado no CARBON (Session 03):** persistência completa de `Account`/`Character`, catálogos, validação de nomes/aparência, alocação/respec transacional, XP autoritativo e projeção validada `CharacterSnapshotV1` + JSON Schema.
- **Proposta para Revisão do NEON:** adoção de `CharacterSnapshotWireV1` pelo futuro módulo de combate/PvP/bosses do NEON e definição conjunta das fórmulas de conversão dos 10 atributos em parâmetros determinísticos de combate.
- **Pendências Mantidas das Sessions 01–02 (Documentadas):**
  1. Autenticação mTLS/HMAC no transporte interprocessos NEON → CARBON.
  2. Worker de publicação/relay efetivo de `outbox_events` e política de retenção.
  3. Adoção de `duplicate_idempotent` no retry de lotes parciais de `DispatchContributions`.
  4. Inclusão de `capturing_faction_id` e `expected_settlement_version` opcional em `SettlementCaptured` e eventos terminais independentes de contribuições (`InvasionPrepared`, `InvasionStarted`, `SettlementDefended`).
  5. Mapeamento formal entre `player_id` de sessão do NEON e `character_id` persistente do CARBON.
  6. Execução local da suíte Go (`go test -race ./...`) bloqueada neste host Windows pela ausência do compilador Go (coberta pelo job `neon-go` no GitHub Actions).
