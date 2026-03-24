// tests/logger.test.js
// Testes unitários para src/logger.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const mockMkdir = vi.fn();
const mockAppendFile = vi.fn();
const mockReadFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  appendFile: mockAppendFile,
  readFile: mockReadFile,
}));

vi.mock('../src/config.js', () => ({ LOG_FILE_PATH: '/tmp/test-app.log' }));

// ─── Setup ─────────────────────────────────────────────────────────────────────

let initLogger, logInfo, logWarn, logError, readRecentLogEntries, _resetLogger;

beforeEach(async () => {
  vi.resetModules();
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockAppendFile.mockReset().mockResolvedValue(undefined);
  mockReadFile.mockReset();

  const mod = await import('../src/logger.js');
  initLogger = mod.initLogger;
  logInfo = mod.logInfo;
  logWarn = mod.logWarn;
  logError = mod.logError;
  readRecentLogEntries = mod.readRecentLogEntries;
  _resetLogger = mod._resetLogger;
});

// ─── initLogger ────────────────────────────────────────────────────────────────

describe('initLogger()', () => {
  it('chama mkdir com { recursive: true }', async () => {
    await initLogger();
    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('chama appendFile para registrar entrada de startup', async () => {
    await initLogger();
    expect(mockAppendFile).toHaveBeenCalled();
    const line = mockAppendFile.mock.calls[0][1];
    const record = JSON.parse(line);
    expect(record.level).toBe('info');
    expect(record.component).toBe('Logger');
    expect(record.message).toContain('iniciado');
  });

  it('não lança quando mkdir rejeita', async () => {
    mockMkdir.mockRejectedValue(new Error('sem permissão'));
    await expect(initLogger()).resolves.toBeUndefined();
  });

  it('não lança quando appendFile rejeita', async () => {
    mockAppendFile.mockRejectedValue(new Error('disco cheio'));
    await expect(initLogger()).resolves.toBeUndefined();
  });
});

// ─── logInfo ───────────────────────────────────────────────────────────────────

describe('logInfo()', () => {
  it('chama appendFile com entrada JSON de nível info', async () => {
    await logInfo('TestComp', 'mensagem informativa');
    expect(mockAppendFile).toHaveBeenCalled();
    const line = mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1];
    const record = JSON.parse(line);
    expect(record.level).toBe('info');
    expect(record.component).toBe('TestComp');
    expect(record.message).toBe('mensagem informativa');
  });

  it('a linha termina com newline', async () => {
    await logInfo('C', 'msg');
    const line = mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1];
    expect(line.endsWith('\n')).toBe(true);
  });

  it('não lança quando appendFile rejeita', async () => {
    mockAppendFile.mockRejectedValue(new Error('erro io'));
    await expect(logInfo('C', 'msg')).resolves.toBeUndefined();
  });
});

// ─── logWarn ───────────────────────────────────────────────────────────────────

describe('logWarn()', () => {
  it('chama appendFile com entrada JSON de nível warn', async () => {
    await logWarn('TestComp', 'aviso importante');
    const line = mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1];
    const record = JSON.parse(line);
    expect(record.level).toBe('warn');
    expect(record.component).toBe('TestComp');
    expect(record.message).toBe('aviso importante');
  });
});

// ─── logError ──────────────────────────────────────────────────────────────────

describe('logError()', () => {
  it('chama appendFile com entrada JSON de nível error', async () => {
    await logError('TestComp', 'erro crítico');
    const line = mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1];
    const record = JSON.parse(line);
    expect(record.level).toBe('error');
    expect(record.component).toBe('TestComp');
    expect(record.message).toBe('erro crítico');
  });

  it('a entrada inclui timestamp ISO', async () => {
    await logError('C', 'msg');
    const line = mockAppendFile.mock.calls[mockAppendFile.mock.calls.length - 1][1];
    const record = JSON.parse(line);
    expect(typeof record.ts).toBe('string');
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── readRecentLogEntries ──────────────────────────────────────────────────────

describe('readRecentLogEntries()', () => {
  it('retorna array de entradas parseadas do arquivo de log', async () => {
    const entries = [
      { ts: '2026-01-01T10:00:00.000Z', level: 'info', component: 'Bot', message: 'online' },
      { ts: '2026-01-01T10:01:00.000Z', level: 'error', component: 'Session', message: 'falhou' },
    ];
    mockReadFile.mockResolvedValue(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const result = await readRecentLogEntries();
    expect(result).toHaveLength(2);
    expect(result[0].level).toBe('info');
    expect(result[1].level).toBe('error');
  });

  it('retorna array vazio quando o arquivo não existe', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await readRecentLogEntries();
    expect(result).toEqual([]);
  });

  it('descarta linhas com JSON inválido', async () => {
    mockReadFile.mockResolvedValue('{"ts":"2026-01-01","level":"info","component":"X","message":"ok"}\nLINHA_INVALIDA\n');
    const result = await readRecentLogEntries();
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('ok');
  });

  it('respeita o limite passado como argumento', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', component: 'X', message: `msg${i}` })
    ).join('\n') + '\n';
    mockReadFile.mockResolvedValue(lines);

    const result = await readRecentLogEntries(3);
    expect(result).toHaveLength(3);
    // Deve retornar as últimas 3 entradas
    expect(result[2].message).toBe('msg9');
  });

  it('retorna todas as entradas quando limit é 0', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', component: 'X', message: `msg${i}` })
    ).join('\n') + '\n';
    mockReadFile.mockResolvedValue(lines);

    const result = await readRecentLogEntries(0);
    expect(result).toHaveLength(5);
  });
});

// ─── _resetLogger ──────────────────────────────────────────────────────────────

describe('_resetLogger()', () => {
  it('faz com que ensureDir chame mkdir novamente na próxima escrita', async () => {
    // Primeira chamada inicializa
    await logInfo('C', 'primeiro');
    const firstCallCount = mockMkdir.mock.calls.length;

    // Resetar deve permitir nova chamada de mkdir
    _resetLogger();
    await logInfo('C', 'segundo');
    expect(mockMkdir.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});
