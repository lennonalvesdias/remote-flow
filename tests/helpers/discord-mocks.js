// tests/helpers/discord-mocks.js
// Fábricas de objetos mock para simular o Discord.js em testes de integração.

import { EventEmitter } from 'events'
import { vi } from 'vitest'

// Contador global para geração de IDs únicos entre factories
let _idCounter = 0

/**
 * Gera um ID único com prefixo opcional.
 * @param {string} [prefix=''] - Prefixo do ID
 * @returns {string} ID único
 */
function nextId(prefix = '') {
  return `${prefix}${++_idCounter}`
}

// ─── createMockMessage ─────────────────────────────────────────────────────────

/**
 * Cria uma mensagem Discord mock com suporte a edição e resposta.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.id] - ID da mensagem
 * @param {string} [opts.content] - Conteúdo da mensagem
 * @param {Object} [opts.author] - Objeto autor
 * @param {Map}    [opts.attachments] - Mapa de attachments
 * @param {Object} [opts.channel] - Canal pai
 * @param {string} [opts.channelId] - ID do canal
 * @returns {Object} Mensagem mock
 */
export function createMockMessage(opts = {}) {
  const message = {
    id: opts.id ?? nextId('msg-'),
    content: opts.content ?? '',
    author: opts.author ?? { id: 'author-123', bot: false },
    attachments: opts.attachments ?? new Map(),
    channel: opts.channel ?? null,
    channelId: opts.channelId ?? 'channel-123',
    _edits: [],

    edit: vi.fn().mockImplementation((payload) => {
      message._edits.push(payload)
      message.content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      return Promise.resolve(message)
    }),

    reply: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      return Promise.resolve(createMockMessage({ content, channel: message.channel }))
    }),
  }
  return message
}

// ─── createMockThread ──────────────────────────────────────────────────────────

/**
 * Cria uma thread Discord mock que simula ThreadChannel.
 * Rastreia mensagens enviadas em `_sentMessages` para assertions nos testes.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.id] - ID da thread
 * @param {string} [opts.name] - Nome da thread
 * @param {Object} [opts.guild] - Objeto guild pai
 * @returns {Object} Thread mock
 */
export function createMockThread(opts = {}) {
  const thread = {
    id: opts.id ?? 'thread-123',
    name: opts.name ?? 'test-thread',
    guild: opts.guild ?? { id: 'guild-123' },
    _sentMessages: [],

    send: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      const msg = createMockMessage({ content, channel: thread, channelId: thread.id })
      thread._sentMessages.push(msg)
      return Promise.resolve(msg)
    }),

    edit: vi.fn().mockResolvedValue({}),

    setArchived: vi.fn().mockResolvedValue({}),

    messages: {
      fetch: vi.fn().mockResolvedValue(new Map()),
    },

    isThread: () => true,
  }
  return thread
}

// ─── createMockInteraction ─────────────────────────────────────────────────────

/**
 * Cria uma interação de slash command Discord mock.
 * Rastreia replies em `_replies` para assertions nos testes.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.id] - ID da interação
 * @param {string} [opts.commandName] - Nome do comando
 * @param {Object} [opts.optionValues] - Mapa { nomeDaOpção: valor } para getString/getInteger/getBoolean
 * @param {Array}  [opts.optionData] - Array raw de dados de opções
 * @param {Object} [opts.user] - Objeto usuário
 * @param {string} [opts.guildId] - ID do guild
 * @param {string} [opts.channelId] - ID do canal
 * @param {Object} [opts.channel] - Canal da interação (padrão: thread mock)
 * @returns {Object} Interação mock
 */
export function createMockInteraction(opts = {}) {
  const optionValues = opts.optionValues ?? {}

  const interaction = {
    id: opts.id ?? nextId('interaction-'),
    commandName: opts.commandName ?? 'command',
    options: {
      getString: vi.fn().mockImplementation((name) => optionValues[name] ?? null),
      getInteger: vi.fn().mockImplementation((name) => optionValues[name] ?? null),
      getBoolean: vi.fn().mockImplementation((name) => optionValues[name] ?? null),
      data: { options: opts.optionData ?? [] },
    },
    user: opts.user ?? { id: 'user-123', username: 'testuser' },
    guildId: opts.guildId ?? 'guild-001',
    channelId: opts.channelId ?? 'channel-123',
    channel: opts.channel ?? createMockThread(),
    createdTimestamp: Date.now(),
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    _deferred: false,
    _replies: [],

    deferReply: vi.fn().mockImplementation(() => {
      interaction._deferred = true
      return Promise.resolve()
    }),

    editReply: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      const msg = createMockMessage({ content })
      interaction._replies.push(msg)
      return Promise.resolve(msg)
    }),

    reply: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      const msg = createMockMessage({ content })
      interaction._replies.push(msg)
      return Promise.resolve(msg)
    }),

    followUp: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      return Promise.resolve(createMockMessage({ content }))
    }),
  }
  return interaction
}

// ─── createMockButtonInteraction ──────────────────────────────────────────────

/**
 * Cria uma interação de botão/componente Discord mock.
 * Rastreia updates em `_updates` e replies em `_replies`.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.customId] - ID customizado do botão
 * @param {Object} [opts.message] - Mensagem que contém o botão
 * @returns {Object} Interação de botão mock
 */
export function createMockButtonInteraction(opts = {}) {
  const interaction = {
    id: opts.id ?? nextId('btn-interaction-'),
    commandName: opts.commandName ?? '',
    customId: opts.customId ?? 'button-id',
    user: opts.user ?? { id: 'user-123', username: 'testuser' },
    guildId: opts.guildId ?? 'guild-001',
    channelId: opts.channelId ?? 'channel-123',
    channel: opts.channel ?? createMockThread(),
    message: opts.message ?? createMockMessage(),
    createdTimestamp: Date.now(),
    isMessageComponent: () => true,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    _deferred: false,
    _replies: [],
    _updates: [],

    deferReply: vi.fn().mockImplementation(() => {
      interaction._deferred = true
      return Promise.resolve()
    }),

    deferUpdate: vi.fn().mockImplementation(() => {
      interaction._deferred = true
      return Promise.resolve()
    }),

    update: vi.fn().mockImplementation((payload) => {
      interaction._updates.push(payload)
      return Promise.resolve()
    }),

    editReply: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      const msg = createMockMessage({ content })
      interaction._replies.push(msg)
      return Promise.resolve(msg)
    }),

    reply: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      const msg = createMockMessage({ content })
      interaction._replies.push(msg)
      return Promise.resolve(msg)
    }),

    followUp: vi.fn().mockImplementation((payload) => {
      const content = typeof payload === 'string' ? payload : (payload?.content ?? '')
      return Promise.resolve(createMockMessage({ content }))
    }),
  }
  return interaction
}

// ─── createMockAutocompleteInteraction ────────────────────────────────────────

/**
 * Cria uma interação de autocomplete Discord mock.
 * Rastreia respostas em `_responses` para assertions nos testes.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {Object} [opts.focusedValue] - Valor da opção em foco { name, value }
 * @param {Object} [opts.optionValues] - Mapa de valores de opções
 * @returns {Object} Interação de autocomplete mock
 */
export function createMockAutocompleteInteraction(opts = {}) {
  const focusedValue = opts.focusedValue ?? { name: 'query', value: '' }
  const optionValues = opts.optionValues ?? {}

  const interaction = {
    id: opts.id ?? nextId('autocomplete-'),
    commandName: opts.commandName ?? 'command',
    user: opts.user ?? { id: 'user-123', username: 'testuser' },
    guildId: opts.guildId ?? 'guild-001',
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => false,
    options: {
      getFocused: vi.fn().mockImplementation((full = false) => {
        return full ? focusedValue : focusedValue.value
      }),
      getString: vi.fn().mockImplementation((name) => optionValues[name] ?? null),
    },
    _responses: [],

    respond: vi.fn().mockImplementation((choices) => {
      interaction._responses.push(choices)
      return Promise.resolve()
    }),
  }
  return interaction
}

// ─── createMockGuild ──────────────────────────────────────────────────────────

/**
 * Cria um guild (servidor) Discord mock.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.id] - ID do guild
 * @returns {Object} Guild mock
 */
export function createMockGuild(opts = {}) {
  const guild = {
    id: opts.id ?? 'guild-001',
    channels: {
      create: vi.fn().mockImplementation(() => Promise.resolve(createMockThread())),
    },
  }
  return guild
}

// ─── createMockClient ─────────────────────────────────────────────────────────

/**
 * Cria um client Discord mock baseado em EventEmitter.
 * Suporta login, destroy e emissão de eventos como o client real.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {Object} [opts.user] - Objeto usuário do bot
 * @param {Object} [opts.guild] - Opções para o guild padrão no cache
 * @returns {EventEmitter} Client Discord mock
 */
export function createMockClient(opts = {}) {
  const guild = createMockGuild(opts.guild ?? {})
  const guildsCache = new Map([[guild.id, guild]])

  const client = new EventEmitter()
  Object.assign(client, {
    user: opts.user ?? { id: 'bot-123', tag: 'Bot#0001', username: 'Bot' },
    guilds: {
      cache: guildsCache,
    },
    application: {
      commands: {
        set: vi.fn().mockResolvedValue([]),
      },
    },
    _token: null,

    login: vi.fn().mockImplementation((token) => {
      client._token = token
      return Promise.resolve(token)
    }),

    destroy: vi.fn().mockResolvedValue(undefined),
  })
  return client
}

// ─── createMockVoiceAttachment ─────────────────────────────────────────────────

/**
 * Cria um attachment de mensagem de voz Discord mock.
 * @param {Object} [opts={}] - Opções de configuração
 * @param {string} [opts.id] - ID do attachment
 * @param {string} [opts.contentType] - MIME type (padrão: 'audio/ogg')
 * @param {string} [opts.url] - URL de CDN do arquivo
 * @param {number} [opts.duration_secs] - Duração em segundos
 * @param {string} [opts.waveform] - Dados de waveform em base64
 * @param {string} [opts.name] - Nome do arquivo
 * @returns {Object} Attachment de voz mock
 */
export function createMockVoiceAttachment(opts = {}) {
  const id = opts.id ?? nextId('attachment-')
  return {
    id,
    contentType: opts.contentType ?? 'audio/ogg',
    url: opts.url ?? `https://cdn.discordapp.com/attachments/123/${id}.ogg`,
    duration_secs: opts.duration_secs ?? 5,
    waveform: opts.waveform ?? Buffer.from('waveform-data').toString('base64'),
    name: opts.name ?? 'voice-message.ogg',
  }
}
