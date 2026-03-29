// tests/integration/stream-to-discord.test.js
// Testa o fluxo de streaming de output do OpenCode para uma thread Discord.
// Usa StreamHandler REAL com sessão EventEmitter mock e thread Discord mockada.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamHandler } from '../../src/stream-handler.js'
import { createMockThread } from '@helpers/discord-mocks.js'
import { advanceTimersAndFlush } from '@helpers/timer-utils.js'
import { STREAM_UPDATE_INTERVAL, THREAD_ARCHIVE_DELAY_MS } from '../../src/config.js'

// ─── Mock discord.js ──────────────────────────────────────────────────────────
// Intercepta AttachmentBuilder/ButtonBuilder/ActionRowBuilder — mesma estrutura
// usada em permission-flow.test.js para consistência entre testes de integração.

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
 * Expõe apenas os campos que StreamHandler lê diretamente.
 * @param {object} [opts]
 * @returns {EventEmitter}
 */
function createMockSession(opts = {}) {
  const emitter = new EventEmitter()
  emitter.status = opts.status ?? 'idle'
  emitter.sessionId = opts.sessionId ?? 'sess-s2d-1'
  emitter.apiSessionId = opts.apiSessionId ?? 'api-sess-1'
  emitter.userId = opts.userId ?? 'user-001'
  emitter.projectPath = opts.projectPath ?? '/projetos/app'
  emitter.agent = opts.agent ?? 'build'
  emitter.outputBuffer = ''
  emitter.getQueueSize = vi.fn().mockReturnValue(0)
  emitter._pendingPermissionId = null
  emitter._pendingPermissionData = null
  emitter.server = opts.server ?? null
  return emitter
}

/** Drena a fila de microtasks pendentes para resolver cadeias de Promises. */
async function flushPromises(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('StreamHandler — streaming de output', () => {
  /** @type {ReturnType<typeof createMockThread>} */
  let thread
  /** @type {ReturnType<typeof createMockSession>} */
  let session
  /** @type {StreamHandler} */
  let handler

  beforeEach(() => {
    vi.useFakeTimers()
    thread = createMockThread()
    session = createMockSession()
    handler = new StreamHandler(thread, session)
    handler.start()
  })

  afterEach(() => {
    handler.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ─── Output streaming ──────────────────────────────────────────────────────

  describe('Output streaming', () => {
    it('output com newline completo é enviado à thread após UPDATE_INTERVAL', async () => {
      session.emit('output', 'Resposta do agente!\n')

      // Antes do timer disparar, nada deve ter sido enviado
      expect(thread.send).not.toHaveBeenCalled()

      // Avança até o timer de flush disparar (fica dentro dos 2500ms do gap detector)
      await advanceTimersAndFlush(STREAM_UPDATE_INTERVAL + 100)

      expect(thread.send).toHaveBeenCalledOnce()
    })

    it('output sem newline não é enviado mesmo após UPDATE_INTERVAL', async () => {
      // Linha incompleta fica retida no buffer de narração aguardando linha completa
      session.emit('output', 'texto sem newline')

      await advanceTimersAndFlush(STREAM_UPDATE_INTERVAL + 100)

      expect(thread.send).not.toHaveBeenCalled()
    })

    it('múltiplos chunks são combinados no mesmo flush', async () => {
      // Primeiro output: sai da fase de narração, entra em currentContent,
      // agenda o updateTimer
      session.emit('output', 'linha 1\n')
      // Segundo output: _inNarrationPhase já é false, vai direto para currentContent
      session.emit('output', 'linha 2\n')

      await advanceTimersAndFlush(STREAM_UPDATE_INTERVAL + 100)

      // Uma única mensagem com os dois chunks combinados
      expect(thread.send).toHaveBeenCalledOnce()
      const sentContent = thread.send.mock.calls[0][0]
      expect(sentContent).toContain('linha 1')
      expect(sentContent).toContain('linha 2')
    })
  })

  // ─── Mensagens de status ───────────────────────────────────────────────────

  describe('Mensagens de status', () => {
    it('status running envia mensagem de processando', async () => {
      session.emit('status', 'running')

      // _drainStatusQueue é async — drena via flushPromises
      await flushPromises()

      const sentContents = thread._sentMessages.map((m) => m.content)
      expect(sentContents.some((c) => c.includes('Processando'))).toBe(true)
    })

    it('status finished envia mensagem de conclusão', async () => {
      session.emit('status', 'finished')

      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith('✅ **Sessão concluída**')
    })

    it('status error envia mensagem de erro', async () => {
      session.emit('status', 'error')

      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith('❌ **Sessão encerrada com erro**')
    })

    it('status waiting_input envia mensagem de aguardando resposta', async () => {
      session.emit('status', 'waiting_input')

      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith('💬 **Aguardando sua resposta...**')
    })

    it('status idle não envia mensagem', async () => {
      // sendStatusMessage('idle') não encontra nenhum branch correspondente
      session.emit('status', 'idle')

      await flushPromises()

      expect(thread.send).not.toHaveBeenCalled()
    })
  })

  // ─── Eventos de ciclo de vida ──────────────────────────────────────────────

  describe('Eventos de ciclo de vida', () => {
    it('evento close arquiva a thread após THREAD_ARCHIVE_DELAY_MS', async () => {
      session.emit('close')

      // Drena o handler assíncrono (flush + stop internos)
      await flushPromises()

      // O timer de arquivamento ainda não disparou
      expect(thread.setArchived).not.toHaveBeenCalled()

      // Avança até o timer de arquivamento disparar
      await advanceTimersAndFlush(THREAD_ARCHIVE_DELAY_MS + 100)

      expect(thread.setArchived).toHaveBeenCalledWith(true)
    })

    it('evento server-restart envia aviso de reinício', async () => {
      // server-restart chama sendStatusMessage('restart') diretamente (não passa pela fila)
      session.emit('server-restart')

      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith('⚠️ Servidor reiniciando...')
    })

    it('evento queue-abandoned envia aviso com contagem de mensagens descartadas', async () => {
      session.emit('queue-abandoned', 3)

      await flushPromises()

      expect(thread.send).toHaveBeenCalledWith(
        '⚠️ 3 mensagem(s) na fila foram descartadas porque a sessão encerrou inesperadamente.'
      )
    })
  })

  // ─── Diff preview ──────────────────────────────────────────────────────────

  describe('Diff preview', () => {
    it('diff pequeno (≤1500 chars) é enviado inline como bloco de código', async () => {
      const smallDiff = '+const x = 1;\n-const y = 2;\n'

      session.emit('diff', { path: 'src/index.js', content: smallDiff })

      await flushPromises(4)

      expect(thread.send).toHaveBeenCalledOnce()
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('string')
      expect(payload).toContain('```diff')
      expect(payload).toContain('index.js')
    })

    it('diff grande (>1500 chars) é enviado como arquivo anexo com AttachmentBuilder', async () => {
      // '+linha\n' = 7 chars × 300 = 2100 chars → excede DIFF_INLINE_LIMIT (1500)
      const largeDiff = '+linha\n'.repeat(300)

      session.emit('diff', { path: 'src/app.js', content: largeDiff })

      await flushPromises(4)

      expect(thread.send).toHaveBeenCalledOnce()
      const payload = thread.send.mock.calls[0][0]
      expect(typeof payload).toBe('object')
      expect(payload).toHaveProperty('files')
      expect(payload.files).toHaveLength(1)
      expect(payload.files[0]).toHaveProperty('name', 'app.js.diff')
    })
  })
})
