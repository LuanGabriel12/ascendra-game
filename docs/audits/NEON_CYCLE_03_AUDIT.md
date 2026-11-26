# Auditoria NEON — Ciclo 03

## Resultado e escopo

**READY WITH LIMITATIONS.** Auditoria independente da entrega `6bf0b3b` em `neon/dynamic-ecosystem-engine`, sobre `349fe69`. Foram examinados o motor regional, a ponte tática, a IA espacial, os caminhos de snapshots, os testes e as propostas de integração. O working tree começou limpo. O fetch confirmou PRs #1 e #2 abertos. A main avançou a `57ac839` com alteração de README. A prévia de merge aponta conflito no README. O PR do ciclo 03 deve usar `neon/creature-ai-engine` como base.

## Funcionalidades verificadas

- Grafo de três regiões, crescimento logístico discreto, mortalidade, resíduos fixed-point, migração por planejamento e aplicação, recursos, escassez e regeneração.
- Acampamentos Establishing, Active, Expanding, ResourceStarved, Threatened, Abandoned e Destroyed. Há limites por região e facção, cooldown de recriação e bloqueio de materialização em acampamentos terminais.
- Competição regional com relações explícitas. Apenas relação hostil causa atrito direto. Coordenação tática e choque de moral ainda usam família. Avaliar facções táticas com design antes de ampliar.
- Ameaça Stable/Growing/Hostile/Critical, histerese e cooldown. A pressão ecológica chega ao estado tático, cuja máquina de invasão permanece responsável pelas transições.
- Alvos tipados, retenção com bônus, expiração, choque por morte de comandante, perfil Orc Berserker e limpeza de grupos terminais. A memória favorece um alvo ainda elegível e não equivale a perseguir posição antiga fora da percepção.
- Snapshots v3 com checksum e restauração de RNG, resíduos e estado lógico. v1 e v2 são rejeitados. Campos desconhecidos e JSON adicional também são rejeitados.

## Achados, severidade e correções

- **P0** — nenhum confirmado.
- **P1, corrigido** — destinos de migração podiam superar a capacidade por planos concorrentes. A aplicação reavalia a capacidade compartilhada e conserva o total. O desempate por ID pode dar prioridade sistemática em disputa. O teste com dois remetentes verifica a lotação e o balanço.
- **P1, corrigido** — grupos integrados podiam reforçar sem reserva e a validação ignorava origem populacional inexistente ou soma em overflow. Reforços de grupos vinculados ficam suspensos até terem um caminho de reserva. Agora são validados o vínculo de acampamento, população, família, facção e região, a soma e a impossibilidade de marcar grupo ainda ativo como contabilizado. Reforços táticos sem vínculo continuam disponíveis no modo de simulação tática.
- **P1, corrigido** — soma saturada de demanda podia creditar mais alocação do que o estoque consumido. O epoch rejeita demanda agregada que excede int64 antes de distribuir aquele recurso. Regeneração agora satura antes da adição. Campamento novo começava com 15 unidades de reserva sem débito no estoque. A criação passou a começar com reserva zero.
- **P2, corrigido** — reservar ou devolver indivíduos alterava a população antes de detectar estouro da sequência de eventos. A mutação agora ocorre após emissão bem-sucedida. A ponte também rejeita posição negativa.
- **P2, corrigido** — contas de força, conflito, ameaça e capacidade de acampamento tinham operações sem guarda. Agregados de força competitiva impossíveis de representar rejeitam o epoch atomicamente. Foram adicionadas guardas na expansão, geração de IDs, multiplicação de baixas, escala e somas de ameaça e cooldown. A ponte limita o incremento e só considera a região ou assentamento correspondente.
- **P2, pendente** — reserva de baixo nível usa saldo agregado. Reaplicar um ticket diretamente pode consumir saldo de outro contingente. O fluxo suportado de integração concilia via grupo/Accounted ou remove o grupo no recall. Antes de expor tickets a outro sistema, adotar identidade por reserva e deduplicação.
- **P2, pendente** — `UnmarshalSnapshot` de World tem teto de bytes padrão, mas valida estrutura sem a Config. Usar `UnmarshalSnapshotWithLimits` para restaurar sob limites operacionais e `UnmarshalIntegratedSnapshot` para invariantes cruzadas. Alguns IDs aninhados só têm limite indireto de bytes e as coleções são validadas após decode. SHA-256 detecta divergência e não autentica origem.
- **P2, pendente** — retenção FIFO de IDs aposentados é finita. IDs antigos podem ser reutilizados após expulsão. Acordar identidade durável antes de persistência. Também falta política competitiva para conflitos, duplicatas e prioridades.
- **P3, documental** — O(G log G) descreve a parte espacial de vizinhança na coordenação, com ordenação, prefixos e busca binária. Busca de alvos de comandantes e avaliação individual ainda percorrem candidatos. Fallback de defensores percorre a janela depois da busca binária. Em alta densidade o custo de alvos pode chegar a O(G × T). A alegação não se aplica ao WorldStep inteiro.

## Conservação, determinismo e limites

O balanço regional soma população livre e materializada. Materialização transfere o contingente e o retorno libera apenas sobreviventes. Derrota devolve zero, recall parcial arredonda sobreviventes para cima e dispersão com HP positivo pode devolver sobreviventes. A limpeza só remove terminal contabilizado após retenção. O camp destruído continua como origem histórica de contingentes existentes. O balanço global por epoch foi recalculado por eventos de crescimento/declínio em três execuções adicionais de 700 epochs. Eventos ecológicos de crescimento/declínio publicam saldo líquido, sem detalhar nascimentos e mortes simultâneos. O teste de resíduos comparou 1.000 pares de quociente/resto com math/big.

No consumo proporcional, estoque debitado iguala a soma das alocações. Restos são destinados em ordem canônica, favorecendo IDs anteriores. Arredondar demanda per capita para cima pode penalizar populações pequenas. Regeneração é uma fonte explícita, consumo e destruição de reservas são saídas. Eventos atuais não expõem um livro-razão completo de estoque e não foram usados como prova de conservação universal.

O diferencial de IA usou a referência quadrática em 150 amostras com três seeds, posições coincidentes e extremas, grupos dispersos, comandantes mortos e ausência de alvos. Replay verificou estado e eventos em pontos de restauração e no CLI. Ticks e epochs são lógicos. Não há uma prova universal de determinismo.

Comandos de spawn, aumento de ameaça e transição forçada são administrativos/autoritativos. Destruir ou estabelecer acampamento, ajustar recursos e aplicar perdas são entradas ecológicas. Posicionar defensor, ataque, suporte e objetivo são intenções de jogador no harness. A ordenação cobre os novos campos dos comandos, mas seleção de prioridade e conflitos ainda requer revisão antes de PvP. Comandos ecológicos devem chegar em um tick de epoch, pois a ponte só os consome nessa fronteira.

## Testes independentes

Go 1.27.4, Windows amd64. Passaram test sem cache, vet, build, race sem cache, shuffle dez vezes, cover, git diff --check e go run ./cmd/sim. Os quatro cenários anteriores e os seis ecológicos A–F concluíram. Táticos e cenário F verificaram eventos e estado após restauração. As sessões longas originais de 3.000 epochs estáveis e 2.000 adversos foram reproduzidas pela suíte. A nova prova amostral adicionou 2.100 epochs e validação por etapa. Não houve medição de memória retida nas simulações longas.

Cobertura independente medida após correções: CLI 74,2%, memory 97,1%, AI 86,5%, ecosystem 85,3%, ports 96,8%, simulation 100%, world 78,6%. Valores do NEON constam no handoff. Permanecem lacunas em combinações de snapshots integrados, IDs, reconciliação repetida de tickets e efeitos acumulados de recursos e campamentos.

Fuzzing independente inicial, dois workers, pelo menos 30 s por alvo: comandos ecológicos 534.012 execuções (20 novos interessantes), snapshot ecológico 52.666 (31), comandos táticos 573.412 (6). As três sessões passaram. Na rodada final, também com dois workers e 30 s de orçamento por alvo, passaram comandos ecológicos com 499.899 execuções (5 novas interessantes), snapshot com 25.880 (14) e comandos táticos com 368.328 (4). O contador do fuzz de snapshot ficou estável após 3 s, embora a sessão tenha terminado com sucesso. Os fuzzers de comando usam estado inicial fixo e muitas entradas são rejeitadas por época/tick antes da lógica. O decoder percorre entradas válidas e inválidas, com round-trip quando aceita.

## Benchmarks independentes

AMD Ryzen 7 5800X3D, Windows 11 Pro amd64, Go 1.27.4, GOMAXPROCS 16. Cinco amostras por benchmark, 150 ms por amostra, pacotes em série sem outros jobs pesados iniciados pelo Codex nessa medição. Carga de aplicativos do host não foi medida. Valores são mediana e faixa em ns/op. B/op e allocs/op são amostras representativas.

| Benchmark | Mediana ns/op | Faixa ns/op | B/op | allocs/op |
|---|---:|---:|---:|---:|
| Coordenação 100 | 16767 | 14334–28280 | 26352 | 14 |
| Coordenação 1000 | 221297 | 206286–271589 | 263409 | 18 |
| Coordenação 10000 | 2050488 | 1905518–2366100 | 2790642 | 25 |
| Step 16 grupos / 4 defensores | 48604 | 39822–73323 | 114024 | 86 |
| Step 32 grupos / 64 defensores | 140868 | 110636–153642 | 234943 | 150 |
| Step 1000 grupos | 3348305 | 2899616–3499995 | 6910222 | 3025 |
| Step 10000 grupos | 24292350 | 19648889–49650583 | 69044522 | 30032 |
| Epoch ecológico padrão | 18474 | 12501–23968 | 11936 | 86 |

Para 10.000 grupos, medianas de coordenação por distribuição: densa 2,63 ms, esparsa 3,33 ms, uniforme 7,83 ms. Cada caso usou cerca de 2,86 MB/op e 73 allocs/op. As escalas de 1000 e 10000 usam configuração de teste. O NEON reportou cerca de 1,45 ms para coordenação e 16,29 ms para Step com 10.000. A medição independente confirma a ordem de grandeza e cerca de 69 MB/op no Step, com maior latência neste ensaio. Não foi feita nova medição da versão quadrática nem atribuição quantitativa por pprof. A inspeção aponta cópia de estado, índices e slices temporárias e as múltiplas buscas/validações de perfis como candidatos para profiling. Alocação por operação não mede memória retida. Essas escalas descrevem grupos, não jogadores.

## CARBON e Ciclo 04

As portas da fundação permanecem idênticas à base e o ciclo não introduziu persistência. Acordar projeções de região, facção, população, acampamento e eventos, mapeamento de IDs, idempotência e representação de int64/uint64 como strings decimais no JSON ou formato binário adequado. Ticks e epochs não substituem timestamps persistentes. Antes de abrir transporte, revisar limites/configuração de snapshots, reservas e auditoria de recursos. Para o diretor mundial, definir dono da máquina de invasão e política de pressão durante invasão já ativa, antes de acrescentar agendamento.
