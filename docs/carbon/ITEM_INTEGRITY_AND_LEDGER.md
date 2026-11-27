# Item Integrity, Anti-Duping & Operation Ledger

## 1. Garantias Contra Duplicação (*Anti-Duping*)

O motor de inventário do CARBON aplica cinco barreiras independentes e complementares contra duplicação e perda de itens:

1. **Transactional Inbox com Fingerprint SHA-256 (`processed_events`):**
   - Toda operação recebe um identificador determinístico de comando/concessão.
   - Reentregas idênticas retornam `duplicate_idempotent` sem reaplicar mutações.
   - Reentregas com o mesmo ID e payload divergente disparam `InboxIdempotencyConflictError`.
2. **Unicidade de Recompensa por Evento (`item_grants`):**
   - A constraint `uq_item_grants_boss_reward_slot UNIQUE (source_event_id, recipient_character_id, reward_slot_index)` impede que dois comandos distintos concedam duas vezes o mesmo slot de recompensa de um *boss* ou evento mundial ao mesmo personagem.
3. **Estado de Localização Único (`item_instances.location_state`):**
   - Uma instância só pode estar em `'in_container'` (com `container_id` e `container_slot_index` não nulos), `'equipped_active'` (com container nulo) ou `'destroyed'`.
   - É impossível no schema SQL estar simultaneamente equipada como ativa e guardada em slot de mochila, ou ocupar dois slots.
4. **Ordenação Canônica de Locks Pessimistas + Controle Otimista de Versão:**
   - Em operações multi-entidade (`mergeStacks`, `activateLoadout`, `transferItemInstance`), personagens, containers, pilhas e instâncias são travados com `SELECT ... FOR UPDATE` em ordem lexicográfica ascendente de UUID, prevenindo *deadlocks*.
   - Toda atualização exige `WHERE id = $X AND version = $expectedVersion` (`instance_version`, `stack.version`, `character.build_version`). Em uma corrida dupla de transferência da mesma arma para dois destinatários (`Promise.all`), exatamente uma transação comita e a segunda falha com erro de propriedade/versão.
5. **Purga Transacional de Referências Inativas:**
   - `transferItemInstance` e `destroyItemInstance` invocam `purgeInactiveLoadoutReferencesForItem` dentro da mesma transação ACID, impedindo ponteiros órfãos em *loadouts* secundários do antigo dono.

---

## 2. Vinculação (*Binding*) e Regras de Transferência

| Política na Definição | Estado Inicial na Concessão | Após Equipar | Transferência Mesma Conta | Transferência Outra Conta |
|---|---|---|---|---|
| `unbound` | `unbound` | `unbound` | Permitida (se desequipado) | Permitida (se desequipado) |
| `bind_on_equip` | `bind_on_equip` | `character_bound` | Permitida **antes** de equipar; proibida após equipar | Permitida **antes** de equipar; proibida após equipar |
| `bind_on_pickup` | `character_bound` | `character_bound` | Proibida | Proibida |
| `character_bound` | `character_bound` | `character_bound` | Proibida | Proibida |
| `account_bound` | `account_bound` | `account_bound` | Permitida (`charA1 -> charA2`) | Proibida (`ItemBindingViolationError`) |

> **Invariante de Imutabilidade de Vínculo:** Uma transferência autorizada (`unbound`, `bind_on_equip` nunca equipado, ou `account_bound` intra-conta) **jamais** limpa ou reduz o `binding_state` do item.

---

## 3. Razão Contábil Imutável (`item_operation_ledger`)

A tabela `item_operation_ledger` registra em ordem estrita (`ledger_seq BIGSERIAL`) todas as operações econômicas relevantes:
- Tipos auditados: `grant`, `move`, `equip`, `unequip`, `split`, `merge`, `transfer`, `destroy`, `durability_loss`, `repair`, `loadout_activate`.
- Campos registrados: `operation_id`, `operation_type`, `character_id`, `counterparty_character_id`, `item_instance_id`, `stack_id`, `definition_code`, `definition_version`, `source_location`, `destination_location`, `quantity`, `entity_version`, `cause_reference`, `metadata` e `recorded_at`.
