import http from 'node:http'
import { vi, describe, it, expect, afterEach } from 'vitest'
import { startHealthServer } from '../src/health.js'

// Usa porta 0 para que o SO atribua uma porta aleatória;
// impede conflito com o server.listen(HEALTH_PORT) interno de startHealthServer.
vi.mock('../src/config.js', () => ({ HEALTH_PORT: 0, HEALTH_HOST: '127.0.0.1' }))

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch (e) { resolve({ status: res.statusCode, body: data }) }
      })
    }).on('error', reject)
  })
}

describe('startHealthServer', () => {
  let server

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve))
      server = null
    }
  })

  function makeMocks({ serverStatuses = ['ready'] } = {}) {
    const sessions = [
      { status: 'running' },
      { status: 'finished' }
    ]
    const servers = serverStatuses.map((status, i) => ({
      toHealthInfo: () => ({ port: 4100 + i, status, circuitBreakerUntil: 0 })
    }))
    return {
      sessionManager: { getAll: vi.fn().mockReturnValue(sessions) },
      serverManager: { getAll: vi.fn().mockReturnValue(servers) },
      startedAt: new Date()
    }
  }

  it('retorna 200 com status ok quando todos os servidores saudáveis', async () => {
    const mocks = makeMocks({ serverStatuses: ['ready'] })
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`)
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
  })

  it('retorna 503 com status degraded quando >50% dos servidores em erro', async () => {
    const mocks = makeMocks({ serverStatuses: ['error', 'error', 'ready'] })
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`)
    expect(status).toBe(503)
    expect(body.status).toBe('degraded')
  })

  it('inclui sessions.total e sessions.active na resposta', async () => {
    const mocks = makeMocks()
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)
    expect(body.sessions).toBeDefined()
    expect(typeof body.sessions.total).toBe('number')
  })

  it('inclui servers[] na resposta', async () => {
    const mocks = makeMocks()
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)
    expect(Array.isArray(body.servers)).toBe(true)
  })

  it('retorna 404 para outros paths', async () => {
    const mocks = makeMocks()
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { status } = await httpGet(`http://127.0.0.1:${port}/outro`)
    expect(status).toBe(404)
  })

  it('inclui uptime como número positivo', async () => {
    const mocks = makeMocks()
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { body } = await httpGet(`http://127.0.0.1:${port}/health`)
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('/metrics — retorna métricas com uptime, sessões e servidores', async () => {
    const mocks = {
      sessionManager: {
        getAll: vi.fn().mockReturnValue([{ status: 'running' }, { status: 'finished' }]),
        totalCreated: 5,
      },
      serverManager: {
        getAll: vi.fn().mockReturnValue([{ status: 'ready', toHealthInfo: () => ({ port: 4100, status: 'ready' }) }]),
      },
      startedAt: new Date(),
    }
    server = startHealthServer(mocks)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const { port } = server.address()
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/metrics`)
    expect(status).toBe(200)
    expect(typeof body.uptime_seconds).toBe('number')
    expect(body.sessions.total_created).toBe(5)
    expect(body.sessions.active).toBe(1)
    expect(body.sessions.by_status).toBeDefined()
    expect(body.servers.total).toBe(1)
    expect(body.servers.ready).toBe(1)
  })
})
