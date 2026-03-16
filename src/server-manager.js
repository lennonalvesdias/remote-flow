// src/server-manager.js
// Gerencia processos `opencode serve` por projeto e roteamento de eventos SSE

// ─── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { OpenCodeClient } from './opencode-client.js';
import { debug } from './utils.js';
import { OPENCODE_BIN, OPENCODE_BASE_PORT } from './config.js';

/**
 * Tipos SSE que nunca carregam sessionID em properties.sessionID
 * ou que nunca são tratados por handleSSEEvent — suprimir do log de diagnóstico
 */
const IGNORED_TYPES = new Set([
  'session.created',
  'session.updated',
  'session.diff',
  'message.updated',
  'message.part.updated',
  'file.watcher.updated',
  'server.heartbeat',
  'server.connected',
]);

/**
 * Whitelist de variáveis de ambiente seguras para repassar ao child process.
 * Evita vazar DISCORD_TOKEN e outras credenciais do bot.
 */
const ENV_ALLOWLIST = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|OPENCODE_|ANTHROPIC_|XDG_|LANG|LC_|TERM|SHELL|USER|LOGNAME|HOSTNAME|SystemRoot|SYSTEMROOT|windir|COMSPEC|ProgramFiles|ProgramData|CommonProgramFiles|NUMBER_OF_PROCESSORS|PROCESSOR_|OS)$/i;

function sanitizeEnvForChild() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ENV_ALLOWLIST.test(key))
  );
}

// ─── OpenCodeServer ───────────────────────────────────────────────────────────

/**
 * Representa um processo `opencode serve` vinculado a um caminho de projeto.
 * Emite: 'ready', 'restart', 'fatal'
 */
class OpenCodeServer extends EventEmitter {
  /**
   * @param {string} projectPath - Caminho absoluto do projeto
   * @param {number} port - Porta TCP alocada para este servidor
   */
  constructor(projectPath, port) {
    super();
    this.projectPath = projectPath;
    this.port = port;
    this.status = 'starting';
    this.process = null;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.client = new OpenCodeClient(this.baseUrl);
    this.sseAbortController = null;
    this.restartCount = 0;

    /** @type {Map<string, object>} Map<apiSessionId, OpenCodeSession> */
    this._sessionRegistry = new Map();

    this._initReadyPromise();
  }

  /**
   * Inicializa (ou reinicializa) a promise de prontidão do servidor
   * @private
   */
  _initReadyPromise() {
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
  }

  /**
   * Inicia o processo `opencode serve` e aguarda até que esteja pronto.
   * @returns {Promise<void>} Resolve quando o servidor estiver aceitando conexões
   */
  start() {
    const child = spawn(
      OPENCODE_BIN,
      ['serve', '--port', String(this.port)],
      {
        cwd: this.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: {
          ...sanitizeEnvForChild(),
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
        },
      }
    );

    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // ── Detecção de prontidão via stdout ──────────────────────────────────────
    let lineBuffer = '';
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // guarda linha incompleta

      for (const line of lines) {
        if (this.status !== 'ready' && line.includes('listening on http://')) {
          this.status = 'ready';
          console.log('[OpenCodeServer] 🟢 Servidor pronto — porta %d', this.port);
          this._readyResolve();
          this.connectSSE();
          this.emit('ready');
        }
      }
    });

    child.stderr.on('data', (chunk) => {
    });

    // ── Tratamento de encerramento / reinicialização ───────────────────────────
    child.on('close', (code) => {
      if (this.status === 'stopped') return;

      if (this.restartCount < 3) {
        this.restartCount++;
        console.warn(
          '[OpenCodeServer] ⚠️  Processo encerrou (code=%d) — reiniciando (%d/3) | porta %d',
          code,
          this.restartCount,
          this.port
        );
        this.emit('restart', { restartCount: this.restartCount, projectPath: this.projectPath });

        this.status = 'starting';
        this._initReadyPromise();

        setTimeout(() => this.start(), 2000);
      } else {
        this.status = 'error';
        console.error(
          '[OpenCodeServer] 💀 Processo falhou %d vezes — abandonando | porta %d',
          this.restartCount,
          this.port
        );
        this.emit('fatal', new Error(`OpenCodeServer falhou após ${this.restartCount} tentativas em ${this.projectPath}`));
        this._readyReject(new Error(`OpenCodeServer falhou após ${this.restartCount} tentativas`));
      }
    });

    return this._readyPromise;
  }

  /**
   * Estabelece a conexão SSE com o servidor para receber eventos em tempo real.
   * Reconecta automaticamente com backoff exponencial em caso de falha.
   * @param {number} [attempt=0] - Tentativa atual de reconexão
   */
  connectSSE(attempt = 0) {
    this.sseAbortController = new AbortController();

    const reconnect = (err) => {
      if (this.status === 'stopped') return;
      if (err?.name === 'AbortError') return;

      const maxDelay = 30_000;
      const delay = Math.min(1000 * Math.pow(2, attempt), maxDelay);

      debug('OpenCodeServer', '🔄 SSE desconectado (tentativa %d) — reconectando em %dms: %s', attempt + 1, delay, err?.message ?? 'stream encerrado');
      this.emit('sse-reconnecting', { attempt: attempt + 1, delay });

      setTimeout(() => {
        if (this.status !== 'stopped') {
          this.connectSSE(attempt + 1);
        }
      }, delay);
    };

    // Fire-and-forget — a promise roda em background
    this.client.connectSSE(
      this.sseAbortController.signal,
      (event) => {
        attempt = 0; // Reset do backoff ao receber evento com sucesso
        this._dispatchSSEEvent(event);
      },
      reconnect,
    ).then(() => {
      // Stream encerrou normalmente — reconectar
      reconnect();
    }).catch(reconnect);

    debug('OpenCodeServer', '🔌 SSE conectado na porta %d', this.port);
  }

  /**
   * Roteia um evento SSE recebido para a sessão registrada correspondente.
   * @param {{ type: string, data: object, id?: string }} event - Evento SSE parseado
   * @private
   */
  _dispatchSSEEvent(event) {
    // Usa event.data.type como tipo real quando o transporte SSE usa "message" como envelope
    const actualType = event.data?.type ?? event.type;

    // Extrai sessionId seguindo a estrutura real da API (capital D em sessionID)
    const sessionId =
      event.data?.properties?.sessionID ??
      event.data?.properties?.sessionId ??
      event.data?.sessionID ??
      event.data?.sessionId;

    if (!sessionId) {
      if (!IGNORED_TYPES.has(actualType)) {
        debug(
          'OpenCodeServer',
          'Evento SSE sem sessionId (tipo=%s): %s',
          actualType,
          JSON.stringify(event.data).slice(0, 200)
        );
      }
      return;
    }

    const session = this._sessionRegistry.get(sessionId);

    if (session) {
      session.handleSSEEvent({ ...event, type: actualType });
      return;
    }

    // Sub-sessões internas do opencode (ex: tool calls) não são registradas — ignorar silenciosamente
    return;
  }

  /**
   * Registra uma sessão para receber eventos SSE deste servidor.
   * @param {string} apiSessionId - ID da sessão retornado pela API do opencode
   * @param {object} session - Instância de OpenCodeSession
   */
  registerSession(apiSessionId, session) {
    this._sessionRegistry.set(apiSessionId, session);
  }

  /**
   * Remove o registro de uma sessão SSE.
   * @param {string} apiSessionId - ID da sessão a ser removida
   */
  deregisterSession(apiSessionId) {
    this._sessionRegistry.delete(apiSessionId);
  }

  /**
   * Para o processo do servidor de forma intencional.
   */
  stop() {
    this.status = 'stopped';

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }

    if (this.process) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        try {
          process.kill(-this.process.pid, 'SIGTERM');
        } catch {
          this.process.kill('SIGTERM');
        }
      }
    }

    console.log('[OpenCodeServer] 🔴 Servidor parado — porta %d', this.port);
  }

  /**
   * Retorna a promise que resolve quando o servidor estiver pronto.
   * @returns {Promise<void>}
   */
  awaitReady() {
    return this._readyPromise;
  }
}

// ─── ServerManager ────────────────────────────────────────────────────────────

/**
 * Gerencia múltiplas instâncias de OpenCodeServer, uma por caminho de projeto.
 * Aloca portas automaticamente a partir de OPENCODE_BASE_PORT.
 */
class ServerManager {
  constructor() {
    /** @type {Map<string, OpenCodeServer>} Map<projectPath, OpenCodeServer> */
    this._servers = new Map();

    /** @type {Set<number>} */
    this._usedPorts = new Set();

    this._nextPort = OPENCODE_BASE_PORT;
  }

  /**
   * Aloca a próxima porta disponível.
   * @returns {number}
   * @private
   */
  _allocatePort() {
    while (this._usedPorts.has(this._nextPort)) {
      this._nextPort++;
    }
    const port = this._nextPort;
    this._usedPorts.add(port);
    this._nextPort++;
    return port;
  }

  /**
   * Retorna o servidor existente para o projeto ou cria e inicia um novo.
   * @param {string} projectPath - Caminho absoluto do projeto
   * @returns {Promise<OpenCodeServer>}
   */
  async getOrCreate(projectPath) {
    const existing = this._servers.get(projectPath);

    if (existing) {
      if (existing.status === 'ready') return existing;
      if (existing.status === 'starting') {
        await existing.awaitReady();
        return existing;
      }
      // status === 'error' ou 'stopped' — cria novo servidor abaixo
    }

    const server = new OpenCodeServer(projectPath, this._allocatePort());

    server.on('restart', ({ restartCount }) => {
      console.warn(
        '[ServerManager] ⚠️  Servidor reiniciando (%d/3) | projeto: %s',
        restartCount,
        projectPath
      );
    });

    server.on('fatal', () => {
      console.error(
        '[ServerManager] 💀 Servidor entrou em estado fatal | projeto: %s',
        projectPath
      );
    });

    this._servers.set(projectPath, server);
    await server.start();
    return server;
  }

  /**
   * Para todos os servidores gerenciados e limpa o estado interno.
   * @returns {Promise<void>}
   */
  async stopAll() {
    for (const server of this._servers.values()) {
      server.stop();
    }
    this._servers.clear();
    this._usedPorts.clear();
    console.log('[ServerManager] 🔴 Todos os servidores parados');
  }

  /**
   * Retorna o servidor associado ao caminho de projeto, ou null se não existir.
   * @param {string} projectPath
   * @returns {OpenCodeServer | null}
   */
  getServer(projectPath) {
    return this._servers.get(projectPath) ?? null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { OpenCodeServer, ServerManager };
