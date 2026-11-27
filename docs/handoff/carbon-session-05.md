# Handoff CARBON — Session 05 (`carbon/reputation-bounty-titles-engine`)

- **Branch base (Session 04):** `carbon/inventory-equipment-engine` (`6e0b843c4e8a7be33ac6549655d589bbdd1e1a6d`)
- **Branch da Session 05:** `carbon/reputation-bounty-titles-engine`
- **Data:** 2026-11-27

---

## 1. Entregas da Session 05

1. **Migrações Incrementais `0008` e `0009`:**
   - `0008`: `social_rules_versions`, `social_regions`, `faction_relations` (propagação de 1 salto), `external_identity_links` + `external_identity_link_history`, `character_social_standing`, `character_regional_standing`, `character_reputations`, `social_standing_ledger` e *backfill* automático para personagens existentes.
   - `0009`: `criminal_jurisdictions`, `criminal_records`, `character_jurisdiction_status`, `criminal_warrants`, `criminal_bounties`, `criminal_bounty_claims` (`pending_economy_settlement`), `title_definitions`, `character_titles`, `character_title_history`, `title_exclusivity_claims`, `historical_social_records` e `contribution_recognitions`.
2. **`SocialEngineService` + Reconhecimento Contextual + Ponte `ContributionEngine`:**
   - Ortogonalidade completa entre *Moral Bounty* assinado (11 faixas + histerese + teto de crime grave), *Fame*, *Reputation* contextual, *Criminality*, *Criminal Bounty* financiado, *Titles* declarativos/condicionais/exclusivos e *World Recognition* sem viés racial.
   - Proteções contra *alt-farming* na mesma conta, *cooldowns*, limites por janela, retornos decrescentes, auto-reivindicação de recompensa e corridas concorrentes.
3. **`SocialStandingSnapshotV1` + 50 Cenários de Teste + Demo de 28 Etapas:**
   - Schema JSON `contracts/neon-carbon/social-standing-snapshot.v1.schema.json` + Zod alinhado em 4 níveis de visibilidade.
   - Demonstração reproduzível `npm run demo:session05` (28 etapas completas incluindo restart real do PostgreSQL).

---

## 2. Comandos de Reprodução

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run demo:session02
npm run demo:session03
npm run demo:session04
npm run demo:session05
```

---

## 3. Pendências de Integração e Divergências Registradas para Aprovação Conjunta

- **Divergência de Nomenclatura da 7ª Raridade de Itens (Session 04):** O design conceitual anterior mencionava *Divino* como sétima raridade, enquanto a Session 04 persistiu `relic` (*Relíquia*) em `item_rarities`. Conforme diretriz de governança, nenhum identificador persistente ou instância de equipamento foi renomeado unilateralmente nesta sessão; aguarda decisão conjunta CARBON/NEON/Design para eventual alias de exibição ou migração versionada.
- **Pendências Interprocessos NEON <-> CARBON Preservadas:** Transporte autenticado Go <-> TypeScript, *worker* de despacho do `outbox_events`, *retry* automático de contribuições, identidade persistente de facções invasoras, eventos terminais de cidades, vínculo em sessão de produção `PlayerID <-> CharacterID`, fórmulas definitivas de combate/efeitos especiais, normalização competitiva e economia monetária/*escrow* real.

---

## 4. Recomendações para Session 06 — Skills, Specialization & Weapon Mastery Engine

1. Modelar proficiências e maestrias nas **22 famílias de armas** (`WEAPON_SUBCATEGORIES` da Session 04) e árvores/habilidades desbloqueáveis vinculadas a `characters(id)` sem impor classes fixas obrigatórias.
2. Popular `equipped_abilities` já reservado em `CharacterSnapshotV1` (`EquippedAbilitySlotSummary`) mantendo compatibilidade com o contrato `v1`, e habilitar o título planejado `master_of_blades` quando os requisitos reais de maestria existirem.
3. Preservar o isolamento absoluto do modo *Genesis Ranked* (onde habilidades/builds da partida são montadas temporariamente sem gravar maestria persistente do mundo aberto).
