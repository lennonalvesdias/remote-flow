// tests/config.test.js
// Testes para constantes de configuração e validateProjectPath

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateProjectPath } from '../src/config.js';

// ─── validateProjectPath (usa import estático — PROJECTS_BASE padrão) ─────────

describe('validateProjectPath', () => {
  it('rejeita path traversal com ../', () => {
    const result = validateProjectPath('../../../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('inválido');
  });

  it('aceita nome de projeto simples', () => {
    const result = validateProjectPath('meu-projeto');
    expect(result.valid).toBe(true);
    expect(result.projectPath).toContain('meu-projeto');
  });

  it('rejeita caminhos absolutos fora da base', () => {
    const result = validateProjectPath('/tmp/exploit');
    expect(result.valid).toBe(false);
  });

  it('retorna projectPath mesmo quando inválido', () => {
    const result = validateProjectPath('../escape');
    expect(result.valid).toBe(false);
    expect(result.projectPath).toBeDefined();
  });

  it('aceita subdiretório aninhado válido', () => {
    const result = validateProjectPath('org/repo');
    expect(result.valid).toBe(true);
    expect(result.projectPath).toContain('repo');
  });
});

// ─── Constantes — dynamic import após resetar módulos ─────────────────────────

describe('constantes de configuração — valores padrão e env', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── ALLOWED_USERS ──────────────────────────────────────────────────────────

  it('ALLOWED_USERS retorna array vazio quando ALLOWED_USER_IDS é vazio', async () => {
    vi.stubEnv('ALLOWED_USER_IDS', '');
    const { ALLOWED_USERS } = await import('../src/config.js');
    expect(ALLOWED_USERS).toEqual([]);
  });

  it('ALLOWED_USERS divide IDs separados por vírgula', async () => {
    vi.stubEnv('ALLOWED_USER_IDS', 'user1,user2,user3');
    const { ALLOWED_USERS } = await import('../src/config.js');
    expect(ALLOWED_USERS).toEqual(['user1', 'user2', 'user3']);
  });

  it('ALLOWED_USERS remove espaços em branco ao redor dos IDs', async () => {
    vi.stubEnv('ALLOWED_USER_IDS', 'user1, user2 , user3');
    const { ALLOWED_USERS } = await import('../src/config.js');
    expect(ALLOWED_USERS).toEqual(['user1', 'user2', 'user3']);
  });

  it('ALLOWED_USERS filtra entradas vazias resultantes de vírgulas duplas', async () => {
    vi.stubEnv('ALLOWED_USER_IDS', 'user1,,user2');
    const { ALLOWED_USERS } = await import('../src/config.js');
    expect(ALLOWED_USERS).toEqual(['user1', 'user2']);
  });

  // ─── Flags booleanas ────────────────────────────────────────────────────────

  it('ALLOW_SHARED_SESSIONS é false quando env não é "true"', async () => {
    vi.stubEnv('ALLOW_SHARED_SESSIONS', '');
    const { ALLOW_SHARED_SESSIONS } = await import('../src/config.js');
    expect(ALLOW_SHARED_SESSIONS).toBe(false);
  });

  it('ALLOW_SHARED_SESSIONS é true quando env="true"', async () => {
    vi.stubEnv('ALLOW_SHARED_SESSIONS', 'true');
    const { ALLOW_SHARED_SESSIONS } = await import('../src/config.js');
    expect(ALLOW_SHARED_SESSIONS).toBe(true);
  });

  it('ENABLE_DM_NOTIFICATIONS é false quando env não é "true"', async () => {
    vi.stubEnv('ENABLE_DM_NOTIFICATIONS', '');
    const { ENABLE_DM_NOTIFICATIONS } = await import('../src/config.js');
    expect(ENABLE_DM_NOTIFICATIONS).toBe(false);
  });

  it('ENABLE_DM_NOTIFICATIONS é true quando env="true"', async () => {
    vi.stubEnv('ENABLE_DM_NOTIFICATIONS', 'true');
    const { ENABLE_DM_NOTIFICATIONS } = await import('../src/config.js');
    expect(ENABLE_DM_NOTIFICATIONS).toBe(true);
  });

  // ─── Inteiros com padrão ────────────────────────────────────────────────────

  it('DISCORD_MSG_LIMIT usa 1900 como padrão quando env é vazio', async () => {
    vi.stubEnv('DISCORD_MSG_LIMIT', '');
    const { DISCORD_MSG_LIMIT } = await import('../src/config.js');
    expect(DISCORD_MSG_LIMIT).toBe(1900);
  });

  it('DISCORD_MSG_LIMIT lê valor inteiro da variável de ambiente', async () => {
    vi.stubEnv('DISCORD_MSG_LIMIT', '1800');
    const { DISCORD_MSG_LIMIT } = await import('../src/config.js');
    expect(DISCORD_MSG_LIMIT).toBe(1800);
  });

  it('STREAM_UPDATE_INTERVAL usa 1500 como padrão quando env é vazio', async () => {
    vi.stubEnv('STREAM_UPDATE_INTERVAL', '');
    const { STREAM_UPDATE_INTERVAL } = await import('../src/config.js');
    expect(STREAM_UPDATE_INTERVAL).toBe(1500);
  });

  it('STREAM_UPDATE_INTERVAL lê da variável de ambiente', async () => {
    vi.stubEnv('STREAM_UPDATE_INTERVAL', '3000');
    const { STREAM_UPDATE_INTERVAL } = await import('../src/config.js');
    expect(STREAM_UPDATE_INTERVAL).toBe(3000);
  });

  it('OPENCODE_BASE_PORT usa 4100 como padrão', async () => {
    vi.stubEnv('OPENCODE_BASE_PORT', '');
    const { OPENCODE_BASE_PORT } = await import('../src/config.js');
    expect(OPENCODE_BASE_PORT).toBe(4100);
  });

  it('OPENCODE_BASE_PORT lê da variável de ambiente', async () => {
    vi.stubEnv('OPENCODE_BASE_PORT', '5100');
    const { OPENCODE_BASE_PORT } = await import('../src/config.js');
    expect(OPENCODE_BASE_PORT).toBe(5100);
  });

  it('DEFAULT_TIMEOUT_MS usa 10000 como padrão', async () => {
    vi.stubEnv('OPENCODE_TIMEOUT_MS', '');
    const { DEFAULT_TIMEOUT_MS } = await import('../src/config.js');
    expect(DEFAULT_TIMEOUT_MS).toBe(10000);
  });

  it('MAX_SESSIONS_PER_USER usa 3 como padrão', async () => {
    vi.stubEnv('MAX_SESSIONS_PER_USER', '');
    const { MAX_SESSIONS_PER_USER } = await import('../src/config.js');
    expect(MAX_SESSIONS_PER_USER).toBe(3);
  });

  it('MAX_SESSIONS_PER_USER lê da variável de ambiente', async () => {
    vi.stubEnv('MAX_SESSIONS_PER_USER', '5');
    const { MAX_SESSIONS_PER_USER } = await import('../src/config.js');
    expect(MAX_SESSIONS_PER_USER).toBe(5);
  });

  it('SESSION_TIMEOUT_MS usa 1800000 como padrão (30 min)', async () => {
    vi.stubEnv('SESSION_TIMEOUT_MS', '');
    const { SESSION_TIMEOUT_MS } = await import('../src/config.js');
    expect(SESSION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('MAX_BUFFER usa 512000 como padrão', async () => {
    vi.stubEnv('MAX_BUFFER', '');
    const { MAX_BUFFER } = await import('../src/config.js');
    expect(MAX_BUFFER).toBe(512000);
  });

  it('MAX_GLOBAL_SESSIONS usa 0 como padrão (sem limite global)', async () => {
    vi.stubEnv('MAX_GLOBAL_SESSIONS', '');
    const { MAX_GLOBAL_SESSIONS } = await import('../src/config.js');
    expect(MAX_GLOBAL_SESSIONS).toBe(0);
  });

  it('HEALTH_PORT usa 9090 como padrão', async () => {
    vi.stubEnv('HEALTH_PORT', '');
    const { HEALTH_PORT } = await import('../src/config.js');
    expect(HEALTH_PORT).toBe(9090);
  });

  it('HEALTH_PORT lê da variável de ambiente', async () => {
    vi.stubEnv('HEALTH_PORT', '8888');
    const { HEALTH_PORT } = await import('../src/config.js');
    expect(HEALTH_PORT).toBe(8888);
  });

  // ─── PROJECTS_BASE ──────────────────────────────────────────────────────────

  it('PROJECTS_BASE usa "C:\\\\projetos" como padrão quando PROJECTS_BASE_PATH é vazio', async () => {
    vi.stubEnv('PROJECTS_BASE_PATH', '');
    const { PROJECTS_BASE } = await import('../src/config.js');
    expect(PROJECTS_BASE).toBe('C:\\projetos');
  });

  it('PROJECTS_BASE lê caminho customizado da variável PROJECTS_BASE_PATH', async () => {
    vi.stubEnv('PROJECTS_BASE_PATH', '/home/dev/projetos');
    const { PROJECTS_BASE } = await import('../src/config.js');
    expect(PROJECTS_BASE).toBe('/home/dev/projetos');
  });

  it('SERVER_RESTART_DELAY_MS usa 2000 como padrão', async () => {
    vi.stubEnv('SERVER_RESTART_DELAY_MS', '');
    const { SERVER_RESTART_DELAY_MS } = await import('../src/config.js');
    expect(SERVER_RESTART_DELAY_MS).toBe(2000);
  });

  it('LOG_FILE_READ_DELAY_MS usa 500 como padrão', async () => {
    vi.stubEnv('LOG_FILE_READ_DELAY_MS', '');
    const { LOG_FILE_READ_DELAY_MS } = await import('../src/config.js');
    expect(LOG_FILE_READ_DELAY_MS).toBe(500);
  });

  it('THREAD_ARCHIVE_DELAY_MS usa 5000 como padrão', async () => {
    vi.stubEnv('THREAD_ARCHIVE_DELAY_MS', '');
    const { THREAD_ARCHIVE_DELAY_MS } = await import('../src/config.js');
    expect(THREAD_ARCHIVE_DELAY_MS).toBe(5000);
  });

  it('SHUTDOWN_TIMEOUT_MS usa 10000 como padrão', async () => {
    vi.stubEnv('SHUTDOWN_TIMEOUT_MS', '');
    const { SHUTDOWN_TIMEOUT_MS } = await import('../src/config.js');
    expect(SHUTDOWN_TIMEOUT_MS).toBe(10000);
  });

  it('STATUS_QUEUE_ITEM_TIMEOUT_MS usa 5000 como padrão', async () => {
    vi.stubEnv('STATUS_QUEUE_ITEM_TIMEOUT_MS', '');
    const { STATUS_QUEUE_ITEM_TIMEOUT_MS } = await import('../src/config.js');
    expect(STATUS_QUEUE_ITEM_TIMEOUT_MS).toBe(5000);
  });

  it('STATUS_QUEUE_ITEM_TIMEOUT_MS lê da variável de ambiente', async () => {
    vi.stubEnv('STATUS_QUEUE_ITEM_TIMEOUT_MS', '8000');
    const { STATUS_QUEUE_ITEM_TIMEOUT_MS } = await import('../src/config.js');
    expect(STATUS_QUEUE_ITEM_TIMEOUT_MS).toBe(8000);
  });

  it('CHANNEL_FETCH_TIMEOUT_MS usa 2000 como padrão', async () => {
    vi.stubEnv('CHANNEL_FETCH_TIMEOUT_MS', '');
    const { CHANNEL_FETCH_TIMEOUT_MS } = await import('../src/config.js');
    expect(CHANNEL_FETCH_TIMEOUT_MS).toBe(2000);
  });

  it('CHANNEL_FETCH_TIMEOUT_MS lê da variável de ambiente', async () => {
    vi.stubEnv('CHANNEL_FETCH_TIMEOUT_MS', '3000');
    const { CHANNEL_FETCH_TIMEOUT_MS } = await import('../src/config.js');
    expect(CHANNEL_FETCH_TIMEOUT_MS).toBe(3000);
  });

  it('SERVER_CIRCUIT_BREAKER_COOLDOWN_MS usa 60000 como padrão', async () => {
    vi.stubEnv('SERVER_CIRCUIT_BREAKER_COOLDOWN_MS', '');
    const { SERVER_CIRCUIT_BREAKER_COOLDOWN_MS } = await import('../src/config.js');
    expect(SERVER_CIRCUIT_BREAKER_COOLDOWN_MS).toBe(60000);
  });

  // ─── Strings com padrão ─────────────────────────────────────────────────────

  it('OPENCODE_BIN usa "opencode" como padrão', async () => {
    vi.stubEnv('OPENCODE_BIN', '');
    const { OPENCODE_BIN } = await import('../src/config.js');
    expect(OPENCODE_BIN).toBe('opencode');
  });

  it('OPENCODE_BIN lê caminho customizado da variável de ambiente', async () => {
    vi.stubEnv('OPENCODE_BIN', '/usr/local/bin/opencode');
    const { OPENCODE_BIN } = await import('../src/config.js');
    expect(OPENCODE_BIN).toBe('/usr/local/bin/opencode');
  });

  // ─── validateProjectPath com PROJECTS_BASE customizado ─────────────────────

  it('validateProjectPath aceita projeto dentro do PROJECTS_BASE customizado', async () => {
    vi.stubEnv('PROJECTS_BASE_PATH', '/tmp/base-projetos');
    const { validateProjectPath: validate } = await import('../src/config.js');
    const result = validate('meu-app');
    expect(result.valid).toBe(true);
    expect(result.projectPath).toContain('meu-app');
  });

  it('validateProjectPath rejeita path traversal com PROJECTS_BASE customizado', async () => {
    vi.stubEnv('PROJECTS_BASE_PATH', '/tmp/base-projetos');
    const { validateProjectPath: validate } = await import('../src/config.js');
    const result = validate('../../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('inválido');
  });

  // ─── DEFAULT_MODEL ──────────────────────────────────────────────────────────

  it('DEFAULT_MODEL usa string vazia como padrão', async () => {
    vi.stubEnv('DEFAULT_MODEL', '');
    const { DEFAULT_MODEL } = await import('../src/config.js');
    expect(DEFAULT_MODEL).toBe('');
  });

  it('DEFAULT_MODEL lê da variável de ambiente', async () => {
    vi.stubEnv('DEFAULT_MODEL', 'openai/gpt-4o');
    const { DEFAULT_MODEL } = await import('../src/config.js');
    expect(DEFAULT_MODEL).toBe('openai/gpt-4o');
  });

  // ─── PERMISSION_TIMEOUT_MS ──────────────────────────────────────────────────

  it('PERMISSION_TIMEOUT_MS usa 60000 como padrão', async () => {
    vi.stubEnv('PERMISSION_TIMEOUT_MS', '');
    const { PERMISSION_TIMEOUT_MS } = await import('../src/config.js');
    expect(PERMISSION_TIMEOUT_MS).toBe(60000);
  });

  // ─── MAX_SESSIONS_PER_PROJECT ───────────────────────────────────────────────

  it('MAX_SESSIONS_PER_PROJECT usa 2 como padrão', async () => {
    vi.stubEnv('MAX_SESSIONS_PER_PROJECT', '');
    const { MAX_SESSIONS_PER_PROJECT } = await import('../src/config.js');
    expect(MAX_SESSIONS_PER_PROJECT).toBe(2);
  });

  // ─── AUDIT_LOG_PATH ─────────────────────────────────────────────────────────

  it('AUDIT_LOG_PATH padrão contém .remote-flow e audit.ndjson', async () => {
    vi.stubEnv('AUDIT_LOG_PATH', '');
    const { AUDIT_LOG_PATH } = await import('../src/config.js');
    expect(AUDIT_LOG_PATH).toContain('.remote-flow');
    expect(AUDIT_LOG_PATH).toContain('audit.ndjson');
  });
});
