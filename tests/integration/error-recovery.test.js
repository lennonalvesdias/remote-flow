// tests/integration/error-recovery.test.js
// Testa cenários de recuperação de erros: falhas do servidor, estados terminais,
// falhas do Discord ignoradas e abandono de fila de mensagens.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamHandler } from '../../src/stream-handler.js'
import { OpenCodeSession } from '../../src/session-manager.js'
import { createMockThread } from '@helpers/discord-mocks.js'
import { advanceTimersAndFlush } from '@helpers/timer-utils.js'
import { THREAD_ARCHIVE_DELAY_MS } from '../../src/config.js'

// ─── Mock discord.js ──────────────────────────────────────────────────────────

vi.mock('discord.js', () => {
  const AttachmentBuilder = function (buffer, options) {
    this.buffer = buffer
    this.name = options?.name
    this.description = options?.description
  }
  const ButtonBuilder = function () {
    this.setCustomId = vi.fn().mockReturnThis()
    this.setLabel = vi.fn().mockReturnThis()
    this.setStyle = vi.fn().mockReturnThis()
    this.setEmoji = vi.fn().mockReturnThis()
    this.setDisabled = vi.fn().mockReturnThis()
  }
  const ActionRowBuilder = function () {
    this.addComponents = vi.fn().mockReturnThis()
  }
  const ButtonStyle = { Success: 3, Danger: 4, Secondary: 2, Primary: 1 }
  return { AttachmentBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle }
})

// ─── Helpers locais ───────────────────────────────────────────────────────────

/**
 * Cria um servidor mock mínimo com EventEmitter para testes de OpenCodeSession.
 * @param {object} [clientOverrides] - Overrides para os métodos do client
 * @returns {EventEmitter}
 */
function createMockServer(clientOverrides = {}) {
  const server = new EventEmitter()
  server.client = {
    createSession: vi.fn().mockResolvedValue({ id: 'api-test-1' }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(undefined),
    approvePermission: vi.fn().mockResolvedValue(undefined),
    ...clientOverrides,
  }
  server.registerSession = vi.fn()
  server.deregisterSession = vi.fn()
  server._sessionRegistry = new Map()
  server.plannotatorBaseUrl = null
  return server
}

/**
 * Cria uma sessão mock mínima baseada em EventEmitter para uso com StreamHandler.
 * @param {object} [opts]
 * @returns {EventEmitter}
 */
function createMockSession(opts = {}) {
  const emitter = new EventEmitter()
  emitter.status = opts.status ?? 'idle'
  emitter.sessionId = opts.sessionId ?? 'sess-err-mock'
  emitter.apiSessionId = opts.apiSessionId ?? 'api-err-mock'
  emitter.userId = opts.userId ?? 'user-123'
  emitter.projectPath = opts.projectPath ?? '/projects/test'
  emitter.agent = opts.agent ?? 'build'
  emitter.outputBuffer = ''
  emitter.getQueueSize = vi.fn().mockReturnValue(0)
  emitter._pendingPermissionId = null
  emitter._pendingPermissionData = null
  emitter.server = opts.server ?? null
  return emitter
}

/** Drena microtasks pendentes para resolver cadeias de Promises. */
async function flushPromises(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Recuperação de erros', () => {
  // ─── 1. Propagação de fatal do servidor ─────────────────────────────────────

  describe('Propagação de fatal do servidor para a sessão', () => {
    it('fatal do servidor define status da sessão como error', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const session = new OpenCodeSession({
        sessionId: 'sess-fatal-1',
        projectPath: '/projects/test',
        threadId: 'thread-fatal-1',
        userId: 'user-f1',
        agent: 'build',
      })

      await session.start(mockServerManager)

      // _onServerFatal emite 'error' — é necessário um listener para evitar throw não tratado
      session.on('error', () => {})
      mockServer.emit('fatal', new Error('disco cheio'))

      expect(session.status).toBe('error')
    })

    it('fatal do servidor emite evento status com valor error', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const session = new OpenCodeSession({
        sessionId: 'sess-fatal-2',
        projectPath: '/projects/test',
        threadId: 'thread-fatal-2',
        userId: 'user-f2',
        agent: 'build',
      })

      await session.start(mockServerManager)

      const statusEvents = []
      session.on('status', (s) => statusEvents.push(s))
      // _onServerFatal emite 'error' — é necessário um listener para evitar throw não tratado
      session.on('error', () => {})

      mockServer.emit('fatal', new Error('servidor caiu'))

      expect(statusEvents).toContain('error')
    })

    it('fatal do servidor emite evento error com mensagem do erro original', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const session = new OpenCodeSession({
        sessionId: 'sess-fatal-3',
        projectPath: '/projects/test',
        threadId: 'thread-fatal-3',
        userId: 'user-f3',
        agent: 'build',
      })

      await session.start(mockServerManager)

      const errors = []
      session.on('error', (e) => errors.push(e))

      mockServer.emit('fatal', new Error('out of memory'))

      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(Error)
      expect(errors[0].message).toContain('out of memory')
    })
  })

  // ─── 2. Encerramento com falha na API deleteSession ────────────────────────

  describe('Encerramento com falha na API deleteSession', () => {
    let session

    beforeEach(async () => {
      const mockServer = createMockServer({
        deleteSession: vi.fn().mockRejectedValue(new Error('API indisponível')),
      })
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      session = new OpenCodeSession({
        sessionId: 'sess-del-fail',
        projectPath: '/projects/test',
        threadId: 'thread-del-fail',
        userId: 'user-df',
        agent: 'build',
      })

      await session.start(mockServerManager)
    })

    it('close() resolve sem lançar exceção mesmo quando deleteSession falha', async () => {
      await expect(session.close()).resolves.toBeUndefined()
    })

    it('close() emite evento close mesmo quando deleteSession falha', async () => {
      let closeFired = false
      session.on('close', () => { closeFired = true })

      await session.close()

      expect(closeFired).toBe(true)
    })

    it('close() define status como finished mesmo quando deleteSession falha', async () => {
      await session.close()

      expect(session.status).toBe('finished')
    })
  })

  // ─── 3. Envio de mensagem em sessão com status terminal ────────────────────

  describe('Envio de mensagem em sessão com status terminal', () => {
    it('sendMessage() lança Sessão encerrada quando status é finished', async () => {
      const session = new OpenCodeSession({
        sessionId: 'sess-term-1',
        projectPath: '/projects/test',
        threadId: 'thread-term-1',
        userId: 'user-t1',
        agent: 'build',
      })
      session.status = 'finished'
      session.apiSessionId = 'api-term-1'
      session.server = { client: { sendMessage: vi.fn() } }

      await expect(session.sendMessage('olá')).rejects.toThrow('Sessão encerrada')
    })

    it('sendMessage() lança Sessão encerrada quando status é error', async () => {
      const session = new OpenCodeSession({
        sessionId: 'sess-term-2',
        projectPath: '/projects/test',
        threadId: 'thread-term-2',
        userId: 'user-t2',
        agent: 'build',
      })
      session.status = 'error'
      session.apiSessionId = 'api-term-2'
      session.server = { client: { sendMessage: vi.fn() } }

      await expect(session.sendMessage('olá')).rejects.toThrow('Sessão encerrada')
    })

    it('queueMessage() lança Sessão encerrada quando status é finished', async () => {
      const session = new OpenCodeSession({
        sessionId: 'sess-term-3',
        projectPath: '/projects/test',
        threadId: 'thread-term-3',
        userId: 'user-t3',
        agent: 'build',
      })
      session.status = 'finished'
      session.apiSessionId = 'api-term-3'
      session.server = { client: { sendMessage: vi.fn() } }

      await expect(session.queueMessage('olá')).rejects.toThrow('Sessão encerrada')
    })

    it('API do servidor não é chamada quando sessão está em estado terminal', async () => {
      const sendMessage = vi.fn()
      const session = new OpenCodeSession({
        sessionId: 'sess-term-4',
        projectPath: '/projects/test',
        threadId: 'thread-term-4',
        userId: 'user-t4',
        agent: 'build',
      })
      session.status = 'error'
      session.apiSessionId = 'api-term-4'
      session.server = { client: { sendMessage } }

      await session.sendMessage('teste').catch(() => {})

      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  // ─── 4. Falhas do Discord ignoradas graciosamente ──────────────────────────

  describe('Falhas do Discord ignoradas graciosamente', () => {
    let thread, handler

    beforeEach(() => {
      vi.useFakeTimers()
      thread = createMockThread()
    })

    afterEach(() => {
      if (handler) {
        handler.stop()
        handler = null
      }
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('thread.send rejeita no output — sem crash, rejeição absorvida', async () => {
      thread.send.mockRejectedValue(new Error('Discord offline'))
      const session = createMockSession()
      handler = new StreamHandler(thread, session)
      handler.start()

      // Emite output com newline para que flush() possa processar
      session.emit('output', 'linha de output\n')
      // Avança além do UPDATE_INTERVAL para acionar o flush debounced
      await advanceTimersAndFlush(2000)

      // Teste passa sem lançar exceção; thread.send foi chamado mas a rejeição foi absorvida
      expect(thread.send).toHaveBeenCalled()
    })

    it('thread.send rejeita no status finished — sem crash', async () => {
      thread.send.mockRejectedValue(new Error('Discord timeout'))
      const session = createMockSession()
      handler = new StreamHandler(thread, session)
      handler.start()

      session.emit('status', 'finished')
      await advanceTimersAndFlush(200)

      expect(thread.send).toHaveBeenCalled()
    })

    it('thread.setArchived rejeita no close — sem crash', async () => {
      thread.setArchived.mockRejectedValue(new Error('Cannot archive'))
      const session = createMockSession({ status: 'idle' })
      handler = new StreamHandler(thread, session)
      handler.start()

      session.emit('close')
      // Drena microtasks para que o handler async de 'close' execute await flush()
      // e registre o setTimeout antes de avançarmos os fake timers
      await flushPromises(20)
      await advanceTimersAndFlush(THREAD_ARCHIVE_DELAY_MS + 1000)

      expect(thread.setArchived).toHaveBeenCalledWith(true)
    })

    it('thread.send rejeita no timeout — sem crash', async () => {
      thread.send.mockRejectedValue(new Error('Rate limited'))
      const session = createMockSession()
      handler = new StreamHandler(thread, session)
      handler.start()

      session.emit('timeout')
      await flushPromises()

      expect(thread.send).toHaveBeenCalled()
    })
  })

  // ─── 5. Abandono de fila em estado terminal ────────────────────────────────

  describe('Abandono de fila em estado terminal', () => {
    it('_drainMessageQueue emite queue-abandoned quando status é error', async () => {
      const session = new OpenCodeSession({
        sessionId: 'sess-q-err',
        projectPath: '/projects/test',
        threadId: 'thread-q-err',
        userId: 'user-qe',
        agent: 'build',
      })
      session.status = 'error'
      session._messageQueue = ['msg1', 'msg2', 'msg3']

      let abandonedCount = -1
      session.on('queue-abandoned', (count) => { abandonedCount = count })

      await session._drainMessageQueue()

      expect(abandonedCount).toBe(3)
    })

    it('fila é completamente esvaziada após queue-abandoned', async () => {
      const session = new OpenCodeSession({
        sessionId: 'sess-q-empty',
        projectPath: '/projects/test',
        threadId: 'thread-q-empty',
        userId: 'user-qem',
        agent: 'build',
      })
      session.status = 'finished'
      session._messageQueue = ['a', 'b']

      await session._drainMessageQueue()

      expect(session._messageQueue).toHaveLength(0)
    })

    it('StreamHandler notifica thread com a contagem de mensagens descartadas', async () => {
      const thread = createMockThread()
      const session = createMockSession()
      const handler = new StreamHandler(thread, session)
      handler.start()

      session.emit('queue-abandoned', 5)
      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith(
        expect.stringContaining('5 mensagem(s) na fila foram descartadas')
      )

      handler.stop()
    })
  })
})
