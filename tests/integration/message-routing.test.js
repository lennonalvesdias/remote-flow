// tests/integration/message-routing.test.js
// Testa o roteamento de mensagens da thread para sessões OpenCode.
// Replica a lógica do handler messageCreate de src/index.js inline,
// pois src/index.js não pode ser importado diretamente (contém process.exit no nível de módulo).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { SessionManager, OpenCodeSession } from '../../src/session-manager.js'
import { formatAge } from '../../src/utils.js'

// ─── Mock de I/O externo ──────────────────────────────────────────────────────
// persistence.js usa node:fs/promises — evita leituras/escritas reais em disco

vi.mock('node:fs/promises', () => {
  const fsMock = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
  return { default: fsMock, ...fsMock }
})

// ─── Helper: simulateMessageCreate ───────────────────────────────────────────

/**
 * Replica a lógica do handler 'messageCreate' de src/index.js para testes de integração.
 * Cobre apenas mensagens de texto (sem voz/attachments). Mantido em sincronia com
 * a lógica real de roteamento definida em src/index.js.
 * @param {object} message - Objeto de mensagem Discord mock
 * @param {SessionManager} sessionManager
 * @param {object} [opts={}] - Configuração de runtime equivalente às variáveis de ambiente
 * @param {string[]} [opts.ALLOWED_USERS=[]] - IDs de usuários autorizados
 * @param {boolean} [opts.ALLOW_SHARED_SESSIONS=false] - Permite sessões compartilhadas
 * @param {string|null} [opts.allowedChannelId=null] - ID do canal pai permitido
 */
async function simulateMessageCreate(message, sessionManager, opts = {}) {
  const { ALLOWED_USERS = [], ALLOW_SHARED_SESSIONS = false, allowedChannelId = null } = opts

  // Guard: ignora mensagens do próprio bot
  if (message.author.bot) return

  // Guard: só processa dentro de threads
  if (!message.channel.isThread()) return

  // Guard: verificação de usuários autorizados
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(message.author.id)) return

  // Guard: restrição de canal pai (opcional)
  if (allowedChannelId) {
    if (message.channel.parentId !== allowedChannelId) return
  }

  // Guard: sessão deve existir para essa thread
  const session = sessionManager.getByThread(message.channel.id)
  if (!session) return

  // Guard: ownership da sessão (a menos que sessões compartilhadas estejam habilitadas)
  if (!ALLOW_SHARED_SESSIONS && session.userId !== message.author.id) return

  const text = message.content.trim()

  // Comandos especiais inline
  if (text === '/stop') {
    await sessionManager.destroy(session.sessionId)
    await message.reply('🛑 Sessão encerrada.')
    return
  }

  if (text === '/status') {
    const s = session.toSummary()
    await message.reply(
      `**Status:** ${s.status}\n**Projeto:** ${s.project}\n**Última atividade:** ${formatAge(s.lastActivityAt)} atrás`
    )
    return
  }

  // Passthrough desativado — ignora mensagens inline
  if (!session.passthroughEnabled) return

  let queueResult
  try {
    queueResult = await session.queueMessage(text)
  } catch (err) {
    await message.reply('⚠️ O processo OpenCode não está ativo nesta sessão. Use `/plan` ou `/build` para iniciar uma nova.').catch(() => {})
    return
  }

  if (queueResult.queued) {
    try {
      await message.reply(`📮 Sua mensagem foi enfileirada (posição ${queueResult.position}). Ela será enviada quando o agente concluir a tarefa atual.`)
    } catch { /* ignora erros de reply */ }
  } else {
    try {
      await message.react('⚙️')
    } catch { /* ignora erros de react */ }
  }
}

// ─── Factories de mocks ───────────────────────────────────────────────────────

/**
 * Cria uma mensagem Discord mock para testes de roteamento.
 * @param {object} [opts={}]
 * @param {string} [opts.content] - Conteúdo da mensagem
 * @param {string} [opts.authorId] - ID do autor
 * @param {boolean} [opts.bot] - Se a mensagem é de bot
 * @param {string} [opts.threadId] - ID da thread (channel.id)
 * @param {string|null} [opts.parentId] - ID do canal pai da thread
 * @param {boolean} [opts.isThread] - Se o canal é uma thread
 * @returns {object}
 */
function createMockMessage({
  content = 'olá agente',
  authorId = 'user-mr-default',
  bot = false,
  threadId = 'thread-mr-default',
  parentId = null,
  isThread = true,
} = {}) {
  return {
    content,
    author: { id: authorId, bot, tag: 'user#0001' },
    channel: { id: threadId, parentId, isThread: () => isThread },
    attachments: new Map(),
    react: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    reactions: { cache: new Map() },
  }
}

/**
 * Cria um serverManager mock para injeção no SessionManager.
 * @returns {object}
 */
function createMockServerManager() {
  const server = {
    client: {
      createSession: vi.fn().mockResolvedValue({ id: 'api-mr-sess-1' }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    },
    registerSession: vi.fn(),
    deregisterSession: vi.fn(),
    plannotatorBaseUrl: null,
    on: vi.fn(),
    off: vi.fn(),
    _sessionRegistry: new Map(),
  }
  return { getOrCreate: vi.fn().mockResolvedValue(server), _server: server }
}

/**
 * Cria e injeta um OpenCodeSession pré-configurado no SessionManager.
 * Bypassa session.start() para evitar I/O externo.
 * @param {SessionManager} sm
 * @param {object} serverManager
 * @param {object} opts
 * @returns {OpenCodeSession}
 */
function injectSession(sm, serverManager, {
  threadId = 'thread-mr-default',
  userId = 'user-mr-default',
  status = 'idle',
  passthroughEnabled = true,
  projectPath = '/projetos/app',
} = {}) {
  const sessionId = `sess-mr-${randomUUID().split('-')[0]}`
  const session = new OpenCodeSession({ sessionId, projectPath, threadId, userId, agent: 'plan', model: '' })
  session.status = status
  session.passthroughEnabled = passthroughEnabled
  session.apiSessionId = 'api-mr-fake-1'
  session.server = serverManager._server
  sm._sessions.set(session.sessionId, session)
  sm._threadIndex.set(threadId, session.sessionId)
  return session
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Roteamento de mensagens para sessões', () => {
  /** @type {ReturnType<createMockServerManager>} */
  let serverManager
  /** @type {SessionManager} */
  let sm

  beforeEach(() => {
    vi.useFakeTimers()
    serverManager = createMockServerManager()
    sm = new SessionManager(serverManager)
  })

  afterEach(() => {
    if (sm._timeoutTimer) clearInterval(sm._timeoutTimer)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ─── Filtragem de mensagens inválidas ────────────────────────────────────────

  describe('Filtragem de mensagens inválidas', () => {
    it('mensagem de bot é ignorada silenciosamente', async () => {
      const threadId = `thread-mr-bot-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId })
      const message = createMockMessage({ authorId: 'bot-id', bot: true, threadId })

      await simulateMessageCreate(message, sm)

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('mensagem em canal que não é thread é ignorada', async () => {
      const threadId = `thread-mr-notthread-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId })
      const message = createMockMessage({ threadId, isThread: false })

      await simulateMessageCreate(message, sm)

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('mensagem em thread sem sessão associada é ignorada', async () => {
      const message = createMockMessage({ threadId: 'thread-sem-sessao-xyz' })

      await simulateMessageCreate(message, sm)

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })
  })

  // ─── Autorização de usuários ─────────────────────────────────────────────────

  describe('Autorização de usuários', () => {
    it('usuário não listado em ALLOWED_USERS é bloqueado', async () => {
      const threadId = `thread-mr-auth-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId: 'authorized-user' })
      const message = createMockMessage({ authorId: 'intruder-user', threadId })

      await simulateMessageCreate(message, sm, { ALLOWED_USERS: ['authorized-user'] })

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('usuário listado em ALLOWED_USERS tem mensagem roteada normalmente', async () => {
      const threadId = `thread-mr-auth2-${randomUUID().split('-')[0]}`
      const userId = `allowed-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId })
      const message = createMockMessage({ authorId: userId, threadId })

      await simulateMessageCreate(message, sm, { ALLOWED_USERS: [userId] })

      // Sessão idle + passthrough ativo → react ⚙️
      expect(message.react).toHaveBeenCalledWith('⚙️')
    })
  })

  // ─── Controle de ownership da sessão ────────────────────────────────────────

  describe('Controle de ownership da sessão', () => {
    it('usuário diferente do dono é bloqueado quando ALLOW_SHARED_SESSIONS=false', async () => {
      const threadId = `thread-mr-own-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId: 'owner-user' })
      const message = createMockMessage({ authorId: 'other-user', threadId })

      await simulateMessageCreate(message, sm, { ALLOW_SHARED_SESSIONS: false })

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('usuário diferente do dono é permitido quando ALLOW_SHARED_SESSIONS=true', async () => {
      const threadId = `thread-mr-shared-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId: 'owner-user' })
      const message = createMockMessage({ authorId: 'other-user', threadId })

      await simulateMessageCreate(message, sm, { ALLOW_SHARED_SESSIONS: true })

      // Sessão idle + passthrough ativo → react ⚙️
      expect(message.react).toHaveBeenCalledWith('⚙️')
    })
  })

  // ─── Controle de passthrough ─────────────────────────────────────────────────

  describe('Controle de passthrough', () => {
    it('passthrough desativado: mensagem não é roteada para queueMessage', async () => {
      const threadId = `thread-mr-ptoff-${randomUUID().split('-')[0]}`
      const userId = `user-mr-ptoff-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId, userId, passthroughEnabled: false })
      const queueSpy = vi.spyOn(session, 'queueMessage')
      const message = createMockMessage({ authorId: userId, threadId })

      await simulateMessageCreate(message, sm)

      expect(queueSpy).not.toHaveBeenCalled()
      expect(message.react).not.toHaveBeenCalled()
    })

    it('passthrough ativado: mensagem de texto é roteada via queueMessage', async () => {
      const threadId = `thread-mr-pton-${randomUUID().split('-')[0]}`
      const userId = `user-mr-pton-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId, userId, passthroughEnabled: true })
      const queueSpy = vi.spyOn(session, 'queueMessage')
      const message = createMockMessage({ authorId: userId, threadId, content: 'faça algo' })

      await simulateMessageCreate(message, sm)

      expect(queueSpy).toHaveBeenCalledWith('faça algo')
    })
  })

  // ─── Enfileiramento de mensagens ─────────────────────────────────────────────

  describe('Enfileiramento de mensagens', () => {
    it('sessão idle: mensagem enviada imediatamente → react ⚙️', async () => {
      const threadId = `thread-mr-idle-${randomUUID().split('-')[0]}`
      const userId = `user-mr-idle-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId, status: 'idle' })
      const message = createMockMessage({ authorId: userId, threadId, content: 'execute tarefa' })

      await simulateMessageCreate(message, sm)

      expect(message.react).toHaveBeenCalledWith('⚙️')
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('sessão running: mensagem enfileirada → reply com posição na fila', async () => {
      const threadId = `thread-mr-running-${randomUUID().split('-')[0]}`
      const userId = `user-mr-running-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId, status: 'running' })
      const message = createMockMessage({ authorId: userId, threadId, content: 'próxima tarefa' })

      await simulateMessageCreate(message, sm)

      expect(message.reply).toHaveBeenCalledWith(
        expect.stringContaining('📮 Sua mensagem foi enfileirada')
      )
      expect(message.react).not.toHaveBeenCalled()
    })

    it('sessão encerrada (finished): reply com aviso de sessão inativa', async () => {
      const threadId = `thread-mr-fin-${randomUUID().split('-')[0]}`
      const userId = `user-mr-fin-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId, status: 'finished' })
      const message = createMockMessage({ authorId: userId, threadId, content: 'oi' })

      await simulateMessageCreate(message, sm)

      expect(message.reply).toHaveBeenCalledWith(
        expect.stringContaining('⚠️ O processo OpenCode não está ativo')
      )
    })
  })

  // ─── Comandos especiais inline ───────────────────────────────────────────────

  describe('Comandos especiais inline', () => {
    it('/stop inline: encerra a sessão e confirma ao usuário', async () => {
      const threadId = `thread-mr-stop-${randomUUID().split('-')[0]}`
      const userId = `user-mr-stop-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId, userId })
      const destroySpy = vi.spyOn(sm, 'destroy')
      const message = createMockMessage({ authorId: userId, threadId, content: '/stop' })

      await simulateMessageCreate(message, sm)

      expect(destroySpy).toHaveBeenCalledWith(session.sessionId)
      expect(message.reply).toHaveBeenCalledWith('🛑 Sessão encerrada.')
    })

    it('/status inline: exibe status, projeto e última atividade', async () => {
      const threadId = `thread-mr-status-${randomUUID().split('-')[0]}`
      const userId = `user-mr-status-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId, status: 'idle' })
      const message = createMockMessage({ authorId: userId, threadId, content: '/status' })

      await simulateMessageCreate(message, sm)

      const replyContent = message.reply.mock.calls[0]?.[0]
      expect(typeof replyContent).toBe('string')
      expect(replyContent).toContain('**Status:**')
      expect(replyContent).toContain('**Projeto:**')
      expect(replyContent).toContain('**Última atividade:**')
    })

    it('/status inline: não encaminha o texto para queueMessage', async () => {
      const threadId = `thread-mr-status2-${randomUUID().split('-')[0]}`
      const userId = `user-mr-status2-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId, userId, status: 'idle' })
      const queueSpy = vi.spyOn(session, 'queueMessage')
      const message = createMockMessage({ authorId: userId, threadId, content: '/status' })

      await simulateMessageCreate(message, sm)

      expect(queueSpy).not.toHaveBeenCalled()
    })
  })

  // ─── Restrição de canal pai ──────────────────────────────────────────────────

  describe('Restrição de canal pai', () => {
    it('mensagem de thread com parentId errado é ignorada quando allowedChannelId está definido', async () => {
      const threadId = `thread-mr-parent-${randomUUID().split('-')[0]}`
      const userId = `user-mr-parent-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId })
      const message = createMockMessage({ authorId: userId, threadId, parentId: 'canal-errado' })

      await simulateMessageCreate(message, sm, { allowedChannelId: 'canal-correto' })

      expect(message.react).not.toHaveBeenCalled()
      expect(message.reply).not.toHaveBeenCalled()
    })

    it('mensagem de thread com parentId correto passa a verificação de canal', async () => {
      const threadId = `thread-mr-parent2-${randomUUID().split('-')[0]}`
      const userId = `user-mr-parent2-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId, userId })
      const message = createMockMessage({ authorId: userId, threadId, parentId: 'canal-correto' })

      await simulateMessageCreate(message, sm, { allowedChannelId: 'canal-correto' })

      // Sessão idle + passthrough ativo → react ⚙️
      expect(message.react).toHaveBeenCalledWith('⚙️')
    })
  })
})
