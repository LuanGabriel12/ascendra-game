# ASCENDRA — Observabilidade (Fundação Ciclo 1)

## Logs estruturados

O núcleo puro de simulação (`internal/simulation`, `internal/ai`, `internal/world`) **não executa I/O nem escreve logs diretamente**. Em vez disso, cada `Step` retorna eventos de domínio estruturados e erros tipados para que a camada hospedeira (como `cmd/sim`) registre logs estruturados com `log/slog` (stdlib Go).

### Campos padronizados

| Campo | Tipo | Uso |
|---|---|---|
| `event` | `string` | Nome do evento operacional ou de domínio (`simulation_started`, `invasion_state_changed`, `contribution_recorded`, `simulation_completed`, `command_rejected`) |
| `tick` | `uint64` | Tick lógico da simulação |
| `simulation_id` | `string` | Identificador estável da instância de simulação |
| `entity_id` | `string` | ID estável da entidade envolvida (settlement, grupo hostil, jogador) |
| `event_id` | `string` | ID estável e idempotente do evento de domínio |
| `state_transition` | `string` | Transição explícita de estado (ex.: `Peace->Threatened`, `Idle->Advance`) |
| `duration` | `duration` / `int64` | Duração medida externamente ao núcleo (apenas no harness/host, nunca usada em regras) |
| `error` | `string` | Erro estruturado de validação ou transição inválida |

### Regras de segurança em logs

- Nunca registrar secrets, tokens, credenciais ou connection strings.
- Nunca despejar payloads sensíveis arbitrariamente.

## Métricas futuras planejadas (boundary — não acopladas a infraestrutura neste ciclo)

Quando o runtime real evoluir para serviço contínuo (ex.: OpenTelemetry via port/adapter opcional), as métricas prioritárias do domínio NEON serão:

- `simulation_tick_duration` — latência de processamento por tick lógico
- `rollback_count` — quantidade de rollbacks executados (quando combate/netcode estiver ativo)
- `desync_count` — divergências detectadas via checksum canônico
- `invalid_command_count` — comandos rejeitados pela validação autoritativa
- `active_world_events` — eventos mundiais/invasões ativos simultaneamente
- `invasion_state_transitions` — contagem por transição de estado da máquina de invasões
- `ai_decision_duration` — tempo gasto na avaliação das políticas de IA
