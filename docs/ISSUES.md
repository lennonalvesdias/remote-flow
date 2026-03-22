# 📋 ISSUES.md — RemoteFlow

> **Documento vivo** — atualizar conforme issues forem resolvidas, novas forem identificadas ou evoluções forem implementadas.

**Data de criação:** 2026-03-17
**Última atualização:** 2026-03-20
**Descrição:** Registro centralizado de bugs, code smells, cobertura de testes e ideias de evolução para o projeto `remote-flow`. Serve como backlog técnico e guia de qualidade para o desenvolvimento contínuo.

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
| B-09 | ✅ **RESOLVIDO** | `session-manager.js:506-510` | **`_checkTimeouts()` chama `close()` sem `await`** — `session.close()` é async mas é chamado sem `await` num loop síncrono; falhas de rede durante o close tornam-se `unhandledRejection` silenciosa. Além disso, `_checkTimeouts` deleta a sessão de `_sessions` imediatamente enquanto o `setTimeout` de 10 min registrado em `create()` ainda vai tentar deletá-la novamente (double-delete assimétrico). Fix: extrair `_expireSession(session)` async com `.catch()`, ou delegar ao fluxo normal de `destroy()` e cancelar o timer de cleanup. |
| B-10 | ✅ **RESOLVIDO** | `stream-handler.js:70-76` | **Timer de arquivamento de thread não rastreado** — o `setTimeout(THREAD_ARCHIVE_DELAY_MS)` criado no evento `close` não é armazenado em nenhuma variável; `stop()` não o cancela. Se o bot for desligado antes do timer disparar, o callback tenta chamar `thread.setArchived(true)` com o Discord client já destruído, gerando erros silenciosos. Fix: armazenar em `this._archiveTimer` e cancelar em `stop()`. |
| B-11 | ✅ **RESOLVIDO** | `commands.js:557-568` | **Thread Discord órfã se `sessionManager.create()` falhar** — em `createSessionInThread()`, a thread Discord é criada *antes* de `sessionManager.create()`. Se `session.start()` falhar (ex: binário opencode não encontrado, porta ocupada), a thread fica criada no Discord sem sessão associada, nunca é arquivada ou deletada, e o usuário vê uma thread vazia. Fix: envolver `sessionManager.create()` em try-catch e arquivar/deletar a thread em caso de falha. |

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
| S-09 | ✅ **RESOLVIDO** | `commands.js:583-591` | **`getProjects()` síncrono e sem cache** — `readdirSync` bloqueante é chamado a cada tecla digitada no autocomplete de projetos e ao listar projetos com `/projetos`. Para diretórios com muitos subpastas ou disco lento (NAS, rede), bloqueia o event loop. Extrair para função async com cache em memória de 60 s (TTL). |
| S-10 | ✅ **RESOLVIDO** | `health.js:16-34` | **Health check não expõe estado dos servidores OpenCode** — `/health` lista contagem de sessões mas não o estado dos `OpenCodeServer`s (circuit breaker ativo, porta, status SSE). Um servidor em status `error` com circuit breaker ativado passa como saudável. Fix: incluir `servers[]` com `{ port, status, circuitBreakerUntil }` no payload e retornar HTTP 503 se taxa de erro > 50%. |
| S-11 | ✅ **RESOLVIDO** | `server-manager.js:437-443` | **`_doAllocatePort()` sem limite máximo de iterações** — loop `while` sem teto; se todas as portas do intervalo estiverem ocupadas (improvável mas possível em ambientes restritos ou com muitos servidores), o loop trava indefinidamente. Fix: adicionar limite (`OPENCODE_BASE_PORT + 200`) e lançar `Error` descritivo se excedido. |
| S-12 | ✅ **RESOLVIDO** | `session-manager.js:208-246` | **Lógica de transição de status duplicada** — os casos `session.status` (com `statusType === 'idle'`) e `session.idle` executam bloco idêntico de `isWaitingForInput` → `waiting_input` ou `finished`. Qualquer mudança de comportamento exige alteração em dois lugares. Fix: extrair `_handleIdleTransition()` privada e chamar nos dois handlers. |

---

## 🧪 Cobertura de Testes

### Status Atual por Módulo

| Módulo | % Stmts | % Branch | % Funcs | % Lines | Status |
|---|---|---|---|---|---|
| `index.js` | — | — | — | — | ⚙️ excluído do coverage |
| `commands.js` | 87% | 74.01% | 89.18% | 87.3% | ✅ Meta atingida |
| `config.js` | 100% | 100% | 100% | 100% | ✅ Meta atingida |
| `health.js` | 95.65% | 100% | 85.71% | 95% | ✅ Meta atingida |
| `opencode-client.js` | 86.11% | 82.35% | 87.5% | 86.11% | ✅ Meta atingida |
| `opencode-commands.js` | 96.66% | 93.75% | 100% | 96% | ✅ Meta atingida |
| `rate-limiter.js` | 100% | 100% | 100% | 100% | ✅ Meta atingida |
| `server-manager.js` | 81.4% | 68.35% | 78.57% | 83.51% | ✅ Meta atingida |
| `session-manager.js` | 87.08% | 68.14% | 81.25% | 87.37% | ✅ Meta atingida |
| `sse-parser.js` | 81.81% | 75% | 100% | 87.5% | ✅ Meta atingida |
| `stream-handler.js` | 80.95% | 68.49% | 74.19% | 81.76% | ✅ Meta atingida |
| `utils.js` | 100% | 100% | 100% | 100% | ✅ Meta atingida |

**Cobertura total atual: 85.9% statements** ✅

---

### Meta de Cobertura por Fase

| Fase | Meta Total | Prazo | Status | Módulos Prioritários |
|---|---|---|---|---|
| **Fase 1** (v1.3) | **85.9%** | Q1 2026 | ✅ **CONCLUÍDA** | Todos os 12 módulos |
| **Fase 2** (v1.4) | **90%+** | Q2 2026 | 🔄 Em planejamento | `opencode-client.js`, `commands.js`, `health.js` (edge cases) |
| **Fase 3** (v2.0) | **65%** | Q3 2026 | ⏳ Futuro | `server-manager.js`, `stream-handler.js`, `index.js` |

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

### Histórico de Cobertura

| Data | Total Stmts | Total Branch | Total Funcs | Total Lines | Testes |
|------|-------------|--------------|-------------|-------------|--------|
| 2026-03-17 | ~4% | — | — | — | ~5 testes |
| 2026-03-20 | 85.9% | 75.67% | 83.33% | 86.73% | 349 testes |

---

## 🚀 Evoluções & Melhorias

### ✅ Fase 1 — Concluída (v1.3.0 — 2026-03-20)

**Status: 100% COMPLETA** — Todos os 10 itens implementados.

| Item | Arquivo | Status | Resolução |
|---|---|---|---|
| Cobertura de testes (30%+) | Todos | ✅ | **85.9% atingido** — superou meta com 349 testes Vitest |
| B-09: `_checkTimeouts` async | `session-manager.js` | ✅ | `_expireSession()` extraído; close aguardado; deleção em dois tempos |
| B-10: Archive timer rastreado | `stream-handler.js` | ✅ | `_archiveTimer` adicionado; cancelado em `stop()` |
| B-11: Thread órfã prevenida | `commands.js` | ✅ | Try-catch em `createSessionInThread()`; thread deletada em erro |
| Cache autocomplete (S-09) | `commands.js` | ✅ | `getProjects()` async com TTL 60 s; proteção contra cache stampede |
| Health check 503 (S-10) | `health.js` | ✅ | Retorna HTTP 503 se >50% dos servidores em erro; inclui `servers[]` |
| Comando `/diff` | `commands.js` | ✅ | `handleDiffCommand()` expõe preview de diffs (inline/arquivo) |
| Refatorar S-12 | `session-manager.js` | ✅ | `_handleIdleTransition()` centralizado; duplicação eliminada |
| Limite `_doAllocatePort()` (S-11) | `server-manager.js` | ✅ | Teto `PORT_SCAN_MAX_RANGE = 200`; erro descritivo |
| Persistência JSON | `src/persistence.js` | ✅ | `~/.remote-flow/data.json` com serialização serial |

---

### 🔴 Fase 2 — Pendente (v1.4+ — Q2 2026)

**Status: A INICIAR** — 8 itens identificados para próxima fase.

| Item | Prioridade | Arquivo | Descrição |
|---|---|---|---|
| Fila de tarefas | 🔴 Alta | `session-manager.js` | Mensagens durante `running` enfileiradas com reação 📥; processadas ao idle |
| Botões de aprovação | 🔴 Alta | `stream-handler.js` | "✅ Aprovar" / "❌ Negar" inline (timeout 60 s); fallback automático |
| Modo passthrough | 🔴 Alta | `commands.js` | `/modo passthrough` ativa forwarding de mensagens sem slash command |
| Seleção de modelo AI | 🟡 Média | `persistence.js` | `/modelo set <nome>` persiste em `data.json`; autocomplete com modelos |
| Endpoint `/metrics` | 🟡 Média | `health.js` | Prometheus: `sessions_active`, `sessions_total`, `messages_sent_total`, `errors_total`, `flush_latency_ms` |
| Audit logging | 🟡 Média | Novo: `src/audit.js` | SQLite leve em `~/.remote-flow/audit.db`; `/auditoria` command para admins |
| Rate limiting por projeto | 🟡 Média | `config.js`, `commands.js` | `MAX_SESSIONS_PER_PROJECT` env var; rejeitar se limite atingido |
| Cobertura 90%+ | 🟡 Média | Todos | Expandir testes para 90% statements; target: edge cases em `opencode-client.js`, `commands.js`, `health.js` |

---

### ⚡ Patches Imediatos (v1.3.x)

- Nenhum bug crítico pendente — Fase 1 concluída com alta qualidade

---

### 🟡 Média Prioridade (v2.0+ — Futuro)

- **Git Worktrees** — `/trabalho [projeto] [branch]` cria worktree isolada por sessão; previne conflitos entre sessões paralelas
- **Browser de sessões** — `/sessao lista` exibe todas (ativas + arquivadas); `/sessao conectar` re-anexa sessão a thread nova
- **Upload de arquivos** — anexos Discord (`.js`, `.ts`, `.md`, `.txt`) salvos automaticamente no projeto antes de enviar prompt
- **Voice input** — transcrição via OpenAI Whisper REST (`whisper-1`); configurável via `OPENAI_API_KEY`
- **Wizard de setup interativo** — `node src/setup.js` guia o usuário pelo setup completo
- **Dashboard web** — página HTML simples na porta `DASHBOARD_PORT`; exibe sessões ativas, métricas em tempo real

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
| 2026-03-19 | B-09 | `_checkTimeouts` async: `_expireSession()` extraído — `session.close()` agora aguardado com `.catch()`; deleção dos índices só ocorre após o close terminar | AI |
| 2026-03-19 | B-10 | Archive timer rastreado: `_archiveTimer` adicionado ao construtor do `StreamHandler`; `stop()` cancela o timer antes que o cliente Discord seja destruído | AI |
| 2026-03-19 | B-11 | Thread órfã prevenida: `createSessionInThread()` agora envolve criação da sessão em try-catch e chama `thread.delete()` se `sessionManager.create()` ou `streamHandler.start()` falharem | AI |
| 2026-03-19 | S-09 | `getProjects()` async com cache: `readdirSync` substituído por `readdir` de `fs/promises`; cache em memória com TTL de 60 s adicionado; todos os call sites atualizados para `await` | AI |
| 2026-03-19 | S-10 | Health check com estado dos servidores: `serverManager.getAll()` adicionado ao `ServerManager`; `/health` agora inclui `servers[]` com `{ port, status, circuitBreakerUntil }`; retorna HTTP 503 se >50% dos servidores em erro | AI |
| 2026-03-19 | S-11 | Limite em `_doAllocatePort()`: constante `PORT_SCAN_MAX_RANGE = 200` adicionada; loop `while` limitado com contador `attempts`; lança `Error` descritivo se o intervalo se esgotar | AI |
| 2026-03-19 | S-12 | `_handleIdleTransition()` extraído: lógica de transição idle→waiting_input/finished centralizada em método privado; elimina duplicação entre handlers `session.status` e `session.idle` | AI |

---

*Documento mantido pela equipe de desenvolvimento do RemoteFlow.*
*Para adicionar um novo issue, seguir o padrão das tabelas acima com ID sequencial (B-09, S-09, etc.).*
