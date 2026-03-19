# 📋 ISSUES.md — opencode-discord

> **Documento vivo** — atualizar conforme issues forem resolvidas, novas forem identificadas ou evoluções forem implementadas.

**Data de criação:** 2026-03-17
**Última atualização:** 2026-03-19
**Descrição:** Registro centralizado de bugs, code smells, cobertura de testes e ideias de evolução para o projeto `opencode-discord`. Serve como backlog técnico e guia de qualidade para o desenvolvimento contínuo.

---

## 🐛 Bugs & Issues

> Ordenados por severidade. Corrigir os críticos antes de qualquer nova feature.

| # | Severidade | Arquivo | Descrição |
|---|---|---|---|
| B-01 | ✅ **RESOLVIDO** | `session-manager.js:393-399` | **Race condition no cleanup de sessões** — sessão removida do `_threadIndex` 10 min após fechar; se nova sessão for criada na mesma thread nessa janela, o índice fica duplicado/ambíguo. Fix: separar remoção do `_threadIndex` (imediata) da remoção do cache (10 min). |
| B-02 | ✅ **RESOLVIDO** | `server-manager.js:197-207` | **Promise rejection não tratada no AbortError** — quando `sseAbortController` é acionado intencionalmente (shutdown), `.then(() => reconnect())` é chamado mesmo assim porque a promise resolve normalmente. Fix: distinguir `AbortError` de erros reais. |
| B-03 | ✅ **RESOLVIDO** (já estava implementado) | `index.js:75-99` | **Unhandled rejection em erros de Discord API** — se a interação já foi respondida e o `catch` tenta `reply()` novamente, lança segunda exceção não tratada. Fix: checar `interaction.replied` e `interaction.deferred` antes de responder. |
| B-04 | ✅ **RESOLVIDO** | `stream-handler.js:222-225` | **Null check ausente em `session.status`** — `this.session` pode virar `null`/`undefined` em cleanup assíncrono; acesso a `this.session.status` explode com `TypeError`. Fix: adicionar guard `this.session &&`. |
| B-05 | ✅ **RESOLVIDO** | `session-manager.js:280-296` | **Race condition no retry de permissões** — `tryApprove()` usa `setTimeout` fire-and-forget; se a sessão fechar antes do retry, o `server.client` está obsoleto e os timeouts não são cancelados em `close()`. Fix: registrar timeouts em array e cancelar em `close()`. |
| B-06 | ✅ **RESOLVIDO** | `index.js:176-185` | **Thread fetch pode travar no shutdown** — `client.channels.fetch()` durante shutdown pode pendurar indefinidamente se o Discord estiver inacessível. Fix: adicionar timeout de 2 s por fetch. |
| B-07 | ✅ **RESOLVIDO** | `server-manager.js:217-249` | **SSE event dispatch sem try-catch** — se `session.handleSSEEvent()` lançar erro, derruba todo o listener SSE, quebrando o stream para todas as sessões do servidor. Fix: envolver em `try-catch` com `session.emit('error', err)`. |
| B-08 | ✅ **RESOLVIDO** | `stream-handler.js:49-62` | **Status queue sem timeout** — se `flush()` travar (rate limit / rede), a queue de status acumula indefinidamente. Fix: `Promise.race` com timeout de 5 s por item da queue. |
| B-09 | 🟡 **Médio** | `session-manager.js:506-510` | **`_checkTimeouts()` chama `close()` sem `await`** — `session.close()` é async mas é chamado sem `await` num loop síncrono; falhas de rede durante o close tornam-se `unhandledRejection` silenciosa. Além disso, `_checkTimeouts` deleta a sessão de `_sessions` imediatamente enquanto o `setTimeout` de 10 min registrado em `create()` ainda vai tentar deletá-la novamente (double-delete assimétrico). Fix: extrair `_expireSession(session)` async com `.catch()`, ou delegar ao fluxo normal de `destroy()` e cancelar o timer de cleanup. |
| B-10 | 🟡 **Médio** | `stream-handler.js:70-76` | **Timer de arquivamento de thread não rastreado** — o `setTimeout(THREAD_ARCHIVE_DELAY_MS)` criado no evento `close` não é armazenado em nenhuma variável; `stop()` não o cancela. Se o bot for desligado antes do timer disparar, o callback tenta chamar `thread.setArchived(true)` com o Discord client já destruído, gerando erros silenciosos. Fix: armazenar em `this._archiveTimer` e cancelar em `stop()`. |
| B-11 | 🟡 **Médio** | `commands.js:557-568` | **Thread Discord órfã se `sessionManager.create()` falhar** — em `createSessionInThread()`, a thread Discord é criada *antes* de `sessionManager.create()`. Se `session.start()` falhar (ex: binário opencode não encontrado, porta ocupada), a thread fica criada no Discord sem sessão associada, nunca é arquivada ou deletada, e o usuário vê uma thread vazia. Fix: envolver `sessionManager.create()` em try-catch e arquivar/deletar a thread em caso de falha. |

---

## 🔧 Code Smells & Design Issues

| # | Arquivo(s) | Descrição |
|---|---|---|
| S-01 | `commands.js:206-213` e `commands.js:463-472` | ✅ **Duplicação de validação de `projectPath`** — mesma lógica de `validateProjectPath()` + `existsSync()` repetida em dois lugares. Extrair para helper `validateAndGetProjectPath()`. |
| S-02 | `stream-handler.js`, `index.js`, `server-manager.js` | ✅ **Timeouts hardcoded** — valores como `5000`, `10000`, `2000`, `1000` ms espalhados em múltiplos arquivos. Centralizar em `config.js` com variáveis de ambiente. |
| S-03 | `commands.js:174-175` | ✅ **Ausência de validação de input** — `projectName` e `promptText` chegam sem validação de tamanho máximo. Risco de DoS. Limitar a 256 e 10.000 chars respectivamente. |
| S-04 | `commands.js:215-222` | ✅ **Sem limite global de sessões** — limite por usuário existe, mas não há limite total de sessões simultâneas no servidor. Adicionar env var `MAX_GLOBAL_SESSIONS`. |
| S-05 | `commands.js`, `index.js` | ✅ **Respostas de erro inconsistentes** — algumas são `ephemeral`, outras não. Extrair helper `replyError(interaction, message)` que sempre responde ephemeral. |
| S-06 | `server-manager.js:91-96` | ✅ **`OPENCODE_BIN` não validado na inicialização** — se apontar para binário inexistente, o erro é críptico. Validar na inicialização com `execSync('opencode --version')`. |
| S-07 | `utils.js:24-39` | ✅ **Regex ANSI suscetível a ReDoS** — regex artesanal para strip ANSI pode pendurar com input especialmente construído. Considerar biblioteca `strip-ansi`. |
| S-08 | `server-manager.js:143-167` | ✅ **Sem circuit breaker para servidores com falha** — após 3 reinícios o servidor fica em status `error`, mas o usuário pode criar nova sessão imediatamente, reiniciando o ciclo. Adicionar cooldown de 60 s. |
| S-09 | `commands.js:583-591` | **`getProjects()` síncrono e sem cache** — `readdirSync` bloqueante é chamado a cada tecla digitada no autocomplete de projetos e ao listar projetos com `/projetos`. Para diretórios com muitos subpastas ou disco lento (NAS, rede), bloqueia o event loop. Extrair para função async com cache em memória de 60 s (TTL). |
| S-10 | `health.js:16-34` | **Health check não expõe estado dos servidores OpenCode** — `/health` lista contagem de sessões mas não o estado dos `OpenCodeServer`s (circuit breaker ativo, porta, status SSE). Um servidor em status `error` com circuit breaker ativado passa como saudável. Fix: incluir `servers[]` com `{ port, status, circuitBreakerUntil }` no payload e retornar HTTP 503 se taxa de erro > 50%. |
| S-11 | `server-manager.js:437-443` | **`_doAllocatePort()` sem limite máximo de iterações** — loop `while` sem teto; se todas as portas do intervalo estiverem ocupadas (improvável mas possível em ambientes restritos ou com muitos servidores), o loop trava indefinidamente. Fix: adicionar limite (`OPENCODE_BASE_PORT + 200`) e lançar `Error` descritivo se excedido. |
| S-12 | `session-manager.js:208-246` | **Lógica de transição de status duplicada** — os casos `session.status` (com `statusType === 'idle'`) e `session.idle` executam bloco idêntico de `isWaitingForInput` → `waiting_input` ou `finished`. Qualquer mudança de comportamento exige alteração em dois lugares. Fix: extrair `_handleIdleTransition()` privada e chamar nos dois handlers. |

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

### Meta de Cobertura por Fase

| Fase | Meta Total | Prazo | Módulos Prioritários |
|---|---|---|---|
| Atual | ~4% | — | — |
| v1.3 | **30%** | Q1 2026 | `utils.js`, `rate-limiter.js`, `sse-parser.js`, `config.js`, `session-manager.js` |
| v1.4 | **50%** | Q2 2026 | + `opencode-client.js`, `commands.js`, `health.js` |
| v2.0 | **65%** | Q3 2026 | + `server-manager.js`, `stream-handler.js`, `index.js` |

**Ordem recomendada de implementação de testes:**

1. **`utils.js`** — funções puras sem efeitos colaterais; rápido de testar; impacto imediato na confiança do stripAnsi
2. **`rate-limiter.js`** — classe isolada com estado simples; cobertura de janela deslizante e multi-usuário
3. **`sse-parser.js`** — crítico para confiabilidade do streaming; testar chunks parciais e JSON inválido
4. **`config.js`** — fundação de todo o projeto; testar defaults, parsing de tipos e validação de paths
5. **`session-manager.js`** — maior ROI; cobre race conditions, lifecycle, timeouts e índices
6. **`opencode-client.js`** — testar com `fetch` mockado; cobrir todos os status HTTP de erro
7. **`commands.js`** — maior número de cenários de usuário; requer mocks de Discord API e SessionManager
8. **`health.js`** — testar com mocks de sessionManager/serverManager; verificar 200 e futuro 503
9. **`server-manager.js`** — mais complexo; requer mock de `child_process.spawn` e sockets
10. **`stream-handler.js`** — requer mock completo da thread Discord; testar flush, chunks e status queue

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

### ⚡ Imediato (patches v1.x)

- **Cobertura de testes** — expandir de ~4% para 30%+ (módulo a módulo, começando por `utils.js`, `rate-limiter.js`, `sse-parser.js`, `config.js`, depois `session-manager.js`, depois `commands.js`)
- **Corrigir B-09, B-10, B-11** — novos bugs identificados na revisão: `_checkTimeouts` sem await, archive timer não rastreado, thread órfã em falha de sessão
- **Cache do autocomplete** — `listOpenCodeCommands()` e `getProjects()` (S-09) chamam filesystem a cada tecla; adicionar cache em memória com TTL de 60 s
- **Health check 503** — `/health` retorna 200 sempre; retornar HTTP 503 se taxa de erro das últimas sessões > 50%, e incluir estado dos `OpenCodeServer`s no payload (S-10)
- **Comando `/diff` completo** — já existe preview de diff emitido via eventos SSE em `stream-handler.js`; expor como slash command `/diff` com opções (staged, unstaged, branch)
- **Refatorar `_handleIdleTransition()`** — eliminar duplicação de lógica entre `session.status` e `session.idle` em `session-manager.js` (S-12)
- **Limite em `_doAllocatePort()`** — adicionar teto máximo de portas para evitar loop teórico infinito (S-11)

---

### 🔴 Alta Prioridade (v1.3 — Estabilidade)

- **Persistência de sessões** — salvar mapeamento `threadId↔sessionId↔port` em `~/.opencode-discord/data.json`; ao reiniciar, exibir na thread o último status conhecido (sem retomar o processo opencode)
- **Fila de tarefas (job queue)** — quando sessão está ocupada (status ≠ idle), enfileirar mensagens com reação 📥; processar automaticamente quando sessão ficar idle; suporte a pause/resume via `/fila`
- **Modo passthrough** — comando `/modo` toggle: libera thread para digitação livre → tudo vai direto para opencode (sem precisar de `/build`, `/plan` etc.); útil para conversas longas; indicador visual no embed
- **Seleção de modelo AI** — `/modelo set claude-3-7/gpt-4o` persiste por canal; `/modelo ver` exibe atual; autocomplete com modelos disponíveis
- **Botões de aprovação de permissão** — quando opencode pede permissão para tool_use, enviar botões Discord "✅ Aprovar" / "❌ Negar" inline na thread em vez de aprovação automática; ephemeral para o dono da sessão
- **Endpoint `/metrics` Prometheus** — exportar: `sessions_active`, `sessions_total`, `messages_sent`, `error_rate`, `flush_latency_ms`; scrape-friendly
- **Audit logging estruturado** — registrar em SQLite leve (`~/.opencode-discord/audit.db`): quem criou qual sessão, quando, com qual prompt; `/auditoria` command para admins

---

### 🟡 Média Prioridade (v2.0 — Poder)

- **Git Worktrees** — comando `/trabalho [projeto] [branch]` cria worktree isolada por sessão; `/autotrabalho` cria branch automática baseada no prompt; merge via botão Discord; previne conflitos entre sessões paralelas
- **Browser de sessões** — `/sessao lista` mostra todas (ativas + arquivadas); `/sessao conectar [id]` re-anexa uma sessão a uma thread nova; `/sessao desconectar` desvincula thread sem fechar sessão
- **Voice input** — transcreve mensagens de voz Discord (arquivos `.ogg`) via OpenAI Whisper REST (`whisper-1`); transcrição exibida antes de enviar ao opencode; configurável via `OPENAI_API_KEY`
- **Upload de arquivos** — anexos Discord (`.js`, `.ts`, `.md`, `.txt`) salvos automaticamente no projeto antes de enviar o prompt ao opencode; útil para "refatora este arquivo"
- **Wizard de setup interativo** — `node src/setup.js` guia o usuário pelo setup (token, guild, projetos, serviço Windows) com validação em tempo real
- **Rate limiting por projeto** — complementar ao limite por usuário; impedir que um único projeto consuma todos os slots disponíveis com `MAX_SESSIONS_PER_PROJECT`

---

### 💡 Nice to Have (v2.x+)

- **Dashboard web de monitoramento** — página HTML simples servida na porta `DASHBOARD_PORT`; mostra sessões ativas, servidores, histórico de erros, métricas em tempo real
- **Adapter para Telegram** — mesma lógica de negócio, interface diferente; extrair camada de transporte para permitir múltiplos adapters
- **Publicação npm** — publicar `opencode-discord` no npm com `npx opencode-discord setup` e `npx opencode-discord start`
- **Webhook CI/CD** — endpoint HTTP que recebe payload de webhook (GitHub, GitLab) e inicia sessão opencode automaticamente em trigger de PR/merge
- **Integração VS Code Remote** — extensão VS Code que expõe o mesmo bot como painel lateral para ambientes remotos

---

## 📜 Changelog

> Esta seção será preenchida conforme os issues acima forem resolvidos.

| Data | Issue | Descrição | Autor |
|---|---|---|---|
| 2026-03-18 | B-01 | Race condition no cleanup: `_threadIndex` agora removido imediatamente no evento `close`; `_sessions` mantido em cache por 10 min | AI |
| 2026-03-18 | B-02 | AbortError em SSE: guard `this.status !== 'stopped'` no `.then()` de `connectSSE` evita reconexão após shutdown intencional | AI |
| 2026-03-18 | B-04 | Null check em `session.status`: guard `this.session &&` adicionado no `flush()` do StreamHandler | AI |
| 2026-03-18 | B-05 | Race condition em `tryApprove`: timeouts rastreados em `_pendingTimeouts[]` e cancelados no `close()` | AI |
| 2026-03-18 | B-06 | Fetch timeout no shutdown: `fetchWithTimeout` com `Promise.race` + `CHANNEL_FETCH_TIMEOUT_MS` | AI |
| 2026-03-18 | B-07 | SSE dispatch com try-catch: `handleSSEEvent` protegido; erro emitido via `session.emit('error')` | AI |
| 2026-03-18 | B-08 | Status queue timeout: `Promise.race` com `STATUS_QUEUE_ITEM_TIMEOUT_MS` (5s) por item da fila | AI |
| 2026-03-18 | S-01 | DRY de validação: helper `validateAndGetProjectPath()` extraído em `commands.js` | AI |
| 2026-03-18 | S-02 | Timeouts centralizados: 7 novas constantes em `config.js` com suporte a env vars | AI |
| 2026-03-18 | S-03 | Validação de input: limite de 256 chars em `projectName` e 10.000 em `promptText` | AI |
| 2026-03-18 | S-04 | Limite global de sessões: `MAX_GLOBAL_SESSIONS` env var adicionada a `config.js` e `commands.js` | AI |
| 2026-03-18 | S-05 | Erros ephemeral consistentes: helper `replyError()` extraído em `commands.js` | AI |
| 2026-03-18 | S-06 | Validação do OPENCODE_BIN: `_validateBin()` com `execSync --version` no `ServerManager` | AI |
| 2026-03-18 | S-07 | ReDoS em ANSI: `stripAnsi` migrado para lib `strip-ansi@7` (pure ESM) | AI |
| 2026-03-18 | S-08 | Circuit breaker: cooldown `SERVER_CIRCUIT_BREAKER_COOLDOWN_MS` (60s) após 3 reinícios no `ServerManager` | AI |

---

*Documento mantido pela equipe de desenvolvimento do opencode-discord.*
*Para adicionar um novo issue, seguir o padrão das tabelas acima com ID sequencial (B-09, S-09, etc.).*
