// tests/helpers/process-mocks.js
// Mocks para child_process.spawn e execFile que simulam processos opencode e comandos git.

import { EventEmitter } from 'events'
import { vi } from 'vitest'

// ─── createMockProcess ─────────────────────────────────────────────────────────

/**
 * Cria um processo filho mock que simula o comportamento de ChildProcess.
 * Emite eventos 'close' e 'error'. Stdin/stdout/stderr são EventEmitters separados.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {number} [opts.pid] - PID do processo (padrão: número aleatório)
 * @returns {EventEmitter} Processo mock com interface de ChildProcess
 */
export function createMockProcess(opts = {}) {
  const proc = new EventEmitter()

  proc.pid = opts.pid ?? (Math.floor(Math.random() * 50000) + 10000)
  proc.killed = false
  proc.exitCode = null

  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  }

  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()

  proc.kill = vi.fn().mockImplementation((signal = 'SIGTERM') => {
    if (proc.killed) return false
    proc.killed = true
    proc.exitCode = signal === 'SIGKILL' ? 9 : 0
    setImmediate(() => proc.emit('close', proc.exitCode, signal))
    return true
  })

  return proc
}

// ─── createSSEEmitter ─────────────────────────────────────────────────────────

/**
 * Cria um emissor de eventos SSE para simular output do processo opencode no stdout.
 * Formata eventos no padrão SSE: "event: TYPE\ndata: JSON\n\n"
 * @param {EventEmitter} process - Processo mock criado por createMockProcess
 * @returns {Object} Emissor SSE com métodos de conveniência
 */
export function createSSEEmitter(process) {
  return {
    /**
     * Emite um evento SSE formatado no stdout do processo.
     * @param {string} eventType - Tipo do evento SSE
     * @param {Object} data - Dados a serializar como JSON
     */
    emitEvent(eventType, data) {
      const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
      process.stdout.emit('data', Buffer.from(line))
    },

    /**
     * Emite mensagem de servidor pronto com a porta de escuta.
     * @param {number} port - Porta HTTP em que o servidor opencode está ouvindo
     */
    emitOpenCodeReady(port) {
      process.stdout.emit('data', Buffer.from(`listening on http://localhost:${port}\n`))
    },

    /**
     * Emite evento de status de sessão SSE.
     * @param {string} status - Status da sessão (running|idle|waiting_input|finished|error)
     * @param {string} [sessionId='session-abc'] - ID da sessão
     */
    emitSessionStatus(status, sessionId = 'session-abc') {
      this.emitEvent('session.status', { sessionId, status })
    },

    /**
     * Emite evento de delta de texto de mensagem SSE.
     * @param {string} content - Conteúdo do delta
     * @param {string} [sessionId='session-abc'] - ID da sessão
     */
    emitMessageDelta(content, sessionId = 'session-abc') {
      this.emitEvent('message.part.delta', {
        sessionId,
        part: { type: 'text', text: content },
      })
    },

    /**
     * Emite evento de permissão solicitada SSE.
     * @param {Object} [opts={}] - Opções da permissão
     * @param {string} [opts.sessionId='session-abc'] - ID da sessão
     * @param {string} [opts.permissionId='perm-1'] - ID da permissão
     * @param {string} [opts.toolName='write_file'] - Nome da ferramenta
     * @param {string} [opts.description] - Descrição da permissão solicitada
     * @param {string} [opts.path='/some/path'] - Caminho afetado
     */
    emitPermission(opts = {}) {
      this.emitEvent('permission.asked', {
        sessionId: opts.sessionId ?? 'session-abc',
        permissionId: opts.permissionId ?? 'perm-1',
        toolName: opts.toolName ?? 'write_file',
        description: opts.description ?? 'Escrever arquivo de configuração',
        path: opts.path ?? '/some/path',
      })
    },

    /**
     * Emite evento de pergunta do agente SSE.
     * @param {Object} [opts={}] - Opções da pergunta
     * @param {string} [opts.sessionId='session-abc'] - ID da sessão
     * @param {string} [opts.questionId='q-1'] - ID da pergunta
     * @param {Array}  [opts.questions] - Lista de perguntas com texto e opções
     */
    emitQuestion(opts = {}) {
      this.emitEvent('question.asked', {
        sessionId: opts.sessionId ?? 'session-abc',
        questionId: opts.questionId ?? 'q-1',
        questions: opts.questions ?? [{ text: 'Continue?', options: ['yes', 'no'] }],
      })
    },

    /**
     * Emite evento de diff de sessão SSE.
     * @param {Object} [opts={}] - Opções do diff
     * @param {string} [opts.sessionId='session-abc'] - ID da sessão
     * @param {string} [opts.diff] - Conteúdo do diff unificado
     */
    emitDiff(opts = {}) {
      this.emitEvent('session.diff', {
        sessionId: opts.sessionId ?? 'session-abc',
        diff: opts.diff ?? '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
      })
    },

    /**
     * Fecha o processo emitindo evento 'close' com código de saída.
     * @param {number} [code=0] - Código de saída do processo
     */
    close(code = 0) {
      process.exitCode = code
      process.emit('close', code, null)
    },
  }
}

// ─── createSpawnMock ──────────────────────────────────────────────────────────

/**
 * Cria um mock para child_process.spawn que retorna processos mock rastreáveis.
 * Uso: vi.spyOn(childProcess, 'spawn').mockImplementation(spawnMock)
 * @returns {{ spawnMock: Function, lastProcess: Object|null, reset: Function }}
 */
export function createSpawnMock() {
  let _lastProcess = null

  const spawnMock = vi.fn().mockImplementation(() => {
    const proc = createMockProcess()
    _lastProcess = proc
    return proc
  })

  return {
    spawnMock,
    /** Retorna o processo mais recentemente criado pelo mock. */
    get lastProcess() {
      return _lastProcess
    },
    /** Limpa o histórico de chamadas e o último processo registrado. */
    reset() {
      _lastProcess = null
      spawnMock.mockClear()
    },
  }
}

// ─── createExecFileMock ───────────────────────────────────────────────────────

/**
 * Cria um mock para execFile que resolve com uma resposta padrão.
 * Pode ser reconfigurado com mockResolvedValueOnce para respostas específicas.
 * @param {string} [defaultResponse=''] - Conteúdo padrão do stdout
 * @returns {Function} Mock vi.fn() compatível com execFile promisificado
 */
export function createExecFileMock(defaultResponse = '') {
  return vi.fn().mockResolvedValue({ stdout: defaultResponse, stderr: '' })
}
