// src/server-manager.js
// Gerencia processos `opencode serve` por projeto e roteamento de eventos SSE

// ─── Imports ──────────────────────────────────────────────────────────────────

import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import { readFile } from 'fs';
import { OpenCodeClient } from './opencode-client.js';
import { debug } from './utils.js';
import {
  OPENCODE_BIN,
  OPENCODE_BASE_PORT,
  SERVER_RESTART_DELAY_MS,
  LOG_FILE_READ_DELAY_MS,
  SERVER_CIRCUIT_BREAKER_COOLDOWN_MS,
} from './config.js';

/**
 * Tipos SSE que nunca carregam sessionID em properties.sessionID
 * ou que nunca são tratados por handleSSEEvent — suprimir do log de diagnóstico
 */
const IGNORED_TYPES = new Set([
  'session.created',
  'session.updated',
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

/**
 * Verifica se uma porta TCP está disponível no sistema operacional.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
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
   * @param {(() => Promise<number>) | null} [portAllocator] - Callback assíncrono para obter nova porta em retentativas
   */
  constructor(projectPath, port, portAllocator) {
    super();
    this.projectPath = projectPath;
    this.port = port;
    this.status = 'starting';
    this.process = null;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.client = new OpenCodeClient(this.baseUrl);
    this.sseAbortController = null;
    this.restartCount = 0;
    this._portAllocator = portAllocator ?? null;
    this._circuitBreakerUntil = 0;

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
    this._spawnProcess();
    return this._readyPromise;
  }

  /**
   * Realiza o spawn do processo. Usado por start() e pelas retentativas internas.
   * @private
   */
  _spawnProcess() {
    // No Windows, .cmd precisa ser executado via cmd.exe /c (sem shell:true para evitar DEP0190)
    const isWindows = process.platform === 'win32';
    const executable = isWindows ? 'cmd.exe' : OPENCODE_BIN;
    const spawnArgs  = isWindows
      ? ['/c', OPENCODE_BIN, 'serve', '--port', String(this.port)]
      : ['serve', '--port', String(this.port)];

    const child = spawn(
      executable,
      spawnArgs,
      {
        cwd: this.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
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
      const text = chunk.toString().trim();
      console.error('[OpenCodeServer] ⚠️  stderr: %s', text);

      // Tenta extrair caminho do arquivo de log para diagnóstico melhorado
      const logMatch = text.match(/check log file at (.+\.log)/i);
      if (logMatch) {
        const logPath = logMatch[1].trim();
        setTimeout(() => {
          readFile(logPath, 'utf8', (err, content) => {
            if (!err && content) {
              const lastLines = content.trim().split('\n').slice(-15).join('\n');
              console.error('[OpenCodeServer] 📋 Conteúdo do log opencode (%s):\n%s', logPath, lastLines);
            }
          });
        }, LOG_FILE_READ_DELAY_MS);
      }
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
        // NÃO recria a promise — reutiliza a mesma para que getOrCreate() receba o resultado correto
        const doRestart = async () => {
          if (this.status === 'stopped') return;
          if (this._portAllocator) {
            try {
              const newPort = await this._portAllocator();
              if (newPort !== this.port) {
                console.log('[OpenCodeServer] 🔀 Trocando porta %d → %d na retentativa', this.port, newPort);
                this.port = newPort;
                this.baseUrl = `http://127.0.0.1:${newPort}`;
                this.client = new OpenCodeClient(this.baseUrl);
              }
            } catch (portErr) {
              console.warn('[OpenCodeServer] ⚠️ Falha ao alocar nova porta, mantendo porta atual: %s', portErr.message);
            }
          }
          this._spawnProcess();
        };
        setTimeout(() => doRestart().catch((err) => {
          console.error('[OpenCodeServer] ❌ Erro fatal durante restart:', err);
          this.status = 'error';
          this._readyReject(err);
        }), SERVER_RESTART_DELAY_MS);
      } else {
        this.status = 'error';
        this._circuitBreakerUntil = Date.now() + SERVER_CIRCUIT_BREAKER_COOLDOWN_MS;
        console.warn('[OpenCodeServer] ⚡ Circuit breaker ativado. Cooldown até:', new Date(this._circuitBreakerUntil).toISOString());
        console.error(
          '[OpenCodeServer] 💀 Processo falhou %d vezes — abandonando | porta %d',
          this.restartCount,
          this.port
        );
        const fatalErr = new Error(`OpenCodeServer falhou após ${this.restartCount} tentativas em ${this.projectPath}`);
        this.emit('fatal', fatalErr);
        // Rejeita a promise original que getOrCreate() está aguardando
        this._readyReject(fatalErr);
      }
    });
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
      // Stream encerrou normalmente — reconectar apenas se não foi parada intencional
      if (this.status !== 'stopped') reconnect();
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
      try {
        session.handleSSEEvent({ ...event, type: actualType });
      } catch (err) {
        console.error('[OpenCodeServer] ❌ Erro ao processar evento SSE (sessionId=%s):', sessionId, err.message);
        session.emit('error', err);
      }
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

    /** @type {Promise<number> | null} Mutex para serializar chamadas concorrentes a _allocatePort */
    this._allocating = null;

    this._binValidated = false;
  }

  /**
   * Valida (uma única vez) que o binário opencode existe e é executável.
   * Lança um erro descritivo se não encontrado, para falhar rápido antes de tentar o spawn.
   * @private
   */
  _validateBin() {
    if (this._binValidated) return;
    try {
      execSync(`"${OPENCODE_BIN}" --version`, { stdio: 'ignore', timeout: 5000 });
      this._binValidated = true;
    } catch {
      throw new Error(`[ServerManager] ❌ Binário opencode não encontrado ou não executável: "${OPENCODE_BIN}". Verifique OPENCODE_BIN no .env.`);
    }
  }

  /**
   * Aloca a próxima porta disponível, verificando disponibilidade real no SO.
   * Serializa chamadas concorrentes para evitar alocação de portas duplicadas.
   * @returns {Promise<number>}
   * @private
   */
  async _allocatePort() {
    // Serializa chamadas concorrentes para evitar condição de corrida
    if (this._allocating) {
      await this._allocating;
      return this._allocatePort();
    }
    this._allocating = this._doAllocatePort();
    try {
      return await this._allocating;
    } finally {
      this._allocating = null;
    }
  }

  /**
   * Implementação interna da alocação de porta.
   * @returns {Promise<number>}
   * @private
   */
  async _doAllocatePort() {
    let port = this._nextPort;
    while (this._usedPorts.has(port) || !(await isPortAvailable(port))) {
      port++;
    }
    this._usedPorts.add(port);
    this._nextPort = port + 1;
    return port;
  }

  /**
   * Retorna o servidor existente para o projeto ou cria e inicia um novo.
   * @param {string} projectPath - Caminho absoluto do projeto
   * @returns {Promise<OpenCodeServer>}
   */
  async getOrCreate(projectPath) {
    this._validateBin();

    const existing = this._servers.get(projectPath);

    if (existing) {
      if (existing.status === 'ready') return existing;
      if (existing.status === 'starting') {
        await existing.awaitReady();
        return existing;
      }
      // status === 'error' — verificar circuit breaker antes de criar novo servidor
      if (existing.status === 'error' && Date.now() < existing._circuitBreakerUntil) {
        const remaining = Math.ceil((existing._circuitBreakerUntil - Date.now()) / 1000);
        throw new Error(`Servidor em cooldown após múltiplas falhas. Tente novamente em ${remaining}s.`);
      }
      // status === 'error' (cooldown expirado) ou 'stopped' — cria novo servidor abaixo
    }

    // Libera a porta do servidor anterior para reutilização
    if (existing) {
      this._usedPorts.delete(existing.port);
    }

    const port = await this._allocatePort();
    const server = new OpenCodeServer(projectPath, port, () => this._allocatePort());

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
