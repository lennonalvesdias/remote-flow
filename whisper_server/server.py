# whisper_server/server.py
# Microserviço Flask para transcrição local de áudio via faster-whisper (CTranslate2).
# Não utiliza PyTorch — faster-whisper usa CTranslate2 diretamente.

# ─── Imports ──────────────────────────────────────────────────────────────────

import os
import tempfile
import logging
import concurrent.futures
import pathlib
import datetime
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
from waitress import serve

# ─── Configuração ─────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisper-server")

# ─── Persistência de logs ─────────────────────────────────────────────────────

# Cria pasta logs/ na raiz do projeto (dois níveis acima de whisper_server/)
_project_root = pathlib.Path(__file__).resolve().parent.parent
_logs_dir = _project_root / "logs"
_logs_dir.mkdir(exist_ok=True)

# Remove arquivos de log do whisper server com mais de 24h
_now = datetime.datetime.now()
for _log_file in _logs_dir.glob("whisper-*.log"):
    try:
        age = _now - datetime.datetime.fromtimestamp(_log_file.stat().st_mtime)
        if age.total_seconds() > 86400:
            _log_file.unlink()
    except Exception:
        pass

# Adiciona FileHandler para o logger whisper-server
_whisper_log_path = _logs_dir / f"whisper-{_now.strftime('%Y-%m-%d')}.log"
_file_handler = logging.FileHandler(_whisper_log_path, encoding="utf-8")
_file_handler.setLevel(logging.INFO)
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logging.getLogger().addHandler(_file_handler)

MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")
LANGUAGE = os.getenv("WHISPER_LANGUAGE", "pt")
PORT = int(os.getenv("WHISPER_PORT", "8765"))
HOST = os.getenv("WHISPER_HOST", "127.0.0.1")

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB
ALLOWED_EXTENSIONS = {".ogg", ".wav", ".mp3", ".webm", ".mp4", ".m4a", ".flac"}
TRANSCRIPTION_TIMEOUT = 120  # segundos

# ─── Carregamento do modelo ────────────────────────────────────────────────────

logger.info(
    f'[WhisperServer] ⚙️  Carregando modelo "{MODEL_SIZE}" em {DEVICE} ({COMPUTE_TYPE})...'
)
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
logger.info("[WhisperServer] ✅ Modelo carregado com sucesso.")

# ─── Validação de CUDA ────────────────────────────────────────────────────────

if DEVICE == "cuda":
    logger.info("[WhisperServer] 🔍 Validando CUDA com inferência de teste...")
    try:
        import numpy as np

        _test_audio = np.zeros(3200, dtype=np.float32)  # 0.2s de silêncio
        list(model.transcribe(_test_audio, language=LANGUAGE)[0])
        logger.info("[WhisperServer] ✅ CUDA validado e funcional.")
    except Exception as _cuda_err:
        logger.warning(
            f"[WhisperServer] ⚠️  CUDA indisponível ({_cuda_err}). "
            "Recarregando modelo em CPU..."
        )
        del model
        DEVICE = "cpu"
        COMPUTE_TYPE = "int8"
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        logger.info("[WhisperServer] ✅ Modelo recarregado em CPU.")

# ─── Aplicação Flask ──────────────────────────────────────────────────────────

app = Flask(__name__)

# ─── Endpoints ────────────────────────────────────────────────────────────────


@app.route("/health", methods=["GET"])
def health():
    """Retorna o status do servidor e o modelo carregado."""
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": DEVICE})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Recebe um arquivo de áudio via multipart (campo 'audio') e retorna a transcrição.

    Resposta de sucesso:
        { "text": str, "language": str, "duration": float }

    Respostas de erro:
        400 — campo 'audio' ausente
        413 — arquivo excede 25 MB
        500 — erro interno na transcrição
        504 — timeout de 120s excedido
    """
    if "audio" not in request.files:
        logger.warning('[WhisperServer] ⚠️  Requisição sem campo "audio".')
        return jsonify({"error": 'Campo "audio" ausente no formulário.'}), 400

    audio_file = request.files["audio"]

    # Guarda de tamanho: rejeita arquivos acima de 25 MB antes de tocar no disco
    audio_data = audio_file.read()
    if len(audio_data) > MAX_FILE_SIZE:
        logger.warning(
            f"[WhisperServer] ⚠️  Arquivo rejeitado: {len(audio_data)} bytes "
            f"(limite: {MAX_FILE_SIZE} bytes)."
        )
        return jsonify({"error": "Arquivo excede o limite de 25 MB."}), 413

    tmp_path = None
    try:
        # Persiste em arquivo temporário para o faster-whisper ler do disco
        raw_ext = os.path.splitext(audio_file.filename or "audio.ogg")[1].lower()
        suffix = raw_ext if raw_ext in ALLOWED_EXTENSIONS else ".ogg"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name

        logger.info(
            f"[WhisperServer] 🎤 Transcrevendo: {tmp_path} ({len(audio_data)} bytes)"
        )

        def _do_transcribe():
            segments, info = model.transcribe(
                tmp_path,
                language=LANGUAGE,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
            )
            # Consome o gerador dentro da thread para garantir execução completa
            text = " ".join(seg.text.strip() for seg in segments).strip()
            return text, info.language, info.duration

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_do_transcribe)
            try:
                text, detected_language, duration = future.result(
                    timeout=TRANSCRIPTION_TIMEOUT
                )
            except concurrent.futures.TimeoutError:
                logger.error("[WhisperServer] ❌ Timeout na transcrição (120s).")
                return jsonify({"error": "Timeout na transcrição."}), 504

        logger.info(
            f"[WhisperServer] ✅ Transcrição concluída: {len(text)} chars "
            f"({duration:.1f}s de áudio, idioma: {detected_language})"
        )
        return jsonify(
            {"text": text, "language": detected_language, "duration": duration}
        )

    except Exception as exc:
        logger.error(f"[WhisperServer] ❌ Erro interno na transcrição: {exc}")
        return jsonify({"error": str(exc)}), 500

    finally:
        # Remove o arquivo temporário independentemente do resultado
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception as cleanup_err:
                logger.warning(
                    f"[WhisperServer] ⚠️  Não foi possível remover arquivo temporário "
                    f'"{tmp_path}": {cleanup_err}'
                )


# ─── Inicialização ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info(f"[WhisperServer] 🚀 Iniciando servidor Waitress em {HOST}:{PORT}...")
    serve(app, host=HOST, port=PORT)
