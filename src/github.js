// src/github.js
// Cliente GitHub — wrapper sobre Octokit para operações de PR, review e issues

import { Octokit, RequestError } from 'octokit';
import { GITHUB_TOKEN } from './config.js';

// ─── Singleton ────────────────────────────────────────────────────────────────

/** @type {GitHubClient|null} */
let _instance = null;

/**
 * Retorna a instância singleton do GitHubClient.
 * Emite warning no console se GITHUB_TOKEN não estiver configurado.
 * @returns {GitHubClient}
 */
export function getGitHubClient() {
  if (!_instance) {
    if (!GITHUB_TOKEN) {
      console.warn('[GitHub] ⚠️ GITHUB_TOKEN não configurado — comandos GitHub estarão indisponíveis.');
    }
    _instance = new GitHubClient(GITHUB_TOKEN);
  }
  return _instance;
}

// ─── Cliente ──────────────────────────────────────────────────────────────────

/**
 * Cliente GitHub com métodos focados em PRs, reviews e issues.
 */
export class GitHubClient {
  /**
   * @param {string} token - Personal Access Token do GitHub
   */
  constructor(token) {
    this._token = token;
    this._octokit = new Octokit({
      auth: token || undefined,
      userAgent: 'remote-flow/1.0.0',
    });
  }

  /**
   * Verifica se o token está configurado e válido.
   * @returns {Promise<{ login: string }>}
   * @throws {Error} Se token ausente ou inválido
   */
  async verifyAuth() {
    if (!this._token) {
      throw new Error('GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
    }
    try {
      const { data } = await this._octokit.rest.users.getAuthenticated();
      return { login: data.login };
    } catch (err) {
      throw _wrapError(err, 'verificar autenticação');
    }
  }

  // ─── Pull Requests ──────────────────────────────────────────────────────────

  /**
   * Cria um Pull Request no repositório.
   * @param {object} opts
   * @param {string} opts.owner - Dono do repositório
   * @param {string} opts.repo - Nome do repositório
   * @param {string} opts.head - Branch de origem
   * @param {string} opts.base - Branch de destino
   * @param {string} opts.title - Título do PR
   * @param {string} [opts.body] - Descrição do PR (Markdown)
   * @param {boolean} [opts.draft] - Se verdadeiro, cria como rascunho
   * @returns {Promise<object>} Dados do PR criado
   */
  async createPullRequest({ owner, repo, head, base, title, body = '', draft = false }) {
    try {
      const { data } = await this._octokit.rest.pulls.create({
        owner, repo, head, base, title, body, draft,
        maintainer_can_modify: true,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, 'criar Pull Request');
    }
  }

  /**
   * Lista Pull Requests do repositório.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {'open'|'closed'|'all'} [opts.state] - Estado dos PRs (padrão: 'open')
   * @param {number} [opts.perPage] - Resultados por página (padrão: 20)
   * @returns {Promise<object[]>} Lista de PRs
   */
  async listPullRequests({ owner, repo, state = 'open', perPage = 20 }) {
    try {
      const { data } = await this._octokit.rest.pulls.list({
        owner, repo, state,
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, 'listar Pull Requests');
    }
  }

  /**
   * Obtém detalhes de um Pull Request específico.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {number} opts.number - Número do PR
   * @returns {Promise<object>} Dados do PR
   */
  async getPullRequest({ owner, repo, number }) {
    try {
      const { data } = await this._octokit.rest.pulls.get({
        owner, repo, pull_number: number,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, `obter PR #${number}`);
    }
  }

  /**
   * Obtém o diff unificado de um Pull Request como string.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {number} opts.number - Número do PR
   * @returns {Promise<string>} Diff unificado
   */
  async getPullRequestDiff({ owner, repo, number }) {
    try {
      const { data } = await this._octokit.rest.pulls.get({
        owner, repo, pull_number: number,
        mediaType: { format: 'diff' },
      });
      // Octokit retorna o diff como string quando mediaType.format = 'diff'
      return String(data);
    } catch (err) {
      throw _wrapError(err, `obter diff do PR #${number}`);
    }
  }

  /**
   * Lista arquivos alterados em um Pull Request.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {number} opts.number - Número do PR
   * @returns {Promise<object[]>} Lista de arquivos com status, additions, deletions, patch
   */
  async getPullRequestFiles({ owner, repo, number }) {
    try {
      const { data } = await this._octokit.rest.pulls.listFiles({
        owner, repo, pull_number: number, per_page: 100,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, `listar arquivos do PR #${number}`);
    }
  }

  /**
   * Cria um review em um Pull Request.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {number} opts.number - Número do PR
   * @param {string} opts.commitId - SHA do commit head do PR
   * @param {string} opts.body - Corpo do review (resumo geral)
   * @param {'APPROVE'|'REQUEST_CHANGES'|'COMMENT'} opts.event - Tipo do review
   * @param {Array<{path:string,line:number,side:string,body:string}>} [opts.comments] - Comentários inline
   * @returns {Promise<object>} Dados do review criado
   */
  async createReview({ owner, repo, number, commitId, body, event = 'COMMENT', comments = [] }) {
    try {
      const { data } = await this._octokit.rest.pulls.createReview({
        owner, repo, pull_number: number,
        commit_id: commitId,
        body, event, comments,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, `criar review no PR #${number}`);
    }
  }

  // ─── Issues ─────────────────────────────────────────────────────────────────

  /**
   * Obtém detalhes de uma issue específica.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {number} opts.number - Número da issue
   * @returns {Promise<object>} Dados da issue
   */
  async getIssue({ owner, repo, number }) {
    try {
      const { data } = await this._octokit.rest.issues.get({
        owner, repo, issue_number: number,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, `obter issue #${number}`);
    }
  }

  /**
   * Cria uma nova issue no repositório.
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {string} opts.title - Título da issue
   * @param {string} [opts.body] - Corpo da issue (Markdown)
   * @param {string[]} [opts.labels] - Labels a aplicar
   * @returns {Promise<object>} Dados da issue criada
   */
  async createIssue({ owner, repo, title, body = '', labels = [] }) {
    try {
      const { data } = await this._octokit.rest.issues.create({
        owner, repo, title, body, labels,
      });
      return data;
    } catch (err) {
      throw _wrapError(err, 'criar issue');
    }
  }

  /**
   * Lista issues abertas do repositório (exclui PRs).
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {'open'|'closed'|'all'} [opts.state] - Estado das issues (padrão: 'open')
   * @param {string} [opts.labels] - Labels para filtrar (separadas por vírgula)
   * @param {number} [opts.perPage] - Resultados por página (padrão: 20)
   * @returns {Promise<object[]>} Lista de issues (sem PRs)
   */
  async listIssues({ owner, repo, state = 'open', labels = '', perPage = 20 }) {
    try {
      const { data } = await this._octokit.rest.issues.listForRepo({
        owner, repo, state,
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        ...(labels ? { labels } : {}),
      });
      // A API do GitHub retorna PRs junto com issues — filtrar apenas issues puras
      return data.filter((item) => !item.pull_request);
    } catch (err) {
      throw _wrapError(err, 'listar issues');
    }
  }
}

// ─── Utilitários internos ─────────────────────────────────────────────────────

/**
 * Converte erros da API GitHub em mensagens amigáveis.
 * @param {unknown} err - Erro capturado
 * @param {string} context - Descrição da operação para contexto
 * @returns {Error}
 */
function _wrapError(err, context) {
  if (err instanceof RequestError) {
    const msg = _friendlyHttpError(err.status, err.message);
    return new Error(`[GitHub] Erro ao ${context}: ${msg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Transforma códigos HTTP em mensagens amigáveis em PT-BR.
 * @param {number} status - Código HTTP
 * @param {string} fallback - Mensagem padrão
 * @returns {string}
 */
function _friendlyHttpError(status, fallback) {
  const messages = {
    401: 'Token inválido ou expirado. Verifique GITHUB_TOKEN.',
    403: 'Sem permissão. Verifique os escopos do token (necessário: repo).',
    404: 'Repositório ou recurso não encontrado.',
    422: 'Dados inválidos enviados à API (branch pode já existir ou PR duplicado).',
    429: 'Rate limit da API GitHub atingido. Tente novamente em alguns minutos.',
  };
  return messages[status] || `HTTP ${status}: ${fallback}`;
}
