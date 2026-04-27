// src/command-report.js
// Handler do comando /report

import { AttachmentBuilder } from 'discord.js';
import { audit } from './audit.js';
import { getGitHubClient } from './github.js';
import { GITHUB_TOKEN, GITHUB_DEFAULT_OWNER, GITHUB_DEFAULT_REPO } from './config.js';
import { debug } from './utils.js';
import { analyzeOutput, captureThreadMessages, formatReportText, buildReportEmbed, readRecentLogs } from './reporter.js';
import { replyError } from './command-utils.js';

export async function handleReport(interaction, sessionManager) {
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

  let threadMessages = [];
  try {
    threadMessages = await captureThreadMessages(interaction.channel, 100);
  } catch (err) {
    debug('Report', 'Erro ao buscar mensagens da thread: %s', err.message);
  }

  let logEntries = [];
  try {
    logEntries = await readRecentLogs(200);
  } catch (err) {
    debug('Report', 'Erro ao ler logs persistentes: %s', err.message);
  }

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

  const embed      = buildReportEmbed(reportData);
  const reportText = formatReportText(reportData);
  const attachment = new AttachmentBuilder(Buffer.from(reportText, 'utf-8'), {
    name: `relatorio-${reportId}.txt`,
  });

  await audit('report.created', {
    reportId,
    severity,
    threadId,
    sessionId:      session?.sessionId ?? null,
    hasSession:     !!session,
    errorsDetected: analysis.errors.length,
    createIssue,
  }, reporter.id, session?.sessionId ?? null, interaction.id);

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

  if (issueUrl) {
    embed.addFields({ name: '🔗 GitHub Issue', value: `[Ver Issue](${issueUrl})`, inline: false });
  }

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
