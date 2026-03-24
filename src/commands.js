// src/commands.js
// Define e processa os slash commands do bot Discord

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import path from 'path';
import { spawn } from 'node:child_process';
import { StreamHandler } from './stream-handler.js';
import { formatAge, debug } from './utils.js';
import { listOpenCodeCommands } from './opencode-commands.js';
import { PROJECTS_BASE, ALLOWED_USERS, validateProjectPath, MAX_SESSIONS_PER_USER, ALLOW_SHARED_SESSIONS, MAX_GLOBAL_SESSIONS, DEFAULT_MODEL, MAX_SESSIONS_PER_PROJECT, GITHUB_TOKEN, GITHUB_DEFAULT_OWNER, GITHUB_DEFAULT_REPO, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL } from './config.js';
import { getAvailableModels } from './model-loader.js';
import { RateLimiter } from './rate-limiter.js';
import { audit } from './audit.js';
import { getGitHubClient } from './github.js';
import { analyzeOutput, captureThreadMessages, formatReportText, buildReportEmbed, readRecentLogs } from './reporter.js';
import { getRepoInfo, hasChanges, createBranchAndCommit, pushBranch } from './git.js';
import { PlannotatorClient } from './plannotator-client.js';

const commandRateLimiter = new RateLimiter({ maxActions: 5, windowMs: 60_000 });

/** Contextos de review pendentes (sessionId → metadados do PR) — usados pelo botão "Publicar Review" */
const _reviewContexts = new Map();

/**
 * Retorna estatísticas do rate limiter de comandos.
 * Conta quantos usuários estão atualmente bloqueados na janela de 60 segundos.
 * @returns {{ blockedLastMinute: number }}
 */
export function getRateLimitStats() {
  const now = Date.now();
  const cutoff = now - 60_000;
  let blocked = 0;
  for (const bucket of commandRateLimiter._buckets.values()) {
    const recentHits = bucket.timestamps.filter((t) => t > cutoff).length;
    if (recentHits >= commandRateLimiter.maxActions) {
      blocked += 1;
    }
  }
  return { blockedLastMinute: blocked };
}

const STATUS_EMOJI = { running: '⚙️', waiting_input: '💬', finished: '✅', error: '❌', idle: '💤' };

// ─── Cache de projetos ────────────────────────────────────────────────────────

/** Cache em memória da lista de projetos */
let _projectsCache = null;
/** Timestamp da última leitura do filesystem */
let _projectsCacheTime = 0;
/** Promise em andamento para evitar leituras paralelas (cache stampede) */
let _projectsPending = null;
/** TTL do cache em milissegundos */
const PROJECTS_CACHE_TTL_MS = 60_000;

/**
 * Reseta o cache de projetos (usado exclusivamente em testes).
 * @internal
 */
export function _resetProjectsCache() {
  _projectsCache = null;
  _projectsCacheTime = 0;
  _projectsPending = null;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Valida o nome do projeto e retorna o caminho absoluto.
 * Combina a validação de path traversal com a verificação de existência.
 * @param {string} projectName - Nome do projeto
 * @returns {{ valid: boolean, projectPath: string|null, error: string|null }}
 */
function validateAndGetProjectPath(projectName) {
  const { valid, projectPath, error } = validateProjectPath(projectName);
  if (!valid) return { valid: false, projectPath: null, error };
  if (!existsSync(projectPath)) {
    return { valid: false, projectPath: null, error: `❌ Projeto "${projectName}" não encontrado.` };
  }
  return { valid: true, projectPath, error: null };
}

/**
 * Responde a uma interação com mensagem de erro ephemeral.
 * Verifica se a interação já foi respondida antes de tentar responder.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} message
 */
async function replyError(interaction, message) {
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

// ─── Definições dos comandos ──────────────────────────────────────────────────

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('plan')
    .setDescription('Inicia uma sessão de planejamento (agent plan) em um projeto')
    .addStringOption((o) =>
      o.setName('project')
       .setDescription('Nome da pasta do projeto')
       .setRequired(false)
       .setAutocomplete(true)
     )
     .addStringOption((o) =>
       o.setName('prompt').setDescription('Descrição inicial da tarefa').setRequired(false)
     )
     .addStringOption((o) =>
       o.setName('model')
       .setDescription('Modelo de IA a usar (opcional)')
       .setAutocomplete(true)
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('build')
    .setDescription('Inicia uma sessão de desenvolvimento (agent build) em um projeto')
    .addStringOption((o) =>
      o.setName('project')
       .setDescription('Nome da pasta do projeto')
       .setRequired(false)
       .setAutocomplete(true)
     )
     .addStringOption((o) =>
       o.setName('prompt').setDescription('Descrição do que deve ser desenvolvido').setRequired(false)
     )
     .addStringOption((o) =>
       o.setName('model')
       .setDescription('Modelo de IA a usar (opcional)')
       .setAutocomplete(true)
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('Lista todas as sessões OpenCode ativas'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra o status da sessão na thread atual'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Encerra a sessão OpenCode na thread atual'),

  new SlashCommandBuilder()
    .setName('projects')
    .setDescription('Lista os projetos disponíveis em PROJECTS_BASE_PATH'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Baixa o output completo da sessão como arquivo de texto'),

  new SlashCommandBuilder()
    .setName('command')
    .setDescription('Executa um comando opencode personalizado na sessão atual')
    .addStringOption((o) =>
      o.setName('name')
       .setDescription('Nome do comando a executar')
       .setRequired(true)
       .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName('args')
       .setDescription('Argumentos opcionais para o comando')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('diff')
    .setDescription('Exibe o diff atual do projeto da sessão desta thread'),

  new SlashCommandBuilder()
    .setName('passthrough')
    .setDescription('Ativa ou desativa o encaminhamento automático de mensagens para o agente'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Gerencia a fila de mensagens da sessão na thread atual')
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Lista as mensagens aguardando na fila')
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('Remove todas as mensagens da fila de espera')
    ),

  new SlashCommandBuilder()
    .setName('pr')
    .setDescription('Operações de Pull Request no GitHub')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Cria um Pull Request a partir das mudanças da sessão atual')
        .addStringOption((o) => o.setName('title').setDescription('Título do PR (opcional)').setRequired(false))
        .addStringOption((o) => o.setName('base').setDescription('Branch de destino (padrão: main)').setRequired(false))
        .addStringOption((o) => o.setName('branch').setDescription('Nome do branch a criar (auto-gerado se omitido)').setRequired(false))
        .addBooleanOption((o) => o.setName('draft').setDescription('Criar como rascunho (padrão: false)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Lista Pull Requests do projeto')
        .addStringOption((o) =>
          o.setName('project').setDescription('Nome do projeto').setRequired(false).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('Estado dos PRs (padrão: abertos)')
            .setRequired(false)
            .addChoices(
              { name: 'Abertos', value: 'open' },
              { name: 'Fechados', value: 'closed' },
              { name: 'Todos', value: 'all' },
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('review')
        .setDescription('Inicia uma revisão de PR com o agente plan')
        .addIntegerOption((o) =>
          o.setName('number').setDescription('Número do PR a revisar').setRequired(true)
        )
        .addStringOption((o) =>
          o.setName('project').setDescription('Nome do projeto (usa a thread atual se omitido)').setRequired(false).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o.setName('model').setDescription('Modelo de IA a usar (opcional)').setRequired(false).setAutocomplete(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('issue')
    .setDescription('Operações com Issues do GitHub')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Lista issues abertas do projeto')
        .addStringOption((o) =>
          o.setName('project').setDescription('Nome do projeto').setRequired(false).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o.setName('label').setDescription('Filtrar por label (opcional)').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('implement')
        .setDescription('Implementa uma issue do GitHub com o agente build')
        .addIntegerOption((o) =>
          o.setName('number').setDescription('Número da issue').setRequired(true)
        )
        .addStringOption((o) =>
          o.setName('project').setDescription('Nome do projeto').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o.setName('model').setDescription('Modelo de IA a usar (opcional)').setRequired(false).setAutocomplete(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Reporta um comportamento inesperado a partir de uma thread de sessão')
    .addStringOption((opt) =>
      opt
        .setName('description')
        .setDescription('Descreva o comportamento inesperado observado')
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addStringOption((opt) =>
      opt
        .setName('severity')
        .setDescription('Gravidade do problema')
        .setRequired(false)
        .addChoices(
          { name: 'Baixa',    value: 'low' },
          { name: 'Média',    value: 'medium' },
          { name: 'Alta',     value: 'high' },
          { name: 'Crítica',  value: 'critical' },
        )
    )
    .addBooleanOption((opt) =>
      opt
        .setName('create_issue')
        .setDescription('Criar GitHub Issue com o relatório completo')
        .setRequired(false)
    ),
].map((c) => c.toJSON());

// ─── Handler de comandos ──────────────────────────────────────────────────────

/**
 * Processa um slash command recebido
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
export async function handleCommand(interaction, sessionManager) {
  // Guard: ignora interações expiradas (reenviadas pelo gateway ao reconectar)
  const AGE_LIMIT_MS = 2500;
  if (Date.now() - interaction.createdTimestamp > AGE_LIMIT_MS) {
    console.warn(`[commands] ⏰ Interação expirada ignorada (${Date.now() - interaction.createdTimestamp}ms): ${interaction.commandName}`);
    return;
  }

  // Verificação de acesso
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(interaction.user.id)) {
    return replyError(interaction, 'Você não tem permissão para usar este bot.');
  }

  // Rate limiting por usuário
  const { allowed, retryAfterMs } = commandRateLimiter.check(interaction.user.id);
  if (!allowed) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    return replyError(interaction, `Rate limit atingido. Tente novamente em ${seconds}s.`);
  }

  const { commandName } = interaction;

  if (commandName === 'plan' || commandName === 'build') {
    await handleStartSession(interaction, sessionManager, commandName);
  } else if (commandName === 'sessions') {
    await handleListSessions(interaction, sessionManager);
  } else if (commandName === 'status') {
    await handleStatus(interaction, sessionManager);
  } else if (commandName === 'stop') {
    await handleStop(interaction, sessionManager);
  } else if (commandName === 'projects') {
    await handleListProjects(interaction);
  } else if (commandName === 'history') {
    await handleHistory(interaction, sessionManager);
  } else if (commandName === 'command') {
    await handleRunCommand(interaction, sessionManager);
  } else if (commandName === 'diff') {
    await handleDiffCommand(interaction, sessionManager);
  } else if (commandName === 'passthrough') {
    await handlePassthrough(interaction, sessionManager);
  } else if (commandName === 'queue') {
    await handleFila(interaction, sessionManager);
  } else if (commandName === 'pr') {
    await handlePrCommand(interaction, sessionManager);
  } else if (commandName === 'issue') {
    await handleIssueCommand(interaction, sessionManager);
  } else if (commandName === 'report') {
    await handleReport(interaction, sessionManager);
  }
}

/**
 * Responde a autocomplete de projeto para /plan e /build,
 * de modelo de IA para /plan e /build,
 * e de nome de comando para /comando
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function handleAutocomplete(interaction) {
  const { commandName } = interaction;

  // Autocomplete de nome de comando para /command
  if (commandName === 'command') {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'name') {
      await handleCommandoAutocomplete(interaction, focusedOption.value);
    }
    return;
  }

  // Autocomplete de modelo e projeto para /pr e /issue
  if (commandName === 'pr' || commandName === 'issue') {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'model') {
      const models = getAvailableModels().filter((m) => m.startsWith(focused.value));
      await interaction.respond(models.slice(0, 25).map((m) => ({ name: m, value: m })));
      return;
    }
    if (focused.name === 'project') {
      const focusedVal = focused.value.toLowerCase();
      const projects = await getProjects();
      const filtered = projects
        .filter((p) => p.toLowerCase().includes(focusedVal))
        .slice(0, 25)
        .map((p) => ({ name: p, value: p }));
      await interaction.respond(filtered);
      return;
    }
  }

  // Autocomplete de modelo para /plan e /build
  if (commandName === 'plan' || commandName === 'build') {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'model') {
      const models = getAvailableModels().filter((m) => m.startsWith(focused.value));
      await interaction.respond(models.slice(0, 25).map((m) => ({ name: m, value: m })));
      return;
    }
  }

  // Autocomplete de projeto para /plan e /build
  const focused = interaction.options.getFocused().toLowerCase();
  const projects = await getProjects();
  const filtered = projects
    .filter((p) => p.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((p) => ({ name: p, value: p }));
  await interaction.respond(filtered);
}

// ─── Handlers individuais ─────────────────────────────────────────────────────

/**
 * Inicia uma nova sessão OpenCode em uma thread Discord
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 * @param {'plan'|'build'} mode
 */
async function handleStartSession(interaction, sessionManager, mode) {
  let projectName = interaction.options.getString('project');
  const promptText = interaction.options.getString('prompt');
  const modelOption = interaction.options.getString('model') || DEFAULT_MODEL;

  // S-03: Validações de tamanho de input (antes do defer para respostas ephemeral limpas)
  if (projectName && projectName.length > 256) {
    return await replyError(interaction, 'Nome do projeto muito longo (máximo 256 caracteres).');
  }
  if (promptText && promptText.length > 10000) {
    return await replyError(interaction, 'Mensagem muito longa (máximo 10.000 caracteres).');
  }

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err; // re-lança erros inesperados
  }

  // Se não passou projeto, mostra selector
  if (!projectName) {
    const projects = await getProjects();
    if (projects.length === 0) {
      return interaction.editReply(
        `❌ Nenhum projeto encontrado em \`${PROJECTS_BASE}\`. Configure \`PROJECTS_BASE_PATH\` no .env.`
      );
    }

    // Exibe select menu para escolher projeto
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`select_project_${mode}`)
        .setPlaceholder('Escolha um projeto...')
        .addOptions(
          projects.slice(0, 25).map((p) => ({
            label: p,
            value: p,
            description: path.join(PROJECTS_BASE, p),
          }))
        )
    );

    return interaction.editReply({
      content: `📁 **Qual projeto para o \`/${mode}\`?**`,
      components: [row],
    });
  }

  // S-01: Valida e sanitiza o caminho do projeto (prevenção de path traversal)
  const { valid, projectPath, error } = validateAndGetProjectPath(projectName);
  if (!valid) {
    return interaction.editReply(error);
  }

  // Verifica limite de sessões ativas por usuário
  const userSessions = sessionManager.getByUser(interaction.user.id)
    .filter((s) => s.status !== 'finished' && s.status !== 'error');
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    return interaction.editReply(
      `⚠️ Limite de ${MAX_SESSIONS_PER_USER} sessões ativas atingido. Encerre uma sessão existente com \`/stop\`.`
    );
  }

  // S-04: Verifica limite global de sessões ativas
  if (MAX_GLOBAL_SESSIONS > 0) {
    const totalActive = sessionManager.getAll()
      .filter((s) => s.status !== 'finished' && s.status !== 'error').length;
    if (totalActive >= MAX_GLOBAL_SESSIONS) {
      return await replyError(interaction, `Limite global de sessões atingido (${MAX_GLOBAL_SESSIONS}). Tente novamente mais tarde.`);
    }
  }

  // Verifica se já existe sessão ativa para este projeto
  const existing = sessionManager.getByProject(projectPath);
  if (existing) {
    return interaction.editReply(
      `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/stop\`.`
    );
  }

  const { thread, session } = await createSessionInThread({
    interaction,
    sessionManager,
    projectPath,
    projectName,
    mode,
    model: modelOption,
  });

  await audit('session.create', { project: projectName, agent: mode, model: modelOption }, interaction.user.id, session.sessionId);

  // Se passou um prompt inicial, envia diretamente
  if (promptText) {
    await session.sendMessage(promptText);
  }

  await interaction.editReply(
    `✅ Sessão **${mode}** iniciada para \`${projectName}\`!\n👉 Acesse a thread: ${thread}`
  );
}

/**
 * Lista todas as sessões ativas
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleListSessions(interaction, sessionManager) {
  const sessions = sessionManager.getAll();

  if (sessions.length === 0) {
    return interaction.reply({ content: '📭 Nenhuma sessão ativa no momento.', flags: MessageFlags.Ephemeral });
  }

  const lines = sessions.map((s) => {
    const emoji = STATUS_EMOJI[s.status] || '❓';
    const age = formatAge(s.createdAt);
    return `${emoji} \`${s.sessionId.slice(-6)}\` · **${path.basename(s.projectPath)}** · ${s.status} · ${age}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📊 Sessões OpenCode Ativas')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setFooter({ text: `${sessions.length} sessão(ões) ativa(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Exibe o status da sessão associada à thread atual
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleStatus(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão OpenCode associada a esta thread.');
  }

  const s = session.toSummary();
  const queueSize = session.getQueueSize();

  const embed = new EmbedBuilder()
    .setTitle(`${STATUS_EMOJI[s.status] || '❓'} Status da Sessão`)
    .addFields(
      { name: 'Projeto', value: s.project, inline: true },
      { name: 'Status', value: s.status, inline: true },
      { name: 'Usuário', value: `<@${s.userId}>`, inline: true },
      { name: 'Iniciada', value: formatAge(s.createdAt) + ' atrás', inline: true },
      { name: 'Última atividade', value: formatAge(s.lastActivityAt) + ' atrás', inline: true },
      { name: 'Caminho', value: `\`${s.projectPath}\``, inline: false }
    )
    .setColor(s.status === 'error' ? 0xff0000 : s.status === 'finished' ? 0x00ff00 : 0x5865f2)
    .setTimestamp();

  if (queueSize > 0) {
    embed.addFields({ name: '📮 Fila', value: `${queueSize} mensagem(s) aguardando`, inline: true });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Encerra a sessão na thread atual (com confirmação)
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleStop(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread.');
  }

  await audit('session.stop', { project: path.basename(session.projectPath) }, interaction.user.id, session.sessionId);

  // Botão de confirmação
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_stop_${session.sessionId}`)
      .setLabel('Confirmar encerramento')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('cancel_stop')
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `⚠️ Deseja encerrar a sessão para **${path.basename(session.projectPath)}**?`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Lista os projetos disponíveis no diretório base
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleListProjects(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err; // re-lança erros inesperados
  }

  const projects = await getProjects();

  if (projects.length === 0) {
    return interaction.editReply(`📭 Nenhum projeto encontrado em \`${PROJECTS_BASE}\`.`);
  }

  const embed = new EmbedBuilder()
    .setTitle('📁 Projetos Disponíveis')
    .setDescription(projects.map((p) => `• \`${p}\``).join('\n'))
    .setColor(0x57f287)
    .setFooter({ text: `Base: ${PROJECTS_BASE}` });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Fornece sugestões de autocomplete para o campo `nome` do /comando.
 * Filtra comandos cujo nome começa com o valor digitado (case-insensitive).
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {string} focusedValue - Valor digitado pelo usuário
 */
async function handleCommandoAutocomplete(interaction, focusedValue) {
  const commands = await listOpenCodeCommands();
  const lowerValue = focusedValue.toLowerCase();

  const choices = commands
    .filter((cmd) => cmd.name.startsWith(lowerValue))
    .slice(0, 25)
    .map((cmd) => ({
      name: cmd.description !== cmd.name ? `${cmd.name} — ${cmd.description}` : cmd.name,
      value: cmd.name,
    }));

  await interaction.respond(choices);
}

/**
 * Envia o output completo da sessão como arquivo .txt
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleHistory(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão associada a esta thread.');
  }

  const output = session.outputBuffer || '(sem output)';
  const buffer = Buffer.from(output, 'utf-8');
  const attachment = new AttachmentBuilder(buffer, {
    name: `session-${session.sessionId.slice(-8)}.txt`,
    description: 'Output completo da sessão OpenCode',
  });

  await interaction.reply({
    content: `📄 Output da sessão (${Math.round(buffer.length / 1024)} KB):`,
    files: [attachment],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Executa um comando opencode personalizado na sessão atual da thread.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleRunCommand(interaction, sessionManager) {
  const commandName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') ?? '';

  // Verifica se estamos em uma thread com sessão ativa
  const threadId = interaction.channelId;
  const session = sessionManager.getByThread(threadId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread. Use `/plan` ou `/build` para iniciar uma.');
  }

  await audit('command.run', { command: commandName, args }, interaction.user.id, session.sessionId);

  // Monta a string do comando e envia para a sessão
  const commandText = args.trim() ? `/${commandName} ${args.trim()}` : `/${commandName}`;

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err; // re-lança erros inesperados
  }
  await session.sendMessage(commandText);
  await interaction.editReply(`⚙️ Comando \`${commandText}\` enviado para a sessão.`);
}

/**
 * Exibe o diff atual (staged + unstaged) do projeto da sessão na thread.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleDiffCommand(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '❌ Nenhuma sessão ativa nesta thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  await audit('command.diff', { project: path.basename(session.projectPath) }, interaction.user.id, session.sessionId);

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err; // re-lança erros inesperados
  }

  let diffOutput = '';

  try {
    diffOutput = await new Promise((resolve, reject) => {
      // git diff HEAD mostra tudo que mudou desde o último commit (staged + unstaged)
      const proc = spawn('git', ['diff', 'HEAD'], {
        cwd: session.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(err || `git diff saiu com código ${code}`));
        else resolve(out);
      });
      proc.on('error', reject);
      // Timeout de 10 s para não travar em repos muito grandes
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout ao executar git diff')); }, 10_000);
      proc.once('close', () => clearTimeout(timer));
    });
  } catch (err) {
    console.error('[commands] Erro ao executar git diff:', err);
    await interaction.editReply('❌ Erro ao executar `git diff`: ' + err.message);
    return;
  }

  if (!diffOutput.trim()) {
    await interaction.editReply('✅ Nenhuma mudança detectada no projeto.');
    return;
  }

  const MAX_INLINE = 1500;
  const projectName = path.basename(session.projectPath);
  const fileName = `${projectName}.diff`;

  try {
    if (diffOutput.length <= MAX_INLINE) {
      await interaction.editReply(`📝 **${fileName}**\n\`\`\`diff\n${diffOutput}\`\`\``);
    } else {
      const buffer = Buffer.from(diffOutput, 'utf-8');
      await interaction.editReply({
        content: `📝 **${fileName}** (arquivo completo — ${diffOutput.length} bytes)`,
        files: [{ attachment: buffer, name: fileName }],
      });
    }
  } catch (err) {
    console.error('[commands] Erro ao enviar diff:', err);
    await interaction.editReply('❌ Erro ao enviar o diff.');
  }
}

/**
 * Alterna o modo passthrough da sessão na thread atual.
 * Quando ativo, mensagens inline do Discord são encaminhadas automaticamente ao agente.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handlePassthrough(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread.');
  }

  const enabled = session.togglePassthrough();
  const content = enabled
    ? '✅ Passthrough **ativado** — mensagens serão enviadas automaticamente ao agente'
    : '⏸️ Passthrough **desativado** — use `/command` para enviar mensagens manualmente';

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// ─── GitHub — helpers internos ────────────────────────────────────────────────

/**
 * Resolve owner e repo a partir do caminho do projeto ou das configurações padrão.
 * @param {string} projectPath - Caminho absoluto do projeto
 * @returns {Promise<{ owner: string, repo: string }>}
 */
async function resolveRepoContext(projectPath) {
  try {
    const info = await getRepoInfo(projectPath);
    return { owner: info.owner, repo: info.repo };
  } catch {
    if (GITHUB_DEFAULT_OWNER && GITHUB_DEFAULT_REPO) {
      return { owner: GITHUB_DEFAULT_OWNER, repo: GITHUB_DEFAULT_REPO };
    }
    throw new Error(
      'Não foi possível detectar o repositório GitHub. ' +
        'Configure `GITHUB_DEFAULT_OWNER` e `GITHUB_DEFAULT_REPO` no .env, ' +
        'ou verifique se o projeto tem um remote "origin" apontando para o GitHub.',
    );
  }
}

// ─── GitHub — /pr ────────────────────────────────────────────────────────────

/**
 * Despacha subcomandos do /pr.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handlePrCommand(interaction, sessionManager) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'create') await handlePrCreate(interaction, sessionManager);
  else if (subcommand === 'list') await handlePrList(interaction, sessionManager);
  else if (subcommand === 'review') await handlePrReview(interaction, sessionManager);
}

/**
 * Cria branch, commit, push e Pull Request a partir das mudanças da sessão atual.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handlePrCreate(interaction, sessionManager) {
  if (!GITHUB_TOKEN) {
    return replyError(interaction, 'GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
  }

  const session = sessionManager.getByThread(interaction.channelId);
  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread. Use `/plan` ou `/build` primeiro.');
  }

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  const projectPath = session.projectPath;
  const projectName = path.basename(projectPath);

  try {
    const { owner, repo } = await resolveRepoContext(projectPath);

    const changed = await hasChanges(projectPath);
    if (!changed) {
      return interaction.editReply('✅ Nenhuma alteração detectada no projeto. Não há nada para incluir no PR.');
    }

    const titleOption = interaction.options.getString('title');
    const baseOption = interaction.options.getString('base') || 'main';
    const branchOption = interaction.options.getString('branch');
    const isDraft = interaction.options.getBoolean('draft') ?? false;

    const shortId = session.sessionId.slice(-6);
    const dateStr = new Date().toISOString().slice(0, 10);
    const branchName = branchOption || `rf/${dateStr}-${shortId}`;
    const title = titleOption || `feat: mudanças da sessão ${session.agent} (${shortId})`;
    const commitMsg = `feat: changes from RemoteFlow ${session.agent} session ${shortId}`;

    const lastOutput = (session.outputBuffer || '').slice(-800).trim();
    const prBody = [
      `## 📋 Contexto`,
      `Criado automaticamente pelo **RemoteFlow** a partir de uma sessão \`${session.agent}\`.`,
      ``,
      `| Campo | Valor |`,
      `|---|---|`,
      `| Projeto | \`${projectName}\` |`,
      `| Sessão | \`${session.sessionId.slice(-8)}\` |`,
      `| Agente | \`${session.agent}\` |`,
      ``,
      lastOutput ? `## 📝 Resumo da Sessão\n\`\`\`\n${lastOutput}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await createBranchAndCommit({
      cwd: projectPath,
      branchName,
      commitMsg,
      authorName: GIT_AUTHOR_NAME,
      authorEmail: GIT_AUTHOR_EMAIL,
    });

    await pushBranch({ cwd: projectPath, branchName, token: GITHUB_TOKEN, owner, repo });

    const gh = getGitHubClient();
    const pr = await gh.createPullRequest({ owner, repo, head: branchName, base: baseOption, title, body: prBody, draft: isDraft });

    await audit('pr.create', { owner, repo, number: pr.number, branch: branchName }, interaction.user.id, session.sessionId);

    const embed = new EmbedBuilder()
      .setTitle(`🔀 Pull Request Criado — #${pr.number}`)
      .setURL(pr.html_url)
      .setDescription(title)
      .addFields(
        { name: 'Repositório', value: `\`${owner}/${repo}\``, inline: true },
        { name: 'Branch', value: `\`${branchName}\` → \`${baseOption}\``, inline: true },
        { name: 'Estado', value: isDraft ? '📝 Rascunho' : '🟢 Aberto', inline: true },
        { name: 'Link', value: pr.html_url, inline: false },
      )
      .setColor(0x6e40c9)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[commands] ❌ Erro ao criar PR:', err.message);
    await interaction.editReply(`❌ Erro ao criar Pull Request: ${err.message}`);
  }
}

/**
 * Lista Pull Requests abertos do repositório associado ao projeto.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handlePrList(interaction, sessionManager) {
  if (!GITHUB_TOKEN) {
    return replyError(interaction, 'GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  const projectOption = interaction.options.getString('project');
  const state = interaction.options.getString('state') || 'open';

  let projectPath;
  if (projectOption) {
    const { valid, projectPath: pp, error } = validateAndGetProjectPath(projectOption);
    if (!valid) return interaction.editReply(error);
    projectPath = pp;
  } else {
    const session = sessionManager.getByThread(interaction.channelId);
    if (!session) {
      return interaction.editReply('❌ Nenhuma sessão nesta thread. Especifique o projeto com a opção `project`.');
    }
    projectPath = session.projectPath;
  }

  try {
    const { owner, repo } = await resolveRepoContext(projectPath);
    const gh = getGitHubClient();
    const prs = await gh.listPullRequests({ owner, repo, state, perPage: 15 });

    if (prs.length === 0) {
      const stateLabel = state === 'open' ? 'aberto' : state === 'closed' ? 'fechado' : '';
      return interaction.editReply(`📭 Nenhum PR ${stateLabel} encontrado em \`${owner}/${repo}\`.`);
    }

    const stateEmoji = { open: '🟢', closed: '🔴', all: '📋' };
    const lines = prs.map((pr) => {
      const emoji = pr.state === 'open' ? '🟢' : '🔴';
      const draft = pr.draft ? ' 📝' : '';
      return `${emoji}${draft} **#${pr.number}** [${pr.title.slice(0, 55)}](${pr.html_url}) — @${pr.user.login}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${stateEmoji[state] || '📋'} Pull Requests — ${owner}/${repo}`)
      .setDescription(lines.join('\n'))
      .setColor(0x6e40c9)
      .setFooter({ text: `${prs.length} PR(s) · ${state}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[commands] ❌ Erro ao listar PRs:', err.message);
    await interaction.editReply(`❌ Erro ao listar Pull Requests: ${err.message}`);
  }
}

/**
 * Inicia uma sessão plan para revisar um PR do GitHub.
 * Ao finalizar, oferece botão para publicar o review no repositório.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handlePrReview(interaction, sessionManager) {
  if (!GITHUB_TOKEN) {
    return replyError(interaction, 'GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
  }

  const prNumber = interaction.options.getInteger('number', true);
  const projectOption = interaction.options.getString('project');
  const modelOption = interaction.options.getString('model') || DEFAULT_MODEL;

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  let projectPath, projectName;
  if (projectOption) {
    const { valid, projectPath: pp, error } = validateAndGetProjectPath(projectOption);
    if (!valid) return interaction.editReply(error);
    projectPath = pp;
    projectName = projectOption;
  } else {
    const session = sessionManager.getByThread(interaction.channelId);
    if (!session) {
      return interaction.editReply('❌ Nenhuma sessão nesta thread. Especifique o projeto com a opção `project`.');
    }
    projectPath = session.projectPath;
    projectName = path.basename(projectPath);
  }

  try {
    const { owner, repo } = await resolveRepoContext(projectPath);
    const gh = getGitHubClient();
    const pr = await gh.getPullRequest({ owner, repo, number: prNumber });

    let diffText = '';
    try {
      diffText = await gh.getPullRequestDiff({ owner, repo, number: prNumber });
      if (diffText.length > 80_000) {
        diffText = diffText.slice(0, 80_000) + '\n\n... [diff truncado — muito grande para exibição completa]';
      }
    } catch {
      diffText = '(não foi possível obter o diff)';
    }

    const files = await gh.getPullRequestFiles({ owner, repo, number: prNumber });
    const fileList = files.map((f) => `• \`${f.filename}\` (+${f.additions}/-${f.deletions})`).join('\n');

    const prompt = [
      `Revise o seguinte Pull Request do GitHub:`,
      ``,
      `## PR #${pr.number}: ${pr.title}`,
      `**Autor:** ${pr.user.login} | **Base:** \`${pr.base.ref}\` ← \`${pr.head.ref}\``,
      `**Commits:** ${pr.commits} | **Adições:** +${pr.additions} | **Remoções:** -${pr.deletions}`,
      ``,
      pr.body ? `**Descrição:**\n${pr.body}\n` : '',
      `## Arquivos alterados (${files.length}):`,
      fileList,
      ``,
      `## Diff:`,
      '```diff',
      diffText,
      '```',
      ``,
      `---`,
      `Analise o código e forneça uma revisão completa em português com:`,
      `1. **Resumo** das mudanças implementadas`,
      `2. **Problemas encontrados** (bugs, segurança, performance, boas práticas)`,
      `3. **Sugestões de melhoria** com exemplos de código quando relevante`,
      `4. **Veredicto final**: APPROVE (aprovado), REQUEST_CHANGES (mudanças necessárias) ou COMMENT (observações sem bloquear merge)`,
    ]
      .filter((s) => s !== undefined)
      .join('\n');

    const { thread, session } = await createSessionInThread({
      interaction,
      sessionManager,
      projectPath,
      projectName,
      mode: 'plan',
      model: modelOption,
    });

    _reviewContexts.set(session.sessionId, {
      owner,
      repo,
      number: prNumber,
      commitId: pr.head.sha,
    });

    await session.sendMessage(prompt);

    // Quando a sessão fechar, envia botão para publicar o review
    session.once('close', async () => {
      try {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`publish_review_${session.sessionId}`)
            .setLabel('📤 Publicar Review no GitHub')
            .setStyle(ButtonStyle.Primary),
        );
        await thread.send({
          content: `🔍 Revisão do **PR #${prNumber}** concluída! Clique para publicar no GitHub:`,
          components: [row],
        });
      } catch (err) {
        console.error('[commands] ⚠️ Erro ao enviar botão de review:', err.message);
      }
    });

    await audit('pr.review', { owner, repo, prNumber }, interaction.user.id, session.sessionId);

    await interaction.editReply(
      `🔍 Revisão do **PR #${prNumber}** iniciada para \`${projectName}\`!\n👉 Acesse a thread: ${thread}`,
    );
  } catch (err) {
    console.error('[commands] ❌ Erro ao iniciar review:', err.message);
    await interaction.editReply(`❌ Erro ao iniciar revisão do PR: ${err.message}`);
  }
}

// ─── GitHub — /issue ─────────────────────────────────────────────────────────

/**
 * Despacha subcomandos do /issue.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleIssueCommand(interaction, sessionManager) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') await handleIssueList(interaction, sessionManager);
  else if (subcommand === 'implement') await handleIssueImplement(interaction, sessionManager);
}

/**
 * Lista issues abertas do repositório associado ao projeto.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleIssueList(interaction, sessionManager) {
  if (!GITHUB_TOKEN) {
    return replyError(interaction, 'GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  const projectOption = interaction.options.getString('project');
  const labelFilter = interaction.options.getString('label') || '';

  let projectPath;
  if (projectOption) {
    const { valid, projectPath: pp, error } = validateAndGetProjectPath(projectOption);
    if (!valid) return interaction.editReply(error);
    projectPath = pp;
  } else {
    const session = sessionManager.getByThread(interaction.channelId);
    if (!session) {
      return interaction.editReply('❌ Nenhuma sessão nesta thread. Especifique o projeto com a opção `project`.');
    }
    projectPath = session.projectPath;
  }

  try {
    const { owner, repo } = await resolveRepoContext(projectPath);
    const gh = getGitHubClient();
    const issues = await gh.listIssues({ owner, repo, state: 'open', labels: labelFilter, perPage: 15 });

    if (issues.length === 0) {
      const labelMsg = labelFilter ? ` com a label \`${labelFilter}\`` : '';
      return interaction.editReply(`📭 Nenhuma issue aberta${labelMsg} encontrada em \`${owner}/${repo}\`.`);
    }

    const lines = issues.map((issue) => {
      const labels = issue.labels.map((l) => `\`${l.name}\``).join(' ');
      return `🐛 **#${issue.number}** [${issue.title.slice(0, 55)}](${issue.html_url}) — @${issue.user.login}${labels ? ' · ' + labels : ''}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🐛 Issues Abertas — ${owner}/${repo}`)
      .setDescription(lines.join('\n'))
      .setColor(0xe8472a)
      .setFooter({ text: `${issues.length} issue(s) · ${labelFilter ? 'label: ' + labelFilter : 'todas'}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[commands] ❌ Erro ao listar issues:', err.message);
    await interaction.editReply(`❌ Erro ao listar issues: ${err.message}`);
  }
}

/**
 * Busca uma issue do GitHub e inicia uma sessão build para implementá-la.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleIssueImplement(interaction, sessionManager) {
  if (!GITHUB_TOKEN) {
    return replyError(interaction, 'GITHUB_TOKEN não configurado. Adicione ao arquivo .env.');
  }

  const issueNumber = interaction.options.getInteger('number', true);
  const projectOption = interaction.options.getString('project', true);
  const modelOption = interaction.options.getString('model') || DEFAULT_MODEL;

  const { valid, projectPath, error } = validateAndGetProjectPath(projectOption);
  if (!valid) return replyError(interaction, error);

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  try {
    const { owner, repo } = await resolveRepoContext(projectPath);
    const gh = getGitHubClient();
    const issue = await gh.getIssue({ owner, repo, number: issueNumber });

    const labels = issue.labels.map((l) => l.name).join(', ') || 'nenhuma';
    const prompt = [
      `Implemente a seguinte issue do GitHub:`,
      ``,
      `## Issue #${issue.number}: ${issue.title}`,
      `**Labels:** ${labels}`,
      `**Autor:** ${issue.user.login}`,
      ``,
      issue.body ? issue.body : '(sem descrição)',
      ``,
      `---`,
      `Implemente a solução seguindo as boas práticas do projeto.`,
      `Ao finalizar, liste os arquivos alterados e descreva o que foi implementado.`,
      `Quando terminar, use \`/pr create\` para criar um Pull Request com as mudanças.`,
    ].join('\n');

    const { thread, session } = await createSessionInThread({
      interaction,
      sessionManager,
      projectPath,
      projectName: projectOption,
      mode: 'build',
      model: modelOption,
    });

    await session.sendMessage(prompt);

    await audit('issue.implement', { owner, repo, issueNumber }, interaction.user.id, session.sessionId);

    await interaction.editReply(
      `🐛 Implementação da **Issue #${issueNumber}** iniciada para \`${projectOption}\`!\n👉 Acesse a thread: ${thread}\n\n💡 Após a sessão concluir, use \`/pr create\` para criar o Pull Request.`,
    );
  } catch (err) {
    console.error('[commands] ❌ Erro ao iniciar implementação:', err.message);
    await interaction.editReply(`❌ Erro ao iniciar implementação da issue: ${err.message}`);
  }
}

// ─── Handler de interações (select menus, botões) ─────────────────────────────

/**
 * Gerencia a fila de mensagens da sessão na thread atual.
 * Subcomandos: `ver` lista as mensagens pendentes; `limpar` remove todas da fila.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleFila(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread.');
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'view') {
    const queue = session._messageQueue;
    if (queue.length === 0) {
      return interaction.reply({ content: '📮 Nenhuma mensagem na fila.', flags: MessageFlags.Ephemeral });
    }

    const lines = queue.map((msg, i) => `**${i + 1}.** ${msg.slice(0, 100)}${msg.length > 100 ? '...' : ''}`);
    return interaction.reply({
      content: `📮 **Fila de mensagens (${queue.length}):**\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (subcommand === 'clear') {
    // Verifica ownership
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return replyError(interaction, 'Apenas o criador da sessão pode limpar a fila.');
    }

    if (session._processingQueue) {
      // Uma mensagem já está sendo processada (fora da fila); remove apenas as restantes
      const remaining = session._messageQueue.length;
      session._messageQueue = [];
      return interaction.reply({
        content: `⚠️ 1 mensagem já está sendo processada. As demais (${remaining}) foram removidas da fila.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const total = session._messageQueue.length;
    session._messageQueue = [];
    return interaction.reply({
      content: `✅ Fila limpa. ${total} mensagem(s) removida(s).`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── /report ──────────────────────────────────────────────────────────────────

/**
 * Gera um relatório de comportamento inesperado para a sessão na thread atual.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleReport(interaction, sessionManager) {
  // Guard: comando só pode ser usado dentro de uma thread
  if (!interaction.channel.isThread()) {
    return replyError(interaction, 'Este comando só pode ser usado dentro de uma thread de sessão.');
  }

  const description = interaction.options.getString('description', true);
  const severity     = interaction.options.getString('severity') ?? 'medium';
  const createIssue  = interaction.options.getBoolean('create_issue') ?? false;

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (report): ${interaction.id}`);
      return;
    }
    throw err;
  }

  const threadId = interaction.channelId;
  const session  = sessionManager.getByThread(threadId);

  // Capturar histórico de mensagens da thread (melhor esforço)
  let threadMessages = [];
  try {
    threadMessages = await captureThreadMessages(interaction.channel, 100);
  } catch (err) {
    debug('Report', 'Erro ao buscar mensagens da thread: %s', err.message);
  }

  // Ler logs recentes do arquivo de log persistente (melhor esforço)
  let logEntries = [];
  try {
    logEntries = await readRecentLogs(200);
  } catch (err) {
    debug('Report', 'Erro ao ler logs persistentes: %s', err.message);
  }

  // Montar dados do relatório
  const reportId     = `RPT-${Date.now().toString(36).toUpperCase()}`;
  const reporter     = interaction.user;
  const sessionOutput = session?.outputBuffer ?? '';
  const sessionStatus = session?.status ?? 'desconhecido';
  const analysis     = analyzeOutput(sessionOutput, sessionStatus);

  const reportData = {
    reportId,
    timestamp: new Date(),
    reporter: {
      id: reporter.id,
      username: reporter.username,
      displayName: reporter.displayName,
    },
    description,
    severity,
    logEntries,
    session: session ? {
      sessionId:       session.sessionId,
      projectPath:     session.projectPath,
      agent:           session.agent,
      model:           session.model ?? 'padrão',
      status:          session.status,
      createdAt:       session.createdAt,
      closedAt:        session.closedAt ?? null,
      lastActivityAt:  session.lastActivityAt,
    } : null,
    threadMessages,
    sessionOutput,
    analysis,
  };

  // Gerar embed e arquivo de texto
  const embed      = buildReportEmbed(reportData);
  const reportText = formatReportText(reportData);
  const attachment = new AttachmentBuilder(Buffer.from(reportText, 'utf-8'), {
    name: `relatorio-${reportId}.txt`,
  });

  // Registrar no audit
  await audit('report.created', {
    reportId,
    severity,
    threadId,
    sessionId:      session?.sessionId ?? null,
    hasSession:     !!session,
    errorsDetected: analysis.errors.length,
    createIssue,
  }, reporter.id, session?.sessionId ?? null);

  // Criar GitHub Issue se solicitado
  let issueUrl = null;
  if (createIssue) {
    try {
      const gh = getGitHubClient();
      if (GITHUB_TOKEN && GITHUB_DEFAULT_OWNER && GITHUB_DEFAULT_REPO) {
        const issueTitle = `[RemoteFlow Report ${reportId}] ${description.slice(0, 80)}`;
        const issue = await gh.createIssue({
          owner:  GITHUB_DEFAULT_OWNER,
          repo:   GITHUB_DEFAULT_REPO,
          title:  issueTitle,
          body:   reportText,
          labels: ['bug', 'remoteflow-report', severity],
        });
        issueUrl = issue.html_url;
        debug('Report', 'Issue criada: %s', issueUrl);
      }
    } catch (err) {
      debug('Report', 'Erro ao criar GitHub issue: %s', err.message);
    }
  }

  // Adicionar link da issue ao embed se criada
  if (issueUrl) {
    embed.addFields({ name: '🔗 GitHub Issue', value: `[Ver Issue](${issueUrl})`, inline: false });
  }

  // Informar o usuário quando issue foi solicitada mas não pôde ser criada
  if (createIssue && !issueUrl) {
    const hasGitHubConfig = GITHUB_TOKEN && GITHUB_DEFAULT_OWNER && GITHUB_DEFAULT_REPO;
    embed.addFields({
      name: '⚠️ GitHub Issue',
      value: hasGitHubConfig
        ? 'Erro ao criar issue no GitHub. Verifique os logs do bot.'
        : 'GitHub não configurado. Defina `GITHUB_TOKEN`, `GITHUB_DEFAULT_OWNER` e `GITHUB_DEFAULT_REPO`.',
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}

/**
 * Processa interações de select menu e botões
 * @param {import('discord.js').StringSelectMenuInteraction | import('discord.js').ButtonInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
export async function handleInteraction(interaction, sessionManager) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;

  // ─── Modal de feedback de plano ───────────────────────────────────────────────

  if (interaction.isModalSubmit() && interaction.customId.startsWith('plan_feedback_modal_')) {
    const sessionId = interaction.customId.replace('plan_feedback_modal_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    const feedback = interaction.fields.getTextInputValue('plan_feedback_input');
    try {
      await interaction.deferReply({ ephemeral: true });
      if (session.server?.plannotatorBaseUrl) {
        const plannotatorClient = new PlannotatorClient(session.server.plannotatorBaseUrl);
        await plannotatorClient.deny({ feedback });
      }
      await interaction.editReply('📝 **Feedback enviado.** O agente irá revisar o plano.');
      session.notifyPlanReviewResolved();
    } catch (err) {
      console.error('[commands] ❌ Erro ao enviar feedback de plano:', err.message);
      await interaction.editReply(`⚠️ Erro ao enviar feedback: ${err.message}`).catch(() => {});
    }
    return;
  }

  // Select de projeto
  if (interaction.customId.startsWith('select_project_')) {
    const mode = interaction.customId.replace('select_project_', '');
    const projectName = interaction.values[0];

    await interaction.deferUpdate();

    // S-01: Valida e sanitiza o caminho do projeto (prevenção de path traversal)
    const { valid, projectPath, error } = validateAndGetProjectPath(projectName);
    if (!valid) {
      return interaction.editReply({ content: error, components: [] });
    }

    // Verifica se já existe sessão ativa para este projeto
    const existing = sessionManager.getByProject(projectPath);
    if (existing) {
      return interaction.editReply({
        content: `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/stop\`.`,
        components: [],
      });
    }

    const { thread } = await createSessionInThread({
      interaction,
      sessionManager,
      projectPath,
      projectName,
      mode,
    });

    await interaction.editReply({
      content: `✅ Sessão **${mode}** iniciada para \`${projectName}\`!\n👉 ${thread}`,
      components: [],
    });
  }

  // Botão confirmar stop
  if (interaction.customId.startsWith('confirm_stop_')) {
    const sessionId = interaction.customId.replace('confirm_stop_', '');
    const targetSession = sessionManager.getById(sessionId);
    const allowShared = ALLOW_SHARED_SESSIONS;
    if (targetSession && !allowShared && targetSession.userId !== interaction.user.id) {
      return interaction.update({ content: '🚫 Apenas o criador da sessão pode encerrá-la.', components: [] });
    }
    await sessionManager.destroy(sessionId);
    await interaction.update({ content: '✅ Sessão encerrada.', components: [] });
  }

  // Botão cancelar stop
  if (interaction.customId === 'cancel_stop') {
    await interaction.update({ content: '↩️ Cancelado.', components: [] });
  }

  // ─── Publicar review no GitHub ────────────────────────────────────────────────
  if (interaction.customId.startsWith('publish_review_')) {
    const sessionId = interaction.customId.replace('publish_review_', '');
    const context = _reviewContexts.get(sessionId);
    if (!context) {
      await interaction.reply({ content: '❌ Contexto de review não encontrado. A sessão pode ter expirado.', ephemeral: true });
      return;
    }
    const session = sessionManager.getById(sessionId);
    const reviewBody = (session?.outputBuffer || '(sem output da revisão)').slice(0, 65536);

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code === 10062) return;
      throw err;
    }

    try {
      const gh = getGitHubClient();
      const upperBody = reviewBody.toUpperCase();
      let event = 'COMMENT';
      if (upperBody.includes('APPROVE') || upperBody.includes('APROVAR') || upperBody.includes('APROVADO')) {
        event = 'APPROVE';
      } else if (
        upperBody.includes('REQUEST_CHANGES') ||
        upperBody.includes('SOLICITAR MUDANÇAS') ||
        upperBody.includes('MUDANÇAS NECESSÁRIAS')
      ) {
        event = 'REQUEST_CHANGES';
      }

      const review = await gh.createReview({
        owner: context.owner,
        repo: context.repo,
        number: context.number,
        commitId: context.commitId,
        body: reviewBody,
        event,
      });

      _reviewContexts.delete(sessionId);

      // Desabilita o botão após publicar
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`publish_review_${sessionId}`)
          .setLabel('✅ Review Publicado')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      );
      await interaction.message.edit({ components: [row] }).catch(() => {});

      await interaction.editReply(
        `✅ Review publicado no GitHub!\n🔗 PR #${context.number}: https://github.com/${context.owner}/${context.repo}/pull/${context.number}\n📋 Tipo: **${event}**`,
      );
    } catch (err) {
      console.error('[commands] ❌ Erro ao publicar review:', err.message);
      await interaction.editReply(`❌ Erro ao publicar review: ${err.message}`);
    }
    return;
  }

  // ─── Aprovação de Permissão ───────────────────────────────────────────────────
  const { customId } = interaction;

  // Helper local para criar a action row desabilitada com 3 botões
  function buildDisabledPermissionRow(sessionId, chosenLabel) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`allow_once_${sessionId}`)
        .setLabel(chosenLabel === 'once' ? 'Permitido ✅' : 'Permitir uma vez')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('✅')
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`allow_always_${sessionId}`)
        .setLabel(chosenLabel === 'always' ? 'Sempre permitido 🔓' : 'Permitir sempre')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔓')
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`reject_permission_${sessionId}`)
        .setLabel(chosenLabel === 'reject' ? 'Rejeitado ❌' : 'Rejeitar')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
        .setDisabled(true),
    );
  }

  if (customId.startsWith('allow_once_')) {
    const sessionId = customId.replace('allow_once_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode gerenciar permissões.',
        ephemeral: true,
      });
    }
    try {
      const permId = session._pendingPermissionId;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session.resolvePermission();
      await session.server.client.approvePermission(session.apiSessionId, permId);
      await interaction.update({
        content: `✅ **Permitido uma vez** — \`${session.agent}\``,
        components: [buildDisabledPermissionRow(sessionId, 'once')],
      });
    } catch (err) {
      console.error('[commands] ❌ Erro ao aprovar permissão uma vez:', err.message);
      await interaction.reply({ content: '⚠️ Erro ao aprovar permissão.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith('allow_always_')) {
    const sessionId = customId.replace('allow_always_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode gerenciar permissões.',
        ephemeral: true,
      });
    }
    try {
      const permId = session._pendingPermissionId;
      const permData = session._pendingPermissionData;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session.resolvePermission();
      // Cacheia o padrão para auto-aprovar futuras solicitações iguais
      if (permData) {
        session.addAllowedPattern(permData);
      }
      await session.server.client.approvePermission(session.apiSessionId, permId);
      const patternsText = permData?.patterns?.length > 0
        ? `\nPadrões: ${permData.patterns.map(p => `\`${p}\``).join(', ')}`
        : '';
      await interaction.update({
        content: `🔓 **Sempre permitido** — \`${permData?.toolName ?? 'ferramenta'}\`${patternsText}\n*Futuras solicitações com este padrão serão aprovadas automaticamente.*`,
        components: [buildDisabledPermissionRow(sessionId, 'always')],
      });
    } catch (err) {
      console.error('[commands] ❌ Erro ao aprovar permissão sempre:', err.message);
      await interaction.reply({ content: '⚠️ Erro ao aprovar permissão.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith('reject_permission_')) {
    const sessionId = customId.replace('reject_permission_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode gerenciar permissões.',
        ephemeral: true,
      });
    }
    try {
      const permId = session._pendingPermissionId;
      const permData = session._pendingPermissionData;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session.resolvePermission();
      // Tenta rejeitar via API (best-effort — sessão não é abortada)
      if (session.server?.client?.rejectPermission) {
        await session.server.client.rejectPermission(session.apiSessionId, permId).catch((err) => {
          console.error('[commands] ⚠️ rejectPermission falhou (continuando):', err.message);
        });
      }
      await interaction.update({
        content: `❌ **Permissão rejeitada** — \`${permData?.toolName ?? 'ferramenta'}\`\n*O agente tentará uma abordagem alternativa.*`,
        components: [buildDisabledPermissionRow(sessionId, 'reject')],
      });
    } catch (err) {
      console.error('[commands] ❌ Erro ao rejeitar permissão:', err.message);
      await interaction.reply({ content: '⚠️ Erro ao rejeitar permissão.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  // ─── Handlers legados (compatibilidade com mensagens antigas) ─────────────────

  if (customId.startsWith('approve_permission_')) {
    const sessionId = customId.replace('approve_permission_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    try {
      const permId = session._pendingPermissionId;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session._pendingPermissionId = null;
      session._pendingPermissionData = null;
      await session.server.client.approvePermission(session.apiSessionId, permId);
      await interaction.update({ content: '✅ Permissão aprovada.' });
    } catch (err) {
      console.error('[commands] ❌ Erro ao aprovar permissão (legado):', err.message);
      await interaction.reply({ content: '⚠️ Erro ao aprovar permissão.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith('deny_permission_')) {
    const sessionId = customId.replace('deny_permission_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    try {
      await session.abort();
      await interaction.update({ content: '❌ Permissão recusada — sessão encerrada.' });
    } catch (err) {
      console.error('[commands] ❌ Erro ao recusar permissão (legado):', err.message);
      await interaction.reply({ content: '⚠️ Erro ao recusar permissão.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  // ─── Revisão de Plano ─────────────────────────────────────────────────────────

  // Helper para criar row de plano desabilitada
  function buildDisabledPlanRow(sessionId, chosenLabel) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_plan_${sessionId}`)
        .setLabel(chosenLabel === 'approve' ? 'Aprovado ✅' : 'Aprovar e Construir')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`changes_plan_${sessionId}`)
        .setLabel(chosenLabel === 'changes' ? 'Alterações solicitadas 📝' : 'Solicitar Alterações')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📝')
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`reject_plan_${sessionId}`)
        .setLabel(chosenLabel === 'reject' ? 'Rejeitado ❌' : 'Rejeitar')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
        .setDisabled(true),
    );
  }

  if (customId.startsWith('approve_plan_')) {
    const sessionId = customId.replace('approve_plan_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode revisar o plano.',
        ephemeral: true,
      });
    }
    try {
      await interaction.deferUpdate();
      if (session.server?.plannotatorBaseUrl) {
        const plannotatorClient = new PlannotatorClient(session.server.plannotatorBaseUrl);
        await plannotatorClient.approve({ agentSwitch: 'build' });
      }
      await interaction.editReply({
        content: `✅ **Plano aprovado** por ${interaction.user}\n> Agente \`build\` iniciado automaticamente.`,
        components: [buildDisabledPlanRow(sessionId, 'approve')],
      });
      session.notifyPlanReviewResolved();
    } catch (err) {
      console.error('[commands] ❌ Erro ao aprovar plano:', err.message);
      // Plannotator pode já ter sido resolvido (race condition com browser)
      await interaction.editReply({
        content: `✅ **Plano revisado** — decisão já processada.`,
        components: [buildDisabledPlanRow(sessionId, 'approve')],
      }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith('changes_plan_')) {
    const sessionId = customId.replace('changes_plan_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode revisar o plano.',
        ephemeral: true,
      });
    }
    // Abre modal para o usuário digitar o feedback
    const modal = new ModalBuilder()
      .setCustomId(`plan_feedback_modal_${sessionId}`)
      .setTitle('Solicitar Alterações no Plano');
    const feedbackInput = new TextInputBuilder()
      .setCustomId('plan_feedback_input')
      .setLabel('Descreva as alterações desejadas')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Ex: Adicione uma fase de testes antes da implementação...')
      .setRequired(true)
      .setMaxLength(4000);
    const row = new ActionRowBuilder().addComponents(feedbackInput);
    modal.addComponents(row);
    await interaction.showModal(modal);
    return;
  }

  if (customId.startsWith('reject_plan_')) {
    const sessionId = customId.replace('reject_plan_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({
        content: '🚫 Apenas o criador da sessão pode revisar o plano.',
        ephemeral: true,
      });
    }
    try {
      await interaction.deferUpdate();
      if (session.server?.plannotatorBaseUrl) {
        const plannotatorClient = new PlannotatorClient(session.server.plannotatorBaseUrl);
        await plannotatorClient.deny({ feedback: 'Plano rejeitado pelo usuário via Discord.' });
      }
      await interaction.editReply({
        content: `❌ **Plano rejeitado** por ${interaction.user}`,
        components: [buildDisabledPlanRow(sessionId, 'reject')],
      });
      session.notifyPlanReviewResolved();
    } catch (err) {
      console.error('[commands] ❌ Erro ao rejeitar plano:', err.message);
      await interaction.editReply({
        content: `❌ **Plano rejeitado** — ${err.message}`,
        components: [buildDisabledPlanRow(sessionId, 'reject')],
      }).catch(() => {});
    }
    return;
  }
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Cria uma thread Discord e inicia uma sessão OpenCode nela.
 * @param {object} opts
 * @param {import('discord.js').ChatInputCommandInteraction | import('discord.js').StringSelectMenuInteraction} opts.interaction
 * @param {import('./session-manager.js').SessionManager} opts.sessionManager
 * @param {string} opts.projectPath
 * @param {string} opts.projectName
 * @param {'plan'|'build'} opts.mode
 * @param {string} [opts.model=''] - Modelo de IA a usar (vazio = padrão do opencode)
 * @returns {Promise<{ thread: import('discord.js').ThreadChannel, session: import('./session-manager.js').OpenCodeSession }>}
 */
async function createSessionInThread({ interaction, sessionManager, projectPath, projectName, mode, model = '' }) {
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

    const streamHandler = new StreamHandler(thread, session);
    streamHandler.start();

    await thread.send(buildSessionEmbed({ mode, projectName, projectPath, session }));
  } catch (err) {
    // Se a sessão já foi criada antes do erro (ex: thread.send falhou), destrói para não ficar órfã
    if (session) {
      await sessionManager.destroy(session.sessionId).catch((e) =>
        console.error('[commands] ⚠️ Erro ao destruir sessão órfã:', e.message)
      );
    }
    // Limpa a thread órfã para não deixar lixo no Discord
    try {
      await thread.delete();
    } catch (deleteErr) {
      console.error('[commands] ⚠️ Erro ao deletar thread órfã:', deleteErr.message);
    }
    throw err;
  }

  return { thread, session };
}

/**
 * Lista os projetos disponíveis no diretório base.
 * Usa cache em memória com TTL de 60 s para evitar leituras repetidas do filesystem.
 * Deduplica chamadas simultâneas quando o cache está expirado (evita cache stampede).
 * @returns {Promise<string[]>}
 */
async function getProjects() {
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

/**
 * Constrói o embed inicial da sessão
 * @param {object} opts
 * @param {'plan'|'build'} opts.mode
 * @param {string} opts.projectName
 * @param {string} opts.projectPath
 * @param {import('./session-manager.js').OpenCodeSession} opts.session
 * @returns {{ embeds: import('discord.js').EmbedBuilder[] }}
 */
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
      { name: 'Caminho', value: `\`${projectPath}\``, inline: false }
    )
    .setColor(mode === 'plan' ? 0xfee75c : 0x57f287)
    .setTimestamp()
    .setFooter({ text: `Sessão ${session.sessionId.slice(-8)}` });

  return { embeds: [embed] };
}

/**
 * Formata a hora atual em HH:MM (pt-BR)
 * @returns {string}
 */
function formatTime() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
