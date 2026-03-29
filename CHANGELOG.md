# Changelog

Todas as mudanças notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [1.8.0] — 2026-03-29

### 🧪 Tests
- Criada suite completa de testes de integração em `tests/integration/` com 18 arquivos cobrindo todos os fluxos principais do projeto
- Adicionados helpers reutilizáveis em `tests/helpers/` (discord-mocks, process-mocks, network-mocks, fs-mocks, fixtures, timer-utils) para padronizar mocks de fronteiras externas
- Fluxos cobertos: ciclo de vida de sessão, streaming para Discord, comandos slash, roteamento de mensagens, permissões, detecção de planos, transcrição de voz, integração GitHub, geração de relatórios, health check, persistência, auditoria, logging, inicialização, encerramento gracioso, recuperação de erros, rate limiting e operações concorrentes
- Adicionados scripts `test:unit` e `test:integration` ao `package.json` para execução separada por categoria

---

## [1.7.2] — 2026-03-28

### 🐛 Fixed

- **Fallback automático de CUDA para CPU no Whisper Server** — quando `cublas64_12.dll` está ausente (CUDA 11.x incompatível com CTranslate2 v4), o servidor agora detecta a falha no startup e recarrega o modelo em CPU automaticamente, evitando travamentos de 120s nas transcrições subsequentes

### ✨ Adicionado

- **Validação de CUDA com inferência de teste** — ao iniciar com `DEVICE=cuda`, o servidor executa uma inferência de teste (0.2s de silêncio via `numpy`) imediatamente após carregar o modelo; qualquer falha de CUDA é capturada antes de aceitar requisições
- **Log persistente do bot Node.js** — novo módulo `src/console-logger.js`; intercepta `console.log/warn/error/info` e `process.stderr` e persiste toda saída em `logs/bot-YYYY-MM-DD.log`; arquivos com mais de 24h são removidos automaticamente no startup
- **Log persistente do Whisper Server** — `whisper_server/server.py` agora escreve logs em `logs/whisper-YYYY-MM-DD.log` via `logging.FileHandler`; arquivos com mais de 24h são removidos automaticamente no startup

---

## [1.7.1] — 2026-03-28

### 🐛 Fixed

- **Timeout na transcrição de voz** — corrigido `AbortSignal.timeout` de 30s para 120s na chamada ao Whisper Server (`src/whisper-client.js`); o cold-start de CUDA (compilação de kernels na primeira inferência real) pode levar 15–60s, causando timeout antes da resposta
- **Timeout no download da CDN do Discord** — aumentado de 15s para 30s (`src/index.js`) para tolerar variações de latência da CDN em arquivos maiores
- **MIME type ausente no Blob** — `FormData.append` agora passa `{ type: 'audio/ogg' }` ao construir o `Blob`, garantindo o `Content-Type` correto no campo `audio` do multipart

### 🔧 Changed

- Novos timeouts são configuráveis via variáveis de ambiente: `VOICE_CDN_DOWNLOAD_TIMEOUT_MS` (padrão: 30000) e `WHISPER_TRANSCRIPTION_TIMEOUT_MS` (padrão: 120000)

---

## [1.7.0] — 2026-03-28

### ✨ Adicionado

- **Transcrição de mensagens de voz** — o bot detecta automaticamente mensagens de voz do Discord (`.ogg` / Opus com `duration_secs`) e arquivos de áudio e transcreve o conteúdo antes de encaminhar ao OpenCode via `session.queueMessage()`
- Novo módulo `src/whisper-client.js` — cliente HTTP para o Whisper Server local; usa `fetch` e `FormData` nativos do Node 20 (sem dependências npm adicionais)
- Novo módulo `src/transcription-provider.js` — abstração multi-provider que suporta três backends: `local` (Whisper Server Python), `openai` (API oficial) e `groq` (API compatível com OpenAI); seleção via `TRANSCRIPTION_PROVIDER`
- Microserviço Python `whisper_server/server.py` — Flask + waitress + faster-whisper (CTranslate2); expõe `POST /transcribe` e `GET /health`; guard de 25 MB e timeout de 120s
- Script `whisper_server/setup.ps1` — setup automatizado do venv Python e download do modelo
- Script npm `whisper` para iniciar o servidor Python local
- Novas variáveis de ambiente: `TRANSCRIPTION_PROVIDER`, `WHISPER_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_API_MODEL`, `VOICE_MAX_DURATION_SECS`, `VOICE_SHOW_TRANSCRIPT`
- Health check de transcrição no startup do bot — ativa/desativa a feature automaticamente conforme disponibilidade do provider
- Transcrição exibida como reply na thread antes de encaminhar ao OpenCode (configurável via `VOICE_SHOW_TRANSCRIPT`)
- Auditoria de mensagens de voz via `audit('message.voice', ...)` com duração, comprimento do texto e provider

---

## [1.6.2] — 2026-03-28

### 🐛 Fixed
- Corrigido deadlock de fila após `question.asked`: evento `message.part.delta` residual não reseta mais o status `waiting_input` → `running` quando há pergunta pendente (`_pendingQuestion`) (RF-07)
- Fila de mensagens agora é drenada ao receber `question.asked`, processando respostas enfileiradas durante a janela de transição

### 🔧 Changed
- `PlannotatorClient._fetch()`: logs de retry consolidados — apenas a falha final é registrada (1 log/request em vez de 3)
- `PlanReviewDetector._poll()`: supressão de logs repetitivos de falha consecutiva (máx. 1 log a cada 30 segundos)

### 📝 Docs
- Logs de transição de status enriquecidos com contexto (sessionId, queue size, pendingQuestion) para facilitar diagnóstico
- Aviso de fila potencialmente presa adicionado ao `_checkTimeouts()` (inatividade > 60s com mensagens enfileiradas)

---

## [1.6.1] — 2026-03-28

### 🐛 Fixed
- Buffer de narração com overflow agora move conteúdo para output normal em vez de descartá-lo silenciosamente (`_exitNarrationPhase(true)`)
- Conteúdo preso em `_narrationBuffer` ao término de sessão (`finished`/`error`/`restart`) é agora preservado e enviado ao Discord antes do flush final
- Timers `reasoningTimer` e `_gapTimer` agora recebem `null` após `clearTimeout` em `stop()`, evitando referências dangling
- Evento `reasoning` cancela o gap detector imediatamente, evitando falso indicador de tool activity durante raciocínio ativo da IA
- Remoção de código morto: bloco `if (_outputBlockHeaderNeeded)` em `flush()` que nunca executava
- Reset de `_inOutputBlock` adicionado ao handler de `status === 'running'`, garantindo novo ciclo limpo em sessões multi-rodada

### 🧪 Tests
- 2 novos testes de edge case para `_processNarrationChunk()`: overflow sem perda de conteúdo e sessão encerrada durante fase de narração

---

## [1.6.0] — 2026-03-28

### ✨ Added
- Exibição de conteúdo de reasoning da IA no Discord: pensamento interno exibido como texto sutil `-# 💭 *...*`, truncado em 400 chars para não sobrecarregar o canal
- Indicador de atividade de ferramentas: quando o agente está executando uma ferramenta sem produzir output por 2500ms, exibe `-# ⚙️ processando...` de forma sutil
- Heurística de narração: texto inicial do ciclo que detecta padrões de narração interna da IA (`"The user wants..."`, `"I should..."`, `"Let me..."`) é roteado automaticamente para exibição de reasoning em vez de output normal

### 🔧 Changed
- Resposta do agente agora é exibida como texto limpo, sem blockquote `>>>` nem cabeçalho `-# 💭 análise do agente`
- Campo `reasoning` do SSE (`message.part.delta` com `field: 'reasoning'`) agora emite evento separado `'reasoning'` no `session-manager` em vez de ser descartado silenciosamente

---

## [1.5.0] — 2026-03-28

### ✨ Added
- Módulo `src/plan-detector.js` — detecção de requisições de revisão de planos via Discord
- Módulo `src/plannotator-client.js` — cliente para integração com o serviço plannotator
- Módulo `src/model-loader.js` — utilitários de carregamento de modelos
- Revisão paralela de planos via Discord + integração com plannotator (RF-plan-review)
- Comando `/report` — analisa erros recentes de sessão e gera relatório de comportamento
- Módulo `src/logger.js` — persistência de logs em arquivo
- Módulo `src/reporter.js` — geração de relatórios com análise de erros recentes
- Módulo `src/utils.js` — utilitários compartilhados entre módulos
- Módulo `src/audit.js` — funcionalidades de auditoria de sessão
- Comando `/reconnect` — aciona manualmente a reconexão SSE
- Reconexão SSE resiliente com lógica de backoff melhorada

### 🐛 Fixed
- Regex com estado, limite de mensagens Discord e timestamp no módulo `reporter`
- Mocks de teste para `PlanReviewDetector` e `interaction.isModalSubmit`

### 🔧 Changed
- Atualização de dependência: `picomatch` 4.0.3 → 4.0.4
- Documentos auxiliares `FORMATTING_PIPELINE.md` e `QUICK_REFERENCE.md` movidos para `docs/`
- AGENTS.md: adicionada regra de organização de arquivos `.md` auxiliares em `docs/`

---

## [1.4.0] — 2026-03-22

### ✨ Added
- Integração nativa com GitHub via Octokit
- Comando `/pr create` — cria branch, commit, push e Pull Request a partir das mudanças da sessão atual
- Comando `/pr list` — lista Pull Requests abertos do repositório
- Comando `/pr review` — cria sessão de revisão com agente plan e publica o review no GitHub
- Comando `/issue list` — lista issues abertas com filtro por label
- Comando `/issue implement` — busca issue e inicia sessão build com contexto completo
- Módulo `src/git.js` — utilitários git (branch, commit, push, extração de owner/repo)
- Módulo `src/github.js` — cliente Octokit para PRs, reviews e issues
- Variáveis de ambiente: `GITHUB_TOKEN`, `GITHUB_DEFAULT_OWNER`, `GITHUB_DEFAULT_REPO`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`
- Botão interativo "Publicar Review no GitHub" após conclusão de sessão de revisão

### 🔒 Security
- Token do GitHub embutido na URL do remote apenas durante o push — URL limpa restaurada no bloco `finally`
- Diff de PRs truncado em 80KB antes de enviar ao agente de IA

---

## [1.3.0] - 2026-03-20

### Adicionado

- **Comando `/diff`** — exibe diff Git da sessão na thread
  - Diffs pequenos (< 1500 chars): inline com syntax highlighting
  - Diffs grandes: enviados como arquivo `.diff` anexo
  - Suporte a múltiplos diffs por evento (`handleDiffCommand` em `commands.js`)
- **Persistência de sessões** — salva estado em `~/.remote-flow/data.json`
  - Serialização serial com serializer customizado para evitar race conditions
  - Recuperação de sessão ao reiniciar o bot (exibe último status na thread)
  - Formato: `{ threads: { threadId: { sessionId, port, status, projectPath } } }`

### Melhorado

- **Circuit breaker para servidores com falha** — cooldown de 60 s após 3 reinícios consecutivos
  - Health check detecta servidores indisponíveis e rejeita novas sessões temporariamente
  - Risco de "thundering herd" mitigado com exponential backoff
- **Auto-aprovação de permissões com retry** — até 3 tentativas com backoff linear
  - Extração de permission ID, tool name e description
  - Tipagem de eventos `permission` (approving / approved / failed / unknown)
- **Health endpoint com status 503** — retorna degradado quando > 50% dos servidores em erro
  - Payload inclui array `servers[]` com estado de cada OpenCodeServer (port, status, circuitBreakerUntil)
  - Melhor observabilidade para load balancers e health checks de produção
- **Testes: cobertura elevada de ~4% para 85,9%** — 349 testes com Vitest
  - Meta v1.3 (30%+) **superada** significativamente
  - 11 arquivos de teste cobrindo camadas críticas: `commands.js`, `config.js`, `rate-limiter.js`, `session-manager.js`, `stream-handler.js`, etc.

### Corrigido

- **B-09**: `_checkTimeouts()` agora aguarda `close()` assincronamente; elimina double-delete do `_sessions`
- **B-10**: Timer de arquivamento de thread rastreado em `_archiveTimer`; cancelado em `stop()`
- **B-11**: Try-catch em `createSessionInThread()`; thread órfã arquivada/deletada se `sessionManager.create()` falhar

### Refatorado

- **S-12**: `_handleIdleTransition()` extraído — transição idle→waiting_input/finished centralizada; elimina duplicação entre handlers `session.status` e `session.idle`
- **S-09**: `getProjects()` agora async com cache em memória (TTL 60 s) — remove bloqueio de `readdirSync` no event loop
- **S-11**: Limite máximo de portas em `_doAllocatePort()` — erro descritivo se intervalo se esgotar

---

## [1.2.0] - 2026-03-16

### Adicionado

- **Preview de diffs no Discord** (item 5.3 do plano de evolução)
  - Intercepta eventos SSE `session.diff` do opencode e exibe alterações de arquivos na thread
  - Diffs pequenos (< 1500 chars): exibidos inline com syntax highlighting (`diff`)
  - Diffs grandes: enviados como arquivo `.diff` anexo
  - Suporte a múltiplos diffs por evento

### Alterado

- **Node.js mínimo atualizado para 20.0.0** — Node 18 atingiu EOL em abril/2025; Vitest 4.x (Rolldown) requer `styleText` de `node:util`, disponível apenas a partir do Node 20.12.0

---

## [1.1.0] - 2026-03-16

Evolução significativa do produto com foco em segurança, confiabilidade, operações e developer experience. Implementa 18 melhorias identificadas na análise de evolução.

### Adicionado

- **Suite de testes** com Vitest (33 testes cobrindo utils, sse-parser, config, rate-limiter, stream-handler) (`e601f3c`)
- **Validação de ownership de sessão** — apenas o criador pode controlar a sessão; configurável via `ALLOW_SHARED_SESSIONS` (`e601f3c`)
- **Sanitização de env vars** — child process recebe apenas variáveis da whitelist, não vaza `DISCORD_TOKEN` (`e601f3c`)
- **Rate limiting** por usuário — 5 comandos/minuto, com resposta ephemeral (`e601f3c`)
- **Limite de sessões** por usuário — padrão 3, configurável via `MAX_SESSIONS_PER_USER` (`e601f3c`)
- **Timeout de sessão** automático — sessões inativas por 30min são encerradas com notificação na thread (`e601f3c`)
- **Reconexão SSE** automática com backoff exponencial (1s → 30s) quando a conexão cai (`e601f3c`)
- **CI/CD** com GitHub Actions — testes em Node 18/20/22 em push e PRs (`e601f3c`)
- **Docker support** — Dockerfile, docker-compose.yml, `.dockerignore`, process kill cross-platform (`e601f3c`)
- **Health check endpoint** — `GET /health` na porta 9090 com status, uptime e contagem de sessões (`e601f3c`)
- **Comando `/historico`** — baixa o output completo da sessão como arquivo .txt (`e601f3c`)
- **Notificação por DM** — quando habilitado (`ENABLE_DM_NOTIFICATIONS`), envia DM ao criador quando sessão finaliza
- **Módulo de configuração centralizado** (`src/config.js`) — single source of truth para todas as env vars
- **Função `createSessionInThread()`** — elimina duplicação na criação de sessão entre slash command e select menu
- **Função `validateProjectPath()`** — validação de path traversal extraída e reutilizada

### Corrigido

- **Bug `lastActivityAt`** — campo nunca era atualizado durante a vida da sessão; `/status` e `/sessoes` mostravam informação incorreta (`e601f3c`)
- **Blocos catch vazios** eliminados em `index.js`, `commands.js` e `sse-parser.js` — agora logam erro apropriadamente (`e601f3c`)

### Melhorado

- **Graceful shutdown** — notifica threads ativas antes de encerrar ("Bot reiniciando..."), com timeout de 10s (`e601f3c`)
- **Config centralizado** — todas as env vars (OPENCODE_BIN, OPENCODE_BASE_PORT, MSG_LIMIT, UPDATE_INTERVAL, MAX_BUFFER, DEFAULT_TIMEOUT_MS, HEALTH_PORT) agora importadas de `src/config.js`
- **`ALLOWED_USERS`** parseado em único lugar (`src/config.js`) em vez de duplicado em `index.js` e `commands.js`

---

## [1.0.2] - 2026-03-16

### Adicionado

- **Comando `/comando`** para executar comandos opencode personalizados dentro de uma sessão ativa (`19fd06e`)
- Autocomplete para nomes de comandos (lê de `OPENCODE_COMMANDS_PATH`)
- Novo módulo `src/opencode-commands.js` para listar comandos customizados do filesystem
- Documentação de `OPENCODE_COMMANDS_PATH` no `.env.example`

### Melhorado

- **Handling de `permission.asked`** com retry logic e notificações no Discord (`0d122a2`)
  - Extração de permission ID de múltiplos caminhos possíveis (fallback paths)
  - Extração de `toolName` e `description` para mensagens no Discord
  - Eventos tipados `permission` (approving / approved / failed / unknown)
  - Retry até 3x com backoff linear em caso de falha

---

## [1.0.1] - 2026-03-16

### Melhorado

- **Redução de ruído nos logs de debug** (`f022395`)
  - Removidos logs de alta frequência no StreamHandler (output event, scheduleUpdate)
  - Removidos logs stdout/stderr line-by-line no OpenCodeServer
  - Expandida lista de `IGNORED_TYPES` no SSE para suprimir eventos internos (`session.created`, `session.updated`, etc.)
  - Sessões não registradas tratadas silenciosamente em vez de logarem warning

---

## [1.0.0] - 2026-03-15

### Adicionado — Release inicial

- **Arquitetura HTTP/SSE** — comunicação com `opencode serve` via REST API + Server-Sent Events (`e09fde1`)
- **Slash commands** — `/plan`, `/build`, `/sessoes`, `/status`, `/parar`, `/projetos`
- **Streaming em tempo real** — output do OpenCode editado/criado em mensagens Discord
- **Gerenciamento de sessões** — múltiplas sessões simultâneas em threads isoladas
- **Gerenciamento de servidores** — um processo `opencode serve` por projeto, com port allocation automática
- **Autocomplete de projetos** (RF-04) — lista subpastas de `PROJECTS_BASE_PATH`
- **Proteção contra path traversal** — validação de caminho nos comandos
- **Deduplicação de sessão** — impede criar duas sessões para o mesmo projeto
- **NSSM service** — script PowerShell para instalar como serviço Windows
- **AGENTS.md** — guidelines para contribuidores AI
- **README** completo com guia passo-a-passo de configuração do Discord

### Dependências

- `discord.js` ^14.18.0
- `dotenv` ^16.4.5
- Override: `undici` ^6.24.1 (compatibilidade discord.js)

---

## Estrutura do Projeto

```
src/
├── index.js              # Entry point — Discord client, eventos, shutdown
├── config.js             # Configuração centralizada (env vars)
├── commands.js           # Slash commands e handlers de interação
├── session-manager.js    # OpenCodeSession + SessionManager (lifecycle)
├── server-manager.js     # OpenCodeServer + ServerManager (processos)
├── opencode-client.js    # Cliente HTTP para API REST do opencode
├── sse-parser.js         # Parser de Server-Sent Events
├── stream-handler.js     # Streaming de output para Discord
├── opencode-commands.js  # Listagem de comandos customizados
├── rate-limiter.js       # Rate limiting por usuário
└── health.js             # Endpoint HTTP de health check

tests/
├── utils.test.js         # Testes de formatAge, stripAnsi
├── sse-parser.test.js    # Testes do parser SSE
├── config.test.js        # Testes de validateProjectPath
├── rate-limiter.test.js  # Testes do rate limiter
└── stream-handler.test.js # Testes de splitIntoChunks, mergeContent
```
