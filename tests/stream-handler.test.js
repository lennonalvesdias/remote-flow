import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamHandler, _internal } from '../src/stream-handler.js';

// ─── Mock de discord.js para que AttachmentBuilder/ButtonBuilder sejam interceptados ─
vi.mock('discord.js', () => {
  // Deve ser function regular (não arrow) para suportar "new"
  const AttachmentBuilder = function (buffer, options) {
    this.buffer = buffer;
    this.name = options?.name;
    this.description = options?.description;
  };

  const ButtonBuilder = function () {
    this.setCustomId = vi.fn().mockReturnThis();
    this.setLabel = vi.fn().mockReturnThis();
    this.setStyle = vi.fn().mockReturnThis();
    this.setEmoji = vi.fn().mockReturnThis();
    this.setDisabled = vi.fn().mockReturnThis();
  };

  const ActionRowBuilder = function () {
    this.addComponents = vi.fn().mockReturnThis();
  };

  const ButtonStyle = { Success: 3, Danger: 4, Secondary: 2 };

  return { AttachmentBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle };
});

// ─── Helper para drenar a fila de microtasks pendentes ────────────────────────

async function flushPromises(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ─── Helpers de mock para StreamHandler ──────────────────────────────────────

function createMockThread() {
  const mockMessage = {
    id: 'msg-1',
    content: '',
    edit: vi.fn().mockResolvedValue({}),
  };
  return {
    send: vi.fn().mockResolvedValue(mockMessage),
    setArchived: vi.fn().mockResolvedValue({}),
    id: 'thread-123',
    guild: { id: 'guild-123' },
  };
}

function createMockSession() {
  const emitter = new EventEmitter();
  emitter.status = 'idle';
  emitter.userId = 'user-123';
  emitter.sessionId = 'sess-123';
  emitter.projectPath = '/projetos/meu-projeto';
  emitter.agent = 'build';
  emitter.outputBuffer = '';
  emitter.getQueueSize = vi.fn().mockReturnValue(0);
  return emitter;
}

// ─── Testes de splitIntoChunks ────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  it('retorna texto curto como chunk único', () => {
    const result = _internal.splitIntoChunks('Hello', 1900);
    expect(result).toEqual(['Hello']);
  });

  it('divide texto longo respeitando o limite', () => {
    const line = 'a'.repeat(100) + '\n';
    const text = line.repeat(25); // 2525 chars
    const chunks = _internal.splitIntoChunks(text, 1900);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(1900));
  });

  it('quebra na última newline antes do limite', () => {
    const text = 'linha1\nlinha2\nlinha3';
    const chunks = _internal.splitIntoChunks(text, 13);
    expect(chunks[0]).toBe('linha1\nlinha2');
  });

  it('força quebra no limite quando não há newline', () => {
    const text = 'a'.repeat(3000);
    const chunks = _internal.splitIntoChunks(text, 1900);
    expect(chunks[0].length).toBe(1900);
  });

  it('lida com string vazia', () => {
    expect(_internal.splitIntoChunks('', 1900)).toEqual([]);
  });
});

// ─── Testes de mergeContent ───────────────────────────────────────────────────

describe('mergeContent', () => {
  it('retorna novo chunk quando existing é vazio', () => {
    expect(_internal.mergeContent('', 'novo')).toBe('novo');
  });

  it('concatena com newline', () => {
    expect(_internal.mergeContent('existente', 'novo')).toBe('existente\nnovo');
  });
});

// ─── Testes de StreamHandler ──────────────────────────────────────────────────

describe('StreamHandler', () => {
  let thread, session, handler;

  beforeEach(() => {
    vi.useFakeTimers();
    thread = createMockThread();
    session = createMockSession();
    handler = new StreamHandler(thread, session);
  });

  afterEach(() => {
    // Garante limpeza de timers pendentes antes de restaurar
    handler.stop();
    vi.useRealTimers();
  });

  // ─── start() — registro de listeners ───────────────────────────────────────

  describe('start() — registro de listeners', () => {
    it('não lança erro ao registrar listeners na sessão', () => {
      expect(() => handler.start()).not.toThrow();
    });

    it('ao emitir output, currentContent acumula o texto recebido', () => {
      handler.start();
      session.emit('output', 'linha de saída do agente');
      expect(handler.currentContent).toBe('linha de saída do agente');
    });

    it('ao emitir output em sequência, currentContent concatena todos os chunks', () => {
      handler.start();
      session.emit('output', 'parte 1');
      session.emit('output', ' parte 2');
      expect(handler.currentContent).toBe('parte 1 parte 2');
    });

    it('ao emitir output, hasOutput torna-se true', () => {
      handler.start();
      expect(handler.hasOutput).toBe(false);
      session.emit('output', 'algum texto');
      expect(handler.hasOutput).toBe(true);
    });

    it('ao emitir output, scheduleUpdate agenda o updateTimer', () => {
      handler.start();
      // Sem output o timer não existe
      expect(handler.updateTimer).toBeNull();
      session.emit('output', 'texto qualquer');
      // Após output, timer deve estar agendado
      expect(handler.updateTimer).not.toBeNull();
    });

    it('ao emitir timeout na sessão, thread.send recebe mensagem de inatividade', () => {
      handler.start();
      session.emit('timeout');
      expect(thread.send).toHaveBeenCalledWith('⏰ **Sessão encerrada por inatividade.**');
    });
  });

  // ─── stop() ────────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('stop() sem timers ativos não lança erro', () => {
      expect(() => handler.stop()).not.toThrow();
    });

    it('stop() após emissão de output zera updateTimer', () => {
      handler.start();
      session.emit('output', 'texto'); // dispara scheduleUpdate → define updateTimer
      expect(handler.updateTimer).not.toBeNull();

      handler.stop();

      expect(handler.updateTimer).toBeNull();
    });

    it('stop() chamado duas vezes consecutivas não lança erro', () => {
      handler.start();
      session.emit('output', 'texto');
      handler.stop();
      expect(() => handler.stop()).not.toThrow();
    });
  });

  // ─── sendStatusMessage() ───────────────────────────────────────────────────

  describe('sendStatusMessage()', () => {
    it("'running' chama thread.send quando hasOutput é false", async () => {
      handler.hasOutput = false;
      await handler.sendStatusMessage('running');
      expect(thread.send).toHaveBeenCalledOnce();
      expect(thread.send).toHaveBeenCalledWith('⚙️ **Processando...**');
    });

    it("'running' não chama thread.send quando hasOutput é true", async () => {
      handler.hasOutput = true;
      await handler.sendStatusMessage('running');
      expect(thread.send).not.toHaveBeenCalled();
    });

    it("'waiting_input' sempre chama thread.send independente de hasOutput", async () => {
      handler.hasOutput = true; // mesmo com output prévio, deve enviar
      await handler.sendStatusMessage('waiting_input');
      expect(thread.send).toHaveBeenCalledOnce();
      expect(thread.send).toHaveBeenCalledWith('💬 **Aguardando sua resposta...**');
    });

    it("'finished' chama thread.send com mensagem de conclusão", async () => {
      await handler.sendStatusMessage('finished');
      expect(thread.send).toHaveBeenCalledOnce();
      expect(thread.send).toHaveBeenCalledWith('✅ **Sessão concluída**');
    });

    it("'finished' reseta currentMessage, currentRawContent e currentMessageLength", async () => {
      handler.currentMessage = { id: 'msg-existente', edit: vi.fn() };
      handler.currentRawContent = 'conteúdo anterior';
      handler.currentMessageLength = 42;
      await handler.sendStatusMessage('finished');
      expect(handler.currentMessage).toBeNull();
      expect(handler.currentRawContent).toBe('');
      expect(handler.currentMessageLength).toBe(0);
    });

    it("'error' chama thread.send com mensagem de erro", async () => {
      await handler.sendStatusMessage('error');
      expect(thread.send).toHaveBeenCalledOnce();
      expect(thread.send).toHaveBeenCalledWith('❌ **Sessão encerrada com erro**');
    });

    it("'restart' chama thread.send com aviso de reinicialização do servidor", async () => {
      await handler.sendStatusMessage('restart');
      expect(thread.send).toHaveBeenCalledWith('⚠️ Servidor reiniciando...');
    });

    it('status desconhecido não chama thread.send', async () => {
      await handler.sendStatusMessage('status_que_nao_existe');
      expect(thread.send).not.toHaveBeenCalled();
    });
  });

  // ─── flush() ───────────────────────────────────────────────────────────────

  describe('flush()', () => {
    it('não chama thread.send quando currentContent está vazio', async () => {
      handler.currentContent = '';
      await handler.flush();
      expect(thread.send).not.toHaveBeenCalled();
    });

    it('não chama thread.send quando currentContent tem apenas espaços em branco', async () => {
      handler.currentContent = '   \n   ';
      await handler.flush();
      expect(thread.send).not.toHaveBeenCalled();
    });

    it('chama thread.send quando há conteúdo não-vazio', async () => {
      handler.currentContent = 'resultado do agente\n';
      await handler.flush();
      expect(thread.send).toHaveBeenCalledOnce();
    });

    it('limpa currentContent após enviar', async () => {
      handler.currentContent = 'algum texto\n';
      await handler.flush();
      expect(handler.currentContent).toBe('');
    });

    it('edita mensagem existente (em vez de criar nova) quando status é running e há espaço', async () => {
      const mockMsg = { id: 'msg-1', content: 'inicial', edit: vi.fn().mockResolvedValue({}) };
      handler.currentMessage = mockMsg;
      handler.currentRawContent = 'inicial';
      handler.currentMessageLength = 7;
      session.status = 'running';
      handler.currentContent = ' continuação do texto\n';
      await handler.flush();
      expect(mockMsg.edit).toHaveBeenCalledOnce();
      expect(thread.send).not.toHaveBeenCalled();
    });
  });

  // ─── scheduleUpdate() ──────────────────────────────────────────────────────

  describe('scheduleUpdate()', () => {
    it('cria um timer que executa flush após UPDATE_INTERVAL', async () => {
      handler.currentContent = 'texto para flush\n';
      handler.scheduleUpdate();

      expect(thread.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);

      expect(thread.send).toHaveBeenCalled();
    });

    it('não cria novo timer se já existe um pendente', () => {
      handler.scheduleUpdate();
      const firstTimer = handler.updateTimer;
      handler.scheduleUpdate();
      expect(handler.updateTimer).toBe(firstTimer);
    });

    it('zera updateTimer após disparo', async () => {
      handler.currentContent = 'texto';
      handler.scheduleUpdate();

      await vi.advanceTimersByTimeAsync(1500);

      expect(handler.updateTimer).toBeNull();
    });
  });

  // ─── evento 'close' da sessão ──────────────────────────────────────────────

  describe("evento 'close' da sessão", () => {
    it('chama flush e stop quando a sessão fecha', async () => {
      handler.start();
      const flushSpy = vi.spyOn(handler, 'flush').mockResolvedValue();
      const stopSpy = vi.spyOn(handler, 'stop');

      session.emit('close');

      await flushPromises();

      expect(flushSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });

    it('agenda arquivamento da thread após THREAD_ARCHIVE_DELAY_MS', async () => {
      handler.start();
      vi.spyOn(handler, 'flush').mockResolvedValue();

      session.emit('close');

      await flushPromises();

      // Timer ainda não disparou
      expect(thread.setArchived).not.toHaveBeenCalled();

      // Avança além do delay padrão de 5000ms
      await vi.advanceTimersByTimeAsync(5001);

      expect(thread.setArchived).toHaveBeenCalledWith(true);
    });

    it('trata silenciosamente erro ao arquivar a thread', async () => {
      thread.setArchived = vi.fn().mockRejectedValue(new Error('Acesso negado'));
      handler.start();
      vi.spyOn(handler, 'flush').mockResolvedValue();

      session.emit('close');
      await flushPromises();

      // Não deve lançar exceção ao avançar o timer
      await expect(vi.advanceTimersByTimeAsync(5001)).resolves.not.toThrow();
    });

    it('zera _archiveTimer após disparo', async () => {
      handler.start();
      vi.spyOn(handler, 'flush').mockResolvedValue();

      session.emit('close');
      await flushPromises();

      await vi.advanceTimersByTimeAsync(5001);

      expect(handler._archiveTimer).toBeNull();
    });
  });

  // ─── evento 'permission' da sessão ────────────────────────────────────────

  describe("evento 'permission' da sessão", () => {
    it("status 'requested' envia mensagem com objeto { content, components }", async () => {
      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'bash',
        description: 'Executar comando shell',
        permissionId: 'perm-1',
      });
      await flushPromises();
      expect(thread.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('bash'),
          components: expect.arrayContaining([expect.any(Object)]),
        })
      );
    });

    it("status 'requested' com description inclui a descrição no conteúdo", async () => {
      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'write_file',
        description: 'Escrever arquivo de configuração',
        permissionId: 'perm-2',
      });
      await flushPromises();
      expect(thread.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Escrever arquivo de configuração'),
        })
      );
    });

    it("status 'requested' sem description não inclui linha de descrição com '>'", async () => {
      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'bash',
        description: '',
        permissionId: 'perm-3',
      });
      await flushPromises();
      expect(thread.send).toHaveBeenCalled();
      const callArg = thread.send.mock.calls[0][0];
      expect(typeof callArg).toBe('object');
      expect(callArg.content).not.toContain('\n>');
    });

    it("status 'requested' define _pendingPermission com permissionId correto", async () => {
      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'bash',
        description: '',
        permissionId: 'perm-42',
      });
      await flushPromises();
      expect(handler._pendingPermission).not.toBeNull();
      expect(handler._pendingPermission.permissionId).toBe('perm-42');
    });

    it('status desconhecido envia aviso genérico sem error', () => {
      handler.start();
      session.emit('permission', {
        status: 'unknown',
        toolName: '',
        description: '',
        error: null,
      });
      expect(thread.send).toHaveBeenCalledWith(
        '⚠️ **Permissão solicitada** (não foi possível identificar a ferramenta)'
      );
    });

    it('status desconhecido com error inclui o erro na mensagem', () => {
      handler.start();
      session.emit('permission', {
        status: 'unknown',
        toolName: '',
        description: '',
        error: 'Ferramenta bloqueada pela política',
      });
      expect(thread.send).toHaveBeenCalledWith(
        '⚠️ **Permissão solicitada** (não foi possível identificar a ferramenta): Ferramenta bloqueada pela política'
      );
    });
  });

  // ─── evento 'diff' da sessão ──────────────────────────────────────────────

  describe("evento 'diff' da sessão", () => {
    it('chama _sendDiffPreview com caminho e conteúdo do arquivo', () => {
      handler.start();
      const spy = vi.spyOn(handler, '_sendDiffPreview').mockResolvedValue();

      session.emit('diff', { path: 'src/app.js', content: '+ nova linha\n- linha removida' });

      expect(spy).toHaveBeenCalledWith('src/app.js', '+ nova linha\n- linha removida');
    });

    it('não lança erro se _sendDiffPreview rejeitar', async () => {
      handler.start();
      vi.spyOn(handler, '_sendDiffPreview').mockRejectedValue(new Error('Falha no diff'));

      // O evento não deve propagar a exceção
      expect(() => session.emit('diff', { path: 'src/app.js', content: 'dados' })).not.toThrow();
    });
  });

  // ─── evento 'question' da sessão ─────────────────────────────────────────

  describe("evento 'question' da sessão", () => {
    it('envia mensagem com todas as perguntas do agente', () => {
      handler.start();
      session.emit('question', {
        questions: [
          { question: 'Qual o nome do projeto?' },
          { question: 'Qual a branch principal?' },
        ],
      });
      expect(thread.send).toHaveBeenCalledWith(
        '❓ **O agente tem uma pergunta para você:**\n> Qual o nome do projeto?\n> Qual a branch principal?'
      );
    });

    it('envia mensagem com pergunta única', () => {
      handler.start();
      session.emit('question', {
        questions: [{ question: 'Deseja continuar?' }],
      });
      expect(thread.send).toHaveBeenCalledWith(
        '❓ **O agente tem uma pergunta para você:**\n> Deseja continuar?'
      );
    });

    it('não envia mensagem quando array de perguntas está vazio', () => {
      handler.start();
      session.emit('question', { questions: [] });
      expect(thread.send).not.toHaveBeenCalled();
    });
  });

  // ─── _sendDiffPreview() ────────────────────────────────────────────────────

  describe('_sendDiffPreview()', () => {
    it('envia diff inline com syntax highlighting quando conteúdo cabe no limite', async () => {
      const content = 'diff --git a/index.js b/index.js\n+console.log("hello")';
      await handler._sendDiffPreview('src/index.js', content);

      expect(thread.send).toHaveBeenCalledOnce();
      const [msg] = thread.send.mock.calls[0];
      expect(typeof msg).toBe('string');
      expect(msg).toContain('index.js');
      expect(msg).toContain('```diff');
      expect(msg).toContain(content);
    });

    it('inclui o nome do arquivo no cabeçalho da mensagem inline', async () => {
      const content = '+adicionado';
      await handler._sendDiffPreview('projeto/utils/helpers.py', content);

      const [msg] = thread.send.mock.calls[0];
      expect(msg).toContain('**helpers.py**');
    });

    it('envia diff como arquivo quando conteúdo excede DIFF_INLINE_LIMIT (1500 chars)', async () => {
      const content = 'a'.repeat(1600); // > 1500
      await handler._sendDiffPreview('src/app.js', content);

      expect(thread.send).toHaveBeenCalledOnce();
      const [arg] = thread.send.mock.calls[0];
      // Deve ser objeto { content, files } em vez de string simples
      expect(arg).toHaveProperty('files');
      expect(arg.files).toHaveLength(1);
    });

    it('captura erro de thread.send silenciosamente sem lançar exceção', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Rate limited pela API'));
      await expect(
        handler._sendDiffPreview('src/app.js', 'conteúdo pequeno')
      ).resolves.not.toThrow();
    });
  });

  // ─── _sendDiffAsFile() ────────────────────────────────────────────────────

  describe('_sendDiffAsFile()', () => {
    it('chama thread.send com objeto { content, files }', async () => {
      await handler._sendDiffAsFile('app.js', 'conteúdo do diff aqui');

      expect(thread.send).toHaveBeenCalledOnce();
      const [arg] = thread.send.mock.calls[0];
      expect(arg).toHaveProperty('content');
      expect(arg).toHaveProperty('files');
    });

    it('a mensagem de conteúdo referencia o nome do arquivo', async () => {
      await handler._sendDiffAsFile('componente.tsx', 'diff data');

      const [arg] = thread.send.mock.calls[0];
      expect(arg.content).toContain('componente.tsx');
    });

    it('o attachment tem extensão .diff no nome', async () => {
      await handler._sendDiffAsFile('script.js', 'diff data');

      const [arg] = thread.send.mock.calls[0];
      const attachment = arg.files[0];
      expect(attachment.name).toBe('script.js.diff');
    });

    it('o attachment contém o conteúdo do diff no buffer', async () => {
      const diffContent = '--- antes\n+++ depois\n+linha nova';
      await handler._sendDiffAsFile('main.py', diffContent);

      const [arg] = thread.send.mock.calls[0];
      const attachment = arg.files[0];
      expect(attachment.buffer.toString('utf-8')).toBe(diffContent);
    });

    it('inclui tamanho em KB na mensagem de conteúdo', async () => {
      const content = 'x'.repeat(2048); // exatamente 2 KB
      await handler._sendDiffAsFile('big.js', content);

      const [arg] = thread.send.mock.calls[0];
      expect(arg.content).toContain('KB');
    });
  });

  // ─── _drainStatusQueue() ──────────────────────────────────────────────────

  describe('_drainStatusQueue()', () => {
    it('processa todos os itens da fila em sequência', async () => {
      const resultados = [];
      handler._statusQueue.push(async () => resultados.push(1));
      handler._statusQueue.push(async () => resultados.push(2));
      handler._statusQueue.push(async () => resultados.push(3));

      await handler._drainStatusQueue();

      expect(resultados).toEqual([1, 2, 3]);
    });

    it('não inicia segundo processamento se _processingStatus já é true', async () => {
      handler._processingStatus = true;
      const spy = vi.fn().mockResolvedValue();
      handler._statusQueue.push(spy);

      await handler._drainStatusQueue();

      expect(spy).not.toHaveBeenCalled();
      // Item permanece na fila pois o processamento foi bloqueado
      expect(handler._statusQueue.length).toBe(1);
    });

    it('reseta _processingStatus para false ao concluir normalmente', async () => {
      handler._statusQueue.push(async () => {});

      await handler._drainStatusQueue();

      expect(handler._processingStatus).toBe(false);
    });

    it('reseta _processingStatus para false mesmo se item lançar erro', async () => {
      handler._statusQueue.push(async () => {
        throw new Error('Erro proposital no item de status');
      });

      await handler._drainStatusQueue();

      expect(handler._processingStatus).toBe(false);
    });

    it('descarta item que ultrapassa STATUS_QUEUE_ITEM_TIMEOUT_MS e continua a fila', async () => {
      const travado = () => new Promise(() => {}); // nunca resolve
      const aposTimeout = vi.fn().mockResolvedValue();

      handler._statusQueue.push(travado);
      handler._statusQueue.push(aposTimeout);

      const drainPromise = handler._drainStatusQueue();

      // Avança além do timeout padrão de 5000ms para disparar a rejeição
      await vi.advanceTimersByTimeAsync(5001);

      await drainPromise;

      expect(handler._processingStatus).toBe(false);
      // O segundo item deve ter sido executado após o timeout do primeiro
      expect(aposTimeout).toHaveBeenCalled();
    });

    it('fila vazia completa sem processar nada', async () => {
      await handler._drainStatusQueue();

      expect(handler._processingStatus).toBe(false);
    });
  });

  // ─── _sendDMNotification ──────────────────────────────────────────────────

  describe('_sendDMNotification()', () => {
    it('envia DM com status finished quando sessão conclui com sucesso', async () => {
      const mockMember = {
        send: vi.fn().mockResolvedValue({}),
      };
      const mockGuild = {
        members: {
          fetch: vi.fn().mockResolvedValue(mockMember),
        },
      };
      thread.guild = mockGuild;
      session.outputBuffer = 'Resultado final da sessão';
      session.agent = 'plan';
      session.projectPath = '/projetos/meuapp';

      handler.start();
      await handler._sendDMNotification('finished');

      expect(mockGuild.members.fetch).toHaveBeenCalledWith('user-123');
      expect(mockMember.send).toHaveBeenCalledOnce();
      const [msg] = mockMember.send.mock.calls[0];
      expect(msg).toContain('✅');
      expect(msg).toContain('concluída');
      expect(msg).toContain('plan');
      expect(msg).toContain('meuapp');
    });

    it('envia DM com status error e ícone de erro', async () => {
      const mockMember = {
        send: vi.fn().mockResolvedValue({}),
      };
      const mockGuild = {
        members: {
          fetch: vi.fn().mockResolvedValue(mockMember),
        },
      };
      thread.guild = mockGuild;
      session.outputBuffer = 'Erro durante processamento';
      session.agent = 'build';

      handler.start();
      await handler._sendDMNotification('error');

      expect(mockMember.send).toHaveBeenCalledOnce();
      const [msg] = mockMember.send.mock.calls[0];
      expect(msg).toContain('❌');
      expect(msg).toContain('com erro');
    });

    it('inclui preview de 200 últimos chars do buffer na DM', async () => {
      const longOutput = 'inicio '.repeat(100) + 'final da sessão';
      const mockMember = {
        send: vi.fn().mockResolvedValue({}),
      };
      const mockGuild = {
        members: {
          fetch: vi.fn().mockResolvedValue(mockMember),
        },
      };
      thread.guild = mockGuild;
      session.outputBuffer = longOutput;

      await handler._sendDMNotification('finished');

      const [msg] = mockMember.send.mock.calls[0];
      expect(msg).toContain('```');
      expect(msg).toContain('final da sessão');
    });

    it('não inclui preview quando buffer está vazio', async () => {
      const mockMember = {
        send: vi.fn().mockResolvedValue({}),
      };
      const mockGuild = {
        members: {
          fetch: vi.fn().mockResolvedValue(mockMember),
        },
      };
      thread.guild = mockGuild;
      session.outputBuffer = '';

      await handler._sendDMNotification('finished');

      const [msg] = mockMember.send.mock.calls[0];
      expect(msg).not.toContain('```');
    });

    it('captura erro silenciosamente sem lançar exceção', async () => {
      const mockGuild = {
        members: {
          fetch: vi.fn().mockRejectedValue(new Error('Membro não encontrado')),
        },
      };
      thread.guild = mockGuild;

      await expect(
        handler._sendDMNotification('finished')
      ).resolves.not.toThrow();
    });

    it('inclui referência à thread na DM', async () => {
      const mockMember = {
        send: vi.fn().mockResolvedValue({}),
      };
      const mockGuild = {
        members: {
          fetch: vi.fn().mockResolvedValue(mockMember),
        },
      };
      thread.guild = mockGuild;

      await handler._sendDMNotification('finished');

      const [msg] = mockMember.send.mock.calls[0];
      expect(msg).toContain('<#');
      expect(msg).toContain('thread-123');
    });
  });

  // ─── evento 'status' da sessão ────────────────────────────────────────────

  describe("evento 'status' da sessão", () => {
    it("'finished' chama flush e sendStatusMessage em sequência", async () => {
      const flushSpy = vi.spyOn(handler, 'flush').mockResolvedValue();
      const statusSpy = vi.spyOn(handler, 'sendStatusMessage').mockResolvedValue();

      handler.start();
      session.emit('status', 'finished');

      await flushPromises(10);

      expect(flushSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledWith('finished');
    });

    it("'running' reseta hasOutput para false após flush", async () => {
      vi.spyOn(handler, 'flush').mockResolvedValue();
      vi.spyOn(handler, 'sendStatusMessage').mockResolvedValue();

      handler.start();
      handler.hasOutput = true;
      session.emit('status', 'running');

      await flushPromises(10);

      expect(handler.hasOutput).toBe(false);
    });
  });

  // ─── evento 'server-restart' da sessão ───────────────────────────────────

  describe("evento 'server-restart' da sessão", () => {
    it("chama sendStatusMessage com 'restart'", () => {
      const statusSpy = vi.spyOn(handler, 'sendStatusMessage').mockResolvedValue();

      handler.start();
      session.emit('server-restart');

      expect(statusSpy).toHaveBeenCalledWith('restart');
    });
  });

  // ─── evento 'timeout' — erro do send ─────────────────────────────────────

  describe("evento 'timeout' — erro do send capturado", () => {
    it('não propaga exceção quando thread.send rejeita', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Rate limited'));
      handler.start();
      session.emit('timeout');
      await flushPromises(5);
      // Passa se nenhuma exceção não capturada for lançada
    });
  });

  // ─── evento 'error' da sessão ─────────────────────────────────────────────

  describe("evento 'error' da sessão", () => {
    it('não lança exceção ao emitir erro na sessão', () => {
      handler.start();
      const err = new Error('Erro crítico de sessão');
      expect(() => session.emit('error', err)).not.toThrow();
    });
  });

  // ─── evento 'question' — erro do send ────────────────────────────────────

  describe("evento 'question' — erro do send capturado", () => {
    it('não propaga exceção quando thread.send rejeita ao enviar pergunta', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Rate limited'));
      handler.start();
      session.emit('question', { questions: [{ question: 'Qual o projeto?' }] });
      await flushPromises(5);
      // Passa se nenhuma exceção não capturada for lançada
    });
  });

  // ─── _sendDiffPreview — diff inline excede MSG_LIMIT ─────────────────────

  describe('_sendDiffPreview() — diff inline excede MSG_LIMIT', () => {
    it('envia como arquivo quando formatted excede MSG_LIMIT mesmo com conteúdo dentro do DIFF_INLINE_LIMIT', async () => {
      const sendAsFileSpy = vi.spyOn(handler, '_sendDiffAsFile').mockResolvedValue();
      // fileName longo + content no limite → formatted (1904 chars) > MSG_LIMIT (1900)
      const content = 'x'.repeat(1500); // exatamente no DIFF_INLINE_LIMIT
      const filePath = 'a'.repeat(381) + '.js'; // formatted = 20 + 384 + 1500 = 1904

      await handler._sendDiffPreview(filePath, content);

      expect(sendAsFileSpy).toHaveBeenCalled();
      expect(thread.send).not.toHaveBeenCalled();
    });
  });

  // ─── flush() — comportamentos extras ─────────────────────────────────────

  describe('flush() — comportamentos extras', () => {
    it('pula chunk composto apenas de espaços em branco sem enviar mensagem para ele', async () => {
      // '   \n' + 2000 'a' + '\n' → flush processes up to last newline;
      // first chunk '   ' (whitespace) is skipped, 'a'.repeat(2000) chunk is sent
      handler.currentContent = '   \n' + 'a'.repeat(2000) + '\n';
      await handler.flush();
      // thread.send é chamado para os chunks 'a', mas não para o chunk em branco
      expect(thread.send).toHaveBeenCalled();
    });

    it('captura erro do thread.send silenciosamente sem lançar exceção', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Discord API error'));
      handler.currentContent = 'texto simples';
      await expect(handler.flush()).resolves.not.toThrow();
    });
  });

  // ─── sendStatusMessage() — erro do send ──────────────────────────────────

  describe('sendStatusMessage() — erro do send capturado', () => {
    it('não propaga exceção quando thread.send rejeita', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Rate limited'));
      await expect(handler.sendStatusMessage('finished')).resolves.not.toThrow();
    });
  });

  // ─── _handlePermissionEvent — erro do send ───────────────────────────────

  describe('_handlePermissionEvent() — erro do send', () => {
    it('retorna silenciosamente quando thread.send rejeita ao enviar permissão solicitada', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Permission send error'));
      await expect(
        handler._handlePermissionEvent({
          status: 'requested',
          toolName: 'bash',
          description: '',
          permissionId: 'perm-1',
        })
      ).resolves.not.toThrow();
    });
  });

  // ─── _handlePermissionEvent — timeout de auto-aprovação ──────────────────

  describe('_handlePermissionEvent() — timeout de auto-aprovação', () => {
    it('auto-aprova permissão após PERMISSION_TIMEOUT_MS quando _pendingPermissionId está definido', async () => {
      const mockApprove = vi.fn().mockResolvedValue({});
      session.server = { client: { approvePermission: mockApprove } };
      session.apiSessionId = 'api-sess-42';

      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'bash',
        description: '',
        permissionId: 'perm-42',
      });

      // Aguarda a mensagem de permissão ser enviada e _pendingPermission ser definido
      await flushPromises(10);

      // Simula que o processo opencode definiu o _pendingPermissionId
      session._pendingPermissionId = 'perm-42';

      await vi.advanceTimersByTimeAsync(60001);
      await flushPromises(10);

      expect(mockApprove).toHaveBeenCalledWith('api-sess-42', 'perm-42');
    });

    it('cancela auto-aprovação quando _pendingPermissionId não está definido (usuário já interagiu)', async () => {
      const mockApprove = vi.fn().mockResolvedValue({});
      session.server = { client: { approvePermission: mockApprove } };
      session.apiSessionId = 'api-sess-42';
      // session._pendingPermissionId não é definido → branch de retorno antecipado no timeout

      handler.start();
      session.emit('permission', {
        status: 'requested',
        toolName: 'bash',
        description: '',
        permissionId: 'perm-42',
      });

      await flushPromises(10);

      await vi.advanceTimersByTimeAsync(60001);
      await flushPromises(10);

      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  // ─── _handlePermissionEvent — unknown status, erro do send ───────────────

  describe('_handlePermissionEvent() — unknown status, erro do send capturado', () => {
    it('não propaga exceção quando thread.send rejeita ao enviar aviso de permissão desconhecida', async () => {
      thread.send = vi.fn().mockRejectedValue(new Error('Rate limited'));
      handler.start();
      session.emit('permission', {
        status: 'unknown',
        toolName: '',
        description: '',
        error: null,
      });
      await flushPromises(5);
      // Passa se nenhuma exceção não capturada for lançada
    });
  });
});
