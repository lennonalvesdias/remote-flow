// src/plan-detector.js
// Detecta quando o plannotator está aguardando revisão de plano e quando é resolvido externamente

import { EventEmitter } from 'events';
import { PlannotatorClient } from './plannotator-client.js';
import { PLAN_POLL_INTERVAL_MS } from './config.js';
import { debug } from './utils.js';

// ─── Detector ────────────────────────────────────────────────────────────────

/**
 * Monitora um servidor plannotator via polling para detectar:
 * - 'plan-ready'   → plano disponível para revisão
 * - 'plan-resolved' → plano resolvido externamente (ex: via browser)
 *
 * @extends EventEmitter
 */
export class PlanReviewDetector extends EventEmitter {
  /**
   * @param {{ plannotatorBaseUrl: string, sessionId: string, pollInterval?: number }} opts
   */
  constructor({ plannotatorBaseUrl, sessionId, pollInterval = PLAN_POLL_INTERVAL_MS }) {
    super();
    this.client = new PlannotatorClient(plannotatorBaseUrl);
    this.sessionId = sessionId;
    this.pollInterval = pollInterval;

    this._timer = null;
    this._active = false;
    this._planReady = false;   // true quando 'plan-ready' já foi emitido
    this._resolved = false;    // true quando o review foi resolvido
    this._consecutiveFailures = 0;    // contagem de falhas consecutivas (servidor inacessível)
    this._lastFailureLoggedAt = 0;    // timestamp do último log de falha (ms)
  }

  // ─── Ciclo de vida ────────────────────────────────────────────────────────

  /**
   * Inicia o polling. Idempotente — chamadas repetidas não criam loops duplos.
   */
  start() {
    if (this._active) return;
    this._active = true;
    debug('PlanDetector', '🔍 Polling iniciado — sessão=%s url=%s', this.sessionId, this.client.baseUrl);
    this._scheduleNext();
  }

  /**
   * Para o polling definitivamente.
   */
  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    debug('PlanDetector', '🛑 Polling encerrado — sessão=%s', this.sessionId);
  }

  /**
   * Reinicia o estado para um novo ciclo de revisão (após deny + novo plano).
   */
  reset() {
    this._planReady = false;
    this._resolved = false;
    this._consecutiveFailures = 0;
    this._lastFailureLoggedAt = 0;
    debug('PlanDetector', '🔄 Estado resetado para novo ciclo — sessão=%s', this.sessionId);
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  _scheduleNext() {
    if (!this._active) return;
    this._timer = setTimeout(() => this._poll(), this.pollInterval);
  }

  async _poll() {
    if (!this._active) return;

    try {
      const plan = await this.client.getPlan();

      if (plan !== null) {
        // Servidor acessível — reseta contadores de falha consecutiva
        this._consecutiveFailures = 0;
        this._lastFailureLoggedAt = 0;
      }

      if (plan !== null && !this._planReady && !this._resolved) {
        // Plannotator respondeu — plano aguardando review
        this._planReady = true;
        debug('PlanDetector', '📋 Plano pronto para revisão — sessão=%s', this.sessionId);
        this.emit('plan-ready', { plan });
      } else if (plan === null && this._planReady && !this._resolved) {
        // Plannotator parou de responder — review concluído externamente (browser)
        this._resolved = true;
        debug('PlanDetector', '✅ Plano resolvido externamente — sessão=%s', this.sessionId);
        this.emit('plan-resolved');
        this.stop();
        return;
      } else if (plan === null && !this._planReady) {
        // Servidor inacessível — suprime logs repetitivos (máx. 1 log a cada 30s)
        this._consecutiveFailures += 1;
        const now = Date.now();
        if (this._consecutiveFailures === 1 || (now - this._lastFailureLoggedAt) > 30_000) {
          debug('PlanDetector', '⚙️ Servidor inacessível (falha #%d) — sessão=%s', this._consecutiveFailures, this.sessionId);
          this._lastFailureLoggedAt = now;
        }
      }
    } catch (err) {
      // ECONNREFUSED e erros similares são esperados enquanto plannotator não iniciou
      debug('PlanDetector', '⚙️ Poll silenciado: %s', err.message);
    }

    this._scheduleNext();
  }
}
