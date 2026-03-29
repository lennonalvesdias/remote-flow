// tests/voice-message.test.js
// Testa a detecção de mensagens de voz e regras de filtragem

import { describe, it, expect } from 'vitest';
import { getVoiceAttachment } from '../src/voice-utils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cria um mock de Message do Discord com o Map de attachments preenchido.
 * @param {object[]} attachments
 * @returns {object}
 */
function makeMessage(attachments = []) {
  const map = new Map(attachments.map((a, i) => [String(i), a]));
  return { attachments: { size: map.size, values: () => map.values() } };
}

// ─── Suite principal ──────────────────────────────────────────────────────────

describe('getVoiceAttachment()', () => {
  it('retorna null quando message não tem attachments (propriedade nula)', () => {
    const message = { attachments: null };

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });

  it('retorna null quando Map está vazio (size = 0)', () => {
    const message = makeMessage([]);

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });

  it('retorna attachment quando tem duration (voice message nativa do Discord)', () => {
    const voiceAttachment = { duration: 3.5, contentType: 'audio/ogg', url: 'https://cdn.discord.com/voice.ogg' };
    const message = makeMessage([voiceAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(voiceAttachment);
  });

  it('aceita duration = 0 como válido (silêncio detectado)', () => {
    const voiceAttachment = { duration: 0, contentType: 'audio/ogg', url: 'https://cdn.discord.com/voice.ogg' };
    const message = makeMessage([voiceAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(voiceAttachment);
  });

  it('retorna null quando attachment não tem duration e não é áudio', () => {
    const imageAttachment = { duration: null, contentType: 'image/png', url: 'https://cdn.discord.com/image.png' };
    const message = makeMessage([imageAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });

  it('retorna attachment de áudio pelo content-type audio/ogg', () => {
    const audioAttachment = { duration: null, contentType: 'audio/ogg', url: 'https://cdn.discord.com/audio.ogg' };
    const message = makeMessage([audioAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(audioAttachment);
  });

  it('retorna attachment de áudio pelo content-type audio/mpeg', () => {
    const audioAttachment = { duration: null, contentType: 'audio/mpeg', url: 'https://cdn.discord.com/audio.mp3' };
    const message = makeMessage([audioAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(audioAttachment);
  });

  it('retorna attachment de áudio pelo content-type audio/webm', () => {
    const audioAttachment = { duration: null, contentType: 'audio/webm', url: 'https://cdn.discord.com/audio.webm' };
    const message = makeMessage([audioAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(audioAttachment);
  });

  it('prioriza attachment com duration sobre content-type (duration != null é suficiente)', () => {
    // Voice message nativa pode ter content-type não-padrão; duration é a verificação prioritária
    const voiceNative = { duration: 5.0, contentType: 'application/octet-stream', url: 'https://cdn.discord.com/voice' };
    const message = makeMessage([voiceNative]);

    const result = getVoiceAttachment(message);

    expect(result).toBe(voiceNative);
  });

  it('retorna null para attachment com content-type de imagem', () => {
    const imageAttachment = { duration: null, contentType: 'image/jpeg', url: 'https://cdn.discord.com/photo.jpg' };
    const message = makeMessage([imageAttachment]);

    const result = getVoiceAttachment(message);

    expect(result).toBeNull();
  });
});
