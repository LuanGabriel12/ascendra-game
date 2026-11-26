# NEON-ADR-0006: Dynamic Ecosystem & Population Engine, Safe Snapshots v3 e Coordenação Espacial 1D

- **Status**: `Proposed` (aguarda revisão CODEX e alinhamento de projeções futuras com CARBON)
- **Data**: 2026-11-26
- **Owner**: NEON
- **Identificador exclusivo**: `NEON-ADR-0006` (prefixo `NEON-` para evitar colisão de numeração com ADRs do CARBON)

## Contexto

O Ciclo 02 validou o motor tático de IA de criaturas (goblins e orcs), mas a auditoria independente identificou gargalos estruturais críticos para escalar rumo a um mundo aberto vivo:
1. Ausência de uma escala macro regional (populações abstratas, recursos, acampamentos, migração e competição);
2. `ai.Coordinate` em `O(G²)` atingindo ~987 ms/op com 10.000 grupos empilhados;
3. Grupos mortos permanecendo nas coleções e consumindo o limite padrão de `32` grupos;
4. Decodificação de snapshots sem teto prévio de bytes antes de alocar o decoder JSON;
5. Identidade textual potencialmente ambígua entre `Settlement` e `Defender`.

## Decisão

1. **Simulação em duas escalas com fonte única de verdade (`IntegratedState`)**:
   - Escala A (`internal/world` + `internal/ai`): ticks táticos detalhados com teto `MaxActiveGroups = 32`.
   - Escala B (`internal/ecosystem`): epochs ecológicos executados a cada `TicksPerEpoch` ticks (default `20`), mantendo `FreePopulation` e `MaterializedPopulation` como única contabilidade de indivíduos.
2. **Matemática populacional discreta inteira com acumuladores de resíduos**:
   - Crescimento logístico em BasisPoints (`math/bits` 128-bit), `GrowthResidualBP` / `MortalityResidualBP` serializáveis, `K == 0` seguro e zero geração espontânea de populações extintas.
3. **Otimização da coordenação espacial 1D (`internal/ai/coordination.go`)**:
   - Substituir o loop quadrático `O(G²)` por ordenação espacial 1D + somas de prefixo (retiradas e aura de comandante) + busca binária (`O(G log G)` mesmo no pior caso com todos os grupos na mesma coordenada), preservando 100% da semântica e verificado por testes de equivalência contra a implementação de referência `O(G²)`.
4. **Snapshot v3 com limite pré-decodificação e identidade tipada**:
   - `SnapshotVersion = 3` (rejeitando explicitamente `v1` e `v2` com `ErrUnsupportedSnapshotVersion`).
   - `DecodeSnapshotWithOptions` valida `len(data) <= MaxBytes` **antes** de instanciar `json.NewDecoder`.
   - `ai.TargetRef{Kind, ID}` elimina colisões entre Settlement e Defender.
   - `cleanupTerminalGroups` remove grupos terminais contabilizados após `GroupCleanupRetentionTicks` para o anel FIFO limitado `RetiredGroupIDs`.
5. **Adições secundárias concluídas neste ciclo**:
   - Perfil `orc-berserker` (6º perfil do catálogo);
   - Evento explícito `EventCommanderFallen` com choque de moral em subordinados próximos;
   - Memória de percepção/retenção de alvo (`TargetMemoryTicks`);
   - Comparador completo em `world.CanonicalizeCommands` (mantendo explicitamente aberta a política de justiça competitiva para uso futuro em rede).

## Alternativas

- **Rodar ecossistema a 60 Hz**: descartada; desperdício computacional sem ganho de gameplay. Epochs lógicos espaçados mantêm custo irrisório e determinismo total.
- **Usar Quadtree/engine 2D para `ai.Coordinate`**: descartada por overengineering; o espaço tático atual é 1D e somas de prefixo + busca binária já entregam `O(G log G)` exato no pior caso denso.
- **Aumentar `MaxActiveGroups` acima de 32**: descartada; mascararia vazamento de grupos mortos em vez de resolver o ciclo de vida e a materialização controlada.

## Consequências

- **Positivas**: redução de ~2 ordens de grandeza em `ai.Coordinate` em 10.000 grupos, conservação matemática exata de população/recursos, limpeza controlada de entidades e defesa contra payloads de snapshot oversized.
- **Negativas / Trade-offs**: quebra intencional de compatibilidade de formato de snapshot (`v2 -> v3`, sem migração automática); seleção de alvos em `SelectTarget` continua `O(G × T)` quando todos os defensores estão simultaneamente no alcance.

## Reversibilidade

**Alta** para parâmetros ecológicos e intervalos de epoch; **Média** para o contrato de `IntegratedState` e `SnapshotVersion = 3`.

## Questões abertas

1. Qual será a política definitiva de justiça para comandos concorrentes/conflitantes de jogadores no mesmo tick antes da exposição em rede competitiva?
2. Como CARBON prefere receber projeções futuras de regiões/acampamentos/eventos (JSON com inteiros 64-bit em string decimal vs Protobuf) e mapeamento entre IDs string do NEON e UUIDs do CARBON?
3. Quando o combate evoluir para espaço 2D `(X, Y)`, qual particionamento espacial (grade uniforme inteira) substituirá o índice 1D?
