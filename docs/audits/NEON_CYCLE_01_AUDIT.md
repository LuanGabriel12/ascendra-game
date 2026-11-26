# Auditoria NEON — ciclo 01

Data: 26/11/2026. Base examinada: a74ee92 na branch neon/backend-foundation.

## Resumo executivo

O vertical slice headless compila e os testes executados passaram. Existem limites de integração e de operação que impedem tratar o projeto como pronto para produção. A revisão de segurança e dos casos extremos não é exaustiva. O histórico da main remota é independente do histórico NEON, o que bloqueia a comparação normal para PR.

## Módulos e arquitetura observada

- cmd/sim executa dois cenários e verifica snapshot/restore.
- internal/world contém estado, comandos, ticks, invasão e harness. Step clona o estado, valida entradas e emite eventos.
- internal/ai avalia percepções e retorna decisões para grupos.
- internal/simulation fornece RNG com estado explícito, hash canônico e snapshots JSON versionados.
- internal/ports declara fronteiras para leitura de settlement e envio de contribuições. internal/adapters/memory fornece implementação em memória.
- docs contém ADRs propostas, ownership, observabilidade, solicitação de contratos e handoff. .vscode/settings.json está ignorado.

O Step não usa banco, rede, interface ou relógio de parede. O harness entrega eventos ao sink fora de Step. A ordem de comandos é a ordem do slice recebido e a ordem de grupos é validada. O script consulta map por tick, sem depender da ordem de iteração. Os testes de replay e snapshot passaram para os cenários testados, sem prova para todas as entradas possíveis.

## Verificações

Go 1.27.4 via C:\Program Files\Go\bin, Git 2.53.0. Go não estava no PATH. GCC estava disponível. GitHub CLI não encontrado. Foram executados 17 testes nomeados após a correção, além dos seeds dos dois fuzz tests. go test -count=1, go vet, go build, go test -cover, go test -shuffle=on -count=10 e go test -race passaram. Coverage por pacote: memory 97,1%, ai 68,3%, simulation 65,8%, world 80,1%. cmd/sim e ports não têm testes próprios. Cobertura não prova correção.

A demonstração go run ./cmd/sim concluiu os cenários Defended e Captured, com snapshot_verified=true em ambos. A busca textual básica por credenciais nos arquivos não identificou valores evidentes. Ela não substitui varredura de segredos de todo o histórico.

## Achados e correções

- P1 integração: origin/main (6c9b180) e NEON não possuem ancestral comum. A comparação de árvores mostra README divergente e notebook existente somente em main. Não foi feito merge nem alteração de histórico. Resolver a integração preservando ambos os conteúdos antes do PR.
- P2 limites numéricos: incremento do tick e sequência de eventos podiam transbordar, cooldown podia voltar no tempo e variâncias máximas provocavam overflow em variance+1. Foram adicionadas rejeições e testes de regressão. As funções falham atomicamente no Step.
- P2 entrega: RunScenario despacha eventos durante a execução e retorna erro sem expor o estado parcial se o sink falhar. Retentativas exigem desenho conjunto de persistência e idempotência com CARBON.
- P2 capacidade: listas de grupos, objetivos, contribuições, cooldowns e eventos do harness podem crescer sem limite. Limites e retenção dependem dos requisitos de operação.
- P2 autoridade: comandos administrativos e comandos de jogador compartilham a mesma API de simulação. Um transporte futuro precisa autenticar e autorizar as origens antes de expor essa API.
- P3 cobertura: o CLI e os ports não possuem testes próprios e a cobertura da política de IA e da serialização tem lacunas.

## Dependências e recomendações

CARBON precisa validar os contratos de settlement e contribuição, a identidade e deduplicação de eventos, a política de retry e a divisão de ownership de combate, PvP e ranked. Persistência e recompensas não foram implementadas. Os ADRs permanecem propostos.

Para o ciclo 02, revisar os limites e contratos, estabelecer ordenação explícita de entradas e testes de replay para IA, além de manter a percepção e o RNG como entradas explícitas. Medir desempenho e crescimento sob carga antes de operar continuamente.

## Limitações

A auditoria não validou execução distribuída, transporte real, persistência, carga, segurança completa nem integração com CARBON. A análise do histórico e de segredos não constitui uma auditoria forense. A integração GitHub e a publicação dependem do resultado das ações posteriores registradas no relatório final.
