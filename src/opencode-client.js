// src/opencode-client.js
// Cliente HTTP para a API REST do opencode

// ─── Imports ──────────────────────────────────────────────────────────────────

import { debug } from './utils.js';
import { parseSSEStream } from './sse-parser.js';
import { DEFAULT_TIMEOUT_MS } from './config.js';

// ─── Classe principal ─────────────────────────────────────────────────────────

/**
 * Cliente HTTP fino para a API REST do opencode.
 * Encapsula chamadas `fetch()` e expõe métodos de alto nível para gerenciar sessões.
 */
export class OpenCodeClient {
  /**
   * @param {string} baseUrl - URL base da API (ex: 'http://127.0.0.1:4100')
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  // ─── Métodos HTTP ───────────────────────────────────────────────────────────

  /**
   * Cria uma nova sessão na API do opencode.
   * @returns {Promise<{ id: string }>} Objeto de sessão contendo o campo `id`
   */
  async createSession() {
    const response = await this._fetch('/session', { method: 'POST', body: '{}' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`POST /session falhou: ${response.status} ${body}`);
    }
    return response.json();
  }

  /**
   * Envia uma mensagem assíncrona para uma sessão existente.
   * @param {string} apiSessionId - ID da sessão na API
   * @param {string} agent - Nome do agente (ex: 'primary')
   * @param {string} text - Texto da mensagem a enviar
   * @returns {Promise<void>}
   */
  async sendMessage(apiSessionId, agent, text) {
    const path = `/session/${apiSessionId}/prompt_async`;
    const body = JSON.stringify({ agent, parts: [{ type: 'text', text }] });
    const response = await this._fetch(path, { method: 'POST', body });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`POST ${path} falhou: ${response.status} ${bodyText}`);
    }
  }

  /**
   * Aborta uma sessão em execução.
   * @param {string} apiSessionId - ID da sessão na API
   * @returns {Promise<void>}
   */
  async abortSession(apiSessionId) {
    const path = `/session/${apiSessionId}/abort`;
    const response = await this._fetch(path, { method: 'POST', body: '{}' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`POST ${path} falhou: ${response.status} ${body}`);
    }
  }

  /**
   * Remove uma sessão da API.
   * @param {string} apiSessionId - ID da sessão na API
   * @returns {Promise<void>}
   */
  async deleteSession(apiSessionId) {
    const path = `/session/${apiSessionId}`;
    const response = await this._fetch(path, { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DELETE ${path} falhou: ${response.status} ${body}`);
    }
  }

  /**
   * Aprova uma permissão pendente em uma sessão.
   * @param {string} apiSessionId - ID da sessão na API
   * @param {string} permissionId - ID da permissão a aprovar
   * @returns {Promise<void>}
   */
  async approvePermission(apiSessionId, permissionId) {
    const path = `/session/${apiSessionId}/permissions/${permissionId}`;
    const response = await this._fetch(path, { method: 'POST', body: '{}' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`POST ${path} falhou: ${response.status} ${body}`);
    }
  }

  // ─── SSE ────────────────────────────────────────────────────────────────────

  /**
   * Conecta ao stream de eventos SSE da API e processa eventos em tempo real.
   * Chamada de longa duração — não aplica timeout automático.
   * @param {AbortSignal} signal - Sinal para cancelar a conexão SSE
   * @param {(event: { type: string, data: unknown, id?: string }) => void} onEvent - Callback por evento
   * @param {(err: Error) => void} [onError] - Callback opcional para erros de stream
   * @returns {Promise<void>}
   */
  async connectSSE(signal, onEvent, onError) {
    const response = await this._fetch('/event', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET /event falhou: ${response.status} ${body}`);
    }
    return parseSSEStream(response, onEvent, onError);
  }

  /**
   * Método interno para executar requisições HTTP com configuração padrão.
   * Usa `AbortSignal.timeout` de 10 s a menos que `options.signal` já esteja definido.
   * @param {string} path - Caminho da rota (sem o baseUrl)
   * @param {RequestInit} [options={}] - Opções para o `fetch()`
   * @returns {Promise<Response>}
   */
  async _fetch(path, options = {}) {
    const method = options.method ?? 'GET';
    debug('OpenCodeClient', `Requisição: ${method} ${path}`);

    const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal,
    });
  }
}
