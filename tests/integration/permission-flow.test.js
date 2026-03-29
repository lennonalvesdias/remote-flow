// tests/integration/permission-flow.test.js
// Testa o fluxo completo de pedido/aprovação/rejeição de permissões entre
// OpenCodeSession (EventEmitter) e StreamHandler (real), com thread Discord mockada.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamHandler } from '../../src/stream-handler.js'
import { createMockThread } from '@helpers/discord-mocks.js'
import { advanceTimersAndFlush } from '@helpers/timer-utils.js'
import { PERMISSION_TIMEOUT_MS } from '../../src/config.js'

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
  emitter.sessionId = opts.sessionId ?? 'sess-123'
  emitter.apiSessionId = opts.apiSessionId ?? 'api-sess-1'
  emitter.userId = opts.userId ?? 'user-123'
  emitter.projectPath = opts.projectPath ?? '/projects/test'
  emitter.agent = opts.agent ?? 'build'
  emitter.outputBuffer = ''
  emitter.getQueueSize = vi.fn().mockReturnValue(0)
  // Campos acessados pelo timeout de auto-aprovação no StreamHandler
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

describe('Fluxo de permissões', () => {
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

  // ─── Pedido de permissão ──────────────────────────────────────────────────

  describe('Pedido de permissão', () => {
    it('renderiza botões de permissão no Discord quando opencode pede permissão', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })

      await flushPromises()

      expect(thread.send).toHaveBeenCalledOnce()
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('object')
      expect(payload).toHaveProperty('components')
      expect(Array.isArray(payload.components)).toBe(true)
      expect(payload.components).toHaveLength(1)
    })

    it('botão allow_once tem ID correto', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })

      await flushPromises()

      const row = thread.send.mock.calls[0][0].components[0]
      const [btn1] = row.addComponents.mock.calls[0]
      expect(btn1.setCustomId.mock.calls[0][0]).toBe(`allow_once_${session.sessionId}`)
    })

    it('botão allow_always tem ID correto', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })

      await flushPromises()

      const row = thread.send.mock.calls[0][0].components[0]
      const [, btn2] = row.addComponents.mock.calls[0]
      expect(btn2.setCustomId.mock.calls[0][0]).toBe(`allow_always_${session.sessionId}`)
    })

    it('botão reject_permission tem ID correto', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })

      await flushPromises()

      const row = thread.send.mock.calls[0][0].components[0]
      const [, , btn3] = row.addComponents.mock.calls[0]
      expect(btn3.setCustomId.mock.calls[0][0]).toBe(`reject_permission_${session.sessionId}`)
    })
  })

  // ─── Aprovação de permissão ───────────────────────────────────────────────

  describe('Aprovação de permissão', () => {
    it('aprovação automática por timeout chama approvePermission e atualiza mensagem', async () => {
      const approvePermission = vi.fn().mockResolvedValue(undefined)
      session.server = { client: { approvePermission } }

      // Simula o estado que handleSSEEvent configuraria no campo _pendingPermissionId
      // — StreamHandler lê esse campo na verificação de race condition do timeout
      session._pendingPermissionId = 'p-1'
      session._pendingPermissionData = { permissionId: 'p-1', toolName: 'write_file' }

      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })

      await flushPromises()

      // Avança o relógio até o timeout de auto-aprovação
      await advanceTimersAndFlush(PERMISSION_TIMEOUT_MS + 100)

      expect(approvePermission).toHaveBeenCalledOnce()
      expect(approvePermission).toHaveBeenCalledWith('api-sess-1', 'p-1')
    })

    it('aprovação com padrão envia notificação discreta sem componentes de botão', async () => {
      // Emite primeira permissão com status 'requested' → botões renderizados
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
        description: 'Write to file.js',
      })
      await flushPromises()
      expect(thread.send).toHaveBeenCalledOnce()

      // Reseta o spy para isolar o segundo envio
      thread.send.mockClear()

      // Emite segunda permissão com 'auto_approved' (o que ocorre quando o padrão está em cache)
      session.emit('permission', {
        status: 'auto_approved',
        toolName: 'write_file',
        description: 'Write to file.js',
      })
      await flushPromises()

      expect(thread.send).toHaveBeenCalledOnce()
      // Deve ser uma string simples, sem componentes interativos
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('string')
      expect(payload).toContain('Auto-aprovado')
    })
  })

  // ─── Rejeição de permissão ────────────────────────────────────────────────

  describe('Rejeição de permissão', () => {
    it('evento permission-resolved limpa o estado pendente no StreamHandler', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
      })
      await flushPromises()

      expect(handler._pendingPermission).not.toBeNull()

      // Emitir permission-resolved simula o que commands.js faz após
      // o usuário clicar em "Rejeitar" (ou qualquer botão)
      session.emit('permission-resolved')
      await flushPromises()

      expect(handler._pendingPermission).toBeNull()
    })

    it('após resolução, estado pendente da permissão é nulo', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
      })
      await flushPromises()

      // Verifica que o estado foi criado antes da resolução
      const pendingBefore = handler._pendingPermission
      expect(pendingBefore).not.toBeNull()
      expect(pendingBefore.permissionId).toBe('p-1')

      session.emit('permission-resolved')
      await flushPromises()

      expect(handler._pendingPermission).toBeNull()
    })
  })

  // ─── Timeout de permissão ─────────────────────────────────────────────────

  describe('Timeout de permissão', () => {
    it('permissão pendente é descartada ao fechar sessão sem erros', async () => {
      session.emit('permission', {
        status: 'requested',
        permissionId: 'p-1',
        toolName: 'write_file',
      })
      await flushPromises()

      expect(handler._pendingPermission).not.toBeNull()

      // stop() deve limpar o estado de permissão pendente e cancelar o timer
      expect(() => handler.stop()).not.toThrow()
      expect(handler._pendingPermission).toBeNull()
    })
  })
})
