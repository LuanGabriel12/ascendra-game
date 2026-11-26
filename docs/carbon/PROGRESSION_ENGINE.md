# CARBON — Motor de Progressão, Experiência Autoritativa e Simulação de Curvas

## 1. Curva Configurável de Experiência (`progression_rules`)

Na configuração provisória `dev_standard_v1` (`rules_version = 1`), o total acumulado de XP exigido para atingir o nível $L \in [1, 100]$ segue o polinômio quadrático exato em `BigInt` ($d = L - 1$):

$$\text{RequiredTotalXP}(L) = d \cdot \text{base} + d \cdot (d - 1) \cdot \text{linear} + d^2 \cdot \text{quadratic}$$

Com `base = 100`, `linear = 50`, `quadratic = 25` e `points_per_level = 2`:
- **Nível 1:** `0` XP (`50` pontos ganhos)
- **Nível 2:** `125` XP (`52` pontos ganhos)
- **Nível 3:** `400` XP (`54` pontos ganhos)
- **Nível 10:** `6.525` XP (`68` pontos ganhos)
- **Nível 50:** `187.425` XP (`148` pontos ganhos)
- **Nível 100 (teto provisório):** `740.025` XP (`248` pontos ganhos)

### Casos de Borda Definidos
- **Salto de múltiplos níveis:** busca binária em `BigInt` determina o nível final exato e concede `(newLevel - previousLevel) * points_per_level` em uma única transação.
- **Nível máximo (`100`):** o nível e `earned_attribute_points` estacionam no teto `100` (`248` pontos), enquanto `experience_total` permanece auditável até `MAX_INT64`.
- **Overflow:** qualquer concessão onde `experience_total + validated_amount > 9223372036854775807` é rejeitada com `ExperienceGrantInvalidError` sem efeitos parciais.

---

## 2. Concessão Autoritativa de XP (`grantExperience`)

- Exclusiva para `internal_system_authority` (fontes válidas: `quest`, `boss`, `exploration`, `world_event`, `invasion_reward_policy`, `discovery`, `achievement`, `dev_authorized`).
- **Não** converte automaticamente `ContributionRecorded` em XP até aprovação da política de recompensas, e mantém XP de personagem separado de futuras maestrias de armas/profissões.
- Protegida por `processed_events` + `experience_grants`: reenvio idêntico retorna `duplicate_idempotent`; reenvio com mesmo `grantId` e valor/destino diferente falha com `InboxIdempotencyConflictError`.

---

## 3. Resultados do Harness de Simulação (`progression-simulator.ts`)

O simulador (`runProgressionSimulationHarness`) avalia a capacidade máxima de alocação sob o teto `30` (`10 atributos * 25 alocáveis = 250 pontos máximos alocáveis`):
- **`points_per_level = 1`:** `149` pontos ganhos no Nível 100 (`capSaturationLevel = null`).
- **`points_per_level = 2` (adotado em `dev_standard_v1`):** `248` pontos ganhos no Nível 100 (`capSaturationLevel = null` — 100% dos pontos ganhos continuam distribuíveis até o nível máximo!).
- **`points_per_level = 3`:** `347` pontos ganhos no Nível 100 → satura o teto `30` no **Nível 68** (`251 > 250`), exigindo elevação do teto caso essa taxa seja adotada futuramente.
- **`points_per_level = 4`:** `446` pontos ganhos no Nível 100 → satura o teto `30` no **Nível 52** (`254 > 250`).
