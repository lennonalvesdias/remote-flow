// tests/integration/health-check-flow.test.js
// Testa o fluxo completo do servidor HTTP de health check integrado com SessionManager real.
// startHealthServer é testado com estado real do SessionManager (sessões injetadas diretamente).

import http from 'node:http'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ─── Mocks de I/O ─────────────────────────────────────────────────────────────
// Porta 0 → SO atribui porta aleatória; SESSION_TIMEOUT_MS:0 → sem timer no SM

vi.mock('../../src/config.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, HEALTH_PORT: 0, SESSION_TIMEOUT_MS: 0 }
})

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

import { SessionManager, OpenCodeSession } from '../../src/session-manager.js'
import { startHealthServer } from '../../src/health.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Faz GET HTTP e retorna { status, body }. */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    }).on('error', reject)
  })
}

/** Aguarda o servidor estar ouvindo na porta. */
function awaitListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

/**
 * Cria serverManager mock mínimo para uso no startHealthServer.
 * @param {Array<string>} [serverStatuses=[]]
 */
function createMockServerManager(serverStatuses = []) {
  const servers = serverStatuses.map((status, i) => ({
    status,
    toHealthInfo: () => ({ port: 4100 + i, status }),
  }))
  return {
    getOrCreate: vi.fn().mockResolvedValue({
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
    }),
    getAll: () => servers,
    stopAll: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Injeta uma sessão diretamente no SessionManager sem spawnar processo real.
 * @param {SessionManager} sm
 * @param {{ status?: string, threadId?: string, userId?: string }} [opts]
 * @returns {OpenCodeSession}
 */
function injectSession(sm, opts = {}) {
  const session = new OpenCodeSession({
    sessionId: `sess-health-${Math.random().toString(36).slice(2, 8)}`,
    projectPath: '/projetos/health-test',
    threadId: opts.threadId ?? `thread-health-${Math.random().toString(36).slice(2, 8)}`,
    userId: opts.userId ?? 'user-health-001',
    agent: 'build',
  })
  session.status = opts.status ?? 'running'
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

describe('health-check-flow — /health integrado com SessionManager real', () => {
  /** @type {import('http').Server} */
  let server
  /** @type {SessionManager} */
  let sm
  let serverManager
  let startedAt

  beforeEach(() => {
    serverManager = createMockServerManager(['ready'])
    sm = new SessionManager(serverManager)
    startedAt = Date.now()
  })

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve))
      server = null
    }
    if (sm._timeoutTimer) clearInterval(sm._timeoutTimer)
  })

  it('/health retorna 200 e sessions.active=0 quando SessionManager não tem sessões', async () => {
    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`)

    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.sessions.total).toBe(0)
    expect(body.sessions.active).toBe(0)
  })

  it('/health reflete contagem correta de sessões ativas após injeção', async () => {
    // 2 ativas + 1 encerrada
    injectSession(sm, { status: 'running' })
    injectSession(sm, { status: 'idle' })
    injectSession(sm, { status: 'finished' })

    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)

    expect(body.sessions.total).toBe(3)
    expect(body.sessions.active).toBe(2)
  })

  it('/health retorna 503 degraded quando >50% dos servidores em erro', async () => {
    const degradedServerManager = createMockServerManager(['error', 'error', 'ready'])

    server = startHealthServer({ sessionManager: sm, serverManager: degradedServerManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`)

    expect(status).toBe(503)
    expect(body.status).toBe('degraded')
  })

  it('/health inclui uptime como número não-negativo', async () => {
    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)

    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('/health inclui array servers[] na resposta', async () => {
    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)

    expect(Array.isArray(body.servers)).toBe(true)
    expect(body.servers).toHaveLength(1)
    expect(body.servers[0].status).toBe('ready')
  })

  it('/health retorna 404 para rota desconhecida', async () => {
    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { status } = await httpGet(`http://127.0.0.1:${port}/nao-existe`)

    expect(status).toBe(404)
  })

  it('/metrics retorna campos uptime_seconds, sessions e servers', async () => {
    injectSession(sm, { status: 'running' })
    injectSession(sm, { status: 'finished' })

    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/metrics`)

    expect(status).toBe(200)
    expect(typeof body.uptime_seconds).toBe('number')
    expect(body.sessions).toBeDefined()
    expect(body.sessions.active).toBe(1)
    expect(body.sessions.by_status).toBeDefined()
    expect(body.servers).toBeDefined()
    expect(typeof body.servers.total).toBe('number')
  })

  it('/metrics reflete totalCreated do SessionManager quando disponível', async () => {
    injectSession(sm, { status: 'running' })
    // Sobrescreve totalCreated após a injeção (simula sessões de execuções anteriores)
    sm.totalCreated = 7

    server = startHealthServer({ sessionManager: sm, serverManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { body } = await httpGet(`http://127.0.0.1:${port}/metrics`)

    // totalCreated foi definido manualmente no SM
    expect(body.sessions.total_created).toBe(7)
  })

  it('/health status ok quando não há servidores', async () => {
    const emptyServerManager = createMockServerManager([])

    server = startHealthServer({ sessionManager: sm, serverManager: emptyServerManager, startedAt })
    await awaitListening(server)
    const { port } = server.address()

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`)

    // Sem servidores = sem degradação
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
  })
})
