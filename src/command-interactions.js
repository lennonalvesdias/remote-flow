// src/command-interactions.js
// Handler de interações de componentes: select menus, botões e modals

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { ALLOW_SHARED_SESSIONS } from './config.js';
import { PlannotatorClient } from './plannotator-client.js';
import { getGitHubClient } from './github.js';
import { createSessionInThread, validateAndGetProjectPath } from './command-utils.js';
import { _reviewContexts } from './command-github.js';

// ─── Helpers de UI ────────────────────────────────────────────────────────────

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

// ─── Handler principal ────────────────────────────────────────────────────────

export async function handleInteraction(interaction, sessionManager) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;

  // ─── Modal de feedback de plano ──────────────────────────────────────────────

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

  // ─── Select de projeto ────────────────────────────────────────────────────────

  if (interaction.customId.startsWith('select_project_')) {
    const mode = interaction.customId.replace('select_project_', '');
    const projectName = interaction.values[0];

    await interaction.deferUpdate();

    const { valid, projectPath, error } = validateAndGetProjectPath(projectName);
    if (!valid) {
      return interaction.editReply({ content: error, components: [] });
    }

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
    return;
  }

  // ─── Botão confirmar stop ────────────────────────────────────────────────────

  if (interaction.customId.startsWith('confirm_stop_')) {
    const sessionId = interaction.customId.replace('confirm_stop_', '');
    const targetSession = sessionManager.getById(sessionId);
    if (targetSession && !ALLOW_SHARED_SESSIONS && targetSession.userId !== interaction.user.id) {
      return interaction.update({ content: '🚫 Apenas o criador da sessão pode encerrá-la.', components: [] });
    }
    await sessionManager.destroy(sessionId);
    await interaction.update({ content: '✅ Sessão encerrada.', components: [] });
    return;
  }

  if (interaction.customId === 'cancel_stop') {
    await interaction.update({ content: '↩️ Cancelado.', components: [] });
    return;
  }

  // ─── Publicar review no GitHub ───────────────────────────────────────────────

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

  const { customId } = interaction;

  // ─── Aprovação de permissão — allow_once ─────────────────────────────────────

  if (customId.startsWith('allow_once_')) {
    const sessionId = customId.replace('allow_once_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode gerenciar permissões.', ephemeral: true });
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

  // ─── Aprovação de permissão — allow_always ────────────────────────────────────

  if (customId.startsWith('allow_always_')) {
    const sessionId = customId.replace('allow_always_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode gerenciar permissões.', ephemeral: true });
    }
    try {
      const permId = session._pendingPermissionId;
      const permData = session._pendingPermissionData;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session.resolvePermission();
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

  // ─── Rejeição de permissão ───────────────────────────────────────────────────

  if (customId.startsWith('reject_permission_')) {
    const sessionId = customId.replace('reject_permission_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode gerenciar permissões.', ephemeral: true });
    }
    try {
      const permId = session._pendingPermissionId;
      const permData = session._pendingPermissionData;
      if (!permId) {
        await interaction.reply({ content: '⚠️ Nenhuma permissão pendente.', ephemeral: true });
        return;
      }
      session.resolvePermission();
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

  // ─── Handlers legados (compatibilidade) ──────────────────────────────────────

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

  if (customId.startsWith('approve_plan_')) {
    const sessionId = customId.replace('approve_plan_', '');
    const session = sessionManager.getById(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ Sessão não encontrada.', ephemeral: true });
      return;
    }
    if (!ALLOW_SHARED_SESSIONS && session.userId !== interaction.user.id) {
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode revisar o plano.', ephemeral: true });
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
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode revisar o plano.', ephemeral: true });
    }
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
      return interaction.reply({ content: '🚫 Apenas o criador da sessão pode revisar o plano.', ephemeral: true });
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
