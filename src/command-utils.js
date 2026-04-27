// src/command-utils.js
// Utilitários compartilhados pelos handlers de comando Discord

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import path from 'path';
import { StreamHandler } from './stream-handler.js';
import { formatAge, debug } from './utils.js';
import { PROJECTS_BASE, validateProjectPath, MAX_SESSIONS_PER_USER, MAX_GLOBAL_SESSIONS, DEFAULT_MODEL, MAX_SESSIONS_PER_PROJECT } from './config.js';
import { getAvailableModels } from './model-loader.js';

export { formatAge };

export const STATUS_EMOJI = { running: '⚙️', waiting_input: '💬', finished: '✅', error: '❌', idle: '💤' };

// ─── Cache de projetos ────────────────────────────────────────────────────────

let _projectsCache = null;
let _projectsCacheTime = 0;
let _projectsPending = null;
const PROJECTS_CACHE_TTL_MS = 60_000;

export function _resetProjectsCache() {
  _projectsCache = null;
  _projectsCacheTime = 0;
  _projectsPending = null;
}

/**
 * Lista os projetos disponíveis com cache de 60s.
 * @returns {Promise<string[]>}
 */
export async function getProjects() {
  if (_projectsCache && Date.now() - _projectsCacheTime < PROJECTS_CACHE_TTL_MS) {
    return _projectsCache;
  }
  if (_projectsPending) return _projectsPending;
  _projectsPending = (async () => {
    try {
      const entries = await readdir(PROJECTS_BASE, { withFileTypes: true });
      _projectsCache = entries
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      _projectsCacheTime = Date.now();
      return _projectsCache;
    } catch (err) {
      debug('commands', '⚠️ Erro ao listar projetos em %s: %s', PROJECTS_BASE, err.message);
      return _projectsCache ?? [];
    } finally {
      _projectsPending = null;
    }
  })();
  return _projectsPending;
}

// ─── Helpers de validação e resposta ─────────────────────────────────────────

/**
 * Valida nome do projeto e retorna caminho absoluto.
 * @param {string} projectName
 * @returns {{ valid: boolean, projectPath: string|null, error: string|null }}
 */
export function validateAndGetProjectPath(projectName) {
  const { valid, projectPath, error } = validateProjectPath(projectName);
  if (!valid) return { valid: false, projectPath: null, error };
  if (!existsSync(projectPath)) {
    return { valid: false, projectPath: null, error: `❌ Projeto "${projectName}" não encontrado.` };
  }
  return { valid: true, projectPath, error: null };
}

/**
 * Responde a uma interação com mensagem de erro ephemeral.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} message
 */
export async function replyError(interaction, message) {
  const payload = { content: `❌ ${message}`, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    console.error('[commands] Erro ao enviar mensagem de erro:', err.message);
  }
}

// ─── Criação de sessão em thread ──────────────────────────────────────────────

function buildSessionEmbed({ mode, projectName, projectPath, session }) {
  const embed = new EmbedBuilder()
    .setTitle(`${mode === 'plan' ? '📋 Sessão Plan' : '🔨 Sessão Build'} — ${projectName}`)
    .setDescription(
      `Sessão OpenCode iniciada!\n\n` +
      `**Como usar:**\n` +
      `• Digite sua mensagem aqui para interagir com o agente\n` +
      `• Use \`/status\` para ver o estado da sessão\n` +
      `• Use \`/stop\` para encerrar\n\n` +
      `⚙️ Inicializando \`opencode\`...`
    )
    .addFields(
      { name: 'Projeto', value: `\`${projectName}\``, inline: true },
      { name: 'Modo', value: mode, inline: true },
      { name: 'Branch', value: session.gitBranch || 'N/A', inline: true },
      { name: 'Commit', value: session.gitCommit ? `\`${session.gitCommit.hash}\`` : 'N/A', inline: true },
      { name: 'Caminho', value: `\`${projectPath}\``, inline: false }
    )
    .setColor(mode === 'plan' ? 0xfee75c : 0x57f287)
    .setTimestamp()
    .setFooter({ text: `Sessão ${session.sessionId.slice(-8)}` });

  return { embeds: [embed] };
}

function formatTime() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Cria uma thread Discord e inicia uma sessão OpenCode nela.
 * @param {object} opts
 * @returns {Promise<{ thread: import('discord.js').ThreadChannel, session: object }>}
 */
export async function createSessionInThread({ interaction, sessionManager, projectPath, projectName, mode, model = '' }) {
  const threadName = `${mode === 'plan' ? '📋 Plan' : '🔨 Build'} · ${projectName} · ${formatTime()}`;
  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: `Sessão OpenCode ${mode} para ${projectName}`,
  });

  let session;
  try {
    session = await sessionManager.create({
      projectPath,
      threadId: thread.id,
      userId: interaction.user.id,
      agent: mode,
      model,
    });

    await session.loadGitInfo();

    const streamHandler = new StreamHandler(thread, session);
    streamHandler.start();

    await thread.send(buildSessionEmbed({ mode, projectName, projectPath, session }));
  } catch (err) {
    if (session) {
      await sessionManager.destroy(session.sessionId).catch((e) =>
        console.error('[commands] ⚠️ Erro ao destruir sessão órfã:', e.message)
      );
    }
    try {
      await thread.delete();
    } catch (deleteErr) {
      console.error('[commands] ⚠️ Erro ao deletar thread órfã:', deleteErr.message);
    }
    throw err;
  }

  return { thread, session };
}

// ─── Autocomplete helpers ─────────────────────────────────────────────────────

export { DEFAULT_MODEL, MAX_SESSIONS_PER_USER, MAX_GLOBAL_SESSIONS, MAX_SESSIONS_PER_PROJECT, PROJECTS_BASE };
export { getAvailableModels };
