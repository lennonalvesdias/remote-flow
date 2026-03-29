// tests/github.test.js
// Testes unitários para src/github.js — cliente GitHub (Octokit wrapper)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock de octokit (hoisted) ────────────────────────────────────────────────

/**
 * Instância mock compartilhada do Octokit.
 * Definida via vi.hoisted para ser acessível dentro do factory de vi.mock.
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
      get: vi.fn(),
      listForRepo: vi.fn(),
      create: vi.fn(),
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

import { GitHubClient } from '../src/github.js';
import { RequestError } from 'octokit';

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Cria cliente com token de teste padrão. */
function createClient(token = 'ghp_test_token_valid') {
  return new GitHubClient(token);
}

// ─── getGitHubClient — singleton e warnings ───────────────────────────────────

describe('getGitHubClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retorna a mesma instância em chamadas repetidas (singleton)', async () => {
    vi.doMock('../src/config.js', () => ({ GITHUB_TOKEN: 'ghp_singleton_test' }));
    const { getGitHubClient } = await import('../src/github.js');

    const inst1 = getGitHubClient();
    const inst2 = getGitHubClient();

    expect(inst1).toBe(inst2);
  });

  it('emite console.warn quando GITHUB_TOKEN está vazio', async () => {
    vi.doMock('../src/config.js', () => ({ GITHUB_TOKEN: '' }));
    const { getGitHubClient } = await import('../src/github.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getGitHubClient();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
  });

  it('não emite console.warn quando token está presente', async () => {
    vi.doMock('../src/config.js', () => ({ GITHUB_TOKEN: 'ghp_valido' }));
    const { getGitHubClient } = await import('../src/github.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getGitHubClient();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── GitHubClient.verifyAuth ──────────────────────────────────────────────────

describe('GitHubClient.verifyAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lança Error descritivo quando token não está configurado', async () => {
    const client = new GitHubClient('');

    await expect(client.verifyAuth()).rejects.toThrow('GITHUB_TOKEN');
  });

  it('retorna { login } em caso de sucesso', async () => {
    mockOctokit.rest.users.getAuthenticated.mockResolvedValueOnce({
      data: { login: 'octocat' },
    });
    const client = createClient();

    const result = await client.verifyAuth();

    expect(result).toEqual({ login: 'octocat' });
  });

  it('encapsula RequestError 401 com mensagem amigável sobre token inválido', async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValueOnce(
      new RequestError('Unauthorized', 401),
    );
    const client = createClient();

    await expect(client.verifyAuth()).rejects.toThrow('Token inválido');
  });

  it('encapsula RequestError 403 com mensagem amigável sobre permissões', async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValueOnce(
      new RequestError('Forbidden', 403),
    );
    const client = createClient();

    await expect(client.verifyAuth()).rejects.toThrow('Sem permissão');
  });
});

// ─── GitHubClient.createPullRequest ──────────────────────────────────────────

describe('GitHubClient.createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const prParams = {
    owner: 'acme',
    repo: 'my-app',
    head: 'feat/nova-feature',
    base: 'main',
    title: 'Adiciona nova feature',
    body: '## Descrição\n\nAlterações implementadas.',
    draft: false,
  };

  it('chama octokit.rest.pulls.create com os parâmetros corretos', async () => {
    mockOctokit.rest.pulls.create.mockResolvedValueOnce({ data: { number: 42 } });
    const client = createClient();

    await client.createPullRequest(prParams);

    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
        head: 'feat/nova-feature',
        base: 'main',
        title: 'Adiciona nova feature',
        maintainer_can_modify: true,
      }),
    );
  });

  it('retorna os dados do PR criado', async () => {
    const prData = { number: 42, html_url: 'https://github.com/acme/my-app/pull/42' };
    mockOctokit.rest.pulls.create.mockResolvedValueOnce({ data: prData });
    const client = createClient();

    const result = await client.createPullRequest(prParams);

    expect(result).toEqual(prData);
  });

  it('encapsula RequestError 422 com mensagem de contexto sobre PR duplicado', async () => {
    mockOctokit.rest.pulls.create.mockRejectedValueOnce(
      new RequestError('Unprocessable Entity', 422),
    );
    const client = createClient();

    await expect(client.createPullRequest(prParams)).rejects.toThrow('PR');
  });

  it('usa draft: false como padrão quando não especificado', async () => {
    mockOctokit.rest.pulls.create.mockResolvedValueOnce({ data: { number: 1 } });
    const client = createClient();

    await client.createPullRequest({
      owner: 'acme', repo: 'my-app',
      head: 'feat/x', base: 'main', title: 'Test',
    });

    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ draft: false }),
    );
  });
});

// ─── GitHubClient.listPullRequests ────────────────────────────────────────────

describe('GitHubClient.listPullRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama com state, sort, direction e per_page corretos', async () => {
    mockOctokit.rest.pulls.list.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listPullRequests({ owner: 'acme', repo: 'my-app', state: 'closed', perPage: 10 });

    expect(mockOctokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 10,
      }),
    );
  });

  it('retorna o array de PRs da resposta da API', async () => {
    const prs = [{ number: 1, title: 'Fix A' }, { number: 2, title: 'Fix B' }];
    mockOctokit.rest.pulls.list.mockResolvedValueOnce({ data: prs });
    const client = createClient();

    const result = await client.listPullRequests({ owner: 'acme', repo: 'my-app' });

    expect(result).toEqual(prs);
  });

  it('usa state "open" como padrão quando não especificado', async () => {
    mockOctokit.rest.pulls.list.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listPullRequests({ owner: 'acme', repo: 'my-app' });

    expect(mockOctokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open' }),
    );
  });
});

// ─── GitHubClient.getPullRequest ─────────────────────────────────────────────

describe('GitHubClient.getPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama com pull_number (não "number") na requisição à API', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: { number: 7 } });
    const client = createClient();

    await client.getPullRequest({ owner: 'acme', repo: 'my-app', number: 7 });

    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7 }),
    );
  });

  it('retorna os dados do PR', async () => {
    const prData = { number: 7, title: 'Fix bug crítico', state: 'open' };
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: prData });
    const client = createClient();

    const result = await client.getPullRequest({ owner: 'acme', repo: 'my-app', number: 7 });

    expect(result).toEqual(prData);
  });

  it('encapsula RequestError 404 quando PR não é encontrado', async () => {
    mockOctokit.rest.pulls.get.mockRejectedValueOnce(
      new RequestError('Not Found', 404),
    );
    const client = createClient();

    await expect(
      client.getPullRequest({ owner: 'acme', repo: 'my-app', number: 999 }),
    ).rejects.toThrow('não encontrado');
  });
});

// ─── GitHubClient.getPullRequestDiff ─────────────────────────────────────────

describe('GitHubClient.getPullRequestDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama octokit.rest.pulls.get com mediaType: { format: "diff" }', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({
      data: '--- a/file\n+++ b/file\n',
    });
    const client = createClient();

    await client.getPullRequestDiff({ owner: 'acme', repo: 'my-app', number: 5 });

    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: { format: 'diff' } }),
    );
  });

  it('retorna o diff unificado como string', async () => {
    const diffContent = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1,2 @@\n+nova linha';
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: diffContent });
    const client = createClient();

    const result = await client.getPullRequestDiff({ owner: 'acme', repo: 'my-app', number: 5 });

    expect(result).toBe(diffContent);
  });

  it('retorna string mesmo quando API retorna tipo não-string', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: 12345 });
    const client = createClient();

    const result = await client.getPullRequestDiff({ owner: 'acme', repo: 'my-app', number: 5 });

    expect(typeof result).toBe('string');
    expect(result).toBe('12345');
  });
});

// ─── GitHubClient.getPullRequestFiles ────────────────────────────────────────

describe('GitHubClient.getPullRequestFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama listFiles com per_page: 100', async () => {
    mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.getPullRequestFiles({ owner: 'acme', repo: 'my-app', number: 3 });

    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 }),
    );
  });

  it('chama com pull_number correto', async () => {
    mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.getPullRequestFiles({ owner: 'acme', repo: 'my-app', number: 3 });

    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 3 }),
    );
  });

  it('retorna o array de arquivos alterados no PR', async () => {
    const files = [
      { filename: 'src/index.js', status: 'modified', additions: 5, deletions: 2 },
      { filename: 'src/utils.js', status: 'added', additions: 30, deletions: 0 },
    ];
    mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: files });
    const client = createClient();

    const result = await client.getPullRequestFiles({ owner: 'acme', repo: 'my-app', number: 3 });

    expect(result).toEqual(files);
  });
});

// ─── GitHubClient.createReview ───────────────────────────────────────────────

describe('GitHubClient.createReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseReviewParams = {
    owner: 'acme',
    repo: 'my-app',
    number: 10,
    commitId: 'abc123sha456',
    body: 'Revisão geral: código bem organizado.',
    event: 'COMMENT',
    comments: [],
  };

  it('chama com commit_id (não "commitId") na requisição à API', async () => {
    mockOctokit.rest.pulls.createReview.mockResolvedValueOnce({ data: { id: 1 } });
    const client = createClient();

    await client.createReview(baseReviewParams);

    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: 'abc123sha456' }),
    );
  });

  it('cria review com evento APPROVE e retorna dados do review', async () => {
    const reviewData = { id: 2, state: 'APPROVED' };
    mockOctokit.rest.pulls.createReview.mockResolvedValueOnce({ data: reviewData });
    const client = createClient();

    const result = await client.createReview({ ...baseReviewParams, event: 'APPROVE' });

    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
    expect(result.state).toBe('APPROVED');
  });

  it('cria review com evento REQUEST_CHANGES', async () => {
    mockOctokit.rest.pulls.createReview.mockResolvedValueOnce({
      data: { id: 3, state: 'CHANGES_REQUESTED' },
    });
    const client = createClient();

    await client.createReview({ ...baseReviewParams, event: 'REQUEST_CHANGES' });

    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES' }),
    );
  });

  it('cria review com evento COMMENT (padrão) corretamente', async () => {
    mockOctokit.rest.pulls.createReview.mockResolvedValueOnce({ data: { id: 4 } });
    const client = createClient();

    await client.createReview(baseReviewParams);

    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'COMMENT' }),
    );
  });

  it('inclui pull_number correto na requisição', async () => {
    mockOctokit.rest.pulls.createReview.mockResolvedValueOnce({ data: { id: 5 } });
    const client = createClient();

    await client.createReview(baseReviewParams);

    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 10 }),
    );
  });
});

// ─── GitHubClient.getIssue ───────────────────────────────────────────────────

describe('GitHubClient.getIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama com issue_number (não "number") na requisição à API', async () => {
    mockOctokit.rest.issues.get.mockResolvedValueOnce({ data: { number: 15 } });
    const client = createClient();

    await client.getIssue({ owner: 'acme', repo: 'my-app', number: 15 });

    expect(mockOctokit.rest.issues.get).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 15 }),
    );
  });

  it('retorna os dados da issue', async () => {
    const issueData = { number: 15, title: 'Bug crítico na autenticação', state: 'open' };
    mockOctokit.rest.issues.get.mockResolvedValueOnce({ data: issueData });
    const client = createClient();

    const result = await client.getIssue({ owner: 'acme', repo: 'my-app', number: 15 });

    expect(result).toEqual(issueData);
  });

  it('encapsula RequestError 404 quando issue não é encontrada', async () => {
    mockOctokit.rest.issues.get.mockRejectedValueOnce(
      new RequestError('Not Found', 404),
    );
    const client = createClient();

    await expect(
      client.getIssue({ owner: 'acme', repo: 'my-app', number: 9999 }),
    ).rejects.toThrow('não encontrado');
  });
});

// ─── GitHubClient.listIssues ─────────────────────────────────────────────────

describe('GitHubClient.listIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filtra itens com propriedade pull_request da resposta da API', async () => {
    const items = [
      { number: 1, title: 'Bug real', state: 'open' },
      { number: 2, title: 'Um PR misturado', pull_request: { url: 'https://...' } },
      { number: 3, title: 'Outra issue válida', state: 'open' },
    ];
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: items });
    const client = createClient();

    const result = await client.listIssues({ owner: 'acme', repo: 'my-app' });

    expect(result).toHaveLength(2);
    expect(result.every((i) => !i.pull_request)).toBe(true);
  });

  it('inclui labels na requisição quando parâmetro não está vazio', async () => {
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listIssues({ owner: 'acme', repo: 'my-app', labels: 'bug,urgent' });

    expect(mockOctokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ labels: 'bug,urgent' }),
    );
  });

  it('não inclui labels na requisição quando parâmetro está vazio', async () => {
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listIssues({ owner: 'acme', repo: 'my-app', labels: '' });

    const callArgs = mockOctokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('labels');
  });

  it('retorna apenas issues puras — zero PRs no resultado', async () => {
    const items = [
      { number: 10, title: 'Issue legítima' },
      { number: 11, title: 'PR disfarçado', pull_request: {} },
      { number: 12, title: 'Outro PR', pull_request: { merged_at: null } },
    ];
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: items });
    const client = createClient();

    const result = await client.listIssues({ owner: 'acme', repo: 'my-app', state: 'all' });

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(10);
  });

  it('usa state "open" como padrão quando não especificado', async () => {
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listIssues({ owner: 'acme', repo: 'my-app' });

    expect(mockOctokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open' }),
    );
  });

  it('chama com sort: "updated" e direction: "desc"', async () => {
    mockOctokit.rest.issues.listForRepo.mockResolvedValueOnce({ data: [] });
    const client = createClient();

    await client.listIssues({ owner: 'acme', repo: 'my-app' });

    expect(mockOctokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'updated', direction: 'desc' }),
    );
  });
});

// ─── GitHubClient — caminhos de erro restantes ───────────────────────────────

describe('GitHubClient — caminhos de erro restantes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listPullRequests() lança RequestError encapsulado com mensagem amigável', async () => {
    mockOctokit.rest.pulls.list.mockRejectedValueOnce(new RequestError('Forbidden', 403));
    const client = createClient();

    await expect(client.listPullRequests({ owner: 'a', repo: 'b' })).rejects.toThrow('Sem permissão');
  });

  it('getPullRequestDiff() lança RequestError encapsulado quando API falha', async () => {
    mockOctokit.rest.pulls.get.mockRejectedValueOnce(new RequestError('Not Found', 404));
    const client = createClient();

    await expect(client.getPullRequestDiff({ owner: 'a', repo: 'b', number: 1 })).rejects.toThrow('não encontrado');
  });

  it('getPullRequestFiles() lança RequestError encapsulado quando API falha', async () => {
    mockOctokit.rest.pulls.listFiles.mockRejectedValueOnce(new RequestError('Not Found', 404));
    const client = createClient();

    await expect(client.getPullRequestFiles({ owner: 'a', repo: 'b', number: 1 })).rejects.toThrow('não encontrado');
  });

  it('createReview() lança RequestError encapsulado quando dados são inválidos', async () => {
    mockOctokit.rest.pulls.createReview.mockRejectedValueOnce(new RequestError('Unprocessable Entity', 422));
    const client = createClient();

    await expect(
      client.createReview({ owner: 'a', repo: 'b', number: 1, commitId: 'abc', body: '', event: 'COMMENT', comments: [] }),
    ).rejects.toThrow('inválidos');
  });

  it('createIssue() cria issue com sucesso e retorna dados da issue criada', async () => {
    mockOctokit.rest.issues.create.mockResolvedValueOnce({ data: { number: 5, title: 'Bug reportado' } });
    const client = createClient();

    const result = await client.createIssue({ owner: 'a', repo: 'b', title: 'Bug reportado' });

    expect(result.number).toBe(5);
    expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'a', repo: 'b', title: 'Bug reportado' }),
    );
  });

  it('createIssue() lança RequestError encapsulado com contexto "criar issue"', async () => {
    mockOctokit.rest.issues.create.mockRejectedValueOnce(new RequestError('Not Found', 404));
    const client = createClient();

    await expect(client.createIssue({ owner: 'a', repo: 'b', title: 'Bug' })).rejects.toThrow('criar issue');
  });

  it('listIssues() lança RequestError encapsulado com contexto "listar issues"', async () => {
    mockOctokit.rest.issues.listForRepo.mockRejectedValueOnce(new RequestError('Forbidden', 403));
    const client = createClient();

    await expect(client.listIssues({ owner: 'a', repo: 'b' })).rejects.toThrow('listar issues');
  });

  it('_wrapError() propaga o Error original quando não é RequestError', async () => {
    const originalError = new Error('network failure');
    mockOctokit.rest.pulls.list.mockRejectedValueOnce(originalError);
    const client = createClient();

    await expect(client.listPullRequests({ owner: 'a', repo: 'b' })).rejects.toBe(originalError);
  });
});
