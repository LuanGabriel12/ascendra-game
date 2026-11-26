# Auditoria NEON — Ciclo 02

Data: 26/11/2026. Base 9d7cd2c, entrega 9397b3c. Análise focada no diff do ciclo 02 e regressões da fundação. A revisão não comprova segurança ou determinismo para todas as entradas.

## Resumo e funcionalidades verificadas

A IA utiliza perfis inteiros, alvos explícitos, coordenação por pares, moral, retorno territorial e solicitações limitadas de reforços. O Step clona o estado, ordena comandos e devolve eventos. Foram executados os quatro cenários headless com snapshot verificado. O código de ports CARBON permanece idêntico à base. O PR #1 está aberto e a base recomendada para o ciclo 02 é neon/backend-foundation.

O catálogo tem cinco perfis com parâmetros e papéis diferentes. Seleção usa pontuação e desempate por distância e ID. Coordenação usa aliados e comandante da mesma família, com ordens alternativas sem comandante. O contexto de invasão e posição determina o engajamento de alvos disponíveis; família influencia táticas e moral, não estabelece uma regra universal de moralidade. O modelo é 1D e o caller fornece defensores como alvos.

Amostras de replay, concorrência e restauração passaram. Um teste adicional compara eventos posteriores ao snapshot. A seed e estado RNG integram o estado, e campos de grupo/defensor constam do checksum. Isso não demonstra determinismo universal. Snapshot v1 é rejeitado por versão e não existe migração. O checksum detecta mudanças acidentais, mas não autentica o conteúdo.

## Achados e correções

- P1 corrigido — defensor com HP zero conseguia completar objetivo. O comando agora rejeita a ação e teste verifica atomicidade.
- P1 corrigido — Step aceitava estado restaurado acima dos limites configurados. Agora rejeita grupos, defensores, objetivos, contribuições e ondas acima da configuração antes de clonar ou executar comandos. O decode em si não recebe Config e ainda aceita esse snapshot.
- P2 corrigido — alvo anterior permanecia no estado quando a decisão deixava de apontar alvo. Agora é limpo para grupos avaliados. Não equivale a memória de percepção ou retenção.
- P2 corrigido — solicitação de reforço era atendida mesmo após o solicitante fugir naquele tick. Solicitações de grupos já derrotados ou dispersos são ignoradas.
- P2 corrigido — razão de dano extremo podia provocar panic em bits.Div64 para percepção válida. O cálculo agora satura antes da divisão.
- P2 pendente — decode JSON não limita tamanho de entrada ou alocação. O limite de grupos é verificado no Step, após decodificação. Um limite de bytes e política de configuração precisam ser definidos para qualquer fronteira não confiável.
- P2 pendente — CurrentTargetID não possui tipo e o ID de defensor pode coincidir com ID do settlement. A semântica de identidade e referências precisa de definição antes de uso em rede. Campos de perfil/família e referências no snapshot não são integralmente validados contra o catálogo.
- P2 pendente — seleção consulta alvos correntes a cada tick. Não há memória de percepção com expiração nem retenção/histerese de alvo. A morte do comandante remove sua aura e ordem na avaliação seguinte, sem evento ou penalidade explícita dedicada.
- P2 pendente — ordenação de comandos fixa prioridade por tipo e ID, duplicatas podem repetir efeitos ou causar falha atômica conforme o comando. Há vantagem potencial de IDs menores em conflitos de ações e reforços. Comparator não inclui todos os campos, incluindo archetype, count e home position. Política de conflitos, deduplicação e justiça requer decisão de gameplay, antes de uso competitivo.
- P2 pendente — listas de cooldown e eventos do harness, e tamanho dos comandos, não têm limite geral. Retentativas do sink após falha parcial e identidade de eventos requerem acordo com CARBON.
- P2 capacidade — Coordinate compara cada grupo com todos os outros, O(G²), além de seleção por alvos O(G*T). Grupos mortos permanecem em coleções e contam para o teto. Perfis e simulação não constituem servidor de jogadores simultâneos.
- P3 desvio de escopo — não há perfil separado de orc berserker, embora seis perfis estivessem no planejamento. Cinco estão no catálogo.

## Testes

Go 1.27.4, Windows 11 Pro amd64. `go test -count=1 ./...`, `go vet ./...`, `go build ./...`, `go test -race -count=1 ./...`, `go test -shuffle=on -count=10 ./...`, `go test -count=1 -cover ./...`, `go run ./cmd/sim` e `git diff --check` passaram. Os testes incluem 37 testes nomeados e sementes de fuzz. A comparação de eventos após snapshot foi acrescentada depois da medição de cobertura.

Cobertura medida após correções: cmd/sim 69,8%, memory 97,1%, ai 73,9%, ports 96,8%, simulation 64,4%, world 79,4%. AI, simulation e world ficaram abaixo da meta desejada de 85%. Restam caminhos de restauração adversarial, limites, colisões de identidade e conflitos simultâneos a testar.

Fuzzing com dois workers, 30 segundos por alvo: FuzzSnapshotDecode passou com 577.537 execuções e usa estrutura de amostra genérica, não WorldState; FuzzCommandValidation passou com 810.223 execuções e exercita um comando sobre dois estados fixos; FuzzTargetSelectionOrder, acrescentado nesta auditoria, passou com 1.152.757 execuções em pares de defensores válidos. Fuzzing é amostragem, não prova de ausência de defeitos.

## Benchmarks

Windows 11 Pro, AMD Ryzen 7 5800X3D, Go 1.27.4, amd64. Benchmarks existentes executados em paralelo com outras verificações: WorldStep 2.666 ns/op, 3.322 B/op, 7 allocs/op; MultiGroup16 31.626 ns/op, 40.113 B/op, 24 allocs/op; Checksum 2.694 ns/op, 696 B/op, 25 allocs/op; SnapshotRoundTrip 32.990 ns/op, 15.134 B/op, 77 allocs/op. Carga concorrente e duração podem afetar a comparação com resultados anteriores.

Benchmarks adicionais usam uma iteração por escala, configuração experimental com limite de grupos aumentado no teste e reforços desativados, um alvo para seleção e grupos ativos. Resultados indicativos, não capacidade de produção.

| Grupos | Coordenação ns / B / allocs | Seleção ns / B / allocs | Step ns / B / allocs | Checksum ns / B / allocs | Decode snapshot ns / B / allocs | Encode snapshot ns / B / allocs |
|---:|---|---|---|---|---|---|
|100|93.000 / 12.672 / 2|1.500 / 0 / 0|175.900 / 241.088 / 107|41.900 / 4.408 / 211|472.100 / 196.280 / 396|133.000 / 203.120 / 240|
|1.000|8.723.100 / 122.880 / 2|16.100 / 0 / 0|9.709.800 / 2.351.040 / 1.007|289.000 / 40.408 / 2.011|2.147.700 / 1.719.976 / 3.086|1.017.100 / 2.385.424 / 2.049|
|10.000|920.602.800 / 1.204.224 / 2|156.600 / 0 / 0|955.314.000 / 23.378.880 / 10.007|2.488.600 / 400.408 / 20.011|24.628.500 / 18.234.288 / 30.203|11.957.200 / 25.038.280 / 20.062|

Construção de percepção isolada para 100, 1.000 e 10.000 defensores, respectivamente: 12.000 / 6.528 / 1, 41.100 / 65.536 / 1 e 151.500 / 647.168 / 1 em ns/op, B/op e allocs/op. A seleção acima representa uma chamada por grupo com um alvo, e não uma medição de múltiplos jogadores conectados. O limite padrão é 32 grupos e 64 defensores.

## Próximo ciclo e dependências

Antes de incorporar ecossistema, definir identidade dos alvos, política de comando concorrente, limites de snapshot e retenção de eventos, e medir coordenação sob carga representativa. Memória, expiração e consequências de morte de comandante permanecem para NEON. CARBON deve acordar projeções persistentes de regiões/populações e semântica de entrega, idempotência e recompensas. Nenhuma regra persistente do CARBON foi implementada.
