/**
 * @fileoverview Módulo de persistência de sessões em disco.
 * Salva metadados de sessões ativas em ~/.opencode-discord/data.json
 * para detectar sessões interrompidas após reinicializações do bot.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PERSISTENCE_PATH } from './config.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

const PERSISTENCE_DIR = PERSISTENCE_PATH
  ? path.dirname(PERSISTENCE_PATH)
  : path.join(os.homedir(), '.opencode-discord');

const PERSISTENCE_FILE = PERSISTENCE_PATH
  || path.join(os.homedir(), '.opencode-discord', 'data.json');

const SCHEMA_VERSION = 1;

// ─── Helpers internos ────────────────────────────────────────────────────────

/** Flag para evitar chamadas redundantes de mkdir após a primeira execução. */
let _dirEnsured = false;

/**
 * Garante que o diretório de persistência existe (com cache de flag).
 * @returns {Promise<void>}
 */
async function ensureDir() {
  if (_dirEnsured) return;
  await fs.mkdir(PERSISTENCE_DIR, { recursive: true });
  _dirEnsured = true;
}

/**
 * Lê o arquivo de persistência. Retorna estrutura vazia se não existir.
 * @returns {Promise<{version: number, sessions: object[]}>}
 */
async function readFile() {
  try {
    const raw = await fs.readFile(PERSISTENCE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== SCHEMA_VERSION) {
      console.warn('[Persistence] Versão incompatível, descartando dados antigos.');
      return { version: SCHEMA_VERSION, sessions: [] };
    }
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: SCHEMA_VERSION, sessions: [] };
    console.warn('[Persistence] Arquivo de persistência corrompido, recriando:', err.message);
    // Tenta deletar o arquivo corrompido para evitar o erro nas próximas reinicializações
    try {
      await fs.unlink(PERSISTENCE_FILE);
    } catch {
      // ignora se já não existe
    }
    return { version: SCHEMA_VERSION, sessions: [] };
  }
}

/**
 * Grava o arquivo de persistência.
 * @param {{version: number, sessions: object[]}} data
 * @returns {Promise<void>}
 */
async function writeFile(data) {
  await ensureDir();
  await fs.writeFile(PERSISTENCE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Fila de escrita ──────────────────────────────────────────────────────────

/** Fila de serialização de escritas para evitar race conditions. */
let _writeQueue = Promise.resolve();

/**
 * Enfileira uma operação de escrita para execução serial.
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
function enqueueWrite(fn) {
  _writeQueue = _writeQueue.then(fn, fn);
  return _writeQueue;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Carrega todas as sessões persistidas em disco.
 * @returns {Promise<object[]>} Array de objetos de sessão
 */
export async function loadSessions() {
  const data = await readFile();
  return data.sessions ?? [];
}

/**
 * Salva ou atualiza os metadados de uma sessão em disco.
 * @param {{ sessionId: string, threadId: string, projectPath: string, userId: string, agent: string, status: string, createdAt: string }} sessionData
 * @returns {Promise<void>}
 */
export async function saveSession(sessionData) {
  return enqueueWrite(async () => {
    const data = await readFile();
    const idx = data.sessions.findIndex(s => s.sessionId === sessionData.sessionId);
    if (idx >= 0) {
      data.sessions[idx] = { ...data.sessions[idx], ...sessionData };
    } else {
      data.sessions.push(sessionData);
    }
    await writeFile(data);
  });
}

/**
 * Remove uma sessão do arquivo de persistência.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function removeSession(sessionId) {
  return enqueueWrite(async () => {
    const data = await readFile();
    data.sessions = data.sessions.filter(s => s.sessionId !== sessionId);
    await writeFile(data);
  });
}

/**
 * Remove todas as sessões do arquivo de persistência.
 * @returns {Promise<void>}
 */
export async function clearSessions() {
  return enqueueWrite(async () => {
    await writeFile({ version: SCHEMA_VERSION, sessions: [] });
  });
}
