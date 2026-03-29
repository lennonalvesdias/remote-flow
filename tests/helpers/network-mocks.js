// tests/helpers/network-mocks.js
// Mocks para fetch global e streams SSE, usados em testes de integração de rede.

import { vi } from 'vitest'

// ─── createFetchMock ──────────────────────────────────────────────────────────

/**
 * Cria um mock para a função global fetch com roteamento baseado em padrões de URL.
 * Handlers podem retornar { status, body, headers } ou um valor direto (tratado como JSON 200).
 * @param {Object} [routes={}] - Mapa { padrãoDeURL: handler | valor } inicial
 * @returns {{ mock: Function, addRoute: Function, reset: Function }}
 */
export function createFetchMock(routes = {}) {
  const routeMap = { ...routes }

  /**
   * Procura o primeiro handler cujo padrão esteja contido na URL.
   * @param {string} url - URL da requisição
   * @returns {Function|any|undefined} Handler ou valor registrado
   */
  function findHandler(url) {
    for (const [pattern, handler] of Object.entries(routeMap)) {
      if (url.includes(pattern)) return handler
    }
    return undefined
  }

  const mock = vi.fn().mockImplementation(async (url, options) => {
    const handler = findHandler(String(url))

    if (handler === undefined) {
      const registradas = Object.keys(routeMap).join(', ') || '(nenhuma)'
      throw new Error(
        `[fetchMock] Nenhuma rota encontrada para URL: ${url}\nRotas registradas: ${registradas}`
      )
    }

    const result = typeof handler === 'function' ? await handler(url, options) : handler

    // Detecta objeto de resposta explícito { status, body, headers }
    const isExplicitResponse =
      result !== null &&
      typeof result === 'object' &&
      'status' in result &&
      'body' in result

    if (isExplicitResponse) {
      const { status, body, headers = {} } = result
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
      return new Response(bodyStr, { status, headers })
    }

    // Trata qualquer outro valor como corpo JSON com status 200
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  return {
    mock,

    /**
     * Adiciona ou sobrescreve uma rota no mock.
     * @param {string} urlPattern - Padrão de URL a corresponder (via includes)
     * @param {Function|Object} handler - Função handler ou valor de resposta direto
     */
    addRoute(urlPattern, handler) {
      routeMap[urlPattern] = handler
    },

    /**
     * Reseta chamadas registradas e restaura as rotas iniciais.
     */
    reset() {
      mock.mockClear()
      for (const key of Object.keys(routeMap)) {
        delete routeMap[key]
      }
      Object.assign(routeMap, routes)
    },
  }
}

// ─── createSSEResponse ────────────────────────────────────────────────────────

/**
 * Cria uma Response com corpo streaming SSE para simular streams de eventos.
 * Cada evento é formatado como "event: TYPE\ndata: JSON\n\n".
 * @param {Array<{type: string, data: Object|string}>} [events=[]] - Lista de eventos a transmitir
 * @returns {Response} Response com ReadableStream em formato SSE
 */
export function createSSEResponse(events = []) {
  const chunks = events.map(({ type, data }) => {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
    return `event: ${type}\ndata: ${dataStr}\n\n`
  })

  const encoder = new TextEncoder()
  let index = 0

  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]))
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ─── createOctokitMock ────────────────────────────────────────────────────────

/**
 * Cria um mock do cliente Octokit do GitHub com respostas padrão.
 * Todos os métodos são vi.fn() para assertions nos testes.
 * @param {Object} [overrides={}] - Sobrescrições de métodos no formato 'rest.recurso.metodo'
 * @returns {Object} Mock compatível com a interface Octokit
 */
export function createOctokitMock(overrides = {}) {
  const methods = {
    'rest.repos.get': vi.fn().mockResolvedValue({
      data: { full_name: 'testuser/test-repo', default_branch: 'main' },
    }),
    'rest.pulls.create': vi.fn().mockResolvedValue({
      data: {
        number: 1,
        html_url: 'https://github.com/testuser/test-repo/pull/1',
        title: 'Test PR',
      },
    }),
    'rest.pulls.list': vi.fn().mockResolvedValue({ data: [] }),
    'rest.pulls.get': vi.fn().mockResolvedValue({
      data: {
        number: 1,
        html_url: 'https://github.com/testuser/test-repo/pull/1',
        title: 'Test PR',
        state: 'open',
      },
    }),
    'rest.issues.create': vi.fn().mockResolvedValue({
      data: {
        number: 2,
        html_url: 'https://github.com/testuser/test-repo/issues/2',
        title: 'Test Issue',
      },
    }),
    'rest.issues.list': vi.fn().mockResolvedValue({ data: [] }),
    'rest.users.getAuthenticated': vi.fn().mockResolvedValue({
      data: { login: 'testuser' },
    }),
  }

  // Aplica sobrescrições passadas pelo chamador
  for (const [key, value] of Object.entries(overrides)) {
    methods[key] = value
  }

  return {
    rest: {
      repos: {
        get: methods['rest.repos.get'],
      },
      pulls: {
        create: methods['rest.pulls.create'],
        list: methods['rest.pulls.list'],
        get: methods['rest.pulls.get'],
      },
      issues: {
        create: methods['rest.issues.create'],
        list: methods['rest.issues.list'],
      },
      users: {
        getAuthenticated: methods['rest.users.getAuthenticated'],
      },
    },
  }
}

// ─── installFetchMock / cleanupFetchMock ──────────────────────────────────────

/**
 * Instala o mock de fetch como variável global no ambiente de teste.
 * @param {{ mock: Function }} fetchMock - Objeto retornado por createFetchMock
 */
export function installFetchMock(fetchMock) {
  vi.stubGlobal('fetch', fetchMock.mock)
}

/**
 * Remove todos os globais stubados pelo Vitest (inclui fetch e outros).
 */
export function cleanupFetchMock() {
  vi.unstubAllGlobals()
}
