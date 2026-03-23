// tests/reporter.test.js
// Testes unitários para src/reporter.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock discord.js ─────────────────────────────────────────────────────────

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

// ─── Imports após configuração dos mocks ─────────────────────────────────────

import { analyzeOutput, captureThreadMessages, formatReportText, buildReportEmbed } from '../src/reporter.js';

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

// ─── analyzeOutput ────────────────────────────────────────────────────────────

describe('analyzeOutput()', () => {
  it('detecta runtime_error em output com "TypeError: Cannot read"', () => {
    const output = 'Running task...\nTypeError: Cannot read properties of undefined\n  at foo.js:10';
    const result = analyzeOutput(output, 'error');

    const runtimeErr = result.errors.find((e) => e.id === 'runtime_error');
    expect(runtimeErr).toBeDefined();
    expect(runtimeErr.category).toBe('Erro em Tempo de Execução');
  });

  it('detecta permission_error em output com "EACCES"', () => {
    const output = 'Error: EACCES: permission denied, open \'/etc/passwd\'';
    const result = analyzeOutput(output, 'error');

    const permErr = result.errors.find((e) => e.id === 'permission_error');
    expect(permErr).toBeDefined();
    expect(permErr.category).toBe('Erro de Permissão');
  });

  it('detecta not_found em output com "ENOENT"', () => {
    const output = 'Error: ENOENT: no such file or directory, open \'./config.json\'';
    const result = analyzeOutput(output, 'error');

    const notFoundErr = result.errors.find((e) => e.id === 'not_found');
    expect(notFoundErr).toBeDefined();
    expect(notFoundErr.category).toBe('Arquivo ou Módulo Não Encontrado');
  });

  it('detecta network_error em output com "ECONNREFUSED"', () => {
    const output = 'Error: ECONNREFUSED 127.0.0.1:3000';
    const result = analyzeOutput(output, 'error');

    const netErr = result.errors.find((e) => e.id === 'network_error');
    expect(netErr).toBeDefined();
    expect(netErr.category).toBe('Erro de Rede/Conexão');
  });

  it('detecta rate_limit em output com "rate limit exceeded"', () => {
    const output = 'API call failed: rate limit exceeded, retry after 60s';
    const result = analyzeOutput(output, 'running');

    const rlErr = result.errors.find((e) => e.id === 'rate_limit');
    expect(rlErr).toBeDefined();
    expect(rlErr.category).toBe('Limite de Taxa Atingido');
  });

  it('retorna array vazio para output sem erros', () => {
    const output = 'Tarefa concluída com sucesso.\nArquivos gerados: 3\nTudo OK!';
    const result = analyzeOutput(output, 'finished');

    expect(result.errors).toHaveLength(0);
  });

  it('adiciona empty_output quando output é vazio e status é "finished"', () => {
    const result = analyzeOutput('', 'finished');

    const emptyErr = result.errors.find((e) => e.id === 'empty_output');
    expect(emptyErr).toBeDefined();
    expect(emptyErr.category).toBe('Output Vazio');
  });

  it('não adiciona empty_output quando output é vazio e status é "running"', () => {
    const result = analyzeOutput('', 'running');
    expect(result.errors).toHaveLength(0);
  });

  it('retorna suggestedActions não-vazio quando erros são detectados', () => {
    const output = 'TypeError: Cannot read properties of undefined';
    const result = analyzeOutput(output, 'error');

    expect(result.suggestedActions.length).toBeGreaterThan(0);
  });

  it('summary contém o número de problemas quando há erros', () => {
    const output = 'TypeError: Cannot read properties of undefined';
    const result = analyzeOutput(output, 'error');

    expect(result.summary).toMatch(/\d+ problema\(s\) detectado\(s\)/);
  });

  it('summary indica nenhum problema quando output é limpo', () => {
    const output = 'Tudo certo.';
    const result = analyzeOutput(output, 'finished');

    expect(result.summary).toMatch(/nenhum problema/i);
  });

  it('deduplica matches idênticos do mesmo padrão', () => {
    const output = 'TypeError: Cannot read properties of undefined\nalguma coisa\nTypeError: Cannot read properties of undefined';
    const result = analyzeOutput(output, 'error');
    const runtimeErrors = result.errors.filter((e) => e.id === 'runtime_error');
    expect(runtimeErrors).toHaveLength(1);
  });

  it('limita a 3 ocorrências por padrão', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `TypeError: erro número ${i}`);
    const output = lines.join('\n');
    const result = analyzeOutput(output, 'error');
    const runtimeErrors = result.errors.filter((e) => e.id === 'runtime_error');
    expect(runtimeErrors).toHaveLength(3);
  });

  it('detecta syntax_error no output', () => {
    const output = 'SyntaxError: Unexpected token } in JSON at position 42';
    const result = analyzeOutput(output, 'error');
    expect(result.errors.some((e) => e.id === 'syntax_error')).toBe(true);
  });

  it('detecta timeout no output', () => {
    const output = 'Operation timed out after 30000ms';
    const result = analyzeOutput(output, 'error');
    expect(result.errors.some((e) => e.id === 'timeout')).toBe(true);
  });

  it('detecta api_error no output', () => {
    const output = 'Request failed: HTTP 500 Internal Server Error';
    const result = analyzeOutput(output, 'error');
    expect(result.errors.some((e) => e.id === 'api_error')).toBe(true);
  });
});

// ─── formatReportText ─────────────────────────────────────────────────────────

describe('formatReportText()', () => {
  it('contém o reportId no texto', () => {
    const data = makeReportData();
    const text = formatReportText(data);
    expect(text).toContain('RPT-TEST123');
  });

  it('contém a descrição no texto', () => {
    const data = makeReportData();
    const text = formatReportText(data);
    expect(text).toContain('O agente parou de responder sem motivo aparente.');
  });

  it('contém a severidade no texto', () => {
    const data = makeReportData();
    const text = formatReportText(data);
    expect(text).toContain('MEDIUM');
  });

  it('funciona sem sessão (session: null)', () => {
    const data = makeReportData({ session: null });
    expect(() => formatReportText(data)).not.toThrow();
    const text = formatReportText(data);
    expect(text).toContain('RPT-TEST123');
  });

  it('inclui histórico de mensagens quando presente', () => {
    const data = makeReportData();
    const text = formatReportText(data);
    expect(text).toContain('HISTÓRICO DA THREAD');
    expect(text).toContain('Inicia a task X');
  });

  it('não inclui seção de histórico quando threadMessages está vazio', () => {
    const data = makeReportData({ threadMessages: [] });
    const text = formatReportText(data);
    expect(text).not.toContain('HISTÓRICO DA THREAD');
  });
});

// ─── buildReportEmbed ─────────────────────────────────────────────────────────

describe('buildReportEmbed()', () => {
  it('retorna objeto com .data.color correto para severidade "critical"', () => {
    const data = makeReportData({ severity: 'critical' });
    const embed = buildReportEmbed(data);
    expect(embed.data.color).toBe(0xFF0000);
  });

  it('retorna objeto com .data.color correto para severidade "high"', () => {
    const data = makeReportData({ severity: 'high' });
    const embed = buildReportEmbed(data);
    expect(embed.data.color).toBe(0xFF6600);
  });

  it('retorna objeto com .data.color correto para severidade "medium"', () => {
    const data = makeReportData({ severity: 'medium' });
    const embed = buildReportEmbed(data);
    expect(embed.data.color).toBe(0xFFCC00);
  });

  it('retorna objeto com .data.color correto para severidade "low"', () => {
    const data = makeReportData({ severity: 'low' });
    const embed = buildReportEmbed(data);
    expect(embed.data.color).toBe(0x0099FF);
  });

  it('título do embed contém "Relatório"', () => {
    const data = makeReportData();
    const embed = buildReportEmbed(data);
    expect(embed.data.title).toContain('Relatório');
  });

  it('título do embed contém o reportId', () => {
    const data = makeReportData();
    const embed = buildReportEmbed(data);
    expect(embed.data.title).toContain('RPT-TEST123');
  });

  it('funciona sem sessão (session: null)', () => {
    const data = makeReportData({ session: null });
    expect(() => buildReportEmbed(data)).not.toThrow();
    const embed = buildReportEmbed(data);
    expect(embed.data.title).toContain('Relatório');
  });

  it('adiciona campo de problemas detectados quando há erros na análise', () => {
    const data = makeReportData({
      analysis: {
        errors: [
          {
            id: 'runtime_error',
            category: 'Erro em Tempo de Execução',
            match: 'TypeError: Cannot read',
            context: 'TypeError: Cannot read properties',
            suggestion: 'Verifique o stack trace.',
          },
        ],
        suggestedActions: ['Verifique o stack trace.'],
        summary: '1 problema(s) detectado(s) no output da sessão.',
      },
    });
    const embed = buildReportEmbed(data);
    const problemField = embed.data.fields.find((f) => f.name === '🐛 Problemas Detectados');
    expect(problemField).toBeDefined();
  });

  it('não adiciona campo de sessão quando session é null', () => {
    const data = makeReportData({ session: null });
    const embed = buildReportEmbed(data);
    const semSessao = embed.data.fields.find((f) => f.name === '📌 Sessão');
    expect(semSessao).toBeDefined();
    const projectField = embed.data.fields.find((f) => f.name === '📁 Projeto');
    expect(projectField).toBeUndefined();
  });
});

// ─── captureThreadMessages ────────────────────────────────────────────────────

describe('captureThreadMessages()', () => {
  it('converte Collection do Discord para array de objetos simples', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const mockMessages = new Map([
      ['msg-1', {
        author: { username: 'alice', bot: false },
        content: 'Olá mundo',
        createdAt: now,
        createdTimestamp: now.getTime(),
      }],
    ]);
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(mockMessages) },
    };

    const result = await captureThreadMessages(mockChannel, 50);

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('alice');
    expect(result[0].content).toBe('Olá mundo');
    expect(result[0].isBot).toBe(false);
    expect(mockChannel.messages.fetch).toHaveBeenCalledWith({ limit: 50 });
  });

  it('retorna array vazio quando não há mensagens', async () => {
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };
    const result = await captureThreadMessages(mockChannel);
    expect(result).toHaveLength(0);
  });

  it('usa limit padrão de 100 quando não especificado', async () => {
    const mockChannel = {
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };
    await captureThreadMessages(mockChannel);
    expect(mockChannel.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
  });
});
