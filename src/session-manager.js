// src/session-manager.js
// Gerencia múltiplas sessões OpenCode via HTTP/SSE (opencode serve)

// ─── Imports ──────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { stripAnsi, debug } from './utils.js';
import { ServerManager } from './server-manager.js';
import { PlanReviewDetector } from './plan-detector.js';
import { SESSION_TIMEOUT_MS, MAX_BUFFER } from './config.js';
import { saveSession, removeSession } from './persistence.js';

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
   * @param {string} [opts.model=''] - Modelo de IA a usar (vazio = padrão do opencode)
   */
  constructor({ sessionId, projectPath, threadId, userId, agent, model = '' }) {
    super();
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.threadId = threadId;
    this.userId = userId;
    this.agent = agent;
    this.model = model;
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
    /** @type {string[]} Fila de mensagens aguardando envio */
    this._messageQueue = [];
    /** @type {boolean} Indica se a fila está sendo drenada no momento */
    this._processingQueue = false;
    /** @type {boolean} Encaminha mensagens inline automaticamente ao agente */
    this.passthroughEnabled = true;
    /** ID da permissão aguardando aprovação interativa do usuário (null = nenhuma pendente) */
    this._pendingPermissionId = null;
    /** Dados completos da permissão aguardando resposta (null = nenhuma pendente) */
    this._pendingPermissionData = null;
    /** @type {Set<string>} Padrões de permissão liberados com "Permitir sempre" nesta sessão */
    this._allowedPatterns = new Set();
    /** @type {PlanReviewDetector|null} Detector de plano aguardando revisão (apenas para agent=plan) */
    this._planDetector = null;
    /** @type {Function|null} Referências nomeadas de listeners do servidor (para remoção no close) */
    this._onServerRestart = null;
    this._onServerFatal = null;
    this._onSSEReconnecting = null;
    this._onSSEConnected = null;
  }

  /**
   * Inicia a sessão obtendo ou criando um servidor para o projeto e
   * registrando uma sessão na API do OpenCode.
   * @param {ServerManager} serverManager
   */
  async start(serverManager) {
    this.status = 'idle';

    this.server = await serverManager.getOrCreate(this.projectPath);

    const apiSession = await this.server.client.createSession(
      this.model ? { model: this.model } : {}
    );
    this.apiSessionId = apiSession.id;

    this.server.registerSession(this.apiSessionId, this);

    // Inicia detecção de revisão de plano para sessões do agente plan
    if (this.agent === 'plan' && this.server.plannotatorBaseUrl) {
      this._planDetector = new PlanReviewDetector({
        plannotatorBaseUrl: this.server.plannotatorBaseUrl,
        sessionId: this.sessionId,
      });
      this._planDetector.on('plan-ready', (data) => this.emit('plan-ready', data));
      this._planDetector.on('plan-resolved', () => this.emit('plan-resolved'));
      this._planDetector.start();
    }

    debug('OpenCodeSession', '✅ Sessão API criada: %s (sessão interna: %s)', this.apiSessionId, this.sessionId);

    this.emit('status', 'idle');

    this._onServerRestart = () => {
      this.emit('server-restart');
    };

    this._onServerFatal = (err) => {
      this.status = 'error';
      this.emit('status', 'error');
      this.emit('error', new Error(`Servidor fatal: ${err?.message ?? err}`));
    };

    // Notifica a thread Discord sobre drops e reconexões SSE
    this._onSSEReconnecting = ({ isConnectionDrop }) => {
      if (!isConnectionDrop) return; // Só notifica para ECONNRESET, não drops normais
      if (!['running', 'waiting_input', 'idle'].includes(this.status)) return;
      this.emit('sse-status', 'reconnecting');
    };

    this._onSSEConnected = () => {
      // Verifica se a sessão ainda está registrada no servidor opencode
      const stillActive = this.server?._sessionRegistry?.has(this.apiSessionId)
        ?? this.server?.sessionRegistry?.has(this.apiSessionId)
        ?? true; // fallback permissivo se não encontrar o registry
      if (!stillActive) return;
      if (!['running', 'waiting_input', 'idle'].includes(this.status)) return;
      this.emit('sse-status', 'reconnected');
    };

    this.server.on('restart', this._onServerRestart);
    this.server.on('fatal', this._onServerFatal);
    this.server.on('sse-reconnecting', this._onSSEReconnecting);
    this.server.on('sse-connected', this._onSSEConnected);
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
   * Enfileira uma mensagem para envio quando a sessão estiver pronta.
   * Se a sessão estiver idle/waiting_input, envia imediatamente e retorna { queued: false, position: 0 }.
   * Se estiver running, enfileira para enviar quando ficar idle e retorna { queued: true, position }.
   * @param {string} text - Texto a enviar
   * @returns {Promise<{ queued: boolean, position: number }>}
   */
  async queueMessage(text) {
    if (this.status === 'finished' || this.status === 'error') {
      throw new Error('Sessão encerrada');
    }

    if (this.status === 'running') {
      // Sessão em execução — enfileira para enviar quando ficar idle
      const position = this._messageQueue.length + 1;
      this._messageQueue.push(text);
      this.emit('queue-change', this._messageQueue.length);
      debug('OpenCodeSession', '📮 Mensagem enfileirada (pos=%d, status=%s): "%s..."',
        position, this.status, text.slice(0, 50));
      return { queued: true, position };
    }

    // Sessão idle ou waiting_input — envia imediatamente via drain
    this._messageQueue.push(text);
    this.emit('queue-change', this._messageQueue.length);
    debug('OpenCodeSession', '📨 Enviando mensagem imediatamente (status=%s): "%s..."',
      this.status, text.slice(0, 50));
    await this._drainMessageQueue();
    return { queued: false, position: 0 };
  }

  /**
   * Retorna o número de mensagens atualmente na fila de espera.
   * @returns {number}
   */
  getQueueSize() {
    return this._messageQueue.length;
  }

  /**
   * Drena a fila de mensagens pendentes, enviando uma por vez.
   * Retorna imediatamente se a fila já está sendo processada ou se a sessão
   * está em execução (aguardando o agente terminar).
   * Em estados terminais (finished/error), abandona as mensagens restantes e emite 'queue-abandoned'.
   * @private
   */
  async _drainMessageQueue() {
    if (this._processingQueue) return;
    if (this.status === 'running') return;

    // Estado terminal — abandona mensagens enfileiradas imediatamente
    if (this.status === 'finished' || this.status === 'error') {
      if (this._messageQueue.length > 0) {
        const count = this._messageQueue.length;
        this._messageQueue = [];
        this.emit('queue-abandoned', count);
      }
      return;
    }

    if (this._messageQueue.length === 0) return;

    this._processingQueue = true;
    try {
      const isTerminal = () => this.status === 'finished' || this.status === 'error';
      while (this._messageQueue.length > 0 && this.status !== 'running' && !isTerminal()) {
        const text = this._messageQueue.shift();
        this.emit('queue-change', this._messageQueue.length);
        await this.sendMessage(text);
        // Pausa entre mensagens consecutivas para evitar spam
        if (this._messageQueue.length > 0 && this.status !== 'running' && !isTerminal()) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      // Saiu do loop com mensagens restantes em estado terminal — abandona
      if (this._messageQueue.length > 0 && isTerminal()) {
        const count = this._messageQueue.length;
        this._messageQueue = [];
        this.emit('queue-abandoned', count);
      }
    } finally {
      this._processingQueue = false;
    }
  }

  /**
   * Alterna o modo passthrough da sessão.
   * Quando ativo, mensagens inline do Discord são encaminhadas automaticamente ao agente.
   * @returns {boolean} Novo estado do passthrough
   */
  togglePassthrough() {
    this.passthroughEnabled = !this.passthroughEnabled;
    debug('OpenCodeSession', '🔀 Passthrough %s: %s', this.passthroughEnabled ? 'ativado' : 'desativado', this.sessionId);
    return this.passthroughEnabled;
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
    this._pendingPermissionId = null;
    this._pendingPermissionData = null;

    // Para o detector de plano se estiver ativo
    if (this._planDetector) {
      this._planDetector.stop();
      this._planDetector = null;
    }

    if (this.apiSessionId && this.server) {
      try {
        await this.server.client.deleteSession(this.apiSessionId);
      } catch (err) {
        console.error('[OpenCodeSession] ⚠️ Erro ao deletar sessão na API:', err.message);
      }
      this.server.deregisterSession(this.apiSessionId);
    }

    // Remove listeners do servidor para evitar vazamento de memória
    if (this.server) {
      if (this._onServerRestart) this.server.off('restart', this._onServerRestart);
      if (this._onServerFatal) this.server.off('fatal', this._onServerFatal);
      if (this._onSSEReconnecting) this.server.off('sse-reconnecting', this._onSSEReconnecting);
      if (this._onSSEConnected) this.server.off('sse-connected', this._onSSEConnected);
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
    // Qualquer evento SSE indica que a sessão está ativa — reset do timeout
    this.lastActivityAt = new Date();

    const type = event.type; // já desempacotado pelo server-manager para o tipo real
    const props = event.data?.properties ?? {};

    switch (type) {
      case 'message.part.delta': {
        const delta = props.delta ?? '';
        if (!delta) return;

        // Reasoning → emite evento separado para exibição sutil no Discord
        if (props.field === 'reasoning') {
          const clean = stripAnsi(delta);
          this.emit('reasoning', clean);
          return;
        }

        // Outros campos desconhecidos → ignora com log de debug
        if (props.field !== 'text') {
          debug('SessionManager', `[SSE] campo ignorado: field=${props.field}`);
          return;
        }

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
        // Apenas se não há pergunta pendente — evita deadlock de fila (Fix 1.1)
        if (this.status === 'waiting_input' && !this._pendingQuestion) {
          this.status = 'running';
          this.emit('status', 'running');
        } else if (this.status === 'waiting_input' && this._pendingQuestion) {
          debug('OpenCodeSession', '📝 Transição running suprimida — delta durante pergunta pendente (id=%s)', this._pendingQuestion.id);
        }

        this.emit('output', clean);
        break;
      }

      case 'session.status': {
        const statusType = props.status?.type;
        if (statusType === 'idle') {
          this._handleIdleTransition();
        }
        break;
      }

      case 'session.idle': {
        // Evento alternativo de conclusão
        this._handleIdleTransition();
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

        // Extrai padrões de diretório/arquivo se disponíveis
        const patterns =
          props.patterns ??
          props.permission?.patterns ??
          (props.pattern ? [props.pattern] : []);

        const directory =
          props.directory ??
          props.path ??
          props.permission?.directory ??
          null;

        debug('OpenCodeSession', '🔐 Permissão solicitada — id=%s tool=%s patterns=%O props=%O', permissionId, toolName, patterns, props);

        if (!permissionId) {
          console.error('[OpenCodeSession] ⚠️  Evento permission.asked sem ID. Evento completo:', JSON.stringify(event, null, 2));
          this.emit('permission', { status: 'unknown', toolName, description, error: 'ID não encontrado no evento' });
          break;
        }

        const permData = { permissionId, toolName, description, patterns, directory };

        // Verifica se o padrão já foi liberado com "Permitir sempre"
        if (this.isPatternAllowed(permData)) {
          debug('OpenCodeSession', '🔓 Padrão em cache — auto-aprovando permissão %s', permissionId);
          this.server.client.approvePermission(this.apiSessionId, permissionId).catch((err) => {
            console.error('[OpenCodeSession] ⚠️ Erro ao auto-aprovar permissão em cache:', err.message);
          });
          this.emit('permission', { ...permData, status: 'auto_approved' });
          break;
        }

        // Armazena dados da permissão e notifica o Discord para exibir botões interativos
        this._pendingPermissionId = permissionId;
        this._pendingPermissionData = permData;
        this.emit('permission', { ...permData, status: 'requested' });
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
        // Drena mensagens enfileiradas durante a janela running→waiting_input (Fix 1.2)
        this._drainMessageQueue().catch((err) => {
          console.error('[OpenCodeSession:%s] ⚠️ Erro ao drenar fila após pergunta (status=%s, queue=%d): %s',
            this.sessionId.slice(0, 8), this.status, this._messageQueue.length, err.message);
        });
        break;
      }

      default:
        debug('OpenCodeSession', '⚠️ Evento SSE não tratado — tipo=%s props=%s', type, JSON.stringify(props).slice(0, 200));
        break;
    }
  }

  /**
   * Centraliza a lógica de transição de estado ao receber sinal idle do servidor.
   * Determina se a sessão deve ir para `waiting_input` ou `finished`.
   * Após a transição, drena a fila de mensagens pendentes.
   * @private
   */
  _handleIdleTransition() {
    debug('OpenCodeSession', '🔄 Transição idle: status=%s queue=%d pendingQuestion=%s recentOutput=%s',
      this.status,
      this._messageQueue.length,
      !!this._pendingQuestion,
      JSON.stringify(this._recentOutput.slice(-100))
    );
    if (this.status === 'running') {
      // Agente concluiu — verifica se está aguardando input
      if (isWaitingForInput(this._recentOutput)) {
        this.status = 'waiting_input';
        this.emit('status', 'waiting_input');
      } else {
        this.status = 'idle';
        this.emit('status', 'finished');
      }
      // Sessão saiu de `running` — processa mensagens enfileiradas
      this._drainMessageQueue().catch((err) => {
        console.error('[OpenCodeSession:%s] ⚠️ Erro ao drenar fila pós-idle (status=%s, queue=%d): %s',
          this.sessionId.slice(0, 8), this.status, this._messageQueue.length, err.message);
      });
      // Reseta o detector de plano para um novo ciclo (caso o agente tenha produzido novo plano)
      if (this._planDetector) {
        this._planDetector.reset();
        this._planDetector.start(); // reinicia polling caso tenha parado após resolução anterior
      }
    } else if (this.status === 'waiting_input') {
      // Servidor sinalizou idle novamente — sessão realmente concluída
      this.status = 'idle';
      this.emit('status', 'finished');
      // Sessão saiu de `waiting_input` — processa mensagens enfileiradas
      this._drainMessageQueue().catch((err) => {
        console.error('[OpenCodeSession:%s] ⚠️ Erro ao drenar fila pós-waiting_input (status=%s, queue=%d): %s',
          this.sessionId.slice(0, 8), this.status, this._messageQueue.length, err.message);
      });
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
   * Gera uma chave de cache para o padrão de permissão.
   * @param {string} toolName
   * @param {string[]} patterns
   * @param {string|null} directory
   * @returns {string}
   * @private
   */
  _buildPatternKey(toolName, patterns, directory) {
    const patternStr = Array.isArray(patterns) && patterns.length > 0
      ? patterns.map(p => String(p)).sort().join('|')
      : '';
    return `${toolName}:${directory ?? ''}:${patternStr}`;
  }

  /**
   * Verifica se este padrão de permissão já foi liberado com "Permitir sempre".
   * @param {{ toolName: string, patterns: string[], directory: string|null }} permData
   * @returns {boolean}
   */
  isPatternAllowed(permData) {
    const key = this._buildPatternKey(permData.toolName, permData.patterns, permData.directory);
    return this._allowedPatterns.has(key);
  }

  /**
   * Adiciona um padrão ao cache de "sempre permitir" para esta sessão.
   * @param {{ toolName: string, patterns: string[], directory: string|null }} permData
   */
  addAllowedPattern(permData) {
    const key = this._buildPatternKey(permData.toolName, permData.patterns, permData.directory);
    this._allowedPatterns.add(key);
    debug('OpenCodeSession', '🔓 Padrão adicionado ao cache "sempre permitir": %s', key);
  }

  /**
   * Sinaliza que a permissão pendente foi resolvida (aprovada, sempre permitida ou rejeitada).
   * Emite 'permission-resolved' para que o StreamHandler cancele o timer de auto-aprovação.
   */
  resolvePermission() {
    this._pendingPermissionId = null;
    this._pendingPermissionData = null;
    this.emit('permission-resolved');
  }

  /**
   * Notifica o stream handler que a revisão de plano foi resolvida via Discord.
   * Impede que o evento `plan-resolved` (disparado quando o plannotator fecha)
   * sobrescreva a mensagem já atualizada pelo handler do botão.
   */
  notifyPlanReviewResolved() {
    this.emit('plan-review-resolved');
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
    /** Contador total de sessões criadas desde o início do processo */
    this.totalCreated = 0;

    // Verificação periódica de sessões expiradas
    if (SESSION_TIMEOUT_MS > 0) {
      this._timeoutTimer = setInterval(() => {
        this._checkTimeouts().catch((err) => {
          console.error('[SessionManager] ⚠️ Erro em _checkTimeouts:', err.message);
        });
      }, TIMEOUT_CHECK_INTERVAL);
    }
  }

  /**
   * Cria uma nova sessão para um projeto e a registra nos índices internos.
   * @param {object} opts
   * @param {string} opts.projectPath - Caminho absoluto do projeto
   * @param {string} opts.threadId - ID da thread Discord
   * @param {string} opts.userId - ID do usuário Discord
   * @param {'plan'|'build'} opts.agent - Agente a ser utilizado
   * @param {string} [opts.model=''] - Modelo de IA a usar (vazio = padrão do opencode)
   * @returns {Promise<OpenCodeSession>}
   */
  async create({ projectPath, threadId, userId, agent, model = '' }) {
    const sessionId = randomUUID();
    const session = new OpenCodeSession({ sessionId, projectPath, threadId, userId, agent, model });

    this._sessions.set(sessionId, session);
    this._threadIndex.set(threadId, sessionId);
    this.totalCreated += 1;

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

    // Persistir metadados da sessão em disco para sobreviver a reinicializações
    saveSession({
      sessionId: session.sessionId,
      threadId: session.threadId,
      projectPath: session.projectPath,
      userId: session.userId,
      agent: session.agent,
      status: 'active',
      createdAt: new Date().toISOString(),
    }).catch(err => console.error('[SessionManager] Erro ao persistir sessão:', err));

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
  async _checkTimeouts() {
    const now = Date.now();
    const toExpire = [];

    for (const session of this._sessions.values()) {
      if (session.status === 'finished' || session.status === 'error') continue;
      // Para sessões aguardando input do usuário, usar timeout duplo
      const effectiveTimeout = session.status === 'waiting_input' ? SESSION_TIMEOUT_MS * 2 : SESSION_TIMEOUT_MS;
      const inactiveMs = now - session.lastActivityAt.getTime();
      if (inactiveMs > effectiveTimeout) {
        console.log('[SessionManager] ⏰ Sessão expirada por inatividade: %s (%dmin)', session.sessionId, Math.round(inactiveMs / 60_000));
        toExpire.push(session);
      }
    }

    for (const session of toExpire) {
      session.emit('timeout');
      await this._expireSession(session);
    }

    // Aviso de fila possivelmente presa (sessão running inativa > 60s com mensagens na fila)
    for (const session of this._sessions.values()) {
      if (session._messageQueue.length > 0 && session.status === 'running') {
        const idleMs = Date.now() - session.lastActivityAt.getTime();
        if (idleMs > 60_000) {
          console.warn('[SessionManager] ⚠️ Fila possivelmente presa — sessão=%s status=%s queue=%d inativa=%ds',
            session.sessionId.slice(0, 8), session.status, session._messageQueue.length, Math.round(idleMs / 1000));
        }
      }
    }
  }

  /**
   * Encerra uma sessão expirada por timeout e remove dos índices internos.
   * Garante que o close() seja aguardado antes da remoção.
   * @param {OpenCodeSession} session
   * @private
   */
  async _expireSession(session) {
    await session.close().catch((err) => {
      console.error('[SessionManager] ⚠️ Erro ao encerrar sessão expirada %s:', session.sessionId, err.message);
    });
    removeSession(session.sessionId).catch(err =>
      console.error('[SessionManager] Erro ao remover sessão expirada da persistência:', err)
    );
    // Deleções abaixo são intencionalmente redundantes com o listener 'close' registrado em create().
    // São no-ops seguros caso o listener já tenha executado primeiro.
    this._sessions.delete(session.sessionId);
    this._threadIndex.delete(session.threadId);
  }

  /**
   * Encerra e remove imediatamente uma sessão pelos índices internos.
   * @param {string} sessionId
   */
  async destroy(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    await session.close();

    // Deleções abaixo são intencionalmente redundantes com o listener 'close' registrado em create().
    // São no-ops seguros caso o listener já tenha executado primeiro.
    this._sessions.delete(sessionId);
    this._threadIndex.delete(session.threadId);

    // Remover sessão do arquivo de persistência em disco
    removeSession(sessionId).catch(err => console.error('[SessionManager] Erro ao remover sessão persistida:', err));

    console.log('[SessionManager] 🗑️ Sessão destruída: %s', sessionId);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { OpenCodeSession, SessionManager, isWaitingForInput };
