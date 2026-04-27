/**
 * @fileoverview Módulo de logging persistente — escreve entradas estruturadas em arquivo NDJSON.
 * Cada linha do arquivo é um objeto JSON independente (newline-delimited JSON).
 * Nunca lança exceções para fora — falhas de I/O são absorvidas para não derrubar o bot.
 */

import { appendFile, mkdir, readFile, stat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LOG_FILE_PATH } from './config.js';

// ─── Estado interno ───────────────────────────────────────────────────────────

/** Flag para evitar chamadas redundantes de mkdir após a primeira inicialização. */
let _initialized = false;

/** Tamanho máximo do arquivo de log antes de rotacionar (padrão: 50 MB) */
const MAX_LOG_BYTES = parseInt(process.env.APP_LOG_MAX_BYTES || String(50 * 1024 * 1024), 10);

// ─── Redação de segredos ──────────────────────────────────────────────────────

/**
 * Lazy-loaded list of secret values to redact from log output.
 * Read after dotenv loads so values are populated.
 */
let _secretValues = null;

function getSecretValues() {
  if (_secretValues) return _secretValues;
  _secretValues = [
    process.env.DISCORD_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.TRANSCRIPTION_API_KEY,
  ].filter((v) => v && v.length > 8);
  return _secretValues;
}

/**
 * Substitui valores de segredos conhecidos por [REDACTED] na string fornecida.
 * @param {string} str
 * @returns {string}
 */
function redactSecrets(str) {
  let result = String(str);
  for (const secret of getSecretValues()) {
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Garante que o diretório de log existe. Idempotente.
 * @returns {Promise<void>}
 */
async function ensureDir() {
  if (_initialized) return;
  try {
    await mkdir(dirname(LOG_FILE_PATH), { recursive: true });
    _initialized = true;
  } catch {
    // Falha silenciosa — log não deve derrubar a aplicação
  }
}

/**
 * Rotaciona o arquivo de log se exceder MAX_LOG_BYTES.
 * O arquivo atual é movido para .1; qualquer .1 anterior é sobrescrito.
 * @returns {Promise<void>}
 */
async function rotateIfNeeded() {
  try {
    const stats = await stat(LOG_FILE_PATH);
    if (stats.size >= MAX_LOG_BYTES) {
      await rename(LOG_FILE_PATH, LOG_FILE_PATH + '.1');
    }
  } catch {
    // Arquivo inexistente ou erro de stat — nada a fazer
  }
}

/**
 * Serializa e persiste uma entrada de log no arquivo.
 * @param {'info'|'warn'|'error'} level
 * @param {string} component
 * @param {string} message
 * @param {string} [correlationId]
 * @returns {Promise<void>}
 */
async function writeLog(level, component, message, correlationId) {
  await ensureDir();
  await rotateIfNeeded();
  const entry = { ts: new Date().toISOString(), level, component, message: redactSecrets(message) };
  if (correlationId) entry.correlationId = correlationId;
  const line = JSON.stringify(entry) + '\n';
  try {
    await appendFile(LOG_FILE_PATH, line, 'utf-8');
  } catch {
    // Falha silenciosa
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa o logger (cria diretório se necessário) e registra entrada de startup.
 * @returns {Promise<void>}
 */
export async function initLogger() {
  await ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), level: 'info', component: 'Logger', message: 'Logger iniciado' }) + '\n';
  try {
    await appendFile(LOG_FILE_PATH, line, 'utf-8');
  } catch {
    // Falha silenciosa
  }
  console.log(`[Logger] ✅ Log persistente iniciado em: ${LOG_FILE_PATH}`);
}

/**
 * Registra uma mensagem de nível INFO no console e no arquivo de log.
 * @param {string} component - Nome do componente (ex: 'SessionManager', 'Bot')
 * @param {string} message - Mensagem de log
 * @returns {Promise<void>}
 */
export async function logInfo(component, message, correlationId) {
  console.log(`[${component}] ${message}`);
  await writeLog('info', component, message, correlationId);
}

/**
 * Registra uma mensagem de nível WARN no console e no arquivo de log.
 * @param {string} component - Nome do componente
 * @param {string} message - Mensagem de log
 * @returns {Promise<void>}
 */
export async function logWarn(component, message, correlationId) {
  console.warn(`[${component}] ${message}`);
  await writeLog('warn', component, message, correlationId);
}

/**
 * Registra uma mensagem de nível ERROR no console e no arquivo de log.
 * @param {string} component - Nome do componente
 * @param {string} message - Mensagem de log
 * @returns {Promise<void>}
 */
export async function logError(component, message, correlationId) {
  console.error(`[${component}] ${message}`);
  await writeLog('error', component, message, correlationId);
}

/**
 * Lê as últimas `limit` entradas do arquivo de log persistente.
 * Retorna array vazio se o arquivo não existir ou não puder ser lido.
 * @param {number} [limit=500] - Máximo de linhas a retornar (0 = todas)
 * @returns {Promise<Array<{ts: string, level: string, component: string, message: string}>>}
 */
export async function readRecentLogEntries(limit = 500) {
  try {
    const content = await readFile(LOG_FILE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const recent = limit > 0 ? lines.slice(-limit) : lines;
    return recent.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reseta o estado interno do logger (usado exclusivamente em testes).
 * @internal
 */
export function _resetLogger() {
  _initialized = false;
}
