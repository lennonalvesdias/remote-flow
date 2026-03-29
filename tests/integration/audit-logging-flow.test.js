// tests/integration/audit-logging-flow.test.js
// Testa o fluxo completo de auditoria (NDJSON) e logging persistente.
// appendFile acumula linhas em memória para validar formato e conteúdo.

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Acumulador em memória via vi.hoisted ─────────────────────────────────────
// Necessário para compartilhar estado entre vi.mock() factory e os testes.

const auditLines = vi.hoisted(() => ({ lines: [] }))
const logLines = vi.hoisted(() => ({ lines: [] }))

const AUDIT_PATH = '/tmp/test-audit-flow/audit.ndjson'
const LOG_PATH = '/tmp/test-audit-flow/app.log'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockImplementation(async (filePath, data) => {
    if (filePath === AUDIT_PATH) {
      auditLines.lines.push(data)
    } else {
      logLines.lines.push(data)
    }
  }),
  readFile: vi.fn().mockImplementation(async (filePath) => {
    if (filePath === LOG_PATH) {
      return logLines.lines.join('')
    }
    throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
  }),
}))

vi.mock('../../src/config.js', () => ({
  AUDIT_LOG_PATH: AUDIT_PATH,
  LOG_FILE_PATH: LOG_PATH,
}))

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('audit-logging-flow — auditoria e log persistente', () => {
  let initAudit, audit
  let initLogger, logInfo, logWarn, logError, readRecentLogEntries

  beforeEach(async () => {
    // Limpa acumuladores entre testes
    auditLines.lines.length = 0
    logLines.lines.length = 0

    // Reseta módulos para zerar _initialized em audit.js e logger.js
    vi.resetModules()

    const auditMod = await import('../../src/audit.js')
    const loggerMod = await import('../../src/logger.js')

    initAudit = auditMod.initAudit
    audit = auditMod.audit
    initLogger = loggerMod.initLogger
    logInfo = loggerMod.logInfo
    logWarn = loggerMod.logWarn
    logError = loggerMod.logError
    readRecentLogEntries = loggerMod.readRecentLogEntries
  })

  // ─── audit() — formato NDJSON ─────────────────────────────────────────────

  describe('audit() — formato e conteúdo NDJSON', () => {
    it('escreve entrada com estrutura NDJSON válida', async () => {
      await audit('session.create', { projectPath: '/p/alpha' }, 'user-001', 'sess-001')

      expect(auditLines.lines).toHaveLength(1)
      const entry = JSON.parse(auditLines.lines[0])
      expect(entry.action).toBe('session.create')
      expect(entry.userId).toBe('user-001')
      expect(entry.sessionId).toBe('sess-001')
      expect(entry.data).toMatchObject({ projectPath: '/p/alpha' })
      expect(typeof entry.ts).toBe('string')
    })

    it('cada chamada gera uma linha NDJSON terminada em \\n', async () => {
      await audit('command.run', {}, 'user-001', null)
      await audit('session.close', {}, 'user-001', 'sess-001')
      await audit('permission.approve', { tool: 'bash' }, 'user-001', 'sess-001')

      expect(auditLines.lines).toHaveLength(3)
      for (const line of auditLines.lines) {
        expect(line.endsWith('\n')).toBe(true)
      }
    })

    it('múltiplas entradas são linhas JSON independentes e parseáveis', async () => {
      await audit('session.create', {}, 'u1', 's1')
      await audit('message.passthrough', { text: 'olá' }, 'u1', 's1')
      await audit('session.close', {}, 'u1', 's1')

      const entries = auditLines.lines.map((line) => JSON.parse(line))
      expect(entries).toHaveLength(3)
      expect(entries[0].action).toBe('session.create')
      expect(entries[1].action).toBe('message.passthrough')
      expect(entries[2].action).toBe('session.close')
    })

    it('audit() com data={} e userId/sessionId null usa valores null no JSON', async () => {
      await audit('bot.startup')

      const entry = JSON.parse(auditLines.lines[0])
      expect(entry.userId).toBeNull()
      expect(entry.sessionId).toBeNull()
      expect(entry.data).toEqual({})
    })

    it('falha de I/O em appendFile é absorvida e não lança exceção', async () => {
      const { appendFile } = await import('node:fs/promises')
      appendFile.mockRejectedValueOnce(new Error('Disco cheio'))

      // Nunca deve lançar — audit absorve falhas de I/O
      await expect(audit('session.create', {}, 'u', 's')).resolves.toBeUndefined()
    })
  })

  // ─── initAudit() ──────────────────────────────────────────────────────────

  describe('initAudit()', () => {
    it('cria diretório na primeira chamada', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockClear()

      await initAudit()

      expect(mkdir).toHaveBeenCalledWith('/tmp/test-audit-flow', { recursive: true })
    })

    it('é idempotente — segunda chamada retorna imediatamente sem I/O', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockClear()

      await initAudit()
      await initAudit()

      expect(mkdir).toHaveBeenCalledOnce()
    })

    it('falha de mkdir não lança exceção (absorvida internamente)', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockRejectedValueOnce(new Error('Permissão negada'))

      await expect(initAudit()).resolves.toBeUndefined()
    })
  })

  // ─── initLogger() e logInfo/logError ──────────────────────────────────────

  describe('initLogger() e funções de log', () => {
    it('initLogger cria diretório e escreve entrada de startup no arquivo', async () => {
      const { mkdir } = await import('node:fs/promises')
      mkdir.mockClear()

      await initLogger()

      expect(mkdir).toHaveBeenCalledWith('/tmp/test-audit-flow', { recursive: true })
      expect(logLines.lines).toHaveLength(1)
      const entry = JSON.parse(logLines.lines[0])
      expect(entry.level).toBe('info')
      expect(entry.component).toBe('Logger')
      expect(entry.message).toBe('Logger iniciado')
    })

    it('logInfo escreve entrada NDJSON com level=info', async () => {
      await initLogger()
      logLines.lines.length = 0  // descarta entrada de startup

      await logInfo('SessionManager', 'Sessão criada com sucesso')

      expect(logLines.lines).toHaveLength(1)
      const entry = JSON.parse(logLines.lines[0])
      expect(entry.level).toBe('info')
      expect(entry.component).toBe('SessionManager')
      expect(entry.message).toBe('Sessão criada com sucesso')
      expect(typeof entry.ts).toBe('string')
    })

    it('logWarn escreve entrada NDJSON com level=warn', async () => {
      await initLogger()
      logLines.lines.length = 0

      await logWarn('Health', 'Servidor em estado degradado')

      const entry = JSON.parse(logLines.lines[0])
      expect(entry.level).toBe('warn')
      expect(entry.component).toBe('Health')
    })

    it('logError escreve entrada NDJSON com level=error', async () => {
      await initLogger()
      logLines.lines.length = 0

      await logError('SessionManager', 'Falha ao criar sessão')

      const entry = JSON.parse(logLines.lines[0])
      expect(entry.level).toBe('error')
      expect(entry.message).toBe('Falha ao criar sessão')
    })

    it('múltiplos logs geram linhas NDJSON parseáveis em sequência', async () => {
      await initLogger()
      logLines.lines.length = 0

      await logInfo('Bot', 'Online')
      await logWarn('Bot', 'Alto uso de memória')
      await logError('Bot', 'Falha crítica detectada')

      const entries = logLines.lines.map((line) => JSON.parse(line))
      expect(entries).toHaveLength(3)
      expect(entries[0].level).toBe('info')
      expect(entries[1].level).toBe('warn')
      expect(entries[2].level).toBe('error')
    })

    it('falha de I/O em appendFile é absorvida silenciosamente', async () => {
      const { appendFile } = await import('node:fs/promises')
      appendFile.mockRejectedValueOnce(new Error('I/O error'))

      // Após resetModules, mkdir pode já ter sido chamado; apenas verificar que não lança
      await expect(logInfo('Test', 'mensagem')).resolves.toBeUndefined()
    })

    it('readRecentLogEntries retorna entradas parseadas do acumulador em memória', async () => {
      await initLogger()
      await logInfo('A', 'msg 1')
      await logInfo('B', 'msg 2')
      await logError('C', 'msg 3')

      const entries = await readRecentLogEntries()

      // Inclui entrada de startup + 3 logs
      expect(entries.length).toBeGreaterThanOrEqual(3)
      expect(entries.every((e) => e.ts && e.level && e.component)).toBe(true)
    })

    it('initLogger é idempotente após reset do módulo via _resetLogger', async () => {
      const { mkdir } = await import('node:fs/promises')
      const { _resetLogger } = await import('../../src/logger.js')
      mkdir.mockClear()

      await initLogger()
      _resetLogger()
      await initLogger()

      // Após reset manual, mkdir deve ser chamado novamente
      expect(mkdir.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
