// src/stream-handler.js
// Captura o output do OpenCode e atualiza mensagens Discord em tempo real

import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { debug } from './utils.js';
import { STREAM_UPDATE_INTERVAL as UPDATE_INTERVAL, DISCORD_MSG_LIMIT as MSG_LIMIT, ENABLE_DM_NOTIFICATIONS, STATUS_QUEUE_ITEM_TIMEOUT_MS, THREAD_ARCHIVE_DELAY_MS, PERMISSION_TIMEOUT_MS } from './config.js';

/** Limite para enviar diff inline vs como arquivo anexo */
const DIFF_INLINE_LIMIT = 1500;

/**
 * Gerencia o envio de output de uma sessão para uma thread Discord.
 * Usa edição de mensagem + criação de novas mensagens para simular streaming.
 */
export class StreamHandler {
  /**
   * @param {import('discord.js').ThreadChannel} thread - Thread Discord alvo
   * @param {import('./session-manager.js').OpenCodeSession} session - Sessão associada
   */
  constructor(thread, session) {
    this.thread = thread;
    this.session = session;
    this.currentMessage = null;
    this.currentRawContent = '';
    this.currentMessageLength = 0;
    this.currentContent = '';
    this.updateTimer = null;
    this.isProcessing = false;
    this.messageQueue = [];
    // Fila de eventos de status para evitar chamadas concorrentes à API Discord
    this._statusQueue = [];
    this._processingStatus = false;
    // Timer de arquivamento da thread após fechar sessão
    this._archiveTimer = null;
    // Flag para saber se já houve output (evita "Processando" redundante)
    this.hasOutput = false;
    // Estado da permissão interativa pendente (null = nenhuma aguardando)
    this._pendingPermission = null;
    this.sentMessages = []; // mensagens anteriores para correção de tabelas no final
    this._pendingTableLines = ''; // linhas de tabela retidas entre flushes
  }

  /**
   * Inicia o loop de atualização de mensagens
   */
  start() {
    // Ouve output da sessão
    this.session.on('output', (chunk) => {
      this.hasOutput = true;
      this.currentContent += chunk;
      this.scheduleUpdate();
    });

    // Quando a sessão muda de status — usa fila para evitar burst de rate limit
    this.session.on('status', (status) => {
      this._statusQueue.push(async () => {
        await this.flush();
        // Reseta hasOutput ao retomar execução para que "Processando..." apareça novamente
        if (status === 'running') {
          this.hasOutput = false;
        }
        await this.sendStatusMessage(status);
        // Notificação DM quando sessão termina processamento (agente idle/finalizado)
        if (ENABLE_DM_NOTIFICATIONS && (status === 'finished' || status === 'error')) {
          await this._sendDMNotification(status);
        }
      });
      this._drainStatusQueue();
    });

    // Quando o processo fecha — flush final, para o handler e arquiva a thread
    this.session.on('close', async () => {
      await this.flush();
      this.stop();
      // Arquiva a thread após THREAD_ARCHIVE_DELAY_MS para dar tempo de ler a mensagem final
      this._archiveTimer = setTimeout(async () => {
        this._archiveTimer = null;
        try {
          await this.thread.setArchived(true);
        } catch (err) {
          console.error('[StreamHandler] Erro ao arquivar thread:', err.message);
        }
      }, THREAD_ARCHIVE_DELAY_MS);
    });

    // Quando o servidor reinicia — envia aviso e reseta o bloco atual
    this.session.on('server-restart', () => {
      this.sendStatusMessage('restart');
    });

    // Quando a sessão expira por timeout
    this.session.on('timeout', () => {
      this.thread.send('⏰ **Sessão encerrada por inatividade.**').catch((err) =>
        console.error('[StreamHandler] Erro ao enviar mensagem de timeout:', err.message)
      );
    });

    // Garante que erros emitidos pela sessão sejam tratados (Node exige ao menos um listener)
    this.session.on('error', (err) => {
      console.error('[StreamHandler] ❌ Erro na sessão:', err.message);
      // status 'error' já tratado via listener 'status'
    });

    // Gerencia pedidos de permissão interativos com botões Aprovar/Recusar
    this.session.on('permission', (event) => {
      this._handlePermissionEvent(event).catch((err) =>
        console.error('[StreamHandler] Erro ao processar evento de permissão:', err.message)
      );
    });

    // Preview de diffs — exibe alterações de arquivos na thread
    this.session.on('diff', ({ path: filePath, content }) => {
      this._sendDiffPreview(filePath, content);
    });

    // Exibe perguntas do agente na thread para o usuário responder
    this.session.on('question', ({ questions }) => {
      if (!questions.length) return;

      const lines = questions.map(({ question }) => `> ${question}`).join('\n');
      const msg = `❓ **O agente tem uma pergunta para você:**\n${lines}`;

      this.thread.send(msg).catch((err) =>
        console.error('[StreamHandler] Erro ao enviar pergunta do agente:', err.message)
      );
    });
  }

  /**
   * Envia um preview de diff formatado na thread.
   * Diffs pequenos são enviados inline com syntax highlighting.
   * Diffs grandes são enviados como arquivo .diff anexo.
   * @param {string} filePath - Caminho do arquivo alterado
   * @param {string} content - Conteúdo do diff (unified format)
   */
  async _sendDiffPreview(filePath, content) {
    try {
      const ext = filePath.split('.').pop() || '';
      const fileName = filePath.split(/[\\/]/).pop();

      if (content.length <= DIFF_INLINE_LIMIT) {
        // Inline: bloco de código com syntax highlighting baseado na extensão
        const lang = getDiffLanguage(ext);
        const formatted = `📝 **${fileName}**\n\`\`\`${lang}\n${content}\n\`\`\``;

        if (formatted.length <= MSG_LIMIT) {
          await this.thread.send(formatted);
        } else {
          // Cabe inline mas excede limite de mensagem — envia como arquivo
          await this._sendDiffAsFile(fileName, content);
        }
      } else {
        // Diff grande — envia como arquivo anexo
        await this._sendDiffAsFile(fileName, content);
      }
    } catch (err) {
      debug('StreamHandler', '⚠️ Erro ao enviar diff preview: %s', err.message);
    }
  }

  /**
   * Envia o diff como arquivo .diff anexo.
   * @param {string} fileName - Nome do arquivo original
   * @param {string} content - Conteúdo do diff
   */
  async _sendDiffAsFile(fileName, content) {
    const buffer = Buffer.from(content, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, {
      name: `${fileName}.diff`,
      description: `Diff de ${fileName}`,
    });

    await this.thread.send({
      content: `📝 **${fileName}** — diff (${Math.round(buffer.length / 1024)} KB)`,
      files: [attachment],
    });
  }

  /**
   * Drena a fila de eventos de status sequencialmente para evitar race conditions
   */
  async _drainStatusQueue() {
    if (this._processingStatus) return;
    this._processingStatus = true;
    try {
      while (this._statusQueue.length > 0) {
        const fn = this._statusQueue.shift();
        debug('StreamHandler', `⚙️  drenando fila de status | ${this._statusQueue.length + 1} item(s) restante(s)`);
        try {
          await Promise.race([
            fn(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Status queue item timeout')),
                STATUS_QUEUE_ITEM_TIMEOUT_MS
              )
            ),
          ]);
        } catch (err) {
          console.error('[StreamHandler] ⚠️ Erro ao processar item da fila de status:', err.message);
        }
      }
    } finally {
      this._processingStatus = false;
    }
  }

  /**
   * Agenda um update de mensagem (debounced para evitar rate limit)
   */
  scheduleUpdate() {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = null;
      await this.flush();
    }, UPDATE_INTERVAL);
  }

  /**
   * Envia/atualiza mensagens com o conteúdo acumulado.
   * Processa apenas linhas completas para não quebrar a detecção de tabelas
   * cujas linhas chegam fragmentadas entre intervalos de flush.
   */
  async flush() {
    if (!this.currentContent.trim()) return;

    // Processa apenas linhas completas para não quebrar detecção de tabelas
    const lastNewline = this.currentContent.lastIndexOf('\n');
    if (lastNewline === -1) return; // sem linha completa ainda

    const toProcess = this.currentContent.slice(0, lastNewline + 1);
    this.currentContent = this.currentContent.slice(lastNewline + 1);

    // Combina linhas de tabela pendentes do flush anterior com o conteúdo atual
    const combined = this._pendingTableLines
      ? this._pendingTableLines + '\n' + toProcess
      : toProcess;
    this._pendingTableLines = '';

    const { content, pending } = convertMarkdownTables(combined);
    this._pendingTableLines = pending;

    // Se nada restou para enviar (tabela ainda incompleta), aguarda próximo flush
    if (!content.trim()) return;

    // Divide em chunks respeitando o limite Discord
    const chunks = splitIntoChunks(content, MSG_LIMIT);
    debug('StreamHandler', `🚿 flush iniciado | conteúdo=${content.length} chars | chunks a enviar=${chunks.length}`);

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;

      try {
        // Se a mensagem atual ainda tem espaço, edita ela
        if (
          this.currentMessage &&
          this.session &&
          (this.session.status === 'running' || this.session.status === 'waiting_input') &&
          this.currentMessageLength + chunk.length < MSG_LIMIT
        ) {
          const newContent = mergeContent(this.currentRawContent, chunk);

          if (newContent.length <= MSG_LIMIT) {
            debug('StreamHandler', `✏️  editando mensagem existente (${newContent.length} chars)`);
            await this.currentMessage.edit(newContent);
            this.currentRawContent = newContent;
            this.currentMessageLength = newContent.length;
            continue;
          }
        }

        // Caso contrário, cria nova mensagem
        debug('StreamHandler', `📨 criando nova mensagem (${chunk.length} chars)`);
        // Salva mensagem anterior para correção final de tabelas
        if (this.currentMessage) {
          this.sentMessages.push({
            message: this.currentMessage,
            content: this.currentRawContent,
          });
        }
        this.currentMessage = await this.thread.send(chunk);
        this.currentRawContent = chunk;
        this.currentMessageLength = chunk.length;
      } catch (err) {
        debug('StreamHandler', `❌ erro ao enviar: ${err.message}`);
        console.error('[StreamHandler] Erro ao enviar mensagem:', err.message);
      }
    }
  }

  /**
   * Envia mensagem de status visual
   * @param {string} status - Status atual da sessão
   */
  async sendStatusMessage(status) {
    debug('StreamHandler', `📊 sendStatusMessage | status=${status} | hasOutput=${this.hasOutput}`);
    const icons = {
      running:       '⚙️ **Processando...**',
      finished:      '✅ **Sessão concluída**',
      error:         '❌ **Sessão encerrada com erro**',
      restart:       '⚠️ Servidor reiniciando...',
      idle:          '💤 **Idle**',
      waiting_input: '💬 **Aguardando sua resposta...**',
    };

    const msg = icons[status];
    if (!msg) return;

    try {
      // Envia "Processando" apenas no início, antes de qualquer output
      if (status === 'running' && !this.hasOutput) {
        await this.thread.send(msg);
        return;
      }

      // Sinaliza ao usuário que o agente está aguardando resposta
      if (status === 'waiting_input') {
        await this.thread.send(msg);
        return;
      }

        // Para estados finais, envia status visual e reseta o bloco atual
        if (status === 'finished' || status === 'error' || status === 'restart') {
          // Converte e envia quaisquer linhas de tabela retidas ao final do stream
          const finalInput = this._pendingTableLines + (this.currentContent || '');
          this._pendingTableLines = '';
          this.currentContent = '';
          if (finalInput.trim()) {
            const { content: finalConverted } = convertMarkdownTables(finalInput, true);
            if (finalConverted.trim()) {
              const finalChunks = splitIntoChunks(finalConverted, MSG_LIMIT);
              for (const chunk of finalChunks) {
                const merged = mergeContent(this.currentRawContent, chunk);
                if (merged.length <= MSG_LIMIT && this.currentMessage) {
                  await this.currentMessage.edit(merged);
                  this.currentRawContent = merged;
                  this.currentMessageLength = merged.length;
                } else {
                  if (this.currentMessage) {
                    this.sentMessages.push({ message: this.currentMessage, content: this.currentRawContent });
                  }
                  this.currentMessage = await this.thread.send(chunk);
                  this.currentRawContent = chunk;
                  this.currentMessageLength = chunk.length;
                }
              }
            }
          }

          // Corrige tabelas em mensagens anteriores (overflow)
          for (const entry of this.sentMessages) {
            const { content: fixed } = convertMarkdownTables(entry.content, true);
            if (fixed !== entry.content) {
              try {
                debug('StreamHandler', '🔧 corrigindo tabelas em mensagem anterior');
                await entry.message.edit(fixed);
                entry.content = fixed;
              } catch (editErr) {
                debug('StreamHandler', `⚠️ falha ao corrigir tabela em msg anterior: ${editErr.message}`);
              }
            }
          }
          // Corrige tabelas que foram fragmentadas durante o streaming
          if (this.currentMessage && this.currentRawContent) {
          const { content: fixed } = convertMarkdownTables(this.currentRawContent, true);
          if (fixed !== this.currentRawContent) {
            try {
              debug('StreamHandler', '🔧 corrigindo tabelas no conteúdo final');
              await this.currentMessage.edit(fixed);
              this.currentRawContent = fixed;
              this.currentMessageLength = fixed.length;
            } catch (editErr) {
              // ignora falha de edição final
              debug('StreamHandler', `⚠️ falha ao corrigir tabelas: ${editErr.message}`);
            }
          }
        }
        await this.thread.send(msg);
        // Reseta current message para próximo bloco começar fresco
        this.currentMessage = null;
        this.currentRawContent = '';
        this.currentMessageLength = 0;
        this.hasOutput = false;
      }
    } catch (err) {
      console.error('[StreamHandler] Erro ao enviar status:', err.message);
    }
  }

  /**
   * Envia notificação por DM ao criador da sessão.
   * @param {string} status
   */
  async _sendDMNotification(status) {
    try {
      const guild = this.thread.guild;
      const member = await guild.members.fetch(this.session.userId);
      const icon = status === 'finished' ? '✅' : '❌';
      const lastOutput = this.session.outputBuffer.slice(-200).trim();
      const preview = lastOutput ? `\n\`\`\`\n${lastOutput}\n\`\`\`` : '';
      await member.send(
        `${icon} **Sessão ${status === 'finished' ? 'concluída' : 'com erro'}** — ${this.session.agent} em \`${this.session.projectPath.split(/[\\/]/).pop()}\`\n👉 <#${this.thread.id}>${preview}`
      );
    } catch (err) {
      debug('StreamHandler', '⚠️ Não foi possível enviar DM: %s', err.message);
    }
  }

  /**
   * Para o handler e limpa timers
   */
  stop() {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this._archiveTimer) {
      clearTimeout(this._archiveTimer);
      this._archiveTimer = null;
    }
    this._clearPendingPermission();
  }

  /**
   * Gerencia eventos de permissão: exibe botões Aprovar/Recusar ou aviso inline.
   * Para `status === 'requested'`, envia mensagem com botões e inicia timer de 60s.
   * Para `status === 'unknown'`, envia aviso simples sem botões.
   * @param {{ status: string, permissionId?: string, toolName?: string, description?: string, error?: string }} event
   */
  async _handlePermissionEvent({ status, permissionId, toolName, description, error }) {
    if (status === 'requested') {
      // Cancela permissão pendente anterior se existir (pode ocorrer em rajadas)
      this._clearPendingPermission();

      const toolLabel = toolName ?? 'ferramenta';
      const descLine = description ? `\n> ${description}` : '';
      const content =
        `🔐 **Permissão solicitada** para \`${toolLabel}\`${descLine}\n\n` +
        `Aprove ou recuse em até **60 segundos**. Sem resposta, será aprovada automaticamente.`;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_permission_${this.session.sessionId}`)
          .setLabel('Aprovar')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`deny_permission_${this.session.sessionId}`)
          .setLabel('Recusar')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌'),
      );

      let permMsg;
      try {
        permMsg = await this.thread.send({ content, components: [row] });
      } catch (sendErr) {
        console.error('[StreamHandler] Erro ao enviar mensagem de permissão:', sendErr.message);
        return;
      }

      // Auto-aprova após PERMISSION_TIMEOUT_MS se o usuário não interagir
      const timeout = setTimeout(async () => {
        if (!this._pendingPermission) return; // Usuário já interagiu

        const pending = this._pendingPermission;
        this._pendingPermission = null;

        // Verifica novamente se o usuário interagiu (race condition)
        if (!this.session._pendingPermissionId) {
          debug('StreamHandler', '⏰ Timeout de permissão disparado, mas usuário já interagiu');
          return;
        }

        this.session._pendingPermissionId = null;

        // Desabilita botões antes de aprovar
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`approve_permission_${this.session.sessionId}`)
            .setLabel('Aprovar')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`deny_permission_${this.session.sessionId}`)
            .setLabel('Recusar')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
            .setDisabled(true),
        );

        try {
          await pending.message.edit({
            content: `${content}\n\n⏰ *Aprovado automaticamente por timeout.*`,
            components: [disabledRow],
          });
        } catch (editErr) {
          debug('StreamHandler', '⚠️ Erro ao editar mensagem de permissão no timeout: %s', editErr.message);
        }

        if (!this.session.server?.client) return;
        try {
          await this.session.server.client.approvePermission(this.session.apiSessionId, pending.permissionId);
          debug('StreamHandler', '⏰ Permissão auto-aprovada após timeout: %s', pending.permissionId);
        } catch (approveErr) {
          console.error('[StreamHandler] ❌ Erro ao auto-aprovar permissão no timeout:', approveErr.message);
        }
      }, PERMISSION_TIMEOUT_MS);

      this._pendingPermission = { permissionId, message: permMsg, timeout };
    } else if (status === 'unknown') {
      this.thread
        .send(`⚠️ **Permissão solicitada** (não foi possível identificar a ferramenta)${error ? `: ${error}` : ''}`)
        .catch((sendErr) =>
          console.error('[StreamHandler] Erro ao enviar aviso de permissão:', sendErr.message)
        );
    }
    // Outros status ('approving', 'approved', 'failed') não são emitidos no novo fluxo interativo
  }

  /**
   * Cancela a permissão pendente atual, limpando o timer e o estado.
   */
  _clearPendingPermission() {
    if (!this._pendingPermission) return;
    clearTimeout(this._pendingPermission.timeout);
    this._pendingPermission = null;
  }
}

// ─── Utilitários de formatação ────────────────────────────────────────────────

/**
 * Remove formatação Markdown inline (bold, italic, code) para cálculo de largura de coluna.
 * @param {string} text
 * @returns {string}
 */
function stripInlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
}

/**
 * Retorna true se a linha parece ser uma linha de tabela Markdown (começa e termina com |).
 * @param {string} line
 * @returns {boolean}
 */
function isTableRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

/**
 * Retorna true se a linha é a linha separadora de tabela Markdown (ex: |---|---|).
 * @param {string} line
 * @returns {boolean}
 */
function isSeparatorRow(line) {
  const t = line.trim();
  return /^\|[\s\-:|]+\|$/.test(t) && /^[\|:\-\s]+$/.test(t);
}

/**
 * Formata um array de linhas de tabela Markdown como bloco de código monospace alinhado.
 * A primeira linha é tratada como cabeçalho; o restante como dados.
 * @param {string[]} rows - Linhas da tabela (sem a linha separadora)
 * @returns {string}
 */
function formatTableAsCode(rows) {
  // Parse cells de cada linha
  const parsed = rows.map((row) =>
    row
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
  );

  // Normaliza número de colunas
  const colCount = Math.max(...parsed.map((r) => r.length));
  const normalized = parsed.map((row) => {
    while (row.length < colCount) row.push('');
    return row;
  });

  // Calcula largura máxima de cada coluna (sem formatação Markdown)
  const widths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(...normalized.map((row) => stripInlineMarkdown(row[ci]).length))
  );

  // Linha separadora com caracteres Unicode box-drawing
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');

  // Formata cada linha: strip inline markdown para alinhamento correto
  const formatted = normalized.map((row) =>
    row.map((cell, ci) => stripInlineMarkdown(cell).padEnd(widths[ci])).join('  ')
  );

  // Cabeçalho + separador + dados
  return `\`\`\`\n${formatted[0]}\n${sep}\n${formatted.slice(1).join('\n')}\n\`\`\``;
}

/**
 * Detecta tabelas Markdown no texto e as converte para blocos de código monospace alinhados.
 * Discord não renderiza tabelas GFM — este passo garante legibilidade.
 *
 * Retorna `{ content, pending }` onde `pending` contém linhas de tabela ainda incompletas
 * (caso a tabela esteja no fim do chunk e `isLastChunk` seja false), para serem
 * pré-pendidas ao próximo flush.
 *
 * @param {string} text
 * @param {boolean} [isLastChunk=false] - Se true, força conversão mesmo de tabelas no fim do chunk
 * @returns {{ content: string, pending: string }}
 */
function convertMarkdownTables(text, isLastChunk = false) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // Detecta início de tabela: linha de dados + linha separadora
    if (isTableRow(lines[i]) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headerLine = lines[i];
      const sepLine = lines[i + 1];
      let j = i + 2;

      // Coleta linhas de dados
      while (j < lines.length && isTableRow(lines[j])) {
        j++;
      }

      const dataRows = lines.slice(i + 2, j);

      // Verifica se há conteúdo não-tabela após as linhas coletadas
      const hasContentAfter = lines.slice(j).some((l) => l.trim() !== '');
      const tableIsComplete = hasContentAfter || isLastChunk;

      if (!tableIsComplete) {
        // Tabela ainda pode estar crescendo — retorna tudo a partir daqui como pendente
        const pendingLines = lines.slice(i).join('\n');
        return { content: result.join('\n'), pending: pendingLines };
      }

      if (dataRows.length === 0) {
        // Tabela sem dados (header apenas) — mantém como texto raw
        result.push(headerLine);
        result.push(sepLine);
        i += 2;
      } else {
        // Tabela completa — converte para bloco de código
        result.push(formatTableAsCode([headerLine, ...dataRows]));
        i = j;
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return { content: result.join('\n'), pending: '' };
}

/**
 * Divide texto longo em pedaços respeitando o limite do Discord
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
function splitIntoChunks(text, limit) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Tenta quebrar em nova linha
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Mescla conteúdo anterior com novo conteúdo
 * @param {string} existing
 * @param {string} newChunk
 * @returns {string}
 */
function mergeContent(existing, newChunk) {
  if (!existing) return newChunk;
  return existing + '\n' + newChunk;
}

/**
 * Mapeia extensão de arquivo para linguagem de syntax highlighting do Discord.
 * Para diffs unified, usa 'diff'. Para outros, tenta mapear a extensão.
 * @param {string} ext - Extensão do arquivo (sem ponto)
 * @returns {string}
 */
function getDiffLanguage(ext) {
  const langMap = {
    js: 'diff', ts: 'diff', jsx: 'diff', tsx: 'diff',
    py: 'diff', rb: 'diff', go: 'diff', rs: 'diff',
    java: 'diff', c: 'diff', cpp: 'diff', h: 'diff',
    css: 'diff', html: 'diff', json: 'diff', yaml: 'diff', yml: 'diff',
    md: 'diff', sql: 'diff', sh: 'diff', bash: 'diff',
  };
  return langMap[ext] ?? 'diff';
}

// ─── Exports internos para testes ────────────────────────────────────────────

/**
 * Funções internas expostas exclusivamente para cobertura de testes.
 * Não fazem parte da API pública do módulo.
 */
export const _internal = { splitIntoChunks, mergeContent, convertMarkdownTables };
