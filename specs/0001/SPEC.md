# SPEC-0001 — RemoteFlow

> **Status:** Draft  
> **Versão:** 1.0.0  
> **Data:** 2026-03-15  
> **Autor:** Gerado via sessão de design colaborativo

---

## 1. Visão Geral

O **RemoteFlow** é um sistema que expõe o ambiente de desenvolvimento local Windows — especificamente o `opencode` CLI com seus agentes `plan` e `build` — através de um bot Discord. O objetivo é replicar, via iPhone (app Discord), a mesma experiência interativa que o desenvolvedor tem hoje no terminal do Windows.

O sistema é inteiramente **local**: o bot roda na mesma máquina Windows, conecta-se ao Discord via WebSocket (sem necessidade de portas abertas ou servidores externos), e gerencia múltiplas sessões OpenCode simultâneas, cada uma isolada em sua própria thread Discord.

---

## 2. Contexto e Motivação

### Situação atual

O desenvolvedor trabalha com o seguinte fluxo no Windows:

1. Abre um terminal na pasta do projeto
2. Executa `opencode`
3. Usa o agente `plan` para especificação e o `build` para desenvolvimento
4. Interage conversacionalmente com o agente: recebe perguntas, responde, itera até concluir

Esse fluxo está **preso ao computador**. Fora do ambiente local, não há como iniciar, acompanhar ou interagir com sessões de desenvolvimento.

### Objetivo

Permitir que o mesmo fluxo aconteça **de qualquer lugar, pelo iPhone**, usando o Discord como interface de terminal remoto — mantendo a natureza conversacional e iterativa do workflow.

---

## 3. Requisitos

### 3.1 Funcionais

| ID | Requisito |
|----|-----------|
| RF-01 | O usuário deve poder iniciar uma sessão `plan` ou `build` via slash command |
| RF-02 | Cada sessão deve ser isolada em uma thread Discord própria |
| RF-03 | O output do agente deve ser transmitido em tempo real para a thread |
| RF-04 | O usuário deve poder responder ao agente digitando na thread |
| RF-05 | O bot deve detectar quando o agente está aguardando input e sinalizar visualmente |
| RF-06 | Múltiplas sessões simultâneas em projetos diferentes devem ser suportadas |
| RF-07 | O usuário deve poder listar, monitorar e encerrar sessões ativas |
| RF-08 | O bot deve listar os projetos disponíveis no `PROJECTS_BASE_PATH` |
| RF-09 | Apenas usuários autorizados (via `ALLOWED_USER_IDS`) devem poder usar o bot |
| RF-10 | O bot deve se recuperar de crashes do processo OpenCode sem derrubar o serviço |

### 3.2 Não-funcionais

| ID | Requisito |
|----|-----------|
| RNF-01 | Zero latência extra de rede (bot roda localmente, sem nuvem intermediária) |
| RNF-02 | O bot deve funcionar como serviço Windows (inicia junto com o SO) |
| RNF-03 | Rate limit do Discord deve ser respeitado (máx. 5 edições/segundo por canal) |
| RNF-04 | Output do terminal deve ter ANSI/escape codes removidos antes de exibir |
| RNF-05 | Mensagens longas devem ser divididas automaticamente respeitando o limite de 2000 chars |
| RNF-06 | A configuração deve ser feita inteiramente via arquivo `.env` |

### 3.3 Fora de escopo (v1.0)

- Interface web de acompanhamento
- Suporte a Telegram (pode ser adicionado em v1.1)
- Autenticação OAuth / login via Discord
- Upload de arquivos pelo Discord para o projeto
- Histórico persistente de sessões em banco de dados

---

## 4. Arquitetura

### 4.1 Visão de alto nível

```
┌─────────────────────────────────────────────────────────┐
│                      iPhone                             │
│   ┌─────────────────────────────────────────────────┐   │
│   │              Discord App                        │   │
│   │  Canal #dev          Thread: Build · meu-app   │   │
│   │  /plan               > output do agente...     │   │
│   │  /build              > Qual o nome do módulo?  │   │
│   │  /sessoes            > [usuário digita aqui]   │   │
│   └─────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket (Discord Gateway)
                         │ (saída — sem porta aberta)
┌────────────────────────▼────────────────────────────────┐
│                  Windows Local                          │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Bot Process (Node.js)                  │   │
│  │                                                  │   │
│  │  ┌─────────────┐    ┌──────────────────────────┐ │   │
│  │  │  Commands   │    │    Session Manager       │ │   │
│  │  │  /plan      │    │                          │ │   │
│  │  │  /build     │───▶│  Session A (projeto-x)   │ │   │
│  │  │  /sessoes   │    │  Session B (projeto-y)   │ │   │
│  │  │  /parar     │    │  Session C (projeto-z)   │ │   │
│  │  └─────────────┘    └──────────┬───────────────┘ │   │
│  │                                │ spawn           │   │
│  │  ┌─────────────────────────────▼───────────────┐ │   │
│  │  │           Stream Handler                    │ │   │
│  │  │  stdout/stderr → chunks → Discord messages  │ │   │
│  │  │  stdin ← mensagens do usuário na thread     │ │   │
│  │  └─────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────┘   │
│                         │ spawn                         │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │            opencode CLI                         │    │
│  │                                                 │    │
│  │   agent plan   │   agent build                  │    │
│  │        │               │                        │    │
│  │   specs/0001/  │   src/, tests/, ...            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  [Docker: Redis, Postgres, etc. — infraestrutura]       │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Fluxo de dados — sessão típica

```
Usuário digita /build projeto=meu-app
        │
        ▼
commands.js: handleStartSession()
  ├── Valida caminho do projeto
  ├── Cria thread Discord "🔨 Build · meu-app · 14:32"
  ├── sessionManager.create({ projectPath, threadId, userId })
  ├── StreamHandler.start() — começa a escutar events da sessão
  └── session.start() — spawn do processo opencode

        │
        ▼ processo opencode inicia
        
opencode CLI escreve no stdout
        │
        ▼
StreamHandler captura chunks
  ├── Acumula no buffer (UPDATE_INTERVAL ms)
  ├── Remove ANSI codes
  ├── Divide em chunks ≤ MSG_LIMIT chars
  └── Edita última mensagem OU cria nova mensagem na thread

        │
        ▼
Agente faz pergunta ao usuário
StreamHandler.isWaitingForInput() → true
  └── session.emit('status', 'waiting_input')
      └── Thread recebe: "💬 Aguardando sua resposta"

        │
        ▼
Usuário digita resposta na thread (iPhone)
        │
        ▼
messageCreate event
  ├── Identifica thread → sessão associada
  └── session.sendInput(texto) → process.stdin.write(texto + '\n')

        │
        ▼
opencode recebe input, continua processamento...
[loop até sessão finalizar]
```

### 4.3 Gerenciamento de sessões simultâneas

Cada sessão é identificada por:

- `sessionId` — UUID interno gerado no momento da criação
- `threadId` — ID da thread Discord associada (chave de busca primária)
- `userId` — ID do usuário Discord que criou a sessão

O `SessionManager` mantém dois índices:
- `Map<sessionId, OpenCodeSession>` — acesso direto por ID
- `Map<threadId, sessionId>` — para resolver "em qual sessão estou nesta thread?"

Sessões encerradas são mantidas em memória por 10 minutos para consulta de histórico, depois são removidas.

---

## 5. Estrutura de Arquivos

```
remote-flow/
│
├── .env.example              # Template de configuração
├── .env                      # Configuração local (não comitar)
├── package.json
│
├── src/
│   ├── index.js              # Entry point: inicializa bot, registra eventos
│   ├── session-manager.js    # OpenCodeSession + SessionManager
│   ├── stream-handler.js     # Captura stdout → Discord messages
│   └── commands.js           # Slash commands: /plan, /build, /sessoes, etc.
│
├── scripts/
│   └── install-service.ps1   # Setup como serviço Windows via NSSM
│
└── specs/
    └── 0001/
        └── SPEC.md           # Este documento
```

---

## 6. Componentes

### 6.1 `OpenCodeSession` (session-manager.js)

Encapsula um processo `opencode` em execução. Herda de `EventEmitter`.

**Propriedades:**

| Prop | Tipo | Descrição |
|------|------|-----------|
| `sessionId` | string | Identificador único |
| `projectPath` | string | Caminho absoluto do projeto |
| `threadId` | string | ID da thread Discord |
| `userId` | string | ID do usuário Discord |
| `status` | enum | `idle \| running \| waiting_input \| finished \| error` |
| `process` | ChildProcess | Processo Node.js do opencode |
| `outputBuffer` | string | Todo o output acumulado da sessão |
| `pendingOutput` | string | Output ainda não enviado ao Discord |

**Eventos emitidos:**

| Evento | Payload | Quando |
|--------|---------|--------|
| `output` | `string` | Novo chunk de texto no stdout/stderr |
| `status` | `string` | Status da sessão muda |
| `close` | `number` | Processo encerrou (exit code) |
| `error` | `Error` | Erro no processo |

**Detecção de "aguardando input":**

Heurísticas aplicadas ao output em tempo real:
- Linha termina com `?`
- Contém padrões como `(y/n)`, `press enter`, `escolha:`, `selecione:`, `confirma`
- Linha termina com prompt `> `

### 6.2 `SessionManager` (session-manager.js)

Registro central de todas as sessões ativas.

**Métodos:**

| Método | Retorno | Descrição |
|--------|---------|-----------|
| `create({ projectPath, threadId, userId })` | `OpenCodeSession` | Cria e indexa nova sessão |
| `getByThread(threadId)` | `OpenCodeSession \| undefined` | Busca por thread Discord |
| `getById(sessionId)` | `OpenCodeSession \| undefined` | Busca por ID |
| `getByUser(userId)` | `OpenCodeSession[]` | Lista sessões de um usuário |
| `getAll()` | `OpenCodeSession[]` | Lista todas as sessões |
| `destroy(sessionId)` | `void` | Encerra e remove sessão |

### 6.3 `StreamHandler` (stream-handler.js)

Responsável por traduzir o output contínuo do processo em mensagens Discord legíveis, respeitando rate limits.

**Estratégia de atualização:**

1. Acumula output por `STREAM_UPDATE_INTERVAL` ms (padrão: 1500ms)
2. No flush, verifica se a última mensagem ainda tem espaço (`< MSG_LIMIT`)
3. Se sim: edita a mensagem existente (atualização visual de streaming)
4. Se não: cria nova mensagem
5. Mensagens muito longas são divididas em chunks na quebra de linha mais próxima

**Formatação:**

Todo output do terminal é exibido em bloco de código Discord (` ```\n...\n``` `) para preservar formatação e espaçamento.

Mensagens de status são enviadas como texto livre com emoji:
- `⚙️ Processando...` — durante execução
- `💬 Aguardando sua resposta` — quando detecta input pendente
- `✅ Sessão concluída` — ao encerrar com sucesso
- `❌ Sessão encerrada com erro` — ao encerrar com erro

### 6.4 Comandos Discord (commands.js)

| Comando | Opções | Comportamento |
|---------|--------|---------------|
| `/plan [projeto] [prompt]` | projeto: string, prompt: string | Inicia sessão plan. Se projeto omitido, exibe select menu. |
| `/build [projeto] [prompt]` | projeto: string, prompt: string | Inicia sessão build. Se projeto omitido, exibe select menu. |
| `/sessoes` | — | Lista todas as sessões ativas (ephemeral) |
| `/status` | — | Status da sessão na thread atual (ephemeral) |
| `/parar` | — | Encerra sessão da thread atual (com confirmação) |
| `/projetos` | — | Lista projetos disponíveis em PROJECTS_BASE_PATH (ephemeral) |

**Interações adicionais (dentro da thread):**

| Texto | Comportamento |
|-------|---------------|
| Qualquer mensagem | Enviada para o stdin do processo OpenCode |
| `/stop` ou `/parar` | Encerra a sessão imediatamente |
| `/status` | Retorna status resumido inline |

---

## 7. Configuração

### 7.1 Variáveis de ambiente (`.env`)

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `DISCORD_TOKEN` | ✅ | — | Token do bot Discord |
| `DISCORD_GUILD_ID` | ✅ | — | ID do servidor Discord |
| `PROJECTS_BASE_PATH` | ✅ | — | Caminho base dos projetos Windows |
| `OPENCODE_BIN` | | `opencode` | Executável do opencode |
| `ALLOWED_USER_IDS` | | (todos) | IDs Discord autorizados, separados por vírgula |
| `DISCORD_MSG_LIMIT` | | `1900` | Limite de chars por mensagem |
| `STREAM_UPDATE_INTERVAL` | | `1500` | Intervalo de atualização em ms |
| `DISCORD_CLIENT_ID` | | (auto) | Client ID do bot (preenchido automaticamente) |

### 7.2 Permissões necessárias no bot Discord

No Discord Developer Portal, o bot precisa dos seguintes **scopes** e **permissions**:

**OAuth2 Scopes:**
- `bot`
- `applications.commands`

**Bot Permissions:**
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`
- `Add Reactions`
- `Embed Links`
- `Use Slash Commands`

**Privileged Gateway Intents:**
- `Message Content Intent` ✅ (obrigatório para ler mensagens nas threads)

---

## 8. Guia de Setup

### 8.1 Criar o bot no Discord

1. Acesse [discord.com/developers/applications](https://discord.com/developers/applications)
2. Clique em **New Application** → dê um nome (ex: `OpenCode Dev`)
3. Vá em **Bot** → clique em **Reset Token** → copie o token
4. Em **Privileged Gateway Intents**: ative **Message Content Intent**
5. Vá em **OAuth2 > URL Generator**:
   - Scopes: `bot` + `applications.commands`
   - Permissions: conforme seção 7.2
6. Copie a URL gerada e abra no navegador para adicionar o bot ao seu servidor
7. Copie o **Application ID** (usado como `DISCORD_CLIENT_ID`)

### 8.2 Obter IDs do Discord

Para obter IDs no Discord, ative o **Modo Desenvolvedor**:
- Configurações → Aparência → Modo Desenvolvedor: ON

Depois:
- **Guild ID**: botão direito no servidor → "Copiar ID do servidor"
- **User ID**: botão direito no seu perfil → "Copiar ID do usuário"
- **Channel ID**: botão direito no canal → "Copiar ID do canal"

### 8.3 Instalação local

```powershell
# 1. Clone ou copie os arquivos para seu Windows
cd C:\Users\SeuUsuario\tools\remote-flow

# 2. Instale dependências
npm install

# 3. Configure o ambiente
copy .env.example .env
# Edite o .env com suas configurações

# 4. Teste o bot
node src/index.js
# Deve exibir: "🤖 Bot online: NomeDoBot#1234"

# 5. (Opcional) Instale como serviço Windows
# Execute como Administrador:
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

### 8.4 Instalação como serviço Windows (NSSM)

O script `install-service.ps1` usa o [NSSM](https://nssm.cc/) para registrar o bot como serviço Windows, garantindo que ele inicie automaticamente com o SO.

```powershell
# Instala NSSM (se não tiver)
winget install nssm

# Instala o serviço
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1

# Gerenciar o serviço
nssm start RemoteFlow
nssm stop RemoteFlow
nssm status RemoteFlow
```

---

## 9. Fluxos de Uso

### 9.1 Fluxo: Iniciar sessão plan com prompt

```
[iPhone - Discord]
Usuário: /plan projeto:minha-api prompt:Preciso criar um módulo de autenticação JWT

[Bot cria thread: "📋 Plan · minha-api · 14:32"]
[Thread]
Bot: [embed] Sessão Plan — minha-api | Inicializando opencode...
Bot: ```
     OpenCode v1.x.x
     Carregando contexto do projeto...
     ```
Bot: ```
     Entendido. Vou criar a especificação para o módulo JWT.
     Antes de começar, algumas perguntas:
     1. Você quer usar refresh tokens?
     ```
Bot: 💬 Aguardando sua resposta

Usuário: Sim, com expiração de 7 dias e armazenamento em Redis

Bot: ⚙️ Processando...
Bot: ```
     Perfeito. Mais uma questão:
     O endpoint de refresh deve invalidar o token anterior?
     ```
Bot: 💬 Aguardando sua resposta

... [continua até spec finalizar]

Bot: ✅ Sessão concluída
```

### 9.2 Fluxo: Múltiplas sessões simultâneas

```
Canal #dev:
/build projeto:api-gateway       → Thread: 🔨 Build · api-gateway · 09:00
/build projeto:frontend-app      → Thread: 🔨 Build · frontend-app · 09:05
/plan  projeto:mobile-sdk        → Thread: 📋 Plan · mobile-sdk · 09:10

/sessoes →
  ⚙️ session_a1b2c3 · api-gateway   · running      · 15min
  💬 session_d4e5f6 · frontend-app  · waiting_input · 10min
  ⚙️ session_g7h8i9 · mobile-sdk    · running      · 5min
```

### 9.3 Fluxo: Encerrar sessão

```
[Dentro da thread]
Usuário: /parar

Bot: ⚠️ Deseja encerrar a sessão para frontend-app?
     [Confirmar encerramento]  [Cancelar]

Usuário: [clica em Confirmar]
Bot: ✅ Sessão encerrada.
```

---

## 10. Decisões de Design

### Por que Discord e não Telegram?

| Critério | Discord | Telegram |
|----------|---------|----------|
| Threads isoladas por sessão | ✅ Nativo | ❌ Apenas tópicos em grupos |
| Mensagens longas | ✅ 2000 chars | ✅ 4096 chars |
| Blocos de código | ✅ Suporte completo | ✅ Suporte completo |
| Edição de mensagens | ✅ Sim | ✅ Sim |
| Bot WebSocket (sem porta aberta) | ✅ Sim | ✅ Sim |
| Select menus / botões | ✅ Componentes ricos | ⚠️ Inline keyboards (limitado) |
| Experiência mobile | ✅ Excelente | ✅ Excelente |

Discord foi escolhido pela **superioridade das threads** para isolar sessões e pelos **componentes interativos** (select menus, botões) que melhoram o UX.

### Por que sem Cloudflare Tunnel?

O bot Discord usa **Gateway WebSocket** — uma conexão de saída do bot para os servidores Discord. Isso significa:
- Nenhuma porta precisa ser aberta no roteador
- Nenhum serviço externo de tunelamento é necessário
- A máquina só precisa de acesso à internet

O Cloudflare Tunnel seria necessário apenas se houvesse webhooks HTTP de entrada, o que não é o caso aqui.

### Por que spawn com pipes ao invés de PTY?

O `node-pty` (PTY) simula um terminal real, o que é necessário para aplicações que detectam se estão num TTY (como colorização condicional). Porém:

- PTY no Windows requer compilação de módulos nativos (`node-gyp`) — frágil
- Para o OpenCode, o output limpo via pipes é suficiente
- ANSI codes são removidos de qualquer forma antes de enviar ao Discord

A abordagem com `stdio: 'pipe'` é mais robusta para o ambiente Windows.

### Intervalo de streaming (1500ms)

O Discord limita edições de mensagem a ~5/segundo por canal. Com múltiplas sessões simultâneas no mesmo servidor, um intervalo de 1500ms garante margem segura e evita erros 429 (rate limit).

---

## 11. Limitações Conhecidas (v1.0)

| Limitação | Impacto | Mitigação |
|-----------|---------|-----------|
| Output de terminal interativo (curses, TUI) | Renderiza como texto confuso | OpenCode não usa TUI — baixo risco |
| Sem upload de arquivos via Discord | Não dá pra enviar código pelo celular | Fora de escopo v1 |
| Sem persistência de histórico | Sessões antigas não ficam acessíveis após reinício | Threads Discord preservam o histórico visual |
| Detecção de "aguardando input" é heurística | Pode haver falsos positivos/negativos | Refinável por padrões específicos do OpenCode |
| Sem autenticação 2FA | Bot exposto a qualquer um no servidor | Mitigado por `ALLOWED_USER_IDS` |

---

## 12. Roadmap

### v1.1
- [ ] Suporte a Telegram (adaptador de interface)
- [ ] Upload de arquivos/contexto via Discord → projeto
- [ ] Comando `/historico` para ver o output completo da sessão
- [ ] Detecção de padrões de input específicos do OpenCode (baseado em observação real)

### v1.2
- [ ] Dashboard web local (visualização de sessões no navegador)
- [ ] Notificações push quando sessão precisa de input (Discord DM)
- [ ] Suporte a múltiplos usuários com permissões por projeto

### v2.0
- [ ] Integração com VS Code Remote para edição de arquivos pelo celular
- [ ] Preview de diffs gerados pelo agente diretamente no Discord

---

## 13. Glossário

| Termo | Definição |
|-------|-----------|
| **OpenCode** | CLI de desenvolvimento assistido por IA com agentes `plan` e `build` |
| **Agente plan** | Modo do OpenCode focado em especificação e planejamento |
| **Agente build** | Modo do OpenCode focado em implementação de código |
| **Thread Discord** | Canal temporário criado dentro de um canal, usado para isolar cada sessão |
| **Session** | Instância de um processo OpenCode associada a uma thread Discord |
| **StreamHandler** | Componente que traduz stdout/stderr do processo em mensagens Discord |
| **Gateway WebSocket** | Protocolo Discord para bots — conexão de saída, sem porta aberta |
| **NSSM** | Non-Sucking Service Manager — ferramenta para registrar processos como serviços Windows |
