// tests/integration/startup-flow.test.js
// Testa as funções de inicialização do bot: initAudit, initLogger, loadModels
// e a lógica de notificação de sessões interrompidas (replicada de src/index.js clientReady).

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockClient, createMockThread } from '@helpers/discord-mocks.js'

// ─── Acumulador em memória ────────────────────────────────────────────────────

const fsStore = vi.hoisted(() => ({
  files: new Map(),
  appendedLines: [],
}))

vi.mock('node:fs/promises', () => {
  // persistence.js usa `import fs from 'node:fs/promises'` (default import) —
  // o mock deve expor tanto `default` quanto named exports.
  const fns = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockImplementation(async (_path, data) => {
      fsStore.appendedLines.push(data)
    }),
    readFile: vi.fn().mockImplementation(async (filePath) => {
      if (!fsStore.files.has(filePath)) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
      }
      return fsStore.files.get(filePath)
    }),
    writeFile: vi.fn().mockImplementation(async (filePath, data) => {
      fsStore.files.set(filePath, data)
    }),
    unlink: vi.fn().mockImplementation(async (filePath) => {
      fsStore.files.delete(filePath)
    }),
  }
  return { default: fns, ...fns }
})

// Mock de execFile para loadModels (node:child_process)
// A factory é avaliada novamente após vi.resetModules(), mantendo a mesma referência
// ao vi.fn() criada por vi.hoisted().
const mockExecFile = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}))

vi.mock('../../src/config.js', () => ({
  AUDIT_LOG_PATH: '/tmp/test-startup/audit.ndjson',
  LOG_FILE_PATH: '/tmp/test-startup/app.log',
  PERSISTENCE_PATH: '/tmp/test-startup/data.json',
  OPENCODE_BIN: 'opencode',
  SESSION_TIMEOUT_MS: 0,
  MAX_BUFFER: 512000,
  OPENCODE_BASE_PORT: 4100,
  PLANNOTATOR_BASE_PORT: 5100,
  HEALTH_PORT: 0,
  SHUTDOWN_TIMEOUT_MS: 5000,
  CHANNEL_FETCH_TIMEOUT_MS: 2000,
}))

// ─── Utilitário: lógica de notificação de sessões interrompidas ───────────────
// Replicada de src/index.js clientReady — não exportada, não pode ser importada.

/**
 * Notifica threads de sessões interrompidas pelo restart do bot.
 * Réplica fiel da lógica em src/index.js clientReady.
 * @param {{ client: object, loadSessions: Function, removeSession: Function }} opts
 */
async function notifyInterruptedSessions({ client, loadSessions, removeSession }) {
  const persistedSessions = await loadSessions()
  const activeSessions = persistedSessions.filter((s) => s.status === 'active')

  for (const s of activeSessions) {
    try {
      const channel = await Promise.race([
        client.channels.fetch(s.threadId),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout fetch canal')), 5_000)
        ),
      ]).catch(() => null)

      if (channel && channel.isThread()) {
        await channel.send(
          `⚠️ **O bot foi reiniciado** e a sessão \`${s.sessionId}\` foi encerrada.\n` +
          `Use \`/plan\` ou \`/build\` para iniciar uma nova sessão.`
        )
      }
    } catch {
      // Absorve erros por thread individual — não deve derrubar a inicialização
    }

    await removeSession(s.sessionId).catch(() => {})
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('startup-flow — funções de inicialização', () => {
  let initAudit, initLogger, loadModels, getAvailableModels

  beforeEach(async () => {
    fsStore.files.clear()
    fsStore.appendedLines.length = 0
    mockExecFile.mockReset()

    // Reset de módulos: zera _initialized em audit/logger e _models em model-loader
    vi.resetModules()

    const auditMod = await import('../../src/audit.js')
    const loggerMod = await import('../../src/logger.js')
    const modelMod = await import('../../src/model-loader.js')

    initAudit = auditMod.initAudit
    initLogger = loggerMod.initLogger
    loadModels = modelMod.loadModels
    getAvailableModels = modelMod.getAvailableModels
  })

  // ─── initAudit() ──────────────────────────────────────────────────────────

  describe('initAudit()', () => {
    it('cria diretório de auditoria na primeira chamada', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockClear()

      await initAudit()

      expect(mkdir).toHaveBeenCalledWith('/tmp/test-startup', { recursive: true })
    })

    it('é idempotente — segunda chamada não aciona mkdir', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockClear()

      await initAudit()
      await initAudit()

      expect(mkdir).toHaveBeenCalledOnce()
    })

    it('falha de mkdir não lança exceção', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockRejectedValueOnce(new Error('Permissão negada'))

      await expect(initAudit()).resolves.toBeUndefined()
    })
  })

  // ─── initLogger() ─────────────────────────────────────────────────────────

  describe('initLogger()', () => {
    it('cria diretório de log e escreve entrada inicial de startup', async () => {
      await initLogger()

      // Deve haver pelo menos a entrada de startup
      expect(fsStore.appendedLines).toHaveLength(1)
      const entry = JSON.parse(fsStore.appendedLines[0])
      expect(entry.message).toBe('Logger iniciado')
      expect(entry.level).toBe('info')
    })

    it('falha de mkdir não lança exceção', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockRejectedValueOnce(new Error('Sem espaço'))

      await expect(initLogger()).resolves.toBeUndefined()
    })
  })

  // ─── loadModels() ─────────────────────────────────────────────────────────

  describe('loadModels()', () => {
    it('carrega modelos via execFile e os armazena internamente', async () => {
      // cb(null, { stdout, stderr }) → promisify resolve com o 2º arg da callback
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, { stdout: 'anthropic/claude-sonnet-4-5\nopenai/gpt-4o\n', stderr: '' })
      })

      await loadModels()

      const models = getAvailableModels()
      expect(models).toContain('anthropic/claude-sonnet-4-5')
      expect(models).toContain('openai/gpt-4o')
      expect(models).toHaveLength(2)
    })

    it('usa lista de fallback quando execFile lança erro', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(new Error('opencode não encontrado'))
      })

      await loadModels()

      const models = getAvailableModels()
      // Fallback padrão tem pelo menos 1 modelo
      expect(models.length).toBeGreaterThan(0)
    })

    it('usa AVAILABLE_MODELS do env quando execFile falha e env está definido', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(new Error('falha'))
      })
      const original = process.env.AVAILABLE_MODELS
      process.env.AVAILABLE_MODELS = 'model-a,model-b,model-c'

      try {
        await loadModels()
        const models = getAvailableModels()
        expect(models).toEqual(['model-a', 'model-b', 'model-c'])
      } finally {
        if (original === undefined) {
          delete process.env.AVAILABLE_MODELS
        } else {
          process.env.AVAILABLE_MODELS = original
        }
      }
    })

    it('usa lista de fallback quando execFile retorna stdout vazio', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, { stdout: '', stderr: '' })
      })

      await loadModels()

      const models = getAvailableModels()
      expect(models.length).toBeGreaterThan(0)
    })

    it('getAvailableModels retorna cópia — mutação externa não afeta estado interno', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, { stdout: 'model-x\n', stderr: '' })
      })

      await loadModels()
      const copy = getAvailableModels()
      copy.push('intruso')

      expect(getAvailableModels()).not.toContain('intruso')
    })
  })

  // ─── Notificação de sessões interrompidas ─────────────────────────────────

  describe('notifyInterruptedSessions() — lógica do clientReady', () => {
    it('envia mensagem na thread de cada sessão ativa interrompida', async () => {
      // Simula arquivo de persistência com sessões ativas
      const persistedData = JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: 'sess-int-1', threadId: 'thread-int-1', projectPath: '/p/a', userId: 'u', agent: 'build', status: 'active', createdAt: '' },
          { sessionId: 'sess-int-2', threadId: 'thread-int-2', projectPath: '/p/b', userId: 'u', agent: 'build', status: 'active', createdAt: '' },
          { sessionId: 'sess-fin-1', threadId: 'thread-fin-1', projectPath: '/p/c', userId: 'u', agent: 'build', status: 'finished', createdAt: '' },
        ],
      })
      fsStore.files.set('/tmp/test-startup/data.json', persistedData)

      const thread1 = createMockThread({ id: 'thread-int-1' })
      const thread2 = createMockThread({ id: 'thread-int-2' })
      const client = createMockClient()

      // Sobrescreve channels.fetch para retornar a thread correta por ID
      client.channels = {
        fetch: vi.fn().mockImplementation((id) => {
          if (id === 'thread-int-1') return Promise.resolve(thread1)
          if (id === 'thread-int-2') return Promise.resolve(thread2)
          return Promise.resolve(null)
        }),
      }

      // Importa loadSessions e removeSession da instância fresca do módulo
      vi.resetModules()
      const { loadSessions, removeSession } = await import('../../src/persistence.js')

      await notifyInterruptedSessions({ client, loadSessions, removeSession })

      // Apenas as sessões ativas devem receber notificação
      expect(thread1.send).toHaveBeenCalledOnce()
      expect(thread2.send).toHaveBeenCalledOnce()
      const msg1 = thread1._sentMessages[0].content
      expect(msg1).toContain('sess-int-1')
      expect(msg1).toContain('reiniciado')
    })

    it('não envia mensagem para sessões com status finished', async () => {
      const persistedData = JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: 'sess-ok', threadId: 'thread-ok', projectPath: '/p/ok', userId: 'u', agent: 'build', status: 'finished', createdAt: '' },
        ],
      })
      fsStore.files.set('/tmp/test-startup/data.json', persistedData)

      const thread = createMockThread({ id: 'thread-ok' })
      const client = createMockClient()
      client.channels = { fetch: vi.fn().mockResolvedValue(thread) }

      vi.resetModules()
      const { loadSessions, removeSession } = await import('../../src/persistence.js')

      await notifyInterruptedSessions({ client, loadSessions, removeSession })

      expect(thread.send).not.toHaveBeenCalled()
    })

    it('não lança exceção quando thread não existe (fetch retorna null)', async () => {
      const persistedData = JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: 'sess-ghost', threadId: 'thread-ghost', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' },
        ],
      })
      fsStore.files.set('/tmp/test-startup/data.json', persistedData)

      const client = createMockClient()
      client.channels = { fetch: vi.fn().mockResolvedValue(null) }

      vi.resetModules()
      const { loadSessions, removeSession } = await import('../../src/persistence.js')

      await expect(
        notifyInterruptedSessions({ client, loadSessions, removeSession })
      ).resolves.toBeUndefined()
    })

    it('remove sessões da persistência após notificar', async () => {
      const persistedData = JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: 'sess-remove', threadId: 'thread-remove', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' },
        ],
      })
      fsStore.files.set('/tmp/test-startup/data.json', persistedData)

      const thread = createMockThread({ id: 'thread-remove' })
      const client = createMockClient()
      client.channels = { fetch: vi.fn().mockResolvedValue(thread) }

      vi.resetModules()
      const { loadSessions, removeSession } = await import('../../src/persistence.js')

      await notifyInterruptedSessions({ client, loadSessions, removeSession })

      // Após notificação, sessão deve ter sido removida
      vi.resetModules()
      const { loadSessions: loadAgain } = await import('../../src/persistence.js')
      const remaining = await loadAgain()
      expect(remaining).toEqual([])
    })
  })
})
