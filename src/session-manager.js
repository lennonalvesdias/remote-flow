// src/session-manager.js
// Gerencia múltiplas sessões OpenCode via HTTP/SSE (opencode serve)

// ─── Imports ──────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { stripAnsi, debug } from './utils.js';
import { ServerManager } from './server-manager.js';
import { SESSION_TIMEOUT_MS, MAX_BUFFER } from './config.js';

/** Intervalo de verificação de timeout (1 min) */
const TIMEOUT_CHECK_INTERVAL = 60_000;

// ─── Detecção de input aguardado ──────────────────────────────────────────────

/** Padrões que indicam que o agente está aguardando input do usuário */
const INPUT_PATTERNS = [
  /\?\s*$/m,            // Linha termina com ?
  /\(y\/n\)/i,          // (y/n)
  /\(s\/n\)/i,          // (s/n) — sim/não em PT-BR
  /\(yes\/no\)/i,       // (yes/no)
  /\(sim\/não\)/i,      // (sim/não)
  /escolha:/i,          // escolha:
  /selecione:/i,        // selecione:
  /confirma(?!r)/i,     // confirma (mas não "confirmar")
  /digite:/i,           // digite:
  /informe:/i,          // informe:
  /press\s+enter/i,     // press enter
  /pressione\s+enter/i, // pressione enter
  /^\s*>\s*$/m,         // Prompt > sozinho na linha
  /^\s*\d+[).]\s+\S/m,  // Opções numeradas no início da linha: "1) algo" ou "1. algo"
];

/**
 * Detecta heuristicamente se o output do agente indica que ele está
 * aguardando uma resposta do usuário.
 * @param {string} text - Output recente do agente (últimos ~500 chars)
 * @returns {boolean}
 */
function isWaitingForInput(text) {
  if (!text || !text.trim()) return false;
  const tail = text.slice(-500);
  return INPUT_PATTERNS.some((p) => p.test(tail));
}

// ─── OpenCodeSession ──────────────────────────────────────────────────────────

/**
 * Representa uma sessão OpenCode ativa ligada a uma thread Discord.
 * Comunica-se com o servidor OpenCode via HTTP/SSE.
 */
class OpenCodeSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId - Identificador UUID interno (chave do thread Discord)
   * @param {string} opts.projectPath - Caminho absoluto do projeto
   * @param {string} opts.threadId - ID da thread Discord associada
   * @param {string} opts.userId - ID do usuário Discord que iniciou a sessão
   * @param {'plan'|'build'} opts.agent - Agente a ser utilizado
   */
  constructor({ sessionId, projectPath, threadId, userId, agent }) {
    super();
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.threadId = threadId;
    this.userId = userId;
    this.agent = agent;
    this.status = 'idle';
    this.apiSessionId = null;
    this.server = null;
    this.outputBuffer = '';
    this.pendingOutput = '';
    this._recentOutput = '';
    this._pendingQuestion = null;
    this.createdAt = new Date();
    this.lastActivityAt = new Date();
    this.closedAt = null;
    this._pendingTimeouts = [];
  }

  /**
   * Inicia a sessão obtendo ou criando um servidor para o projeto e
   * registrando uma sessão na API do OpenCode.
   * @param {ServerManager} serverManager
   */
  async start(serverManager) {
    this.status = 'idle';

    this.server = await serverManager.getOrCreate(this.projectPath);

    const apiSession = await this.server.client.createSession();
    this.apiSessionId = apiSession.id;

    this.server.registerSession(this.apiSessionId, this);

    debug('OpenCodeSession', '✅ Sessão API criada: %s (sessão interna: %s)', this.apiSessionId, this.sessionId);

    this.emit('status', 'idle');

    this.server.on('restart', () => {
      this.emit('server-restart');
    });

    this.server.on('fatal', (err) => {
      this.status = 'error';
      this.emit('status', 'error');
      this.emit('error', new Error(`Servidor fatal: ${err?.message ?? err}`));
    });
  }

  /**
   * Envia uma mensagem de texto para o agente OpenCode.
   * @param {string} text - Mensagem a ser enviada
   */
  async sendMessage(text) {
    if (this.status === 'finished' || this.status === 'error') {
      throw new Error('Sessão encerrada');
    }

    this._pendingQuestion = null;
    this._recentOutput = '';
    this.status = 'running';
    this.lastActivityAt = new Date();
    this.emit('status', 'running');

    await this.server.client.sendMessage(this.apiSessionId, this.agent, text);

    debug('OpenCodeSession', '📨 Mensagem enviada: %s...', text.slice(0, 50));
  }

  /**
   * Aborta a execução atual da sessão.
   */
  async abort() {
    if (!this.apiSessionId) return;

    await this.server.client.abortSession(this.apiSessionId);

    debug('OpenCodeSession', '🛑 Sessão abortada: %s', this.apiSessionId);
  }

  /**
   * Encerra a sessão, remove o registro no servidor e emite os eventos finais.
   */
  async close() {
    // Cancela timeouts de retry de permissão pendentes
    for (const tid of this._pendingTimeouts) {
      clearTimeout(tid);
    }
    this._pendingTimeouts = [];

    if (this.apiSessionId && this.server) {
      try {
        await this.server.client.deleteSession(this.apiSessionId);
      } catch (err) {
        console.error('[OpenCodeSession] ⚠️ Erro ao deletar sessão na API:', err.message);
      }
      this.server.deregisterSession(this.apiSessionId);
    }

    this.status = 'finished';
    this.closedAt = new Date();
    this.emit('status', 'finished');
    this.emit('close');

    console.log('[OpenCodeSession] ✅ Sessão encerrada: %s', this.sessionId);
  }

  /**
   * Processa um evento SSE despachado pelo OpenCodeServer.
   * @param {{ type: string, data: object, id?: string }} event
   */
  handleSSEEvent(event) {
    const type = event.type; // já desempacotado pelo server-manager para o tipo real
    const props = event.data?.properties ?? {};

    switch (type) {
      case 'message.part.delta': {
        // Só processar deltas de texto (não reasoning)
        if (props.field !== 'text') return;
        const delta = props.delta ?? '';
        if (!delta) return;

        const clean = stripAnsi(delta);
        this.outputBuffer += clean;
        this.pendingOutput += clean;
        this._recentOutput += clean;
        if (this._recentOutput.length > 2000) {
          this._recentOutput = this._recentOutput.slice(-1000);
        }
        this.lastActivityAt = new Date();

        if (this.outputBuffer.length > MAX_BUFFER) {
          this.outputBuffer = this.outputBuffer.slice(-MAX_BUFFER);
        }

        // Se o agente voltou a emitir output enquanto aguardávamos input, retorna a running
        if (this.status === 'waiting_input') {
          this.status = 'running';
          this.emit('status', 'running');
        }

        this.emit('output', clean);
        break;
      }

      case 'session.status': {
        const statusType = props.status?.type;
        if (statusType === 'idle') {
          if (this.status === 'running') {
            // Agente concluiu — verifica se está aguardando input
            if (isWaitingForInput(this._recentOutput)) {
              this.status = 'waiting_input';
              this.emit('status', 'waiting_input');
            } else {
              this.status = 'idle';
              this.emit('status', 'finished');
            }
          } else if (this.status === 'waiting_input') {
            // Servidor sinalizou idle novamente — sessão realmente concluída
            this.status = 'idle';
            this.emit('status', 'finished');
          }
        }
        break;
      }

      case 'session.idle': {
        // Evento alternativo de conclusão
        if (this.status === 'running') {
          if (isWaitingForInput(this._recentOutput)) {
            this.status = 'waiting_input';
            this.emit('status', 'waiting_input');
          } else {
            this.status = 'idle';
            this.emit('status', 'finished');
          }
        } else if (this.status === 'waiting_input') {
          // Servidor sinalizou idle novamente — sessão realmente concluída
          this.status = 'idle';
          this.emit('status', 'finished');
        }
        break;
      }

      case 'session.error': {
        this.status = 'error';
        this.emit('status', 'error');
        this.emit('error', new Error(props.error ?? props.message ?? 'Erro desconhecido na sessão'));
        break;
      }

      case 'permission.asked': {
        // Tenta extrair o ID da permissão de múltiplos caminhos possíveis
        const permissionId =
          props.id ??
          props.permissionId ??
          props.permission?.id ??
          event.data?.id;

        // Extrai metadados úteis para exibir no Discord
        const toolName =
          props.toolName ??
          props.tool?.name ??
          props.permission?.toolName ??
          props.title ??
          'ferramenta desconhecida';

        const description =
          props.description ??
          props.permission?.description ??
          props.title ??
          null;

        debug('OpenCodeSession', '🔐 Permissão solicitada — id=%s tool=%s props=%O', permissionId, toolName, props);

        if (!permissionId) {
          console.error('[OpenCodeSession] ⚠️  Evento permission.asked sem ID. Evento completo:', JSON.stringify(event, null, 2));
          this.emit('permission', { status: 'unknown', toolName, description, error: 'ID não encontrado no evento' });
          break;
        }

        // Notifica o Discord antes de tentar aprovar
        this.emit('permission', { status: 'approving', permissionId, toolName, description });

        // Tenta aprovar com retry (até 3 tentativas)
        const tryApprove = async (attempt = 1) => {
          try {
            await this.server.client.approvePermission(this.apiSessionId, permissionId);
            debug('OpenCodeSession', '✅ Permissão aprovada: %s (tentativa %d)', permissionId, attempt);
            this.emit('permission', { status: 'approved', permissionId, toolName, description });
          } catch (err) {
            console.error(`[OpenCodeSession] ❌ Erro ao aprovar permissão (tentativa ${attempt}):`, err.message);
            if (attempt < 3) {
              const tid = setTimeout(() => {
                const idx = this._pendingTimeouts.indexOf(tid);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                tryApprove(attempt + 1);
              }, 1000 * attempt);
              this._pendingTimeouts.push(tid);
            } else {
              console.error('[OpenCodeSession] ❌ Falha definitiva ao aprovar permissão:', permissionId);
              this.emit('permission', { status: 'failed', permissionId, toolName, description, error: err.message });
            }
          }
        };

        tryApprove();
        break;
      }

      case 'session.diff': {
        // Diff de alterações em arquivos feitas pelo agente
        const diffs = props.diffs ?? props.diff ?? event.data?.diffs ?? [];
        const diffList = Array.isArray(diffs) ? diffs : [diffs];

        for (const diff of diffList) {
          if (!diff) continue;
          const filePath = diff.path ?? diff.file ?? diff.filename ?? 'arquivo desconhecido';
          const content = diff.content ?? diff.patch ?? diff.diff ?? '';
          if (content) {
            this.lastActivityAt = new Date();
            this.emit('diff', { path: filePath, content });
          }
        }
        break;
      }

      case 'question.asked': {
        const questionId =
          props.id ??
          props.questionId ??
          event.data?.id;

        const questions = Array.isArray(props.questions)
          ? props.questions
          : props.question
            ? [{ question: props.question }]
            : [];

        debug('OpenCodeSession', '❓ Pergunta recebida — id=%s qtd=%d', questionId, questions.length);

        this._pendingQuestion = { id: questionId, questions };
        this.status = 'waiting_input';
        this.lastActivityAt = new Date();
        this.emit('status', 'waiting_input');
        this.emit('question', { questionId, questions });
        break;
      }

      default:
        debug('OpenCodeSession', '⚠️ Evento SSE não tratado — tipo=%s props=%s', type, JSON.stringify(props).slice(0, 200));
        break;
    }
  }

  /**
   * Consome e limpa o buffer de output pendente.
   * @returns {string}
   */
  flushPending() {
    const out = this.pendingOutput;
    this.pendingOutput = '';
    if (out) this.lastActivityAt = new Date();
    return out;
  }

  /**
   * Retorna um resumo serializado da sessão.
   * @returns {object}
   */
  toSummary() {
    return {
      sessionId: this.sessionId,
      projectPath: this.projectPath,
      threadId: this.threadId,
      userId: this.userId,
      agent: this.agent,
      status: this.status,
      apiSessionId: this.apiSessionId,
      createdAt: this.createdAt,
      closedAt: this.closedAt,
      project: basename(this.projectPath),
      lastActivityAt: this.closedAt ?? this.lastActivityAt,
    };
  }
}

// ─── SessionManager ───────────────────────────────────────────────────────────

/**
 * Gerencia todas as sessões OpenCode ativas, indexadas por sessionId e threadId.
 */
class SessionManager {
  /**
   * @param {ServerManager} serverManager - Instância do gerenciador de servidores
   */
  constructor(serverManager) {
    this.serverManager = serverManager;
    /** @type {Map<string, OpenCodeSession>} */
    this._sessions = new Map();
    /** @type {Map<string, string>} */
    this._threadIndex = new Map();

    // Verificação periódica de sessões expiradas
    if (SESSION_TIMEOUT_MS > 0) {
      this._timeoutTimer = setInterval(() => this._checkTimeouts(), TIMEOUT_CHECK_INTERVAL);
    }
  }

  /**
   * Cria uma nova sessão para um projeto e a registra nos índices internos.
   * @param {object} opts
   * @param {string} opts.projectPath - Caminho absoluto do projeto
   * @param {string} opts.threadId - ID da thread Discord
   * @param {string} opts.userId - ID do usuário Discord
   * @param {'plan'|'build'} opts.agent - Agente a ser utilizado
   * @returns {Promise<OpenCodeSession>}
   */
  async create({ projectPath, threadId, userId, agent }) {
    const sessionId = randomUUID();
    const session = new OpenCodeSession({ sessionId, projectPath, threadId, userId, agent });

    this._sessions.set(sessionId, session);
    this._threadIndex.set(threadId, sessionId);

    session.once('close', () => {
      // Remove do índice de threads imediatamente para evitar duplicação
      this._threadIndex.delete(threadId);
      // Mantém a sessão no cache por 10 min para consultas de status
      setTimeout(() => {
        this._sessions.delete(sessionId);
        debug('SessionManager', '🗑️ Sessão removida do cache: %s', sessionId);
      }, 10 * 60 * 1000);
    });

    console.log('[SessionManager] ✅ Sessão criada: %s (projeto: %s)', sessionId, projectPath);

    await session.start(this.serverManager);

    return session;
  }

  /**
   * Busca sessão pelo ID da thread Discord.
   * @param {string} threadId
   * @returns {OpenCodeSession | undefined}
   */
  getByThread(threadId) {
    const id = this._threadIndex.get(threadId);
    return this._sessions.get(id);
  }

  /**
   * Busca sessão pelo seu identificador interno.
   * @param {string} sessionId
   * @returns {OpenCodeSession | undefined}
   */
  getById(sessionId) {
    return this._sessions.get(sessionId);
  }

  /**
   * Lista todas as sessões pertencentes a um usuário.
   * @param {string} userId
   * @returns {OpenCodeSession[]}
   */
  getByUser(userId) {
    return [...this._sessions.values()].filter((s) => s.userId === userId);
  }

  /**
   * Retorna a primeira sessão ativa (não encerrada) para o caminho do projeto.
   * @param {string} projectPath
   * @returns {OpenCodeSession | undefined}
   */
  getByProject(projectPath) {
    return [...this._sessions.values()].find(
      (s) => s.projectPath === projectPath && s.status !== 'finished' && s.status !== 'error',
    );
  }

  /**
   * Retorna todas as sessões registradas.
   * @returns {OpenCodeSession[]}
   */
  getAll() {
    return [...this._sessions.values()];
  }

  /**
   * Verifica e encerra sessões que excederam o tempo de inatividade.
   * @private
   */
  _checkTimeouts() {
    const now = Date.now();
    for (const session of this._sessions.values()) {
      if (session.status === 'finished' || session.status === 'error') continue;
      // Para sessões aguardando input do usuário, usar timeout duplo
      const effectiveTimeout = session.status === 'waiting_input' ? SESSION_TIMEOUT_MS * 2 : SESSION_TIMEOUT_MS;
      const inactiveMs = now - session.lastActivityAt.getTime();
      if (inactiveMs > effectiveTimeout) {
        console.log('[SessionManager] ⏰ Sessão expirada por inatividade: %s (%dmin)', session.sessionId, Math.round(inactiveMs / 60_000));
        session.emit('timeout');
        session.close();
        this._sessions.delete(session.sessionId);
        this._threadIndex.delete(session.threadId);
      }
    }
  }

  /**
   * Encerra e remove imediatamente uma sessão pelos índices internos.
   * @param {string} sessionId
   */
  async destroy(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    await session.close();

    this._sessions.delete(sessionId);
    this._threadIndex.delete(session.threadId);

    console.log('[SessionManager] 🗑️ Sessão destruída: %s', sessionId);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { OpenCodeSession, SessionManager, isWaitingForInput };
