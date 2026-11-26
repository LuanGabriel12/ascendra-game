# NEON → CARBON CONTRACT REQUEST

**Versão:** `v0.1-proposed`  
**Status:** `Proposed` (aguardando alinhamento com CARBON)  
**Origem:** NEON (Simulação de Mundo / World Director / Validação de Contribuição)  
**Destino:** CARBON (Domínio Persistente de Cidades, Recompensas, Reputação, Bounty e Economia)

---

## Contexto

O núcleo de simulação headless do NEON (World/Event Director e motor de invasões) precisa:
1. consultar dados mínimos de um `Settlement` para inicializar e conduzir uma invasão sem duplicar a entidade persistente;
2. entregar o resultado validado de contribuição de jogadores em eventos mundiais para que o CARBON decida e persista quaisquer consequências econômicas, de reputação, Bounty, títulos ou reconstrução.

O NEON **não** criará tabelas, schemas de banco nem regras persistentes desses domínios. No Ciclo 1, ambas as fronteiras são exercitadas via adapters in-memory (`internal/adapters/memory`).

---

## Contrato 1 — Leitura de Settlement (`SettlementReader`)

### Interface necessária

```go
type SettlementReader interface {
    GetSettlementSnapshot(settlementID string) (SettlementSnapshot, error)
}
```

### Motivo

Permitir que o World Director inicie simulações de ameaça e invasão a partir da fonte de verdade do CARBON sem importar o modelo persistente completo de cidades, economia regional ou reconstrução.

### Campos necessários (`SettlementSnapshot`)

- `SettlementID` (`string`): identificador único e estável da cidade.
- `RegionID` (`string`): identificador único e estável da região à qual a cidade pertence.
- `DefenseState` (`SettlementDefenseState` — enum lógico: `Secure`, `Fortified`, `Damaged`, `Captured`): estado defensivo atual relevante para a simulação.
- `MaxDefenseHP` (`int64`): capacidade máxima de integridade defensiva da cidade para a simulação (`> 0`).

### Semântica

- Operação somente leitura, sem efeitos colaterais.
- O snapshot retornado representa o estado inicial no momento da consulta; a simulação do NEON evolui seu próprio estado lógico temporário em memória e nunca muta o banco do CARBON diretamente.

### Invariantes

- `SettlementID` e `RegionID` não podem ser vazios.
- `MaxDefenseHP` deve ser estritamente positivo (`> 0`).
- `DefenseState` deve pertencer ao conjunto de estados reconhecidos pelo contrato.

### Idempotência

- Naturalmente idempotente (leitura pura).

### Erros possíveis

- `ErrSettlementNotFound`: `SettlementID` inexistente na fonte de verdade do CARBON.
- `ErrInvalidSettlementSnapshot`: dados persistidos violam invariantes mínimas (ex.: `MaxDefenseHP <= 0` ou `RegionID` vazio).

### Ownership

- **Fonte de verdade e persistência**: CARBON.
- **Consumo na simulação em tempo real**: NEON.

---

## Contrato 2 — Entrega de Contribuição Validada (`ContributionSink`)

### Interface necessária

```go
type ContributionSink interface {
    RecordContribution(result ContributionResult) error
}
```

### Motivo

Separar estritamente a **validação autoritativa de gameplay** (NEON) da **persistência e concessão de recompensas/reputação/Bounty/títulos** (CARBON).

### Campos necessários (`ContributionResult`)

- `EventID` (`string`): identificador único, estável e determinístico da emissão de contribuição (ex.: `sim:<simulation_id>:inv:<invasion_id>:contrib:<player_id>`).
- `SimulationID` (`string`): identificador da instância de simulação.
- `InvasionID` (`string`): identificador da invasão encerrada.
- `SettlementID` (`string`): cidade alvo da invasão.
- `Tick` (`uint64`): tick lógico em que a contribuição foi fechada/validada.
- `PlayerID` (`string`): identificador estável do jogador contribuinte.
- `Damage` (`int64`): dano total autoritativo validado contra forças invasoras (`>= 0`).
- `Support` (`int64`): pontuação autoritativa de suporte defensivo validada (`>= 0`).
- `Objectives` (`int64`): quantidade de objetivos defensivos concluídos (`>= 0`).
- `Eligible` (`bool`): indica se o jogador atingiu o critério mínimo de gameplay para elegibilidade (a decisão de *qual* recompensa conceder pertence exclusivamente ao CARBON).
- `Outcome` (`InvasionOutcome` — `Defended` ou `Captured`): desfecho autoritativo da invasão.

### Semântica

- Emitido pelo NEON somente quando a invasão atinge o estado terminal `Resolved`.
- A chamada **não** concede ouro, itens, Bounty, reputação ou títulos dentro do NEON; apenas entrega o fato autoritativo validado ao domínio do CARBON.

### Invariantes

- `EventID`, `SimulationID`, `InvasionID`, `SettlementID` e `PlayerID` não podem ser vazios.
- `Damage >= 0`, `Support >= 0`, `Objectives >= 0`.
- Nenhum jogador pode receber emissão com valores negativos ou overflow.
- Para uma mesma combinação `(SimulationID, InvasionID, PlayerID)`, o NEON emite no máximo um `ContributionResult` terminal com `EventID` estável.

### Idempotência

- **Obrigatória por `EventID`**: se o mesmo `EventID` for entregue novamente (ex.: retry de transporte/worker futuro), o CARBON deve reconhecer a duplicidade e **nunca** aplicar recompensas/reputação/Bounty duas vezes.
- Retorno esperado para duplicata: `ErrDuplicateContribution` (ou no-op idempotente acordado — ver questões abertas).

### Erros possíveis

- `ErrInvalidContribution`: violação de invariante nos campos obrigatórios ou valores negativos.
- `ErrDuplicateContribution`: `EventID` já processado anteriormente.

### Ownership

- **Validação de gameplay e geração do `ContributionResult`**: NEON.
- **Deduplicação persistente, histórico, recompensas, reputação, Bounty e economia**: CARBON.

---

## Questões abertas para alinhamento NEON ↔ CARBON

1. Para entrega duplicada de `EventID` em `ContributionSink`, CARBON prefere retornar `ErrDuplicateContribution` explícito ou tratar silenciosamente como sucesso idempotente (no-op)?
2. CARBON precisa também de um evento/callback separado para o resultado da cidade (`SettlementDefended` / `SettlementCaptured`) atualizar o estado persistente do `Settlement` e disparar contratos de reconstrução?
3. Quando evoluirmos para o ciclo de combate/PvP/Ranked, quais campos mínimos de `CharacterSnapshot` (atributos e loadout) CARBON fornecerá ao NEON?
4. Há preferência do CARBON por contratos em Go no mesmo monorepo (monólito modular inicial) ou por contratos serializados (ex.: Protobuf) entre processos independentes?
