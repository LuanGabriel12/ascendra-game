# Contextual World Recognition & Historical Memory

## 1. Política Orientada a Dados para Reação de NPCs (`world-recognition.ts`)

`evaluateContextualWorldRecognition` produz classificações determinísticas (`Unknown`, `Neutral`, `Friendly`, `Respectful`, `Admiring`, `Reverent`, `Suspicious`, `Fearful`, `Contemptuous`, `Hostile`) e diretrizes de zona segura (`none`, `watch_closely`, `deny_access_and_arrest`) para que o NEON execute diálogos, posturas e guardas no futuro.

### Garantia Estrutural Contra Viés Racial
O campo `raceCode` / `lineageCode` **não existe** em `WorldRecognitionEvaluationInput`. Um Orc defensor de Valewatch (`Gorim Escudo-Vivo`) recebe tratamento `Respectful`/`Admiring` dos cidadãos e guardas da cidade, enquanto um Humano assassino procurado (`Varkon Cinza-Negra`) recebe `Hostile` (`deny_access_and_arrest`) da guarda cívica e `Admiring` no submundo da Irmandade de Thornveil.

### Cinco Cenários Validados
- **Cenário A (Herói Local):** Reconhecido como `Respectful`/`Admiring` na cidade defendida, mas `Unknown`/`Neutral` em regiões distantes sem fama suficiente.
- **Cenário B (Herói Lendário):** `globalFame >= 1500` e `moralBounty >= 1000` produz `Reverent` sem conceder autoridade política automática.
- **Cenário C (Criminoso Desconhecido):** Infração menor em outra jurisdição com baixa fama resulta em `Unknown` para mercadores distantes (NPCs não são oniscientes).
- **Cenário D (Criminoso Lendário):** Produz `Hostile` em `town_guard`, `Fearful` em cidadãos quando há alto risco/poder autoritativo (`authoritativePowerStanding`), `Contemptuous` caso contrário, e `Admiring`/`Respectful` em `criminal_syndicate`.
- **Cenário E (Mercenário):** Reação varia contextualmente conforme reputação local com facções e assentamentos.

---

## 2. Memória Histórica (`historical_social_records`) e Ponte com Contribuições

- `historical_social_records` armazena marcos duradouros (`SettlementDefended`, `SettlementLiberated`, `BossFirstDefeated`, `CriminalWarrantIssued`, `ExclusiveMilestone`) com `contribution_role` e `visibility`, preparados para crônicas, monumentos e diálogos futuros sem coroar automaticamente o maior causador de dano como "líder".
- `recognizeEligibleContribution` consome `gameplay_contributions` da Session 02 exigindo `eligible = TRUE`, identidade ativa em `external_identity_links` e política explícita para `outcome = 'Captured'`, gravando `contribution_recognitions(contribution_id)` para garantir aplicação única e idempotente.
