// src/log-utils.js
// Utilitários compartilhados de logging: redação de segredos.
// Importado por logger.js e audit.js para evitar duplicação.

// ─── Redação de segredos ──────────────────────────────────────────────────────

/** Cache lazy dos valores de segredos lidos do ambiente. */
let _secretValues = null;

/**
 * Retorna a lista de valores secretos a redigir nos logs.
 * Lazy-loaded para garantir que dotenv já carregou os valores ao importar.
 * @returns {string[]}
 */
export function getSecretValues() {
  if (_secretValues) return _secretValues;
  _secretValues = [
    process.env.DISCORD_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.TRANSCRIPTION_API_KEY,
  ].filter((v) => v && v.length > 8);
  return _secretValues;
}

/**
 * Substitui valores de segredos conhecidos por [REDACTED] na string fornecida.
 * @param {string} str
 * @returns {string}
 */
export function redactSecrets(str) {
  let result = String(str);
  for (const secret of getSecretValues()) {
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}

/**
 * Redigita segredos de um objeto serializado como JSON.
 * @param {object|null} obj
 * @returns {object|null}
 */
export function redactData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return JSON.parse(redactSecrets(JSON.stringify(obj)));
}

/**
 * Reseta o cache de segredos (usado exclusivamente em testes).
 * @internal
 */
export function _resetSecretValues() {
  _secretValues = null;
}
