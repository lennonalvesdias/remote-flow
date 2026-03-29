# download_model.py — execute uma vez para pré-baixar o modelo
# Uso: python whisper_server/download_model.py

import os
from faster_whisper import WhisperModel

MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")

print(f"[WhisperServer] Baixando modelo {MODEL_SIZE} ({DEVICE}/{COMPUTE_TYPE})...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
print("[WhisperServer] Modelo pronto.")
