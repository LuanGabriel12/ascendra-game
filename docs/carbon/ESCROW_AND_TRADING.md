# CARBON Escrow & Bilateral Player Trading (`ESCROW_AND_TRADING.md`)

## 1. Escrow Monetário (`currency_reservations`)

Quando um jogador compromete moedas (`reserveFunds` ou oferta em negociação/recompensa criminal):
1. O valor é **imediatamente debitado** da `player_wallet` do jogador e **creditado** em `escrow_account` via lançamento real no ledger (`reserve_ledger_tx_id`), impedindo gasto duplo concorrente.
2. A reserva nasce em `status = 'Reserved'` (`consumed_amount = 0`, `released_amount = 0`).
3. `consumeReservation` ou `releaseReservation` faz `UPDATE ... WHERE id = $1 AND status = 'Reserved' AND version = $2` (`rowCount === 1`), garantindo que consumo e cancelamento concorrentes nunca ocorram duas vezes.

---

## 2. Custódia Física de Equipamentos e Materiais (`escrow_asset_holdings`)

- **Equipamentos Únicos (`item_instances`):** a migração `0013` estende `chk_item_instances_single_location` com `location_state = 'in_escrow'` (`container_id IS NULL AND container_slot_index IS NULL`). Enquanto em `'in_escrow'`, o item é purgado de *loadouts* inativos, protegido pelo índice parcial único `uq_escrow_active_item_instance` e bloqueado contra `equipItem`, `moveInventoryEntry`, `saveInactiveLoadout`, `activateLoadout`, `transferItemInstance`, `destroyItemInstance` e novo anúncio.
- **Materiais Empilháveis (`inventory_stacks`):** a quantidade reservada é fisicamente deduzida da pilha no contêiner do jogador e registrada em `escrow_asset_holdings` (`asset_kind = 'material_stack'`), preservando `quality_bp`, `binding_state` e `stack_equivalence_key` sem duplicar unidades.

---

## 3. Comércio Bilateral entre Jogadores (`PlayerTradingService`)

Fluxo transacional persistido em `trade_sessions` + `trade_offer_assets`:
1. `initiateTrade`: participante A cria sessão em `'PendingAcceptance'`.
2. `acceptTrade`: participante B aceita, movendo para `'Negotiating'` (`offer_version = 1`).
3. `setTradeParticipantOffer`: reserva moedas e ativos do participante, libera eventuais reservas anteriores daquele lado, incrementa `offer_version` e **zera `participant_a_confirmed_version` e `participant_b_confirmed_version`** (prevenção contra *bait-and-switch*). Rejeita itens `character_bound` e `non_tradable` (permitindo `account_bound`/`restricted` apenas entre personagens da mesma conta).
4. `confirmTradeOffer(expectedOfferVersion)`: rejeita versões obsoletas. Assim que **ambos** confirmam o mesmo `offer_version`, liquida moedas e entrega ativos na mesma transação PostgreSQL. Se o inventário de qualquer destinatário estiver cheio, lança `InventoryCapacityExceededError` com `ROLLBACK` total (zero perda de itens).
5. `cancelTrade`: idempotente; devolve reservas monetárias e ativos em custódia aos proprietários originais (com *fallback* seguro para `personal_storage` caso a mochila principal tenha enchido).
