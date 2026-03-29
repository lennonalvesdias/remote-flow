// tests/integration/rate-limiting-flow.test.js
// Testa os comportamentos de rate limiting de comandos: bloqueio por usuário,
// isolamento entre usuários, reset por janela de tempo e métricas de estatísticas.
// Usa handleCommand e getRateLimitStats REAIS com o RateLimiter real;
// mocka apenas dependências externas de commands.js.

import { describe, it, expect, vi, afterEach } from 'vitest'

// ─── Mocks de módulos (hoisted pelo Vitest) ──────────────────────────────────
// Deve vir antes dos imports de commands.js para interceptar as dependências.
// discord.js e rate-limiter.js NÃO são mockados — são o objeto do teste.

vi.mock('../../src/config.js', () => ({
  ALLOWED_USERS: [],
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
  MAX_GLOBAL_SESSIONS: 0,
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
  readdir: vi.fn(),
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

// ─── Imports do módulo sob teste (após os mocks) ─────────────────────────────

import { handleCommand, getRateLimitStats } from '../../src/commands.js'

// ─── Factories de mocks ───────────────────────────────────────────────────────

/**
 * Cria um mock mínimo de SessionManager que retorna lista vazia de sessões.
 * Suficiente para o caminho handleListSessions (sem sessões ativas).
 * @returns {object}
 */
function createSessionManagerMock() {
  return {
    getAll: vi.fn().mockReturnValue([]),
    getByThread: vi.fn().mockReturnValue(null),
    getByUser: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(null),
    create: vi.fn(),
    destroy: vi.fn(),
  }
}

/**
 * Cria um mock mínimo de ChatInputCommandInteraction para o comando especificado.
 * Define createdTimestamp como Date.now() no momento da criação para garantir que
 * o guard de interação expirada (> 2500ms) não rejeite a interação prematuramente.
 * @param {{ userId: string, commandName: string }} opts
 * @returns {object}
 */
function createInteraction({ userId, commandName }) {
  return {
    commandName,
    createdTimestamp: Date.now(),
    user: { id: userId },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    guildId: 'guild-test',
    channelId: 'channel-test',
    channel: { id: 'channel-test' },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue(null),
    },
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Rate limiting de comandos', () => {
  // ─── 1. Primeiros 5 comandos são permitidos ──────────────────────────────────
  // Cada describe usa userId únicos para não contaminar o singleton commandRateLimiter.

  describe('Primeiros 5 comandos são permitidos', () => {
    it('5 chamadas consecutivas do mesmo usuário são todas respondidas normalmente', async () => {
      const userId = 'user-rl-allowed-1'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        const interaction = createInteraction({ userId, commandName: 'sessions' })
        await handleCommand(interaction, sm, null)

        // Cada chamada deve receber a resposta de sessões, não de rate limit
        expect(interaction.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: '📭 Nenhuma sessão ativa no momento.' })
        )
      }
    })

    it('nenhuma das 5 primeiras chamadas aciona mensagem de rate limit', async () => {
      const userId = 'user-rl-allowed-2'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        const interaction = createInteraction({ userId, commandName: 'sessions' })
        await handleCommand(interaction, sm, null)

        expect(interaction.reply).not.toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('Rate limit') })
        )
      }
    })
  })

  // ─── 2. 6º comando é bloqueado ────────────────────────────────────────────────

  describe('6º comando é bloqueado', () => {
    it('a 6ª chamada retorna mensagem de rate limit atingido', async () => {
      const userId = 'user-rl-blocked-1'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId, commandName: 'sessions' }), sm, null)
      }

      const blocked = createInteraction({ userId, commandName: 'sessions' })
      await handleCommand(blocked, sm, null)

      expect(blocked.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Rate limit atingido') })
      )
    })

    it('mensagem de bloqueio inclui tempo de retry em segundos', async () => {
      const userId = 'user-rl-blocked-2'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId, commandName: 'sessions' }), sm, null)
      }

      const blocked = createInteraction({ userId, commandName: 'sessions' })
      await handleCommand(blocked, sm, null)

      // Mensagem deve conter "Xs" indicando quantos segundos esperar
      expect(blocked.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringMatching(/\d+s\.?$/) })
      )
    })
  })

  // ─── 3. Isolamento entre usuários ────────────────────────────────────────────

  describe('Isolamento entre usuários', () => {
    it('usuário B não é afetado quando usuário A esgota o limite', async () => {
      const userA = 'user-rl-iso-a'
      const userB = 'user-rl-iso-b'
      const sm = createSessionManagerMock()

      // Esgota o limite para userA
      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId: userA, commandName: 'sessions' }), sm, null)
      }

      // userA está bloqueado na 6ª chamada
      const blockedA = createInteraction({ userId: userA, commandName: 'sessions' })
      await handleCommand(blockedA, sm, null)
      expect(blockedA.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Rate limit atingido') })
      )

      // userB ainda pode usar o comando normalmente
      const allowedB = createInteraction({ userId: userB, commandName: 'sessions' })
      await handleCommand(allowedB, sm, null)
      expect(allowedB.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '📭 Nenhuma sessão ativa no momento.' })
      )
    })

    it('múltiplos usuários têm contadores de rate limit independentes', async () => {
      const sm = createSessionManagerMock()
      const users = ['user-rl-multi-1', 'user-rl-multi-2', 'user-rl-multi-3']

      // Cada usuário faz 3 chamadas (abaixo do limite de 5) — todos devem ser permitidos
      for (const userId of users) {
        for (let i = 0; i < 3; i++) {
          const interaction = createInteraction({ userId, commandName: 'sessions' })
          await handleCommand(interaction, sm, null)
          expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: '📭 Nenhuma sessão ativa no momento.' })
          )
        }
      }
    })
  })

  // ─── 4. Reset após janela de tempo ───────────────────────────────────────────

  describe('Reset após janela de tempo', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('7ª chamada é permitida após a janela de 60s expirar', async () => {
      vi.useFakeTimers()
      // Define tempo fixo para isolar completamente timestamps de outros testes
      vi.setSystemTime(new Date('2030-06-01T12:00:00.000Z'))

      const userId = 'user-rl-reset-1'
      const sm = createSessionManagerMock()

      // Esgota o limite (5 chamadas)
      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId, commandName: 'sessions' }), sm, null)
      }

      // 6ª chamada é bloqueada
      const blocked = createInteraction({ userId, commandName: 'sessions' })
      await handleCommand(blocked, sm, null)
      expect(blocked.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Rate limit atingido') })
      )

      // Avança 61s para garantir que a janela de 60s expirou
      vi.advanceTimersByTime(61_000)

      // A 7ª chamada deve ser permitida após o reset (nova interação com timestamp atualizado)
      const allowed = createInteraction({ userId, commandName: 'sessions' })
      await handleCommand(allowed, sm, null)
      expect(allowed.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '📭 Nenhuma sessão ativa no momento.' })
      )
    })
  })

  // ─── 5. getRateLimitStats() ───────────────────────────────────────────────────
  // Usa datas de sistema distintas e muito no futuro para isolar o estado
  // do singleton commandRateLimiter que persiste entre os testes do arquivo.

  describe('getRateLimitStats()', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('retorna shape correto com blockedLastMinute como número', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'))

      const stats = getRateLimitStats()

      expect(stats).toHaveProperty('blockedLastMinute')
      expect(typeof stats.blockedLastMinute).toBe('number')
    })

    it('retorna 0 bloqueados quando nenhum usuário atingiu o limite nesta janela', () => {
      // Data muito no futuro — todos os timestamps de testes anteriores estão expirados
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2031-01-15T00:00:00.000Z'))

      const stats = getRateLimitStats()

      expect(stats.blockedLastMinute).toBe(0)
    })

    it('conta 1 usuário bloqueado após atingir 5 ações', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2031-02-01T00:00:00.000Z'))

      const userId = 'user-stats-blocked-a'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId, commandName: 'sessions' }), sm, null)
      }

      expect(getRateLimitStats().blockedLastMinute).toBe(1)
    })

    it('retorna 0 bloqueados após a janela de 60s expirar', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2031-03-01T00:00:00.000Z'))

      const userId = 'user-stats-expire-a'
      const sm = createSessionManagerMock()

      for (let i = 0; i < 5; i++) {
        await handleCommand(createInteraction({ userId, commandName: 'sessions' }), sm, null)
      }

      // Usuário está bloqueado antes de expirar
      expect(getRateLimitStats().blockedLastMinute).toBe(1)

      // Avança 65s para expirar todos os timestamps da janela
      vi.advanceTimersByTime(65_000)

      expect(getRateLimitStats().blockedLastMinute).toBe(0)
    })
  })
})
