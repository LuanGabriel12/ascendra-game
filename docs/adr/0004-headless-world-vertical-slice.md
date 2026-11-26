# ADR-0004: Seleção do Vertical Slice Headless do Ciclo 1 (Prioridade B — World Simulation Harness)

- **Status**: `Proposed`
- **Data**: 2026-11-26
- **Owner**: NEON

## Contexto

No Ciclo 1, devemos entregar **um único** vertical slice headless que prove a fundação determinística, testável e autoritativa do backend sob responsabilidade do NEON:

- **Prioridade A (Combat Simulation Harness)**: aplicável quando já existe contrato ou núcleo de combate no repositório.
- **Prioridade B (World Simulation Harness)**: aplicável quando combate está fora de escopo imediato ou pendente de alinhamento de ownership/contrato.
- **Prioridade C (Somente contratos/bloqueio)**: aplicável quando há conflito com código existente.

Na auditoria inicial, o repositório estava vazio (sem contrato ou núcleo de combate existente), e a especificação de ownership classifica explicitamente o **núcleo genérico de combate e PvP** como área pendente de confirmação com o CARBON, enquanto **World/Event Director, motor de invasões, IA de criaturas e validação de contribuições** são 100% ownership primário do NEON.

## Decisão

Implementar a **Prioridade B — World Simulation Harness headless** neste Ciclo 1, cobrindo de ponta a ponta:

1. Leitura inicial de um `Settlement` seguro via `SettlementReader` (adapter in-memory);
2. Evolução de ameaça regional por ticks lógicos determinísticos;
3. Criação e movimentação/ataque de um grupo hostil dirigido por uma máquina de estados pura de IA (`Idle -> Patrol -> Advance -> Attack -> Retreat / Dead`);
4. Transições explícitas da máquina de estados de invasão (`Peace -> Threatened -> UnderAttack -> Resolved`) com rejeição de transições inválidas;
5. Validação autoritativa de ações defensivas de jogadores gerando `ContributionResult` com `EventID` estável entregue ao `ContributionSink` fake in-memory;
6. Resolução determinística em `SettlementDefended` ou `SettlementCaptured`;
7. Verificação formal de determinismo (`Run A == Run B`), `snapshot/restore` no tick `K`, execução de 1.000+ ticks sem relógio de parede, invariantes, rejeição de comandos inválidos, `race detector`, fuzzing e benchmarks de baseline.

## Alternativas

- **Implementar Prioridade A (Combat Simulation Harness) mesmo sem contrato**: descartada porque invadiria área de ownership ainda pendente de confirmação com o CARBON e exigiria inventar contratos de hit/hurtbox, atributos e stats ainda não aprovados.
- **Parar na Prioridade C sem slice executável**: descartada porque não há código conflitante no repositório e já podemos provar toda a fundação determinística (ticks, RNG seeded, fixed-point, snapshot/restore, checksum canônico, FSM e ports) dentro do domínio exclusivo do NEON.

## Consequências

- **Positivas**:
  - 100% dentro do ownership exclusivo do NEON (risco mínimo de conflito com CARBON).
  - Prova todos os fundamentos necessários tanto para simulação de mundo quanto para futuro combate/rollback (tick loop puro, snapshot/restore, checksum canônico, autoridade).
- **Negativas / Trade-offs**:
  - Combate lateral 2D (hitboxes, hurtboxes, hitstun, cooldowns de frame) permanece adiado até confirmação de ownership e contrato com o CARBON.

## Reversibilidade

**Alta.** A fundação de `internal/simulation` (RNG, checksum canônico, snapshot) é reutilizável diretamente quando o módulo de combate for aprovado no próximo ciclo.

## Questões abertas

1. Após alinhamento com CARBON, o Ciclo 2 abrirá o Combat Simulation Harness (60 ticks/s) sobre a mesma fundação de `internal/simulation`?
2. Quais regras futuras de escalonamento de ameaça regional e fases de boss/comandante entrarão no ciclo seguinte do World Director?
