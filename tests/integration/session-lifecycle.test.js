// tests/integration/session-lifecycle.test.js
// Testa o ciclo de vida completo de sessões: criação, mensagens, eventos SSE e encerramento.
// Usa OpenCodeSession e SessionManager REAIS; mocka apenas I/O externo (node:fs/promises).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager, OpenCodeSession } from '../../src/session-manager.js'
import { advanceTimersAndFlush } from '@helpers/timer-utils.js'

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

// ─── Helpers locais ──────────────────────────────────────────────────────────

/** Drena a fila de microtasks pendentes para resolver cadeias de Promises. */
async function flushPromises(rounds = 8) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Cria um serverManager mock mínimo para injeção em SessionManager.
 * Simula getOrCreate() retornando um servidor com client HTTP mockado,
 * suficiente para session.start() completar sem I/O real.
 */
function createMockServerManager() {
  const server = {
    client: {
      createSession: vi.fn().mockResolvedValue({ id: 'api-sess-1' }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    },
    registerSession: vi.fn(),
    deregisterSession: vi.fn(),
    plannotatorBaseUrl: null,
    on: vi.fn(),
    off: vi.fn(),
    _sessionRegistry: new Map(),
  }
  return {
    getOrCreate: vi.fn().mockResolvedValue(server),
    _server: server,
  }
}

// ─── OpenCodeSession — ciclo de vida básico ───────────────────────────────────

describe('OpenCodeSession — ciclo de vida básico', () => {
  /** @type {OpenCodeSession} */
  let session

  beforeEach(() => {
    vi.useFakeTimers()

    const mockServer = {
      client: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
      deregisterSession: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      _sessionRegistry: new Map(),
    }

    session = new OpenCodeSession({
      sessionId: 'sess-lifecycle-1',
      projectPath: '/projetos/app',
      threadId: 'thread-lifecycle-1',
      userId: 'user-001',
      agent: 'build',
    })
    // Injeta dependências externas diretamente — evita spawnar processos reais
    session.apiSessionId = 'api-sess-lifecycle-1'
    session.status = 'idle'
    session.server = mockServer
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ─── queueMessage() ─────────────────────────────────────────────────────────

  describe('queueMessage()', () => {
    it('enquanto idle envia imediatamente e retorna queued: false', async () => {
      const result = await session.queueMessage('Olá!')

      expect(result.queued).toBe(false)
      expect(result.position).toBe(0)
      expect(session.server.client.sendMessage).toHaveBeenCalledOnce()
      expect(session.server.client.sendMessage).toHaveBeenCalledWith(
        'api-sess-lifecycle-1',
        'build',
        'Olá!'
      )
    })

    it('enquanto running enfileira sem enviar e retorna queued: true', async () => {
      session.status = 'running'

      const result = await session.queueMessage('mensagem enfileirada')

      expect(result.queued).toBe(true)
      expect(result.position).toBe(1)
      expect(session.server.client.sendMessage).not.toHaveBeenCalled()
      expect(session.getQueueSize()).toBe(1)
    })

    it('segunda mensagem enfileirada durante running tem posição 2', async () => {
      session.status = 'running'

      await session.queueMessage('msg 1')
      const result2 = await session.queueMessage('msg 2')

      expect(result2.position).toBe(2)
      expect(session.getQueueSize()).toBe(2)
    })

    it('lança "Sessão encerrada" para sessão com status finished', async () => {
      session.status = 'finished'

      await expect(session.queueMessage('msg')).rejects.toThrow('Sessão encerrada')
    })

    it('lança "Sessão encerrada" para sessão com status error', async () => {
      session.status = 'error'

      await expect(session.queueMessage('msg')).rejects.toThrow('Sessão encerrada')
    })
  })

  // ─── handleSSEEvent() ────────────────────────────────────────────────────────

  describe('handleSSEEvent()', () => {
    it('message.part.delta acumula output no buffer e emite evento output', () => {
      const outputs = []
      session.on('output', (chunk) => outputs.push(chunk))
      session.status = 'running'

      session.handleSSEEvent({
        type: 'message.part.delta',
        data: { properties: { field: 'text', delta: 'Olá!', sessionID: 'api-sess-lifecycle-1' } },
      })

      expect(outputs).toEqual(['Olá!'])
      expect(session.outputBuffer).toContain('Olá!')
    })

    it('message.part.delta com campo reasoning emite evento reasoning, não output', () => {
      const outputs = []
      const reasonings = []
      session.on('output', (c) => outputs.push(c))
      session.on('reasoning', (c) => reasonings.push(c))

      session.handleSSEEvent({
        type: 'message.part.delta',
        data: { properties: { field: 'reasoning', delta: 'Pensando...', sessionID: 'api-sess-lifecycle-1' } },
      })

      expect(outputs).toHaveLength(0)
      expect(reasonings).toEqual(['Pensando...'])
    })

    it('session.status idle faz transição running → emite status finished', async () => {
      const statusEvents = []
      session.on('status', (s) => statusEvents.push(s))
      session.status = 'running'

      session.handleSSEEvent({
        type: 'session.status',
        data: { properties: { status: { type: 'idle' } } },
      })

      await flushPromises()

      expect(statusEvents).toContain('finished')
      expect(session.status).toBe('idle')
    })

    it('session.error emite status error e evento error com a mensagem correta', () => {
      const statusEvents = []
      const errors = []
      session.on('status', (s) => statusEvents.push(s))
      session.on('error', (err) => errors.push(err))

      session.handleSSEEvent({
        type: 'session.error',
        data: { properties: { error: 'Falha crítica' } },
      })

      expect(statusEvents).toContain('error')
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe('Falha crítica')
    })

    it('event delta com campo desconhecido não emite output', () => {
      const outputs = []
      session.on('output', (c) => outputs.push(c))

      session.handleSSEEvent({
        type: 'message.part.delta',
        data: { properties: { field: 'metadata', delta: 'ignorado', sessionID: 'api-sess-lifecycle-1' } },
      })

      expect(outputs).toHaveLength(0)
    })
  })

  // ─── close() ─────────────────────────────────────────────────────────────────

  describe('close()', () => {
    it('emite evento status finished', async () => {
      const statusEvents = []
      session.on('status', (s) => statusEvents.push(s))

      await session.close()

      expect(statusEvents).toContain('finished')
    })

    it('emite evento close', async () => {
      const closes = []
      session.on('close', () => closes.push(true))

      await session.close()

      expect(closes).toHaveLength(1)
    })

    it('atualiza session.status para finished', async () => {
      await session.close()

      expect(session.status).toBe('finished')
    })

    it('chama deleteSession com o apiSessionId correto', async () => {
      await session.close()

      expect(session.server.client.deleteSession).toHaveBeenCalledWith('api-sess-lifecycle-1')
    })

    it('após close, queueMessage lança "Sessão encerrada"', async () => {
      await session.close()

      await expect(session.queueMessage('pós-close')).rejects.toThrow('Sessão encerrada')
    })
  })
})

// ─── SessionManager ───────────────────────────────────────────────────────────

describe('SessionManager', () => {
  /** @type {ReturnType<createMockServerManager>} */
  let serverManager
  /** @type {SessionManager} */
  let sm

  beforeEach(() => {
    vi.useFakeTimers()
    serverManager = createMockServerManager()
    sm = new SessionManager(serverManager)
  })

  afterEach(() => {
    // Cancela o timer de verificação de timeout para evitar vazamento entre testes
    if (sm._timeoutTimer) clearInterval(sm._timeoutTimer)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ─── create() ───────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('retorna OpenCodeSession com os campos corretos', async () => {
      const session = await sm.create({
        projectPath: '/projetos/alpha',
        threadId: 'thread-c-1',
        userId: 'user-001',
        agent: 'build',
      })

      expect(session.projectPath).toBe('/projetos/alpha')
      expect(session.threadId).toBe('thread-c-1')
      expect(session.userId).toBe('user-001')
      expect(session.agent).toBe('build')
      expect(session.status).toBe('idle')
    })

    it('registra a sessão em _sessions e _threadIndex', async () => {
      const session = await sm.create({
        projectPath: '/projetos/alpha',
        threadId: 'thread-c-2',
        userId: 'user-001',
        agent: 'build',
      })

      expect(sm.getByThread('thread-c-2')).toBe(session)
      expect(sm.getById(session.sessionId)).toBe(session)
    })

    it('incrementa totalCreated a cada nova sessão', async () => {
      expect(sm.totalCreated).toBe(0)

      await sm.create({ projectPath: '/p/a', threadId: 'thread-tc-1', userId: 'u', agent: 'build' })
      expect(sm.totalCreated).toBe(1)

      await sm.create({ projectPath: '/p/b', threadId: 'thread-tc-2', userId: 'u', agent: 'build' })
      expect(sm.totalCreated).toBe(2)
    })
  })

  // ─── getByThread() ──────────────────────────────────────────────────────────

  describe('getByThread()', () => {
    it('retorna undefined para threadId inexistente', () => {
      expect(sm.getByThread('thread-inexistente')).toBeUndefined()
    })

    it('retorna a sessão correta após criação', async () => {
      const session = await sm.create({
        projectPath: '/p/a',
        threadId: 'thread-lookup-1',
        userId: 'u',
        agent: 'build',
      })

      expect(sm.getByThread('thread-lookup-1')).toBe(session)
    })
  })

  // ─── getByProject() ─────────────────────────────────────────────────────────

  describe('getByProject()', () => {
    it('retorna sessão ativa para o caminho do projeto', async () => {
      const session = await sm.create({
        projectPath: '/projetos/busca',
        threadId: 'thread-gp-1',
        userId: 'u',
        agent: 'build',
      })

      expect(sm.getByProject('/projetos/busca')).toBe(session)
    })

    it('não retorna sessão com status finished', async () => {
      await sm.create({
        projectPath: '/projetos/encerrado',
        threadId: 'thread-gp-2',
        userId: 'u',
        agent: 'build',
      })
      const session = sm.getByThread('thread-gp-2')
      await session.close()

      expect(sm.getByProject('/projetos/encerrado')).toBeUndefined()
    })
  })

  // ─── getByUser() ────────────────────────────────────────────────────────────

  describe('getByUser()', () => {
    it('retorna todas as sessões do usuário especificado', async () => {
      await sm.create({ projectPath: '/p/a', threadId: 'thread-gu-1', userId: 'user-x', agent: 'build' })
      await sm.create({ projectPath: '/p/b', threadId: 'thread-gu-2', userId: 'user-x', agent: 'build' })
      await sm.create({ projectPath: '/p/c', threadId: 'thread-gu-3', userId: 'user-y', agent: 'build' })

      expect(sm.getByUser('user-x')).toHaveLength(2)
      expect(sm.getByUser('user-y')).toHaveLength(1)
      expect(sm.getByUser('user-z')).toHaveLength(0)
    })
  })

  // ─── getAll() ───────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('retorna array vazio quando não há sessões', () => {
      expect(sm.getAll()).toHaveLength(0)
    })

    it('retorna todas as sessões registradas', async () => {
      await sm.create({ projectPath: '/p/a', threadId: 'thread-ga-1', userId: 'u', agent: 'build' })
      await sm.create({ projectPath: '/p/b', threadId: 'thread-ga-2', userId: 'u', agent: 'build' })

      expect(sm.getAll()).toHaveLength(2)
    })
  })

  // ─── Retenção de sessão fechada ──────────────────────────────────────────────

  describe('Retenção de sessão após close', () => {
    it('sessão fechada é removida do threadIndex imediatamente', async () => {
      const session = await sm.create({
        projectPath: '/p/ret',
        threadId: 'thread-ret-1',
        userId: 'u',
        agent: 'build',
      })
      await session.close()

      expect(sm.getByThread('thread-ret-1')).toBeUndefined()
    })

    it('sessão fechada ainda está em _sessions por até 10 minutos', async () => {
      const session = await sm.create({
        projectPath: '/p/cache',
        threadId: 'thread-ret-2',
        userId: 'u',
        agent: 'build',
      })
      const { sessionId } = session
      await session.close()

      // Imediatamente após close: ainda no cache por 10 min
      expect(sm.getById(sessionId)).toBe(session)
    })

    it('sessão fechada é removida do cache após 10 minutos', async () => {
      const session = await sm.create({
        projectPath: '/p/gc',
        threadId: 'thread-ret-3',
        userId: 'u',
        agent: 'build',
      })
      const { sessionId } = session
      await session.close()

      await advanceTimersAndFlush(10 * 60 * 1000 + 500)

      expect(sm.getById(sessionId)).toBeUndefined()
    })
  })

  // ─── destroy() ──────────────────────────────────────────────────────────────

  describe('destroy()', () => {
    it('encerra a sessão e remove do threadIndex', async () => {
      const session = await sm.create({
        projectPath: '/p/destroy',
        threadId: 'thread-d-1',
        userId: 'u',
        agent: 'build',
      })
      const { sessionId } = session

      await sm.destroy(sessionId)

      expect(session.status).toBe('finished')
      expect(sm.getByThread('thread-d-1')).toBeUndefined()
    })

    it('não lança erro para sessionId inexistente', async () => {
      await expect(sm.destroy('sess-inexistente')).resolves.toBeUndefined()
    })
  })
})
