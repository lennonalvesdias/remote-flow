// tests/integration/question-flow.test.js
// Testa o fluxo de exibição de perguntas do agente na thread Discord e o
// roteamento de respostas via queueMessage na OpenCodeSession real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamHandler } from '../../src/stream-handler.js'
import { OpenCodeSession } from '../../src/session-manager.js'
import { createMockThread } from '@helpers/discord-mocks.js'

// ─── Mock discord.js ──────────────────────────────────────────────────────────
// Segue o padrão de stream-handler.test.js para interceptar ButtonBuilder/ActionRowBuilder

vi.mock('discord.js', () => {
  const AttachmentBuilder = function (buffer, options) {
    this.buffer = buffer
    this.name = options?.name
    this.description = options?.description
  }

  const ButtonBuilder = function () {
    this.setCustomId = vi.fn().mockReturnThis()
    this.setLabel = vi.fn().mockReturnThis()
    this.setStyle = vi.fn().mockReturnThis()
    this.setEmoji = vi.fn().mockReturnThis()
    this.setDisabled = vi.fn().mockReturnThis()
  }

  const ActionRowBuilder = function () {
    this.addComponents = vi.fn().mockReturnThis()
  }

  const ButtonStyle = { Success: 3, Danger: 4, Secondary: 2, Primary: 1 }

  return { AttachmentBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle }
})

// ─── Helpers locais ───────────────────────────────────────────────────────────

/**
 * Cria uma sessão mock mínima baseada em EventEmitter.
 * Expõe apenas os campos que StreamHandler acessa diretamente.
 * @param {object} [opts]
 * @returns {EventEmitter}
 */
function createMockSession(opts = {}) {
  const emitter = new EventEmitter()
  emitter.status = opts.status ?? 'idle'
  emitter.sessionId = opts.sessionId ?? 'sess-q-1'
  emitter.apiSessionId = opts.apiSessionId ?? 'api-sess-1'
  emitter.userId = opts.userId ?? 'user-123'
  emitter.projectPath = opts.projectPath ?? '/projects/test'
  emitter.agent = opts.agent ?? 'build'
  emitter.outputBuffer = ''
  emitter.getQueueSize = vi.fn().mockReturnValue(0)
  emitter._pendingPermissionId = null
  emitter._pendingPermissionData = null
  emitter.server = opts.server ?? null
  return emitter
}

/** Drena microtasks pendentes para resolver cadeias de Promises. */
async function flushPromises(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Fluxo de perguntas do agente', () => {
  // ─── Apresentação de pergunta ───────────────────────────────────────────────

  describe('Apresentação de pergunta na thread', () => {
    let thread, session, handler

    beforeEach(() => {
      vi.useFakeTimers()
      thread = createMockThread()
      session = createMockSession()
      handler = new StreamHandler(thread, session)
      handler.start()
    })

    afterEach(() => {
      handler.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('StreamHandler envia pergunta como mensagem de texto na thread', async () => {
      session.emit('question', {
        questionId: 'q-1',
        questions: [{ question: 'Deseja continuar?' }],
      })

      await flushPromises()

      expect(thread.send).toHaveBeenCalledOnce()
    })

    it('mensagem de pergunta começa com o indicador ❓', async () => {
      session.emit('question', {
        questionId: 'q-1',
        questions: [{ question: 'Deseja continuar?' }],
      })

      await flushPromises()

      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('string')
      expect(payload).toContain('❓')
    })

    it('mensagem contém o texto da pergunta', async () => {
      session.emit('question', {
        questionId: 'q-1',
        questions: [{ question: 'Qual é o nome do projeto?' }],
      })

      await flushPromises()

      const payload = thread.send.mock.calls[0][0]
      expect(payload).toContain('Qual é o nome do projeto?')
    })

    it('StreamHandler não renderiza botões para perguntas — envia apenas texto', async () => {
      session.emit('question', {
        questionId: 'q-1',
        questions: [{ question: 'Continuar com a operação?' }],
      })

      await flushPromises()

      const payload = thread.send.mock.calls[0][0]
      // Deve ser string simples, não objeto com components
      expect(typeof payload).toBe('string')
      expect(payload).not.toHaveProperty('components')
    })

    it('múltiplas perguntas são exibidas como linhas separadas', async () => {
      session.emit('question', {
        questionId: 'q-2',
        questions: [
          { question: 'Primeira pergunta?' },
          { question: 'Segunda pergunta?' },
        ],
      })

      await flushPromises()

      const payload = thread.send.mock.calls[0][0]
      expect(payload).toContain('Primeira pergunta?')
      expect(payload).toContain('Segunda pergunta?')
    })

    it('array de perguntas vazio não envia mensagem', async () => {
      session.emit('question', {
        questionId: 'q-3',
        questions: [],
      })

      await flushPromises()

      expect(thread.send).not.toHaveBeenCalled()
    })
  })

  // ─── Roteamento de resposta via queueMessage ────────────────────────────────

  describe('Roteamento de resposta via queueMessage', () => {
    it('queueMessage com sessão waiting_input envia mensagem imediatamente via sendMessage', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)

      const session = new OpenCodeSession({
        sessionId: 'sess-q-route',
        projectPath: '/projects/test',
        threadId: 'thread-123',
        userId: 'user-123',
        agent: 'build',
      })
      session.apiSessionId = 'api-sess-q'
      session.status = 'waiting_input'
      session.server = { client: { sendMessage } }

      await session.queueMessage('sim')

      expect(sendMessage).toHaveBeenCalledOnce()
      expect(sendMessage).toHaveBeenCalledWith('api-sess-q', 'build', 'sim')
    })

    it('queueMessage com sessão waiting_input retorna queued: false', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)

      const session = new OpenCodeSession({
        sessionId: 'sess-q-immediate',
        projectPath: '/projects/test',
        threadId: 'thread-456',
        userId: 'user-123',
        agent: 'build',
      })
      session.apiSessionId = 'api-sess-immediate'
      session.status = 'waiting_input'
      session.server = { client: { sendMessage } }

      const result = await session.queueMessage('resposta do usuário')

      expect(result.queued).toBe(false)
      expect(result.position).toBe(0)
    })

    it('queueMessage com sessão running enfileira mensagem sem enviar imediatamente', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)

      const session = new OpenCodeSession({
        sessionId: 'sess-q-queued',
        projectPath: '/projects/test',
        threadId: 'thread-789',
        userId: 'user-123',
        agent: 'build',
      })
      session.apiSessionId = 'api-sess-queued'
      session.status = 'running'
      session.server = { client: { sendMessage } }

      const result = await session.queueMessage('mensagem enfileirada')

      expect(result.queued).toBe(true)
      expect(result.position).toBe(1)
      // Não deve enviar enquanto running
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })
})
