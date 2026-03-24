// src/config.js
// Configuração centralizada — single source of truth para variáveis de ambiente

import path from 'path';
import os from 'os';

// ─── Discord ──────────────────────────────────────────────────────────────────

export const ALLOWED_USERS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const ALLOW_SHARED_SESSIONS = process.env.ALLOW_SHARED_SESSIONS === 'true';

/** Limite de caracteres por mensagem Discord (máximo 2000) */
export const DISCORD_MSG_LIMIT = parseInt(process.env.DISCORD_MSG_LIMIT || '1900', 10);

/** Intervalo em ms para atualizar mensagem de streaming */
export const STREAM_UPDATE_INTERVAL = parseInt(process.env.STREAM_UPDATE_INTERVAL || '1500', 10);

/** Habilitar notificação por DM quando sessão precisa de input */
export const ENABLE_DM_NOTIFICATIONS = process.env.ENABLE_DM_NOTIFICATIONS === 'true';

// ─── Projetos ─────────────────────────────────────────────────────────────────

export const PROJECTS_BASE = process.env.PROJECTS_BASE_PATH || 'C:\\projetos';

// ─── OpenCode ─────────────────────────────────────────────────────────────────

/** Caminho ou nome do binário opencode */
export const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';

/** Porta base para os servidores opencode serve */
export const OPENCODE_BASE_PORT = parseInt(process.env.OPENCODE_BASE_PORT || '4100', 10);

/** Timeout padrão para chamadas HTTP ao opencode (ms) */
export const DEFAULT_TIMEOUT_MS = parseInt(process.env.OPENCODE_TIMEOUT_MS || '10000', 10);

/** Modelo de IA padrão (vazio = usa o padrão configurado no opencode) */
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';

// ─── Plannotator ─────────────────────────────────────────────────────────────

/** Porta base do plannotator (uma por servidor opencode). Default: OPENCODE_BASE_PORT + 1000 */
export const PLANNOTATOR_BASE_PORT = parseInt(process.env.PLANNOTATOR_BASE_PORT || String(OPENCODE_BASE_PORT + 1000), 10);

/** Intervalo de polling para detectar plano pronto no plannotator (ms) */
export const PLAN_POLL_INTERVAL_MS = parseInt(process.env.PLAN_POLL_INTERVAL_MS || '3000', 10);

// ─── Sessões ──────────────────────────────────────────────────────────────────

/** Máximo de sessões ativas por usuário */
export const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || '3', 10);

/** Timeout de inatividade por sessão (ms, padrão: 30 min) */
export const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || String(30 * 60 * 1000), 10);

/** Limite máximo do buffer de output por sessão (bytes) */
export const MAX_BUFFER = parseInt(process.env.MAX_BUFFER || '512000', 10);

/** Limite total de sessões simultâneas no servidor (0 = sem limite) */
export const MAX_GLOBAL_SESSIONS = parseInt(process.env.MAX_GLOBAL_SESSIONS || '0', 10);

/** Máximo de sessões simultâneas por projeto (0 = sem limite) */
export const MAX_SESSIONS_PER_PROJECT = parseInt(process.env.MAX_SESSIONS_PER_PROJECT || '2', 10);

// ─── Operações ────────────────────────────────────────────────────────────────

/** Porta do endpoint de health check */
export const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '9090', 10);

/** Caminho do arquivo de persistência de sessões (opcional) */
export const PERSISTENCE_PATH = process.env.PERSISTENCE_PATH || null;

/** Caminho do arquivo de auditoria NDJSON (padrão: ~/.remote-flow/audit.ndjson) */
export const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ||
  path.join(os.homedir(), '.remote-flow', 'audit.ndjson');

/** Caminho do arquivo de log persistente da aplicação (padrão: ~/.remote-flow/app.log) */
export const LOG_FILE_PATH = process.env.LOG_FILE_PATH ||
  path.join(os.homedir(), '.remote-flow', 'app.log');

// ─── Timeouts internos ────────────────────────────────────────────────────────

/** Delay em ms antes de reiniciar servidor OpenCode após crash (padrão: 2000) */
export const SERVER_RESTART_DELAY_MS = parseInt(process.env.SERVER_RESTART_DELAY_MS || '2000', 10);

/** Delay em ms para leitura do arquivo de log após crash (padrão: 500) */
export const LOG_FILE_READ_DELAY_MS = parseInt(process.env.LOG_FILE_READ_DELAY_MS || '500', 10);

/** Delay em ms para arquivar thread após conclusão da sessão (padrão: 5000) */
export const THREAD_ARCHIVE_DELAY_MS = parseInt(process.env.THREAD_ARCHIVE_DELAY_MS || '5000', 10);

/** Timeout em ms por item na fila de status do StreamHandler (padrão: 5000) */
export const STATUS_QUEUE_ITEM_TIMEOUT_MS = parseInt(process.env.STATUS_QUEUE_ITEM_TIMEOUT_MS || '5000', 10);

/** Timeout em ms para shutdown gracioso do bot (padrão: 10000) */
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);

/** Timeout em ms para fetch de canal Discord durante shutdown (padrão: 2000) */
export const CHANNEL_FETCH_TIMEOUT_MS = parseInt(process.env.CHANNEL_FETCH_TIMEOUT_MS || '2000', 10);

/** Cooldown em ms após circuit breaker do servidor OpenCode (padrão: 60000) */
export const SERVER_CIRCUIT_BREAKER_COOLDOWN_MS = parseInt(process.env.SERVER_CIRCUIT_BREAKER_COOLDOWN_MS || '60000', 10);

/** Timeout em ms para aprovação interativa de permissão antes do auto-approve (padrão: 60000) */
export const PERMISSION_TIMEOUT_MS = parseInt(process.env.PERMISSION_TIMEOUT_MS || '60000', 10);

// ─── GitHub ───────────────────────────────────────────────────────────────────

/** Personal Access Token do GitHub (fine-grained ou classic) */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

/** Owner padrão do repositório (fallback quando git remote não está disponível) */
export const GITHUB_DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER || '';

/** Nome padrão do repositório (fallback quando git remote não está disponível) */
export const GITHUB_DEFAULT_REPO = process.env.GITHUB_DEFAULT_REPO || '';

/** Nome do autor para commits automáticos criados pelo bot */
export const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'RemoteFlow Bot';

/** Email do autor para commits automáticos criados pelo bot */
export const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@remote-flow.local';

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Valida o caminho de um projeto, prevenindo path traversal.
 * @param {string} projectName - Nome da pasta do projeto
 * @returns {{ valid: boolean, projectPath: string, error?: string }}
 */
export function validateProjectPath(projectName) {
  const resolvedBase = path.resolve(PROJECTS_BASE);
  const projectPath = path.resolve(PROJECTS_BASE, projectName);

  if (!projectPath.startsWith(resolvedBase + path.sep) && projectPath !== resolvedBase) {
    return { valid: false, projectPath, error: '❌ Caminho de projeto inválido.' };
  }

  return { valid: true, projectPath };
}
