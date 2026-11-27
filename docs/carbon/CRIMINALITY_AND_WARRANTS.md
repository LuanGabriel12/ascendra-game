# Criminality, Jurisdictions & Arrest Warrants

## 1. Infrações Autoritativas (`criminal_records`)

Nove códigos de infração suportados (`OFFENSE_CODES`):
`UnlawfulAttack`, `UnlawfulKill`, `Theft`, `Robbery`, `Sabotage`, `Treason`, `ProtectedNPCViolation`, `SettlementAssault`, `Smuggling`.

- Apenas `internal_system_authority` pode registrar infrações (`SocialAuthorizationForbiddenError` para chamadas de contas de jogadores).
- Cada registro preserva `jurisdiction_id`, `settlement_id`, `faction_id`, `region_id`, `combat_context`, `severity` (`minor`, `moderate`, `major`, `capital`), `legal_status` (`suspected`, `confirmed`, `pardoned`, `sentence_served`), `moral_delta_applied`, `notoriety_fame_granted`, `source_event_id` (`UNIQUE`) e `evidence_reference`.

---

## 2. Jurisdições Orientadas a Dados (`criminal_jurisdictions`)

`evaluateIncidentUnderJurisdiction` avalia cada acontecimento conforme o perfil legal local (`civic_protected`, `martial_frontier`, `syndicate_shadow`, `lawless`):
- **Combate Legal vs Crime:** `consensual_duel`, `authorized_arena`, `recognized_faction_war` e `self_defense` são isentos quando permitidos pela jurisdição (`constitutesCrime = false`, zero mandado e zero penalidade moral).
- **Separação entre Lei Local e Moralidade:** `Smuggling` constitui infração estatutária local (`constitutesCrime = true`), mas aplica `moralDelta = 0` por padrão; já em regiões `lawless` (`jur-shadowfen-lawless`), não há crime cívico nem mandado de captura local, ainda que assassinatos confirmados mantenham peso moral negativo.
- **Suspeita vs Confirmação:** Eventos com `confirmationLevel = 'suspected'` colocam o personagem em `Suspected` (`safe_zone_access = 'monitored'`), sem penalidade moral e sem elegibilidade para mandado ou recompensa criminal.

---

## 3. Máquina de Estados Criminais, Zonas Seguras e Perdão

Estados suportados por `(character_id, jurisdiction_id)` em `character_jurisdiction_status`:
`Clear`, `Suspected`, `Wanted`, `Fugitive`, `Captured`, `ServingSentence`, `Pardoned`.

- **Decisões Persistentes para Zonas Seguras (`safe_zone_access`):**
  - `Clear` / `Pardoned` -> `permitted`
  - `Suspected` / `Captured` / `ServingSentence` -> `monitored`
  - `Wanted` / `Fugitive` -> `restricted_arrest_on_sight` (respeitando escopo estrito da jurisdição emissora, sem transformar automaticamente o alvo em procurado global).
- **Perdão Sem Apagar Histórico:** `resolveCriminalStatus(..., targetState: 'Pardoned')` encerra mandados ativos em `criminal_warrants` e restaura `safe_zone_access = 'permitted'`, marcando `criminal_records.legal_status = 'pardoned'` sem deletar nenhum registro original.
