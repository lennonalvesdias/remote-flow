// src/commands.js
// Router de slash commands — thin layer que delega para módulos de feature.
// API pública inalterada: commandDefinitions, handleCommand, handleAutocomplete,
// handleInteraction, getRateLimitStats, _resetProjectsCache.

import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import path from 'path';
import { ALLOWED_USERS, DEFAULT_MODEL } from './config.js';
import { getAvailableModels } from './model-loader.js';
import { RateLimiter } from './rate-limiter.js';

// ─── Feature handlers ─────────────────────────────────────────────────────────

import {
  handleStartSession,
  handleListSessions,
  handleStatus,
  handleStop,
  handleListProjects,
  handleHistory,
  handleRunCommand,
  handleCommandoAutocomplete,
  handleDiffCommand,
  handlePassthrough,
  handleFila,
} from './command-session.js';

import {
  handlePrCommand,
  handleIssueCommand,
} from './command-github.js';

import { handleReconnect } from './command-reconnect.js';
import { handleReport } from './command-report.js';
export { handleInteraction } from './command-interactions.js';
export { _resetProjectsCache } from './command-utils.js';
import { getProjects } from './command-utils.js';

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const commandRateLimiter = new RateLimiter({ maxActions: 5, windowMs: 60_000 });

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

  new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription('Reconecta a sessão SSE do servidor opencode deste thread'),
].map((c) => c.toJSON());

// ─── Router principal ─────────────────────────────────────────────────────────

export async function handleCommand(interaction, sessionManager, serverManager) {
  const AGE_LIMIT_MS = 2500;
  if (Date.now() - interaction.createdTimestamp > AGE_LIMIT_MS) {
    console.warn(`[commands] ⏰ Interação expirada ignorada (${Date.now() - interaction.createdTimestamp}ms): ${interaction.commandName}`);
    return;
  }

  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(interaction.user.id)) {
    const payload = { content: '❌ Você não tem permissão para usar este bot.', flags: MessageFlags.Ephemeral };
    return interaction.reply(payload).catch(() => {});
  }

  const { allowed, retryAfterMs } = commandRateLimiter.check(interaction.user.id);
  if (!allowed) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    const payload = { content: `❌ Rate limit atingido. Tente novamente em ${seconds}s.`, flags: MessageFlags.Ephemeral };
    return interaction.reply(payload).catch(() => {});
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
  } else if (commandName === 'reconnect') {
    await handleReconnect(interaction, sessionManager, serverManager);
  }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

export async function handleAutocomplete(interaction) {
  const { commandName } = interaction;

  if (commandName === 'command') {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'name') {
      await handleCommandoAutocomplete(interaction, focusedOption.value);
    }
    return;
  }

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

  if (commandName === 'plan' || commandName === 'build') {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'model') {
      const models = getAvailableModels().filter((m) => m.startsWith(focused.value));
      await interaction.respond(models.slice(0, 25).map((m) => ({ name: m, value: m })));
      return;
    }
  }

  const focused = interaction.options.getFocused().toLowerCase();
  const projects = await getProjects();
  const filtered = projects
    .filter((p) => p.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((p) => ({ name: p, value: p }));
  await interaction.respond(filtered);
}
