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
  AVAILABLE_MODELS: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o'],
  DEFAULT_MODEL: '',
  MAX_SESSIONS_PER_PROJECT: 2,
  PERMISSION_TIMEOUT_MS: 60000,
  validateProjectPath: vi.fn((name) => ({
    valid: true,
    projectPath: '/projetos/' + name,
    error: null,
  })),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

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

// ─── Imports do módulo sob teste (após os mocks) ──────────────────────────────

import * as fsp from 'fs/promises';
import { existsSync } from 'fs';
import { validateProjectPath } from '../src/config.js';
import { handleCommand, handleAutocomplete, handleInteraction, commandDefinitions, getRateLimitStats, _resetProjectsCache } from '../src/commands.js';

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
  commandName = 'projetos',
  userId = null,
  options = {},
  channelId = 'channel-test',
  replied = false,
  deferred = false,
} = {}) {
  const uid = userId ?? nextUserId();

  const mockOptions = {
    getString: vi.fn((name) => options[name] ?? null),
    getBoolean: vi.fn(() => null),
    getFocused: vi.fn((withObject) =>
      withObject
        ? { name: options._focusedName ?? 'projeto', value: options._focusedValue ?? '' }
        : (options._focusedValue ?? '')
    ),
    getSubcommand: vi.fn(() => null),
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

  it('contém os comandos: plan, build, sessoes, status, parar, projetos, historico, comando', () => {
    const names = commandDefinitions.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('build');
    expect(names).toContain('sessoes');
    expect(names).toContain('status');
    expect(names).toContain('parar');
    expect(names).toContain('projetos');
    expect(names).toContain('historico');
    expect(names).toContain('comando');
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
      commandName: 'projetos',
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
    const interaction = createInteraction({ commandName: 'sessoes' });
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
    const interaction = createInteraction({ commandName: 'sessoes' });
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
    const interaction = createInteraction({ commandName: 'sessoes' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('/projetos — com projetos responde com embed', async () => {
    fsp.readdir.mockResolvedValue([mockDirentDir('proj-a'), mockDirentDir('proj-b')]);
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'projetos' });
    await handleCommand(interaction, sm);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('/historico — com sessão responde com arquivo', async () => {
    const session = { sessionId: 'sess-hist-1', outputBuffer: 'algum output' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'historico' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('/historico — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'historico' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/parar — com sessão responde com confirmação de encerramento', async () => {
    const session = { sessionId: 'sess-stop-1', projectPath: '/projetos/meu-proj', userId: 'user-st' };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'parar' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Deseja encerrar') }));
  });

  it('/parar — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'parar' });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/comando — envia comando para sessão ativa', async () => {
    const session = { sessionId: 'sess-cmd-1', projectPath: '/projetos/cmd-proj', sendMessage: vi.fn().mockResolvedValue({}) };
    const sm = createSessionManager({ getByThreadResult: session });
    const interaction = createInteraction({ commandName: 'comando', options: { nome: 'meu-cmd', args: '' } });
    await handleCommand(interaction, sm);
    expect(session.sendMessage).toHaveBeenCalledWith('/meu-cmd');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('enviado'));
  });

  it('/comando — sem sessão responde com erro', async () => {
    const sm = createSessionManager({ getByThreadResult: null });
    const interaction = createInteraction({ commandName: 'comando', options: { nome: 'meu-cmd', args: '' } });
    await handleCommand(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sessão') }));
  });

  it('/plan — cria sessão em thread com projectName fornecido', async () => {
    const sm = createSessionManager();
    const interaction = createInteraction({ commandName: 'plan', options: { projeto: 'meu-projeto' } });
    await handleCommand(interaction, sm);
    expect(sm.create).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/projetos/meu-projeto', agent: 'plan' }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('iniciada'));
  });
});

describe('handleAutocomplete() — modelos', () => {
  it('sugere modelos filtrando por prefixo digitado', async () => {
    const interaction = createInteraction({ commandName: 'plan', options: { _focusedName: 'modelo', _focusedValue: 'anthropic' } });
    await handleAutocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'anthropic/claude-sonnet-4-5', value: 'anthropic/claude-sonnet-4-5' }]));
  });
});

describe('handleInteraction() — approve/deny permission', () => {
  it('approve_permission_ — chama confirmPermission e atualiza interação', async () => {
    const sessionId = 'sess-approve-1';
    const confirmPermission = vi.fn().mockResolvedValue({});
    const session = { sessionId, apiSessionId: 'api-perm-1', server: { client: { confirmPermission } } };
    const interaction = createComponentInteraction({ isButton: true, customId: `approve_permission_${sessionId}` });
    const sm = createSessionManager({ getByIdResult: session });
    await handleInteraction(interaction, sm);
    expect(confirmPermission).toHaveBeenCalledWith('api-perm-1');
    expect(interaction.update).toHaveBeenCalled();
  });

  it('approve_permission_ — sem sessão responde com erro', async () => {
    const interaction = createComponentInteraction({ isButton: true, customId: 'approve_permission_sess-nao-existe' });
    const sm = createSessionManager({ getByIdResult: null });
    await handleInteraction(interaction, sm);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('não encontrada') }));
  });

  it('deny_permission_ — chama abort e atualiza com mensagem de recusa', async () => {
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
    const interaction = createInteraction({ commandName: 'projetos', userId: blockedUserId });
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
      commandName: 'comando',
      options: { _focusedName: 'nome', _focusedValue: 'hel' },
    });

    await handleAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ value: 'help' })]),
    );
  });

  it('sugere todos os comandos quando valor digitado está vazio', async () => {
    const interaction = createInteraction({
      commandName: 'comando',
      options: { _focusedName: 'nome', _focusedValue: '' },
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
      options: { _focusedName: 'projeto', _focusedValue: 'al' },
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
      options: { projeto: 'a'.repeat(257) },
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
      options: { projeto: 'meu-projeto', prompt: 'x'.repeat(10001) },
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
      options: { projeto: 'meu-projeto' },
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
      options: { projeto: 'meu-projeto' },
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
      options: { projeto: 'meu-projeto' },
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
      options: { projeto: 'meu-projeto' },
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
      options: { projeto: 'projeto-inexistente' },
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
    const interaction = createInteraction({ commandName: 'projetos' });

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
