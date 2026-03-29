// src/voice-utils.js
// Utilitários para detecção e processamento de mensagens de voz

// ─── Detecção de anexos de áudio ──────────────────────────────────────────────

/** Tipos MIME de áudio aceitos para transcrição */
const AUDIO_MIME_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4']);

/**
 * Retorna o primeiro attachment que é uma mensagem de voz do Discord.
 * Voice messages nativas têm `duration` definida; também aceita áudio por MIME type.
 *
 * @param {import('discord.js').Message} message
 * @returns {import('discord.js').Attachment | null}
 */
export function getVoiceAttachment(message) {
  if (!message.attachments || message.attachments.size === 0) return null;
  for (const attachment of message.attachments.values()) {
    if (attachment.duration != null) return attachment;
    // Normaliza o Content-Type removendo parâmetros opcionais (ex: "audio/ogg; codecs=opus" → "audio/ogg")
    const baseContentType = (attachment.contentType ?? '').split(';')[0].trim();
    if (AUDIO_MIME_TYPES.has(baseContentType)) return attachment;
  }
  return null;
}
