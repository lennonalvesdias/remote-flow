// src/reporter.js
// Módulo de análise e geração de relatórios de comportamento inesperado de sessões

import { EmbedBuilder } from 'discord.js';
import { readRecentLogEntries } from './logger.js';

// ─── Constantes ────────────────────────────────────────────────────────────────

/** Cores por nível de severidade para embeds do Discord */
const SEVERITY_COLORS = {
  critical: 0xFF0000, // vermelho
  high:     0xFF6600, // laranja
  medium:   0xFFCC00, // amarelo
  low:      0x0099FF, // azul
};

/** Rótulos PT-BR por nível de severidade */
const SEVERITY_LABELS = {
  critical: '🔴 Crítica',
  high:     '🟠 Alta',
  medium:   '🟡 Média',
  low:      '🔵 Baixa',
};

/** Padrões de detecção de erros no output da sessão */
const ERROR_PATTERNS = [
  {
    id: 'runtime_error',
    regex: /(?:^|\n)(.*(?:Error|TypeError|RangeError|ReferenceError|EvalError|URIError):\s+.+)/gm,
    category: 'Erro em Tempo de Execução',
    suggestion: 'Verifique o stack trace acima para identificar a linha e função que originou o erro. Corrija o código apontado.',
  },
  {
    id: 'syntax_error',
    regex: /(?:^|\n)(.*(?:SyntaxError|Unexpected token|Cannot parse|Unexpected end of JSON|JSON\.parse).+)/gm,
    category: 'Erro de Sintaxe',
    suggestion: 'Verifique a sintaxe do arquivo indicado. Pode ser um JSON malformado ou erro de código.',
  },
  {
    id: 'permission_error',
    regex: /(?:^|\n)(.*(?:Permission denied|EACCES|EPERM|not permitted|Access is denied).+)/gm,
    category: 'Erro de Permissão',
    suggestion: 'Verifique se o processo tem permissão para acessar o arquivo ou diretório indicado. Execute como administrador se necessário.',
  },
  {
    id: 'not_found',
    regex: /(?:^|\n)(.*(?:ENOENT|Cannot find module|not found|no such file or directory|Module not found).+)/gm,
    category: 'Arquivo ou Módulo Não Encontrado',
    suggestion: 'Verifique se o caminho do arquivo está correto e se o módulo está instalado (npm install).',
  },
  {
    id: 'network_error',
    regex: /(?:^|\n)(.*(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|fetch failed|ENOTFOUND|network|connection refused).+)/gim,
    category: 'Erro de Rede/Conexão',
    suggestion: 'Verifique sua conexão de internet e se o servidor de destino está acessível.',
  },
  {
    id: 'rate_limit',
    regex: /(?:^|\n)(.*(?:rate limit|rate_limit|429|too many requests|quota exceeded).+)/gim,
    category: 'Limite de Taxa Atingido',
    suggestion: 'Aguarde alguns minutos e tente novamente. Considere reduzir a frequência de requisições.',
  },
  {
    id: 'timeout',
    regex: /(?:^|\n)(.*(?:\btimeout\b|timed out|operation timed|exceeded.*time|time.*exceeded).+)/gim,
    category: 'Timeout',
    suggestion: 'O processo demorou mais que o esperado. Tente dividir a tarefa em partes menores ou aumentar o timeout.',
  },
  {
    id: 'api_error',
    regex: /(?:^|\n)(.*(?:HTTP [45]\d\d|status [45]\d\d|Error [45]\d\d|4\d\d Error|5\d\d Error).+)/gim,
    category: 'Erro de API HTTP',
    suggestion: 'Verifique as credenciais de API, endpoint e formato dos dados enviados.',
  },
];

// ─── Utilitários internos ─────────────────────────────────────────────────────

/**
 * Extrai contexto (±2 linhas) ao redor de uma correspondência no texto.
 * @param {string} text - Texto completo
 * @param {string} match - Trecho encontrado
 * @returns {string} - Contexto com ±2 linhas
 */
function extractContext(text, match) {
  const lines = text.split('\n');
  const matchIndex = lines.findIndex((line) => line.includes(match.trim()));
  if (matchIndex === -1) return match;
  const start = Math.max(0, matchIndex - 2);
  const end = Math.min(lines.length - 1, matchIndex + 2);
  return lines.slice(start, end + 1).join('\n');
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Lê as últimas `limit` entradas do arquivo de log persistente da aplicação.
 * @param {number} [limit=200] - Máximo de entradas a retornar
 * @returns {Promise<Array<{ts: string, level: string, component: string, message: string}>>}
 */
export async function readRecentLogs(limit = 200) {
  return readRecentLogEntries(limit);
}

/**
 * Analisa entradas de log do bot e retorna erros e avisos recentes.
 * @param {Array<{ts: string, level: string, component: string, message: string}>} entries
 * @returns {{ errors: Array, warnings: Array, summary: string }}
 */
export function analyzeLogEntries(entries) {
  if (!entries || entries.length === 0) {
    return { errors: [], warnings: [], summary: 'Nenhuma entrada de log disponível.' };
  }
  const errors = entries.filter((e) => e.level === 'error');
  const warnings = entries.filter((e) => e.level === 'warn');
  const total = errors.length + warnings.length;
  const summary = total === 0
    ? 'Nenhum erro ou aviso encontrado nos logs recentes do bot.'
    : `${errors.length} erro(s) e ${warnings.length} aviso(s) encontrado(s) nos logs recentes.`;
  return { errors, warnings, summary };
}

/**
 * Analisa o output de uma sessão e retorna erros detectados + sugestões.
 * @param {string} output - Output completo da sessão
 * @param {string} status - Status final da sessão
 * @returns {{ errors: Array, suggestedActions: string[], summary: string }}
 */
export function analyzeOutput(output, status) {
  const errors = [];
  const suggestedActions = [];
  const seen = new Set();

  // Guard: output vazio com sessão finalizada é sinal suspeito
  if (!output || output.trim() === '') {
    if (status === 'finished' || status === 'error') {
      errors.push({
        id: 'empty_output',
        category: 'Output Vazio',
        match: '',
        context: '',
        suggestion: 'A sessão finalizou sem produzir nenhum output. Isso pode indicar falha silenciosa.',
      });
    }
    const summary = errors.length === 0
      ? 'Nenhum problema detectado automaticamente.'
      : `${errors.length} problema(s) detectado(s) no output da sessão.`;
    return { errors, suggestedActions, summary };
  }

  for (const pattern of ERROR_PATTERNS) {
    // Criar instância fresca a cada chamada — regex com flag 'g' é stateful (lastIndex)
    const freshRegex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of output.matchAll(freshRegex)) {
      const matchText = (match[1] || match[0]).trim();
      // Dedup por padrão + texto para evitar duplicatas dentro do mesmo padrão
      const dedupKey = `${pattern.id}:${matchText}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      errors.push({
        id: pattern.id,
        category: pattern.category,
        match: matchText,
        context: extractContext(output, matchText),
        suggestion: pattern.suggestion,
      });
      if (!suggestedActions.includes(pattern.suggestion)) {
        suggestedActions.push(pattern.suggestion);
      }
      // Limitar a 3 ocorrências por padrão para não inflar o relatório
      if (errors.filter((e) => e.id === pattern.id).length >= 3) break;
    }
  }

  const summary = errors.length === 0
    ? 'Nenhum problema detectado automaticamente no output.'
    : `${errors.length} problema(s) detectado(s) no output da sessão.`;

  return { errors, suggestedActions, summary };
}

/**
 * Captura mensagens de uma thread Discord (até `limit` mensagens).
 * @param {import('discord.js').ThreadChannel} channel
 * @param {number} limit - Máximo de mensagens a capturar (limitado a 100 pela API do Discord)
 * @returns {Promise<Array<{author: string, content: string, timestamp: Date, isBot: boolean}>>}
 */
export async function captureThreadMessages(channel, limit = 100) {
  const fetched = await channel.messages.fetch({ limit: Math.min(limit, 100) });
  const msgs = [...fetched.values()];
  return msgs
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((msg) => ({
      author: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt,
      isBot: msg.author.bot,
    }));
}

/**
 * Formata o relatório completo como texto simples.
 * @param {Object} data - Dados do relatório
 * @returns {string}
 */
export function formatReportText(data) {
  const {
    reportId,
    timestamp,
    reporter,
    description,
    severity,
    session,
    threadMessages,
    sessionOutput,
    analysis,
    logEntries,
  } = data;

  const lines = [];
  const hr = '='.repeat(60);
  const divider = '-'.repeat(60);

  lines.push(hr);
  lines.push('REMOTEFLOW — RELATÓRIO DE COMPORTAMENTO INESPERADO');
  lines.push(hr);
  lines.push('');
  lines.push(`ID do Relatório : ${reportId}`);
  lines.push(`Data/Hora       : ${timestamp.toISOString()}`);
  lines.push(`Severidade      : ${severity.toUpperCase()}`);
  lines.push(`Reportado por   : ${reporter.displayName ?? reporter.username} (${reporter.id})`);
  lines.push('');

  lines.push('DESCRIÇÃO DO PROBLEMA');
  lines.push(divider);
  lines.push(description);
  lines.push('');

  if (session) {
    lines.push('INFORMAÇÕES DA SESSÃO');
    lines.push(divider);
    lines.push(`Session ID    : ${session.sessionId}`);
    lines.push(`Projeto       : ${session.projectPath}`);
    lines.push(`Agente        : ${session.agent}`);
    lines.push(`Modelo        : ${session.model}`);
    lines.push(`Status        : ${session.status}`);
    lines.push(`Criada em     : ${session.createdAt.toISOString()}`);
    lines.push(`Última ativ.  : ${session.lastActivityAt.toISOString()}`);
    if (session.closedAt) {
      lines.push(`Fechada em    : ${session.closedAt.toISOString()}`);
    }
    lines.push('');
  }

  lines.push('ANÁLISE AUTOMÁTICA');
  lines.push(divider);
  lines.push(analysis.summary);
  lines.push('');

  if (analysis.errors.length > 0) {
    lines.push('Problemas Detectados:');
    for (const err of analysis.errors) {
      lines.push(`  [${err.category}]`);
      if (err.match) lines.push(`  Trecho: ${err.match.slice(0, 200)}`);
      lines.push(`  Sugestão: ${err.suggestion}`);
      lines.push('');
    }
  }

  if (threadMessages && threadMessages.length > 0) {
    lines.push('HISTÓRICO DA THREAD');
    lines.push(divider);
    for (const msg of threadMessages) {
      const ts = msg.timestamp instanceof Date ? msg.timestamp.toISOString() : String(msg.timestamp);
      const botTag = msg.isBot ? ' [BOT]' : '';
      lines.push(`[${ts}] ${msg.author}${botTag}: ${msg.content.slice(0, 500)}`);
    }
    lines.push('');
  }

  if (logEntries && logEntries.length > 0) {
    const logAnalysis = analyzeLogEntries(logEntries);
    const relevantEntries = [...logAnalysis.errors, ...logAnalysis.warnings];
    if (relevantEntries.length > 0) {
      lines.push('LOGS RECENTES DO BOT (ERROS/AVISOS)');
      lines.push(divider);
      lines.push(logAnalysis.summary);
      lines.push('');
      for (const entry of relevantEntries.slice(-20)) {
        lines.push(`[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.component}] ${entry.message}`);
      }
      lines.push('');
    }
  }

  if (sessionOutput) {
    lines.push('OUTPUT DA SESSÃO');
    lines.push(divider);
    // Limitar output a 50.000 caracteres para não gerar arquivo gigante
    const truncated = sessionOutput.length > 50_000
      ? '[... início do output omitido ...]\n' + sessionOutput.slice(-50_000)
      : sessionOutput;
    lines.push(truncated);
    lines.push('');
  }

  lines.push(hr);
  lines.push(`Gerado pelo RemoteFlow em ${timestamp.toISOString()}`);
  lines.push(hr);

  return lines.join('\n');
}

/**
 * Constrói o embed resumido para o relatório.
 * @param {Object} data - Dados do relatório
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildReportEmbed(data) {
  const { reportId, timestamp, reporter, description, severity, session, analysis, logEntries } = data;

  const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.medium;
  const severityLabel = SEVERITY_LABELS[severity] ?? severity;

  const embed = new EmbedBuilder()
    .setTitle(`📋 Relatório de Comportamento Inesperado — ${reportId}`)
    .setColor(color)
    .setTimestamp(timestamp)
    .setFooter({ text: `Reportado por ${reporter.displayName ?? reporter.username}` });

  embed.addFields(
    { name: '📝 Descrição', value: description.slice(0, 1024), inline: false },
    { name: '⚠️ Severidade', value: severityLabel, inline: true },
    { name: '🔍 Análise', value: analysis.summary, inline: false },
  );

  if (analysis.errors.length > 0) {
    const errSummary = analysis.errors
      .slice(0, 5)
      .map((e) => `• **${e.category}**: ${e.match.slice(0, 100)}`)
      .join('\n');
    embed.addFields({ name: '🐛 Problemas Detectados', value: errSummary.slice(0, 1024), inline: false });
  }

  if (session) {
    embed.addFields(
      { name: '📁 Projeto', value: `\`${session.projectPath}\``, inline: true },
      { name: '🤖 Agente', value: session.agent, inline: true },
      { name: '📊 Status Final', value: session.status, inline: true },
    );
  } else {
    embed.addFields({ name: '📌 Sessão', value: 'Nenhuma sessão ativa encontrada nesta thread.', inline: false });
  }

  if (logEntries && logEntries.length > 0) {
    const logAnalysis = analyzeLogEntries(logEntries);
    if (logAnalysis.errors.length > 0 || logAnalysis.warnings.length > 0) {
      const logSummary = [...logAnalysis.errors, ...logAnalysis.warnings]
        .slice(-5)
        .map((e) => `\`[${e.level.toUpperCase()}]\` **${e.component}**: ${e.message.slice(0, 100)}`)
        .join('\n');
      embed.addFields({
        name: '📋 Logs Recentes do Bot',
        value: logSummary.slice(0, 1024),
        inline: false,
      });
    }
  }

  return embed;
}
