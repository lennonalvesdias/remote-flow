# Changelog

Todas as mudanças notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

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
