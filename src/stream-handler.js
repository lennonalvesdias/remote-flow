// src/stream-handler.js
// Captura o output do OpenCode e atualiza mensagens Discord em tempo real

import { AttachmentBuilder } from 'discord.js';
import { debug } from './utils.js';
import { STREAM_UPDATE_INTERVAL as UPDATE_INTERVAL, DISCORD_MSG_LIMIT as MSG_LIMIT, ENABLE_DM_NOTIFICATIONS } from './config.js';

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
    // Flag para saber se já houve output (evita "Processando" redundante)
    this.hasOutput = false;
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
      // Arquiva a thread após 5 segundos para dar tempo de ler a mensagem final
      setTimeout(async () => {
        try {
          await this.thread.setArchived(true);
        } catch (err) {
          console.error('[StreamHandler] Erro ao arquivar thread:', err.message);
        }
      }, 5000);
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

    // Notifica a thread quando uma permissão é solicitada ou aprovada
    this.session.on('permission', ({ status, toolName, description, error }) => {
      let msg;
      if (status === 'approving') {
        msg = `🔐 **Permissão solicitada** para \`${toolName}\`${description ? ` — ${description}` : ''}\nAprovando automaticamente...`;
      } else if (status === 'approved') {
        msg = `✅ **Permissão aprovada** para \`${toolName}\``;
      } else if (status === 'failed') {
        msg = `❌ **Falha ao aprovar permissão** para \`${toolName}\`: ${error}`;
      } else {
        // status === 'unknown'
        msg = `⚠️ **Permissão solicitada** (não foi possível identificar a ferramenta)${error ? `: ${error}` : ''}`;
      }

      this.thread.send(msg).catch((err) =>
        console.error('[StreamHandler] Erro ao enviar mensagem de permissão:', err.message)
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
          await fn();
        } catch (err) {
          console.error('[StreamHandler] Erro ao processar status:', err.message);
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
   * Envia/atualiza mensagens com o conteúdo acumulado
   */
  async flush() {
    if (!this.currentContent.trim()) return;

    const content = this.currentContent;
    this.currentContent = '';

    // Divide em chunks respeitando o limite Discord
    const chunks = splitIntoChunks(content, MSG_LIMIT);
    debug('StreamHandler', `🚿 flush iniciado | conteúdo=${content.length} chars | chunks a enviar=${chunks.length}`);

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;

      try {
        // Se a mensagem atual ainda tem espaço, edita ela
        if (
          this.currentMessage &&
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
  }
}

// ─── Utilitários de formatação ────────────────────────────────────────────────

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
