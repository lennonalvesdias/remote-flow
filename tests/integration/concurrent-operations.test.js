// tests/integration/concurrent-operations.test.js
// Testa operações concorrentes e paralelas: múltiplas sessões para projetos e
// usuários diferentes, ordenação FIFO da fila de mensagens, segurança de
// close() duplo e rastreamento de threads pelo SessionManager.
// Usa OpenCodeSession e SessionManager REAIS; mocka apenas I/O externo.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { OpenCodeSession, SessionManager } from '../../src/session-manager.js'

// ─── Mock de I/O externo ─────────────────────────────────────────────────────
// persistence.js usa node:fs/promises — evita leituras/escritas reais em disco

vi.mock('node:fs/promises', () => {
  const fsMock = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
  return { default: fsMock, ...fsMock }
})

// ─── Helpers locais ───────────────────────────────────────────────────────────

/** Drena a fila de microtasks pendentes para resolver cadeias de Promises. */
async function flushPromises(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Cria um servidor mock mínimo com EventEmitter para injeção em OpenCodeSession.
 * Usa EventEmitter real para que os métodos on/off funcionem corretamente com
 * os listeners registrados em session.start().
 * @param {object} [clientOverrides]
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

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Operações concorrentes', () => {
  // ─── 1. Múltiplas sessões para projetos diferentes ───────────────────────────

  describe('Múltiplas sessões para projetos diferentes', () => {
    let manager

    beforeEach(() => {
      vi.useFakeTimers()
      manager = new SessionManager({ getOrCreate: vi.fn() })
    })

    afterEach(() => {
      if (manager?._timeoutTimer) clearInterval(manager._timeoutTimer)
      vi.useRealTimers()
    })

    it('getAll retorna todas as sessões independentemente do projeto', () => {
      const sessA = new OpenCodeSession({
        sessionId: 'sess-proj-a', projectPath: '/projetos/app-a',
        threadId: 'thread-pa', userId: 'user-pa', agent: 'build',
      })
      const sessB = new OpenCodeSession({
        sessionId: 'sess-proj-b', projectPath: '/projetos/app-b',
        threadId: 'thread-pb', userId: 'user-pb', agent: 'build',
      })

      manager._sessions.set('sess-proj-a', sessA)
      manager._sessions.set('sess-proj-b', sessB)

      const all = manager.getAll()
      expect(all).toHaveLength(2)
      expect(all).toContain(sessA)
      expect(all).toContain(sessB)
    })

    it('getByProject retorna a sessão correta para cada caminho de projeto', () => {
      const sessC = new OpenCodeSession({
        sessionId: 'sess-proj-c', projectPath: '/projetos/app-c',
        threadId: 'thread-pc', userId: 'user-pc', agent: 'build',
      })
      const sessD = new OpenCodeSession({
        sessionId: 'sess-proj-d', projectPath: '/projetos/app-d',
        threadId: 'thread-pd', userId: 'user-pd', agent: 'build',
      })

      manager._sessions.set('sess-proj-c', sessC)
      manager._sessions.set('sess-proj-d', sessD)

      expect(manager.getByProject('/projetos/app-c')).toBe(sessC)
      expect(manager.getByProject('/projetos/app-d')).toBe(sessD)
      expect(manager.getByProject('/projetos/inexistente')).toBeUndefined()
    })

    it('getByProject ignora sessões com status terminal', () => {
      const sessFinished = new OpenCodeSession({
        sessionId: 'sess-proj-fin', projectPath: '/projetos/app-e',
        threadId: 'thread-pe', userId: 'user-pe', agent: 'build',
      })
      sessFinished.status = 'finished'

      manager._sessions.set('sess-proj-fin', sessFinished)

      // Sessão finalizada não deve ser retornada por getByProject
      expect(manager.getByProject('/projetos/app-e')).toBeUndefined()
    })
  })

  // ─── 2. Múltiplas sessões de usuários diferentes ──────────────────────────────

  describe('Múltiplas sessões de usuários diferentes', () => {
    let manager

    beforeEach(() => {
      vi.useFakeTimers()
      manager = new SessionManager({ getOrCreate: vi.fn() })
    })

    afterEach(() => {
      if (manager?._timeoutTimer) clearInterval(manager._timeoutTimer)
      vi.useRealTimers()
    })

    it('getByUser retorna apenas as sessões do usuário especificado', () => {
      const sessU1A = new OpenCodeSession({
        sessionId: 'sess-u1a', projectPath: '/projetos/a',
        threadId: 'th-u1a', userId: 'user-001', agent: 'build',
      })
      const sessU1B = new OpenCodeSession({
        sessionId: 'sess-u1b', projectPath: '/projetos/b',
        threadId: 'th-u1b', userId: 'user-001', agent: 'build',
      })
      const sessU2 = new OpenCodeSession({
        sessionId: 'sess-u2', projectPath: '/projetos/c',
        threadId: 'th-u2', userId: 'user-002', agent: 'plan',
      })

      manager._sessions.set('sess-u1a', sessU1A)
      manager._sessions.set('sess-u1b', sessU1B)
      manager._sessions.set('sess-u2', sessU2)

      const user1Sessions = manager.getByUser('user-001')
      expect(user1Sessions).toHaveLength(2)
      expect(user1Sessions).toContain(sessU1A)
      expect(user1Sessions).toContain(sessU1B)

      const user2Sessions = manager.getByUser('user-002')
      expect(user2Sessions).toHaveLength(1)
      expect(user2Sessions).toContain(sessU2)
    })

    it('getByUser retorna lista vazia para usuário sem sessões', () => {
      const sess = new OpenCodeSession({
        sessionId: 'sess-u3', projectPath: '/projetos/d',
        threadId: 'th-u3', userId: 'user-003', agent: 'build',
      })

      manager._sessions.set('sess-u3', sess)

      expect(manager.getByUser('user-desconhecido')).toHaveLength(0)
    })
  })

  // ─── 3. Fila de mensagens é FIFO ──────────────────────────────────────────────

  describe('Fila de mensagens é FIFO', () => {
    it('mensagens enfileiradas durante running mantêm a ordem de inserção', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const session = new OpenCodeSession({
        sessionId: 'sess-fifo-1', projectPath: '/projetos/fifo',
        threadId: 'thread-fifo-1', userId: 'user-fifo', agent: 'build',
      })
      session.status = 'running'
      session.apiSessionId = 'api-fifo-1'
      session.server = { client: { sendMessage } }

      await session.queueMessage('primeira mensagem')
      await session.queueMessage('segunda mensagem')
      await session.queueMessage('terceira mensagem')

      expect(session._messageQueue[0]).toBe('primeira mensagem')
      expect(session._messageQueue[1]).toBe('segunda mensagem')
      expect(session._messageQueue[2]).toBe('terceira mensagem')
    })

    it('a primeira mensagem da fila é enviada ao sair do estado running', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const session = new OpenCodeSession({
        sessionId: 'sess-fifo-2', projectPath: '/projetos/fifo',
        threadId: 'thread-fifo-2', userId: 'user-fifo', agent: 'build',
      })
      session.status = 'running'
      session.apiSessionId = 'api-fifo-2'
      session.server = { client: { sendMessage } }

      await session.queueMessage('primeira')
      await session.queueMessage('segunda')
      await session.queueMessage('terceira')

      // Dispara a transição idle — drena a fila na ordem FIFO
      session._handleIdleTransition()
      await flushPromises()

      // Apenas a primeira mensagem é enviada por ciclo idle
      // (sendMessage seta status='running', quebrando o while loop)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith('api-fifo-2', 'build', 'primeira')
    })

    it('segunda e terceira mensagens permanecem na fila após o primeiro drain', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const session = new OpenCodeSession({
        sessionId: 'sess-fifo-3', projectPath: '/projetos/fifo',
        threadId: 'thread-fifo-3', userId: 'user-fifo', agent: 'build',
      })
      session.status = 'running'
      session.apiSessionId = 'api-fifo-3'
      session.server = { client: { sendMessage } }

      await session.queueMessage('msg-1')
      await session.queueMessage('msg-2')
      await session.queueMessage('msg-3')

      session._handleIdleTransition()
      await flushPromises()

      // Fila ainda contém as 2 mensagens restantes (enviadas nos próximos drains)
      expect(session._messageQueue).toContain('msg-2')
      expect(session._messageQueue).toContain('msg-3')
    })
  })

  // ─── 4. close() duplo é seguro ────────────────────────────────────────────────

  describe('close() duplo é seguro', () => {
    it('segundo close() resolve sem lançar exceção', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const session = new OpenCodeSession({
        sessionId: 'sess-close-dup', projectPath: '/projetos/dup',
        threadId: 'thread-close-dup', userId: 'user-dup', agent: 'build',
      })

      await session.start(mockServerManager)
      await session.close()

      // Segundo close() não deve lançar exceção
      await expect(session.close()).resolves.toBeUndefined()
    })

    it('status permanece finished após close() duplo', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const session = new OpenCodeSession({
        sessionId: 'sess-close-status', projectPath: '/projetos/dup2',
        threadId: 'thread-close-status', userId: 'user-dup2', agent: 'build',
      })

      await session.start(mockServerManager)
      await session.close()
      await session.close()

      expect(session.status).toBe('finished')
    })
  })

  // ─── 5. SessionManager rastreia threads corretamente ─────────────────────────

  describe('SessionManager rastreia threads corretamente', () => {
    let manager

    beforeEach(() => {
      vi.useFakeTimers()
      manager = new SessionManager({ getOrCreate: vi.fn() })
    })

    afterEach(() => {
      if (manager?._timeoutTimer) clearInterval(manager._timeoutTimer)
      vi.useRealTimers()
    })

    it('getByThread retorna a sessão antes do encerramento e undefined após', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const threadId = 'thread-track-1'
      const session = new OpenCodeSession({
        sessionId: 'sess-track-1', projectPath: '/projetos/track',
        threadId, userId: 'user-track', agent: 'build',
      })

      // Registra a sessão manualmente (espelha o que SessionManager.create() faz)
      manager._sessions.set('sess-track-1', session)
      manager._threadIndex.set(threadId, 'sess-track-1')

      // Registra listener de close como SessionManager.create() o faria
      session.once('close', () => {
        manager._threadIndex.delete(threadId)
        setTimeout(() => {
          manager._sessions.delete('sess-track-1')
        }, 10 * 60 * 1000)
      })

      await session.start(mockServerManager)

      // Sessão acessível antes do encerramento
      expect(manager.getByThread(threadId)).toBe(session)

      await session.close()

      // Thread removida do índice imediatamente no evento 'close'
      expect(manager.getByThread(threadId)).toBeUndefined()
    })

    it('sessão permanece no cache por 10 min após o encerramento', async () => {
      const mockServer = createMockServer()
      const mockServerManager = { getOrCreate: vi.fn().mockResolvedValue(mockServer) }

      const threadId = 'thread-cache-1'
      const session = new OpenCodeSession({
        sessionId: 'sess-cache-1', projectPath: '/projetos/cache',
        threadId, userId: 'user-cache', agent: 'build',
      })

      manager._sessions.set('sess-cache-1', session)
      manager._threadIndex.set(threadId, 'sess-cache-1')

      session.once('close', () => {
        manager._threadIndex.delete(threadId)
        setTimeout(() => {
          manager._sessions.delete('sess-cache-1')
        }, 10 * 60 * 1000)
      })

      await session.start(mockServerManager)
      await session.close()

      // Thread removida do índice mas sessão ainda no cache _sessions
      expect(manager.getByThread(threadId)).toBeUndefined()
      expect(manager.getById('sess-cache-1')).toBe(session)

      // Avança 10 min + 1s — o GC timer expira e remove do cache
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000)

      expect(manager.getById('sess-cache-1')).toBeUndefined()
    })
  })
})
