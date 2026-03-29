// src/index.js
// Entry point — inicializa o bot Discord e conecta tudo

import { initConsoleLogger } from './console-logger.js';
initConsoleLogger(); // deve ser chamado antes de qualquer outro import

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  MessageFlags,
} from 'discord.js';
import path from 'node:path';
import { SessionManager } from './session-manager.js';
import { ServerManager } from './server-manager.js';
import { handleCommand, handleInteraction, handleAutocomplete, commandDefinitions } from './commands.js';
import { formatAge, debug } from './utils.js';
import { ALLOWED_USERS, ALLOW_SHARED_SESSIONS, CHANNEL_FETCH_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS, VOICE_MAX_DURATION_SECS, VOICE_SHOW_TRANSCRIPT, VOICE_CDN_DOWNLOAD_TIMEOUT_MS } from './config.js';
import { startHealthServer } from './health.js';
import { loadSessions, removeSession } from './persistence.js';
import { initAudit, audit } from './audit.js';
import { initLogger, logError, logWarn } from './logger.js';
import { loadModels } from './model-loader.js';
import { provider as transcriptionProvider } from './transcription-provider.js';
import { getVoiceAttachment } from './voice-utils.js';

// ─── Validação de configuração ────────────────────────────────────────────────

const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'PROJECTS_BASE_PATH'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Variáveis de ambiente faltando: ${missing.join(', ')}`);
  console.error('   Copie .env.example para .env e preencha os valores.');
  process.exit(1);
}

// ─── Inicialização ─────────────────────────────────────────────────────────────

const serverManager = new ServerManager();
const sessionManager = new SessionManager(serverManager);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let transcriptionAvailable = false;
let _lastTranscriptionHealthCheck = 0;
const TRANSCRIPTION_HEALTH_TTL_MS = 60_000; // reavalia provider a cada 60s

/** Verifica (ou usa cache) se o provider de transcrição está disponível. */
async function isTranscriptionAvailable() {
  if (Date.now() - _lastTranscriptionHealthCheck > TRANSCRIPTION_HEALTH_TTL_MS) {
    transcriptionAvailable = await transcriptionProvider.checkHealth();
    _lastTranscriptionHealthCheck = Date.now();
  }
  return transcriptionAvailable;
}

// ─── Registro de slash commands ───────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📡 Registrando slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(
        client.application?.id || process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commandDefinitions }
    );
    console.log('✅ Slash commands registrados.');
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err.message);
  }
}

// ─── Eventos do Discord ───────────────────────────────────────────────────────

client.once('clientReady', async (c) => {
  // Notificar threads de sessões que foram interrompidas pelo restart
  try {
    const persistedSessions = await loadSessions();
    const activeSessions = persistedSessions.filter(s => s.status === 'active');
    if (activeSessions.length > 0) {
      console.log(`[Index] ⚠️ ${activeSessions.length} sessão(ões) interrompida(s) pelo restart`);
      for (const s of activeSessions) {
        try {
          const channel = await Promise.race([
            client.channels.fetch(s.threadId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout fetch canal')), 5_000)),
          ]).catch(() => null);
          if (channel && channel.isThread()) {
            await channel.send(
              `⚠️ **O bot foi reiniciado** e a sessão \`${s.sessionId}\` (projeto \`${path.basename(s.projectPath)}\`) foi encerrada.\n` +
              `Use \`/plan\` ou \`/build\` para iniciar uma nova sessão.`
            );
          }
        } catch (err) {
          console.error(`[Index] Erro ao notificar thread ${s.threadId}:`, err);
        }
        // Remover sessão interrompida da persistência (após notificar)
        await removeSession(s.sessionId).catch(err =>
          console.error(`[Index] Erro ao remover sessão ${s.sessionId} da persistência:`, err)
        );
      }
    }
  } catch (err) {
    console.error('[Index] Erro ao carregar sessões persistidas:', err);
  }

  console.log(`\n🤖 Bot online: ${c.user.tag}`);
  console.log(`📁 Projetos: ${process.env.PROJECTS_BASE_PATH}`);
  console.log(`🔧 OpenCode: ${process.env.OPENCODE_BIN || 'opencode'}\n`);
  await initAudit();
  await initLogger();
  await loadModels();
  // Verifica disponibilidade do provider de transcrição de voz
  transcriptionAvailable = await transcriptionProvider.checkHealth();
  _lastTranscriptionHealthCheck = Date.now();
  if (transcriptionAvailable) {
    console.log(`✅ Transcrição de voz habilitada (provider: ${transcriptionProvider.name})`);
  } else {
    console.warn(`⚠️  Transcrição de voz indisponível (provider: ${transcriptionProvider.name})`);
    if (transcriptionProvider.name === 'local') {
      console.warn('   Inicie com: .venv-whisper\\Scripts\\activate && python whisper_server/server.py');
    } else {
      console.warn('   Verifique se TRANSCRIPTION_API_KEY está configurada corretamente.');
    }
  }
  await registerCommands();
  startHealthServer({ sessionManager, serverManager, startedAt: Date.now() });
});

// Slash commands, autocomplete e interações de componentes
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, sessionManager, serverManager);
    } else {
      await handleInteraction(interaction, sessionManager);
    }
  } catch (err) {
    logError('interactionCreate', `Erro não tratado: ${err?.message ?? String(err)}`);
    // Interações de autocomplete não suportam reply/followUp — nada a fazer
    if (interaction.isAutocomplete()) return;
    // 10062 = token expirado; nenhuma resposta é possível
    if (err.code === 10062) return;
    const reply = { content: '❌ Ocorreu um erro interno. Por favor, tente novamente.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (replyErr) {
      console.error('[interactionCreate] Erro ao enviar resposta de erro:', replyErr.message);
    }
  }
});

// Mensagens nas threads — encaminha para stdin da sessão
client.on('messageCreate', async (message) => {
  // Ignora mensagens do próprio bot
  if (message.author.bot) return;

  // Só processa se estiver dentro de uma thread
  if (!message.channel.isThread()) return;

  // Verificação de usuários autorizados
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(message.author.id)) return;

  // Restrição de canal (opcional)
  const allowedChannelId = process.env.DISCORD_ALLOWED_CHANNEL_ID;
  if (allowedChannelId) {
    // Para threads, verificar o canal pai
    const parentId = message.channel.parentId;
    if (parentId !== allowedChannelId) return;
  }

  // Verifica se existe uma sessão associada a essa thread
  const session = sessionManager.getByThread(message.channel.id);
  if (!session) return;

  // Verifica ownership da sessão (a menos que sessões compartilhadas estejam habilitadas)
  if (!ALLOW_SHARED_SESSIONS && session.userId !== message.author.id) {
    debug('Bot', '🚫 Usuário %s tentou interagir com sessão de %s', message.author.id, session.userId);
    return;
  }

  // ─── Mensagens de voz ─────────────────────────────────────────────────────
  const voiceAttachment = getVoiceAttachment(message);

  if (voiceAttachment) {
    // Ignora silenciosamente se transcrição não estiver disponível
    if (!(await isTranscriptionAvailable())) return;

    // Passthrough deve estar ativo para encaminhar ao OpenCode
    if (!session.passthroughEnabled) {
      debug('Bot', '⏸️ Passthrough desativado — mensagem de voz ignorada na thread %s', message.channel.id);
      return;
    }

    // Valida duração máxima
    const duration = voiceAttachment.duration ?? 0;
    if (duration > VOICE_MAX_DURATION_SECS) {
      await message.reply(`❌ Mensagem de voz muito longa (${Math.round(duration)}s). Limite: ${VOICE_MAX_DURATION_SECS}s.`).catch(() => {});
      return;
    }

    // Valida tamanho máximo antes de baixar (Discord expõe .size em bytes)
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
    if (voiceAttachment.size > MAX_AUDIO_BYTES) {
      await message.reply(
        `❌ Arquivo de áudio muito grande (${(voiceAttachment.size / 1024 / 1024).toFixed(1)} MB). Limite: 25 MB.`
      ).catch(() => {});
      return;
    }

    // Reação visual imediata
    try { await message.react('🎙️'); } catch { /* ignora */ }

    try {
      // Baixa o áudio da CDN do Discord
      const audioResponse = await fetch(voiceAttachment.url, { signal: AbortSignal.timeout(VOICE_CDN_DOWNLOAD_TIMEOUT_MS) });
      if (!audioResponse.ok) throw new Error(`Falha ao baixar áudio: HTTP ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Transcreve via provider configurado
      const filename = voiceAttachment.name || 'voice.ogg';
      const { text, duration: transcribedDuration } = await transcriptionProvider.transcribe(audioBuffer, filename);

      if (!text || !text.trim()) {
        await message.reactions.cache.get('🎙️')?.remove().catch(() => {});
        await message.react('❓').catch(() => {});
        await message.reply('❓ Não foi possível identificar fala no áudio. Tente enviar como texto.').catch(() => {});
        return;
      }

      const trimmedText = text.trim();

      // Exibe transcrição na thread (se habilitado)
      if (VOICE_SHOW_TRANSCRIPT) {
        const preview = trimmedText.length > 500 ? trimmedText.slice(0, 497) + '...' : trimmedText;
        await message.reply(`> 🎙️ *"${preview}"*`).catch(() => {});
      }

      // Encaminha para a sessão OpenCode
      let queueResult;
      try {
        queueResult = await session.queueMessage(trimmedText);
      } catch (queueErr) {
        debug('index', '❌ Erro ao enfileirar mensagem de voz:', queueErr.message);
        await message.reply('⚠️ O processo OpenCode não está ativo nesta sessão.').catch(() => {});
        return;
      }

      // Feedback final
      await message.reactions.cache.get('🎙️')?.remove().catch(() => {});
      await message.react('✅').catch(() => {});

      if (queueResult.queued) {
        await message.reply(`📮 Transcrição enfileirada (posição ${queueResult.position}).`).catch(() => {});
      }

      await audit(
        'message.voice',
        { duration: transcribedDuration ?? duration, textLength: trimmedText.length, provider: transcriptionProvider.name },
        message.author.id,
        session.sessionId
      );

    } catch (err) {
      console.error('[index] ❌ Erro ao processar mensagem de voz:', err.message);
      await message.reactions.cache.get('🎙️')?.remove().catch(() => {});
      await message.react('❌').catch(() => {});
      await message.reply('❌ Não foi possível transcrever o áudio. Tente enviar como texto.').catch(() => {});
    }

    return; // não processar como mensagem de texto
  }
  // ─── Fim mensagens de voz ─────────────────────────────────────────────────

  // Não aceita input enquanto está processando (exceto comandos especiais)
  const text = message.content.trim();

  // Comandos especiais inline
  if (text === '/stop') {
    await sessionManager.destroy(session.sessionId);
    await message.reply('🛑 Sessão encerrada.');
    return;
  }

  if (text === '/status') {
    const s = session.toSummary();
    await message.reply(
      `**Status:** ${s.status}\n**Projeto:** ${s.project}\n**Última atividade:** ${formatAge(s.lastActivityAt)} atrás`
    );
    return;
  }

  // Envia o input para o processo OpenCode
  debug('Bot', `💬 mensagem na thread | threadId=${message.channel.id} | user=${message.author.tag} | texto=${JSON.stringify(text.slice(0, 80))}`);
  debug('Bot', `🔗 sessão encontrada | sessionId=${session.sessionId} | status=${session.status}`);

  // Verifica se o passthrough está ativo — se desativado, ignora mensagens inline
  if (!session.passthroughEnabled) {
    debug('Bot', '⏸️ Passthrough desativado — mensagem ignorada na thread %s', message.channel.id);
    return;
  }

  let queueResult;
  try {
    queueResult = await session.queueMessage(text);
  } catch (err) {
    debug('index', '❌ Erro ao enfileirar mensagem:', err.message);
    await message.reply('⚠️ O processo OpenCode não está ativo nesta sessão. Use `/plan` ou `/build` para iniciar uma nova.').catch(() => {});
    return;
  }

  debug('Bot', `↩️  input encaminhado para opencode`);

  if (queueResult.queued) {
    // Mensagem enfileirada — informa posição ao usuário
    try {
      await message.reply(`📮 Sua mensagem foi enfileirada (posição ${queueResult.position}). Ela será enviada quando o agente concluir a tarefa atual.`);
    } catch (replyErr) {
      debug('Bot', '⚠️ Erro ao notificar posição na fila: %s', replyErr.message);
    }
  } else {
    // Mensagem enviada imediatamente — reação visual de "recebido"
    try {
      await message.react('⚙️');
    } catch (reactErr) {
      debug('Bot', '⚠️ Erro ao reagir à mensagem: %s', reactErr.message);
    }
  }

  await audit('message.passthrough', { text: text.slice(0, 100) }, message.author.id, session.sessionId);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando sessões...`);
  const sessions = sessionManager.getAll().filter((s) => s.status !== 'finished' && s.status !== 'error');

  // Busca canal com timeout para não travar se o Discord estiver inacessível
  const fetchWithTimeout = (channelId) =>
    Promise.race([
      client.channels.fetch(channelId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CHANNEL_FETCH_TIMEOUT_MS)
      ),
    ]);

  // Notifica usuários nas threads ativas
  await Promise.allSettled(
    sessions.map(async (s) => {
      try {
        const channel = await fetchWithTimeout(s.threadId);
        if (channel) await channel.send('⚠️ **Bot reiniciando.** Sua sessão será encerrada.');
      } catch {
        // thread pode já estar arquivada ou Discord inacessível
      }
    })
  );

  // Encerra sessões com timeout de segurança
  const closePromise = Promise.allSettled(sessions.map((s) => s.close()));
  await Promise.race([closePromise, new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS))]);

  await serverManager.stopAll();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  logError('uncaughtException', err?.message ?? String(err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  logError('unhandledRejection', reason instanceof Error ? reason.message : String(reason));
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
