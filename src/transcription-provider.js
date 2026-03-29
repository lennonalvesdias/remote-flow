// src/transcription-provider.js
// Abstração de múltiplos backends de transcrição de áudio.
// Seleciona o provider ativo via variável de ambiente TRANSCRIPTION_PROVIDER.

// ─── Imports ──────────────────────────────────────────────────────────────────

import { transcribeAudio, checkWhisperHealth } from './whisper-client.js';
import {
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_API_KEY,
  TRANSCRIPTION_API_MODEL,
  WHISPER_LANGUAGE,
} from './config.js';

// ─── Provider local (faster-whisper) ─────────────────────────────────────────

/**
 * Provider local — delega ao Whisper Server rodando na mesma máquina.
 * Não requer chave de API nem acesso à internet.
 */
const localProvider = {
  get name() {
    return 'local';
  },

  /**
   * @param {Buffer} audioBuffer
   * @param {string} [filename='voice.ogg']
   * @returns {Promise<{ text: string, language: string, duration: number }>}
   */
  async transcribe(audioBuffer, filename = 'voice.ogg') {
    return transcribeAudio(audioBuffer, filename);
  },

  /** @returns {Promise<boolean>} */
  async checkHealth() {
    return checkWhisperHealth();
  },
};

// ─── Provider OpenAI ──────────────────────────────────────────────────────────

/**
 * Provider OpenAI — usa a API oficial `v1/audio/transcriptions`.
 * Requer TRANSCRIPTION_API_KEY configurada.
 */
const openaiProvider = {
  get name() {
    return 'openai';
  },

  /**
   * @param {Buffer} audioBuffer
   * @param {string} [filename='voice.ogg']
   * @returns {Promise<{ text: string, language: string, duration: number }>}
   */
  async transcribe(audioBuffer, filename = 'voice.ogg') {
    if (!TRANSCRIPTION_API_KEY) {
      throw new Error(
        '[TranscriptionProvider] ❌ TRANSCRIPTION_API_KEY não configurada para o provider "openai".',
      );
    }

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', TRANSCRIPTION_API_MODEL);
    form.append('language', WHISPER_LANGUAGE);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[TranscriptionProvider] OpenAI retornou ${response.status}: ${body}`);
    }

    const data = await response.json();
    // A API da OpenAI retorna `duration` em segundos como número decimal
    return {
      text: data.text,
      language: WHISPER_LANGUAGE,
      duration: data.duration ?? 0,
    };
  },

  /**
   * Verifica disponibilidade sem realizar chamada HTTP (evita cobranças desnecessárias).
   * Retorna `true` se a chave de API estiver configurada.
   *
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    return Boolean(TRANSCRIPTION_API_KEY);
  },
};

// ─── Provider Groq ────────────────────────────────────────────────────────────

/**
 * Provider Groq — usa a API compatível com OpenAI em `api.groq.com`.
 * Resposta retorna apenas `{ text }` — duration é preenchida como 0.
 * Requer TRANSCRIPTION_API_KEY configurada.
 */
const groqProvider = {
  get name() {
    return 'groq';
  },

  /**
   * @param {Buffer} audioBuffer
   * @param {string} [filename='voice.ogg']
   * @returns {Promise<{ text: string, language: string, duration: number }>}
   */
  async transcribe(audioBuffer, filename = 'voice.ogg') {
    if (!TRANSCRIPTION_API_KEY) {
      throw new Error(
        '[TranscriptionProvider] ❌ TRANSCRIPTION_API_KEY não configurada para o provider "groq".',
      );
    }

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', TRANSCRIPTION_API_MODEL);
    form.append('language', WHISPER_LANGUAGE);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[TranscriptionProvider] Groq retornou ${response.status}: ${body}`);
    }

    // Groq retorna apenas { text } — complementa com valores padrão
    const data = await response.json();
    return { text: data.text, language: WHISPER_LANGUAGE, duration: 0 };
  },

  /**
   * Verifica disponibilidade sem realizar chamada HTTP (evita cobranças desnecessárias).
   * Retorna `true` se a chave de API estiver configurada.
   *
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    return Boolean(TRANSCRIPTION_API_KEY);
  },
};

// ─── Seleção do provider ──────────────────────────────────────────────────────

/** Mapa de todos os providers suportados */
const PROVIDERS = {
  local: localProvider,
  openai: openaiProvider,
  groq: groqProvider,
};

if (!(TRANSCRIPTION_PROVIDER in PROVIDERS)) {
  throw new Error(
    `[TranscriptionProvider] ❌ Provider desconhecido: "${TRANSCRIPTION_PROVIDER}". ` +
      `Valores válidos: ${Object.keys(PROVIDERS).join(', ')}.`,
  );
}

// ─── Exportação ───────────────────────────────────────────────────────────────

/**
 * Provider de transcrição ativo, selecionado via TRANSCRIPTION_PROVIDER.
 * Suporta os backends: "local" (Whisper local), "openai", "groq".
 *
 * @type {{
 *   transcribe(audioBuffer: Buffer, filename?: string): Promise<{ text: string, language: string, duration: number }>,
 *   checkHealth(): Promise<boolean>,
 *   name: string,
 * }}
 */
export const provider = PROVIDERS[TRANSCRIPTION_PROVIDER];
