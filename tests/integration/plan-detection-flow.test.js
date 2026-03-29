// tests/integration/plan-detection-flow.test.js
// Testa o fluxo completo de detecção de plano entre PlanReviewDetector,
// OpenCodeSession (EventEmitter) e StreamHandler (real), com thread Discord mockada.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamHandler } from '../../src/stream-handler.js'
import { PlanReviewDetector } from '../../src/plan-detector.js'
import { createMockThread } from '@helpers/discord-mocks.js'
import { advanceTimersAndFlush } from '@helpers/timer-utils.js'

// ─── Mock PlannotatorClient ──────────────────────────────────────────────────
// vi.hoisted garante que o construtor mock está pronto antes de qualquer import

const MockPlannotatorClient = vi.hoisted(() => vi.fn())

vi.mock('../../src/plannotator-client.js', () => ({
  PlannotatorClient: MockPlannotatorClient,
}))

// ─── Mock discord.js ──────────────────────────────────────────────────────────
// Segue o padrão de stream-handler.test.js — construtores function, não arrow

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
  emitter.sessionId = opts.sessionId ?? 'sess-plan-1'
  emitter.apiSessionId = opts.apiSessionId ?? 'api-sess-1'
  emitter.userId = opts.userId ?? 'user-123'
  emitter.projectPath = opts.projectPath ?? '/projects/test'
  emitter.agent = opts.agent ?? 'plan'
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

describe('Fluxo de detecção de plano', () => {
  let thread, session, handler

  beforeEach(() => {
    vi.useFakeTimers()
    MockPlannotatorClient.mockImplementation(function () {
      this.getPlan = vi.fn().mockResolvedValue(null)
    })
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

  // ─── Integração com StreamHandler ─────────────────────────────────────────

  describe('Integração com StreamHandler', () => {
    it('StreamHandler renderiza botões de plano quando plan-ready é emitido', async () => {
      session.emit('plan-ready', { plan: { content: 'Plano teste', version: 1 } })
      await flushPromises()

      expect(thread.send).toHaveBeenCalledOnce()
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('object')
      expect(payload).toHaveProperty('components')
      expect(Array.isArray(payload.components)).toBe(true)
      expect(payload.components).toHaveLength(1)
    })

    it('botões de plano têm IDs corretos', async () => {
      session.emit('plan-ready', { plan: { content: 'Plano teste', version: 1 } })
      await flushPromises()

      const row = thread.send.mock.calls[0][0].components[0]
      const [btn1, btn2, btn3] = row.addComponents.mock.calls[0]
      expect(btn1.setCustomId.mock.calls[0][0]).toBe(`approve_plan_${session.sessionId}`)
      expect(btn2.setCustomId.mock.calls[0][0]).toBe(`changes_plan_${session.sessionId}`)
      expect(btn3.setCustomId.mock.calls[0][0]).toBe(`reject_plan_${session.sessionId}`)
    })

    it('segundo evento plan-ready limpa o anterior e cria nova mensagem', async () => {
      // Primeiro plano — cria mensagem com botões
      session.emit('plan-ready', { plan: { content: 'Plano v1', version: 1 } })
      await flushPromises()
      expect(thread.send).toHaveBeenCalledTimes(1)

      // Segundo plano (novo ciclo) — deve criar nova mensagem
      session.emit('plan-ready', { plan: { content: 'Plano v2', version: 2 } })
      await flushPromises()
      expect(thread.send).toHaveBeenCalledTimes(2)
    })

    it('plan-resolved edita mensagem com botões desabilitados quando plano foi revisado via browser', async () => {
      // Primeiro precisa existir plano pendente
      session.emit('plan-ready', { plan: { content: 'Plano teste', version: 1 } })
      await flushPromises()

      const planMsg = thread._sentMessages[0]
      expect(planMsg).toBeDefined()

      // plan-resolved vem do detector quando plannotator fecha
      session.emit('plan-resolved')
      await flushPromises()

      expect(planMsg.edit).toHaveBeenCalledOnce()
      expect(handler._pendingPlanReview).toBeNull()
    })

    it('plan-review-resolved limpa estado pendente sem editar mensagem (resolução via Discord)', async () => {
      session.emit('plan-ready', { plan: { content: 'Plano teste', version: 1 } })
      await flushPromises()

      expect(handler._pendingPlanReview).not.toBeNull()

      // plan-review-resolved é emitido quando usuário clica em botão no Discord
      session.emit('plan-review-resolved')
      await flushPromises()

      expect(handler._pendingPlanReview).toBeNull()
    })

    it('plan-resolved sem plano pendente não lança erro', async () => {
      // Sem emitir plan-ready antes — handler deve ignorar silenciosamente
      expect(() => session.emit('plan-resolved')).not.toThrow()
      await flushPromises()
      expect(thread.send).not.toHaveBeenCalled()
    })
  })

  // ─── Detector integrado com sessão e StreamHandler ────────────────────────

  describe('Detector integrado com sessão e StreamHandler', () => {
    let detector

    beforeEach(() => {
      detector = new PlanReviewDetector({
        plannotatorBaseUrl: 'http://localhost:5100',
        sessionId: session.sessionId,
        pollInterval: 100,
      })
      // Conecta detector à sessão, como session-manager.js faz em start()
      detector.on('plan-ready', (data) => session.emit('plan-ready', data))
      detector.on('plan-resolved', () => session.emit('plan-resolved'))
    })

    afterEach(() => {
      detector.stop()
    })

    it('detector emite plan-ready → sessão → StreamHandler renderiza botões', async () => {
      detector.client.getPlan.mockResolvedValue({ content: 'Plano do detector', version: 1 })

      detector.start()
      await advanceTimersAndFlush(150)

      expect(thread.send).toHaveBeenCalledOnce()
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('object')
      expect(payload).toHaveProperty('components')
    })

    it('detector não dispara plan-ready duas vezes para o mesmo plano', async () => {
      detector.client.getPlan.mockResolvedValue({ content: 'Plano único' })

      detector.start()
      await advanceTimersAndFlush(400) // 4 polls em intervalo de 100ms

      expect(thread.send).toHaveBeenCalledTimes(1)
    })

    it('detector emite plan-resolved → sessão → StreamHandler edita mensagem com botões desabilitados', async () => {
      // Primeiro poll retorna plano, segundo em diante retorna null (resolvido)
      detector.client.getPlan
        .mockResolvedValueOnce({ content: 'Plano do detector' })
        .mockResolvedValue(null)

      detector.start()
      await advanceTimersAndFlush(150) // primeiro poll: plan-ready

      const planMsg = thread._sentMessages[0]
      expect(planMsg).toBeDefined()

      await advanceTimersAndFlush(150) // segundo poll: plan-resolved

      expect(planMsg.edit).toHaveBeenCalledOnce()
      expect(handler._pendingPlanReview).toBeNull()
    })

    it('stop() para o polling — thread não recebe novos eventos', async () => {
      detector.client.getPlan.mockResolvedValue(null)

      detector.start()
      detector.stop()

      await advanceTimersAndFlush(500)

      // Nenhuma mensagem deve ter sido enviada
      expect(thread.send).not.toHaveBeenCalled()
    })

    it('erros de poll são suprimidos — thread não recebe mensagem de erro', async () => {
      detector.client.getPlan.mockRejectedValue(new Error('ECONNREFUSED'))

      detector.start()
      await advanceTimersAndFlush(350)

      // Nenhuma mensagem de erro deve ter sido enviada
      expect(thread.send).not.toHaveBeenCalled()
    })
  })
})
