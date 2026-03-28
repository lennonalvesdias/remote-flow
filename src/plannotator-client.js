// src/plannotator-client.js
// Cliente HTTP para a API local do plannotator
// Permite aprovar/rejeitar planos programaticamente em paralelo com o browser

import { debug } from './utils.js';

// ─── Constantes ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

// ─── Cliente ────────────────────────────────────────────────────────────────

/**
 * Cliente HTTP para a API local do @plannotator/opencode.
 * O plannotator expõe um servidor HTTP por sessão de review, permitindo
 * aprovação/rejeição programática em paralelo com o browser.
 */
export class PlannotatorClient {
  /**
   * @param {string} baseUrl - URL base do servidor plannotator (ex: http://localhost:5100)
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  // ─── API pública ──────────────────────────────────────────────────────────

  /**
   * Verifica se há um plano aguardando revisão.
   * Retorna null se o servidor não estiver no ar (plannotator ainda não iniciou).
   * @returns {Promise<object|null>}
   */
  async getPlan() {
    try {
      const data = await this._fetch('GET', '/api/plan');
      return data ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Aprova o plano atual. Pode especificar agentSwitch para transição automática.
   * @param {{ feedback?: string, agentSwitch?: string }} [opts]
   * @returns {Promise<void>}
   */
  async approve({ feedback = '', agentSwitch = 'build' } = {}) {
    await this._fetch('POST', '/api/approve', { feedback, agentSwitch, approved: true });
  }

  /**
   * Rejeita o plano atual com feedback. O agente irá revisar o plano.
   * @param {{ feedback: string }} opts
   * @returns {Promise<void>}
   */
  async deny({ feedback }) {
    await this._fetch('POST', '/api/deny', { feedback, approved: false });
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  /**
   * Executa uma requisição HTTP com timeout e retry.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<any>}
   */
  async _fetch(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const opts = {
          method,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        };
        if (body !== undefined) {
          opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} — ${method} ${path}`);
        }

        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;
      }
    }

    debug('PlannotatorClient', '⚠️ %s %s — falhou após %d tentativa(s): %s', method, path, MAX_RETRIES + 1, lastError.message);
    throw lastError;
  }
}
