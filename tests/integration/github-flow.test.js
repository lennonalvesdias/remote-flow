// tests/integration/github-flow.test.js
// Testa o fluxo completo de integração com GitHub: operações git locais,
// criação de Pull Requests e issues via GitHubClient.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks hoisted ────────────────────────────────────────────────────────────

/**
 * Mock assíncrono que substitui execFileAsync criado por promisify(execFile).
 * Definido via vi.hoisted para ser referenciável dentro das factories de vi.mock.
 */
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: vi.fn(() => mockExecFileAsync),
}));

/**
 * Instância mock compartilhada do Octokit.
 * Inclui issues.create além dos métodos do github.test.js unitário.
 */
const mockOctokit = vi.hoisted(() => ({
  rest: {
    users: { getAuthenticated: vi.fn() },
    pulls: {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      listFiles: vi.fn(),
      createReview: vi.fn(),
    },
    issues: {
      create: vi.fn(),
      get: vi.fn(),
      listForRepo: vi.fn(),
    },
  },
}));

vi.mock('octokit', () => ({
  // Deve ser class ou function regular — arrow functions não podem ser construtoras
  Octokit: class {
    constructor() {
      return mockOctokit;
    }
  },
  RequestError: class RequestError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
      this.name = 'RequestError';
    }
  },
}));

// ─── Imports após configuração dos mocks ─────────────────────────────────────

import {
  getRepoInfo,
  hasChanges,
  createBranchAndCommit,
  pushBranch,
} from '../../src/git.js';
import { GitHubClient } from '../../src/github.js';
import { RequestError } from 'octokit';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CWD = '/projetos/meu-repo';

/** Configura próxima chamada a mockExecFileAsync para retornar stdout de sucesso. */
function mockGitSuccess(stdout = '') {
  mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr: '' });
}

/** Configura próxima chamada a mockExecFileAsync para rejeitar simulando erro git. */
function mockGitError(message = 'fatal: error', stderr = 'fatal: error') {
  mockExecFileAsync.mockRejectedValueOnce(
    Object.assign(new Error(message), { stderr }),
  );
}

/** Cria cliente GitHubClient com token de teste padrão. */
function createClient(token = 'ghp_test_token_valid') {
  return new GitHubClient(token);
}

// ─── Operações Git locais ─────────────────────────────────────────────────────

describe('Fluxo de integração com GitHub — Operações Git locais', () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
  });

  it('detecta repositório git e extrai owner/repo da URL remota', async () => {
    mockGitSuccess('https://github.com/owner/repo.git');

    const result = await getRepoInfo(CWD);

    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      remoteUrl: 'https://github.com/owner/repo.git',
    });
  });

  it('detecta se há mudanças não commitadas no repositório', async () => {
    mockGitSuccess('M src/file.js\n');

    const result = await hasChanges(CWD);

    expect(result).toBe(true);
  });

  it('retorna false quando não há mudanças não commitadas', async () => {
    mockGitSuccess('');

    const result = await hasChanges(CWD);

    expect(result).toBe(false);
  });

  it('cria branch e commit na sequência correta de comandos git', async () => {
    mockGitSuccess('M src/feature.js'); // status --porcelain (hasChanges)
    mockGitSuccess();                   // checkout -b
    mockGitSuccess();                   // add --all
    mockGitSuccess();                   // commit -m

    await createBranchAndCommit({
      cwd: CWD,
      branchName: 'feat/nova-feature',
      commitMsg: 'feat: adiciona nova feature',
    });

    const calls = mockExecFileAsync.mock.calls;
    expect(calls[0][1]).toEqual(['status', '--porcelain']);
    expect(calls[1][1]).toEqual(['checkout', '-b', 'feat/nova-feature']);
    expect(calls[2][1]).toEqual(['add', '--all']);
    expect(calls[3][1]).toEqual(['commit', '-m', 'feat: adiciona nova feature']);
  });

  it('executa push com token embutido e restaura URL limpa no finally', async () => {
    mockGitSuccess(); // remote set-url com token
    mockGitSuccess(); // push --set-upstream
    mockGitSuccess(); // remote set-url limpa (finally)

    await pushBranch({
      cwd: CWD,
      branchName: 'feat/nova-feature',
      token: 'ghp_abc123',
      owner: 'owner',
      repo: 'repo',
    });

    const calls = mockExecFileAsync.mock.calls;
    expect(calls[0][1]).toEqual([
      'remote', 'set-url', 'origin',
      'https://ghp_abc123@github.com/owner/repo.git',
    ]);
    expect(calls[1][1]).toEqual(['push', '--set-upstream', 'origin', 'feat/nova-feature']);
    expect(calls[2][1]).toEqual([
      'remote', 'set-url', 'origin',
      'https://github.com/owner/repo.git',
    ]);
  });

  it('restaura URL limpa mesmo quando push falha', async () => {
    mockGitSuccess();                                          // set-url com token
    mockGitError('push rejected', 'error: failed to push'); // push falha
    mockGitSuccess();                                          // set-url limpa (finally)

    await expect(
      pushBranch({
        cwd: CWD,
        branchName: 'feat/nova-feature',
        token: 'ghp_abc123',
        owner: 'owner',
        repo: 'repo',
      }),
    ).rejects.toThrow();

    const lastCall = mockExecFileAsync.mock.calls[2];
    expect(lastCall[1]).toEqual([
      'remote', 'set-url', 'origin',
      'https://github.com/owner/repo.git',
    ]);
  });
});

// ─── Criação de Pull Request ──────────────────────────────────────────────────

describe('Fluxo de integração com GitHub — Criação de Pull Request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const prParams = {
    owner: 'acme',
    repo: 'my-app',
    head: 'feat/nova-feature',
    base: 'main',
    title: 'Test PR',
    body: '## Descrição\n\nAlterações implementadas.',
  };

  it('cria PR no GitHub com título e corpo corretos', async () => {
    const prData = { number: 42, html_url: 'https://github.com/acme/my-app/pull/42', title: 'Test PR' };
    mockOctokit.rest.pulls.create.mockResolvedValueOnce({ data: prData });

    const result = await createClient().createPullRequest(prParams);

    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
        head: 'feat/nova-feature',
        base: 'main',
        title: 'Test PR',
      }),
    );
    expect(result).toEqual(prData);
  });

  it('lista PRs abertas retornando o array da API', async () => {
    const prs = [{ number: 1, title: 'Fix bug' }, { number: 2, title: 'Nova feature' }];
    mockOctokit.rest.pulls.list.mockResolvedValueOnce({ data: prs });

    const result = await createClient().listPullRequests({ owner: 'acme', repo: 'my-app' });

    expect(result).toEqual(prs);
    expect(mockOctokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open' }),
    );
  });

  it('falha graciosamente se token GitHub inválido (401)', async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValueOnce(
      new RequestError('Unauthorized', 401),
    );

    await expect(createClient().verifyAuth()).rejects.toThrow('Token inválido');
  });

  it('encapsula RequestError 403 com mensagem sobre permissões', async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValueOnce(
      new RequestError('Forbidden', 403),
    );

    await expect(createClient().verifyAuth()).rejects.toThrow('Sem permissão');
  });
});

// ─── Criação de Issues ────────────────────────────────────────────────────────

describe('Fluxo de integração com GitHub — Criação de Issues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cria issue com título e corpo retornando dados da issue', async () => {
    const issueData = { number: 7, html_url: 'https://github.com/acme/my-app/issues/7' };
    mockOctokit.rest.issues.create.mockResolvedValueOnce({ data: issueData });

    const result = await createClient().createIssue({
      owner: 'acme',
      repo: 'my-app',
      title: 'Bug: erro na autenticação',
      body: '## Descrição\n\nO login falha com credenciais válidas.',
    });

    expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
        title: 'Bug: erro na autenticação',
      }),
    );
    expect(result).toEqual(issueData);
  });

  it('lista issues abertas filtrando PRs da resposta da API', async () => {
    const items = [
      { number: 10, title: 'Issue real', state: 'open' },
      { number: 11, title: 'PR disfarçado', pull_request: { url: 'https://...' } },
      { number: 12, title: 'Outra issue válida', state: 'open' },
    ];
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: items });

    const result = await createClient().listIssues({ owner: 'acme', repo: 'my-app' });

    expect(result).toHaveLength(2);
    expect(result.every((i) => !i.pull_request)).toBe(true);
    expect(result.map((i) => i.number)).toEqual([10, 12]);
  });

  it('encapsula RequestError 404 quando issue não encontrada', async () => {
    mockOctokit.rest.issues.get.mockRejectedValueOnce(
      new RequestError('Not Found', 404),
    );

    await expect(
      createClient().getIssue({ owner: 'acme', repo: 'my-app', number: 9999 }),
    ).rejects.toThrow('não encontrado');
  });
});
