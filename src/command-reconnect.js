// src/command-reconnect.js
// Handler do comando /reconnect

import path from 'path';
import { StreamHandler } from './stream-handler.js';
import { loadSessions, removeSession, saveSession } from './persistence.js';

export async function handleReconnect(interaction, sessionManager, serverManager) {
  const channelId = interaction.channelId;

  // Caso 1: sessão ativa em memória → reconexão SSE
  const session = sessionManager.getByThread(channelId);
  if (session) {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code === 10062) return;
      throw err;
    }

    const server = serverManager.getServer(session.projectPath);
    if (!server) {
      await interaction.editReply('❌ Servidor não encontrado para este projeto.');
      return;
    }

    if (server.status === 'stopped' || server.status === 'error') {
      await interaction.editReply(`❌ Servidor está no estado \`${server.status}\`. Use \`/plan\` ou \`/build\` para iniciar uma nova sessão.`);
      return;
    }

    try {
      server.reconnectSSE();
      await interaction.editReply('🔄 Reconexão SSE iniciada. Se a tarefa ainda estava em andamento, a conexão será restaurada automaticamente.');
    } catch (err) {
      await interaction.editReply(`❌ Erro ao reconectar: ${err.message}`);
    }
    return;
  }

  // Caso 2: busca sessão interrompida na persistência
  let allSessions;
  try {
    allSessions = await loadSessions();
  } catch (err) {
    console.error('[Reconnect] Erro ao carregar sessões persistidas:', err);
    await interaction.reply({
      content: '❌ Erro ao carregar sessões. Tente novamente em alguns instantes.',
      ephemeral: true,
    });
    return;
  }

  const interrupted = allSessions.find(
    (s) => s.threadId === channelId && s.status === 'interrupted'
  );

  if (!interrupted) {
    await interaction.reply({
      content: '❌ Nenhuma sessão ativa ou interrompida neste thread.',
      ephemeral: true,
    });
    return;
  }

  if (sessionManager.getByThread(channelId)) {
    await interaction.reply({
      content: '⚠️ Uma sessão já está ativa neste thread. Use `/status` para verificar.',
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply();
  } catch (err) {
    if (err.code === 10062) return;
    throw err;
  }

  try {
    const thread = await interaction.client.channels.fetch(channelId);

    const newSession = await sessionManager.create({
      projectPath: interrupted.projectPath,
      threadId: channelId,
      userId: interrupted.userId,
      agent: interrupted.agent,
      model: interrupted.model ?? '',
    });

    await newSession.loadGitInfo();

    await removeSession(interrupted.sessionId);

    const streamHandler = new StreamHandler(thread, newSession);
    streamHandler.start();

    await interaction.editReply(
      `🔄 **Sessão restaurada!** Projeto: \`${path.basename(interrupted.projectPath)}\`, agente: \`${interrupted.agent}\`.`
    );
  } catch (err) {
    console.error('[Reconnect] Erro ao restaurar sessão:', err);
    await saveSession(interrupted).catch((e) =>
      console.error('[Reconnect] Erro ao re-persistir sessão interrompida após falha:', e)
    );
    await interaction.editReply('❌ Falha ao restaurar a sessão. Tente `/reconnect` novamente ou use `/plan` / `/build` para iniciar uma nova.');
  }
}
