// src/command-github.js
// Handlers de GitHub: /pr create|list|review  e  /issue list|implement

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import path from 'path';
import { audit } from './audit.js';
import { getGitHubClient } from './github.js';
import { getRepoInfo, hasChanges, createBranchAndCommit, pushBranch } from './git.js';
import {
  GITHUB_TOKEN,
  GITHUB_DEFAULT_OWNER,
  GITHUB_DEFAULT_REPO,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_MODEL,
} from './config.js';
import {
  replyError,
  validateAndGetProjectPath,
  createSessionInThread,
} from './command-utils.js';

// ─── Contextos de review pendentes (sessionId → metadados do PR) ──────────────
// Exportado para uso em command-interactions.js (botão "Publicar Review")
export const _reviewContexts = new Map();

// ─── Helper ───────────────────────────────────────────────────────────────────

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

// ─── /pr ─────────────────────────────────────────────────────────────────────

export async function handlePrCommand(interaction, sessionManager) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'create') await handlePrCreate(interaction, sessionManager);
  else if (subcommand === 'list') await handlePrList(interaction, sessionManager);
  else if (subcommand === 'review') await handlePrReview(interaction, sessionManager);
}

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

    await audit('pr.create', { owner, repo, number: pr.number, branch: branchName }, interaction.user.id, session.sessionId, interaction.id);

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

    await audit('pr.review', { owner, repo, prNumber }, interaction.user.id, session.sessionId, interaction.id);

    await interaction.editReply(
      `🔍 Revisão do **PR #${prNumber}** iniciada para \`${projectName}\`!\n👉 Acesse a thread: ${thread}`,
    );
  } catch (err) {
    console.error('[commands] ❌ Erro ao iniciar review:', err.message);
    await interaction.editReply(`❌ Erro ao iniciar revisão do PR: ${err.message}`);
  }
}

// ─── /issue ───────────────────────────────────────────────────────────────────

export async function handleIssueCommand(interaction, sessionManager) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') await handleIssueList(interaction, sessionManager);
  else if (subcommand === 'implement') await handleIssueImplement(interaction, sessionManager);
}

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

    await audit('issue.implement', { owner, repo, issueNumber }, interaction.user.id, session.sessionId, interaction.id);

    await interaction.editReply(
      `🐛 Implementação da **Issue #${issueNumber}** iniciada para \`${projectOption}\`!\n👉 Acesse a thread: ${thread}\n\n💡 Após a sessão concluir, use \`/pr create\` para criar o Pull Request.`,
    );
  } catch (err) {
    console.error('[commands] ❌ Erro ao iniciar implementação:', err.message);
    await interaction.editReply(`❌ Erro ao iniciar implementação da issue: ${err.message}`);
  }
}
