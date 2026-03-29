// tests/helpers/fs-mocks.js
// Filesystem virtual em memória para testes que dependem de fs/promises.
// Nenhuma operação real de I/O é realizada — tudo persiste em Maps internos.

// ─── Utilitário de normalização de caminhos ───────────────────────────────────

/**
 * Normaliza separadores de caminho para forward slashes, removendo redundâncias.
 * Garante consistência entre Windows e Unix nos caminhos da FS virtual.
 * @param {string} p - Caminho a normalizar
 * @returns {string} Caminho normalizado com forward slashes
 */
function normalizePath(p) {
  // Substitui backslashes por forward slashes e remove trailing slash
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Lança um erro ENOENT padronizado para caminhos não encontrados.
 * @param {string} filePath - Caminho que não foi encontrado
 * @throws {Error} Erro com código ENOENT
 */
function throwEnoent(filePath) {
  const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`)
  err.code = 'ENOENT'
  err.path = filePath
  throw err
}

// ─── createFsMock ─────────────────────────────────────────────────────────────

/**
 * Cria um filesystem virtual em memória compatível com fs/promises.
 * Suporta readFile, writeFile, appendFile, mkdir, readdir, stat, access e rm.
 * @param {Object} [initialFiles={}] - Arquivos iniciais { 'caminho/arquivo': 'conteúdo' }
 * @returns {{ mock: Object, addFile: Function, readFile: Function, reset: Function }}
 */
export function createFsMock(initialFiles = {}) {
  // Armazena arquivos: caminho normalizado → conteúdo como string
  const fileStore = new Map()
  // Armazena diretórios conhecidos: caminhos normalizados
  const dirStore = new Set()

  /**
   * Registra todos os diretórios pai de um caminho de arquivo.
   * @param {string} normalizedPath - Caminho de arquivo já normalizado
   */
  function registerParentDirs(normalizedPath) {
    const parts = normalizedPath.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      dirStore.add(parts.slice(0, depth).join('/'))
    }
  }

  /**
   * Carrega o estado inicial a partir de initialFiles.
   */
  function loadInitialFiles() {
    fileStore.clear()
    dirStore.clear()
    for (const [filePath, content] of Object.entries(initialFiles)) {
      const normalized = normalizePath(filePath)
      fileStore.set(normalized, String(content))
      registerParentDirs(normalized)
    }
  }

  loadInitialFiles()

  // ─── Interface fs/promises ──────────────────────────────────────────────────

  const mock = {
    /**
     * Lê o conteúdo de um arquivo.
     * Retorna string quando encoding é especificado, Buffer caso contrário.
     * @param {string} filePath - Caminho do arquivo
     * @param {string|Object} [opts] - Encoding como string ou { encoding }
     * @returns {Promise<string|Buffer>}
     */
    async readFile(filePath, opts) {
      const normalized = normalizePath(String(filePath))
      if (!fileStore.has(normalized)) throwEnoent(filePath)

      const content = fileStore.get(normalized)
      const encoding = typeof opts === 'string' ? opts : (opts?.encoding ?? null)

      return encoding !== null
        ? String(content)
        : Buffer.from(String(content))
    },

    /**
     * Escreve (sobrescreve) dados em um arquivo.
     * Cria o arquivo se não existir, registrando diretórios pai automaticamente.
     * @param {string} filePath - Caminho do arquivo
     * @param {string|Buffer} data - Dados a escrever
     * @returns {Promise<void>}
     */
    async writeFile(filePath, data) {
      const normalized = normalizePath(String(filePath))
      const content = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
      registerParentDirs(normalized)
      fileStore.set(normalized, content)
    },

    /**
     * Adiciona dados ao final de um arquivo existente (cria se não existir).
     * @param {string} filePath - Caminho do arquivo
     * @param {string|Buffer} data - Dados a adicionar
     * @returns {Promise<void>}
     */
    async appendFile(filePath, data) {
      const normalized = normalizePath(String(filePath))
      const existing = fileStore.get(normalized) ?? ''
      const toAppend = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
      registerParentDirs(normalized)
      fileStore.set(normalized, existing + toAppend)
    },

    /**
     * Cria um diretório. Lança EEXIST quando não-recursivo e já existir.
     * @param {string} dirPath - Caminho do diretório a criar
     * @param {Object} [opts] - Opções (recursive: bool)
     * @returns {Promise<void>}
     */
    async mkdir(dirPath, opts) {
      const normalized = normalizePath(String(dirPath))
      const alreadyExists = dirStore.has(normalized) || fileStore.has(normalized)

      if (alreadyExists && !opts?.recursive) {
        const err = new Error(`EEXIST: file already exists, mkdir '${dirPath}'`)
        err.code = 'EEXIST'
        throw err
      }

      // Modo recursivo: cria todos os segmentos intermediários
      if (opts?.recursive) {
        const parts = normalized.split('/')
        for (let depth = 1; depth <= parts.length; depth++) {
          dirStore.add(parts.slice(0, depth).join('/'))
        }
        return
      }

      dirStore.add(normalized)
    },

    /**
     * Lista entradas de um diretório (primeiro nível apenas).
     * @param {string} dirPath - Caminho do diretório
     * @returns {Promise<string[]>} Nomes das entradas (sem caminho completo)
     */
    async readdir(dirPath) {
      const normalized = normalizePath(String(dirPath))
      const prefix = normalized + '/'
      const entries = new Set()

      for (const filePath of fileStore.keys()) {
        if (filePath.startsWith(prefix)) {
          entries.add(filePath.slice(prefix.length).split('/')[0])
        }
      }
      for (const dir of dirStore) {
        if (dir.startsWith(prefix)) {
          entries.add(dir.slice(prefix.length).split('/')[0])
        }
      }

      return [...entries]
    },

    /**
     * Retorna metadados de um arquivo ou diretório.
     * @param {string} filePath - Caminho a inspecionar
     * @returns {Promise<{ isFile: Function, isDirectory: Function, size: number, mtime: Date }>}
     */
    async stat(filePath) {
      const normalized = normalizePath(String(filePath))
      const isFile = fileStore.has(normalized)
      const isDir = !isFile && dirStore.has(normalized)

      if (!isFile && !isDir) throwEnoent(filePath)

      const content = fileStore.get(normalized) ?? ''
      const size = Buffer.byteLength(String(content), 'utf-8')

      return {
        isFile: () => isFile,
        isDirectory: () => isDir,
        size,
        mtime: new Date(),
      }
    },

    /**
     * Verifica se um caminho existe. Lança ENOENT se não encontrado.
     * @param {string} filePath - Caminho a verificar
     * @returns {Promise<void>}
     */
    async access(filePath) {
      const normalized = normalizePath(String(filePath))
      const exists = fileStore.has(normalized) || dirStore.has(normalized)
      if (!exists) throwEnoent(filePath)
    },

    /**
     * Remove um arquivo ou diretório (com suporte a recursive e force).
     * @param {string} filePath - Caminho a remover
     * @param {Object} [opts] - Opções (recursive: bool, force: bool)
     * @returns {Promise<void>}
     */
    async rm(filePath, opts) {
      const normalized = normalizePath(String(filePath))
      const exists = fileStore.has(normalized) || dirStore.has(normalized)

      if (!exists) {
        if (!opts?.force) throwEnoent(filePath)
        return
      }

      fileStore.delete(normalized)
      dirStore.delete(normalized)

      if (opts?.recursive) {
        const prefix = normalized + '/'
        for (const key of [...fileStore.keys()]) {
          if (key.startsWith(prefix)) fileStore.delete(key)
        }
        for (const key of [...dirStore]) {
          if (key.startsWith(prefix)) dirStore.delete(key)
        }
      }
    },
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  return {
    mock,

    /**
     * Adiciona ou atualiza um arquivo no filesystem virtual.
     * @param {string} filePath - Caminho do arquivo
     * @param {string} content - Conteúdo a armazenar
     */
    addFile(filePath, content) {
      const normalized = normalizePath(filePath)
      fileStore.set(normalized, String(content))
      registerParentDirs(normalized)
    },

    /**
     * Lê o conteúdo atual de um arquivo no filesystem virtual (síncrono).
     * Retorna undefined se o arquivo não existir.
     * @param {string} filePath - Caminho do arquivo
     * @returns {string|undefined} Conteúdo do arquivo
     */
    readFile(filePath) {
      return fileStore.get(normalizePath(filePath))
    },

    /**
     * Reseta o filesystem virtual para o estado de initialFiles.
     */
    reset() {
      loadInitialFiles()
    },
  }
}
