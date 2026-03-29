// tests/transcription-provider.test.js
// Testes para transcription-provider — abstração de múltiplos backends de transcrição

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─── Mock de FormData e Blob globais ──────────────────────────────────────────

class MockFormData {
  constructor() { this._entries = []; }
  append(name, value, filename) { this._entries.push({ name, value, filename }); }
  getEntries() { return this._entries; }
}

class MockBlob {
  constructor(parts) { this.parts = parts; }
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

// ─── Provider local ───────────────────────────────────────────────────────────

describe('provider local', () => {
  let provider;
  let mockTranscribeAudio;
  let mockCheckWhisperHealth;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    mockTranscribeAudio = vi.fn();
    mockCheckWhisperHealth = vi.fn();

    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'local',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));

    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: mockTranscribeAudio,
      checkWhisperHealth: mockCheckWhisperHealth,
    }));

    const mod = await import('../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcribe() delega para transcribeAudio do whisper-client', async () => {
    const expected = { text: 'Olá mundo', language: 'pt', duration: 1.5 };
    mockTranscribeAudio.mockResolvedValue(expected);

    const result = await provider.transcribe(Buffer.from('audio'));

    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.anything(), 'voice.ogg');
    expect(result).toEqual(expected);
  });

  it('checkHealth() delega para checkWhisperHealth do whisper-client', async () => {
    mockCheckWhisperHealth.mockResolvedValue(true);

    const result = await provider.checkHealth();

    expect(mockCheckWhisperHealth).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('name retorna "local"', () => {
    expect(provider.name).toBe('local');
  });
});

// ─── Provider openai ──────────────────────────────────────────────────────────

describe('provider openai', () => {
  let provider;
  let mockFetch;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'openai',
      TRANSCRIPTION_API_KEY: 'sk-test-key',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));

    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const mod = await import('../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcribe() chama https://api.openai.com/v1/audio/transcriptions', async () => {
    mockFetch.mockResolvedValue(mockResponse({ text: 'Olá', duration: 1.5 }));

    await provider.transcribe(Buffer.from('audio'));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('transcribe() lança erro descritivo quando API retorna 401', async () => {
    mockFetch.mockResolvedValue(mockResponse('Unauthorized', 401));

    await expect(provider.transcribe(Buffer.from('audio'))).rejects.toThrow('401');
  });

  it('checkHealth() retorna true quando TRANSCRIPTION_API_KEY está configurada', async () => {
    const result = await provider.checkHealth();

    expect(result).toBe(true);
  });

  it('name retorna "openai"', () => {
    expect(provider.name).toBe('openai');
  });

  it('transcribe() lança erro descritivo quando TRANSCRIPTION_API_KEY está vazia', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'openai',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));
    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const { provider: p } = await import('../src/transcription-provider.js');

    await expect(p.transcribe(Buffer.from('audio'))).rejects.toThrow('TRANSCRIPTION_API_KEY');
  });

  it('checkHealth() retorna false quando TRANSCRIPTION_API_KEY está vazia', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'openai',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));
    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const { provider: p } = await import('../src/transcription-provider.js');

    const result = await p.checkHealth();

    expect(result).toBe(false);
  });
});

// ─── Provider groq ────────────────────────────────────────────────────────────

describe('provider groq', () => {
  let provider;
  let mockFetch;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('FormData', MockFormData);
    vi.stubGlobal('Blob', MockBlob);

    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'groq',
      TRANSCRIPTION_API_KEY: 'gsk-test-key',
      TRANSCRIPTION_API_MODEL: 'whisper-large-v3',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));

    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const mod = await import('../src/transcription-provider.js');
    provider = mod.provider;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcribe() chama https://api.groq.com/openai/v1/audio/transcriptions', async () => {
    mockFetch.mockResolvedValue(mockResponse({ text: 'Olá' }));

    await provider.transcribe(Buffer.from('audio'));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('transcribe() lança erro descritivo quando TRANSCRIPTION_API_KEY está vazia', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'groq',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-large-v3',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));
    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    const { provider: p } = await import('../src/transcription-provider.js');

    await expect(p.transcribe(Buffer.from('audio'))).rejects.toThrow('TRANSCRIPTION_API_KEY');
  });

  it('checkHealth() retorna true quando TRANSCRIPTION_API_KEY está configurada', async () => {
    const result = await provider.checkHealth();

    expect(result).toBe(true);
  });

  it('name retorna "groq"', () => {
    expect(provider.name).toBe('groq');
  });

  it('transcribe() lança erro descritivo quando Groq retorna HTTP 500', async () => {
    mockFetch.mockResolvedValue(mockResponse('Internal Server Error', 500));

    await expect(provider.transcribe(Buffer.from('audio'))).rejects.toThrow('Groq retornou 500');
  });
});

// ─── Provider desconhecido ────────────────────────────────────────────────────

describe('provider desconhecido', () => {
  it('lança erro ao carregar com TRANSCRIPTION_PROVIDER inválido', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      TRANSCRIPTION_PROVIDER: 'invalid-provider',
      TRANSCRIPTION_API_KEY: '',
      TRANSCRIPTION_API_MODEL: 'whisper-1',
      WHISPER_LANGUAGE: 'pt',
      WHISPER_URL: 'http://127.0.0.1:8765',
    }));
    vi.doMock('../src/whisper-client.js', () => ({
      transcribeAudio: vi.fn(),
      checkWhisperHealth: vi.fn(),
    }));

    await expect(import('../src/transcription-provider.js')).rejects.toThrow('Provider desconhecido');
  });
});
