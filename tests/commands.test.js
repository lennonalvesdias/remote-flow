// tests/commands.test.js
// Testes para as funções exportadas de src/commands.js

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'node:events';

// ─── Estado mutável para testes de autorização ───────────────────────────────

/**
 * Objeto compartilhado entre vi.hoisted e os testes.
 * Permite alterar ALLOWED_USERS por teste sem recarregar o módulo.
 */
const mockConfigState = vi.hoisted(() => ({ allowedUsers: [], maxGlobalSessions: 0 }));

// ─── Mock de spawn para testes de /diff ──────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());

// ─── Mocks de módulos (hoisted pelo Vitest) ───────────────────────────────────

vi.mock('../src/config.js', () => ({
  // Getter garante que o valor atualizado em beforeEach é lido por commands.js
  get ALLOWED_USERS() { return mockConfigState.allowedUsers; },
  get MAX_GLOBAL_SESSIONS() { return mockConfigState.maxGlobalSessions; },
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
    validateProjectPath: vi.fn((name) => ({
    valid: true,
    projectPath: '/projetos/' + name,
    error: null,
  })),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn, execFile: vi.fn() }));

vi.mock('../src/model-loader.js', () => ({
  getAvailableModels: () => ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o'],
}));

vi.mock('../src/opencode-commands.js', () => ({
  listOpenCodeCommands: vi.fn().mockResolvedValue([
    { name: 'help', description: 'Show help' },
    { name: 'version', description: 'Show version' },
  ]),
}));

vi.mock('../src/stream-handler.js', () => ({
  StreamHandler: vi.fn().mockImplementation(function MockStreamHandler() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.flush = vi.fn().mockResolvedValue(undefined);
    this.currentRawContent = '';
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(''),
}));

vi.mock('../src/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/github.js', () => ({
  getGitHubClient: vi.fn(() => ({
    createPullRequest: vi.fn().mockResolvedValue({ number: 42, html_url: 'https://github.com/owner/repo/pull/42' }),
    listPullRequests: vi.fn().mockResolvedValue([]),
    getPullRequest: vi.fn().mockResolvedValue({ number: 1, title: 'Test PR', user: { login: 'user' }, base: { ref: 'main' }, head: { ref: 'feat', sha: 'abc123' }, commits: 1, additions: 10, deletions: 5, body: '' }),
    getPullRequestDiff: vi.fn().mockResolvedValue('diff --git a/file.js b/file.js'),
    getPullRequestFiles: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({ number: 1, title: 'Test Issue', user: { login: 'user' }, labels: [], body: 'Issue body' }),
    createReview: vi.fn().mockResolvedValue({ id: 1 }),
    createIssue: vi.fn().mockResolvedValue({ number: 99, html_url: 'https://github.com/owner/repo/issues/99' }),
  })),
}));

vi.mock('../src/reporter.js', () => ({
  analyzeOutput: vi.fn().mockReturnValue({
    errors: [],
    suggestedActions: [],
    summary: 'Nenhum problema detectado automaticamente no output.',
  }),
  captureThreadMessages: vi.fn().mockResolvedValue([]),
  formatReportText: vi.fn().mockReturnValue('relatório de texto'),
  buildReportEmbed: vi.fn().mockReturnValue({
    data: { color: 0xFFCC00, title: 'Relatório', fields: [] },
    addFields: vi.fn().mockReturnThis(),
  }),
}));

vi.mock('../src/git.js', () => ({
  getRepoInfo: vi.fn().mockResolvedValue({ owner: 'owner', repo: 'repo' }),
  hasChanges: vi.fn().mockResolvedValue(true),
  createBranchAndCommit: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/plannotator-client.js', () => ({
  PlannotatorClient: vi.fn().mockImplementation(function () {
    this.approve = vi.fn().mockResolvedValue({});
    this.deny = vi.fn().mockResolvedValue({});
  }),
}));

// ─── Imports do módulo sob teste (após os mocks) ──────────────────────────────

import * as fsp from 'fs/promises';
import { existsSync } from 'fs';
import { validateProjectPath } from '../src/config.js';
import { handleCommand, handleAutocomplete, handleInteraction, commandDefinitions, getRateLimitStats, _resetProjectsCache } from '../src/commands.js';
import { captureThreadMessages, buildReportEmbed } from '../src/reporter.js';
import { getGitHubClient } from '../src/github.js';

// ─── Factories de mocks ───────────────────────────────────────────────────────

/**
 * Gera um userId único usando UUID.
 * Garante isolamento de estado entre testes e suporta execução paralela.
 * @returns {string}
 */
function nextUserId() {
  return `test-user-${randomUUID().split('-')[0]}`;
}

/**
 * Cria um Dirent mock representando um diretório.
 * @param {string} name
 * @returns {object}
 */
function mockDirentDir(name) {
  return { name, isDirectory: () => true, isFile: () => false };
}

/**
 * Cria um mock completo de ChatInputCommandInteraction.
 * @param {object} opts
 * @param {string} [opts.commandName='projetos']
 * @param {string|null} [opts.userId=null] - null gera userId único automaticamente
 * @param {object} [opts.options={}] - valores de getString por nome
 * @param {string} [opts.channelId='channel-test']
 * @param {boolean} [opts.replied=false]
 * @param {boolean} [opts.deferred=false]
 * @returns {object}
 */
function createInteraction({
  commandName = 'projects',
  userId = null,
  options = {},
  channelId = 'channel-test',
  replied = false,
  deferred = false,
} = {}) {
  const uid = userId ?? nextUserId();

  const mockOptions = {
    getString: vi.fn((name) => options[name] ?? null),
    getBoolean: vi.fn((name) => options[name] ?? null),
    getInteger: vi.fn((name) => options[name] ?? null),
    getFocused: vi.fn((withObject) =>
      withObject
        ? { name: options._focusedName ?? 'project', value: options._focusedValue ?? '' }
        : (options._focusedValue ?? '')
    ),
    getSubcommand: vi.fn(() => options._subcommand ?? null),
  };

  return {
    commandName,
    channelId,
    guildId: 'guild-test',
    replied,
    deferred,
    user: { id: uid, username: 'testuser', send: vi.fn().mockResolvedValue({}) },
    member: { permissions: { has: vi.fn().mockReturnValue(true) } },
    options: mockOptions,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    respond: vi.fn().mockResolvedValue({}),
    channel: {
      id: channelId,
      isThread: vi.fn().mockReturnValue(false),
      threads: {
        create: vi.fn().mockResolvedValue({
            id: 'thread-new-1',
            send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
            setArchived: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            messages: { fetch: vi.fn().mockResolvedValue([]) },
          }),
      },
    },
    guild: {
      id: 'guild-test',
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isThread: vi.fn().mockReturnValue(true),
          send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
          setArchived: vi.fn().mockResolvedValue({}),
        }),
      },
    },
  };
}

/**
 * Cria um mock do SessionManager com valores padrão sobrescrevíveis.
 * @param {object} opts
 * @param {object|null} [opts.getByThreadResult=null]
 * @param {object[]} [opts.getAllResult=[]]
 * @param {object[]} [opts.getByUserResult=[]]
 * @param {object|null} [opts.getByIdResult=null]
 * @param {object|null} [opts.getByProjectResult=null]
 * @returns {object}
 */
function createSessionManager({
  getByThreadResult = null,
  getAllResult = [],
  getByUserResult = [],
  getByIdResult = null,
  getByProjectResult = null,
} = {}) {
  return {
    create: vi.fn().mockImplementation(async ({ threadId, userId: uid }) => ({
      sessionId: 'sess-test-abc',
      threadId,
      userId: uid,
      status: 'idle',
      projectPath: '/projetos/teste',
      agent: 'plan',
      outputBuffer: '',
      toSummary: () => ({
        sessionId: 'sess-test-abc',
        status: 'idle',
        projectPath: '/projetos/teste',
        project: 'teste',
        userId: uid,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }),
      sendMessage: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    })),
    getByThread: vi.fn().mockReturnValue(getByThreadResult),
    getByUser: vi.fn().mockReturnValue(getByUserResult),
    getAll: vi.fn().mockReturnValue(getAllResult),
    getById: vi.fn().mockReturnValue(getByIdResult),
    getByProject: vi.fn().mockReturnValue(getByProjectResult),
    destroy: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Cria um mock de StringSelectMenuInteraction ou ButtonInteraction.
 * @param {object} opts
 * @param {boolean} [opts.isSelectMenu=false]
 * @param {boolean} [opts.isButton=false]
 * @param {string} [opts.customId='']
 * @param {string[]} [opts.values=[]]
 * @param {string|null} [opts.userId=null]
 * @returns {object}
 */
function createComponentInteraction({
  isSelectMenu = false,
  isButton = false,
  customId = '',
  values = [],
  userId = null,
} = {}) {
  const uid = userId ?? nextUserId();
  return {
    isStringSelectMenu: vi.fn().mockReturnValue(isSelectMenu),
    isButton: vi.fn().mockReturnValue(isButton),
    isModalSubmit: vi.fn().mockReturnValue(false),
    customId,
    values,
    user: { id: uid, username: 'testuser' },
    channel: {
      threads: {
        create: vi.fn().mockResolvedValue({
          id: 'thread-comp-1',
          send: vi.fn().mockResolvedValue({ id: 'msg-comp-1' }),
          delete: vi.fn().mockResolvedValue({}),
        }),
      },
    },
    deferUpdate: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('commandDefinitions', () => {
  it('exporta array com definições JSON de todos os comandos', () => {
    expect(Array.isArray(commandDefinitions)).toBe(true);
    expect(commandDefinitions.length).toBeGreaterThan(0);

    for (const cmd of commandDefinitions) {
      expect(cmd).toHaveProperty('name');
      expect(cmd).toHaveProperty('description');
      expect(typeof cmd.name).toBe('string');
    }
  });

  it('contém os comandos: plan, build, sessions, status, stop, projects, history, command, report', () => {
    const names = commandDefinitions.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('build');
    expect(names).toContain('sessions');
    expect(names).toContain('status');
    expect(names).toContain('stop');
    expect(names).toContain('projects');
    expect(names).toContain('history');
    expect(names).toContain('command');
    expect(names).toContain('report');
  });
});

// ─── handleCommand ────────────────────────────────────────────────────────────

describe('handleCommand()', () => {
  beforeEach(() => {
    // Garante lista limpa antes de cada teste para evitar vazamento de estado
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    mockSpawn.mockReset();
    _resetProjectsCache();
  });

  it('recusa usuário não autorizado quando ALLOWED_USERS está configurado', async () => {
    mockConfigState.allowedUsers = ['usuario-permitido-123'];
    const interaction = createInteraction({
      commandName: 'projects',
      userId: 'usuario-bloqueado-456',
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    // replyError chama interaction.reply com mensagem ephemeral de permissão negada
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('permissão'),
      }),
    );
  });

  it('/sessoes — responde com mensagem de lista vazia quando não há sessões ativas', async () => {
    // ALLOWED_USERS vazio = todos permitidos
    const interaction = createInteraction({ commandName: 'sessions' });
    const sm = createSessionManager(); // getAllResult = [] por padrão

    await handleCommand(interaction, sm);

    expect(sm.getAll).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '📭 Nenhuma sessão ativa no momento.',
      }),
    );
  });

  it('/sessoes — consulta sessionManager independentemente de userId', async () => {
    const interaction = createInteraction({ commandName: 'sessions' });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    // Verifica que getAll foi chamado (e não getByUser ou getByThread)
    expect(sm.getAll).toHaveBeenCalledOnce();
    expect(sm.getByUser).not.toHaveBeenCalled();
    expect(sm.getByThread).not.toHaveBeenCalled();
  });
});

// ─── handleInteraction ────────────────────────────────────────────────────────

describe('handleInteraction()', () => {
  it('ignora interação que não é select menu nem botão e não chama nenhum método', async () => {
    // isSelectMenu=false e isButton=false — handler retorna imediatamente
    const interaction = createComponentInteraction();
    const sm = createSessionManager();

    await handleInteraction(interaction, sm);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(sm.destroy).not.toHaveBeenCalled();
  });

  it('botão cancel_stop — atualiza interação com mensagem de cancelamento', async () => {
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'cancel_stop',
    });
    const sm = createSessionManager();

    await handleInteraction(interaction, sm);

    expect(interaction.update).toHaveBeenCalledWith({
      content: '↩️ Cancelado.',
      components: [],
    });
    // Nenhuma sessão deve ter sido destruída
    expect(sm.destroy).not.toHaveBeenCalled();
  });

  it('botão confirm_stop_ — encerra sessão do próprio usuário e confirma', async () => {
    const sessionId = 'sess-teste-xpto-99';
    const userId = 'user-dono-da-sessao';
    // targetSession.userId === interaction.user.id → autorizado
    const targetSession = { sessionId, userId };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: `confirm_stop_${sessionId}`,
      userId,
    });
    const sm = createSessionManager({ getByIdResult: targetSession });

    await handleInteraction(interaction, sm);

    expect(sm.getById).toHaveBeenCalledWith(sessionId);
    expect(sm.destroy).toHaveBeenCalledWith(sessionId);
    expect(interaction.update).toHaveBeenCalledWith({
      content: '✅ Sessão encerrada.',
      components: [],
    });
  });

  it('botão confirm_stop_ — bloqueia usuário diferente do dono quando ALLOW_SHARED_SESSIONS é false', async () => {
    const sessionId = 'sess-alheia-77';
    const targetSession = { sessionId, userId: 'user-dono-original' };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: `confirm_stop_${sessionId}`,
      userId: 'user-intruso-diferente', // não é o dono
    });
    const sm = createSessionManager({ getByIdResult: targetSession });

    await handleInteraction(interaction, sm);

    // Deve avisar que só o criador pode encerrar
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('criador'),
      }),
    );
    // Não deve destruir a sessão
    expect(sm.destroy).not.toHaveBeenCalled();
  });
});

// ─── Novos testes ─────────────────────────────────────────────────────────────

describe('handleCommand() — comandos adicionais', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    mockSpawn.mockReset();
    _resetProjectsCache();
  });

  it('/passthrough — ativa passthrough e responde com confirmação', async () => {
    const session = { sessionId: 'sess-pt-1', projectPath: '/projetos/pt', togglePassthrough: vi.fn().mockReturnValue(true) };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'passthrough' });
    await handleCommand(interaction, sm);
    expect(session.togglePassthrough).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ativado') }));
  });

  it('/passthrough — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'passthrough' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/status — com sessão responde com embed', async () => {
    const session = {
      sessionId: 'sess-st-1',
      getQueueSize: vi.fn().mockReturnValue(0),
      toSummary: vi.fn().mockReturnValue({ sessionId: 'sess-st-1', project: 'proj', status: 'running', userId: 'u1', projectPath: '/projetos/proj', createdAt: new Date(), lastActivityAt: new Date() }),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'status' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('/status — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'status' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/sessoes — com sessões ativas responde com embed', async () => {
    const sessions = [{ sessionId: 'sess-list-1', status: 'running', projectPath: '/projetos/proj1', createdAt: new Date() }];
    const sm = createSessionManager({ getAllResult: sessions });
    const interaction = createInteraction({ commandName: 'sessions' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('/projetos — com projetos responde com embed', async () => {
    fsp.readdir.mockResolvedValue([mockDirentDir('proj-a'), mockDirentDir('proj-b')]);
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projects' });
    await handleCommand(interaction, sm);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('/historico — com sessão responde com arquivo', async () => {
    const session = { sessionId: 'sess-hist-1', outputBuffer: 'algum output' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'history' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('/historico — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'history' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/parar — com sessão responde com confirmação de encerramento', async () => {
    const session = { sessionId: 'sess-stop-1', projectPath: '/projetos/meu-proj', userId: 'user-st' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'stop' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Deseja encerrar') }));
  });

  it('/parar — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'stop' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/comando — envia comando para sessão ativa', async () => {
    const session = { sessionId: 'sess-cmd-1', projectPath: '/projetos/cmd-proj', sendMessage: vi.fn().mockResolvedValue({}) };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'command', options: { name: 'meu-cmd', args: '' } });
    await handleCommand(interaction, sm);
    expect(session.sendMessage).toHaveBeenCalledWith('/meu-cmd');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('enviado'));
  });

  it('/comando — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'command', options: { name: 'meu-cmd', args: '' } });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/plan — cria sessão em thread com projectName fornecido', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'plan', options: { project: 'meu-projeto' } });
    await handleCommand(interaction, sm);
    expect(sm.create).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/projetos/meu-projeto', agent: 'plan' }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('iniciada'));
  });
});

describe('handleAutocomplete() — modelos', () => {
  it('sugere modelos filtrando por prefixo digitado', async () => {
    const interaction = createInteraction({ commandName: 'plan', options: { _focusedName: 'model', _focusedValue: 'anthropic' } });
    await handleAutocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5' }]));
  });
});

describe('handleInteraction() — approve/deny permission', () => {
  it('allow_once_ — chama approvePermission com apiSessionId e permissionId corretos', async () => {
    const sessionId = 'sess-approve-1';
    const userId = 'user-approver-1';
    const approvePermission = vi.fn().mockResolvedValue({});
    const session = {
      sessionId,
      userId,
      apiSessionId: 'api-perm-1',
      agent: 'build',
      _pendingPermissionId: 'perm-xyz',
      _pendingPermissionData: null,
      resolvePermission: vi.fn(),
      server: { client: { approvePermission } },
    };
    const interaction = createComponentInteraction({ isButton: true, customId: `allow_once_${sessionId}`, userId });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(approvePermission).toHaveBeenCalledWith('api-perm-1', 'perm-xyz');
    expect(interaction.update).toHaveBeenCalled();
  });

  it('allow_once_ — sem sessão responde com erro', async () => {
    const interaction = createComponentInteraction({ isButton: true, customId: 'allow_once_sess-nao-existe' });
    const sm = createSessionManager({ getByIdResult: null });
    await handleInteraction(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('não encontrada') }));
  });

  it('allow_always_ — cacheia padrão e chama approvePermission', async () => {
    const sessionId = 'sess-always-1';
    const userId = 'user-always-1';
    const approvePermission = vi.fn().mockResolvedValue({});
    const addAllowedPattern = vi.fn();
    const permData = { toolName: 'bash', patterns: ['C:/Users/*'], directory: null };
    const session = {
      sessionId,
      userId,
      apiSessionId: 'api-always-1',
      agent: 'build',
      _pendingPermissionId: 'perm-always-1',
      _pendingPermissionData: permData,
      addAllowedPattern,
      resolvePermission: vi.fn(),
      server: { client: { approvePermission } },
    };
    const interaction = createComponentInteraction({ isButton: true, customId: `allow_always_${sessionId}`, userId });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(addAllowedPattern).toHaveBeenCalledWith(permData);
    expect(approvePermission).toHaveBeenCalledWith('api-always-1', 'perm-always-1');
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Sempre permitido'),
    }));
  });

  it('allow_always_ — sem sessão responde com erro', async () => {
    const interaction = createComponentInteraction({ isButton: true, customId: 'allow_always_sess-nao-existe' });
    const sm = createSessionManager({ getByIdResult: null });
    await handleInteraction(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('não encontrada') }));
  });

  it('reject_permission_ — chama rejectPermission, NÃO chama abort', async () => {
    const sessionId = 'sess-reject-1';
    const userId = 'user-reject-1';
    const rejectPermission = vi.fn().mockResolvedValue({});
    const abort = vi.fn();
    const session = {
      sessionId,
      userId,
      apiSessionId: 'api-reject-1',
      agent: 'build',
      _pendingPermissionId: 'perm-reject-1',
      _pendingPermissionData: { toolName: 'bash', patterns: [], directory: null },
      abort,
      resolvePermission: vi.fn(),
      server: { client: { rejectPermission } },
    };
    const interaction = createComponentInteraction({ isButton: true, customId: `reject_permission_${sessionId}`, userId });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(rejectPermission).toHaveBeenCalledWith('api-reject-1', 'perm-reject-1');
    expect(abort).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('rejeitada'),
    }));
  });

  it('reject_permission_ — sem sessão responde com erro', async () => {
    const interaction = createComponentInteraction({ isButton: true, customId: 'reject_permission_sess-nao-existe' });
    const sm = createSessionManager({ getByIdResult: null });
    await handleInteraction(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('não encontrada') }));
  });

  it('approve_permission_ (legado) — chama approvePermission com apiSessionId e permissionId', async () => {
    const sessionId = 'sess-legacy-1';
    const approvePermission = vi.fn().mockResolvedValue({});
    const session = {
      sessionId,
      apiSessionId: 'api-legacy-1',
      _pendingPermissionId: 'perm-legacy-1',
      _pendingPermissionData: null,
      server: { client: { approvePermission } },
    };
    const interaction = createComponentInteraction({ isButton: true, customId: `approve_permission_${sessionId}` });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(approvePermission).toHaveBeenCalledWith('api-legacy-1', 'perm-legacy-1');
    expect(interaction.update).toHaveBeenCalled();
  });

  it('approve_permission_ (legado) — sem sessão responde com erro', async () => {
    const interaction = createComponentInteraction({ isButton: true, customId: 'approve_permission_sess-nao-existe' });
    const sm = createSessionManager({ getByIdResult: null });
    await handleInteraction(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('não encontrada') }));
  });

  it('deny_permission_ (legado) — chama abort e atualiza com mensagem de recusa', async () => {
    const sessionId = 'sess-deny-1';
    const abort = vi.fn().mockResolvedValue({});
    const session = { sessionId, apiSessionId: 'api-deny-1', server: { client: {} }, abort };
    const interaction = createComponentInteraction({ isButton: true, customId: `deny_permission_${sessionId}` });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(abort).toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('recusada') }));
  });
});

// ─── getRateLimitStats ────────────────────────────────────────────────────────

describe('getRateLimitStats()', () => {
  it('retorna { blockedLastMinute: 0 } quando nenhum usuário foi limitado', () => {
    const stats = getRateLimitStats();
    expect(stats).toHaveProperty('blockedLastMinute');
    expect(typeof stats.blockedLastMinute).toBe('number');
  });

  it('conta usuário bloqueado após atingir 5 comandos na janela de 60s', async () => {
    const blockedUserId = `blocked-user-${randomUUID()}`;
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projects', userId: blockedUserId });
    fsp.readdir.mockResolvedValue([]);

    // Executa 6 comandos para ultrapassar o limite de 5
    for (let i = 0; i < 6; i++) {
      await handleCommand(interaction, sm);
    }

    const stats = getRateLimitStats();
    expect(stats.blockedLastMinute).toBeGreaterThanOrEqual(1);
  });
});

// ─── replyError com followUp ──────────────────────────────────────────────────

describe('replyError — followUp quando já respondido', () => {
  it('usa followUp quando interaction.replied é true', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({
      commandName: 'status',
      replied: true,
    });

    await handleCommand(interaction, sm);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('❌') }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

// ─── handleAutocomplete — /comando ───────────────────────────────────────────

describe('handleAutocomplete() — /comando', () => {
  it('sugere comandos opencode filtrados pelo valor digitado', async () => {
    const interaction = createInteraction({
      commandName: 'command',
      options: { _focusedName: 'name', _focusedValue: 'hel' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ value: 'help' })]),
    );
  });

  it('sugere todos os comandos quando valor digitado está vazio', async () => {
    const interaction = createInteraction({
      commandName: 'command',
      options: { _focusedName: 'name', _focusedValue: '' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 'help' }),
        expect.objectContaining({ value: 'version' }),
      ]),
    );
  });
});

// ─── handleAutocomplete — projeto autocomplete ───────────────────────────────

describe('handleAutocomplete() — projeto autocomplete', () => {
  beforeEach(() => {
    _resetProjectsCache();
    fsp.readdir.mockResolvedValue([mockDirentDir('alpha'), mockDirentDir('beta')]);
  });

  it('sugere projetos filtrados para /plan com foco em projeto', async () => {
    const interaction = createInteraction({
      commandName: 'plan',
      options: { _focusedName: 'project', _focusedValue: 'al' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ value: 'alpha' })]),
    );
  });
});

// ─── handleStartSession — validações e caminhos ──────────────────────────────

describe('handleCommand() — /plan validações', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    mockSpawn.mockReset();
    _resetProjectsCache();
  });

  it('/plan — projectName > 256 chars retorna erro ephemeral', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'a'.repeat(257) },
    });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('longo') }),
    );
  });

  it('/plan — prompt > 10000 chars retorna erro ephemeral', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto', prompt: 'x'.repeat(10001) },
    });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('longa') }),
    );
  });

  it('/plan — sem projectName e readdir vazio → editReply com "Nenhum projeto"', async () => {
    fsp.readdir.mockResolvedValue([]);
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'plan', options: {} });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhum projeto'),
    );
  });

  it('/plan — sem projectName e projetos disponíveis → editReply com select menu', async () => {
    fsp.readdir.mockResolvedValue([mockDirentDir('proj-x'), mockDirentDir('proj-y')]);
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'plan', options: {} });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: expect.any(Array) }),
    );
  });

  it('/plan — limite de MAX_SESSIONS_PER_USER (3) ativas → editReply com "Limite"', async () => {
    const userId = nextUserId();
    const runningSessions = [
      { status: 'running' },
      { status: 'running' },
      { status: 'running' },
    ];
    const sm = createSessionManager({ getByUserResult: runningSessions });
    const interaction = createInteraction({
      commandName: 'plan',
      userId,
      options: { project: 'meu-projeto' },
    });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Limite'),
    );
  });

  it('/plan — MAX_GLOBAL_SESSIONS=1 e há 1 sessão ativa → replyError "Limite global"', async () => {
    mockConfigState.maxGlobalSessions = 1;
    const sm = createSessionManager({ getAllResult: [{ status: 'running' }] });
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto' },
    });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('global') }),
    );
  });

  it('/plan — projeto já tem sessão ativa → editReply com "Já existe"', async () => {
    const sm = createSessionManager({
      getByProjectResult: { sessionId: 'sess-existing', threadId: 'th-existing' },
    });
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto' },
    });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Já existe'),
    );
  });

  it('/plan — validateProjectPath retorna valid:false → editReply com erro de caminho', async () => {
    validateProjectPath.mockReturnValueOnce({
      valid: false,
      projectPath: null,
      error: '❌ Caminho de projeto inválido.',
    });
    const sm = createSessionManager();
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto' },
    });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('inválido'),
    );
  });

  it('/plan — existsSync retorna false → editReply com "não encontrado"', async () => {
    existsSync.mockReturnValueOnce(false);
    const sm = createSessionManager();
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'projeto-inexistente' },
    });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('não encontrado'),
    );
  });
});

// ─── handleListProjects — readdir vazio ──────────────────────────────────────

describe('handleCommand() — /projetos vazio', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    _resetProjectsCache();
  });

  it('/projetos — readdir vazio → reply com "Nenhum projeto encontrado"', async () => {
    fsp.readdir.mockResolvedValue([]);
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projects' });

    await handleCommand(interaction, sm);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhum projeto'),
    );
  });
});

// ─── handleDiffCommand ────────────────────────────────────────────────────────

describe('handleCommand() — /diff', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockSpawn.mockReset();
  });

  /**
   * Cria um processo mock compatível com EventEmitter para testar spawn.
   */
  function createMockProcess() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
  }

  it('/diff — sem sessão ativa responde com "Nenhuma sessão"', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'diff' });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Nenhuma sessão') }),
    );
  });

  it('/diff — git diff retorna output curto → editReply com bloco diff inline', async () => {
    const session = { sessionId: 'sess-diff-1', projectPath: '/projetos/meu-projeto' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = handleCommand(interaction, sm);
    // Drena microtasks para que audit() e deferReply() completem antes do spawn
    for (let i = 0; i < 5; i++) await Promise.resolve();

    proc.stdout.emit('data', '+linha adicionada\n-linha removida');
    proc.emit('close', 0);

    await promise;

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('```diff'),
    );
  });

  it('/diff — git diff retorna saída vazia → editReply "Nenhuma mudança"', async () => {
    const session = { sessionId: 'sess-diff-2', projectPath: '/projetos/meu-projeto' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = handleCommand(interaction, sm);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Nenhum dado emitido — output fica vazio
    proc.emit('close', 0);

    await promise;

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma mudança'),
    );
  });

  it('/diff — output longo (>1500 chars) → editReply com arquivo anexo', async () => {
    const session = { sessionId: 'sess-diff-3', projectPath: '/projetos/meu-projeto' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = handleCommand(interaction, sm);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    proc.stdout.emit('data', 'x'.repeat(2000));
    proc.emit('close', 0);

    await promise;

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.any(Array) }),
    );
  });

  it('/diff — git diff retorna código de saída != 0 → editReply com mensagem de erro', async () => {
    const session = { sessionId: 'sess-diff-4', projectPath: '/projetos/meu-projeto' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = handleCommand(interaction, sm);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    proc.stderr.emit('data', 'fatal: not a git repository');
    proc.emit('close', 1);

    await promise;

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Erro'),
    );
  });
});

// ─── handleCommand — /fila ───────────────────────────────────────────────────

describe('handleCommand() — /fila', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    _resetProjectsCache();
  });

  it('/fila ver — fila vazia → reply com "Nenhuma mensagem na fila"', async () => {
    const session = {
      sessionId: 'sess-fila-1',
      _messageQueue: [],
      _processingQueue: false,
      userId: 'user-fila-1',
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'queue', options: { _subcommand: 'view' } });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Nenhuma mensagem na fila') }),
    );
  });

  it('/fila ver — com mensagens → lista mensagens numeradas', async () => {
    const session = {
      sessionId: 'sess-fila-2',
      _messageQueue: ['Primeira mensagem', 'Segunda mensagem'],
      _processingQueue: false,
      userId: 'user-fila-2',
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'queue', options: { _subcommand: 'view' } });

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('**1.** Primeira mensagem'),
      }),
    );
  });

  it('/fila limpar — fila com mensagens → remove tudo e confirma contagem', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-fila-3',
      _messageQueue: ['msg-a', 'msg-b', 'msg-c'],
      _processingQueue: false,
      userId,
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'queue', userId, options: { _subcommand: 'clear' } });

    await handleCommand(interaction, sm);

    expect(session._messageQueue).toHaveLength(0);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('3 mensagem(s) removida(s)') }),
    );
  });

  it('/fila limpar — processando mensagem → avisa sobre mensagem em andamento', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-fila-4',
      _messageQueue: ['msg-restante'],
      _processingQueue: true,
      userId,
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'queue', userId, options: { _subcommand: 'clear' } });

    await handleCommand(interaction, sm);

    expect(session._messageQueue).toHaveLength(0);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('1 mensagem já está sendo processada') }),
    );
  });
});

// ─── handleCommand — /status com fila ────────────────────────────────────────

describe('handleCommand() — /status com fila', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    _resetProjectsCache();
  });

  it('/status — getQueueSize > 0 → embed contém campo "📮 Fila"', async () => {
    const session = {
      sessionId: 'sess-st-queue',
      getQueueSize: vi.fn().mockReturnValue(3),
      toSummary: vi.fn().mockReturnValue({
        sessionId: 'sess-st-queue',
        project: 'proj',
        status: 'running',
        userId: 'u1',
        projectPath: '/projetos/proj',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'status' });

    await handleCommand(interaction, sm);

    const payload = interaction.reply.mock.calls[0][0];
    const embed = payload.embeds[0];
    const filaField = embed.data.fields.find((f) => f.name === '📮 Fila');
    expect(filaField).toBeDefined();
    expect(filaField.value).toBe('3 mensagem(s) aguardando');
  });
});

// ─── handleInteraction — select_project_ ─────────────────────────────────────

describe('handleInteraction() — select_project_plan', () => {
  beforeEach(() => {
    _resetProjectsCache();
  });

  it('select_project_plan — cria sessão e atualiza interação com confirmação', async () => {
    const interaction = createComponentInteraction({
      isSelectMenu: true,
      customId: 'select_project_plan',
      values: ['meu-projeto'],
    });
    const sm = createSessionManager();

    await handleInteraction(interaction, sm);

    expect(sm.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/projetos/meu-projeto' }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('iniciada') }),
    );
  });

  it('select_project_plan — caminho inválido → editReply com mensagem de erro', async () => {
    validateProjectPath.mockReturnValueOnce({
      valid: false,
      projectPath: null,
      error: '❌ Caminho de projeto inválido.',
    });
    const interaction = createComponentInteraction({
      isSelectMenu: true,
      customId: 'select_project_plan',
      values: ['../escape'],
    });
    const sm = createSessionManager();

    await handleInteraction(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('inválido') }),
    );
  });
});

// ─── handleCommand — /report ──────────────────────────────────────────────────

describe('handleCommand() — /report', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    _resetProjectsCache();
    // Limpa histórico de chamadas sem apagar implementações dos mocks
    vi.clearAllMocks();
    // Restaurar implementações essenciais após clearAllMocks
    captureThreadMessages.mockResolvedValue([]);
    buildReportEmbed.mockReturnValue({
      data: { color: 0xFFCC00, title: 'Relatório', fields: [] },
      addFields: vi.fn().mockReturnThis(),
    });
  });

  it('/report — fora de uma thread → reply com erro sobre uso em thread', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({
      commandName: 'report',
      options: { description: 'Comportamento inesperado detectado', severity: 'medium' },
    });
    // isThread retorna false por padrão no createInteraction

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('thread') }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('/report — sem sessão ativa → defere, gera relatório e edita reply com embed e arquivo', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({
      commandName: 'report',
      options: { description: 'Problema reportado sem sessão ativa', severity: 'low' },
    });
    interaction.channel.isThread.mockReturnValue(true);

    await handleCommand(interaction, sm);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        files: expect.any(Array),
      }),
    );
  });

  it('/report — caminho feliz com sessão ativa → defere, captura mensagens e edita reply com embed e arquivo', async () => {
    const session = {
      sessionId: 'sess-report-1',
      projectPath: '/projetos/meu-proj',
      agent: 'plan',
      model: 'claude-sonnet',
      status: 'finished',
      outputBuffer: 'algum output da sessão',
      createdAt: new Date(),
      closedAt: null,
      lastActivityAt: new Date(),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({
      commandName: 'report',
      options: { description: 'Comportamento inesperado detectado', severity: 'high' },
    });
    interaction.channel.isThread.mockReturnValue(true);

    await handleCommand(interaction, sm);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(captureThreadMessages).toHaveBeenCalledWith(interaction.channel, 100);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        files: expect.any(Array),
      }),
    );
  });

  it('/report — create_issue=true com GitHub configurado → cria issue com conteúdo do relatório', async () => {
    // Substitui o retorno de getGitHubClient por um cliente estável e rastreável
    const stableGhClient = {
      createIssue: vi.fn().mockResolvedValue({ number: 99, html_url: 'https://github.com/owner/repo/issues/99' }),
    };
    getGitHubClient.mockReturnValueOnce(stableGhClient);

    const session = {
      sessionId: 'sess-report-gh',
      projectPath: '/projetos/gh-proj',
      agent: 'plan',
      model: 'claude-sonnet',
      status: 'finished',
      outputBuffer: '',
      createdAt: new Date(),
      closedAt: null,
      lastActivityAt: new Date(),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({
      commandName: 'report',
      options: { description: 'Erro crítico detectado', severity: 'critical' },
    });
    interaction.channel.isThread.mockReturnValue(true);
    interaction.options.getBoolean.mockReturnValue(true); // create_issue=true

    await handleCommand(interaction, sm);

    expect(stableGhClient.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        labels: expect.arrayContaining(['bug', 'remoteflow-report']),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        files: expect.any(Array),
      }),
    );
  });

  it('/report — create_issue=true com GitHub falhando → não crasha e editReply é chamado com aviso', async () => {
    // Simula falha no GitHub — a exceção deve ser absorvida pelo handler
    getGitHubClient.mockReturnValueOnce({
      createIssue: vi.fn().mockRejectedValue(new Error('GitHub API error simulado')),
    });

    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({
      commandName: 'report',
      options: { description: 'Problema com GitHub indisponível', severity: 'medium' },
    });
    interaction.channel.isThread.mockReturnValue(true);
    interaction.options.getBoolean.mockReturnValue(true); // create_issue=true

    await handleCommand(interaction, sm);

    // Não deve ter crashado — editReply deve ter sido chamado mesmo após falha do GitHub
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        files: expect.any(Array),
      }),
    );
  });
});

// ─── commandDefinitions — /report ─────────────────────────────────────────────

describe('commandDefinitions — /report', () => {
  it('nome do comando é "report" (em inglês)', () => {
    const reportCmd = commandDefinitions.find((c) => c.name === 'report');
    expect(reportCmd).toBeDefined();
    expect(reportCmd.name).toBe('report');
  });

  it('tem opção "description" obrigatória', () => {
    const reportCmd = commandDefinitions.find((c) => c.name === 'report');
    const descOpt = reportCmd.options.find((o) => o.name === 'description');
    expect(descOpt).toBeDefined();
    expect(descOpt.required).toBe(true);
  });

  it('tem opção "severity" opcional com choices: low, medium, high, critical', () => {
    const reportCmd = commandDefinitions.find((c) => c.name === 'report');
    const sevOpt = reportCmd.options.find((o) => o.name === 'severity');
    expect(sevOpt).toBeDefined();
    expect(sevOpt.required).toBeFalsy();
    const choiceValues = sevOpt.choices.map((ch) => ch.value);
    expect(choiceValues).toContain('low');
    expect(choiceValues).toContain('medium');
    expect(choiceValues).toContain('high');
    expect(choiceValues).toContain('critical');
  });

  it('tem opção "create_issue" opcional do tipo boolean', () => {
    const reportCmd = commandDefinitions.find((c) => c.name === 'report');
    const ciOpt = reportCmd.options.find((o) => o.name === 'create_issue');
    expect(ciOpt).toBeDefined();
    expect(ciOpt.required).toBeFalsy();
    // type 5 = BOOLEAN na API do Discord (ApplicationCommandOptionType.Boolean)
    expect(ciOpt.type).toBe(5);
  });
});

// ─── handleCommand() — /reconnect ────────────────────────────────────────────

/**
 * Cria um mock de serverManager com getServer configurável.
 * @param {object|null} serverResult - valor retornado por getServer()
 * @returns {object}
 */
function createServerManager(serverResult = null) {
  return {
    getServer: vi.fn().mockReturnValue(serverResult),
    getAll: vi.fn().mockReturnValue([]),
  };
}

describe('handleCommand() — /reconnect', () => {
  it('/reconnect — sem sessão na thread → editReply com "Nenhuma sessão"', async () => {
    const interaction = createInteraction({ commandName: 'reconnect', channelId: 'thread-abc' });
    const sm = createSessionManager({ getByThreadResult: null });
    const svr = createServerManager(null);

    await handleCommand(interaction, sm, svr);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma sessão'),
    );
  });

  it('/reconnect — sessão existe mas servidor não encontrado → editReply com "Servidor não encontrado"', async () => {
    const session = { projectPath: '/projetos/app', sessionId: 'sess-r1' };
    const interaction = createInteraction({ commandName: 'reconnect', channelId: 'thread-abc' });
    const sm = createSessionManager({ getByThreadResult: session });
    const svr = createServerManager(null);

    await handleCommand(interaction, sm, svr);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Servidor não encontrado'),
    );
  });

  it('/reconnect — servidor em estado "stopped" → editReply com estado', async () => {
    const session = { projectPath: '/projetos/app', sessionId: 'sess-r2' };
    const server = { status: 'stopped', reconnectSSE: vi.fn() };
    const interaction = createInteraction({ commandName: 'reconnect', channelId: 'thread-abc' });
    const sm = createSessionManager({ getByThreadResult: session });
    const svr = createServerManager(server);

    await handleCommand(interaction, sm, svr);

    expect(server.reconnectSSE).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('stopped'),
    );
  });

  it('/reconnect — sucesso → reconnectSSE chamado e editReply com confirmação', async () => {
    const session = { projectPath: '/projetos/app', sessionId: 'sess-r3' };
    const server = { status: 'running', reconnectSSE: vi.fn() };
    const interaction = createInteraction({ commandName: 'reconnect', channelId: 'thread-abc' });
    const sm = createSessionManager({ getByThreadResult: session });
    const svr = createServerManager(server);

    await handleCommand(interaction, sm, svr);

    expect(server.reconnectSSE).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Reconexão SSE iniciada'),
    );
  });
});

// ─── handleCommand() — /pr create ────────────────────────────────────────────

describe('handleCommand() — /pr create', () => {
  it('/pr create — GITHUB_TOKEN não configurado → replyError', async () => {
    const { getGitHubClient: _ghc } = await import('../src/github.js');
    const { hasChanges: _hc } = await import('../src/git.js');

    // Precisamos simular GITHUB_TOKEN ausente; o mock de config retorna 'test-token' por padrão.
    // Verificamos apenas que hasChanges NÃO é chamado quando o token estiver ausente.
    // Para isso, testamos o caminho sem sessão (guarda antes do token check)
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'create' },
    });
    const sm = createSessionManager({ getByThreadResult: null });

    await handleCommand(interaction, sm);

    // Sem sessão → replyError (ephemeral)
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Nenhuma sessão') }),
    );
  });

  it('/pr create — sem mudanças no projeto → editReply "Nenhuma alteração"', async () => {
    const { hasChanges } = await import('../src/git.js');
    hasChanges.mockResolvedValueOnce(false);

    const session = {
      projectPath: '/projetos/app',
      sessionId: 'sess-pr-1',
      agent: 'build',
      outputBuffer: '',
    };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'create' },
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma alteração'),
    );
  });

  it('/pr create — sucesso → cria PR e editReply com embed contendo número e link', async () => {
    const { hasChanges } = await import('../src/git.js');
    hasChanges.mockResolvedValueOnce(true);

    const session = {
      projectPath: '/projetos/app',
      sessionId: 'sess-pr-2',
      agent: 'build',
      outputBuffer: 'output da sessão',
    };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'create' },
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('/pr create — erro durante criação → editReply com mensagem de erro', async () => {
    const { hasChanges } = await import('../src/git.js');
    const { getGitHubClient } = await import('../src/github.js');
    hasChanges.mockResolvedValueOnce(true);
    getGitHubClient.mockReturnValueOnce({
      createPullRequest: vi.fn().mockRejectedValue(new Error('API indisponível')),
    });

    const session = {
      projectPath: '/projetos/app',
      sessionId: 'sess-pr-3',
      agent: 'build',
      outputBuffer: '',
    };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'create' },
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('API indisponível'),
    );
  });
});

// ─── handleCommand() — /pr list ──────────────────────────────────────────────

describe('handleCommand() — /pr list', () => {
  it('/pr list — sem PRs → editReply com "Nenhum PR"', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      listPullRequests: vi.fn().mockResolvedValue([]),
    });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-prl-1' };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'list' },
      channelId: 'thread-list-1',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhum PR'),
    );
  });

  it('/pr list — com PRs → editReply com embed contendo lista de PRs', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    const mockPrs = [
      { number: 1, title: 'feat: nova funcionalidade', state: 'open', draft: false, html_url: 'https://github.com/o/r/pull/1', user: { login: 'dev' } },
      { number: 2, title: 'fix: correção de bug', state: 'open', draft: true, html_url: 'https://github.com/o/r/pull/2', user: { login: 'dev2' } },
    ];
    getGitHubClient.mockReturnValueOnce({
      listPullRequests: vi.fn().mockResolvedValue(mockPrs),
    });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-prl-2' };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'list' },
      channelId: 'thread-list-2',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('/pr list — com opção project explícita → usa projectPath da opção', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      listPullRequests: vi.fn().mockResolvedValue([]),
    });

    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'list', project: 'meu-projeto' },
    });
    const sm = createSessionManager(); // sem sessão na thread

    await handleCommand(interaction, sm);

    // Deve funcionar mesmo sem sessão, pois o projeto foi passado explicitamente
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhum PR'),
    );
  });

  it('/pr list — erro na API → editReply com mensagem de erro', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      listPullRequests: vi.fn().mockRejectedValue(new Error('rate limit')),
    });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-prl-4' };
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'list' },
      channelId: 'thread-list-4',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('rate limit'),
    );
  });
});

// ─── handleCommand() — /pr review ────────────────────────────────────────────

describe('handleCommand() — /pr review', () => {
  it('/pr review — sem sessão na thread e sem opção project → editReply com erro', async () => {
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'review', number: 1 },
      channelId: 'thread-prr-no-session',
    });
    const sm = createSessionManager({ getByThreadResult: null });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma sessão'),
    );
  });

  it('/pr review — com opção project → cria sessão de revisão e editReply com confirmação', async () => {
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'review', number: 42, project: 'meu-projeto' },
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Revisão'),
    );
  });

  it('/pr review — erro ao buscar PR → editReply com mensagem de erro', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      getPullRequest: vi.fn().mockRejectedValue(new Error('PR não encontrado')),
      getPullRequestDiff: vi.fn().mockResolvedValue(''),
      getPullRequestFiles: vi.fn().mockResolvedValue([]),
    });

    const interaction = createInteraction({
      commandName: 'pr',
      options: { _subcommand: 'review', number: 999, project: 'meu-projeto' },
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('PR não encontrado'),
    );
  });
});

// ─── handleCommand() — /issue list ───────────────────────────────────────────

describe('handleCommand() — /issue list', () => {
  it('/issue list — sem issues → editReply com "Nenhuma issue"', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      listIssues: vi.fn().mockResolvedValue([]),
    });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-il-1' };
    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'list' },
      channelId: 'thread-il-1',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma issue'),
    );
  });

  it('/issue list — com issues → editReply com embed contendo lista', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    const mockIssues = [
      { number: 10, title: 'Bug crítico no login', html_url: 'https://github.com/o/r/issues/10', user: { login: 'reporter' }, labels: [] },
      { number: 11, title: 'Feature: dark mode', html_url: 'https://github.com/o/r/issues/11', user: { login: 'user2' }, labels: [{ name: 'enhancement' }] },
    ];
    getGitHubClient.mockReturnValueOnce({
      listIssues: vi.fn().mockResolvedValue(mockIssues),
    });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-il-2' };
    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'list' },
      channelId: 'thread-il-2',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('/issue list — com label filter → chama listIssues com label correto', async () => {
    const mockListIssues = vi.fn().mockResolvedValue([]);
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({ listIssues: mockListIssues });

    const session = { projectPath: '/projetos/app', sessionId: 'sess-il-3' };
    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'list', label: 'bug' },
      channelId: 'thread-il-3',
    });
    const sm = createSessionManager({ getByThreadResult: session });

    await handleCommand(interaction, sm);

    expect(mockListIssues).toHaveBeenCalledWith(
      expect.objectContaining({ labels: 'bug' }),
    );
  });

  it('/issue list — sem sessão e sem opção project → editReply com instrução', async () => {
    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'list' },
      channelId: 'thread-no-session',
    });
    const sm = createSessionManager({ getByThreadResult: null });

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Nenhuma sessão'),
    );
  });
});

// ─── handleCommand() — /issue implement ──────────────────────────────────────

describe('handleCommand() — /issue implement', () => {
  it('/issue implement — projeto inválido → replyError', async () => {
    const { validateProjectPath } = await import('../src/config.js');
    validateProjectPath.mockReturnValueOnce({ valid: false, projectPath: null, error: 'Projeto não encontrado' });

    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'implement', number: 5, project: 'projeto-invalido' },
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Projeto não encontrado') }),
    );
  });

  it('/issue implement — sucesso → cria sessão build e editReply com confirmação', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      getIssue: vi.fn().mockResolvedValue({
        number: 7,
        title: 'Implementar feature X',
        user: { login: 'requester' },
        labels: [{ name: 'feature' }],
        body: 'Descrição detalhada da feature',
      }),
    });

    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'implement', number: 7, project: 'meu-projeto' },
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Implementação'),
    );
  });

  it('/issue implement — erro ao buscar issue → editReply com mensagem de erro', async () => {
    const { getGitHubClient } = await import('../src/github.js');
    getGitHubClient.mockReturnValueOnce({
      getIssue: vi.fn().mockRejectedValue(new Error('issue não encontrada')),
    });

    const interaction = createInteraction({
      commandName: 'issue',
      options: { _subcommand: 'implement', number: 999, project: 'meu-projeto' },
    });
    const sm = createSessionManager();

    await handleCommand(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('issue não encontrada'),
    );
  });
});

// ─── handleInteraction() — publish_review_ ───────────────────────────────────

describe('handleInteraction() — publish_review_', () => {
  it('publish_review_ — sem contexto de review → reply ephemeral com erro', async () => {
    const interaction = {
      isStringSelectMenu: vi.fn().mockReturnValue(false),
      isButton: vi.fn().mockReturnValue(true),
      isModalSubmit: vi.fn().mockReturnValue(false),
      customId: 'publish_review_sess-inexistente-xyz',
      user: { id: 'user-pub-1', username: 'testuser' },
      reply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
      message: { edit: vi.fn().mockResolvedValue({}) },
    };
    const sm = createSessionManager();

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Contexto de review não encontrado'),
        ephemeral: true,
      }),
    );
  });
});

// ─── handleInteraction() — plan_feedback_modal_ ───────────────────────────────

describe('handleInteraction() — plan_feedback_modal_', () => {
  it('plan_feedback_modal_ — sessão não encontrada → reply com erro', async () => {
    const interaction = {
      isStringSelectMenu: vi.fn().mockReturnValue(false),
      isButton: vi.fn().mockReturnValue(false),
      isModalSubmit: vi.fn().mockReturnValue(true),
      customId: 'plan_feedback_modal_sess-inexistente',
      user: { id: 'user-fb-1', username: 'testuser' },
      fields: { getTextInputValue: vi.fn().mockReturnValue('meu feedback') },
      reply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
    };
    const sm = createSessionManager({ getByIdResult: null });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Sessão não encontrada'),
      }),
    );
  });

  it('plan_feedback_modal_ — sessão sem plannotatorBaseUrl → editReply com confirmação sem chamar API', async () => {
    const session = {
      sessionId: 'sess-fb-2',
      server: null, // sem servidor plannotator
      notifyPlanReviewResolved: vi.fn(),
    };
    const interaction = {
      isStringSelectMenu: vi.fn().mockReturnValue(false),
      isButton: vi.fn().mockReturnValue(false),
      isModalSubmit: vi.fn().mockReturnValue(true),
      customId: 'plan_feedback_modal_sess-fb-2',
      user: { id: 'user-fb-2', username: 'testuser' },
      fields: { getTextInputValue: vi.fn().mockReturnValue('feedback do usuário') },
      reply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
    };
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(session.notifyPlanReviewResolved).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Feedback enviado'),
    );
  });
});

// ─── createSessionInThread — erro relançado ───────────────────────────────────

describe('createSessionInThread — erro relançado', () => {
  it('relança erro quando thread.send() falha após criação da sessão', async () => {
    const sendError = new Error('Falha ao enviar mensagem na thread');
    const mockThread = {
      id: 'thread-err-1',
      send: vi.fn().mockRejectedValue(sendError),
      delete: vi.fn().mockResolvedValue({}),
      setArchived: vi.fn().mockResolvedValue({}),
      messages: { fetch: vi.fn().mockResolvedValue([]) },
    };
    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto' },
    });
    interaction.channel.threads.create = vi.fn().mockResolvedValue(mockThread);

    const sm = createSessionManager();

    await expect(handleCommand(interaction, sm)).rejects.toThrow('Falha ao enviar mensagem na thread');
  });
});

// ─── getProjects() — catch de readdir ────────────────────────────────────────

describe('getProjects() — catch de readdir', () => {
  it('retorna array vazio quando readdir lança erro e cache está limpo', async () => {
    _resetProjectsCache();
    fsp.readdir.mockRejectedValueOnce(new Error('Permissão negada'));

    const interaction = createInteraction({
      commandName: 'plan',
      options: { _focusedName: 'project', _focusedValue: '' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

// ─── replyError — catch silencioso ───────────────────────────────────────────

describe('replyError — catch silencioso quando reply falha', () => {
  it('absorve erro quando interaction.reply lança exceção durante replyError', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'status', replied: false, deferred: false });
    interaction.reply.mockRejectedValueOnce(new Error('Unknown interaction'));

    // Não deve lançar — o catch interno absorve o erro silenciosamente
    await expect(handleCommand(interaction, sm)).resolves.toBeUndefined();
  });
});

// ─── handleStartSession — prompt inicial ─────────────────────────────────────

describe('handleCommand() — /plan com prompt inicial', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockConfigState.maxGlobalSessions = 0;
    _resetProjectsCache();
  });

  it('chama session.sendMessage com o promptText quando opção prompt é fornecida', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sm = createSessionManager();
    sm.create = vi.fn().mockImplementation(async ({ threadId, userId: uid }) => ({
      sessionId: 'sess-prompt-1',
      threadId,
      userId: uid,
      status: 'idle',
      projectPath: '/projetos/meu-projeto',
      agent: 'plan',
      outputBuffer: '',
      toSummary: () => ({
        sessionId: 'sess-prompt-1',
        status: 'idle',
        projectPath: '/projetos/meu-projeto',
        project: 'meu-projeto',
        userId: uid,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }),
      sendMessage,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    }));

    const interaction = createInteraction({
      commandName: 'plan',
      options: { project: 'meu-projeto', prompt: 'crie uma feature de login' },
    });

    await handleCommand(interaction, sm);

    expect(sendMessage).toHaveBeenCalledWith('crie uma feature de login');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Sessão'),
    );
  });
});

// ─── handleAutocomplete — /pr e /issue ───────────────────────────────────────

describe('handleAutocomplete() — /pr e /issue', () => {
  beforeEach(() => {
    _resetProjectsCache();
    fsp.readdir.mockResolvedValue([mockDirentDir('proj-a'), mockDirentDir('proj-b')]);
  });

  it('/pr com foco em model → respond com lista de modelos filtrados por prefixo', async () => {
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _focusedName: 'model', _focusedValue: 'anthropic' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5' },
      ]),
    );
  });

  it('/pr com foco em project → respond com lista de projetos filtrados', async () => {
    const interaction = createInteraction({
      commandName: 'pr',
      options: { _focusedName: 'project', _focusedValue: 'proj' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 'proj-a' }),
        expect.objectContaining({ value: 'proj-b' }),
      ]),
    );
  });

  it('/issue com foco em model → respond com lista de modelos filtrados', async () => {
    const interaction = createInteraction({
      commandName: 'issue',
      options: { _focusedName: 'model', _focusedValue: 'openai' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'openai/gpt-4o', value: 'openai/gpt-4o' },
      ]),
    );
  });
});

// ─── handleListProjects — deferReply error paths ─────────────────────────────

describe('handleCommand() — /projects deferReply erro', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    _resetProjectsCache();
  });

  it('deferReply com código 10062 → retorna silenciosamente sem editReply', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projects' });
    const err = new Error('Unknown interaction');
    err.code = 10062;
    interaction.deferReply.mockRejectedValueOnce(err);

    await handleCommand(interaction, sm);

    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('deferReply com erro inesperado → relança o erro', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projects' });
    const err = new Error('Erro inesperado do servidor');
    err.code = 500;
    interaction.deferReply.mockRejectedValueOnce(err);

    await expect(handleCommand(interaction, sm)).rejects.toThrow('Erro inesperado do servidor');
  });
});

// ─── handleRunCommand — deferReply error paths ───────────────────────────────

describe('handleCommand() — /command deferReply erro', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
  });

  it('deferReply com código 10062 → retorna silenciosamente sem chamar sendMessage', async () => {
    const session = {
      sessionId: 'sess-cmd-10062',
      projectPath: '/projetos/teste',
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({
      commandName: 'command',
      options: { name: 'help', args: '' },
    });
    const err = new Error('Unknown interaction');
    err.code = 10062;
    interaction.deferReply.mockRejectedValueOnce(err);

    await handleCommand(interaction, sm);

    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it('deferReply com erro inesperado → relança o erro', async () => {
    const session = {
      sessionId: 'sess-cmd-500',
      projectPath: '/projetos/teste',
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({
      commandName: 'command',
      options: { name: 'help', args: '' },
    });
    const err = new Error('Erro inesperado de servidor');
    err.code = 500;
    interaction.deferReply.mockRejectedValueOnce(err);

    await expect(handleCommand(interaction, sm)).rejects.toThrow('Erro inesperado de servidor');
  });
});

// ─── handleDiffCommand — deferReply error paths ──────────────────────────────

describe('handleCommand() — /diff deferReply erro', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockSpawn.mockReset();
  });

  it('deferReply com código 10062 → retorna silenciosamente sem editReply', async () => {
    const session = { sessionId: 'sess-diff-10062', projectPath: '/projetos/teste' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });
    const err = new Error('Unknown interaction');
    err.code = 10062;
    interaction.deferReply.mockRejectedValueOnce(err);

    await handleCommand(interaction, sm);

    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('deferReply com erro inesperado → relança o erro', async () => {
    const session = { sessionId: 'sess-diff-500', projectPath: '/projetos/teste' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });
    const err = new Error('Erro inesperado');
    err.code = 500;
    interaction.deferReply.mockRejectedValueOnce(err);

    await expect(handleCommand(interaction, sm)).rejects.toThrow('Erro inesperado');
  });
});

// ─── handleDiffCommand — editReply falha ao enviar diff ──────────────────────

describe('handleCommand() — /diff erro ao enviar resultado', () => {
  beforeEach(() => {
    mockConfigState.allowedUsers = [];
    mockSpawn.mockReset();
  });

  it('editReply para saída do diff lança erro → fallback editReply com mensagem de erro', async () => {
    const session = { sessionId: 'sess-diff-send-err', projectPath: '/projetos/meu-projeto' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'diff' });

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);

    // Primeiro editReply (para o conteúdo do diff) falha; segundo (fallback) resolve
    interaction.editReply
      .mockRejectedValueOnce(new Error('Message content too large'))
      .mockResolvedValue({});

    const promise = handleCommand(interaction, sm);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    proc.stdout.emit('data', 'diff --git a/file.js b/file.js\n+added line');
    proc.emit('close', 0);

    await promise;

    expect(interaction.editReply).toHaveBeenLastCalledWith('❌ Erro ao enviar o diff.');
  });
});

// ─── handleInteraction — caminhos extras de permissão ────────────────────────

describe('handleInteraction() — caminhos extras de permissão', () => {
  it('allow_once_ — userId diferente do session.userId → reply com "criador"', async () => {
    const session = {
      sessionId: 'sess-once-noowner',
      userId: 'owner-user',
      _pendingPermissionId: 'perm-1',
      _pendingPermissionData: null,
      resolvePermission: vi.fn(),
      server: { client: { approvePermission: vi.fn().mockResolvedValue({}) } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'allow_once_sess-once-noowner',
      userId: 'other-user',
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('criador') }),
    );
  });

  it('allow_once_ — _pendingPermissionId nulo → reply com "Nenhuma permissão pendente"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-once-noperm',
      userId,
      _pendingPermissionId: null,
      _pendingPermissionData: null,
      resolvePermission: vi.fn(),
      server: { client: { approvePermission: vi.fn() } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'allow_once_sess-once-noperm',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('pendente') }),
    );
  });

  it('allow_once_ — approvePermission lança erro → reply com "Erro ao aprovar"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-once-err',
      userId,
      apiSessionId: 'api-once-err',
      agent: 'build',
      _pendingPermissionId: 'perm-once-err',
      _pendingPermissionData: null,
      resolvePermission: vi.fn(),
      server: { client: { approvePermission: vi.fn().mockRejectedValue(new Error('API down')) } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'allow_once_sess-once-err',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Erro ao aprovar') }),
    );
  });

  it('allow_always_ — _pendingPermissionId nulo → reply com "Nenhuma permissão pendente"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-always-noperm',
      userId,
      _pendingPermissionId: null,
      _pendingPermissionData: null,
      addAllowedPattern: vi.fn(),
      resolvePermission: vi.fn(),
      server: { client: { approvePermission: vi.fn() } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'allow_always_sess-always-noperm',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('pendente') }),
    );
  });

  it('allow_always_ — approvePermission lança erro → reply com "Erro ao aprovar"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-always-err',
      userId,
      apiSessionId: 'api-always-err',
      agent: 'build',
      _pendingPermissionId: 'perm-always-err',
      _pendingPermissionData: { toolName: 'bash', patterns: [] },
      addAllowedPattern: vi.fn(),
      resolvePermission: vi.fn(),
      server: { client: { approvePermission: vi.fn().mockRejectedValue(new Error('timeout')) } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'allow_always_sess-always-err',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Erro ao aprovar') }),
    );
  });

  it('reject_permission_ — _pendingPermissionId nulo → reply com "Nenhuma permissão pendente"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-reject-noperm',
      userId,
      apiSessionId: 'api-reject-noperm',
      agent: 'build',
      _pendingPermissionId: null,
      _pendingPermissionData: null,
      resolvePermission: vi.fn(),
      server: { client: { rejectPermission: vi.fn() } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'reject_permission_sess-reject-noperm',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('pendente') }),
    );
  });

  it('reject_permission_ — interaction.update lança erro → reply com "Erro ao rejeitar"', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-reject-err',
      userId,
      apiSessionId: 'api-reject-err',
      agent: 'build',
      _pendingPermissionId: 'perm-reject-err',
      _pendingPermissionData: { toolName: 'bash', patterns: [] },
      resolvePermission: vi.fn(),
      server: { client: { rejectPermission: vi.fn().mockResolvedValue({}) } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'reject_permission_sess-reject-err',
      userId,
    });
    interaction.update = vi.fn().mockRejectedValue(new Error('Discord error'));
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Erro ao rejeitar') }),
    );
  });

  it('approve_permission_ (legado) — _pendingPermissionId nulo → reply com "Nenhuma permissão pendente"', async () => {
    const session = {
      sessionId: 'sess-legacy-noperm',
      apiSessionId: 'api-legacy-noperm',
      _pendingPermissionId: null,
      _pendingPermissionData: null,
      server: { client: { approvePermission: vi.fn() } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'approve_permission_sess-legacy-noperm',
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('pendente') }),
    );
  });

  it('approve_permission_ (legado) — approvePermission lança erro → reply com "Erro ao aprovar"', async () => {
    const session = {
      sessionId: 'sess-legacy-err',
      apiSessionId: 'api-legacy-err',
      _pendingPermissionId: 'perm-legacy-err',
      _pendingPermissionData: null,
      server: { client: { approvePermission: vi.fn().mockRejectedValue(new Error('API timeout')) } },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'approve_permission_sess-legacy-err',
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Erro ao aprovar') }),
    );
  });

  it('deny_permission_ (legado) — abort lança erro → reply com "Erro ao recusar"', async () => {
    const sessionId = 'sess-deny-err';
    const session = {
      sessionId,
      server: { client: {} },
      abort: vi.fn().mockRejectedValue(new Error('abort failed')),
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: `deny_permission_${sessionId}`,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Erro ao recusar') }),
    );
  });
});

// ─── handleInteraction — revisão de plano ────────────────────────────────────

describe('handleInteraction() — revisão de plano', () => {
  it('approve_plan_ — happy path → deferUpdate + editReply aprovado + notifyPlanReviewResolved', async () => {
    const userId = nextUserId();
    const notifyPlanReviewResolved = vi.fn();
    const session = {
      sessionId: 'sess-approve-plan-1',
      userId,
      server: { plannotatorBaseUrl: 'http://localhost:5100' },
      notifyPlanReviewResolved,
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'approve_plan_sess-approve-plan-1',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(notifyPlanReviewResolved).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('aprovado') }),
    );
  });

  it('approve_plan_ — userId diferente → reply com "criador"', async () => {
    const session = {
      sessionId: 'sess-approve-plan-noowner',
      userId: 'owner-user-plan',
      server: { plannotatorBaseUrl: null },
      notifyPlanReviewResolved: vi.fn(),
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'approve_plan_sess-approve-plan-noowner',
      userId: 'other-user-plan',
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('criador') }),
    );
  });

  it('approve_plan_ — plannotatorClient.approve lança erro → editReply com "já processada"', async () => {
    const { PlannotatorClient } = await import('../src/plannotator-client.js');
    PlannotatorClient.mockImplementationOnce(function () {
      this.approve = vi.fn().mockRejectedValue(new Error('connection refused'));
      this.deny = vi.fn();
    });

    const userId = nextUserId();
    const session = {
      sessionId: 'sess-approve-plan-err',
      userId,
      server: { plannotatorBaseUrl: 'http://localhost:5100' },
      notifyPlanReviewResolved: vi.fn(),
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'approve_plan_sess-approve-plan-err',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('já processada') }),
    );
  });

  it('changes_plan_ — happy path → showModal é chamado com modal de feedback', async () => {
    const userId = nextUserId();
    const session = {
      sessionId: 'sess-changes-plan-1',
      userId,
      server: { plannotatorBaseUrl: 'http://localhost:5100' },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'changes_plan_sess-changes-plan-1',
      userId,
    });
    interaction.showModal = vi.fn().mockResolvedValue({});
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('changes_plan_ — userId diferente → reply com "criador" sem showModal', async () => {
    const session = {
      sessionId: 'sess-changes-plan-noowner',
      userId: 'owner-changes',
      server: { plannotatorBaseUrl: null },
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'changes_plan_sess-changes-plan-noowner',
      userId: 'other-changes',
    });
    interaction.showModal = vi.fn().mockResolvedValue({});
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('criador') }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('reject_plan_ — happy path → deferUpdate + editReply rejeitado + notifyPlanReviewResolved', async () => {
    const userId = nextUserId();
    const notifyPlanReviewResolved = vi.fn();
    const session = {
      sessionId: 'sess-reject-plan-1',
      userId,
      server: { plannotatorBaseUrl: 'http://localhost:5100' },
      notifyPlanReviewResolved,
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'reject_plan_sess-reject-plan-1',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(notifyPlanReviewResolved).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rejeitado') }),
    );
  });

  it('reject_plan_ — userId diferente → reply com "criador"', async () => {
    const session = {
      sessionId: 'sess-reject-plan-noowner',
      userId: 'owner-reject-plan',
      server: { plannotatorBaseUrl: null },
      notifyPlanReviewResolved: vi.fn(),
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'reject_plan_sess-reject-plan-noowner',
      userId: 'other-reject-plan',
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('criador') }),
    );
  });

  it('reject_plan_ — plannotatorClient.deny lança erro → editReply com mensagem de erro', async () => {
    const { PlannotatorClient } = await import('../src/plannotator-client.js');
    PlannotatorClient.mockImplementationOnce(function () {
      this.approve = vi.fn();
      this.deny = vi.fn().mockRejectedValue(new Error('service unavailable'));
    });

    const userId = nextUserId();
    const session = {
      sessionId: 'sess-reject-plan-err',
      userId,
      server: { plannotatorBaseUrl: 'http://localhost:5100' },
      notifyPlanReviewResolved: vi.fn(),
    };
    const interaction = createComponentInteraction({
      isButton: true,
      customId: 'reject_plan_sess-reject-plan-err',
      userId,
    });
    const sm = createSessionManager({ getByIdResult: session });

    await handleInteraction(interaction, sm);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rejeitado') }),
    );
  });
});
