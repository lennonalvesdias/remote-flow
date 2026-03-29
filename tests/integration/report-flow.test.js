// tests/integration/report-flow.test.js
// Testa o fluxo completo de geração de relatórios: captura de mensagens,
// análise de output, formatação e construção do embed Discord.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock discord.js ──────────────────────────────────────────────────────────

vi.mock('discord.js', () => {
  /**
   * EmbedBuilder simplificado para testes — espelha o comportamento do discord.js v14.
   * Armazena campos em `this.data` assim como a implementação real.
   */
  class EmbedBuilder {
    constructor() {
      this.data = { fields: [] };
    }
    setTitle(title)      { this.data.title = title;    return this; }
    setColor(color)      { this.data.color = color;    return this; }
    setTimestamp(ts)     { this.data.timestamp = ts;   return this; }
    setFooter(footer)    { this.data.footer = footer;  return this; }
    addFields(...fields) {
      const flat = fields.flat();
      this.data.fields.push(...flat);
      return this;
    }
  }
  return { EmbedBuilder };
});

// ─── Mock logger.js para evitar I/O em filesystem ────────────────────────────

vi.mock('../../src/logger.js', () => ({
  readRecentLogEntries: vi.fn().mockResolvedValue([]),
}));

// ─── Imports após configuração dos mocks ─────────────────────────────────────

import {
  analyzeOutput,
  captureThreadMessages,
  formatReportText,
  buildReportEmbed,
} from '../../src/reporter.js';
import { createMockThread } from '@helpers/discord-mocks.js';

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Cria dados de relatório mínimos para testes de formatReportText e buildReportEmbed.
 * @param {object} [overrides]
 * @returns {object}
 */
function makeReportData(overrides = {}) {
  return {
    reportId: 'RPT-TEST123',
    timestamp: new Date('2026-01-01T12:00:00.000Z'),
    reporter: {
      id: 'user-123',
      username: 'testuser',
      displayName: 'Test User',
    },
    description: 'O agente parou de responder sem motivo aparente.',
    severity: 'medium',
    session: {
      sessionId: 'sess-abc',
      projectPath: '/projetos/meu-app',
      agent: 'build',
      model: 'anthropic/claude-sonnet',
      status: 'error',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
      closedAt: new Date('2026-01-01T11:55:00.000Z'),
      lastActivityAt: new Date('2026-01-01T11:54:00.000Z'),
    },
    threadMessages: [
      {
        author: 'testuser',
        content: 'Inicia a task X',
        timestamp: new Date('2026-01-01T11:01:00.000Z'),
        isBot: false,
      },
    ],
    sessionOutput: 'Processando...\nFeito.',
    analysis: {
      errors: [],
      suggestedActions: [],
      summary: 'Nenhum problema detectado automaticamente no output.',
    },
    ...overrides,
  };
}

// ─── Captura de mensagens ─────────────────────────────────────────────────────

describe('Fluxo de relatório — Captura de mensagens', () => {
  it('captura mensagens do thread para análise', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const mockMessages = new Map([
      ['msg-1', {
        author: { username: 'alice', bot: false },
        content: 'Mensagem de teste',
        createdAt: now,
        createdTimestamp: now.getTime(),
      }],
    ]);
    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(mockMessages);

    const result = await captureThreadMessages(thread);

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('alice');
    expect(result[0].content).toBe('Mensagem de teste');
    expect(result[0].isBot).toBe(false);
  });

  it('captura mensagens respeitando o limite máximo de 100 da API do Discord', async () => {
    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(new Map());

    await captureThreadMessages(thread, 200);

    // Math.min(200, 100) = 100 — API do Discord limita a 100 por requisição
    expect(thread.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
  });

  it('realiza apenas uma chamada fetch (sem paginação)', async () => {
    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(new Map());

    await captureThreadMessages(thread, 200);

    expect(thread.messages.fetch).toHaveBeenCalledOnce();
  });

  it('retorna array vazio quando não há mensagens na thread', async () => {
    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(new Map());

    const result = await captureThreadMessages(thread);

    expect(result).toHaveLength(0);
  });
});

// ─── Análise de output ────────────────────────────────────────────────────────

describe('Fluxo de relatório — Análise de output', () => {
  it('detecta erro de runtime no output', () => {
    const output = 'TypeError: Cannot read properties of undefined\n  at foo.js:10';
    const result = analyzeOutput(output, 'error');

    const runtimeErr = result.errors.find((e) => e.id === 'runtime_error');
    expect(runtimeErr).toBeDefined();
    expect(runtimeErr.category).toBe('Erro em Tempo de Execução');
  });

  it('detecta erro de permissão no output', () => {
    const output = 'Error: EACCES: permission denied, open \'/etc/shadow\'';
    const result = analyzeOutput(output, 'error');

    const permErr = result.errors.find((e) => e.id === 'permission_error');
    expect(permErr).toBeDefined();
    expect(permErr.category).toBe('Erro de Permissão');
  });

  it('detecta output limpo sem erros', () => {
    const output = 'Build concluído com sucesso.\nArquivos gerados: 5\nTudo OK!';
    const result = analyzeOutput(output, 'finished');

    expect(result.errors).toHaveLength(0);
    expect(result.summary).toMatch(/nenhum problema/i);
  });

  it('detecta rate limit no output', () => {
    const output = 'API call failed: rate limit exceeded, retry after 60s';
    const result = analyzeOutput(output, 'running');

    const rlErr = result.errors.find((e) => e.id === 'rate_limit');
    expect(rlErr).toBeDefined();
    expect(rlErr.category).toBe('Limite de Taxa Atingido');
  });

  it('detecta timeout no output', () => {
    const output = 'Operation timed out after 30000ms';
    const result = analyzeOutput(output, 'error');

    expect(result.errors.some((e) => e.id === 'timeout')).toBe(true);
  });
});

// ─── Formatação de relatório ──────────────────────────────────────────────────

describe('Fluxo de relatório — Formatação', () => {
  it('formata relatório com informações da sessão', () => {
    const data = makeReportData({ severity: 'high' });
    const text = formatReportText(data);

    expect(text).toContain('RPT-TEST123');
    expect(text).toContain('/projetos/meu-app');
    expect(text).toContain('build');
    expect(text).toContain('HIGH');
  });

  it('buildReportEmbed usa cor correta para severidade "critical"', () => {
    const embed = buildReportEmbed(makeReportData({ severity: 'critical' }));
    expect(embed.data.color).toBe(0xFF0000);
  });

  it('buildReportEmbed usa cor correta para severidade "high"', () => {
    const embed = buildReportEmbed(makeReportData({ severity: 'high' }));
    expect(embed.data.color).toBe(0xFF6600);
  });

  it('buildReportEmbed usa cor correta para severidade "medium"', () => {
    const embed = buildReportEmbed(makeReportData({ severity: 'medium' }));
    expect(embed.data.color).toBe(0xFFCC00);
  });

  it('buildReportEmbed usa cor correta para severidade "low"', () => {
    const embed = buildReportEmbed(makeReportData({ severity: 'low' }));
    expect(embed.data.color).toBe(0x0099FF);
  });
});

// ─── Fluxo completo /report ───────────────────────────────────────────────────

describe('Fluxo de relatório — Fluxo completo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gera e envia embed de relatório ao Discord com detecção de erro', async () => {
    const errorTimestamp = new Date('2026-01-01T12:05:00.000Z');
    const mockMessages = new Map([
      ['msg-1', {
        author: { username: 'testuser', bot: false },
        content: 'Inicia a task X',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        createdTimestamp: new Date('2026-01-01T12:00:00.000Z').getTime(),
      }],
      ['msg-2', {
        author: { username: 'Bot', bot: true },
        content: 'TypeError: Cannot read properties of undefined reading "map"',
        createdAt: errorTimestamp,
        createdTimestamp: errorTimestamp.getTime(),
      }],
    ]);

    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(mockMessages);

    // 1. Captura mensagens da thread
    const messages = await captureThreadMessages(thread);
    expect(messages).toHaveLength(2);

    // 2. Analisa output da sessão que continha o TypeError
    const sessionOutput = 'Executando tarefa...\nTypeError: Cannot read properties of undefined reading "map"\n  at processData (src/utils.js:42:15)';
    const analysis = analyzeOutput(sessionOutput, 'error');
    expect(analysis.errors.some((e) => e.id === 'runtime_error')).toBe(true);

    // 3. Constrói embed com severidade "high" pelo erro detectado
    const reportData = makeReportData({
      severity: 'high',
      threadMessages: messages,
      sessionOutput,
      analysis,
    });

    const embed = buildReportEmbed(reportData);

    // Verifica estrutura do embed
    expect(embed.data.title).toContain('Relatório');
    expect(embed.data.color).toBe(0xFF6600); // high = laranja
    const problemField = embed.data.fields.find((f) => f.name === '🐛 Problemas Detectados');
    expect(problemField).toBeDefined();
  });

  it('fluxo de relatório sem erros gera embed com cor medium', async () => {
    const thread = createMockThread();
    thread.messages.fetch.mockResolvedValue(new Map([
      ['msg-1', {
        author: { username: 'testuser', bot: false },
        content: 'Solicitação concluída',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        createdTimestamp: new Date('2026-01-01T12:00:00.000Z').getTime(),
      }],
    ]));

    const messages = await captureThreadMessages(thread);
    const sessionOutput = 'Tarefa concluída com sucesso.\nResultado: OK';
    const analysis = analyzeOutput(sessionOutput, 'finished');

    expect(analysis.errors).toHaveLength(0);

    const reportData = makeReportData({
      severity: 'medium',
      threadMessages: messages,
      sessionOutput,
      analysis,
    });

    const embed = buildReportEmbed(reportData);

    expect(embed.data.title).toContain('Relatório');
    expect(embed.data.color).toBe(0xFFCC00); // medium = amarelo
  });
});
