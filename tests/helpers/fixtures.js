// tests/helpers/fixtures.js
// Dados de teste compartilhados: fábricas de eventos SSE, configurações de sessão
// e payloads Discord usados em toda a suíte de testes de integração.

// ─── Constantes de projeto ─────────────────────────────────────────────────────

/** Nome do projeto padrão usado em testes */
export const PROJECT_NAME = 'test-project'

/** Caminho absoluto do projeto padrão (usa forward slashes para compatibilidade) */
export const PROJECT_PATH = '/projects/test-project'

/** ID do usuário principal nos testes */
export const USER_ID = 'user-123'

/** ID de um segundo usuário para testes de multiusuário */
export const USER_ID_2 = 'user-456'

/** ID da thread Discord padrão nos testes */
export const THREAD_ID = 'thread-789'

/** ID interno de sessão do SessionManager */
export const SESSION_ID = 'session-abc'

/** ID de sessão retornado pela API opencode */
export const API_SESSION_ID = 'api-session-xyz'

/** ID do guild (servidor) Discord padrão */
export const GUILD_ID = 'guild-001'

// ─── Fábricas de eventos SSE ───────────────────────────────────────────────────

/**
 * Conjunto de fábricas para criar objetos de eventos SSE do opencode.
 * Cada método retorna um objeto { type, data } compatível com handleSSEEvent.
 */
export const sseEvents = {
  /**
   * Cria evento SSE de delta de texto de mensagem.
   * @param {string} sessionId - ID da sessão opencode
   * @param {string} text - Trecho de texto emitido pelo agente
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  messageDelta(sessionId, text) {
    return {
      type: 'message.part.delta',
      data: {
        sessionId,
        part: { type: 'text', text },
      },
    }
  },

  /**
   * Cria evento SSE de atualização de status de sessão.
   * @param {string} sessionId - ID da sessão opencode
   * @param {string} status - Novo status (running|idle|waiting_input|finished|error)
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  sessionStatus(sessionId, status) {
    return {
      type: 'session.status',
      data: { sessionId, status },
    }
  },

  /**
   * Cria evento SSE de permissão solicitada pelo agente.
   * @param {string} sessionId - ID da sessão opencode
   * @param {Object} [opts={}] - Opções da permissão
   * @param {string} [opts.permissionId='perm-1'] - ID único da permissão
   * @param {string} [opts.toolName='write_file'] - Ferramenta que solicita permissão
   * @param {string} [opts.description] - Descrição da operação solicitada
   * @param {string} [opts.path='/some/path'] - Caminho afetado
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  permissionAsked(sessionId, opts = {}) {
    return {
      type: 'permission.asked',
      data: {
        sessionId,
        permissionId: opts.permissionId ?? 'perm-1',
        toolName: opts.toolName ?? 'write_file',
        description: opts.description ?? 'Escrever arquivo de configuração',
        path: opts.path ?? '/some/path',
      },
    }
  },

  /**
   * Cria evento SSE de pergunta do agente ao usuário.
   * @param {string} sessionId - ID da sessão opencode
   * @param {Object} [opts={}] - Opções da pergunta
   * @param {string} [opts.questionId='q-1'] - ID único da pergunta
   * @param {Array}  [opts.questions] - Lista de perguntas com texto e opções
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  questionAsked(sessionId, opts = {}) {
    return {
      type: 'question.asked',
      data: {
        sessionId,
        questionId: opts.questionId ?? 'q-1',
        questions: opts.questions ?? [{ text: 'Continue?', options: ['yes', 'no'] }],
      },
    }
  },

  /**
   * Cria evento SSE de diff de arquivo gerado pelo agente.
   * @param {string} sessionId - ID da sessão opencode
   * @param {string} [diff] - Conteúdo do diff unificado
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  sessionDiff(sessionId, diff) {
    return {
      type: 'session.diff',
      data: {
        sessionId,
        diff: diff ?? '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
      },
    }
  },

  /**
   * Cria evento SSE de delta de raciocínio interno do agente.
   * Usa type 'message.part.delta' com part.type='reasoning'.
   * @param {string} sessionId - ID da sessão opencode
   * @param {string} text - Trecho do raciocínio emitido
   * @returns {{ type: string, data: Object }} Evento SSE
   */
  reasoningDelta(sessionId, text) {
    return {
      type: 'message.part.delta',
      data: {
        sessionId,
        part: { type: 'reasoning', text },
      },
    }
  },
}

// ─── Fábricas de configuração de sessão ───────────────────────────────────────

/**
 * Cria uma configuração de sessão com valores padrão substituíveis.
 * @param {Object} [overrides={}] - Campos a sobrescrever no objeto padrão
 * @returns {{ sessionId: string, projectPath: string, threadId: string, userId: string, agent: string, model: string|null }}
 */
export function sessionConfig(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    projectPath: PROJECT_PATH,
    threadId: THREAD_ID,
    userId: USER_ID,
    agent: 'coder',
    model: null,
    ...overrides,
  }
}

/**
 * Cria a configuração padrão do bot RemoteFlow.
 * @returns {Object} Objeto de configuração com valores padrão de desenvolvimento
 */
export function defaultConfig() {
  return {
    ALLOWED_USERS: [],
    PROJECTS_BASE: '/projects',
    OPENCODE_BIN: 'opencode',
    DISCORD_MSG_LIMIT: 1900,
    STREAM_UPDATE_INTERVAL: 1500,
  }
}

// ─── Fábricas de payload Discord ──────────────────────────────────────────────

/**
 * Cria um payload raw de interação de slash command Discord.
 * Útil para testes que trabalham com o payload bruto antes do parse.
 * @param {string} commandName - Nome do comando (ex: 'command', 'sessions')
 * @param {Object} [options={}] - Mapa { nomeDaOpção: valor } das opções do comando
 * @returns {Object} Payload de interação de application command
 */
export function commandPayload(commandName, options = {}) {
  return {
    id: `interaction-${Date.now()}`,
    type: 2, // APPLICATION_COMMAND
    data: {
      name: commandName,
      options: Object.entries(options).map(([name, value]) => ({
        name,
        value,
        type: typeof value === 'number' ? 4 : typeof value === 'boolean' ? 5 : 3,
      })),
    },
    guild_id: GUILD_ID,
    channel_id: THREAD_ID,
    member: {
      user: { id: USER_ID, username: 'testuser' },
    },
  }
}

/**
 * Cria um payload raw de interação de botão Discord.
 * @param {string} customId - ID customizado do botão (ex: 'permit:perm-1')
 * @param {Object} [opts={}] - Opções adicionais
 * @param {string} [opts.guildId] - ID do guild
 * @param {string} [opts.channelId] - ID do canal
 * @param {string} [opts.userId] - ID do usuário que clicou
 * @param {string} [opts.messageId] - ID da mensagem com o botão
 * @param {string} [opts.messageContent] - Conteúdo da mensagem com o botão
 * @returns {Object} Payload de interação de componente
 */
export function buttonPayload(customId, opts = {}) {
  return {
    id: `btn-${Date.now()}`,
    type: 3, // MESSAGE_COMPONENT
    data: {
      custom_id: customId,
      component_type: 2, // BUTTON
    },
    guild_id: opts.guildId ?? GUILD_ID,
    channel_id: opts.channelId ?? THREAD_ID,
    member: {
      user: { id: opts.userId ?? USER_ID, username: 'testuser' },
    },
    message: {
      id: opts.messageId ?? `msg-${Date.now()}`,
      content: opts.messageContent ?? '',
    },
  }
}
