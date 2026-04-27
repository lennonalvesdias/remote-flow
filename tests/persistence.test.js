// tests/persistence.test.js
// Testes unitários para src/persistence.js

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ─── Mock de fs/promises via vi.hoisted ──────────────────────────────────────
// vi.hoisted() garante que mockFs esteja disponível tanto na factory de vi.mock()
// quanto nos testes, mesmo sendo avaliado antes dos imports estáticos.

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  // default: necessário pois persistence.js usa `import fs from 'node:fs/promises'`
  default: mockFs,
  // Spread para compatibilidade com named imports
  ...mockFs,
}));

vi.mock('../src/config.js', () => ({
  PERSISTENCE_PATH: '/tmp/test-remote-flow/data.json',
}));

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('persistence', () => {
  let loadSessions, saveSession, removeSession, clearSessions;

  beforeEach(async () => {
    // Reseta o módulo para limpar _dirEnsured e _writeQueue (estado de módulo)
    vi.resetModules();
    mockFs.readFile.mockReset();
    mockFs.writeFile.mockReset();
    mockFs.mkdir.mockReset();
    mockFs.rename.mockReset();
    // Stubs padrão para operações de escrita
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    // Importação dinâmica obtém instância fresca do módulo
    const mod = await import('../src/persistence.js');
    loadSessions = mod.loadSessions;
    saveSession = mod.saveSession;
    removeSession = mod.removeSession;
    clearSessions = mod.clearSessions;
  });

  // ─── loadSessions() ──────────────────────────────────────────────────────────

  describe('loadSessions()', () => {
    it('retorna array de sessões quando arquivo existe com dados válidos', async () => {
      const data = { version: 1, sessions: [{ sessionId: 'sess-1', status: 'running' }] };
      mockFs.readFile.mockResolvedValue(JSON.stringify(data));

      const sessions = await loadSessions();

      expect(sessions).toEqual([{ sessionId: 'sess-1', status: 'running' }]);
    });

    it('retorna array vazio quando arquivo não existe (ENOENT)', async () => {
      const err = new Error('ENOENT: no such file');
      err.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(err);

      const sessions = await loadSessions();

      expect(sessions).toEqual([]);
    });

    it('retorna array vazio e descarta dados quando versão é incompatível', async () => {
      const data = { version: 99, sessions: [{ sessionId: 'sess-old' }] };
      mockFs.readFile.mockResolvedValue(JSON.stringify(data));

      const sessions = await loadSessions();

      expect(sessions).toEqual([]);
    });

    it('retorna array vazio quando erro genérico ao ler arquivo', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Permissão negada'));

      const sessions = await loadSessions();

      expect(sessions).toEqual([]);
    });
  });

  // ─── saveSession() ───────────────────────────────────────────────────────────

  describe('saveSession()', () => {
    it('adiciona nova sessão quando sessionId não existe no arquivo', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, sessions: [] }));

      await saveSession({ sessionId: 'sess-new', status: 'running' });

      expect(mockFs.writeFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
      expect(written.sessions).toHaveLength(1);
      expect(written.sessions[0].sessionId).toBe('sess-new');
    });

    it('atualiza sessão existente quando sessionId já existe', async () => {
      const existing = { sessionId: 'sess-existing', status: 'running', threadId: 'th-1' };
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, sessions: [existing] }));

      await saveSession({ sessionId: 'sess-existing', status: 'finished' });

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
      expect(written.sessions).toHaveLength(1);
      expect(written.sessions[0].status).toBe('finished');
      // Preserva campos do registro original
      expect(written.sessions[0].threadId).toBe('th-1');
    });
  });

  // ─── removeSession() ─────────────────────────────────────────────────────────

  describe('removeSession()', () => {
    it('remove sessão com o sessionId correspondente', async () => {
      const data = {
        version: 1,
        sessions: [
          { sessionId: 'sess-remove' },
          { sessionId: 'sess-keep' },
        ],
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(data));

      await removeSession('sess-remove');

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
      expect(written.sessions).toHaveLength(1);
      expect(written.sessions[0].sessionId).toBe('sess-keep');
    });

    it('não falha quando sessionId não existe no arquivo', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, sessions: [] }));

      await expect(removeSession('sess-inexistente')).resolves.toBeUndefined();
    });
  });

  // ─── clearSessions() ─────────────────────────────────────────────────────────

  describe('clearSessions()', () => {
    it('escreve arquivo com array de sessões vazio e version=1', async () => {
      await clearSessions();

      expect(mockFs.writeFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
      expect(written.sessions).toEqual([]);
      expect(written.version).toBe(1);
    });
  });

  // ─── ensureDir() ─────────────────────────────────────────────────────────────

  describe('ensureDir()', () => {
    it('chama mkdir com recursive:true na primeira operação de escrita', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, sessions: [] }));

      await saveSession({ sessionId: 'sess-dir-test', status: 'idle' });

      expect(mockFs.mkdir).toHaveBeenCalledWith('/tmp/test-remote-flow', { recursive: true });
    });

    it('não chama mkdir novamente após o flag _dirEnsured ser definido', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, sessions: [] }));

      await saveSession({ sessionId: 'sess-a', status: 'idle' });
      await saveSession({ sessionId: 'sess-b', status: 'idle' });

      // mkdir deve ser chamado apenas uma vez (flag _dirEnsured evita redundância)
      expect(mockFs.mkdir).toHaveBeenCalledOnce();
    });
  });
});
