# OpenCode Discord Bridge

> Use o `opencode` CLI do seu Windows/Linux pelo iPhone, via Discord.

Bot Discord que expõe seus agentes `plan` e `build` do OpenCode como sessões interativas em threads — replicando no celular a mesma experiência conversacional que você tem no terminal.

---

## Como funciona

```
iPhone (Discord) ──WebSocket──▶ Bot (Windows/Linux/Docker) ──HTTP/SSE──▶ opencode serve
                 ◀─────────────  output em tempo real via SSE
```

O bot roda **localmente na sua máquina** (ou em Docker), conecta ao Discord via WebSocket (sem abrir portas), e para cada `/plan` ou `/build` cria uma thread Discord com streaming do output em tempo real. Você responde ao agente digitando na thread.

## Pré-requisitos

- Node.js 18+ (ou Docker)
- `opencode` instalado e no PATH
- Conta Discord + bot criado no [Developer Portal](https://discord.com/developers/applications)

## Setup rápido

```bash
# 1. Instale dependências
npm install

# 2. Configure
cp .env.example .env
# Edite .env com as variáveis conforme seção "Configuração (.env)"

# 3. Teste
node src/index.js

# 4. (Opcional) Via Docker
docker compose up -d
```

### Instalação como serviço (Windows)

```powershell
# Execute o PowerShell como Administrador:
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

## Comandos Discord

| Comando | O que faz |
|---------|-----------|
| `/plan [projeto] [prompt]` | Inicia sessão de planejamento |
| `/build [projeto] [prompt]` | Inicia sessão de desenvolvimento |
| `/sessoes` | Lista sessões ativas |
| `/status` | Status da sessão na thread atual |
| `/parar` | Encerra sessão da thread atual |
| `/projetos` | Lista projetos disponíveis |
| `/comando [nome]` | Executa comando opencode personalizado |
| `/historico` | Baixa o output completo da sessão como .txt |

Dentro de qualquer thread de sessão, **qualquer mensagem** é enviada diretamente ao agente OpenCode.

### Comandos inline (na thread)

| Comando | O que faz |
|---------|-----------|
| `/stop` ou `/parar` | Encerra a sessão atual |
| `/status` | Mostra status da sessão |

## Múltiplas sessões

Cada sessão roda em sua própria thread Discord, completamente isolada. Você pode ter até 3 sessões ativas simultaneamente por usuário (configurável via `MAX_SESSIONS_PER_USER`).

---

## Segurança

- **Ownership de sessão**: Apenas o criador pode controlar a sessão (mensagens na thread de outro usuário são ignoradas). Configurável com `ALLOW_SHARED_SESSIONS=true`.
- **Rate limiting**: Máximo de 5 comandos por minuto por usuário.
- **Limite de sessões**: Máximo de 3 sessões ativas por usuário (configurável).
- **Sanitização de env vars**: O processo `opencode serve` recebe apenas variáveis necessárias (PATH, HOME, OPENCODE_*, ANTHROPIC_*). O `DISCORD_TOKEN` e outras credenciais nunca são repassados.
- **Path traversal protection**: Validação de caminho impede acesso a diretórios fora do `PROJECTS_BASE_PATH`.

---

## Operações

### Health check

O bot expõe um endpoint HTTP de health check:

```bash
curl http://localhost:9090/health
# {"status":"ok","uptime":3600,"sessions":{"total":5,"active":2}}
```

Configurável via `HEALTH_PORT` (padrão: 9090). Integrado ao Docker HEALTHCHECK.

### Docker

```bash
# Build e run
docker compose up -d

# Ou manualmente
docker build -t opencode-discord .
docker run --env-file .env -v /caminho/projetos:/projects opencode-discord
```

### Graceful shutdown

Ao receber SIGINT/SIGTERM, o bot:
1. Notifica todas as threads ativas ("Bot reiniciando...")
2. Encerra sessões com timeout de 10s
3. Para todos os servidores opencode

### Timeout de sessão

Sessões inativas por mais de 30 minutos (configurável via `SESSION_TIMEOUT_MS`) são automaticamente encerradas com notificação na thread.

### Reconexão SSE

Se a conexão SSE com o `opencode serve` cair, o bot reconecta automaticamente com backoff exponencial (1s → 30s).

### Notificação DM

Quando habilitado (`ENABLE_DM_NOTIFICATIONS=true`), o bot envia uma mensagem direta ao criador da sessão quando o agente termina de processar, com preview do último output.

---

## Testes

```bash
# Rodar testes
npm test

# Rodar uma vez (CI)
npm run test:ci
```

Cobertura de testes: utils, SSE parser, config/path validation, rate limiter, stream chunking.

### CI/CD

O projeto usa GitHub Actions para CI automático (Node 18/20/22) em push para `main` e PRs.

---

## Configuração (.env)

### Referência rápida

| Variável | Obrigatório | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `DISCORD_TOKEN` | ✅ | — | Token do bot Discord |
| `DISCORD_GUILD_ID` | ✅ | — | ID do servidor Discord |
| `PROJECTS_BASE_PATH` | ✅ | — | Caminho base dos projetos |
| `DISCORD_CLIENT_ID` | ❌ | (auto) | Application ID do bot |
| `OPENCODE_BIN` | ❌ | `opencode` | Caminho para executável |
| `ALLOWED_USER_IDS` | ❌ | (vazio) | IDs de usuários autorizados |
| `DISCORD_ALLOWED_CHANNEL_ID` | ❌ | (vazio) | Restringe a um canal |
| `DISCORD_MSG_LIMIT` | ❌ | `1900` | Máx. caracteres por mensagem |
| `STREAM_UPDATE_INTERVAL` | ❌ | `1500` | Intervalo de atualização (ms) |
| `ALLOW_SHARED_SESSIONS` | ❌ | `false` | Permite controle entre usuários |
| `MAX_SESSIONS_PER_USER` | ❌ | `3` | Limite de sessões ativas por usuário |
| `SESSION_TIMEOUT_MS` | ❌ | `1800000` | Timeout de inatividade (30 min) |
| `HEALTH_PORT` | ❌ | `9090` | Porta do endpoint de health check |
| `ENABLE_DM_NOTIFICATIONS` | ❌ | `false` | Notificação DM ao fim de sessão |
| `OPENCODE_BASE_PORT` | ❌ | `4100` | Porta base dos servidores opencode |
| `OPENCODE_TIMEOUT_MS` | ❌ | `10000` | Timeout HTTP para opencode |

---

### Passo a passo

#### 1. `DISCORD_TOKEN` (obrigatório)

Este é o token secreto que autoriza o bot a se conectar ao Discord.

**Passos:**

1. Acesse [Discord Developer Portal](https://discord.com/developers/applications)
2. Clique em **"New Application"** e dê um nome ao bot
3. Na barra lateral esquerda, abra a aba **"Bot"**
4. Clique em **"Reset Token"**, confirme, e **copie o token**
5. Abra a aba **"Privileged Gateway Intents"** e habilite **"Message Content Intent"** (necessário para ler mensagens nas threads)
6. Agora que o token está copiado, você precisará convidar o bot ao seu servidor:
   - Vá para a aba **"OAuth2"** → **"URL Generator"**
   - Em "Scopes", selecione: `bot` e `applications.commands`
   - Em "Permissions", selecione:
     - ✅ Enviar mensagens
     - ✅ Criar tópicos públicos
     - ✅ Enviar mensagens em tópicos
     - ✅ Ver histórico de mensagens
     - ✅ Adicionar reações
     - ✅ Inserir links
      - ✅ Usar comandos de barra
   - Copie a URL gerada e abra em seu navegador para convidar o bot ao servidor
7. Cole o token no `.env`:

```env
DISCORD_TOKEN=seu_token_aqui
```

---

#### 2. `DISCORD_GUILD_ID` (obrigatório)

Este é o ID do seu servidor Discord (também chamado de "guild").

**Passos:**

1. Abra Discord
2. Vá para **Settings** (no canto inferior esquerdo) → **Advanced** → habilite **"Developer Mode"**
3. Feche Settings e clique com botão direito no **nome do servidor** (no topo da lista de canais)
4. Selecione **"Copy Server ID"**
5. Cole no `.env`:

```env
DISCORD_GUILD_ID=123456789012345678
```

---

#### 3. `DISCORD_CLIENT_ID` (opcional, recomendado na primeira execução)

Este é o "Application ID" do seu bot. É necessário apenas para registrar os slash commands no seu servidor na primeira vez que o bot inicia.

**Passos:**

1. Acesse [Discord Developer Portal](https://discord.com/developers/applications)
2. Abra sua aplicação (o bot que criou no passo 1 do `DISCORD_TOKEN`)
3. Na aba **"General Information"**, copie o **"Application ID"**
4. Descomente e cole no `.env`:

```env
DISCORD_CLIENT_ID=123456789012345678
```

> **Nota:** Após a primeira execução, você pode deixar comentado ou remover. O bot detecta automaticamente depois.

---

#### 4. `PROJECTS_BASE_PATH` (obrigatório)

Este é o caminho completo da pasta que contém seus projetos. O bot listará cada subpasta como um projeto selecionável nos comandos `/plan` e `/build`.

**Exemplo prático:**

Se seus projetos estão assim:

```
C:\Users\lenno\Projects\
  ├── projeto-a\
  ├── projeto-b\
  └── projeto-c\
```

Configure:

```env
PROJECTS_BASE_PATH=C:\Users\lenno\Projects
```

Agora, quando usar `/plan`, o bot mostrará: `projeto-a`, `projeto-b`, `projeto-c`.

---

#### 5. `ALLOWED_USER_IDS` (opcional, mas recomendado)

Restringe o uso do bot a usuários específicos do Discord. Deixe vazio para permitir qualquer membro do servidor.

```env
ALLOWED_USER_IDS=123456789012345678,987654321098765432
```

---

## Exemplo de `.env` completo

```env
# Obrigatório
DISCORD_TOKEN=MzA4NjIyNTEzOTAwMzI2OTc3.xyz123abc456def789ghijkl
DISCORD_GUILD_ID=123456789012345678
PROJECTS_BASE_PATH=C:\Users\lenno\Projects

# Recomendado na primeira execução
DISCORD_CLIENT_ID=123456789012345678

# Recomendado para segurança
ALLOWED_USER_IDS=123456789012345678

# Opcional
OPENCODE_BIN=opencode
OPENCODE_BASE_PORT=4100
DISCORD_ALLOWED_CHANNEL_ID=
DISCORD_MSG_LIMIT=1900
STREAM_UPDATE_INTERVAL=1500

# Sessões
MAX_SESSIONS_PER_USER=3
SESSION_TIMEOUT_MS=1800000
ALLOW_SHARED_SESSIONS=false

# Operações
HEALTH_PORT=9090
ENABLE_DM_NOTIFICATIONS=false
```

---

## Arquitetura

```
src/
├── index.js              # Entry point — Discord client, eventos, shutdown
├── config.js             # Configuração centralizada (env vars)
├── commands.js           # Slash commands e handlers de interação
├── session-manager.js    # OpenCodeSession + SessionManager (lifecycle)
├── server-manager.js     # OpenCodeServer + ServerManager (processos)
├── opencode-client.js    # Cliente HTTP para API REST do opencode
├── sse-parser.js         # Parser de Server-Sent Events
├── stream-handler.js     # Streaming de output para Discord (edição+criação)
├── opencode-commands.js  # Listagem de comandos customizados do opencode
├── rate-limiter.js       # Rate limiting por usuário
└── health.js             # Endpoint HTTP de health check
```

## Especificação completa

Veja [`specs/0001/SPEC.md`](specs/0001/SPEC.md) para arquitetura detalhada, decisões de design e roadmap.
