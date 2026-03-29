// tests/helpers/timer-utils.js
// Utilitários para controle de fake timers do Vitest em testes assíncronos.
// Todos os helpers assumem que vi.useFakeTimers() já foi chamado no teste.

import { vi } from 'vitest'

// ─── advanceTimersAndFlush ────────────────────────────────────────────────────

/**
 * Avança os fake timers em `ms` milissegundos e drena a fila de microtasks.
 * Necessário quando código usa setTimeout + Promises encadeadas, pois o simples
 * avanço de timers não resolve as Promises pendentes automaticamente.
 * @param {number} ms - Milissegundos a avançar nos fake timers
 * @returns {Promise<void>}
 */
export async function advanceTimersAndFlush(ms) {
  vi.advanceTimersByTime(ms)
  // Múltiplas rodadas garantem resolução de cadeias de Promises
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

// ─── runAllTimersAndFlush ──────────────────────────────────────────────────────

/**
 * Executa todos os timers pendentes de uma vez e drena a fila de microtasks.
 * Útil quando não importa o tempo exato, apenas garantir que tudo foi executado.
 * Atenção: pode causar loop infinito com timers recorrentes (setInterval sem limite).
 * @returns {Promise<void>}
 */
export async function runAllTimersAndFlush() {
  vi.runAllTimers()
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

// ─── tickUntil ────────────────────────────────────────────────────────────────

/**
 * Avança os fake timers em incrementos de `tickMs` até que conditionFn() retorne true.
 * Lança erro se a condição não for satisfeita dentro de `maxTicks` iterações.
 * @param {Function} conditionFn - Função predicado sem argumentos; retorna bool
 * @param {Object} [opts={}] - Opções de controle
 * @param {number} [opts.maxTicks=100] - Número máximo de iterações antes de falhar
 * @param {number} [opts.tickMs=100] - Milissegundos avançados por iteração
 * @returns {Promise<void>}
 * @throws {Error} Se maxTicks for atingido sem a condição ser satisfeita
 */
export async function tickUntil(conditionFn, { maxTicks = 100, tickMs = 100 } = {}) {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (conditionFn()) return

    vi.advanceTimersByTime(tickMs)
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
  }

  if (!conditionFn()) {
    const totalMs = maxTicks * tickMs
    throw new Error(
      `tickUntil: condição não satisfeita após ${maxTicks} ticks (${totalMs}ms total)`
    )
  }
}

// ─── withFakeTimers ───────────────────────────────────────────────────────────

/**
 * Configura fake timers, executa a função fornecida e restaura os timers reais.
 * Garante limpeza mesmo quando a função lança exceção.
 * @param {Function} fn - Função assíncrona a executar com fake timers ativos
 * @returns {Promise<void>}
 */
export async function withFakeTimers(fn) {
  vi.useFakeTimers()
  try {
    await fn()
  } finally {
    vi.useRealTimers()
  }
}
