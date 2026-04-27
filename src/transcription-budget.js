// src/transcription-budget.js
// Controle de orçamento diário para chamadas a APIs externas de transcrição.
// O contador reseta automaticamente à meia-noite (hora local).
// Somente aplicável a providers externos (openai, groq) — provider local é gratuito.

import { TRANSCRIPTION_PROVIDER } from './config.js';

/** Limite diário em segundos de áudio (0 = sem limite) */
export const TRANSCRIPTION_DAILY_LIMIT_SECS = parseInt(
  process.env.TRANSCRIPTION_DAILY_LIMIT_SECS || '0',
  10,
);

// ─── Estado interno ───────────────────────────────────────────────────────────

let _usedSecs = 0;
let _resetDate = new Date().toDateString();

function _maybeReset() {
  const today = new Date().toDateString();
  if (today !== _resetDate) {
    _usedSecs = 0;
    _resetDate = today;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Verifica se a duração estimada cabe no orçamento diário restante.
 * Lança um erro se o limite seria excedido.
 * Operações com provider local nunca são bloqueadas.
 *
 * @param {number} estimatedSecs - Duração estimada do áudio (segundos)
 * @throws {Error} Quando o orçamento diário seria excedido
 */
export function checkBudget(estimatedSecs) {
  if (TRANSCRIPTION_PROVIDER === 'local') return;
  if (TRANSCRIPTION_DAILY_LIMIT_SECS <= 0) return;
  _maybeReset();
  if (_usedSecs + estimatedSecs > TRANSCRIPTION_DAILY_LIMIT_SECS) {
    const remaining = Math.max(0, TRANSCRIPTION_DAILY_LIMIT_SECS - _usedSecs);
    throw new Error(
      `Orçamento diário de transcrição atingido (${_usedSecs}s usados de ${TRANSCRIPTION_DAILY_LIMIT_SECS}s). ` +
      `Restante: ${remaining}s. Redefine à meia-noite.`,
    );
  }
}

/**
 * Registra o uso real após uma transcrição bem-sucedida.
 * @param {number} actualSecs - Duração real do áudio transcrito (segundos)
 */
export function recordUsage(actualSecs) {
  if (TRANSCRIPTION_PROVIDER === 'local') return;
  _maybeReset();
  _usedSecs += actualSecs;
}

/**
 * Retorna o status atual do orçamento de transcrição.
 * @returns {{ usedSecs: number, limitSecs: number, provider: string }}
 */
export function getBudgetStatus() {
  _maybeReset();
  return {
    usedSecs: _usedSecs,
    limitSecs: TRANSCRIPTION_DAILY_LIMIT_SECS,
    provider: TRANSCRIPTION_PROVIDER,
  };
}

/**
 * Reseta o estado interno (usado exclusivamente em testes).
 * @internal
 */
export function _resetBudget() {
  _usedSecs = 0;
  _resetDate = new Date().toDateString();
}
