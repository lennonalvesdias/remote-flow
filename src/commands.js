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
} from 'discord.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import path from 'path';
import { StreamHandler } from './stream-handler.js';
import { formatAge, debug } from './utils.js';
import { listOpenCodeCommands } from './opencode-commands.js';
import { PROJECTS_BASE, ALLOWED_USERS, validateProjectPath, MAX_SESSIONS_PER_USER, ALLOW_SHARED_SESSIONS, MAX_GLOBAL_SESSIONS } from './config.js';
import { RateLimiter } from './rate-limiter.js';

const commandRateLimiter = new RateLimiter({ maxActions: 5, windowMs: 60_000 });

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
    .setName('historico')
    .setDescription('Baixa o output completo da sessão como arquivo de texto'),

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

  new SlashCommandBuilder()
    .setName('diff')
    .setDescription('Exibe o diff atual do projeto da sessão desta thread'),
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
  } else if (commandName === 'sessoes') {
    await handleListSessions(interaction, sessionManager);
  } else if (commandName === 'status') {
    await handleStatus(interaction, sessionManager);
  } else if (commandName === 'parar') {
    await handleStop(interaction, sessionManager);
  } else if (commandName === 'projetos') {
    await handleListProjects(interaction);
  } else if (commandName === 'historico') {
    await handleHistory(interaction, sessionManager);
  } else if (commandName === 'comando') {
    await handleRunCommand(interaction, sessionManager);
  } else if (commandName === 'diff') {
    await handleDiffCommand(interaction, sessionManager);
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
  let projectName = interaction.options.getString('projeto');
  const promptText = interaction.options.getString('prompt');

  // S-03: Validações de tamanho de input (antes do defer para respostas ephemeral limpas)
  if (projectName && projectName.length > 256) {
    return await replyError(interaction, 'Nome do projeto muito longo (máximo 256 caracteres).');
  }
  if (promptText && promptText.length > 10000) {
    return await replyError(interaction, 'Mensagem muito longa (máximo 10.000 caracteres).');
  }

  await interaction.deferReply();

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
      `⚠️ Limite de ${MAX_SESSIONS_PER_USER} sessões ativas atingido. Encerre uma sessão existente com \`/parar\`.`
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
      `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/parar\`.`
    );
  }

  const { thread, session } = await createSessionInThread({
    interaction,
    sessionManager,
    projectPath,
    projectName,
    mode,
  });

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
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread.');
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
  const projects = await getProjects();

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
  const commandName = interaction.options.getString('nome', true);
  const args = interaction.options.getString('args') ?? '';

  // Verifica se estamos em uma thread com sessão ativa
  const threadId = interaction.channelId;
  const session = sessionManager.getByThread(threadId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread. Use `/plan` ou `/build` para iniciar uma.');
  }

  // Monta a string do comando e envia para a sessão
  const commandText = args.trim() ? `/${commandName} ${args.trim()}` : `/${commandName}`;

  await interaction.deferReply();
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

  await interaction.deferReply();

  const { spawn } = await import('node:child_process');

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
        if (code !== 0 && err) reject(new Error(err));
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

    // S-01: Valida e sanitiza o caminho do projeto (prevenção de path traversal)
    const { valid, projectPath, error } = validateAndGetProjectPath(projectName);
    if (!valid) {
      return interaction.editReply({ content: error, components: [] });
    }

    // Verifica se já existe sessão ativa para este projeto
    const existing = sessionManager.getByProject(projectPath);
    if (existing) {
      return interaction.editReply({
        content: `⚠️ Já existe uma sessão ativa para \`${projectName}\` nesta thread: <#${existing.threadId}>. Encerre-a primeiro com \`/parar\`.`,
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
 * @returns {Promise<{ thread: import('discord.js').ThreadChannel, session: import('./session-manager.js').OpenCodeSession }>}
 */
async function createSessionInThread({ interaction, sessionManager, projectPath, projectName, mode }) {
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
