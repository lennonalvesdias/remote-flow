// src/whisper-client.js
// Cliente HTTP para o Whisper Server local — transcrição de mensagens de voz

import { WHISPER_URL, WHISPER_TRANSCRIPTION_TIMEOUT_MS } from './config.js';

// ─── Transcrição ──────────────────────────────────────────────────────────────

/**
 * Envia um buffer de áudio para o Whisper Server e retorna o texto transcrito.
 *
 * @param {Buffer} audioBuffer - Buffer com os dados de áudio
 * @param {string} [filename='voice.ogg'] - Nome do arquivo (determina o Content-Type)
 * @returns {Promise<{ text: string, language: string, duration: number }>}
 */
export async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('[WhisperClient] audioBuffer deve ser um Buffer não-vazio.');
  }
  const form = new FormData();
  form.append('audio', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);

  const response = await fetch(`${WHISPER_URL}/transcribe`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(WHISPER_TRANSCRIPTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper Server retornou ${response.status}: ${body}`);
  }

  return response.json();
}

// ─── Health ───────────────────────────────────────────────────────────────────

/**
 * Verifica se o Whisper Server está disponível e respondendo.
 * Nunca lança exceção — retorna `false` em qualquer falha de rede ou HTTP.
 *
 * @returns {Promise<boolean>}
 */
export async function checkWhisperHealth() {
  try {
    const response = await fetch(`${WHISPER_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch (err) {
    console.warn(`[WhisperClient] ⚠️  Servidor indisponível: ${err.message}`);
    return false;
  }
}
