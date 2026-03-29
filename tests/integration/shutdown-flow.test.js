// tests/integration/shutdown-flow.test.js
// Testa a lógica de shutdown gracioso do bot.
// A função shutdown() de src/index.js não é exportada; é replicada aqui
// para testar: notificação de threads, encerramento de sessões,
// chamada a stopAll() e forçar encerramento após timeout.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OpenCodeSession, SessionManager } from '../../src/session-manager.js'
import { createMockClient, createMockThread } from '@helpers/discord-mocks.js'

// ─── Mocks de I/O ─────────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => {
  const fsMock = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
  }
  return { default: fsMock, ...fsMock }
})

vi.mock('../../src/config.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    SESSION_TIMEOUT_MS: 0,
    SHUTDOWN_TIMEOUT_MS: 5000,
    CHANNEL_FETCH_TIMEOUT_MS: 500,
  }
})

// ─── Lógica de shutdown replicada de src/index.js ─────────────────────────────
// Não inclui process.exit() para não derrubar o processo de testes.

/**
 * Cria a função de shutdown isolada da dependência do process.exit.
 * @param {{ sessionManager: SessionManager, serverManager: object, client: object, SHUTDOWN_TIMEOUT_MS: number, CHANNEL_FETCH_TIMEOUT_MS: number }} deps
 * @returns {() => Promise<void>}
 */
function createShutdown({ sessionManager, serverManager, client, SHUTDOWN_TIMEOUT_MS, CHANNEL_FETCH_TIMEOUT_MS }) {
  return async function shutdown() {
    const sessions = sessionManager.getAll().filter(
      (s) => s.status !== 'finished' && s.status !== 'error'
    )

    const fetchWithTimeout = (channelId) =>
      Promise.race([
        client.channels.fetch(channelId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CHANNEL_FETCH_TIMEOUT_MS)
        ),
      ])

    // Notifica usuários nas threads ativas
    await Promise.allSettled(
      sessions.map(async (s) => {
        try {
          const channel = await fetchWithTimeout(s.threadId)
          if (channel) await channel.send('⚠️ **Bot reiniciando.** Sua sessão será encerrada.')
        } catch {
          // thread pode já estar arquivada ou Discord inacessível
        }
      })
    )

    // Encerra sessões com timeout de segurança
    const closePromise = Promise.allSettled(sessions.map((s) => s.close()))
    await Promise.race([closePromise, new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS))])

    await serverManager.stopAll()
    client.destroy()
    // process.exit(0) omitido intencionalmente em testes
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Drena microtasks pendentes. */
async function flushPromises(rounds = 8) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Injeta sessão com mock server no SessionManager.
 * @param {SessionManager} sm
 * @param {{ status?: string, threadId?: string }} [opts]
 * @returns {OpenCodeSession}
 */
function injectSession(sm, opts = {}) {
  const session = new OpenCodeSession({
    sessionId: `sess-sd-${Math.random().toString(36).slice(2, 8)}`,
    projectPath: '/projetos/shutdown-test',
    threadId: opts.threadId ?? `thread-sd-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-sd-001',
    agent: 'build',
  })
  session.status = opts.status ?? 'running'
  session.apiSessionId = `api-sd-${session.sessionId}`
  session.server = {
    client: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    deregisterSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    _sessionRegistry: new Map(),
  }
  sm._sessions.set(session.sessionId, session)
  sm._threadIndex.set(session.threadId, session.sessionId)
  sm.totalCreated += 1
  return session
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('shutdown-flow — graceful shutdown do bot', () => {
  /** @type {SessionManager} */
  let sm
  let serverManager
  let client

  beforeEach(() => {
    sm = new SessionManager({ getOrCreate: vi.fn(), getAll: () => [], stopAll: vi.fn() })
    serverManager = { stopAll: vi.fn().mockResolvedValue(undefined) }
    client = createMockClient()
    // createMockClient não inclui channels — adicionamos fetch para os testes
    client.channels = { fetch: vi.fn().mockResolvedValue(null) }
  })

  afterEach(() => {
    if (sm._timeoutTimer) clearInterval(sm._timeoutTimer)
  })

  // ─── Notificação de threads ────────────────────────────────────────────────

  describe('notificação de threads ativas', () => {
    it('envia mensagem de aviso nas threads de todas as sessões ativas', async () => {
      const thread1 = createMockThread({ id: 'thread-sd-1' })
      const thread2 = createMockThread({ id: 'thread-sd-2' })

      const sess1 = injectSession(sm, { status: 'running', threadId: 'thread-sd-1' })
      const sess2 = injectSession(sm, { status: 'idle', threadId: 'thread-sd-2' })

      client.channels.fetch = vi.fn().mockImplementation((id) => {
        if (id === sess1.threadId) return Promise.resolve(thread1)
        if (id === sess2.threadId) return Promise.resolve(thread2)
        return Promise.resolve(null)
      })

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(thread1.send).toHaveBeenCalledOnce()
      expect(thread2.send).toHaveBeenCalledOnce()
      expect(thread1._sentMessages[0].content).toContain('reiniciando')
    })

    it('não notifica threads de sessões já encerradas (finished/error)', async () => {
      const thread = createMockThread({ id: 'thread-sd-finished' })
      injectSession(sm, { status: 'finished', threadId: 'thread-sd-finished' })
      injectSession(sm, { status: 'error', threadId: 'thread-sd-error' })

      client.channels.fetch = vi.fn().mockResolvedValue(thread)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      // fetch não deve ter sido chamado para sessões já encerradas
      expect(client.channels.fetch).not.toHaveBeenCalled()
    })

    it('absorve erro quando fetch do canal falha', async () => {
      injectSession(sm, { status: 'running', threadId: 'thread-fetch-fail' })

      client.channels.fetch = vi.fn().mockRejectedValue(new Error('Canal não encontrado'))

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })

      // Não deve lançar exceção
      await expect(shutdown()).resolves.toBeUndefined()
    })

    it('continua o shutdown quando fetch timeout é excedido', async () => {
      injectSession(sm, { status: 'running', threadId: 'thread-timeout' })

      // fetch nunca resolve dentro do CHANNEL_FETCH_TIMEOUT_MS
      client.channels.fetch = vi.fn().mockImplementation(
        () => new Promise(() => { /* nunca resolve */ })
      )

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 50, // timeout muito curto
      })

      await expect(shutdown()).resolves.toBeUndefined()
      // stopAll e destroy ainda devem ser chamados mesmo com timeout no fetch
      expect(serverManager.stopAll).toHaveBeenCalledOnce()
      expect(client.destroy).toHaveBeenCalledOnce()
    })
  })

  // ─── Encerramento de sessões ───────────────────────────────────────────────

  describe('encerramento de sessões', () => {
    it('chama close() em todas as sessões ativas', async () => {
      const sess1 = injectSession(sm, { status: 'running' })
      const sess2 = injectSession(sm, { status: 'idle' })

      vi.spyOn(sess1, 'close')
      vi.spyOn(sess2, 'close')

      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(sess1.close).toHaveBeenCalledOnce()
      expect(sess2.close).toHaveBeenCalledOnce()
    })

    it('não chama close() em sessões finished', async () => {
      const finishedSess = injectSession(sm, { status: 'finished' })
      vi.spyOn(finishedSess, 'close')

      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(finishedSess.close).not.toHaveBeenCalled()
    })

    it('continua o shutdown mesmo quando close() de uma sessão lança erro', async () => {
      const sess1 = injectSession(sm, { status: 'running' })
      const sess2 = injectSession(sm, { status: 'running' })

      // sess1.close falha; sess2.close tem sucesso
      vi.spyOn(sess1, 'close').mockRejectedValue(new Error('Falha ao fechar sessão'))
      vi.spyOn(sess2, 'close')

      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })

      await expect(shutdown()).resolves.toBeUndefined()
      expect(sess2.close).toHaveBeenCalledOnce()
    })
  })

  // ─── serverManager.stopAll() e client.destroy() ───────────────────────────

  describe('limpeza de recursos', () => {
    it('chama serverManager.stopAll() após encerrar sessões', async () => {
      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(serverManager.stopAll).toHaveBeenCalledOnce()
    })

    it('chama client.destroy() ao final do shutdown', async () => {
      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(client.destroy).toHaveBeenCalledOnce()
    })

    it('funciona corretamente quando não há sessões ativas', async () => {
      // SessionManager vazio — nenhuma sessão injetada

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS: 5000, CHANNEL_FETCH_TIMEOUT_MS: 500,
      })
      await shutdown()

      expect(serverManager.stopAll).toHaveBeenCalledOnce()
      expect(client.destroy).toHaveBeenCalledOnce()
      expect(client.channels.fetch).not.toHaveBeenCalled()
    })
  })

  // ─── Timeout de segurança ─────────────────────────────────────────────────

  describe('timeout de segurança com fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('avança para além do timeout de sessão e ainda chama stopAll', async () => {
      const sess = injectSession(sm, { status: 'running' })

      // close() nunca resolve — simula sessão travada
      vi.spyOn(sess, 'close').mockImplementation(
        () => new Promise(() => { /* nunca resolve */ })
      )

      client.channels.fetch = vi.fn().mockResolvedValue(null)

      const SHUTDOWN_TIMEOUT_MS = 1000

      const shutdown = createShutdown({
        sessionManager: sm, serverManager, client,
        SHUTDOWN_TIMEOUT_MS, CHANNEL_FETCH_TIMEOUT_MS: 50,
      })

      // Inicia shutdown sem await (sessão travada impede conclusão natural)
      const shutdownPromise = shutdown()

      // Avança o relógio além do SHUTDOWN_TIMEOUT_MS para acionar o race
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 100)
      await flushPromises()

      await shutdownPromise

      // Após o timeout de segurança, recursos devem ser liberados
      expect(serverManager.stopAll).toHaveBeenCalledOnce()
      expect(client.destroy).toHaveBeenCalledOnce()
    })
  })
})
