// tests/integration/persistence-flow.test.js
// Testa o fluxo completo de persistência de sessões:
// save → load → update → remove → clear, com sistema de arquivos em memória.

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Sistema de arquivos em memória via vi.hoisted ────────────────────────────
// O store é criado antes da factory vi.mock() para que ambos compartilhem
// a mesma referência ao Map de arquivos e aos vi.fn() mocks.

const store = vi.hoisted(() => {
  const files = new Map()

  const mkdir = vi.fn().mockResolvedValue(undefined)

  const readFile = vi.fn().mockImplementation(async (filePath) => {
    if (!files.has(filePath)) {
      throw Object.assign(new Error(`ENOENT: no such file: ${filePath}`), { code: 'ENOENT' })
    }
    return files.get(filePath)
  })

  const writeFile = vi.fn().mockImplementation(async (filePath, data) => {
    files.set(filePath, data)
  })

  const unlink = vi.fn().mockImplementation(async (filePath) => {
    files.delete(filePath)
  })

  const rename = vi.fn().mockImplementation(async (src, dest) => {
    if (!files.has(src)) {
      throw Object.assign(new Error(`ENOENT: no such file: ${src}`), { code: 'ENOENT' })
    }
    files.set(dest, files.get(src))
    files.delete(src)
  })

  return { files, mkdir, readFile, writeFile, unlink, rename }
})

vi.mock('node:fs/promises', () => ({
  default: store,
  mkdir: store.mkdir,
  readFile: store.readFile,
  writeFile: store.writeFile,
  unlink: store.unlink,
  rename: store.rename,
}))

vi.mock('../../src/config.js', () => ({
  PERSISTENCE_PATH: '/tmp/test-persistence-flow/data.json',
}))

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('persistence-flow — ciclo completo de persistência', () => {
  let loadSessions, saveSession, removeSession, clearSessions

  beforeEach(async () => {
    // Limpa filesystem em memória e histórico de chamadas entre testes
    store.files.clear()
    store.mkdir.mockClear()
    store.readFile.mockClear()
    store.writeFile.mockClear()
    store.unlink.mockClear()
    store.rename.mockClear()

    // vi.resetModules() força reimportação com _dirEnsured=false e _writeQueue novo
    vi.resetModules()
    const mod = await import('../../src/persistence.js')
    loadSessions = mod.loadSessions
    saveSession = mod.saveSession
    removeSession = mod.removeSession
    clearSessions = mod.clearSessions
  })

  // ─── Ciclo básico save → load ─────────────────────────────────────────────

  describe('ciclo save → load', () => {
    it('salva sessão e carrega de volta com todos os campos', async () => {
      const sessData = {
        sessionId: 'sess-pf-001',
        threadId: 'thread-pf-001',
        projectPath: '/projetos/alpha',
        userId: 'user-001',
        agent: 'build',
        status: 'active',
        createdAt: '2026-03-01T10:00:00.000Z',
      }

      await saveSession(sessData)
      const loaded = await loadSessions()

      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject(sessData)
    })

    it('salva múltiplas sessões e carrega todas', async () => {
      await saveSession({ sessionId: 'sess-a', threadId: 'th-a', projectPath: '/p/a', userId: 'u', agent: 'build', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-b', threadId: 'th-b', projectPath: '/p/b', userId: 'u', agent: 'plan', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-c', threadId: 'th-c', projectPath: '/p/c', userId: 'u', agent: 'build', status: 'active', createdAt: '' })

      const loaded = await loadSessions()

      expect(loaded).toHaveLength(3)
      expect(loaded.map((s) => s.sessionId)).toEqual(
        expect.arrayContaining(['sess-a', 'sess-b', 'sess-c'])
      )
    })

    it('atualiza sessão existente ao salvar com mesmo sessionId', async () => {
      await saveSession({ sessionId: 'sess-update', threadId: 'th-u', projectPath: '/p/u', userId: 'u', agent: 'build', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-update', threadId: 'th-u', projectPath: '/p/u', userId: 'u', agent: 'build', status: 'finished', createdAt: '' })

      const loaded = await loadSessions()

      // Deve haver apenas uma sessão (atualizada, não duplicada)
      expect(loaded).toHaveLength(1)
      expect(loaded[0].status).toBe('finished')
    })

    it('preserva campos originais ao atualizar parcialmente', async () => {
      await saveSession({
        sessionId: 'sess-preserve',
        threadId: 'th-preserve',
        projectPath: '/p/preserve',
        userId: 'user-original',
        agent: 'plan',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      // Atualiza apenas status
      await saveSession({ sessionId: 'sess-preserve', status: 'finished' })

      const loaded = await loadSessions()

      expect(loaded[0].userId).toBe('user-original')
      expect(loaded[0].agent).toBe('plan')
      expect(loaded[0].status).toBe('finished')
    })
  })

  // ─── removeSession() ──────────────────────────────────────────────────────

  describe('ciclo save → remove → load', () => {
    it('remove a sessão correta e mantém as demais', async () => {
      await saveSession({ sessionId: 'sess-rm-1', threadId: 'th-1', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-rm-2', threadId: 'th-2', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-rm-3', threadId: 'th-3', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })

      await removeSession('sess-rm-2')

      const loaded = await loadSessions()
      const ids = loaded.map((s) => s.sessionId)

      expect(ids).toContain('sess-rm-1')
      expect(ids).not.toContain('sess-rm-2')
      expect(ids).toContain('sess-rm-3')
    })

    it('removeSession de ID inexistente não lança e não altera dados', async () => {
      await saveSession({ sessionId: 'sess-keep', threadId: 'th-keep', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })

      await expect(removeSession('sess-nao-existe')).resolves.toBeUndefined()

      const loaded = await loadSessions()
      expect(loaded).toHaveLength(1)
      expect(loaded[0].sessionId).toBe('sess-keep')
    })
  })

  // ─── clearSessions() ──────────────────────────────────────────────────────

  describe('clearSessions()', () => {
    it('remove todas as sessões e deixa array vazio', async () => {
      await saveSession({ sessionId: 'sess-clr-1', threadId: 'th-1', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })
      await saveSession({ sessionId: 'sess-clr-2', threadId: 'th-2', projectPath: '/p', userId: 'u', agent: 'build', status: 'active', createdAt: '' })

      await clearSessions()

      const loaded = await loadSessions()
      expect(loaded).toEqual([])
    })

    it('clearSessions em armazenamento vazio não lança erro', async () => {
      await expect(clearSessions()).resolves.toBeUndefined()
      const loaded = await loadSessions()
      expect(loaded).toEqual([])
    })
  })

  // ─── Resiliência ──────────────────────────────────────────────────────────

  describe('resiliência a erros de I/O', () => {
    it('loadSessions retorna [] quando arquivo não existe (ENOENT)', async () => {
      // Nenhum arquivo escrito → store.files está vazio → readFile lança ENOENT
      const loaded = await loadSessions()
      expect(loaded).toEqual([])
    })

    it('loadSessions retorna [] e recupera quando arquivo contém JSON corrompido', async () => {
      // Escreve conteúdo inválido diretamente no filesystem em memória
      store.files.set('/tmp/test-persistence-flow/data.json', '{ INVALID JSON <<<')

      const loaded = await loadSessions()

      expect(loaded).toEqual([])
    })

    it('loadSessions retorna [] e descarta dados com versão incompatível', async () => {
      const incompatible = JSON.stringify({ version: 99, sessions: [{ sessionId: 'old-sess' }] })
      store.files.set('/tmp/test-persistence-flow/data.json', incompatible)

      const loaded = await loadSessions()

      expect(loaded).toEqual([])
    })

    it('ensureDir é chamado apenas uma vez por instância do módulo', async () => {
      await saveSession({ sessionId: 's1', status: 'active' })
      await saveSession({ sessionId: 's2', status: 'active' })
      await saveSession({ sessionId: 's3', status: 'active' })

      // mkdir deve ser chamado apenas uma vez (flag _dirEnsured evita redundância)
      expect(store.mkdir).toHaveBeenCalledOnce()
      expect(store.mkdir).toHaveBeenCalledWith('/tmp/test-persistence-flow', { recursive: true })
    })
  })

  // ─── Fluxo completo simulando ciclo de vida do bot ────────────────────────

  describe('fluxo completo: inicialização → atividade → encerramento', () => {
    it('simula restart: carrega sessões ativas, atualiza status, limpa ao final', async () => {
      // Fase 1: bot salva sessão ao criar
      await saveSession({
        sessionId: 'sess-lifecycle',
        threadId: 'thread-lifecycle',
        projectPath: '/projetos/bot',
        userId: 'user-bot',
        agent: 'build',
        status: 'active',
        createdAt: new Date().toISOString(),
      })

      // Fase 2: bot reinicia e carrega sessões do disco
      const sessionsOnRestart = await loadSessions()
      expect(sessionsOnRestart).toHaveLength(1)
      expect(sessionsOnRestart[0].status).toBe('active')

      // Fase 3: bot notifica e remove sessão interrompida
      await removeSession('sess-lifecycle')

      // Fase 4: estado limpo
      const sessionsAfterCleanup = await loadSessions()
      expect(sessionsAfterCleanup).toEqual([])
    })
  })
})
