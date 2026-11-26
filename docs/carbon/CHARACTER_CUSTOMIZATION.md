# CARBON — Customização Modular de Aparência (`character_appearance`)

## 1. Modelo Persistente de Sprites Modulares

A tabela `character_appearance` armazena identificadores canônicos validados contra catálogos versionados (`appearance_catalog_version = 1` em `src/modules/peoples/domain/appearance.ts`):

- **Slots obrigatórios:** `body_preset`, `skin_tone`, `eye_style`, `eye_color`.
- **Slots condicionais ao perfil do povo (`CustomizationProfile`):**
  - `hair_style` + `hair_color` (exigem par completo quando selecionados; desabilitados em povos escamados como `draconians`).
  - `beard_style` (habilitado em `humans`, `dwarves`, `orcs`; bloqueado em `elves`, `goblins`, `draconians`).
  - `ear_style` (restrito às orelhas válidas do povo, ex.: `long_batwing` para `goblins`, `pointed_long` para `elves`, `frilled_crest` para `draconians`).
  - `horn_style`, `tail_style` e `scale_pattern` (exclusivos de povos com suporte explícito no catálogo; `draconians` exigem `scale_pattern` obrigatório e bloqueiam humanos/elfos/anões/goblins/orcs de equiparem chifres, caudas ou escamas).
- **Coleções limitadas e ordenadas:** `tattoos` (máx. 3), `scars` (máx. 3), `cosmetic_accessories` (máx. 4) e `voice_profile` opcional.

---

## 2. Segurança e Neutralidade Competitiva

1. **Bloqueio de Injeção Cosmética:** todos os campos aceitam exclusivamente códigos alfanuméricos de catálogo (`^[a-z0-9][a-z0-9_-]{1,63}$`), rejeitando URLs (`http://`, `https://`, `data:`, `javascript:`), tags HTML/scripts (`<`, `>`) e caminhos de arquivo (`../`, `/`, `\`).
2. **Zero Impacto em Combate:** escolhas cosméticas não alteram *hitboxes*, alcance, atributos ou recursos em nenhum modo de jogo.
3. **Versionamento Otimista:** atualizações em `updateAppearance` incrementam `appearance_version`, validam `expectedAppearanceVersion` e emitem `CharacterAppearanceChanged` no Outbox.
