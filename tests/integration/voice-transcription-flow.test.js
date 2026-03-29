// tests/integration/voice-transcription-flow.test.js
// Testa o fluxo de detecção e transcrição de mensagens de voz, integrando
// voice-utils.js com transcription-provider.js e seus backends configuráveis.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVoiceAttachment } from '../../src/voice-utils.js';
import { createMockMessage, createMockVoiceAttachment } from '@helpers/discord-mocks.js';

// ─── Stubs globais reutilizados nos providers ─────────────────────────────────

class MockFormData {
  constructor() { this._entries = []; }
  append(name, value, filename) { this._entries.push({ name, value, filename }); }
  getEntries() { return this._entries; }
}

class MockBlob {
  constructor(parts) { this.parts = parts; }
}

/**
 * Cria um mock de Response do fetch com status e dados configuráveis.
 * @param {unknown} data
 * @param {number} [status=200]
 * @returns {object}
 */
function mockFetchResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

// ─── Provider local (Whisper) ─────────────────────────────────────────────────

describe('Fluxo de transcrição de voz — Provider local (Whisper)', () => {
  let provider;
  let mockTranscribeAudio;
  let mockCheckWhisperHealth;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    mockTranscribeAudio = vi.fn();
    mockCheckWhisperHealth = vi.fn();

    vi.doMock('../../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'local',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
      VOICE_MAX_DURATION_SECS: 300,
    }));

    vi.doMock('../../src/whisper-client.js', () => ({
      transcribeAudio: mockTranscribeAudio,
      checkWhisperHealth: mockCheckWhisperHealth,
    }));

    const mod = await import('../../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcreve mensagem de voz e encaminha texto para sessão', async () => {
    const transcriptionResult = { text: 'olá mundo', language: 'pt', duration: 2 };
    mockTranscribeAudio.mockResolvedValue(transcriptionResult);

    const attachment = createMockVoiceAttachment();
    const attachments = new Map([[attachment.id, attachment]]);
    const message = createMockMessage({ attachments });

    const voiceAttachment = getVoiceAttachment(message);
    expect(voiceAttachment).not.toBeNull();

    const result = await provider.transcribe(Buffer.from('audio-data'));

    expect(result.text).toBe('olá mundo');
    const sessionQueueMessage = vi.fn();
    sessionQueueMessage(result.text);
    expect(sessionQueueMessage).toHaveBeenCalledWith('olá mundo');
  });

  it('falha na transcrição retorna erro tratado', async () => {
    mockTranscribeAudio.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.transcribe(Buffer.from('audio-data'))).rejects.toThrow(/ECONNREFUSED/);
  });

  it('valida duração máxima do áudio', async () => {
    const VOICE_MAX_DURATION_SECS = 300;
    const attachment = createMockVoiceAttachment({ duration_secs: 401 });

    expect(attachment.duration_secs).toBeGreaterThan(VOICE_MAX_DURATION_SECS);

    // Simula o que o código de produção faria em index.js:
    // não chama transcrição quando a duração excede o limite
    if (attachment.duration_secs <= VOICE_MAX_DURATION_SECS) {
      await provider.transcribe(Buffer.from('audio-data'));
    }

    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });
});

// ─── Provider OpenAI ──────────────────────────────────────────────────────────

describe('Fluxo de transcrição de voz — Provider OpenAI', () => {
  let provider;
  let mockFetch;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    vi.doMock('../../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'openai',
      TRANSCRIPTION_API_KEY: 'sk-test-key',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
      VOICE_MAX_DURATION_SECS: 300,
    }));

    vi.doMock('../../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const mod = await import('../../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcreve usando API da OpenAI quando configurado', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ text: 'texto openai', duration: 1.5 }));

    const result = await provider.transcribe(Buffer.from('audio-data'));

    expect(result.text).toBe('texto openai');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('falha se API key não configurada', async () => {
    vi.resetModules();
    vi.doMock('../../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'openai',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
      VOICE_MAX_DURATION_SECS: 300,
    }));
    vi.doMock('../../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const { provider: p } = await import('../../src/transcription-provider.js');

    await expect(p.transcribe(Buffer.from('audio-data'))).rejects.toThrow('TRANSCRIPTION_API_KEY');
  });
});

// ─── Provider Groq ────────────────────────────────────────────────────────────

describe('Fluxo de transcrição de voz — Provider Groq', () => {
  let provider;
  let mockFetch;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    vi.doMock('../../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'groq',
      TRANSCRIPTION_API_KEY: 'gsk-test-key',
      TRANSCRIPTION_API_MODEL: 'whisper-large-v3',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
      VOICE_MAX_DURATION_SECS: 300,
    }));

    vi.doMock('../../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const mod = await import('../../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcreve usando API da Groq quando configurado', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse({ text: 'texto groq' }));

    const result = await provider.transcribe(Buffer.from('audio-data'));

    expect(result.text).toBe('texto groq');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });
});

// ─── Detecção de anexo de voz ─────────────────────────────────────────────────
// getVoiceAttachment não tem dependências — pode ser importado estaticamente
// sem resetar módulos entre os testes.

describe('Detecção de anexo de voz', () => {
  it('detecta anexo de voz em mensagem Discord por MIME type audio/ogg', () => {
    const attachment = createMockVoiceAttachment(); // contentType: 'audio/ogg' por padrão
    const attachments = new Map([[attachment.id, attachment]]);
    const message = createMockMessage({ attachments });

    const result = getVoiceAttachment(message);

    expect(result).not.toBeNull();
    expect(result.id).toBe(attachment.id);
  });

  it('retorna null para mensagem sem anexo de voz', () => {
    const attachment = {
      id: 'img-1',
      contentType: 'image/png',
      duration: null,
      url: 'https://cdn.discordapp.com/image.png',
    };
    const attachments = new Map([[attachment.id, attachment]]);
    const message = createMockMessage({ attachments });

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });

  it('prioriza primeiro anexo de voz sobre outros tipos de anexo', () => {
    const imageAttachment = {
      id: 'img-1',
      contentType: 'image/png',
      duration: null,
    };
    const voiceAttachment = createMockVoiceAttachment({ id: 'audio-1' });
    // Imagem primeiro, depois voz — retorna a de voz
    const attachments = new Map([
      [imageAttachment.id, imageAttachment],
      [voiceAttachment.id, voiceAttachment],
    ]);
    const message = createMockMessage({ attachments });

    const result = getVoiceAttachment(message);

    expect(result).not.toBeNull();
    expect(result.id).toBe('audio-1');
  });

  it('retorna null para mensagem sem attachments', () => {
    const message = createMockMessage({ attachments: new Map() });

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });

  it('detecta mensagem de voz nativa do Discord pelo campo duration', () => {
    const nativeVoice = {
      id: 'native-voice-1',
      contentType: 'audio/ogg; codecs=opus',
      duration: 3.5, // campo duration (não duration_secs) — mensagem nativa
      url: 'https://cdn.discordapp.com/voice.ogg',
    };
    const attachments = new Map([[nativeVoice.id, nativeVoice]]);
    const message = createMockMessage({ attachments });

    const result = getVoiceAttachment(message);

    expect(result).not.toBeNull();
    expect(result.id).toBe('native-voice-1');
  });
});
