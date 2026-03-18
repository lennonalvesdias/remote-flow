# 📋 ISSUES.md — opencode-discord

> **Documento vivo** — atualizar conforme issues forem resolvidas, novas forem identificadas ou evoluções forem implementadas.

**Data de criação:** 2026-03-17
**Última atualização:** 2026-03-17
**Descrição:** Registro centralizado de bugs, code smells, cobertura de testes e ideias de evolução para o projeto `opencode-discord`. Serve como backlog técnico e guia de qualidade para o desenvolvimento contínuo.

---

## 🐛 Bugs & Issues

> Ordenados por severidade. Corrigir os críticos antes de qualquer nova feature.

| # | Severidade | Arquivo | Descrição |
|---|---|---|---|
| B-01 | 🔴 **CRÍTICO** | `session-manager.js:393-399` | **Race condition no cleanup de sessões** — sessão removida do `_threadIndex` 10 min após fechar; se nova sessão for criada na mesma thread nessa janela, o índice fica duplicado/ambíguo. Fix: separar remoção do `_threadIndex` (imediata) da remoção do cache (10 min). |
| B-02 | 🔴 **CRÍTICO** | `server-manager.js:197-207` | **Promise rejection não tratada no AbortError** — quando `sseAbortController` é acionado intencionalmente (shutdown), `.then(() => reconnect())` é chamado mesmo assim porque a promise resolve normalmente. Fix: distinguir `AbortError` de erros reais. |
| B-03 | 🟠 **ALTO** | `index.js:75-99` | **Unhandled rejection em erros de Discord API** — se a interação já foi respondida e o `catch` tenta `reply()` novamente, lança segunda exceção não tratada. Fix: checar `interaction.replied` e `interaction.deferred` antes de responder. |
| B-04 | 🟠 **ALTO** | `stream-handler.js:222-225` | **Null check ausente em `session.status`** — `this.session` pode virar `null`/`undefined` em cleanup assíncrono; acesso a `this.session.status` explode com `TypeError`. Fix: adicionar guard `this.session &&`. |
| B-05 | 🟠 **ALTO** | `session-manager.js:280-296` | **Race condition no retry de permissões** — `tryApprove()` usa `setTimeout` fire-and-forget; se a sessão fechar antes do retry, o `server.client` está obsoleto e os timeouts não são cancelados em `close()`. Fix: registrar timeouts em array e cancelar em `close()`. |
| B-06 | 🟡 **MÉDIO** | `index.js:176-185` | **Thread fetch pode travar no shutdown** — `client.channels.fetch()` durante shutdown pode pendurar indefinidamente se o Discord estiver inacessível. Fix: adicionar timeout de 2 s por fetch. |
| B-07 | 🟡 **MÉDIO** | `server-manager.js:217-249` | **SSE event dispatch sem try-catch** — se `session.handleSSEEvent()` lançar erro, derruba todo o listener SSE, quebrando o stream para todas as sessões do servidor. Fix: envolver em `try-catch` com `session.emit('error', err)`. |
| B-08 | 🟡 **MÉDIO** | `stream-handler.js:49-62` | **Status queue sem timeout** — se `flush()` travar (rate limit / rede), a queue de status acumula indefinidamente. Fix: `Promise.race` com timeout de 5 s por item da queue. |

---

## 🔧 Code Smells & Design Issues

| # | Arquivo(s) | Descrição |
|---|---|---|
| S-01 | `commands.js:206-213` e `commands.js:463-472` | **Duplicação de validação de `projectPath`** — mesma lógica de `validateProjectPath()` + `existsSync()` repetida em dois lugares. Extrair para helper `validateAndGetProjectPath()`. |
| S-02 | `stream-handler.js`, `index.js`, `server-manager.js` | **Timeouts hardcoded** — valores como `5000`, `10000`, `2000`, `1000` ms espalhados em múltiplos arquivos. Centralizar em `config.js` com variáveis de ambiente. |
| S-03 | `commands.js:174-175` | **Ausência de validação de input** — `projectName` e `promptText` chegam sem validação de tamanho máximo. Risco de DoS. Limitar a 256 e 10.000 chars respectivamente. |
| S-04 | `commands.js:215-222` | **Sem limite global de sessões** — limite por usuário existe, mas não há limite total de sessões simultâneas no servidor. Adicionar env var `MAX_GLOBAL_SESSIONS`. |
| S-05 | `commands.js`, `index.js` | **Respostas de erro inconsistentes** — algumas são `ephemeral`, outras não. Extrair helper `replyError(interaction, message)` que sempre responde ephemeral. |
| S-06 | `server-manager.js:91-96` | **`OPENCODE_BIN` não validado na inicialização** — se apontar para binário inexistente, o erro é críptico. Validar na inicialização com `execSync('opencode --version')`. |
| S-07 | `utils.js:24-39` | **Regex ANSI suscetível a ReDoS** — regex artesanal para strip ANSI pode pendurar com input especialmente construído. Considerar biblioteca `strip-ansi`. |
| S-08 | `server-manager.js:143-167` | **Sem circuit breaker para servidores com falha** — após 3 reinícios o servidor fica em status `error`, mas o usuário pode criar nova sessão imediatamente, reiniciando o ciclo. Adicionar cooldown de 60 s. |

---

## 🧪 Cobertura de Testes

### Status Atual por Módulo

| Módulo | Linhas | Cobertura | Status |
|---|---|---|---|
| `index.js` | 207 | 0% | ❌ Sem testes |
| `commands.js` | 606 | 0% | ❌ Sem testes |
| `session-manager.js` | 495 | ~2% | ⚠️ Mínima |
| `stream-handler.js` | 380 | ~5% | ⚠️ Mínima |
| `server-manager.js` | 400 | 0% | ❌ Sem testes |
| `opencode-client.js` | 144 | 0% | ❌ Sem testes |
| `opencode-commands.js` | 87 | 0% | ❌ Sem testes |
| `config.js` | 71 | ~15% | ⚠️ Mínima |
| `utils.js` | 55 | ~40% | ⚠️ Parcial |
| `rate-limiter.js` | 49 | ~20% | ⚠️ Mínima |
| `sse-parser.js` | 92 | ~15% | ⚠️ Mínima |
| `health.js` | 46 | 0% | ❌ Sem testes |

**Cobertura total estimada: ~4%** ❌

---

### Testes Sugeridos por Módulo

#### `index.js` — ❌ Sem testes
- `deveRegistrarComandosSlashNaInicialização`
- `deveEncerrarSessõesAtivasAoReceberSIGINT`
- `deveEncerrarSessõesAtivasAoReceberSIGTERM`
- `deveCapturarUncaughtExceptionSemCrash`
- `deveCapturarUnhandledRejectionSemCrash`
- `deveIgnorarInteraçõesDeBotsExternos`
- `deveVerificarPermissõesDoUsuárioAntesDeExecutar`

#### `commands.js` — ❌ Sem testes
- `deveCriarSessãoComProjectPathVálido`
- `deveRejeitarProjectPathFora do BasePath`
- `deveRejeitarProjectPathInexistente`
- `deveRespeitar LimiteDeSessionsPorUsuário`
- `deveResponderEphemeralEmTodosOsErros`
- `deveEnviarMensagemParaSessãoExistente`
- `deveRejeitarMensagemParaSessãoFechada`
- `deveListarProjetosDisponíveis`
- `deveAutocompletarNomesDeProjetoCorretamente`
- `deveLimitarPromptTextA10000Chars`
- `deveLimitarProjectNameA256Chars`
- `deveListarSessõesAtivasDoUsuário`
- `deveEncerarSessãoQuandoSolicitado`
- `deveRejeitarComandoDeUsuárioNãoPermitido`
- `deveRetornarErroSeDiscordAPIFalharNaCriação`
- `deveValidarOpçõesDoComandoStart`
- `deveValidarOpçõesDoComandoSend`
- `deveMostrarStatusDaSessãoCorretamente`
- `deveTratarThreadJáExistenteGraciosamente`
- `deveTratarInteraçãoJáRespondidaSemCrash`

#### `session-manager.js` — ⚠️ Mínima (~2%)
- `deveCriarSessãoComIDÚnico`
- `deveIndexarSessãoPorThreadId`
- `deveRemoverDoThreadIndexImediatamenteAoFechar`
- `deveMantêrCachePor10MinutosApósFechar`
- `deveColetarLixoAposExpiracaoDoCache`
- `deveRespeitarLimiteDeSessoesPorUsuário`
- `deveCancelarTimeoutsDeRetryNoClose`
- `deveNãoCriarDuplicataParaMesmaThread`
- `deveEmitirEventoCloseAoEncerrar`
- `deveEmitirEventoErrorEmFalha`

#### `stream-handler.js` — ⚠️ Mínima (~5%)
- `deveFlushBufferNoIntervaloConfigurado`
- `deveNãoExplodirComSessionNull`
- `deveAplicarTimeoutDe5sNaStatusQueue`
- `deveLimitarMensagemAoDiscordMsgLimit`
- `deveStripAnsiAntesDeEnviar`
- `deveAcumularOutputEntreFlushs`
- `devePararFlushAoDesconectar`
- `deveRespeitarRateLimitDoDiscord`

#### `server-manager.js` — ❌ Sem testes
- `deveInicializarServidorOpencode`
- `deveReconectarSSEAposDesconexão`
- `deveNãoReconectarEmAbortIntencional`
- `deveEncaminharEventoSSEParaSessãoCorreta`
- `deveTratarErroEmHandleSSEEventSemQuebrarStream`
- `deveValidarOPENCODE_BINNaInicialização`
- `deveAplicarCircuitBreakerApos3Reinícios`
- `deveAguardarCooldownDe60sAposCircuitBreaker`
- `deveListarServadoresAtivos`

#### `opencode-client.js` — ❌ Sem testes
- `deveEnviarRequisiçãoHTTPCorretamente`
- `deveTratarTimeoutDeConexão`
- `deveRetornarErroEmStatusHTTPNão2xx`
- `deveSerializarBodyComoJSON`
- `deveDeserializarRespostaJSON`
- `deveTratarRespostaVazia`

#### `opencode-commands.js` — ❌ Sem testes
- `deveConstruirComandoRunCorretamente`
- `deveConstruirComandoSendCorretamente`
- `deveEscaparArgumentosComEspaços`
- `deveRetornarArrayDeArgumentos`

#### `config.js` — ⚠️ Mínima (~15%)
- `deveLerVariáveisDeAmbienteCorretamente`
- `deveUsarValoresPadrãoQuandoOptionalAusente`
- `deveLançarErroSeVariávelObrigatóriaAusente`
- `deveConverterSTREAM_UPDATE_INTERVALParaNumber`
- `deveConverterDISCORD_MSG_LIMITParaNumber`
- `deveParsearALLOWED_USER_IDSComoArray`

#### `utils.js` — ⚠️ Parcial (~40%)
- `deveStripCódigosANSISimples`
- `deveStripSequênciasANSIComplexas`
- `deveNãoPendurárComInputMaliciosaReDoS`
- `deveRetornarStringVaziaParaInputVazia`
- `deveTruncaMensagemAoLimiteInformado`

#### `rate-limiter.js` — ⚠️ Mínima (~20%)
- `devePrimeiraChamadaPassarImediatamente`
- `deveBloquearChamadasAcimaDoLimite`
- `deveResetarJanelaAposIntervalo`
- `deveTratarMúltiplosClientesSeparadamente`

#### `sse-parser.js` — ⚠️ Mínima (~15%)
- `deveParseEventoSSESimples`
- `deveParseEventoSSEComMultiplasLinhas`
- `deveIgnorarLinhasDeComentário`
- `deveEmitirEventoComCampoDataCorreto`
- `deveEmitirEventoComCampoEventCorreto`
- `deveTratarChunksParciais`
- `deveTratarStreamVazio`

#### `health.js` — ❌ Sem testes
- `deveRetornar200QuandoSaudável`
- `deveRetornar503QuandoTaxaDeErroAcima50pct`
- `deveIncluirMétricasNaResposta`
- `deveResponderEmMenosDe100ms`

---

## 🚀 Evoluções & Melhorias

### ⚡ Imediato

- Corrigir **B-01** e **B-02** (bugs críticos de race condition e AbortError)
- Corrigir **B-03**, **B-04** e **B-05** (bugs de alto impacto)
- Adicionar testes para `commands.js` (mínimo 20 casos — ver lista acima)
- Corrigir **B-06**, **B-07** e **B-08** (bugs de médio impacto)

---

### 🔴 Alta Prioridade

- **Extrair timeouts para config** (S-02) — centralizar todos os valores em `config.js` com fallback via env var (`ABORT_TIMEOUT_MS`, `FLUSH_TIMEOUT_MS`, etc.)
- **Validação de input em comandos** (S-03) — limitar `projectName` a 256 chars e `promptText` a 10.000 chars; responder ephemeral com mensagem clara se exceder
- **Circuit breaker para servidores com falha** (S-08) — cooldown de 60 s após 3 reinícios consecutivos; expor status no `/health`
- **Testes para `server-manager.js`** — cobrir especialmente o fluxo SSE e o circuit breaker
- **Testes para `opencode-client.js`** — cobrir todos os casos de erro HTTP

---

### 🟡 Média Prioridade

- **Audit logging** — registrar quem criou qual sessão, quando, com qual prompt inicial; gravar em arquivo rotativo ou banco SQLite leve
- **Persistência de sessões** — ao reiniciar o bot, reexibir na thread qual sessão existia e seu último status conhecido (sem retomar o processo)
- **Métricas e observabilidade** — endpoint `/metrics` compatível com Prometheus exportando: sessões ativas, mensagens enviadas, taxa de erros, latência de flush
- **Health check inteligente** — retornar HTTP 503 se taxa de erro nas últimas sessões > 50%; hoje o `/health` responde 200 sempre
- **Cache do autocomplete de projetos** — hoje `readdirSync` é chamado a cada tecla digitada; adicionar cache em memória com TTL de 60 s

---

### 💡 Nice to Have (Futuro)

- **UI de aprovação de permissões no Discord** — botões "✅ Aprovar" / "❌ Negar" inline na thread para cada `tool_use` que requer permissão, em vez de texto puro
- **Histórico estruturado por sessão** — além do output bruto, manter registro de mensagens trocadas com timestamps para exibição de resumo
- **Integração webhook para CI/CD** — endpoint HTTP que recebe payload e inicia uma sessão opencode automaticamente (ex: trigger em merge de PR)
- **Dashboard web de monitoramento** — painel simples com sessões ativas, servidores, últimos erros e métricas em tempo real
- **Rate limiting por projeto** — complementar ao limite por usuário; evitar que um único projeto consuma todos os recursos disponíveis
- **Sugestão inline de comandos na thread** — ao criar uma sessão, enviar mensagem inicial com os comandos disponíveis (`/send`, `/status`, `/close`) como embed formatado

---

## 📜 Changelog

> Esta seção será preenchida conforme os issues acima forem resolvidos.

| Data | Issue | Descrição | Autor |
|---|---|---|---|
| — | — | *Nenhuma entrada ainda* | — |

---

*Documento mantido pela equipe de desenvolvimento do opencode-discord.*
*Para adicionar um novo issue, seguir o padrão das tabelas acima com ID sequencial (B-09, S-09, etc.).*
