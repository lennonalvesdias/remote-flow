// src/index.js
// Entry point — inicializa o bot Discord e conecta tudo

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  MessageFlags,
} from 'discord.js';
import { SessionManager } from './session-manager.js';
import { ServerManager } from './server-manager.js';
import { handleCommand, handleInteraction, handleAutocomplete, commandDefinitions } from './commands.js';
import { formatAge, debug } from './utils.js';
import { ALLOWED_USERS, ALLOW_SHARED_SESSIONS, CHANNEL_FETCH_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from './config.js';
import { startHealthServer } from './health.js';

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
  console.log(`\n🤖 Bot online: ${c.user.tag}`);
  console.log(`📁 Projetos: ${process.env.PROJECTS_BASE_PATH}`);
  console.log(`🔧 OpenCode: ${process.env.OPENCODE_BIN || 'opencode'}\n`);
  await registerCommands();
  startHealthServer({ sessionManager, serverManager, startedAt: Date.now() });
});

// Slash commands, autocomplete e interações de componentes
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, sessionManager);
    } else {
      await handleInteraction(interaction, sessionManager);
    }
  } catch (err) {
    console.error('[interactionCreate] Erro:', err);
    // Interações de autocomplete não suportam reply/followUp — nada a fazer
    if (interaction.isAutocomplete()) return;
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

  // Não aceita input enquanto está processando (exceto comandos especiais)
  const text = message.content.trim();

  // Comandos especiais inline
  if (text === '/stop' || text === '/parar') {
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
  try {
    await session.sendMessage(text);
  } catch (err) {
    debug('index', '❌ Erro ao enviar mensagem:', err.message);
    await message.reply('⚠️ O processo OpenCode não está ativo nesta sessão. Use `/plan` ou `/build` para iniciar uma nova.').catch(() => {});
    return;
  }

  debug('Bot', `↩️  input encaminhado para opencode`);

  // Reação visual de "recebido"
  try {
    await message.react('⚙️');
  } catch (reactErr) {
    debug('Bot', '⚠️ Erro ao reagir à mensagem: %s', reactErr.message);
  }
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
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
