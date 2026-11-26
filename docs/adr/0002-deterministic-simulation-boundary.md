# ADR-0002: Deterministic Simulation Boundary & Fixed-Point Units

- **Status**: `Proposed`
- **Data**: 2026-11-26
- **Owner**: NEON

## Contexto

A visão de ASCENDRA combina mundo vivo autoritativo (invasões, IA de criaturas, eventos mundiais) e combate técnico lateral de alta precisão (com alvo conceitual de 60 ticks/s e preparo futuro para eventual rollback). Para evitar desyncs, exploits de cliente e bugs não reproduzíveis, o núcleo de simulação precisa ser 100% determinístico, headless e autoritativo desde o primeiro ciclo.

## Decisão

1. **Fronteira funcional pura de avanço por tick**:
   - A simulação avança exclusivamente por passos discretos explícitos:
     `Step(state, commands, config) -> (nextState, events, error)`
   - `state` é imutável do ponto de vista do chamador (clonado profundamente antes de mutação interna, de modo que erros de validação jamais deixam estado parcialmente corrompido).
   - Nenhuma dependência de HTTP, banco de dados, UI, engine gráfica, filesystem ou relógio de parede (`time.Now()`).

2. **Tempo lógico vs tempo real**:
   - Todo timer, cooldown e duração é expresso em **ticks inteiros** (`uint64` para o relógio lógico, `int64` para durações/cooldowns).
   - O alvo conceitual futuro para combate é `60 ticks/s`, mas o núcleo não vincula regras a tempo real: testes executam milhares de ticks consecutivos o mais rápido possível.

3. **Representação numérica inteira / fixed-point (sem floats na lógica crítica)**:
   - Nenhum campo de estado, percepção de IA, cálculo de ameaça, posição, distância, HP, dano ou contribuição utiliza `float32` ou `float64`.
   - Unidades internas padronizadas:
     - **Posição / Distância (`WorldUnit`)**: inteiro `int64` representando `1/1000` de unidade espacial (miliunidades; ex.: `1000 = 1.000` unidade).
     - **Proporções / Percentuais (`BasisPoints`)**: inteiro `int64` em escala `0..10000` (`10000 = 100.00%`).
     - **Vida / Dano / Ameaça / Contribuição**: inteiros `int64` com saturação ou rejeição explícita de overflow/underflow.

4. **RNG determinístico serializável**:
   - Proibido uso de `math/rand` global.
   - Todo sorteio determinístico usa `simulation.DeterministicRNG` (SplitMix64 com estado explícito `uint64` armazenado dentro do próprio estado da simulação), garantindo continuidade exata após snapshot/restore.

5. **Ordem canônica e Checksum de diagnóstico**:
   - Coleções no estado lógico são mantidas em slices ordenadas por ID estável (`GroupID`, `PlayerID`) — jamais dependendo de iteração não ordenada de `map`.
   - O checksum (`SHA-256`) é computado sobre uma codificação binária canônica (big-endian, length-prefixed, campos fixos) exclusivamente do estado lógico, ignorando ponteiros, logs ou metadados cosméticos.
   - Checksum é ferramenta de diagnóstico/reprodutibilidade/desync detection, **não** mecanismo de segurança criptográfica.

6. **Autoridade e invariantes**:
   - Toda entrada externa futura é tratada como intenção não confiável.
   - Comandos inválidos (tick passado/futuro fora do passo atual, valores negativos, IDs desconhecidos, overflow, transição ilegal) falham explicitamente sem corromper o estado.

## Alternativas

- **Ponto flutuante (`float64`) com tolerância epsilon**: descartada pela fragilidade entre arquiteturas/compiladores e incompatibilidade com igualdade exata de checksum/rollback.
- **Usar `encoding/json` como base direta do checksum**: descartada como representação canônica de hash por depender de convenções textuais e ordenação implícita; JSON versionado é usado apenas para inspeção/intercâmbio de snapshots, enquanto o checksum usa codificação binária canônica explícita.
- **Paralelizar cada tick desde o início**: descartada; determinismo tem prioridade sobre otimização prematura. Concorrência no Ciclo 1 é validada por isolamento entre simulações independentes (`go test -race`).

## Consequências

- **Positivas**:
  - Replay exato, snapshot/restore verificável em qualquer tick `K` e detecção imediata de regressão de determinismo.
  - Base compatível com futura evolução para rollback de combate e sharding por região.
- **Negativas / Trade-offs**:
  - Cálculos de proporção/física exigem atenção explícita a ordem de multiplicação/divisão inteira e limites de `int64`.

## Reversibilidade

**Média-Alta.** A escala de unidades (`WorldUnit = 1/1000`, `BasisPoints = 1/10000`) é configurável por versão de schema; a disciplina de determinismo é fundacional e recomendada para permanecer durante todo o projeto.

## Questões abertas

1. Combate 2D lateral utilizará a mesma escala `1/1000` (subpixels/miliunidades) ou uma grade específica alinhada aos sprites/hitboxes?
2. Qual frequência lógica (`ticks/s`) será adotada para o World Simulation loop em produção (ex.: `10 Hz` ou `20 Hz`) em contraste com os `60 Hz` conceituais do combate?
