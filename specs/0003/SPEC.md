# Whisper Local — Integração com remote-flow

> Transcrição de mensagens de voz do Discord para instruções de texto no OpenCode, rodando localmente na mesma máquina Windows que hospeda o bot.

---

## Índice

1. [Visão geral da arquitetura](#1-visão-geral-da-arquitetura)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Instalação do Whisper](#3-instalação-do-whisper)
4. [Microserviço de transcrição](#4-microserviço-de-transcrição)
5. [Integração no remote-flow](#5-integração-no-remote-flow)
6. [Configuração e variáveis de ambiente](#6-configuração-e-variáveis-de-ambiente)
7. [Inicialização conjunta dos serviços](#7-inicialização-conjunta-dos-serviços)
8. [Referência do modelo recomendado](#8-referência-do-modelo-recomendado)

---

## 1. Visão geral da arquitetura

```
Discord App (mobile)
    │
    │  voice message (.ogg / Opus)
    ▼
Discord Bot (remote-flow)          ← Node.js / TypeScript
    │
    │  1. detecta attachment com duration_secs
    │  2. baixa o arquivo .ogg via fetch
    │  3. POST /transcribe → whisper_server (localhost:8765)
    ▼
Whisper Server                     ← Python / Flask  (localhost:8765)
    │
    │  faster-whisper small · CUDA int8
    │  idioma: pt (forçado)
    ▼
texto transcrito
    │
    ▼
remote-flow (lógica existente)
    │
    │  injeta texto como mensagem na thread ativa
    ▼
OpenCode (sessão local)
```

Todos os componentes rodam na **mesma máquina Windows**. O Whisper Server é um processo Python independente que o bot Node.js consulta via HTTP local — sem dependências cruzadas entre os runtimes.

---

## 2. Pré-requisitos

| Requisito | Versão mínima | Observação |
|---|---|---|
| Python | 3.10+ | Recomendado via `pyenv-win` ou instalador oficial |
| CUDA Toolkit | 11.8+ | Para aceleração na RTX 3060 |
| cuDNN | 8.x | Necessário para CTranslate2 (backend do faster-whisper) |
| ffmpeg | qualquer | Conversão de formatos de áudio |
| Node.js | 18+ | Já em uso no remote-flow |

### Verificar CUDA disponível

```powershell
python -c "import torch; print(torch.cuda.is_available(), torch.version.cuda)"
# Esperado: True  11.8  (ou versão superior)
```

Se retornar `False`, instale o CUDA Toolkit antes de continuar.

---

## 3. Instalação do Whisper

### 3.1 Criar ambiente virtual isolado

```powershell
# Na raiz do projeto remote-flow (ou em pasta separada)
python -m venv .venv-whisper
.venv-whisper\Scripts\activate
```

### 3.2 Instalar dependências

```powershell
# PyTorch com suporte CUDA 11.8
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118

# faster-whisper (CTranslate2 backend — muito mais rápido que o Whisper original)
pip install faster-whisper

# Servidor HTTP leve
pip install flask
```

### 3.3 Instalar ffmpeg

```powershell
# Via Scoop (recomendado)
scoop install ffmpeg

# Ou via Chocolatey
choco install ffmpeg
```

Verificar:

```powershell
ffmpeg -version
```

### 3.4 Download do modelo (primeira execução)

O modelo é baixado automaticamente na primeira vez que o servidor inicializa. Para forçar o download antes de usar:

```python
# download_model.py — execute uma vez
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cuda", compute_type="int8")
print("Modelo pronto.")
```

```powershell
python download_model.py
# Baixa ~244 MB para %USERPROFILE%\.cache\huggingface\hub\
```

---

## 4. Microserviço de transcrição

Crie o arquivo `whisper_server/server.py` dentro do projeto remote-flow:

```python
# whisper_server/server.py
import os
import tempfile
import logging
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisper-server")

# ---------------------------------------------------------------------------
# Modelo — carregado uma vez ao iniciar o processo
# ---------------------------------------------------------------------------
MODEL_SIZE    = os.getenv("WHISPER_MODEL", "small")      # tiny | base | small | medium
DEVICE        = os.getenv("WHISPER_DEVICE", "cuda")      # cuda | cpu
COMPUTE_TYPE  = os.getenv("WHISPER_COMPUTE", "int8")     # int8 | float16 | float32
LANGUAGE      = os.getenv("WHISPER_LANGUAGE", "pt")      # forçar idioma evita detecção desnecessária
PORT          = int(os.getenv("WHISPER_PORT", "8765"))

logger.info(f"Carregando modelo {MODEL_SIZE} em {DEVICE} ({COMPUTE_TYPE})...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
logger.info("Modelo pronto.")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Endpoint principal
# ---------------------------------------------------------------------------
@app.post("/transcribe")
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "campo 'audio' ausente"}), 400

    audio_file = request.files["audio"]

    # Salva em arquivo temporário (ffmpeg precisa de path em disco)
    suffix = os.path.splitext(audio_file.filename or ".ogg")[1] or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=LANGUAGE,
            beam_size=5,
            vad_filter=True,          # remove silêncio — melhora velocidade
            vad_parameters={"min_silence_duration_ms": 500},
        )
        text = "".join(segment.text for segment in segments).strip()
        logger.info(f"Transcrito ({info.duration:.1f}s): {text[:80]}...")
        return jsonify({"text": text, "language": info.language, "duration": info.duration})
    except Exception as e:
        logger.error(f"Erro na transcrição: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": DEVICE})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=False)
```

### Estrutura de diretórios após adicionar o serviço

```
remote-flow/
├── src/
│   ├── bot/
│   │   ├── handlers/
│   │   │   ├── messageCreate.ts       ← modificado
│   │   │   └── ...
│   │   └── ...
│   ├── services/
│   │   ├── whisper.ts                 ← novo
│   │   └── ...
│   └── ...
├── whisper_server/
│   └── server.py                      ← novo
├── .venv-whisper/                     ← gitignore
├── .env
└── package.json
```

---

## 5. Integração no remote-flow

### 5.1 Serviço TypeScript de transcrição

Crie `src/services/whisper.ts`:

```typescript
// src/services/whisper.ts
import FormData from "form-data";
import fetch from "node-fetch";

const WHISPER_URL = process.env.WHISPER_URL ?? "http://127.0.0.1:8765";

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
}

/**
 * Envia um buffer de áudio para o Whisper Server local e retorna o texto.
 * Aceita qualquer formato suportado pelo ffmpeg (.ogg, .mp3, .wav, etc.)
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = "voice.ogg"
): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("audio", audioBuffer, { filename, contentType: "audio/ogg" });

  const response = await fetch(`${WHISPER_URL}/transcribe`, {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper Server retornou ${response.status}: ${body}`);
  }

  return response.json() as Promise<TranscriptionResult>;
}

/**
 * Verifica se o Whisper Server está disponível.
 * Use no startup do bot para fail-fast.
 */
export async function checkWhisperHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
```

### 5.2 Detectar voice messages no handler de mensagens

No handler `messageCreate` (adapte ao nome e estilo do seu código existente):

```typescript
// src/bot/handlers/messageCreate.ts
import { Message, AttachmentBuilder } from "discord.js";
import { transcribeAudio } from "../../services/whisper";
// ... seus imports existentes (sendToSession, getThreadSession, etc.)

/**
 * Retorna o primeiro attachment que é uma voice message do Discord.
 * Voice messages têm a propriedade duration_secs definida.
 */
function getVoiceAttachment(message: Message) {
  return message.attachments.find(
    (a) => a.duration !== null && a.duration !== undefined
  ) ?? null;
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;

  // --- INÍCIO: bloco de voz (novo) ---
  const voiceAttachment = getVoiceAttachment(message);

  if (voiceAttachment) {
    // Reação visual imediata para o usuário saber que foi recebido
    await message.react("🎙️");

    try {
      // Baixa o arquivo .ogg diretamente da CDN do Discord
      const audioResponse = await fetch(voiceAttachment.url);
      if (!audioResponse.ok) throw new Error("Falha ao baixar áudio do Discord");
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Transcreve localmente via Whisper
      const { text, duration } = await transcribeAudio(audioBuffer);

      if (!text) {
        await message.react("❓");
        return;
      }

      // Remove reação de "processando" e adiciona confirmação
      await message.reactions.cache.get("🎙️")?.remove();
      await message.react("✅");

      // Opcional: responde na thread mostrando o que foi transcrito
      // await message.reply(`> 🎙️ *"${text}"*`);

      // Injeta o texto transcrito no fluxo existente exatamente como
      // se o usuário tivesse digitado a mensagem
      // Substitua esta linha pela sua chamada real ao remote-flow session
      await forwardToSession(message, text);

    } catch (error) {
      console.error("[Whisper] Erro ao transcrever:", error);
      await message.reactions.cache.get("🎙️")?.remove();
      await message.react("❌");
      await message.reply("❌ Não foi possível transcrever o áudio. Tente enviar como texto.");
    }

    return; // evita processar como mensagem de texto normal
  }
  // --- FIM: bloco de voz ---

  // ... sua lógica existente de mensagens de texto
}

/**
 * Encaminha o texto para a sessão OpenCode da thread atual.
 * Adapte esta função para chamar sua API/serviço existente do remote-flow.
 */
async function forwardToSession(message: Message, text: string): Promise<void> {
  // Exemplo genérico — substitua pela sua implementação real:
  // await remoteFlowApi.sendMessage(message.channelId, text);
  throw new Error("Implemente forwardToSession com a lógica do remote-flow");
}
```

### 5.3 Health check no startup do bot

Adicione ao arquivo de inicialização do bot (ex.: `src/index.ts`):

```typescript
import { checkWhisperHealth } from "./services/whisper";

// No startup, antes do client.login()
const whisperAvailable = await checkWhisperHealth();
if (whisperAvailable) {
  console.log("✅ Whisper Server conectado — voice messages habilitadas");
} else {
  console.warn("⚠️  Whisper Server indisponível — voice messages desabilitadas");
  console.warn("   Inicie com: .venv-whisper\\Scripts\\activate && python whisper_server/server.py");
}
```

### 5.4 Dependências Node.js necessárias

```bash
npm install form-data node-fetch
npm install --save-dev @types/node-fetch
```

Se o projeto já usa `node-fetch` v3 (ESM), ajuste os imports conforme necessário.

---

## 6. Configuração e variáveis de ambiente

Adicione ao `.env` do projeto:

```dotenv
# ── Whisper Server ──────────────────────────────────────────────
WHISPER_URL=http://127.0.0.1:8765

# Variáveis consumidas pelo whisper_server/server.py
WHISPER_MODEL=small       # tiny | base | small | medium | large-v3
WHISPER_DEVICE=cuda       # cuda | cpu (cpu é ~10x mais lento)
WHISPER_COMPUTE=int8      # int8 economiza VRAM sem perda perceptível em pt-BR
WHISPER_LANGUAGE=pt       # forçar idioma elimina etapa de detecção automática
WHISPER_PORT=8765
```

Adicione ao `.gitignore`:

```
.venv-whisper/
whisper_server/__pycache__/
```

---

## 7. Inicialização conjunta dos serviços

Para facilitar o start de tudo junto, crie um script PowerShell `start-all.ps1`:

```powershell
# start-all.ps1
$ErrorActionPreference = "Stop"

Write-Host "🐍 Iniciando Whisper Server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList `
  "-NoExit", "-Command", `
  "& { cd '$PSScriptRoot'; .\.venv-whisper\Scripts\activate; python whisper_server/server.py }"

# Aguarda o servidor subir (modelo leva ~5s para carregar na GPU)
Write-Host "⏳ Aguardando Whisper Server..." -ForegroundColor Yellow
Start-Sleep -Seconds 8

Write-Host "🤖 Iniciando remote-flow bot..." -ForegroundColor Cyan
npm run dev
```

Ou adicione ao `package.json`:

```json
{
  "scripts": {
    "whisper": ".venv-whisper\\Scripts\\python whisper_server/server.py",
    "dev:whisper": "concurrently \"npm run whisper\" \"npm run dev\""
  }
}
```

```bash
npm install --save-dev concurrently
npm run dev:whisper
```

---

## 8. Referência do modelo recomendado

### Configuração escolhida: `small` + `cuda` + `int8`

| Parâmetro | Valor | Motivo |
|---|---|---|
| Modelo | `small` | 244M parâmetros — equilíbrio ótimo entre precisão e velocidade para pt-BR |
| Device | `cuda` | RTX 3060 4GB — ~6x realtime (áudio de 30s transcrito em ~5s) |
| Compute type | `int8` | Usa ~600MB de VRAM vs ~1GB em float16 — cabe folgado na 3060 |
| Idioma | `pt` (forçado) | Elimina etapa de detecção — reduz latência em ~200ms |
| `vad_filter` | `true` | Remove silêncios — acelera transcrições com pausas longas |

### Tabela de modelos disponíveis

| Modelo | Parâmetros | VRAM necessária | Velocidade relativa | Uso recomendado |
|---|---|---|---|---|
| `tiny` | 39M | ~200 MB | ~32× realtime | Prototipagem |
| `base` | 74M | ~300 MB | ~16× realtime | Testes rápidos |
| **`small`** | **244M** | **~600 MB** | **~6× realtime** | **Recomendado** |
| `medium` | 769M | ~1.5 GB | ~2× realtime | Máxima precisão na 3060 |
| `large-v3` | 1.5B | ~3 GB | ~1× realtime | GPU ≥ 8GB VRAM |

### Estimativa de latência (RTX 3060 4GB)

| Duração do áudio | Modelo `small` int8 | Modelo `medium` int8 |
|---|---|---|
| 5s | ~0.8s | ~2.5s |
| 15s | ~2.5s | ~7.5s |
| 30s | ~5s | ~15s |
| 60s | ~10s | ~30s |

> Para mensagens de voz típicas do Discord (5–20s), o `small` responde em menos de 3 segundos — tempo imperceptível para o usuário.

---

*Documento gerado em março/2026 para o projeto `remote-flow` (lennonalvesdias).*
