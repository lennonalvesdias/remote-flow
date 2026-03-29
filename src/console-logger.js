// src/console-logger.js
// Persiste toda saída de console em arquivos de log diários em logs/
// Arquivos com mais de 24h são removidos automaticamente no startup.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuração ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 horas

let _logFile = null;
let _active = false;

// ─── Helpers internos ─────────────────────────────────────────────────────────

function getTodayFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `bot-${yyyy}-${mm}-${dd}.log`;
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  return `[${ts}] [${level.toUpperCase()}] ${msg}\n`;
}

function writeLine(level, args) {
  if (!_active || !_logFile) return;
  try {
    // Rotate: if the day changed, update the target file
    const todayFile = join(LOGS_DIR, getTodayFilename());
    if (todayFile !== _logFile) _logFile = todayFile;
    appendFileSync(_logFile, formatLine(level, args));
  } catch {
    // Nunca deixa erro de log derrubar a aplicação
  }
}

function cleanOldLogs() {
  try {
    const now = Date.now();
    for (const name of readdirSync(LOGS_DIR)) {
      if (!name.startsWith('bot-') || !name.endsWith('.log')) continue;
      const filePath = join(LOGS_DIR, name);
      try {
        const { mtimeMs } = statSync(filePath);
        if (now - mtimeMs > LOG_MAX_AGE_MS) unlinkSync(filePath);
      } catch { /* ignora */ }
    }
  } catch { /* ignora se pasta não existe ainda */ }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa a interceptação de console e log em arquivo.
 * Deve ser chamado antes de qualquer outro import que use console.
 * Idempotente — chamadas repetidas não têm efeito.
 * @returns {void}
 */
export function initConsoleLogger() {
  if (_active) return;

  try {
    mkdirSync(LOGS_DIR, { recursive: true });
  } catch { /* pasta já existe */ }

  cleanOldLogs();
  _logFile = join(LOGS_DIR, getTodayFilename());
  _active = true;

  // Intercepta os 4 métodos de console preservando o comportamento original
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  console.log = (...args) => { orig.log(...args); writeLine('info', args); };
  console.warn = (...args) => { orig.warn(...args); writeLine('warn', args); };
  console.error = (...args) => { orig.error(...args); writeLine('error', args); };
  console.info = (...args) => { orig.info(...args); writeLine('info', args); };

  // Também captura stderr de process para erros não capturados
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    writeLine('error', [typeof chunk === 'string' ? chunk.replace(/\n$/, '') : chunk]);
    return origStderrWrite(chunk, ...rest);
  };
}

/**
 * Retorna o caminho do arquivo de log atual (para diagnóstico).
 * @returns {string|null}
 */
export function getCurrentLogFile() {
  return _logFile;
}
