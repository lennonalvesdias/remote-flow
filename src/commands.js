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
} from 'discord.js';
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { StreamHandler } from './stream-handler.js';
import { formatAge } from './utils.js';
import { listOpenCodeCommands } from './opencode-commands.js';

const PROJECTS_BASE = process.env.PROJECTS_BASE_PATH || 'C:\\projetos';
const ALLOWED_USERS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const STATUS_EMOJI = { running: '⚙️', waiting_input: '💬', finished: '✅', error: '❌', idle: '💤' };

// ─── Definições dos comandos ──────────────────────────────────────────────────

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('plan')
    .setDescription('Inicia uma sessão de planejamento (agent plan) em um projeto')
    .addStringOption((o) =>
      o.setName('projeto')
       .setDescription('Nome da pasta do projeto')
       .setRequired(false)
       .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName('prompt').setDescription('Descrição inicial da tarefa').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('build')
    .setDescription('Inicia uma sessão de desenvolvimento (agent build) em um projeto')
    .addStringOption((o) =>
      o.setName('projeto')
       .setDescription('Nome da pasta do projeto')
       .setRequired(false)
       .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName('prompt').setDescription('Descrição do que deve ser desenvolvido').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('sessoes')
    .setDescription('Lista todas as sessões OpenCode ativas'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra o status da sessão na thread atual'),

  new SlashCommandBuilder()
    .setName('parar')
    .setDescription('Encerra a sessão OpenCode na thread atual'),

  new SlashCommandBuilder()
    .setName('projetos')
    .setDescription('Lista os projetos disponíveis em PROJECTS_BASE_PATH'),

  new SlashCommandBuilder()
    .setName('comando')
    .setDescription('Executa um comando opencode personalizado na sessão atual')
    .addStringOption((o) =>
      o.setName('nome')
       .setDescription('Nome do comando a executar')
       .setRequired(true)
       .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName('args')
       .setDescription('Argumentos opcionais para o comando')
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
  // Verificação de acesso
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(interaction.user.id)) {
    return interaction.reply({
      content: '🚫 Você não tem permissão para usar este bot.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const { commandName } = interaction;

  if (commandName === 'plan' || commandName === 'build') {
    await handleStartSession(interaction, sessionManager, commandName);
  } else if (commandName === 'sessoes') {
    await handleListSessions(interaction, sessionManager);
  } else if (commandName === 'status') {
    await handleStatus(interaction, sessionManager);
  } else if (commandName === 'parar') {
    await handleStop(interaction, sessionManager);
  } else if (commandName === 'projetos') {
    await handleListProjects(interaction);
  } else if (commandName === 'comando') {
    await handleRunCommand(interaction, sessionManager);
  }
}

/**
 * Responde a autocomplete de projeto para /plan e /build,
 * e de nome de comando para /comando
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function handleAutocomplete(interaction) {
  const { commandName } = interaction;

  // Autocomplete de nome de comando para /comando
  if (commandName === 'comando') {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'nome') {
      await handleCommandoAutocomplete(interaction, focusedOption.value);
    }
    return;
  }

  // Autocomplete de projeto para /plan e /build
  const focused = interaction.options.getFocused().toLowerCase();
  const projects = getProjects();
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
  await interaction.deferReply();

  let projectName = interaction.options.getString('projeto');
  const promptText = interaction.options.getString('prompt');

  // Se não passou projeto, mostra selector
  if (!projectName) {
    const projects = getProjects();
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

  // Valida e sanitiza o caminho do projeto (prevenção de path traversal)
  const resolvedBase = path.resolve(PROJECTS_BASE);
  const projectPath = path.resolve(PROJECTS_BASE, projectName);
  if (!projectPath.startsWith(resolvedBase + path.sep) && projectPath !== resolvedBase) {
    return interaction.editReply('❌ Caminho de projeto inválido.');
  }
  if (!existsSync(projectPath)) {
    return interaction.editReply(`❌ Projeto \`${projectName}\` não encontrado em \`${PROJECTS_BASE}\`.`);
  }

  // Verifica se já existe sessão ativa para este projeto
  const existing = sessionManager.getByProject(projectPath);
  if (existing) {
    return interaction.editReply(
      `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/parar\`.`
    );
  }

  // Cria thread para a sessão
  const threadName = `${mode === 'plan' ? '📋 Plan' : '🔨 Build'} · ${projectName} · ${formatTime()}`;
  const thread = await interaction.channel.threads.create({
    name: threadName,
    autoArchiveDuration: 1440, // 24h
    reason: `Sessão OpenCode ${mode} para ${projectName}`,
  });

  // Cria e inicia a sessão
  const session = await sessionManager.create({
    projectPath,
    threadId: thread.id,
    userId: interaction.user.id,
    agent: mode,
  });

  const streamHandler = new StreamHandler(thread, session);
  streamHandler.start();

  // Mensagem inicial na thread
  await thread.send(buildSessionEmbed({ mode, projectName, projectPath, session }));

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
    return interaction.reply({
      content: '❌ Nenhuma sessão OpenCode associada a esta thread.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const s = session.toSummary();

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
    return interaction.reply({
      content: '❌ Nenhuma sessão ativa nesta thread.',
      flags: MessageFlags.Ephemeral,
    });
  }

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
  const projects = getProjects();

  if (projects.length === 0) {
    return interaction.reply({
      content: `📭 Nenhum projeto encontrado em \`${PROJECTS_BASE}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('📁 Projetos Disponíveis')
    .setDescription(projects.map((p) => `• \`${p}\``).join('\n'))
    .setColor(0x57f287)
    .setFooter({ text: `Base: ${PROJECTS_BASE}` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
 * Executa um comando opencode personalizado na sessão atual da thread.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
async function handleRunCommand(interaction, sessionManager) {
  const commandName = interaction.options.getString('nome', true);
  const args = interaction.options.getString('args') ?? '';

  // Verifica se estamos em uma thread com sessão ativa
  const threadId = interaction.channelId;
  const session = sessionManager.getByThread(threadId);

  if (!session) {
    return interaction.reply({
      content: '❌ Nenhuma sessão ativa nesta thread. Use `/plan` ou `/build` para iniciar uma.',
      ephemeral: true,
    });
  }

  // Monta a string do comando e envia para a sessão
  const commandText = args.trim() ? `/${commandName} ${args.trim()}` : `/${commandName}`;

  await interaction.deferReply();
  await session.sendMessage(commandText);
  await interaction.editReply(`⚙️ Comando \`${commandText}\` enviado para a sessão.`);
}

// ─── Handler de interações (select menus, botões) ─────────────────────────────

/**
 * Processa interações de select menu e botões
 * @param {import('discord.js').StringSelectMenuInteraction | import('discord.js').ButtonInteraction} interaction
 * @param {import('./session-manager.js').SessionManager} sessionManager
 */
export async function handleInteraction(interaction, sessionManager) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

  // Select de projeto
  if (interaction.customId.startsWith('select_project_')) {
    const mode = interaction.customId.replace('select_project_', '');
    const projectName = interaction.values[0];

    await interaction.deferUpdate();

    // Valida e sanitiza o caminho do projeto (prevenção de path traversal)
    const resolvedBase = path.resolve(PROJECTS_BASE);
    const projectPath = path.resolve(PROJECTS_BASE, projectName);
    if (!projectPath.startsWith(resolvedBase + path.sep) && projectPath !== resolvedBase) {
      return interaction.editReply({ content: '❌ Caminho de projeto inválido.', components: [] });
    }
    if (!existsSync(projectPath)) {
      return interaction.editReply({
        content: `❌ Projeto \`${projectName}\` não encontrado em \`${PROJECTS_BASE}\`.`,
        components: [],
      });
    }

    // Verifica se já existe sessão ativa para este projeto
    const existing = sessionManager.getByProject(projectPath);
    if (existing) {
      return interaction.editReply({
        content: `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/parar\`.`,
        components: [],
      });
    }

    const threadName = `${mode === 'plan' ? '📋 Plan' : '🔨 Build'} · ${projectName} · ${formatTime()}`;
    const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
    });

    const session = await sessionManager.create({
      projectPath,
      threadId: thread.id,
      userId: interaction.user.id,
      agent: mode,
    });

    const streamHandler = new StreamHandler(thread, session);
    streamHandler.start();

    await thread.send(buildSessionEmbed({ mode, projectName, projectPath, session }));

    await interaction.editReply({
      content: `✅ Sessão **${mode}** iniciada para \`${projectName}\`!\n👉 ${thread}`,
      components: [],
    });
  }

  // Botão confirmar stop
  if (interaction.customId.startsWith('confirm_stop_')) {
    const sessionId = interaction.customId.replace('confirm_stop_', '');
    await sessionManager.destroy(sessionId);
    await interaction.update({ content: '✅ Sessão encerrada.', components: [] });
  }

  // Botão cancelar stop
  if (interaction.customId === 'cancel_stop') {
    await interaction.update({ content: '↩️ Cancelado.', components: [] });
  }
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Lista os projetos disponíveis no diretório base
 * @returns {string[]}
 */
function getProjects() {
  try {
    return readdirSync(PROJECTS_BASE, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
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
      `• Use \`/parar\` para encerrar\n\n` +
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
