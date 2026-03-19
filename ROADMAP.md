# 🗺️ ROADMAP — opencode-discord

> **Versão atual:** v1.2.0
> **Última atualização:** 2026-03-19
> **Status:** Em desenvolvimento ativo

Mapeamento completo de evoluções planejadas para o projeto `opencode-discord`, com análise de impacto, esforço e risco para cada funcionalidade.

---

## 📍 Visão do Produto

O `opencode-discord` é uma ponte que torna o desenvolvimento assistido por IA acessível de qualquer lugar do mundo através de uma interface já familiar para milhões de desenvolvedores: o Discord. Em vez de exigir acesso direto ao terminal da máquina de desenvolvimento, o bot expõe o poder do `opencode` — um agente de código de última geração — como uma conversa de texto no bolso do desenvolvedor. Isso significa que um desenvolvedor pode iniciar uma sessão de planejamento ou implementação a partir do celular durante uma reunião, no trem, ou de qualquer outro dispositivo, sem jamais abrir um terminal.

A visão de longo prazo é transformar o `opencode-discord` em uma plataforma de agentes de desenvolvimento *mobile-first*: onde qualquer desenvolvedor consiga iniciar, monitorar e guiar sessões de codificação remota em tempo real, com latência mínima, máxima resiliência a falhas de rede, e interface rica usando os componentes nativos do Discord (botões, selects, threads, embeds, DMs). O projeto deve continuar sendo a ponte mais simples possível entre o humano e o agente de código, sem adicionar camadas desnecessárias de complexidade.

O produto respeita intencionalmente a filosofia minimalista herdada do projeto-pai: sem etapa de compilação, sem containers obrigatórios, sem dependências externas além do Node.js e do Discord. A meta de instalação é: qualquer desenvolvedor Windows deve conseguir configurar, iniciar e usar o bot em menos de 10 minutos, com um único arquivo `.env` e um script PowerShell para o serviço.

---

## ✅ Estado Atual (v1.2.0)

### O que funciona hoje

- ✅ Comandos `/plan` e `/build` com seletor visual de projeto (select menu)
- ✅ Threads Discord individuais por sessão, criadas automaticamente
- ✅ Streaming de output em tempo real (edição de mensagem + debounce)
- ✅ Envio de mensagens inline na thread (sem slash command)
- ✅ Comandos inline `/stop` e `/status` direto na thread
- ✅ Aprovação automática de permissões `tool_use` com retry (3 tentativas)
- ✅ Preview de diffs: inline com syntax highlighting ou como arquivo `.diff`
- ✅ Exibição de perguntas do agente na thread
- ✅ Notificações por DM ao término da sessão (`ENABLE_DM_NOTIFICATIONS`)
- ✅ Rate limiting por usuário (5 ações/minuto, janela deslizante)
- ✅ Limite global de sessões simultâneas (`MAX_GLOBAL_SESSIONS`)
- ✅ Limite de sessões por usuário (`MAX_SESSIONS_PER_USER`)
- ✅ Circuit breaker para servidores com falha (3 tentativas + cooldown de 60 s)
- ✅ Health check HTTP em `GET /health` com contagem de sessões
- ✅ Autocomplete de projetos e comandos `opencode`
- ✅ Timeout de inatividade configurável por sessão (`SESSION_TIMEOUT_MS`)
- ✅ Shutdown gracioso com notificação nas threads ativas
- ✅ Instalação como serviço Windows via NSSM
- ✅ `/historico` — download do output completo como arquivo `.txt`
- ✅ `/comando` — execução de comandos `opencode` customizados
- ✅ Filtro de usuários autorizados (`ALLOWED_USER_IDS`)
- ✅ Sessões compartilhadas entre usuários (`ALLOW_SHARED_SESSIONS`)
- ✅ Sanitização de ambiente antes de passar ao processo filho (sem vazar `DISCORD_TOKEN`)

### Gaps conhecidos

- ❌ Sem persistência: sessões perdidas ao reiniciar o bot
- ❌ Sem fila de tarefas: mensagens enviadas durante execução são silenciosamente descartadas
- ❌ Aprovação de permissão é sempre automática (sem opção de negar via Discord)
- ❌ Sem seleção de modelo AI via Discord
- ❌ Sem modo passthrough (digitação livre sem slash commands)
- ❌ Health check sempre retorna HTTP 200 (sem 503 inteligente)
- ❌ Cache de autocomplete ausente (`readdirSync` síncrono a cada tecla)
- ❌ Sem endpoint `/metrics` compatível com Prometheus
- ❌ Sem audit logging estruturado
- ❌ Cobertura de testes ~4% (meta: 30% em v1.3)
- ❌ Sem slash command `/diff` (preview existe mas não é exposto como comando)
- ❌ Sem suporte a upload de arquivos como contexto para o agente
- ❌ Sem voice input
- ❌ Sem browser de sessões (reconectar a sessão existente via nova thread)
- ❌ Bugs B-09, B-10, B-11 ainda abertos (ver ISSUES.md)

---

## 🧭 Princípios de Evolução

1. **Simplicidade primeiro** — JS puro, sem build step, sem bundler, fácil de hackear por qualquer desenvolvedor Node.js. Novas dependências devem ser justificadas explicitamente.
2. **Windows-native** — NSSM, pipes, separadores de path, taskkill. O bot roda na mesma máquina que o `opencode`. Nunca assumir Unix.
3. **Mobile-first UX** — tudo deve funcionar bem no app iOS/Android do Discord. Mensagens curtas, embeds simples, botões grandes, sem tabelas longas.
4. **Resiliência defensiva** — erros nunca devem derrubar o bot inteiro; degradação graciosa em cada camada. Um servidor com crash não afeta outros projetos.

---

## 📊 Matriz de Impacto × Esforço

| Funcionalidade | Impacto | Esforço | Prioridade | Fase |
|---|---|---|---|---|
| Cobertura de testes 30% | Alto | Médio | 🔴 Crítico | Fase 1 |
| Cache do autocomplete | Médio | Baixo | 🔴 Alta | Fase 1 |
| Health check 503 | Médio | Baixo | 🔴 Alta | Fase 1 |
| Comando `/diff` | Médio | Baixo | 🔴 Alta | Fase 1 |
| Fix B-09 / B-10 / B-11 | Alto | Baixo | 🔴 Alta | Fase 1 |
| Persistência de sessões | Alto | Médio | 🔴 Alta | Fase 1 |
| Fila de tarefas | Alto | Médio | 🔴 Alta | Fase 2 |
| Botões de aprovação | Alto | Médio | 🔴 Alta | Fase 2 |
| Modo passthrough | Alto | Baixo | 🔴 Alta | Fase 2 |
| Endpoint `/metrics` | Médio | Médio | 🟡 Média | Fase 2 |
| Audit logging SQLite | Médio | Médio | 🟡 Média | Fase 2 |
| Seleção de modelo AI | Alto | Médio | 🟡 Média | Fase 2 |
| Rate limiting por projeto | Médio | Baixo | 🟡 Média | Fase 2 |
| Git Worktrees | Alto | Alto | 🟡 Média | Fase 3 |
| Browser de sessões | Médio | Médio | 🟡 Média | Fase 3 |
| Upload de arquivos | Alto | Médio | 🟡 Média | Fase 3 |
| Voice input (Whisper) | Alto | Alto | 🟡 Média | Fase 3 |
| Wizard de setup | Médio | Médio | 🟢 Baixa | Fase 3 |
| Dashboard web | Médio | Alto | 🟢 Baixa | Fase 4 |
| Publicação npm | Alto | Médio | 🟢 Baixa | Fase 4 |
| Adapter Telegram | Médio | Alto | 🟢 Baixa | Fase 4 |
| Webhook CI/CD | Médio | Médio | 🟢 Baixa | Fase 4 |

---

## 🚀 Fases de Evolução

### Fase 1 — Qualidade (v1.3) · Meta: Q1 2026

> Foco: corrigir bugs abertos, elevar cobertura de testes, melhorar observabilidade e resolver os code smells mais impactantes. Zero novas features até atingir 30% de cobertura.

| Feature | Descrição | Impacto | Esforço | Risco | Requisito |
|---|---|---|---|---|---|
| **Cobertura 30%** | Testar `utils.js`, `rate-limiter.js`, `sse-parser.js`, `config.js`, `session-manager.js` com Jest/Vitest | Alto | Médio | Baixo | ISSUES B-09 a B-11 |
| **Fix B-09** | `_checkTimeouts()`: adicionar `await` e resolver double-delete com o setTimeout de cleanup | Alto | Baixo | Baixo | — |
| **Fix B-10** | Rastrear timer de arquivamento em `this._archiveTimer`; cancelar em `stop()` | Médio | Baixo | Baixo | — |
| **Fix B-11** | Try-catch em `createSessionInThread()`; arquivar thread órfã em caso de falha | Médio | Baixo | Baixo | — |
| **Cache autocomplete** | `getProjects()` e `listOpenCodeCommands()`: cache em memória com TTL de 60 s | Médio | Baixo | Baixo | S-09 |
| **Health check 503** | Retornar 503 se `errorRate > 0.5`; incluir `servers[]` no payload com estado do circuit breaker | Médio | Baixo | Baixo | S-10 |
| **Comando `/diff`** | Slash command que exibe diff staged/unstaged do projeto; usa lógica já existente de `_sendDiffPreview()` | Médio | Baixo | Baixo | — |
| **Refatorar S-12** | Extrair `_handleIdleTransition()` em `session-manager.js` | Baixo | Baixo | Baixo | S-12 |
| **Limite `_doAllocatePort()`** | Adicionar teto máximo (ex: porta base + 200) e erro descritivo | Baixo | Baixo | Baixo | S-11 |
| **Persistência JSON** | Salvar `threadId↔sessionId↔status` em `~/.opencode-discord/data.json`; mostrar na thread ao reiniciar | Alto | Médio | Médio | — |

---

### Fase 2 — Resiliência (v1.4) · Meta: Q2 2026

> Foco: tornar o bot robusto para uso intensivo em equipes. Fila de tarefas, aprovação de permissões via botões, observabilidade completa.

| Feature | Descrição | Impacto | Esforço | Risco |
|---|---|---|---|---|
| **Fila de tarefas** | Mensagens enviadas enquanto sessão está `running` ficam na fila com reação 📥; processadas automaticamente ao idle; suporte a `/fila ver` e `/fila limpar` | Alto | Médio | Médio |
| **Botões de aprovação** | Substituir aprovação automática por botões Discord "✅ Aprovar" / "❌ Negar" com timeout de 60 s; fallback para aprovação automática se ninguém responder | Alto | Médio | Médio |
| **Modo passthrough** | `/modo passthrough` ativa forwarding de todas as mensagens da thread para o agente sem slash command; indicador visual no embed inicial; `/modo normal` reverte | Alto | Baixo | Baixo |
| **Seleção de modelo AI** | `/modelo set <nome>` persiste por thread no arquivo de persistência; `/modelo ver` exibe atual; autocomplete com lista de modelos do opencode | Alto | Médio | Médio |
| **Endpoint `/metrics`** | Exportar métricas Prometheus: `sessions_active`, `sessions_total`, `messages_sent_total`, `errors_total`, `flush_latency_ms` | Médio | Médio | Baixo |
| **Audit logging** | Registrar em SQLite leve (`~/.opencode-discord/audit.db`): user_id, session_id, projeto, prompt_inicial, timestamp; `/auditoria` para admins | Médio | Médio | Baixo |
| **Rate limiting por projeto** | `MAX_SESSIONS_PER_PROJECT` env var; rejeitar novas sessões se projeto já tiver o limite atingido | Médio | Baixo | Baixo |
| **Cobertura 50%** | Expandir testes para `opencode-client.js`, `commands.js`, `health.js` | Alto | Médio | Baixo |

---

### Fase 3 — Poder (v2.0) · Meta: Q3 2026

> Foco: funcionalidades avançadas que transformam o bot em uma plataforma completa de agentes remotos.

| Feature | Descrição | Impacto | Esforço | Risco |
|---|---|---|---|---|
| **Git Worktrees** | `/trabalho [projeto] [branch]` cria worktree isolada por sessão; branch automática baseada no prompt; merge via botão Discord; previne conflitos entre sessões paralelas do mesmo projeto | Alto | Alto | Alto |
| **Browser de sessões** | `/sessao lista` exibe todas (ativas + arquivadas com status); `/sessao conectar [id]` re-anexa sessão a nova thread; `/sessao desconectar` libera thread sem fechar processo | Médio | Médio | Médio |
| **Upload de arquivos** | Anexos Discord (`.js`, `.ts`, `.md`, `.txt`, `.json`) detectados automaticamente; salvos em diretório temp do projeto antes de enviar prompt; exibição de preview do nome dos arquivos | Alto | Médio | Médio |
| **Voice input** | Arquivos `.ogg` e `.mp3` anexados à thread transcritos via OpenAI Whisper REST (`whisper-1`); transcrição exibida como preview antes de enviar ao agente; configurável via `OPENAI_API_KEY` | Alto | Alto | Médio |
| **Wizard de setup** | `node src/setup.js` guia o usuário pelo setup completo: Discord token, guild ID, projetos, modelo AI, serviço Windows; validação em tempo real com feedback colorido | Médio | Médio | Baixo |
| **Cobertura 65%** | Expandir testes para `server-manager.js`, `stream-handler.js`, `index.js` | Alto | Alto | Médio |

---

### Fase 4 — Distribuição (v2.x) · Meta: 2027+

> Foco: alcançar outros desenvolvedores, outras plataformas, outros casos de uso.

| Feature | Descrição | Impacto | Esforço | Risco |
|---|---|---|---|---|
| **Dashboard web** | Página HTML servida na porta `DASHBOARD_PORT`; exibe sessões ativas, estado dos servidores, histórico de erros, métricas em tempo real; sem dependências de framework | Médio | Alto | Baixo |
| **Publicação npm** | Publicar `opencode-discord` no npm; `npx opencode-discord setup` e `npx opencode-discord start`; versionamento semântico com changelog automático | Alto | Médio | Baixo |
| **Adapter Telegram** | Extrair camada de transporte (Discord-specific) para interface genérica `BotAdapter`; implementar `TelegramAdapter`; mesma lógica de sessões e agentes para ambos | Médio | Alto | Alto |
| **Webhook CI/CD** | Endpoint HTTP `POST /webhook` que recebe payload GitHub/GitLab (PR opened, merge, push) e inicia sessão opencode automaticamente com contexto do evento | Médio | Médio | Médio |
| **Integração VS Code Remote** | Extensão VS Code que expõe o mesmo bot como painel lateral; útil para ambientes remotos onde o Discord não está disponível mas o VS Code está | Médio | Alto | Alto |

---

## 🔄 Comparativo com remote-opencode

> Comparação de funcionalidades entre o `opencode-discord` e a abordagem de `remote-opencode` (acesso remoto via CLI/SSH/proxy HTTP direto).

| Funcionalidade | opencode-discord | remote-opencode | Fase Roadmap |
|---|---|---|---|
| Acesso mobile | ✅ Discord app nativo | ⚠️ Requer terminal mobile | — |
| Sem VPN / port forwarding | ✅ Usa API Discord como relay | ❌ Exige exposição de porta ou VPN | — |
| Múltiplas sessões paralelas | ✅ Threads separadas por sessão | ⚠️ Multiplexar manualmente | — |
| Histórico persistido | ✅ Thread Discord é o histórico | ⚠️ Depende do terminal | — |
| Notificações push | ✅ Discord push notification | ❌ Sem notificação nativa | — |
| Streaming de output | ✅ Edição de mensagem em tempo real | ✅ TTY nativo | — |
| Aprovação de permissões | ✅ Automática (botões na Fase 2) | ✅ Interativo no terminal | Fase 2 |
| Seleção de modelo AI | ❌ Não implementado | ✅ Via flags CLI | Fase 2 |
| Upload de arquivos como contexto | ❌ Não implementado | ✅ Via pipe/redirecionamento | Fase 3 |
| Voice input | ❌ Não implementado | ❌ Não implementado | Fase 3 |
| Git worktrees por sessão | ❌ Não implementado | ❌ Manual | Fase 3 |
| Fácil de instalar (Windows) | ✅ NSSM + `.env` | ⚠️ SSH server ou proxy adicional | — |
| Audit logging | ❌ Não implementado | ❌ Não implementado | Fase 2 |
| Métricas Prometheus | ❌ Não implementado | ❌ Não implementado | Fase 2 |
| Multi-usuário com controle de acesso | ✅ `ALLOWED_USER_IDS` | ❌ Sem controle nativo | — |
| Fila de tarefas | ❌ Não implementado | ❌ Não implementado | Fase 2 |
| Dashboard web | ❌ Não implementado | ❌ Não implementado | Fase 4 |

---

## 🏗️ Decisões Arquiteturais Futuras

As seguintes decisões técnicas precisam ser tomadas antes de iniciar as respectivas fases. Cada uma tem implicações de manutenção, complexidade e compatibilidade com a filosofia minimalista do projeto.

| Decisão | Opções | Recomendação | Fase |
|---|---|---|---|
| **Persistência de sessões** | (A) JSON file simples `data.json` · (B) SQLite via `better-sqlite3` · (C) Redis | **(A) JSON** para Fase 1 (sem dependência extra); migrar para **(B) SQLite** na Fase 2 quando precisar de audit logging | Fase 1 |
| **Voice input** | (A) OpenAI Whisper REST API (`whisper-1`) · (B) Whisper.cpp local (sem custo, precisa GPU/CPU potente) | **(A) REST** para Fase 3 (simples, sem infra extra); opcional ativar só se `OPENAI_API_KEY` estiver configurada | Fase 3 |
| **Fila de tarefas** | (A) In-memory Array (perde no restart) · (B) SQLite com tabela `queue` · (C) Redis/Bull | **(A) In-memory** para Fase 2 (simplicidade primeiro); avaliar **(B) SQLite** se persistência da fila for pedida por usuários | Fase 2 |
| **Dashboard web** | (A) HTML estático servido pelo servidor de health check existente · (B) SPA React/Vue com bundler · (C) Sem dashboard; métricas só via Prometheus | **(A) HTML estático** — respeita o princípio de sem build step; uma única rota extra no `health.js` | Fase 4 |
| **Distribuição** | (A) npm package · (B) Docker image · (C) Ambos | **(A) npm** primeiro (mais alinhado com o público Windows/Node.js); **(C) ambos** quando tiver CI/CD | Fase 4 |
| **Adapter multi-plataforma** | (A) Extrair `BotAdapter` interface antes da Fase 4 · (B) Refatorar na hora de implementar Telegram | **(A) Extrair antes** para evitar refatoração invasiva; definir interface mínima em `src/adapters/` | Fase 3 |
| **Aprovação de permissão** | (A) Botões com timeout e fallback automático · (B) Apenas botões (bloqueia se ninguém responder) | **(A) Botões com timeout** (60 s) — melhor UX mobile; nunca bloquear o agente indefinidamente | Fase 2 |

---

## 🤝 Contribuindo

Para pegar uma tarefa do roadmap e contribuir com o projeto, siga o fluxo:

1. **Escolha um item** de uma das fases acima. Priorize a Fase atual (v1.3) antes de avançar para fases posteriores.

2. **Verifique os princípios** em [AGENTS.md](./AGENTS.md):
   - JS puro, ES Modules com extensão `.js` nos imports
   - Comentários e mensagens em Português (PT-BR)
   - JSDoc para todas as funções exportadas
   - Conventional Commits com referência ao requisito (ex: `feat(RF-04): ...`)

3. **Consulte o ISSUES.md** para bugs relacionados ao item que você vai implementar — corrija junto se o esforço for baixo.

4. **Escreva testes** para o código novo. A meta de cobertura por fase está definida na seção "Meta de Cobertura" do ISSUES.md. Preferência por Jest ou Vitest (ESM-native).

5. **Abra um PR** com:
   - Título seguindo Conventional Commits
   - Descrição com o item do roadmap referenciado
   - Atualização do `ISSUES.md` se um bug for corrigido ou code smell resolvido

---

*Documento mantido pela equipe de desenvolvimento do opencode-discord.*
*Para sugerir uma nova funcionalidade, abrir issue com label `roadmap` no repositório.*
