# ADR CARBON-0006: Itemização Versionada, Geração Procedural Determinística em Inteiros e Anti-Duping Transacional

- **Status:** Accepted (CARBON Domain) / Proposed Wire (`EquipmentSnapshotProposalV1`)
- **Data:** 2026-11-27
- **Domínio:** CARBON (`src/modules/inventory/`, `src/modules/characters/`, `migrations/0006..0007`)
- **Sessão:** CARBON Engineering Session 04 (`carbon/inventory-equipment-engine`)

## 1. Contexto

O ASCENDRA exige um sistema persistente de inventário, equipamentos, raridades, afixos procedurais, durabilidade, vinculação (*binding*) e *loadouts* capaz de sustentar:
1. Liberdade de *builds* emergentes (ex.: Cavaleiro Arcano, Anão Mercador, Orc Arcanista) sem classes fixas.
2. Identidade individual persistente de cada equipamento gerado no mundo (sem que duas *Espadas de Ironfang* precisem compartilhar os mesmos atributos ou histórico).
3. Integridade econômica rigorosa sob concorrência real no PostgreSQL, impedindo duplicação de itens (*duping*) em *retries*, *boss drops*, divisões de pilhas (*stacks*), trocas de armas de duas mãos ou transferências simultâneas.
4. Determinismo auditável sem ponto flutuante e isolamento absoluto contra itens temporários do modo competitivo *Genesis Ranked*.

## 2. Decisões Arquiteturais

### 2.1 Separação Estrita entre `ItemDefinition` Versionada e `ItemInstance` / `InventoryStack`
- **`item_definitions (definition_code, definition_version)`:** Catálogo imutável por versão. Alterações estruturais exigem publicar `definition_version + 1` via `registerItemDefinition`, preservando intactas todas as instâncias geradas em versões anteriores.
- **`item_instances (id UUID)`:** Equipamentos, ferramentas, relíquias e cosméticos não empilháveis. Possuem estado próprio (`rarity_code`, `quality_bp`, `implicit_attributes`, `generated_attributes`, `item_instance_affixes`, `current_durability`, `binding_state`, `origin_type`, `generation_seed_hash` e `instance_version`).
- **`inventory_stacks (id UUID)`:** Recursos e consumíveis empilháveis (`stackable = TRUE`, sem estado individual de durabilidade ou afixos procedurais), agrupáveis exclusivamente quando compartilham a mesma `stack_equivalence_key` (`definitionCode + definitionVersion + qualityBp + bindingState + boundTarget`).

### 2.2 Geração Procedural Determinística 100% Inteira (`SplitMix64`)
- Nenhum cliente pode informar *seed*, raridade, qualidade ou modificadores.
- A *seed* canônica é derivada no servidor via SHA-256 sobre `ascendra:itemgen:v1|definitionCode|definitionVersion|rulesVersion|itemLevel|rarityCode|originReference|serverSeed`, alimentando um gerador `SplitMix64` puro em `BigInt` (`64 bits`, rejeição uniforme sem *modulo bias* e zero `Math.random` ou ponto flutuante).
- Qualidade (`quality_bp` em `0..10000` *basis points*) é ortogonal à raridade (`common..relic`): um item *Raro* de alta qualidade pode superar em rolagens específicas um *Épico* mal rolado, sem que raridade substitua habilidade mecânica.
- Efeitos especiais em `Epic+` (`special_effect_definitions`) são puramente declarativos (identificador + parâmetros inteiros); nenhuma string de código executável é armazenada ou avaliada.

### 2.3 Localização Autoritativa Única e *Loadouts* por Ponteiro Seguro
- Cada `ItemInstance` possui exatamente um `location_state` (`in_container`, `equipped_active` ou `destroyed`) validado por `CHECK` constraint e *triggers* cruzadas (`fn_enforce_container_slot_integrity`) entre `item_instances` e `inventory_stacks`.
- *Loadouts* inativos armazenam referências validadas (`equipment_loadout_slots`) para instâncias pertencentes ao personagem sem duplicar linhas físicas. Ao transferir ou destruir um item, todas as referências em *loadouts* inativos do remetente são purgadas na mesma transação ACID.

### 2.4 Requisitos Intrínsecos Não Circulares e Equipamento Quebrado
- Requisitos de equipamento (`required_level` e `required_attributes`) são verificados exclusivamente contra `character.baseAttributes + character.allocatedAttributes`, impedindo *self-buffing* circular entre equipamentos.
- Itens com `current_durability = 0` ou cujos requisitos deixem de ser atendidos após um *respec* não são destruídos nem deletados, mas têm `isActiveForCombat = false`, sendo suprimidos de `CharacterSnapshotV1.equippedItems` e de `equipmentModifiers` até reparo ou realocação.

### 2.5 Camadas Anti-Duping e Ordenação Canônica de Locks
- **Idempotência de entrada:** `processed_events` com *fingerprint* canônico SHA-256 (`InboxIdempotencyConflictError` em colisão divergente).
- **Unicidade de recompensa:** `UNIQUE (source_event_id, recipient_character_id, reward_slot_index)` em `item_grants`.
- **Concorrência:** `SELECT ... FOR UPDATE` em ordem lexicográfica ascendente de UUIDs de personagens, containers, *stacks* e instâncias, combinado com verificação otimista de `instance_version`, `stack.version` e `character.build_version`.
- **Trilha de auditoria:** `item_operation_ledger` registra sequencialmente (`ledger_seq BIGSERIAL`) toda concessão, movimentação, *split*, *merge*, equipagem, desgaste, reparo, ativação de *loadout*, transferência e destruição.

### 2.6 Compatibilidade com `CharacterSnapshotV1` e Proposta `EquipmentSnapshotProposalV1`
- `CharacterSnapshotV1.equippedItems` passa a ser populado em transação `REPEATABLE READ READ ONLY` sem quebrar consumidores `v1`.
- Propõe-se ao NEON o contrato complementar `contracts/neon-carbon/equipment-snapshot.v1.schema.json` (`EquipmentSnapshotProposalV1`) para transporte explícito de modificadores procedurais agregados e referências passivas declarativas.

## 3. Consequências
- **Positivas:** Zero risco de itens duplicados sob corridas concorrentes; evolução segura de catálogo por versão; reprodutibilidade bit-a-bit de lotes procedurais; compatibilidade integral com `CharacterSnapshotV1`.
- **Limitações Conhecidas:** A interpretação em combate dos efeitos passivos declarativos e dos atributos de equipamento depende de integração futura com o motor em Go do NEON; parâmetros numéricos de orçamento e pesos (`dev_itemgen_v1`) são provisórios de desenvolvimento.
