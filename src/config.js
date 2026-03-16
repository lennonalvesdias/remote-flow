// src/config.js
// Configuração centralizada — single source of truth para variáveis de ambiente

import path from 'path';

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

// ─── Sessões ──────────────────────────────────────────────────────────────────

/** Máximo de sessões ativas por usuário */
export const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || '3', 10);

/** Timeout de inatividade por sessão (ms, padrão: 30 min) */
export const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || String(30 * 60 * 1000), 10);

/** Limite máximo do buffer de output por sessão (bytes) */
export const MAX_BUFFER = parseInt(process.env.MAX_BUFFER || '512000', 10);

// ─── Operações ────────────────────────────────────────────────────────────────

/** Porta do endpoint de health check */
export const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '9090', 10);

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
