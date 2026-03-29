// tests/console-logger.test.js
// Testes unitários para src/console-logger.js

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks estáticos de node:fs ───────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:fs', () => fsMock);

// ─── Estado original do console e stderr ─────────────────────────────────────

const _origConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};
const _origStderrWrite = process.stderr.write;

// ─── Setup e teardown ─────────────────────────────────────────────────────────

let initConsoleLogger, getCurrentLogFile;

beforeEach(async () => {
  vi.resetModules();
  fsMock.mkdirSync.mockReset();
  fsMock.appendFileSync.mockReset();
  fsMock.readdirSync.mockReset().mockReturnValue([]);
  fsMock.statSync.mockReset();
  fsMock.unlinkSync.mockReset();

  // Recarrega o módulo com estado limpo (_active = false, _logFile = null)
  const mod = await import('../src/console-logger.js');
  initConsoleLogger = mod.initConsoleLogger;
  getCurrentLogFile = mod.getCurrentLogFile;
});

afterEach(() => {
  // Restaura console e stderr originais para não infectar outros testes
  console.log = _origConsole.log;
  console.warn = _origConsole.warn;
  console.error = _origConsole.error;
  console.info = _origConsole.info;
  process.stderr.write = _origStderrWrite;
});

// ─── getCurrentLogFile() ──────────────────────────────────────────────────────

describe('getCurrentLogFile()', () => {
  it('retorna null antes de initConsoleLogger ser chamado', () => {
    expect(getCurrentLogFile()).toBeNull();
  });

  it('retorna string não-nula após initConsoleLogger ser chamado', () => {
    initConsoleLogger();
    const logFile = getCurrentLogFile();
    expect(typeof logFile).toBe('string');
    expect(logFile.length).toBeGreaterThan(0);
  });

  it('retorna caminho que contém o prefixo "bot-" e extensão ".log"', () => {
    initConsoleLogger();
    const logFile = getCurrentLogFile();
    expect(logFile).toMatch(/bot-\d{4}-\d{2}-\d{2}\.log$/);
  });
});

// ─── initConsoleLogger() — inicialização ─────────────────────────────────────

describe('initConsoleLogger() — inicialização', () => {
  it('chama mkdirSync com { recursive: true } para criar o diretório de logs', () => {
    initConsoleLogger();
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });

  it('chama readdirSync para limpar logs antigos na inicialização', () => {
    initConsoleLogger();
    expect(fsMock.readdirSync).toHaveBeenCalledOnce();
  });

  it('é idempotente — segunda chamada não chama mkdirSync novamente', () => {
    initConsoleLogger();
    fsMock.mkdirSync.mockClear();
    initConsoleLogger(); // segunda chamada — deve ser no-op
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it('é idempotente — segunda chamada não substitui console novamente', () => {
    initConsoleLogger();
    const patchedLog = console.log; // referência após primeiro patch
    initConsoleLogger(); // segunda chamada
    expect(console.log).toBe(patchedLog); // função não mudou
  });

  it('não lança quando mkdirSync falha', () => {
    fsMock.mkdirSync.mockImplementation(() => { throw new Error('sem permissão'); });
    expect(() => initConsoleLogger()).not.toThrow();
  });
});

// ─── initConsoleLogger() — interceptação de console ──────────────────────────

describe('initConsoleLogger() — interceptação de console', () => {
  beforeEach(() => {
    initConsoleLogger();
    fsMock.appendFileSync.mockClear(); // limpa chamadas da inicialização
  });

  it('console.log() chama appendFileSync com nível INFO', () => {
    console.log('mensagem de teste');
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('[INFO]');
    expect(line).toContain('mensagem de teste');
  });

  it('console.warn() chama appendFileSync com nível WARN', () => {
    console.warn('aviso importante');
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('[WARN]');
    expect(line).toContain('aviso importante');
  });

  it('console.error() chama appendFileSync com nível ERROR', () => {
    console.error('erro crítico');
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('[ERROR]');
    expect(line).toContain('erro crítico');
  });

  it('console.info() chama appendFileSync com nível INFO', () => {
    console.info('informação do sistema');
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('[INFO]');
    expect(line).toContain('informação do sistema');
  });

  it('log contém timestamp ISO 8601', () => {
    console.log('teste de timestamp');
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('argumentos objeto são serializados como JSON', () => {
    console.log({ chave: 'valor', numero: 42 });
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('"chave"');
    expect(line).toContain('"valor"');
  });

  it('múltiplos argumentos são concatenados com espaço', () => {
    console.log('parte1', 'parte2', 'parte3');
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('parte1 parte2 parte3');
  });

  it('não lança quando appendFileSync falha', () => {
    fsMock.appendFileSync.mockImplementation(() => { throw new Error('disco cheio'); });
    expect(() => console.log('teste')).not.toThrow();
  });

  it('process.stderr.write chama appendFileSync com nível error', () => {
    process.stderr.write('stderr output\n');
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const [, line] = fsMock.appendFileSync.mock.calls[0];
    expect(line).toContain('[ERROR]');
    expect(line).toContain('stderr output');
  });
});

// ─── Limpeza de logs antigos ──────────────────────────────────────────────────

describe('cleanOldLogs()', () => {
  it('remove arquivo de log com mais de 24h', () => {
    const ageMsOver24h = 25 * 60 * 60 * 1000; // 25 horas
    fsMock.readdirSync.mockReturnValue(['bot-2025-01-01.log']);
    fsMock.statSync.mockReturnValue({ mtimeMs: Date.now() - ageMsOver24h });

    initConsoleLogger();

    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('não remove arquivo de log com menos de 24h', () => {
    const ageMsUnder24h = 2 * 60 * 60 * 1000; // 2 horas
    fsMock.readdirSync.mockReturnValue(['bot-2025-01-02.log']);
    fsMock.statSync.mockReturnValue({ mtimeMs: Date.now() - ageMsUnder24h });

    initConsoleLogger();

    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('ignora arquivos que não seguem o padrão bot-*.log', () => {
    fsMock.readdirSync.mockReturnValue(['app.log', 'debug.txt', 'README.md']);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0 }); // Tempo antigo

    initConsoleLogger();

    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    expect(fsMock.statSync).not.toHaveBeenCalled();
  });

  it('trata exceção de statSync graciosamente sem lançar', () => {
    fsMock.readdirSync.mockReturnValue(['bot-2025-01-01.log']);
    fsMock.statSync.mockImplementation(() => { throw new Error('acesso negado'); });

    expect(() => initConsoleLogger()).not.toThrow();
  });

  it('trata exceção de readdirSync graciosamente sem lançar', () => {
    fsMock.readdirSync.mockImplementation(() => { throw new Error('pasta não existe'); });

    expect(() => initConsoleLogger()).not.toThrow();
  });
});
