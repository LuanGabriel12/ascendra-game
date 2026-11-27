# Moral Bounty System (`moral_bounty` & `moral_band`)

## 1. Modelo Global e Manifestação Regional

- **Representação:** Inteiro assinado de 64 bits (`BIGINT` no PostgreSQL, `bigint` em TypeScript, string decimal assinada `SignedInt64Schema` na fronteira JSON).
- **Fonte de Verdade Global:** `character_social_standing.moral_bounty` armazena o saldo moral acumulado das ações autoritativas validadas do personagem (`[-1.000.000, +1.000.000]` nas regras provisórias `dev_social_rules_v1`), precedido por verificação estrita contra overflow de `int64` (`checkedAddSignedInt64`).
- **Manifestação Regional Sem Dupla Contagem:** Quando uma ação moral ocorre em uma região específica (`regionId`), a transação atualiza `character_social_standing.moral_bounty` uma única vez e registra simultaneamente o reflexo regional em `character_regional_standing.regional_moral_bounty`. O valor global nunca re-soma `character_regional_standing`, impedindo dupla contagem.

---

## 2. Onze Faixas Configuráveis de Reconhecimento Moral (`INITIAL_MORAL_BANDS_V1`)

| Código | Nome | Ordinal | Intervalo Provisório (`v1`) |
|---|---|---|---|
| `heroic_legend` | Lenda Heroica | `+5` | `+2500 .. +1000000` |
| `revered_hero` | Herói Reverenciado | `+4` | `+1200 .. +2499` |
| `protector` | Protetor | `+3` | `+500 .. +1199` |
| `respected` | Respeitado | `+2` | `+200 .. +499` |
| `well_regarded` | Bem-visto | `+1` | `+50 .. +199` |
| `neutral` | Neutro | `0` | `-24 .. +49` |
| `suspected` | Suspeito | `-1` | `-99 .. -25` |
| `dishonored` | Desonrado | `-2` | `-249 .. -100` |
| `criminal` | Criminoso | `-3` | `-799 .. -250` |
| `public_menace` | Ameaça Pública | `-4` | `-1999 .. -800` |
| `legendary_enemy` | Inimigo Lendário | `-5` | `-1000000 .. -2000` |

---

## 3. Histerese e Teto de Crime Grave

1. **Histerese (`moral_band_hysteresis = 15`):** Para evitar oscilação constante nas fronteiras entre faixas adjacentes, a mudança para uma faixa imediatamente superior ou inferior exige ultrapassar o limiar da faixa anterior em pelo menos `15` pontos.
2. **Proteção Contra Lavagem de Crimes Graves (`severe_crime_count`):** Infrações confirmadas de severidade `major` ou `capital` com impacto moral negativo incrementam `severe_crime_count`. Enquanto `severe_crime_count > 0`, ações positivas cotidianas não podem elevar `moral_band` acima de `severe_crime_cap_band` (`well_regarded`), exigindo arco futuro explícito de reabilitação/expiação.
