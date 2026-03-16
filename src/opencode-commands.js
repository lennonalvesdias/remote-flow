// src/opencode-commands.js
// Utilitário para listar comandos customizados do opencode do sistema de arquivos

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Retorna o diretório de comandos do opencode.
 * Usa a variável de ambiente OPENCODE_COMMANDS_PATH se definida,
 * caso contrário usa o caminho padrão ~/.config/opencode/command.
 * @returns {string}
 */
export function getCommandsDir() {
  return process.env.OPENCODE_COMMANDS_PATH || join(homedir(), '.config', 'opencode', 'command');
}

/**
 * @typedef {Object} OpenCodeCommand
 * @property {string} name - Nome do comando (sem extensão .md)
 * @property {string} description - Descrição extraída do frontmatter YAML (ou nome como fallback)
 * @property {string} filePath - Caminho absoluto do arquivo .md
 */

/**
 * Lista todos os comandos opencode disponíveis no diretório de comandos.
 * Retorna [] se o diretório não existir, estiver vazio ou ocorrer algum erro.
 * @returns {Promise<OpenCodeCommand[]>}
 */
export async function listOpenCodeCommands() {
  const dir = getCommandsDir();

  // Lê o diretório — retorna [] de forma silenciosa se não existir
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[OpenCodeCommands] ⚠️ Erro ao listar diretório de comandos:', err.message);
    }
    return [];
  }

  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));

  if (mdFiles.length === 0) return [];

  const commands = await Promise.all(
    mdFiles.map(async (entry) => {
      const filePath = join(dir, entry.name);
      const name = entry.name.slice(0, -3); // Remove extensão .md

      let description = name; // Fallback: usa o próprio nome
      try {
        const content = await readFile(filePath, 'utf8');
        description = extractDescription(content) ?? name;
      } catch (err) {
        console.warn('[OpenCodeCommands] ⚠️ Erro ao ler arquivo %s:', entry.name, err.message);
      }

      return { name, description, filePath };
    })
  );

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Utilitários internos ─────────────────────────────────────────────────────

/**
 * Extrai o campo `description` do frontmatter YAML de um arquivo Markdown.
 * Usa regex simples — não requer parser YAML externo.
 * @param {string} content - Conteúdo completo do arquivo .md
 * @returns {string | null} Descrição extraída, ou null se não encontrada
 */
function extractDescription(content) {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const descriptionMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  if (!descriptionMatch) return null;

  return descriptionMatch[1].trim() || null;
}
