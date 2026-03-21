import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { isWaitingForInput, OpenCodeSession, SessionManager } from '../src/session-manager.js';

describe('isWaitingForInput', () => {
  // ─── Casos positivos ────────────────────────────────────────────────────────

  describe('positivos — deve detectar input aguardado', () => {
    it('linha terminando com ? detecta aguardo de resposta', () => {
      expect(isWaitingForInput('Deseja continuar?')).toBe(true);
    });

    it('detecta (y/n) como opção binária de confirmação', () => {
      expect(isWaitingForInput('Deseja sobrescrever o arquivo? (y/n)')).toBe(true);
    });

    it('detecta (s/n) como variante PT-BR de confirmação', () => {
      expect(isWaitingForInput('Deseja continuar? (s/n)')).toBe(true);
    });

    it('detecta (yes/no) como opção binária por extenso', () => {
      expect(isWaitingForInput('Aplicar as mudanças? (yes/no)')).toBe(true);
    });

    it('detecta (sim/não) como variante PT-BR por extenso', () => {
      expect(isWaitingForInput('Confirmar operação? (sim/não)')).toBe(true);
    });

    it('detecta "escolha:" como solicitação de seleção', () => {
      expect(isWaitingForInput('Escolha:')).toBe(true);
    });

    it('detecta "selecione:" como solicitação de seleção', () => {
      expect(isWaitingForInput('Selecione uma opção:\n1) Sim\n2) Não')).toBe(true);
    });

    it('detecta "confirma" (sem "r" seguinte) como pedido de confirmação', () => {
      expect(isWaitingForInput('Por favor confirma a operação')).toBe(true);
    });

    it('detecta "digite:" como solicitação de entrada de dados', () => {
      // O padrão busca a substring literal "digite:" — o colon deve seguir imediatamente
      expect(isWaitingForInput('Por favor, digite: seu nome')).toBe(true);
    });

    it('detecta "informe:" como solicitação de entrada de dados', () => {
      // O padrão busca a substring literal "informe:" — o colon deve seguir imediatamente
      expect(isWaitingForInput('Por favor, informe: o valor desejado')).toBe(true);
    });

    it('detecta "press enter" como aguardo de confirmação com teclado', () => {
      expect(isWaitingForInput('Pronto! Press Enter para continuar...')).toBe(true);
    });

    it('detecta "pressione enter" como variante PT-BR de aguardo de teclado', () => {
      expect(isWaitingForInput('Pressione Enter para continuar...')).toBe(true);
    });

    it('linha com > sozinho detecta prompt de input', () => {
      expect(isWaitingForInput('Selecione uma opção:\n>')).toBe(true);
    });

    it('opção numerada com parêntese "1) algo" detecta menu de seleção', () => {
      expect(isWaitingForInput('1) Confirmar\n2) Cancelar')).toBe(true);
    });

    it('opção numerada com ponto "1. algo" detecta menu de seleção', () => {
      expect(isWaitingForInput('1. Instalar dependências\n2. Pular')).toBe(true);
    });
  });

  // ─── Casos negativos ────────────────────────────────────────────────────────

  describe('negativos — não deve detectar em output normal', () => {
    it('retorna false para string vazia', () => {
      expect(isWaitingForInput('')).toBe(false);
    });

    it('retorna false para string com apenas espaços', () => {
      expect(isWaitingForInput('   ')).toBe(false);
    });

    it('retorna false para output normal de agente sem pergunta', () => {
      expect(isWaitingForInput('Analisando o código e gerando resposta...\nConcluído com sucesso.')).toBe(false);
    });

    it('retorna false quando ? está no meio de uma linha (não no final)', () => {
      // /\?\s*$/m exige que ? esteja no final da linha
      expect(isWaitingForInput('O que? é interessante aqui é a implementação')).toBe(false);
    });

    it('retorna false para "confirmar" — regex exclui "r" imediatamente após confirma', () => {
      expect(isWaitingForInput('Pode confirmar o envio do arquivo.')).toBe(false);
    });

    it('não detecta "confirmar" (com r) como pedido de input', () => {
      expect(isWaitingForInput('Para confirmar a operação, clique em OK.')).toBe(false);
    });

    it('retorna false para null', () => {
      expect(isWaitingForInput(null)).toBe(false);
    });

    it('retorna false para undefined', () => {
      expect(isWaitingForInput(undefined)).toBe(false);
    });

    it('retorna false quando > está no meio de uma linha (não sozinho)', () => {
      // /^\s*>\s*$/m exige que > esteja sozinho na linha
      expect(isWaitingForInput('10 > 5 é verdadeiro nesse contexto')).toBe(false);
    });

    it('retorna false para número com ponto sem conteúdo depois ("1. " sem palavra)', () => {
      // /\d+[).]\s+\S/m exige \S (caractere não-espaço) após os espaços
      expect(isWaitingForInput('1. ')).toBe(false);
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('detecta pergunta no final de output longo (>500 chars)', () => {
      // A função analisa apenas os últimos 500 chars; a pergunta deve estar nessa janela
      const prefixo = 'x'.repeat(600);
      const outputLongo = `${prefixo}\nDeseja continuar?`;
      expect(isWaitingForInput(outputLongo)).toBe(true);
    });

    it('retorna false quando pergunta está APENAS no início de output longo (>500 chars)', () => {
      // A pergunta fica fora dos últimos 500 chars — não deve ser detectada
      const pergunta = 'Deseja continuar?\n';
      const sufixo = 'x'.repeat(600);
      const outputLongo = `${pergunta}${sufixo}`;
      expect(isWaitingForInput(outputLongo)).toBe(false);
    });
  });
});

// ─── OpenCodeSession ──────────────────────────────────────────────────────────

describe('OpenCodeSession', () => {
  let session, serverManager, server, client

  beforeEach(() => {
    vi.useFakeTimers()
    client = {
      createSession: vi.fn().mockResolvedValue({ id: 'api-session-1' }),
      sendMessage: vi.fn().mockResolvedValue({}),
      deleteSession: vi.fn().mockResolvedValue({}),
      approvePermission: vi.fn().mockResolvedValue({})
    }
    server = new EventEmitter()
    server.client = client
    server.registerSession = vi.fn()
    server.deregisterSession = vi.fn()
    serverManager = { getOrCreate: vi.fn().mockResolvedValue(server) }
    session = new OpenCodeSession({
      sessionId: 'sess-001',
      projectPath: '/projetos/meu-projeto',
      threadId: 'thread-001',
      userId: 'user-001',
      agent: 'coder'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('inicializa com status idle', () => {
    expect(session.status).toBe('idle')
  })

  it('inicializa apiSessionId como null', () => {
    expect(session.apiSessionId).toBeNull()
  })

  it('start() chama serverManager.getOrCreate com projectPath', async () => {
    await session.start(serverManager)
    expect(serverManager.getOrCreate).toHaveBeenCalledWith('/projetos/meu-projeto')
  })

  it('start() chama server.client.createSession()', async () => {
    await session.start(serverManager)
    expect(client.createSession).toHaveBeenCalled()
  })

  it('start() define apiSessionId com ID retornado', async () => {
    await session.start(serverManager)
    expect(session.apiSessionId).toBe('api-session-1')
  })

  it('start() chama server.registerSession', async () => {
    await session.start(serverManager)
    expect(server.registerSession).toHaveBeenCalledWith('api-session-1', session)
  })

  it('start() emite evento status idle', async () => {
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    await session.start(serverManager)
    expect(statuses).toContain('idle')
  })

  it('sendMessage() chama server.client.sendMessage', async () => {
    await session.start(serverManager)
    await session.sendMessage('hello')
    expect(client.sendMessage).toHaveBeenCalledWith('api-session-1', 'coder', 'hello')
  })

  it('sendMessage() muda status para running', async () => {
    await session.start(serverManager)
    await session.sendMessage('hello')
    expect(session.status).toBe('running')
  })

  it('sendMessage() lança erro se status é finished', async () => {
    await session.start(serverManager)
    session.status = 'finished'
    await expect(session.sendMessage('hello')).rejects.toThrow()
  })

  it('sendMessage() lança erro se status é error', async () => {
    await session.start(serverManager)
    session.status = 'error'
    await expect(session.sendMessage('hello')).rejects.toThrow()
  })

  it('close() chama deleteSession', async () => {
    await session.start(serverManager)
    await session.close()
    expect(client.deleteSession).toHaveBeenCalledWith('api-session-1')
  })

  it('close() emite evento close', async () => {
    await session.start(serverManager)
    let fired = false
    session.on('close', () => { fired = true })
    await session.close()
    expect(fired).toBe(true)
  })

  it('close() muda status para finished', async () => {
    await session.start(serverManager)
    await session.close()
    expect(session.status).toBe('finished')
  })

  it('close() define closedAt', async () => {
    await session.start(serverManager)
    await session.close()
    expect(session.closedAt).toBeInstanceOf(Date)
  })

  it('handleSSEEvent message.part.delta acumula output e emite output', async () => {
    await session.start(serverManager)
    session.status = 'running'
    const outputs = []
    session.on('output', (t) => outputs.push(t))
    session.handleSSEEvent({
      type: 'message.part.delta',
      data: { properties: { field: 'text', delta: 'hello world' } }
    })
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0]).toContain('hello world')
  })

  it('handleSSEEvent session.error emite error', async () => {
    await session.start(serverManager)
    let errorFired = false
    session.on('error', () => { errorFired = true })
    session.handleSSEEvent({
      type: 'session.error',
      data: { properties: { error: 'algo deu errado' } }
    })
    expect(errorFired).toBe(true)
    expect(session.status).toBe('error')
  })

  it('handleSSEEvent permission.asked emite permission', async () => {
    await session.start(serverManager)
    session.status = 'running'
    const permissions = []
    session.on('permission', (p) => permissions.push(p))
    session.handleSSEEvent({
      type: 'permission.asked',
      data: { properties: { id: 'perm-1', toolName: 'write_file', description: 'escrever arquivo' } }
    })
    expect(permissions.length).toBeGreaterThan(0)
  })

  it('flushPending() retorna output acumulado e limpa', async () => {
    await session.start(serverManager)
    session.status = 'running'
    session.handleSSEEvent({
      type: 'message.part.delta',
      data: { properties: { field: 'text', delta: 'conteudo' } }
    })
    const result = session.flushPending()
    expect(result).toContain('conteudo')
    expect(session.flushPending()).toBe('')
  })

  it('toSummary() retorna objeto com campos corretos', () => {
    const summary = session.toSummary()
    expect(summary.sessionId).toBe('sess-001')
    expect(summary.projectPath).toBe('/projetos/meu-projeto')
    expect(summary.threadId).toBe('thread-001')
    expect(summary.status).toBe('idle')
  })

  // ─── handleSSEEvent — session.diff ──────────────────────────────────────────

  it('handleSSEEvent session.diff emite evento diff com path e conteúdo corretos', async () => {
    await session.start(serverManager)
    const diffs = []
    session.on('diff', (d) => diffs.push(d))
    session.handleSSEEvent({
      type: 'session.diff',
      data: { properties: { diffs: [{ path: 'src/index.js', content: '+ linha adicionada' }] } }
    })
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('src/index.js')
    expect(diffs[0].content).toBe('+ linha adicionada')
  })

  it('handleSSEEvent session.diff emite múltiplos diffs de um array', async () => {
    await session.start(serverManager)
    const diffs = []
    session.on('diff', (d) => diffs.push(d))
    session.handleSSEEvent({
      type: 'session.diff',
      data: {
        properties: {
          diffs: [
            { path: 'a.js', content: 'diff a' },
            { path: 'b.js', content: 'diff b' }
          ]
        }
      }
    })
    expect(diffs).toHaveLength(2)
  })

  it('handleSSEEvent session.diff usa props.diff (objeto único) quando props.diffs não existe', async () => {
    await session.start(serverManager)
    const diffs = []
    session.on('diff', (d) => diffs.push(d))
    session.handleSSEEvent({
      type: 'session.diff',
      data: { properties: { diff: { path: 'main.js', content: 'mudança' } } }
    })
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('main.js')
  })

  it('handleSSEEvent session.diff não emite diff sem conteúdo', async () => {
    await session.start(serverManager)
    const diffs = []
    session.on('diff', (d) => diffs.push(d))
    session.handleSSEEvent({
      type: 'session.diff',
      data: { properties: { diffs: [{ path: 'arquivo.js', content: '' }] } }
    })
    expect(diffs).toHaveLength(0)
  })

  // ─── handleSSEEvent — question.asked ────────────────────────────────────────

  it('handleSSEEvent question.asked muda status para waiting_input', async () => {
    await session.start(serverManager)
    session.handleSSEEvent({
      type: 'question.asked',
      data: { properties: { questionId: 'q-1', question: 'Qual o próximo passo?' } }
    })
    expect(session.status).toBe('waiting_input')
  })

  it('handleSSEEvent question.asked emite evento question com questionId e questions', async () => {
    await session.start(serverManager)
    const questoes = []
    session.on('question', (q) => questoes.push(q))
    session.handleSSEEvent({
      type: 'question.asked',
      data: { properties: { questionId: 'q-1', question: 'Deseja prosseguir?' } }
    })
    expect(questoes).toHaveLength(1)
    expect(questoes[0].questionId).toBe('q-1')
    expect(questoes[0].questions).toHaveLength(1)
  })

  it('handleSSEEvent question.asked aceita questions como array via props.questions', async () => {
    await session.start(serverManager)
    const questoes = []
    session.on('question', (q) => questoes.push(q))
    session.handleSSEEvent({
      type: 'question.asked',
      data: {
        properties: {
          id: 'q-2',
          questions: [
            { question: 'Opção 1?' },
            { question: 'Opção 2?' }
          ]
        }
      }
    })
    expect(questoes[0].questions).toHaveLength(2)
  })

  it('handleSSEEvent question.asked emite evento status waiting_input', async () => {
    await session.start(serverManager)
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session.handleSSEEvent({
      type: 'question.asked',
      data: { properties: { id: 'q-3', question: 'Continuar?' } }
    })
    expect(statuses).toContain('waiting_input')
  })

  // ─── handleSSEEvent — session.status ────────────────────────────────────────

  it('handleSSEEvent session.status com tipo idle aciona transição e emite finished', async () => {
    await session.start(serverManager)
    session.status = 'running'
    session._recentOutput = 'Tarefa concluída com sucesso.'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session.handleSSEEvent({
      type: 'session.status',
      data: { properties: { status: { type: 'idle' } } }
    })
    expect(statuses).toContain('finished')
  })

  it('handleSSEEvent session.status com tipo diferente de idle não altera status', async () => {
    await session.start(serverManager)
    session.status = 'running'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session.handleSSEEvent({
      type: 'session.status',
      data: { properties: { status: { type: 'running' } } }
    })
    expect(statuses).not.toContain('finished')
    expect(session.status).toBe('running')
  })

  // ─── handleSSEEvent — session.idle ──────────────────────────────────────────

  it('handleSSEEvent session.idle aciona transição e emite finished quando running', async () => {
    await session.start(serverManager)
    session.status = 'running'
    session._recentOutput = 'Processamento finalizado.'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session.handleSSEEvent({ type: 'session.idle', data: {} })
    expect(statuses).toContain('finished')
  })

  // ─── _handleIdleTransition ───────────────────────────────────────────────────

  it('_handleIdleTransition com status running e output sem padrão de input emite finished', async () => {
    await session.start(serverManager)
    session.status = 'running'
    session._recentOutput = 'Arquivo gerado com sucesso.'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session._handleIdleTransition()
    expect(statuses).toContain('finished')
    expect(session.status).toBe('idle')
  })

  it('_handleIdleTransition com status running e padrão de input muda para waiting_input', async () => {
    await session.start(serverManager)
    session.status = 'running'
    session._recentOutput = 'Deseja sobrescrever o arquivo? (y/n)'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session._handleIdleTransition()
    expect(statuses).toContain('waiting_input')
    expect(session.status).toBe('waiting_input')
  })

  it('_handleIdleTransition com status waiting_input emite finished', async () => {
    await session.start(serverManager)
    session.status = 'waiting_input'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session._handleIdleTransition()
    expect(statuses).toContain('finished')
    expect(session.status).toBe('idle')
  })

  it('_handleIdleTransition com status idle não emite nenhum evento', async () => {
    await session.start(serverManager)
    session.status = 'idle'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session._handleIdleTransition()
    expect(statuses).toHaveLength(0)
  })

  // ─── abort ───────────────────────────────────────────────────────────────────

  it('abort() chama server.client.abortSession com apiSessionId', async () => {
    client.abortSession = vi.fn().mockResolvedValue({})
    await session.start(serverManager)
    await session.abort()
    expect(client.abortSession).toHaveBeenCalledWith('api-session-1')
  })

  it('abort() não faz nada se apiSessionId é null', async () => {
    client.abortSession = vi.fn().mockResolvedValue({})
    // Não chama start() — apiSessionId permanece null
    await session.abort()
    expect(client.abortSession).not.toHaveBeenCalled()
  })

  // ─── handleSSEEvent — message.part.delta (casos adicionais) ─────────────────

  it('handleSSEEvent message.part.delta ignora campos diferentes de text', async () => {
    await session.start(serverManager)
    const outputs = []
    session.on('output', (t) => outputs.push(t))
    session.handleSSEEvent({
      type: 'message.part.delta',
      data: { properties: { field: 'reasoning', delta: 'raciocínio interno' } }
    })
    expect(outputs).toHaveLength(0)
  })

  it('handleSSEEvent message.part.delta ignora delta vazio', async () => {
    await session.start(serverManager)
    const outputs = []
    session.on('output', (t) => outputs.push(t))
    session.handleSSEEvent({
      type: 'message.part.delta',
      data: { properties: { field: 'text', delta: '' } }
    })
    expect(outputs).toHaveLength(0)
  })

  it('handleSSEEvent message.part.delta em status waiting_input transita de volta para running', async () => {
    await session.start(serverManager)
    session.status = 'waiting_input'
    const statuses = []
    session.on('status', (s) => statuses.push(s))
    session.handleSSEEvent({
      type: 'message.part.delta',
      data: { properties: { field: 'text', delta: 'continuando processamento...' } }
    })
    expect(session.status).toBe('running')
    expect(statuses).toContain('running')
  })

  // ─── close — tratamento de erros ─────────────────────────────────────────────

  it('close() trata erro em deleteSession e ainda emite evento close', async () => {
    client.deleteSession = vi.fn().mockRejectedValue(new Error('API indisponível'))
    await session.start(serverManager)
    let firedClose = false
    session.on('close', () => { firedClose = true })
    await session.close()
    expect(firedClose).toBe(true)
    expect(session.status).toBe('finished')
  })
})

// ─── SessionManager ───────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let sm, serverManager, server, client

  beforeEach(() => {
    vi.useFakeTimers()
    client = {
      createSession: vi.fn().mockResolvedValue({ id: 'api-sess-1' }),
      sendMessage: vi.fn().mockResolvedValue({}),
      deleteSession: vi.fn().mockResolvedValue({}),
      approvePermission: vi.fn().mockResolvedValue({})
    }
    server = new EventEmitter()
    server.client = client
    server.registerSession = vi.fn()
    server.deregisterSession = vi.fn()
    serverManager = { getOrCreate: vi.fn().mockResolvedValue(server) }
    sm = new SessionManager(serverManager)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('getAll() retorna array vazio inicialmente', () => {
    expect(sm.getAll()).toEqual([])
  })

  it('getByThread() retorna undefined para thread inexistente', () => {
    expect(sm.getByThread('nao-existe')).toBeUndefined()
  })

  it('create() retorna instância de OpenCodeSession', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-aaa',
      userId: 'user-aaa',
      agent: 'coder'
    })
    expect(sess).toBeInstanceOf(OpenCodeSession)
  })

  it('create() indexa sessão por threadId', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-bbb',
      userId: 'user-bbb',
      agent: 'coder'
    })
    expect(sm.getByThread('thread-bbb')).toBe(sess)
  })

  it('getByUser() retorna sessões do usuário', async () => {
    await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-ccc',
      userId: 'user-ccc',
      agent: 'coder'
    })
    expect(sm.getByUser('user-ccc').length).toBeGreaterThan(0)
  })

  it('getAll() retorna sessão criada', async () => {
    await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-ddd',
      userId: 'user-ddd',
      agent: 'coder'
    })
    expect(sm.getAll().length).toBeGreaterThan(0)
  })

  it('destroy() remove sessão dos índices', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-eee',
      userId: 'user-eee',
      agent: 'coder'
    })
    await sm.destroy(sess.sessionId)
    expect(sm.getByThread('thread-eee')).toBeUndefined()
  })

  it('quando sessão fecha, remove do _threadIndex imediatamente', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/proj',
      threadId: 'thread-fff',
      userId: 'user-fff',
      agent: 'coder'
    })
    await sess.close()
    expect(sm.getByThread('thread-fff')).toBeUndefined()
  })

  // ─── getByProject ─────────────────────────────────────────────────────────

  it('getByProject() retorna sessão ativa para o caminho do projeto', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/meu-app',
      threadId: 'thread-proj-1',
      userId: 'user-p1',
      agent: 'coder'
    })
    expect(sm.getByProject('/projetos/meu-app')).toBe(sess)
  })

  it('getByProject() retorna undefined quando não há sessão para o projeto', () => {
    expect(sm.getByProject('/projetos/inexistente')).toBeUndefined()
  })

  it('getByProject() não retorna sessão com status finished', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/encerrado',
      threadId: 'thread-enc',
      userId: 'user-enc',
      agent: 'coder'
    })
    await sess.close()
    expect(sm.getByProject('/projetos/encerrado')).toBeUndefined()
  })

  it('getByProject() não retorna sessão com status error', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/com-erro',
      threadId: 'thread-err',
      userId: 'user-err',
      agent: 'coder'
    })
    sess.status = 'error'
    expect(sm.getByProject('/projetos/com-erro')).toBeUndefined()
  })

  // ─── getById ──────────────────────────────────────────────────────────────

  it('getById() retorna sessão pelo sessionId interno', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/proj-id',
      threadId: 'thread-id-1',
      userId: 'user-id',
      agent: 'coder'
    })
    expect(sm.getById(sess.sessionId)).toBe(sess)
  })

  it('getById() retorna undefined para sessionId inexistente', () => {
    expect(sm.getById('id-que-nao-existe')).toBeUndefined()
  })

  // ─── _checkTimeouts ───────────────────────────────────────────────────────

  it('_checkTimeouts() expira sessão inativa além do timeout padrão', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/timeout-direto',
      threadId: 'thread-td',
      userId: 'user-td',
      agent: 'coder'
    })
    // Simula lastActivityAt 31 min no passado (além do timeout padrão de 30 min)
    sess.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000)

    await sm._checkTimeouts()

    expect(sess.status).toBe('finished')
  })

  it('_checkTimeouts() não expira sessão recentemente ativa', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/recente',
      threadId: 'thread-rec',
      userId: 'user-rec',
      agent: 'coder'
    })
    // lastActivityAt ainda é "agora" — não deve expirar
    await sm._checkTimeouts()

    expect(sess.status).not.toBe('finished')
  })

  it('_checkTimeouts() usa timeout duplo (60 min) para sessão em waiting_input', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/aguardando',
      threadId: 'thread-wt',
      userId: 'user-wt',
      agent: 'coder'
    })
    sess.status = 'waiting_input'
    // 35 min de inatividade: excede timeout normal (30 min), mas NÃO o duplo (60 min)
    sess.lastActivityAt = new Date(Date.now() - 35 * 60 * 1000)

    await sm._checkTimeouts()

    // Sessão deve permanecer ativa pois ainda está dentro do timeout duplo
    expect(sess.status).toBe('waiting_input')
  })

  it('_checkTimeouts() expira sessão em waiting_input além do timeout duplo', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/aguardando-exp',
      threadId: 'thread-wte',
      userId: 'user-wte',
      agent: 'coder'
    })
    sess.status = 'waiting_input'
    // 61 min de inatividade: excede o timeout duplo (60 min)
    sess.lastActivityAt = new Date(Date.now() - 61 * 60 * 1000)

    await sm._checkTimeouts()

    expect(sess.status).toBe('finished')
  })

  it('_checkTimeouts() não verifica sessões já encerradas (finished)', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/ja-encerrado',
      threadId: 'thread-ja',
      userId: 'user-ja',
      agent: 'coder'
    })
    sess.status = 'finished'
    sess.lastActivityAt = new Date(0) // Epoch — seria expirado se fosse verificado

    // Não deve lançar erro e status deve permanecer finished
    await sm._checkTimeouts()
    expect(sess.status).toBe('finished')
  })

  it('_checkTimeouts() é disparado automaticamente pelo setInterval ao avançar tempo', async () => {
    const sess = await sm.create({
      projectPath: '/projetos/timeout-timer',
      threadId: 'thread-tt',
      userId: 'user-tt',
      agent: 'coder'
    })
    // Sessão inativa há 31 min no passado (relativo ao tempo fake atual)
    sess.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000)

    // Avança 1 minuto (60 000 ms) para disparar o setInterval de verificação
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sess.status).toBe('finished')
  })

  // ─── destroy — id inexistente ─────────────────────────────────────────────

  it('destroy() com sessionId inexistente não lança erro', async () => {
    await expect(sm.destroy('sessao-que-nao-existe')).resolves.toBeUndefined()
  })

  // ─── queueMessage ──────────────────────────────────────────────────────────

  it('queueMessage() envia imediatamente quando status é idle', async () => {
    const sess = await sm.create({ projectPath: '/projetos/queue-idle', threadId: 'thread-qi', userId: 'user-qi', agent: 'coder' })
    client.sendMessage.mockClear()
    await sess.queueMessage('olá agente')
    expect(client.sendMessage).toHaveBeenCalledWith('api-sess-1', 'coder', 'olá agente')
    expect(sess._messageQueue).toHaveLength(0)
  })

  it('queueMessage() enfileira sem enviar quando status é running', async () => {
    const sess = await sm.create({ projectPath: '/projetos/queue-running', threadId: 'thread-qr', userId: 'user-qr', agent: 'coder' })
    sess.status = 'running'
    client.sendMessage.mockClear()
    await sess.queueMessage('mensagem enfileirada')
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(sess._messageQueue).toHaveLength(1)
  })

  // ─── togglePassthrough ─────────────────────────────────────────────────────

  it('togglePassthrough() inverte passthroughEnabled e retorna novo valor', () => {
    const sess = new OpenCodeSession({ sessionId: 'sess-pt', projectPath: '/projetos/pt', threadId: 'thread-pt', userId: 'user-pt', agent: 'coder' })
    expect(sess.passthroughEnabled).toBe(true)
    const result = sess.togglePassthrough()
    expect(result).toBe(false)
    expect(sess.passthroughEnabled).toBe(false)
    const result2 = sess.togglePassthrough()
    expect(result2).toBe(true)
  })

  // ─── totalCreated ──────────────────────────────────────────────────────────

  it('totalCreated começa em 0 e incrementa a cada create()', async () => {
    expect(sm.totalCreated).toBe(0)
    await sm.create({ projectPath: '/projetos/tc-1', threadId: 'thread-tc1', userId: 'user-tc1', agent: 'coder' })
    expect(sm.totalCreated).toBe(1)
    await sm.create({ projectPath: '/projetos/tc-2', threadId: 'thread-tc2', userId: 'user-tc2', agent: 'coder' })
    expect(sm.totalCreated).toBe(2)
  })

  // ─── create com model ──────────────────────────────────────────────────────

  it('create() com opção model define session.model corretamente', async () => {
    const sess = await sm.create({ projectPath: '/projetos/model-test', threadId: 'thread-mdl', userId: 'user-mdl', agent: 'coder', model: 'openai/gpt-4o' })
    expect(sess.model).toBe('openai/gpt-4o')
  })

  // ─── queueMessage — retorno { queued, position } ────────────────────────────

  it('queueMessage() retorna { queued: false, position: 0 } quando status é idle', async () => {
    const sess = await sm.create({ projectPath: '/projetos/qret-idle', threadId: 'thread-qri', userId: 'user-qri', agent: 'coder' })
    // status é 'idle' após start
    const result = await sess.queueMessage('olá agente')
    expect(result).toEqual({ queued: false, position: 0 })
  })

  it('queueMessage() retorna { queued: true, position: 1 } quando status é running (primeira mensagem)', async () => {
    const sess = await sm.create({ projectPath: '/projetos/qret-running', threadId: 'thread-qrr', userId: 'user-qrr', agent: 'coder' })
    sess.status = 'running'
    const result = await sess.queueMessage('primeira mensagem')
    expect(result).toEqual({ queued: true, position: 1 })
  })

  it('queueMessage() retorna { queued: true, position: 2 } para segunda mensagem enfileirada', async () => {
    const sess = await sm.create({ projectPath: '/projetos/qret-p2', threadId: 'thread-qrp2', userId: 'user-qrp2', agent: 'coder' })
    sess.status = 'running'
    await sess.queueMessage('primeira')
    const result = await sess.queueMessage('segunda')
    expect(result).toEqual({ queued: true, position: 2 })
  })

  // ─── queue-change event ──────────────────────────────────────────────────────

  it('queueMessage() emite queue-change ao adicionar mensagem à fila quando running', async () => {
    const sess = await sm.create({ projectPath: '/projetos/qchange', threadId: 'thread-qch', userId: 'user-qch', agent: 'coder' })
    sess.status = 'running'
    const changes = []
    sess.on('queue-change', (size) => changes.push(size))
    await sess.queueMessage('mensagem')
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]).toBe(1)
  })

  // ─── getQueueSize ────────────────────────────────────────────────────────────

  it('getQueueSize() retorna 0 inicialmente e incrementa ao enfileirar mensagens', async () => {
    const sess = await sm.create({ projectPath: '/projetos/qsize', threadId: 'thread-qs', userId: 'user-qs', agent: 'coder' })
    expect(sess.getQueueSize()).toBe(0)
    sess.status = 'running'
    await sess.queueMessage('msg1')
    expect(sess.getQueueSize()).toBe(1)
    await sess.queueMessage('msg2')
    expect(sess.getQueueSize()).toBe(2)
  })

  // ─── _drainMessageQueue — estados terminais ──────────────────────────────────

  it('_drainMessageQueue() não processa mensagens quando status já é finished', async () => {
    const sess = await sm.create({ projectPath: '/projetos/drain-fin', threadId: 'thread-df', userId: 'user-df', agent: 'coder' })
    sess.status = 'finished'
    sess._messageQueue = ['msg1', 'msg2']
    client.sendMessage.mockClear()
    await sess._drainMessageQueue()
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('_drainMessageQueue() emite queue-abandoned quando status é terminal e há mensagens', async () => {
    const sess = await sm.create({ projectPath: '/projetos/drain-abandon', threadId: 'thread-da', userId: 'user-da', agent: 'coder' })
    sess.status = 'finished'
    sess._messageQueue = ['msg1', 'msg2', 'msg3']
    const abandoned = []
    sess.on('queue-abandoned', (count) => abandoned.push(count))
    await sess._drainMessageQueue()
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]).toBe(3)
    expect(sess._messageQueue).toHaveLength(0)
  })

  // ─── _handleIdleTransition — waiting_input → finished drena fila ─────────────

  it('_handleIdleTransition() com status waiting_input chama _drainMessageQueue()', async () => {
    const sess = await sm.create({ projectPath: '/projetos/idle-drain', threadId: 'thread-id2', userId: 'user-id2', agent: 'coder' })
    sess.status = 'waiting_input'
    sess._messageQueue = ['mensagem pendente']
    const drainSpy = vi.spyOn(sess, '_drainMessageQueue').mockResolvedValue()
    sess._handleIdleTransition()
    expect(drainSpy).toHaveBeenCalled()
  })
})
