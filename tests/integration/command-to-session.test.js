// tests/integration/command-to-session.test.js
// Testa a integração entre comandos Discord e criação/gerenciamento de sessões.
// Usa handleCommand REAL e SessionManager REAL com dependências externas mockadas.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'

// ─── Estado mutável para testes de autorização ────────────────────────────────

const mockConfigState = vi.hoisted(() => ({ allowedUsers: [], maxGlobalSessions: 0 }))

// ─── Mocks de módulos (hoisted pelo Vitest) ───────────────────────────────────
// Deve vir antes dos imports de commands.js para interceptar as dependências.

vi.mock('../../src/config.js', () => ({
  get ALLOWED_USERS() { return mockConfigState.allowedUsers },
  get MAX_GLOBAL_SESSIONS() { return mockConfigState.maxGlobalSessions },
  ALLOW_SHARED_SESSIONS: false,
  DISCORD_MSG_LIMIT: 1900,
  STREAM_UPDATE_INTERVAL: 1500,
  ENABLE_DM_NOTIFICATIONS: false,
  PROJECTS_BASE: '/projetos',
  OPENCODE_BIN: 'opencode',
  OPENCODE_BASE_PORT: 4100,
  DEFAULT_TIMEOUT_MS: 10000,
  MAX_SESSIONS_PER_USER: 3,
  SESSION_TIMEOUT_MS: 1800000,
  MAX_BUFFER: 512000,
  HEALTH_PORT: 9090,
  SERVER_RESTART_DELAY_MS: 2000,
  LOG_FILE_READ_DELAY_MS: 500,
  THREAD_ARCHIVE_DELAY_MS: 5000,
  STATUS_QUEUE_ITEM_TIMEOUT_MS: 5000,
  SHUTDOWN_TIMEOUT_MS: 10000,
  CHANNEL_FETCH_TIMEOUT_MS: 2000,
  SERVER_CIRCUIT_BREAKER_COOLDOWN_MS: 60000,
  DEFAULT_MODEL: '',
  MAX_SESSIONS_PER_PROJECT: 2,
  PERMISSION_TIMEOUT_MS: 60000,
  GITHUB_TOKEN: 'test-token',
  GITHUB_DEFAULT_OWNER: 'owner',
  GITHUB_DEFAULT_REPO: 'repo',
  GIT_AUTHOR_NAME: 'Test Bot',
  GIT_AUTHOR_EMAIL: 'bot@test.com',
  PERSISTENCE_PATH: null,
  validateProjectPath: vi.fn((name) => ({
    valid: true,
    projectPath: '/projetos/' + name,
    error: null,
  })),
}))

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))

vi.mock('../../src/model-loader.js', () => ({
  getAvailableModels: () => ['anthropic/claude-sonnet-4-5'],
}))

vi.mock('../../src/opencode-commands.js', () => ({
  listOpenCodeCommands: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/stream-handler.js', () => ({
  StreamHandler: vi.fn().mockImplementation(function () {
    this.start = vi.fn()
    this.stop = vi.fn()
    this.flush = vi.fn().mockResolvedValue(undefined)
    this.currentRawContent = ''
  }),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
}))

vi.mock('../../src/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/github.js', () => ({
  getGitHubClient: vi.fn(() => ({
    createPullRequest: vi.fn(),
    listPullRequests: vi.fn().mockResolvedValue([]),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    getPullRequestFiles: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn(),
    createReview: vi.fn(),
    createIssue: vi.fn(),
  })),
}))

vi.mock('../../src/reporter.js', () => ({
  analyzeOutput: vi.fn().mockReturnValue({ errors: [], suggestedActions: [], summary: '' }),
  captureThreadMessages: vi.fn().mockResolvedValue([]),
  formatReportText: vi.fn().mockReturnValue(''),
  buildReportEmbed: vi.fn().mockReturnValue({
    data: { fields: [] },
    addFields: vi.fn().mockReturnThis(),
  }),
  readRecentLogs: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/git.js', () => ({
  getRepoInfo: vi.fn().mockResolvedValue({ owner: 'o', repo: 'r' }),
  hasChanges: vi.fn().mockResolvedValue(true),
  createBranchAndCommit: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/plannotator-client.js', () => ({
  PlannotatorClient: vi.fn().mockImplementation(function () {
    this.approve = vi.fn().mockResolvedValue({})
    this.deny = vi.fn().mockResolvedValue({})
  }),
}))

vi.mock('node:fs/promises', () => {
  const fsMock = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  }
  return { default: fsMock, ...fsMock }
})

// ─── Imports dos módulos sob teste (após os mocks) ────────────────────────────

import * as fsp from 'fs/promises'
import { handleCommand, _resetProjectsCache } from '../../src/commands.js'
import { SessionManager, OpenCodeSession } from '../../src/session-manager.js'

// ─── Factories de mocks ───────────────────────────────────────────────────────

/**
 * Gera userId único para isolar estado no commandRateLimiter singleton.
 * @returns {string}
 */
function nextUserId() {
  return `c2s-user-${randomUUID().split('-')[0]}`
}

/**
 * Cria um mock de thread Discord para testes de criação de sessão.
 * @param {string} [id] - ID da thread
 * @returns {object}
 */
function createMockThread(id = 'thread-c2s-default') {
  return {
    id,
    name: 'test-thread',
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    setArchived: vi.fn().mockResolvedValue({}),
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    isThread: () => true,
  }
}

/**
 * Cria uma interação de slash command mock com canal capaz de criar threads.
 * @param {object} opts
 * @param {string} opts.commandName - Nome do comando
 * @param {string} [opts.userId] - ID do usuário (gerado automaticamente se omitido)
 * @param {object} [opts.options] - Valores de opções do comando
 * @param {string} [opts.channelId] - ID do canal
 * @param {object} [opts.thread] - Thread a ser retornada por channel.threads.create
 * @returns {object}
 */
function createInteraction({ commandName, userId = null, options = {}, channelId = 'channel-c2s', thread = null } = {}) {
  const uid = userId ?? nextUserId()
  const mockThread = thread ?? createMockThread(`thread-${randomUUID().split('-')[0]}`)

  const interaction = {
    commandName,
    channelId,
    guildId: 'guild-c2s',
    replied: false,
    deferred: false,
    user: { id: uid, username: 'testuser' },
    createdTimestamp: Date.now(),
    options: {
      getString: vi.fn((name) => options[name] ?? null),
      getBoolean: vi.fn((name) => options[name] ?? null),
      getInteger: vi.fn((name) => options[name] ?? null),
      getSubcommand: vi.fn(() => options._subcommand ?? null),
    },
    channel: {
      id: channelId,
      isThread: vi.fn().mockReturnValue(false),
      threads: { create: vi.fn().mockResolvedValue(mockThread) },
    },
    _thread: mockThread,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockImplementation(() => {
      interaction.deferred = true
      return Promise.resolve()
    }),
  }
  return interaction
}

/**
 * Cria um serverManager mock para injeção no SessionManager.
 * @returns {object}
 */
function createMockServerManager() {
  const server = {
    client: {
      createSession: vi.fn().mockResolvedValue({ id: 'api-c2s-sess-1' }),
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
 * Cria e injeta um OpenCodeSession pré-configurado diretamente no SessionManager.
 * Evita chamar session.start() para não precisar de I/O real.
 * @param {SessionManager} sm
 * @param {object} serverManager
 * @param {object} opts
 * @returns {OpenCodeSession}
 */
function injectSession(sm, serverManager, {
  sessionId = null,
  projectPath = '/projetos/app',
  threadId = 'thread-c2s-pre',
  userId,
  agent = 'plan',
} = {}) {
  const sid = sessionId ?? `sess-c2s-${randomUUID().split('-')[0]}`
  const session = new OpenCodeSession({ sessionId: sid, projectPath, threadId, userId, agent, model: '' })
  session.status = 'idle'
  session.apiSessionId = 'api-c2s-fake-1'
  session.server = serverManager._server
  sm._sessions.set(session.sessionId, session)
  sm._threadIndex.set(threadId, session.sessionId)
  return session
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Integração comando → sessão', () => {
  /** @type {ReturnType<createMockServerManager>} */
  let serverManager
  /** @type {SessionManager} */
  let sm

  beforeEach(() => {
    _resetProjectsCache()
    serverManager = createMockServerManager()
    sm = new SessionManager(serverManager)
  })

  afterEach(() => {
    if (sm._timeoutTimer) clearInterval(sm._timeoutTimer)
    vi.clearAllTimers()
    vi.restoreAllMocks()
  })

  // ─── /plan — fluxo de criação de sessão ──────────────────────────────────────

  describe('/plan', () => {
    it('com projeto válido: cria thread e confirma com editReply de sucesso', async () => {
      const interaction = createInteraction({ commandName: 'plan', options: { project: 'my-project' } })

      await handleCommand(interaction, sm, serverManager)

      // Deve ter criado uma thread via channel.threads.create
      expect(interaction.channel.threads.create).toHaveBeenCalledOnce()

      // A confirmação final deve conter a mensagem de sessão iniciada
      const replyArg = interaction.editReply.mock.calls.at(-1)?.[0]
      expect(typeof replyArg).toBe('string')
      expect(replyArg).toContain('✅ Sessão **plan** iniciada')
      expect(replyArg).toContain('my-project')
    })

    it('com projeto válido: registra a sessão no SessionManager com os dados corretos', async () => {
      const uid = nextUserId()
      const interaction = createInteraction({ commandName: 'plan', userId: uid, options: { project: 'my-project' } })

      await handleCommand(interaction, sm, serverManager)

      const thread = interaction._thread
      const session = sm.getByThread(thread.id)

      expect(session).toBeDefined()
      expect(session.agent).toBe('plan')
      expect(session.userId).toBe(uid)
      expect(session.projectPath).toBe('/projetos/my-project')
    })

    it('sem projeto com projetos disponíveis: exibe seletor de projetos', async () => {
      fsp.readdir.mockResolvedValue([
        { name: 'proj-a', isDirectory: () => true },
        { name: 'proj-b', isDirectory: () => true },
      ])
      const interaction = createInteraction({ commandName: 'plan', options: {} })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.editReply.mock.calls[0]?.[0]
      expect(replyArg).toBeDefined()
      const content = typeof replyArg === 'string' ? replyArg : replyArg?.content
      expect(content).toContain('/plan')
    })

    it('sem projeto e sem projetos disponíveis: informa ausência de projetos', async () => {
      fsp.readdir.mockResolvedValue([])
      const interaction = createInteraction({ commandName: 'plan', options: {} })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.editReply.mock.calls[0]?.[0]
      const content = typeof replyArg === 'string' ? replyArg : replyArg?.content
      expect(content).toContain('Nenhum projeto encontrado')
    })

    it('com projeto válido: envia embed inicial na thread recém-criada', async () => {
      const interaction = createInteraction({ commandName: 'plan', options: { project: 'meu-app' } })

      await handleCommand(interaction, sm, serverManager)

      const thread = interaction._thread
      // O embed inicial é enviado via thread.send
      expect(thread.send).toHaveBeenCalledOnce()
      const sentPayload = thread.send.mock.calls[0][0]
      expect(sentPayload).toHaveProperty('embeds')
      expect(sentPayload.embeds).toHaveLength(1)
    })
  })

  // ─── /stop — fluxo de encerramento ───────────────────────────────────────────

  describe('/stop', () => {
    it('com sessão na thread: exibe confirmação de encerramento com nome do projeto', async () => {
      const uid = nextUserId()
      const channelId = `channel-stop-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId: channelId, userId: uid, projectPath: '/projetos/minha-app' })
      const interaction = createInteraction({ commandName: 'stop', channelId, userId: uid })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.content).toContain('⚠️ Deseja encerrar')
      expect(replyArg?.content).toContain('minha-app')
    })

    it('com sessão na thread: inclui botões de confirmação e cancelamento', async () => {
      const uid = nextUserId()
      const channelId = `channel-stop-btns-${randomUUID().split('-')[0]}`
      injectSession(sm, serverManager, { threadId: channelId, userId: uid })
      const interaction = createInteraction({ commandName: 'stop', channelId, userId: uid })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.components).toBeDefined()
      expect(replyArg.components).toHaveLength(1)
    })

    it('sem sessão na thread: responde com erro informativo', async () => {
      const interaction = createInteraction({ commandName: 'stop', channelId: 'channel-empty-stop' })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.content).toContain('Nenhuma sessão ativa nesta thread')
    })
  })

  // ─── /passthrough — alternância de modo de passagem ──────────────────────────

  describe('/passthrough', () => {
    it('com passthrough ativado (padrão): desativa e confirma na resposta', async () => {
      const uid = nextUserId()
      const channelId = `channel-pt-off-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId: channelId, userId: uid })
      // Confirma que padrão é ativado
      expect(session.passthroughEnabled).toBe(true)

      const interaction = createInteraction({ commandName: 'passthrough', channelId, userId: uid })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.content).toContain('⏸️ Passthrough **desativado**')
      expect(session.passthroughEnabled).toBe(false)
    })

    it('com passthrough desativado: ativa e confirma na resposta', async () => {
      const uid = nextUserId()
      const channelId = `channel-pt-on-${randomUUID().split('-')[0]}`
      const session = injectSession(sm, serverManager, { threadId: channelId, userId: uid })
      session.passthroughEnabled = false

      const interaction = createInteraction({ commandName: 'passthrough', channelId, userId: uid })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.content).toContain('✅ Passthrough **ativado**')
      expect(session.passthroughEnabled).toBe(true)
    })

    it('sem sessão na thread: responde com erro informativo', async () => {
      const interaction = createInteraction({ commandName: 'passthrough', channelId: 'channel-empty-pt' })

      await handleCommand(interaction, sm, serverManager)

      const replyArg = interaction.reply.mock.calls[0]?.[0]
      expect(replyArg?.content).toContain('Nenhuma sessão ativa nesta thread')
    })
  })
})
