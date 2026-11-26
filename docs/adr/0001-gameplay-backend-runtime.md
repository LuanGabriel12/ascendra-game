# ADR-0001: Gameplay Backend Runtime (Default Reversível)

- **Status**: `Proposed` (aguarda validação conjunta com CARBON quando o desenvolvimento paralelo iniciar)
- **Data**: 2026-11-26
- **Owner**: NEON

## Contexto

Na auditoria inicial do workspace de ASCENDRA (`Condição C — repositório quase vazio`), nenhuma linguagem, framework ou contrato de backend existia previamente no repositório. O núcleo sob responsabilidade do NEON precisa suportar:

- simulação headless e determinística orientada a ticks;
- alta testabilidade (unit, determinismo, snapshot/restore, fuzzing, race detection e benchmarks);
- desenvolvimento ágil em equipe pequena (2 desenvolvedores: NEON e CARBON);
- independência de banco de dados, UI, engine gráfica e provedores de cloud neste primeiro ciclo.

## Decisão

Adotar **Go `1.27.x`** como **default reversível** para o backend de simulação de gameplay do Ciclo 1, utilizando:

- apenas a **standard library** do Go (zero dependências externas no módulo inicial `ascendra-game`);
- arquitetura de **monólito modular** com domínio isolado de transporte e persistência;
- interfaces definidas apenas nos boundaries reais (`internal/ports`);
- execução completa sem Docker, sem banco externo e sem frontend.

> Esta decisão **não** fixa Go permanentemente caso CARBON ou uma futura decisão de engine/netcode exija outra stack. Também reafirma que "NEON" é apenas o nome do agente/engenheiro e não implica uso de Neon Database.

## Alternativas

### 1. Go `1.27.x` (Escolhida como default reversível)
- **Prós**: compilação quase instantânea; stdlib completa (`testing`, `-race`, `fuzz`, `bench`, `log/slog`, `crypto/sha256`, `encoding/binary`, `encoding/json`); excelente produtividade para equipe de 2 pessoas; binário estático simples de operar; profiling integrado (`pprof`/`trace`).
- **Contras**: presença de GC (exige atenção a alocações em hot paths futuros de combate 60Hz); determinismo requer disciplina explícita (evitar `float`, evitar iteração de `map` em lógica e usar PRNG próprio).

### 2. Rust
- **Prós**: determinismo e previsibilidade de memória sem GC; excelente segurança de concorrência em tempo de compilação; excelente interoperabilidade via C ABI / WASM caso se queira compartilhar exatamente o mesmo núcleo de combate com um cliente futuro.
- **Contras**: maior custo cognitivo e tempo de compilação para prototipar a fundação inicial em equipe de 2; fuzzing e benchmarking de produção exigem tooling externo (`cargo-fuzz`, `criterion`). Continua sendo forte alternativa caso rollback/combate em produção exija zero-GC.

### 3. C# (.NET)
- **Prós**: ergonomia alta; excelente sinergia se o cliente futuro adotar Godot C# ou Unity com compartilhamento de modelos.
- **Contras**: SDK mais pesado; runtime gerenciado com GC; não há ainda decisão confirmada de Godot C# ou Unity no repositório.

## Consequências

- **Positivas**:
  - Vertical slice headless compilável e verificável em segundos (`go test -race ./...`).
  - Zero lock-in de frameworks, ORMs, filas ou bancos de dados.
  - Contratos simples em `internal/ports` podem ser traduzidos para JSON/Protobuf/gRPC futuramente.
- **Negativas / Trade-offs**:
  - Se o time decidir futuramente por Rust (ex.: para compartilhar o core determinístico com o cliente via FFI/WASM) ou C# (ex.: Godot C#), o código do slice precisará ser portado.

## Reversibilidade

**Alta.** O escopo do Ciclo 1 é deliberadamente pequeno (um vertical slice headless + ADRs + contratos), sem acoplamento de infraestrutura nem banco de dados. Os contratos, invariantes e cenários de teste são transferíveis para Rust ou C#.

## Questões abertas

1. CARBON adotará Go para os serviços de persistência/domínio ou prefere outra stack comunicando-se via contratos versionados?
2. Qual engine será escolhida para o cliente 2D pixel art (ex.: Godot GDScript/C#, engine custom) e haverá necessidade de compartilhar código de predição/rollback entre cliente e servidor?
3. Qual será o path definitivo do módulo Go assim que a organização/URL oficial de `ascendra-game` no GitHub for confirmada (atualmente `module ascendra-game`)?
