# Transcrição de Mensagens de Voz (Whisper)

Documentação de setup e uso da feature de transcrição automática de áudio no RemoteFlow.

---

## Visão Geral

O RemoteFlow detecta automaticamente mensagens de voz enviadas em threads do Discord (arquivos `.ogg` com Opus e campo `duration_secs`, além de outros formatos de áudio suportados) e as transcreve para texto antes de encaminhá-las ao OpenCode via `session.queueMessage()`.

**Fluxo simplificado:**

```
Usuário envia voz no Discord
        ↓
bot.js detecta attachment de áudio
        ↓
transcription-provider.js seleciona backend (local / openai / groq)
        ↓
Áudio transcrito → texto
        ↓
[Opcional] Reply na thread exibindo a transcrição
        ↓
session.queueMessage(textoTranscrito)
        ↓
OpenCode processa como mensagem normal
```

O feature é **auto-habilitado**: durante o startup o bot executa um health check no provider configurado. Se o provider não estiver disponível, a transcrição é desativada silenciosamente e mensagens de voz são ignoradas.

---

## Pré-requisitos

| Dependência | Versão mínima | Notas |
|---|---|---|
| Node.js | 20.0.0 | `fetch` e `FormData` nativos obrigatórios |
| Python | 3.10+ | Apenas para provider `local` |
| ffmpeg | qualquer | Apenas para provider `local`; deve estar no `PATH` |
| CUDA Toolkit | 11.8+ | Opcional; apenas para aceleração GPU no provider `local` |

> **ffmpeg** é obrigatório para o provider `local`. O faster-whisper usa o ffmpeg para decodificar os arquivos de áudio recebidos do Discord.

---

## Setup do Whisper Server Local (provider `local`)

### 1. Executar o script de setup

```powershell
# Execute a partir da raiz do projeto
.\whisper_server\setup.ps1
```

O script irá:
- Criar um venv Python em `whisper_server\.venv`
- Instalar as dependências (`flask`, `waitress`, `faster-whisper`)
- Baixar o modelo selecionado (padrão: `small`) para cache local

> Na primeira execução o download do modelo pode levar alguns minutos dependendo da sua conexão.

### 2. Iniciar o servidor

```bash
npm run whisper
```

O servidor sobe em `http://127.0.0.1:8765` por padrão.

### 3. Verificar o health check

```bash
curl http://127.0.0.1:8765/health
```

Resposta esperada:

```json
{ "status": "ok", "model": "small", "device": "cpu" }
```

---

## Configuração via `.env`

Adicione as variáveis abaixo ao seu `.env`:

```dotenv
# ── Transcrição de Voz ────────────────────────────────────────────────────────

# Provider de transcrição: local | openai | groq
# Padrão: local
TRANSCRIPTION_PROVIDER=local

# URL do Whisper Server local (apenas para TRANSCRIPTION_PROVIDER=local)
# Padrão: http://127.0.0.1:8765
WHISPER_URL=http://127.0.0.1:8765

# API key para providers externos (openai ou groq)
# Não necessário para provider local
TRANSCRIPTION_API_KEY=sk-...

# Modelo a usar nos providers externos (openai ou groq)
# Padrão: whisper-1
TRANSCRIPTION_API_MODEL=whisper-1

# Duração máxima de áudio aceita (segundos)
# Mensagens acima deste limite são rejeitadas com aviso ao usuário
# Padrão: 300 (5 minutos)
VOICE_MAX_DURATION_SECS=300

# Exibir transcrição como reply na thread antes de enviar ao OpenCode?
# true = exibe; false = processa silenciosamente
# Padrão: true
VOICE_SHOW_TRANSCRIPT=true
```

---

## Providers Disponíveis

| Provider | Variável | Latência | Custo | Privacidade | Requer internet |
|---|---|---|---|---|---|
| `local` | — | Médio–Alto (depende do hardware) | Gratuito | Total (local) | Não |
| `openai` | `TRANSCRIPTION_API_KEY` | Baixo | Pago (por minuto) | Dados enviados à OpenAI | Sim |
| `groq` | `TRANSCRIPTION_API_KEY` | Muito baixo | Free tier generoso | Dados enviados à Groq | Sim |

**Recomendações:**
- **Desenvolvimento / privacidade**: use `local` com modelo `small`
- **Produção com baixa latência**: use `groq` (Whisper Large V3 hospedado)
- **Integração com stack OpenAI existente**: use `openai`

---

## Modelos Disponíveis (provider `local`)

Configure o modelo no script `setup.ps1` ou na variável `WHISPER_MODEL` (se exposta):

| Modelo | VRAM aprox. | Velocidade | Qualidade | Recomendado para |
|---|---|---|---|---|
| `tiny` | ~1 GB | Muito rápido | Baixa | Testes rápidos |
| `base` | ~1 GB | Rápido | Razoável | Hardware limitado |
| `small` | ~2 GB | Bom | Boa | **Uso geral (recomendado)** |
| `medium` | ~5 GB | Moderado | Muito boa | Transcrições críticas |
| `large-v3` | ~10 GB | Lento | Excelente | GPU dedicada disponível |

> Para uso no Windows sem GPU dedicada, **`small`** oferece o melhor equilíbrio entre velocidade e qualidade.

---

## Fluxo de uma Mensagem de Voz

Passo a passo do que ocorre ao enviar um áudio em uma thread ativa:

1. **Detecção** — o handler `messageCreate` em `index.js` verifica se o attachment possui `content_type` de áudio ou campo `duration_secs` (indicador de voice message nativo do Discord)
2. **Validação de duração** — se `duration_secs > VOICE_MAX_DURATION_SECS`, o bot responde com aviso e descarta o áudio
3. **Download** — o arquivo de áudio é baixado em memória via `fetch`
4. **Transcrição** — `transcription-provider.js` roteia para o backend configurado:
   - `local`: envia `multipart/form-data` ao `whisper_server/server.py` via `whisper-client.js`
   - `openai` / `groq`: envia para o endpoint `/v1/audio/transcriptions` da API correspondente
5. **Exibição** *(se `VOICE_SHOW_TRANSCRIPT=true`)* — bot faz reply na thread com o texto transcrito formatado como citação
6. **Encaminhamento** — `session.queueMessage(textoTranscrito)` envia o texto ao OpenCode como se fosse uma mensagem digitada
7. **Auditoria** — `audit('message.voice', { duration, textLength, provider })` registra o evento para observabilidade

---

## Troubleshooting

### Whisper Server não inicia

**Sintoma:** `npm run whisper` termina imediatamente ou exibe erro de importação.

**Causas comuns:**
- `ffmpeg` não está no `PATH` → instale o ffmpeg e adicione ao PATH do sistema
- venv não foi criado → execute `.\whisper_server\setup.ps1` novamente
- Python não encontrado → verifique `python --version` no terminal

```powershell
# Verificar ffmpeg
ffmpeg -version

# Recriar o venv do zero
Remove-Item -Recurse -Force whisper_server\.venv
.\whisper_server\setup.ps1
```

---

### CUDA não disponível (aviso no startup)

**Sintoma:** Log exibe `⚠️ CUDA não disponível, usando CPU`.

**Solução:** Isso é esperado em máquinas sem GPU NVIDIA com CUDA instalado. O servidor funciona normalmente em CPU, apenas com velocidade reduzida. Não é necessário nenhuma ação.

Para forçar CPU explicitamente e suprimir o aviso, defina no `setup.ps1` ou no script de start:

```
WHISPER_DEVICE=cpu
```

---

### Provider externo não funciona (openai / groq)

**Sintoma:** Mensagens de voz são ignoradas ou bot exibe `❌ Falha na transcrição`.

**Verificações:**
1. `TRANSCRIPTION_API_KEY` está definida e correta no `.env`
2. A key tem permissão para o endpoint de áudio (verifique no dashboard do provider)
3. O modelo em `TRANSCRIPTION_API_MODEL` existe no provider (ex: `whisper-1` para OpenAI, `whisper-large-v3` para Groq)

```dotenv
# Exemplo para Groq
TRANSCRIPTION_PROVIDER=groq
TRANSCRIPTION_API_KEY=gsk_...
TRANSCRIPTION_API_MODEL=whisper-large-v3
```

---

### Áudio rejeitado por duração

**Sintoma:** Bot responde com aviso de duração máxima excedida.

**Solução:** Aumente o limite no `.env`:

```dotenv
VOICE_MAX_DURATION_SECS=600  # 10 minutos
```

> Áudios muito longos aumentam o tempo de transcrição local. Para áudios acima de 10 min considere usar um provider externo (`groq` ou `openai`).

---

## Permissões do Bot no Discord

A feature de transcrição de voz requer que o bot tenha acesso ao **conteúdo de mensagens**:

| Intent / Permissão | Onde configurar | Por quê |
|---|---|---|
| `MESSAGE_CONTENT` (Privileged Intent) | Discord Developer Portal → Bot → Privileged Gateway Intents | Necessário para ler attachments de mensagens em servidores |
| `Read Message History` | Permissões do bot no servidor | Acesso às mensagens anteriores na thread |

> Sem o intent `MESSAGE_CONTENT` habilitado no Developer Portal **e** na instância do cliente Discord.js (`GatewayIntentBits.MessageContent`), o bot não recebe os attachments e a transcrição nunca é acionada.
