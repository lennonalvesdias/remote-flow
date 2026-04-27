// src/command-session.js
// Handlers de sessão: /plan, /build, /sessions, /status, /stop, /projects,
// /history, /command, /diff, /passthrough, /queue

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import path from 'path';
import { spawn } from 'node:child_process';
import { listOpenCodeCommands } from './opencode-commands.js';
import { formatAge, debug } from './utils.js';
import {
  PROJECTS_BASE,
  ALLOW_SHARED_SESSIONS,
  MAX_SESSIONS_PER_USER,
  MAX_GLOBAL_SESSIONS,
  DEFAULT_MODEL,
} from './config.js';
import { audit } from './audit.js';
import {
  STATUS_EMOJI,
  replyError,
  validateAndGetProjectPath,
  createSessionInThread,
  getProjects,
} from './command-utils.js';

// ─── /plan e /build ───────────────────────────────────────────────────────────

export async function handleStartSession(interaction, sessionManager, mode) {
  let projectName = interaction.options.getString('project');
  const promptText = interaction.options.getString('prompt');
  const modelOption = interaction.options.getString('model') || DEFAULT_MODEL;

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
    throw err;
  }

  if (!projectName) {
    const projects = await getProjects();
    if (projects.length === 0) {
      return interaction.editReply(
        `❌ Nenhum projeto encontrado em \`${PROJECTS_BASE}\`. Configure \`PROJECTS_BASE_PATH\` no .env.`
      );
    }

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

  const { valid, projectPath, error } = validateAndGetProjectPath(projectName);
  if (!valid) return interaction.editReply(error);

  const userSessions = sessionManager.getByUser(interaction.user.id)
    .filter((s) => s.status !== 'finished' && s.status !== 'error');
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    return interaction.editReply(
      `⚠️ Limite de ${MAX_SESSIONS_PER_USER} sessões ativas atingido. Encerre uma sessão existente com \`/stop\`.`
    );
  }

  if (MAX_GLOBAL_SESSIONS > 0) {
    const totalActive = sessionManager.getAll()
      .filter((s) => s.status !== 'finished' && s.status !== 'error').length;
    if (totalActive >= MAX_GLOBAL_SESSIONS) {
      return await replyError(interaction, `Limite global de sessões atingido (${MAX_GLOBAL_SESSIONS}). Tente novamente mais tarde.`);
    }
  }

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

  await audit('session.create', { project: projectName, agent: mode, model: modelOption }, interaction.user.id, session.sessionId, interaction.id);

  if (promptText) {
    await session.sendMessage(promptText);
  }

  await interaction.editReply(
    `✅ Sessão **${mode}** iniciada para \`${projectName}\`!\n👉 Acesse a thread: ${thread}`
  );
}

// ─── /sessions ────────────────────────────────────────────────────────────────

export async function handleListSessions(interaction, sessionManager) {
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

// ─── /status ─────────────────────────────────────────────────────────────────

export async function handleStatus(interaction, sessionManager) {
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
      { name: 'Caminho', value: `\`${s.projectPath}\``, inline: false },
      { name: 'Branch', value: s.gitBranch || 'N/A', inline: true },
      { name: 'Commit', value: s.gitCommit ? `\`${s.gitCommit.hash}\`` : 'N/A', inline: true }
    )
    .setColor(s.status === 'error' ? 0xff0000 : s.status === 'finished' ? 0x00ff00 : 0x5865f2)
    .setTimestamp();

  if (queueSize > 0) {
    embed.addFields({ name: '📮 Fila', value: `${queueSize} mensagem(s) aguardando`, inline: true });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── /stop ────────────────────────────────────────────────────────────────────

export async function handleStop(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread.');
  }

  await audit('session.stop', { project: path.basename(session.projectPath) }, interaction.user.id, session.sessionId, interaction.id);

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

// ─── /projects ────────────────────────────────────────────────────────────────

export async function handleListProjects(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err;
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

// ─── /history ─────────────────────────────────────────────────────────────────

export async function handleHistory(interaction, sessionManager) {
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

// ─── /command ─────────────────────────────────────────────────────────────────

export async function handleRunCommand(interaction, sessionManager) {
  const commandName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') ?? '';

  const session = sessionManager.getByThread(interaction.channelId);

  if (!session) {
    return replyError(interaction, 'Nenhuma sessão ativa nesta thread. Use `/plan` ou `/build` para iniciar uma.');
  }

  await audit('command.run', { command: commandName, args }, interaction.user.id, session.sessionId, interaction.id);

  const commandText = args.trim() ? `/${commandName} ${args.trim()}` : `/${commandName}`;

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err;
  }
  await session.sendMessage(commandText);
  await interaction.editReply(`⚙️ Comando \`${commandText}\` enviado para a sessão.`);
}

export async function handleCommandoAutocomplete(interaction, focusedValue) {
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

// ─── /diff ────────────────────────────────────────────────────────────────────

export async function handleDiffCommand(interaction, sessionManager) {
  const session = sessionManager.getByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '❌ Nenhuma sessão ativa nesta thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  await audit('command.diff', { project: path.basename(session.projectPath) }, interaction.user.id, session.sessionId, interaction.id);

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) {
      console.warn(`[commands] ⏰ Token de interação expirado ao deferir (${interaction.commandName}): ${interaction.id}`);
      return;
    }
    throw err;
  }

  let diffOutput = '';

  try {
    diffOutput = await new Promise((resolve, reject) => {
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

// ─── /passthrough ─────────────────────────────────────────────────────────────

export async function handlePassthrough(interaction, sessionManager) {
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

// ─── /queue ───────────────────────────────────────────────────────────────────

export async function handleFila(interaction, sessionManager) {
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
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return replyError(interaction, 'Apenas o criador da sessão pode limpar a fila.');
    }

    if (session._processingQueue) {
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
