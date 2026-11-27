# Weapon Mastery Engine (`src/modules/skills/`)

## 1. As 22 Famílias de Armas + Combate Desarmado

O motor de maestria reutiliza exatamente os identificadores canônicos de `WEAPON_SUBCATEGORIES` (`src/modules/inventory/domain/item-types.ts`) sem alterá-los, adicionando `'unarmed'` como 23º código explícito de proficiência marcial em `MASTERY_WEAPON_FAMILIES`:

1. `short_sword` (Espadas curtas)
2. `longsword` (Espadas longas)
3. `greatsword_2h` (Espadas de duas mãos)
4. `dagger` (Adagas)
5. `axe` (Machados)
6. `heavy_axe_2h` (Machados pesados)
7. `hammer` (Martelos)
8. `mace` (Maças)
9. `spear` (Lanças)
10. `halberd_2h` (Alabardas)
11. `scythe_2h` (Foices)
12. `katana` (Katanas)
13. `staff_2h` (Cajados)
14. `wand` (Varinhas)
15. `grimoire` (Grimórios)
16. `gauntlets` (Manoplas)
17. `claws` (Garras)
18. `bow_2h` (Arcos)
19. `crossbow_2h` (Bestas)
20. `shield` (Escudos)
21. `dual_blades_2h` (Armas duplas)
22. `magic_catalyst` (Catalisadores mágicos)
23. `unarmed` (Combate desarmado — proficiência marcial adicional)

Cada personagem desenvolve maestrias independentes por família, sem qualquer bloqueio ou bônus imposto por raça ou linhagem.

---

## 2. Curva Provisória de Maestria (`1..100`) e Faixas Conceituais

A experiência de maestria é completamente separada da experiência geral do personagem (`characters.experience_total`). Para alcançar o nível $L \in [1, 100]$ na regra provisória `dev_skills_mastery_v1` (`xp_curve_base = 100`, `xp_curve_linear = 45`, `xp_curve_quadratic = 12`):

$$\text{XP}_{\text{cum}}(1) = 0, \qquad \text{XP}_{\text{cum}}(L) = \sum_{k=1}^{L-1} \left(100 + 45k + 12k^2\right)$$

### Faixas Conceituais Provisórias (`proficiency_rank`)
- `novice` (*Iniciante*): níveis `1..9`
- `apprentice` (*Aprendiz*): níveis `10..24` (`XP(10) = 6.345`)
- `practitioner` (*Praticante*): níveis `25..49` (`XP(25) = 73.500`)
- `specialist` (*Especialista*): níveis `50..74` (`XP(50) = 550.225`)
- `master` (*Mestre*): níveis `75..94` (`XP(75) = 1.805.050`)
- `grandmaster` (*Grão-Mestre*): níveis `95..100` (`XP(100) = 4.197.450`)

> **Nota:** Estes valores são *fixtures* de desenvolvimento e não constituem balanceamento definitivo de produção.

---

## 3. Concessão Autoritativa e Prevenção de Farming

- **Autoridade Exclusiva:** `grantWeaponMasteryExperience` aceita apenas `AuthorityPrincipal.kind === 'internal_system_authority'`. Clientes autenticados nunca enviam XP diretamente.
- **Idempotência e Conflitos:** Deduplicação em `processed_events` por `grantId` + fingerprint canônico SHA-256 (`duplicate_idempotent` em retries idênticos; `InboxIdempotencyConflictError` em divergências semânticas).
- **Bloqueio de Duplicação Multi-Arma:** `UNIQUE (source_event_id, character_id)` em `mastery_experience_grants` impede que o mesmo evento de combate credite XP simultaneamente em múltiplas famílias de armas para o mesmo personagem.
- **Anti-Alt-Farming:** Rejeita concessões quando `counterpartyCharacterId` pertence ao mesmo `account_id` do personagem beneficiado (`MasteryAntiFarmingRejectedError`).
- **Cooldown, Janela e Retornos Decrescentes:** Suporta aplicação opcional de *cooldown* (`30s`), teto por janela (`8` concessões/hora) e redução progressiva (`2000 bp` por concessão prévia na janela, respeitando piso mínimo de `1` XP).
- **Limitações Honestas:** O CARBON valida apenas fatos persistentes disponíveis; a validação física de participação em combate (evitar ataques no vazio ou conluio comportamental em tempo real) cabe ao simulador autoritativo do **NEON**.
