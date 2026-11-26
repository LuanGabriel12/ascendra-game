# CARBON — Sistema de Dez Atributos, Orçamento, Presets Emergentes e Respec

## 1. Os Dez Atributos Fundamentais (`PRIMARY_ATTRIBUTE_KEYS`)

| Código | Nome | Papel Conceitual |
| :--- | :--- | :--- |
| `strength` | Força | Poder físico e armas pesadas |
| `fortitude` | Fortitude | Vida e resistência estrutural |
| `vigor` | Vigor | Stamina e recuperação física |
| `agility` | Agilidade | Mobilidade e reposicionamento |
| `dexterity` | Destreza | Precisão e domínio técnico de armas |
| `intelligence` | Inteligência | Poder arcano e construtos |
| `wisdom` | Sabedoria | Mana, cura e eficiência mágica |
| `determination` | Determinação | Resistência a efeitos negativos e guarda |
| `luck` | Sorte | *Loot* e fabricação (jamais define vitória aleatória em Ranked) |
| `charisma` | Carisma | Influência social, facções e economia |

---

## 2. Separação de Camadas e Conservação de Orçamento

- **`BaseAttributes` (`character_attributes.base_*`)**: pontos iniciais definidos pela regra vigente (`5` em cada um dos 10 atributos = `50` pontos base na `dev_standard_v1`).
- **`AllocatedAttributes` (`character_attributes.alloc_*`)**: pontos inteiros não negativos efetivamente distribuídos pelo jogador.
- **`EffectiveAttributes` (calculados em runtime)**: soma de `Base + Allocated` (e futuramente modificadores de equipamentos/condições). Valores derivados **não** são gravados como colunas redundantes independentes no banco.

### Parâmetros Provisórios de Desenvolvimento (`rules_version = 1`)
- Orçamento alocável na criação: `50` pontos (orçamento inicial total = `100`).
- Teto por atributo efetivo antes de equipamentos: `30` (`5` base + até `25` alocados).
- Lei de conservação garantida na aplicação e no PostgreSQL:
  `allocated_attribute_points + unspent_attribute_points = earned_attribute_points`.

---

## 3. Classes Emergentes e Presets Opcionais (`BUILD_ARCHETYPE_PRESETS`)

Não existem classes obrigatórias. Nove *presets* opcionais demonstram especializações emergentes respeitando exatamente os mesmos `50` pontos alocáveis e o teto `30`:
`berserker`, `paladin`, `assassin`, `arcanist`, `necromancer`, `monk`, `blacksmith`, `merchant` e `arcane_knight`.

### Recursos Secundários Preparatórios (`computeDevPreviewSecondaryResources`)
Função isolada (`dev_preview_v1`) para inspeção de `Health`, `Mana`, `Stamina`, `Guard` e `Focus` em simulações de playtest — fórmulas definitivas de combate, *frame data*, *hitstun* e crítico permanecem pendentes de contrato conjunto com o NEON.

---

## 4. Redistribuição de Atributos (`respecAttributes`)

- Zera `AllocatedAttributes` e devolve integralmente `earned_attribute_points` para `unspent_attribute_points`.
- Incrementa `build_version` e `snapshot_version`, gravando auditoria imutável em `character_build_history` e emitindo `CharacterAttributesReset` + `CharacterBuildChanged` no Outbox.
- Rejeita execução duplicada por `commandId` (`duplicate_idempotent`), rejeita `expectedBuildVersion` obsoleta (`CharacterBuildConflictError`) e bloqueia redistribuição unilateral quando `competitive_lock_state = 'in_ranked_series'`.
