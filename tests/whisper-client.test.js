// tests/whisper-client.test.js
// Testes para whisper-client — cliente HTTP do Whisper Server local

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { transcribeAudio, checkWhisperHealth } from '../src/whisper-client.js';

// ─── Mock de config ────────────────────────────────────────────────────────────

vi.mock('../src/config.js', () => ({
  WHISPER_URL: 'http://127.0.0.1:8765',
  WHISPER_TRANSCRIPTION_TIMEOUT_MS: 120_000,
}));

// ─── Mock de FormData e Blob globais ──────────────────────────────────────────

class MockFormData {
  constructor() { this._entries = []; }
  append(name, value, filename) { this._entries.push({ name, value, filename }); }
  getEntries() { return this._entries; }
}

class MockBlob {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type ?? '';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cria um mock de Response do fetch com status e dados configuráveis.
 * @param {unknown} data
 * @param {number} [status=200]
 * @returns {object}
 */
function mockResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

// ─── Suite principal ──────────────────────────────────────────────────────────

describe('whisper-client', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── transcribeAudio ────────────────────────────────────────────────────────

  describe('transcribeAudio()', () => {
    it('envia POST para /transcribe com FormData', async () => {
      mockFetch.mockResolvedValue(mockResponse({ text: 'Olá', language: 'pt', duration: 1.5 }));

      await transcribeAudio(Buffer.from('audio data'));

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.body).toBeInstanceOf(MockFormData);
    });

    it('usa a URL correta baseada em WHISPER_URL do config', async () => {
      mockFetch.mockResolvedValue(mockResponse({ text: 'Olá', language: 'pt', duration: 1.5 }));

      await transcribeAudio(Buffer.from('audio data'));

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8765/transcribe');
    });

    it('retorna { text, language, duration } em caso de sucesso', async () => {
      const respData = { text: 'Texto transcrito', language: 'pt', duration: 2.3 };
      mockFetch.mockResolvedValue(mockResponse(respData));

      const result = await transcribeAudio(Buffer.from('audio data'));

      expect(result).toEqual(respData);
    });

    it('lança erro com status code quando servidor retorna 400', async () => {
      mockFetch.mockResolvedValue(mockResponse('Bad Request', 400));

      await expect(transcribeAudio(Buffer.from('audio data'))).rejects.toThrow('400');
    });

    it('lança erro com status code quando servidor retorna 500', async () => {
      mockFetch.mockResolvedValue(mockResponse('Internal Server Error', 500));

      await expect(transcribeAudio(Buffer.from('audio data'))).rejects.toThrow('500');
    });

    it('a mensagem de erro inclui o corpo da resposta', async () => {
      mockFetch.mockResolvedValue(mockResponse('Arquivo de áudio corrompido', 422));

      await expect(transcribeAudio(Buffer.from('audio data'))).rejects.toThrow('Arquivo de áudio corrompido');
    });

    it('lança erro quando audioBuffer está vazio', async () => {
      await expect(transcribeAudio(Buffer.alloc(0))).rejects.toThrow('audioBuffer deve ser um Buffer não-vazio');
    });

    it('lança erro quando audioBuffer é null', async () => {
      await expect(transcribeAudio(null)).rejects.toThrow('audioBuffer deve ser um Buffer não-vazio');
    });

    it('cria o Blob com type "audio/ogg" para garantir Content-Type correto no multipart', async () => {
      mockFetch.mockResolvedValue(mockResponse({ text: 'Olá', language: 'pt', duration: 1.5 }));

      await transcribeAudio(Buffer.from('audio data'));

      const [, options] = mockFetch.mock.calls[0];
      const formData = options.body;
      const entry = formData.getEntries().find((e) => e.name === 'audio');
      expect(entry).toBeDefined();
      expect(entry.value).toBeInstanceOf(MockBlob);
      expect(entry.value.type).toBe('audio/ogg');
    });
  });

  // ─── checkWhisperHealth ─────────────────────────────────────────────────────

  describe('checkWhisperHealth()', () => {
    it('retorna true quando servidor responde 200', async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: 'ok' }, 200));

      const result = await checkWhisperHealth();

      expect(result).toBe(true);
    });

    it('retorna false quando servidor responde 500', async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: 'error' }, 500));

      const result = await checkWhisperHealth();

      expect(result).toBe(false);
    });

    it('retorna false quando fetch lança exceção (rede indisponível)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await checkWhisperHealth();

      expect(result).toBe(false);
    });

    it('nunca lança exceção mesmo com erro de rede', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(checkWhisperHealth()).resolves.toBe(false);
    });
  });
});
