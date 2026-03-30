// src/git.js
// Utilitários para operações git — branch, commit, push e extração de info do repositório

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ─── Utilitário base ──────────────────────────────────────────────────────────

/**
 * Executa um comando git no diretório especificado.
 * @param {string[]} args - Argumentos do git
 * @param {string} cwd - Diretório de trabalho
 * @returns {Promise<string>} stdout do comando (trimmed)
 */
export async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    if (stderr && stderr.trim() && !stderr.startsWith('warning:') && !stderr.startsWith('hint:')) {
      // git frequentemente escreve info em stderr — não são erros reais
      console.warn(`[git] stderr: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (error) {
    const msg = (error.stderr || error.message || '').trim();
    throw new Error(`[git] Falha ao executar 'git ${args.join(' ')}': ${msg}`);
  }
}

// ─── Informações do repositório ───────────────────────────────────────────────

/**
 * Analisa uma URL git do GitHub e extrai owner e repo.
 * Suporta formatos HTTPS, SSH e HTTPS com token embutido.
 * @param {string} remoteUrl - URL do remote git
 * @returns {{ owner: string, repo: string }}
 */
export function parseGitHubUrl(remoteUrl) {
  // Formato SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Formato HTTPS: https://github.com/owner/repo.git
  //            ou: https://TOKEN@github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  throw new Error(
    `[git] Não foi possível extrair owner/repo da URL: "${remoteUrl}". ` +
      'Verifique se o remote "origin" aponta para o GitHub.',
  );
}

/**
 * Obtém owner e repo do repositório GitHub no diretório especificado.
 * @param {string} cwd - Diretório do repositório local
 * @returns {Promise<{ owner: string, repo: string, remoteUrl: string }>}
 */
export async function getRepoInfo(cwd) {
  let remoteUrl;
  try {
    remoteUrl = await git(['remote', 'get-url', 'origin'], cwd);
  } catch {
    // Fallback para versões mais antigas do git
    remoteUrl = await git(['config', '--get', 'remote.origin.url'], cwd);
  }

  if (!remoteUrl) {
    throw new Error('[git] Repositório não tem remote "origin" configurado.');
  }

  const { owner, repo } = parseGitHubUrl(remoteUrl);
  return { owner, repo, remoteUrl };
}

// ─── Estado do repositório ────────────────────────────────────────────────────

/**
 * Verifica se há alterações não commitadas no repositório.
 * @param {string} cwd - Diretório do repositório
 * @returns {Promise<boolean>}
 */
export async function hasChanges(cwd) {
  const status = await git(['status', '--porcelain'], cwd);
  return status.length > 0;
}

/**
 * Retorna o nome do branch atual.
 * @param {string} cwd - Diretório do repositório
 * @returns {Promise<string>}
 */
export async function getCurrentBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * Retorna o hash curto e a mensagem do último commit.
 * @param {string} cwd - Diretório do repositório
 * @returns {Promise<{ hash: string, subject: string }>}
 */
export async function getLastCommit(cwd) {
  try {
    const output = await git(['log', '-1', '--format=%h|%s'], cwd);
    const pipeIndex = output.indexOf('|');
    if (pipeIndex === -1) return { hash: output.slice(0, 7) || 'unknown', subject: '' };
    const hash = output.slice(0, pipeIndex);
    const subject = output.slice(pipeIndex + 1);
    return { hash, subject };
  } catch {
    return { hash: 'unknown', subject: '' };
  }
}

// ─── Operações de branch e commit ─────────────────────────────────────────────

/**
 * Cria um novo branch e realiza um commit com todas as alterações.
 * Configura identidade do autor antes do commit para ambientes headless.
 * @param {object} opts
 * @param {string} opts.cwd - Diretório do repositório
 * @param {string} opts.branchName - Nome do branch a criar
 * @param {string} opts.commitMsg - Mensagem do commit
 * @param {string} [opts.authorName] - Nome do autor (padrão: config global do git)
 * @param {string} [opts.authorEmail] - Email do autor (padrão: config global do git)
 * @returns {Promise<void>}
 */
export async function createBranchAndCommit({ cwd, branchName, commitMsg, authorName, authorEmail }) {
  // Verificar alterações pendentes
  if (!(await hasChanges(cwd))) {
    throw new Error('[git] Nenhuma alteração para commitar.');
  }

  // Criar e mudar para o novo branch
  await git(['checkout', '-b', branchName], cwd);

  // Adicionar todas as alterações
  await git(['add', '--all'], cwd);

  // Configurar identidade do autor (necessário em ambientes headless/Windows)
  if (authorName) await git(['config', 'user.name', authorName], cwd);
  if (authorEmail) await git(['config', 'user.email', authorEmail], cwd);

  // Realizar o commit
  await git(['commit', '-m', commitMsg], cwd);
}

// ─── Push ─────────────────────────────────────────────────────────────────────

/**
 * Faz push do branch para o remote origin, usando autenticação via token.
 * Remove o token da URL após o push para manter segurança.
 * @param {object} opts
 * @param {string} opts.cwd - Diretório do repositório
 * @param {string} opts.branchName - Nome do branch a enviar
 * @param {string} opts.token - Personal Access Token do GitHub
 * @param {string} opts.owner - Dono do repositório no GitHub
 * @param {string} opts.repo - Nome do repositório no GitHub
 * @returns {Promise<void>}
 */
export async function pushBranch({ cwd, branchName, token, owner, repo }) {
  const tokenUrl = `https://${token}@github.com/${owner}/${repo}.git`;
  const cleanUrl = `https://github.com/${owner}/${repo}.git`;

  try {
    // Configurar URL com token para autenticação
    await git(['remote', 'set-url', 'origin', tokenUrl], cwd);
    // Enviar branch
    await git(['push', '--set-upstream', 'origin', branchName], cwd);
  } finally {
    // Sempre restaurar URL sem token (mesmo em caso de erro)
    try {
      await git(['remote', 'set-url', 'origin', cleanUrl], cwd);
    } catch (cleanErr) {
      console.warn('[git] ⚠️ Não foi possível restaurar URL limpa do remote:', cleanErr.message);
    }
  }
}
