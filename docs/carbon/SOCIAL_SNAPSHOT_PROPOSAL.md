# `SocialStandingSnapshotV1` Proposal & Privacy Scopes

## 1. Independência frente ao `CharacterSnapshotV1`

Para preservar 100% de compatibilidade com consumidores existentes de `CharacterSnapshotWireV1`, o estado social é projetado em contrato dedicado somente leitura:
- **Leitor:** `PostgresSocialSnapshotReader` (`src/modules/social/application/social-snapshot-query.ts`), executado em transação `REPEATABLE READ READ ONLY`.
- **JSON Schema:** `contracts/neon-carbon/social-standing-snapshot.v1.schema.json`.
- **Validação Runtime:** `SocialStandingSnapshotWireV1Schema` (Zod), serializando `moral_bounty` (`SignedInt64Schema`) e `global_fame`/`regional_fame` (`NonNegativeInt64Schema`) como strings decimais canônicas de 64 bits.

---

## 2. Quatro Escopos de Visibilidade e Segurança

| Escopo (`projection_scope`) | Autorização Exigida | Regras de Exposição |
|---|---|---|
| `public_limited` | Qualquer `AuthorityPrincipal` autenticado | Expõe `moral_band`, `global_fame`, `equipped_title` e mandados públicos (`Wanted`/`Fugitive`). **Omite** `moral_bounty` exato, reputações detalhadas e investigações privadas em estado `Suspected`. |
| `self_character` | Dono da `AccountID` do personagem ou sistema | Inclui `moral_bounty` exato, `regional_fame`, `faction_reputations`, `settlement_reputations` e `criminal_status_summary`. |
| `internal_authorized` | Exclusivo `internal_system_authority` (NEON) | Projeção completa de gameplay para reconhecimento contextual de NPCs, sem vazar `account_id` ou notas administrativas. |
| `judicial_authority` | Exclusivo `internal_system_authority` | Filtra mandados ativos, estado criminal e `safe_zone_access` por `jurisdictionFilterId` para guardas e zonas seguras. |

---

## 3. Compatibilidade com Legacy Ranked e Isolamento Genesis Ranked

- **Legacy Ranked (`legacy_ranked_md3`):** Pode ler `SocialStandingSnapshotV1` para exibição visual de títulos conquistados, sem que Fama, *Bounty* ou Títulos alterem atributos ou fórmulas de combate.
- **Genesis Ranked (`genesis_ranked_md3_scratch`):** Estritamente bloqueado em todas as mutações e leituras persistentes (`GenesisTemporaryStatePersistenceForbiddenError`). Vitórias ou derrotas competitivas futuras terão eventos próprios e jamais geram crime ou *Bounty* moral automático.
