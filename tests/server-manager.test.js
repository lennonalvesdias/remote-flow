// tests/server-manager.test.js
// Testes para OpenCodeServer e ServerManager
// Cobre: toHealthInfo, registerSession, deregisterSession, _dispatchSSEEvent,
//        getAll, getServer, stopAll, _doAllocatePort, getOrCreate,
//        stop, awaitReady, _spawnProcess, _validateBin, _allocatePort

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock de child_process — evita spawnar processos reais no SO
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

// Mock de fs — evita leituras reais de arquivos de log disparadas pelo handler de stderr
vi.mock('fs', () => ({
  readFile: vi.fn(),
}))

// Mock de net — simula disponibilidade de porta sem bind real na interface
vi.mock('net', () => {
  const createServer = vi.fn(() => {
    const listeners = {}
    const srv = {
      once: vi.fn((event, cb) => {
        listeners[event] = cb
        return srv
      }),
      // Dispara 'listening' como microtask — simula porta disponível sem network real
      listen: vi.fn(() => {
        Promise.resolve().then(() => listeners['listening']?.())
        return srv
      }),
      close: vi.fn((cb) => {
        cb?.()
        return srv
      }),
    }
    return srv
  })
  return { default: { createServer }, createServer }
})

// Mock de OpenCodeClient — evita conexões HTTP reais com o servidor opencode
// Usa class para que `new OpenCodeClient(...)` funcione (arrow fn não é construtor)
vi.mock('../src/opencode-client.js', () => ({
  OpenCodeClient: class MockOpenCodeClient {
    connectSSE() {
      // Promise que nunca resolve: evita loop de reconexão SSE durante os testes
      return new Promise(() => {})
    }
  },
}))

// ─── Imports após mocks ───────────────────────────────────────────────────────

import { spawn, execSync } from 'child_process'
import { OpenCodeServer, ServerManager } from '../src/server-manager.js'

// ─── OpenCodeServer ───────────────────────────────────────────────────────────

describe('OpenCodeServer', () => {
  /** @type {OpenCodeServer} */
  let server

  beforeEach(() => {
    vi.clearAllMocks()
    server = new OpenCodeServer('/projetos/meu-projeto', 4100)
  })

  // ─── toHealthInfo() ─────────────────────────────────────────────────────────

  describe('toHealthInfo()', () => {
    it('retorna objeto com port, status e circuitBreakerUntil corretos', () => {
      const info = server.toHealthInfo()

      expect(info).toEqual({
        port: 4100,
        status: 'starting',
        circuitBreakerUntil: 0,
      })
    })

    it('reflete porta passada no construtor', () => {
      const outro = new OpenCodeServer('/proj/b', 4200)
      expect(outro.toHealthInfo().port).toBe(4200)
    })

    it('reflete status atualizado após mudança manual', () => {
      server.status = 'ready'
      expect(server.toHealthInfo().status).toBe('ready')
    })

    it('reflete circuitBreakerUntil quando circuit breaker está ativo', () => {
      const futuro = Date.now() + 60_000
      server._circuitBreakerUntil = futuro
      expect(server.toHealthInfo().circuitBreakerUntil).toBe(futuro)
    })
  })

  // ─── registerSession() e deregisterSession() ────────────────────────────────

  describe('registerSession() e deregisterSession()', () => {
    it('registerSession() mapeia apiSessionId para o objeto de sessão', () => {
      const mockSession = { handleSSEEvent: vi.fn(), emit: vi.fn() }

      server.registerSession('sess-abc', mockSession)

      expect(server._sessionRegistry.get('sess-abc')).toBe(mockSession)
    })

    it('deregisterSession() remove a sessão do registro', () => {
      const mockSession = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      server.registerSession('sess-abc', mockSession)

      server.deregisterSession('sess-abc')

      expect(server._sessionRegistry.has('sess-abc')).toBe(false)
    })

    it('deregisterSession() em ID inexistente não lança erro', () => {
      expect(() => server.deregisterSession('id-que-nao-existe')).not.toThrow()
    })

    it('pode registrar múltiplas sessões independentes', () => {
      const s1 = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      const s2 = { handleSSEEvent: vi.fn(), emit: vi.fn() }

      server.registerSession('sess-1', s1)
      server.registerSession('sess-2', s2)

      expect(server._sessionRegistry.size).toBe(2)
      expect(server._sessionRegistry.get('sess-1')).toBe(s1)
      expect(server._sessionRegistry.get('sess-2')).toBe(s2)
    })

    it('registerSession() sobrescreve sessão com mesmo ID', () => {
      const original = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      const substituta = { handleSSEEvent: vi.fn(), emit: vi.fn() }

      server.registerSession('sess-dup', original)
      server.registerSession('sess-dup', substituta)

      expect(server._sessionRegistry.get('sess-dup')).toBe(substituta)
    })
  })

  // ─── _dispatchSSEEvent() ────────────────────────────────────────────────────

  describe('_dispatchSSEEvent()', () => {
    it('chama handleSSEEvent com tipo real extraído de event.data.type', () => {
      const mockSession = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      server.registerSession('sess-xyz', mockSession)

      const evento = {
        type: 'message',
        data: { type: 'message.part.text', properties: { sessionID: 'sess-xyz' } },
      }
      server._dispatchSSEEvent(evento)

      expect(mockSession.handleSSEEvent).toHaveBeenCalledOnce()
      expect(mockSession.handleSSEEvent).toHaveBeenCalledWith({
        ...evento,
        type: 'message.part.text',
      })
    })

    it('não lança erro quando sessionId não está registrado (comportamento silencioso)', () => {
      const evento = {
        type: 'message',
        data: { type: 'message.part.text', properties: { sessionID: 'sessao-desconhecida' } },
      }

      expect(() => server._dispatchSSEEvent(evento)).not.toThrow()
    })

    it('emite event error na session quando handleSSEEvent lança exceção', () => {
      const erro = new Error('falha no processamento do evento')
      const mockSession = {
        handleSSEEvent: vi.fn().mockImplementation(() => { throw erro }),
        emit: vi.fn(),
      }
      server.registerSession('sess-err', mockSession)

      const evento = {
        type: 'message',
        data: { type: 'some.event', properties: { sessionID: 'sess-err' } },
      }
      server._dispatchSSEEvent(evento)

      expect(mockSession.emit).toHaveBeenCalledWith('error', erro)
      expect(mockSession.handleSSEEvent).toHaveBeenCalledOnce()
    })

    it('não lança erro para evento de tipo ignorado (server.heartbeat) sem sessionId', () => {
      const evento = {
        type: 'server.heartbeat',
        data: { type: 'server.heartbeat' },
      }

      expect(() => server._dispatchSSEEvent(evento)).not.toThrow()
    })

    it('resolve sessionId via data.sessionId quando properties.sessionID está ausente', () => {
      const mockSession = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      server.registerSession('sess-fallback-data', mockSession)

      const evento = {
        type: 'message',
        data: { type: 'algum.evento', sessionId: 'sess-fallback-data' },
      }
      server._dispatchSSEEvent(evento)

      expect(mockSession.handleSSEEvent).toHaveBeenCalledOnce()
    })

    it('resolve sessionId via data.properties.sessionId (minúsculo) como fallback de sessionID', () => {
      const mockSession = { handleSSEEvent: vi.fn(), emit: vi.fn() }
      server.registerSession('sess-lower', mockSession)

      const evento = {
        type: 'message',
        data: { type: 'algum.evento', properties: { sessionId: 'sess-lower' } },
      }
      server._dispatchSSEEvent(evento)

      expect(mockSession.handleSSEEvent).toHaveBeenCalledOnce()
    })
  })

  // ─── start() e _spawnProcess() ──────────────────────────────────────────────

  describe('start() e _spawnProcess()', () => {
    /** Cria um processo falso com stdout/stderr como EventEmitters */
    function makeMockProcess() {
      const p = new EventEmitter()
      p.stdout = new EventEmitter()
      p.stderr = new EventEmitter()
      p.stdout.setEncoding = vi.fn()
      p.stderr.setEncoding = vi.fn()
      p.pid = 12345
      return p
    }

    it('registra handler de stderr e não lança erro ao receber dados simples', () => {
      spawn.mockReturnValue(makeMockProcess())
      server._spawnProcess()
      const proc = spawn.mock.results[0].value

      expect(() => proc.stderr.emit('data', 'mensagem de erro genérica')).not.toThrow()
    })

    it('registra handler de stderr com padrão de arquivo de log sem lançar erro', () => {
      spawn.mockReturnValue(makeMockProcess())
      server._spawnProcess()
      const proc = spawn.mock.results[0].value

      expect(() =>
        proc.stderr.emit('data', 'falha crítica: check log file at C:\\opencode\\debug.log')
      ).not.toThrow()
    })

    it('ignora evento close quando status já é stopped', () => {
      spawn.mockReturnValue(makeMockProcess())
      server._spawnProcess()
      const proc = spawn.mock.results[0].value

      server.status = 'stopped'
      const restartSpy = vi.fn()
      server.on('restart', restartSpy)

      proc.emit('close', 0)

      expect(restartSpy).not.toHaveBeenCalled()
      expect(server.restartCount).toBe(0)
    })

    it('incrementa restartCount e emite restart ao encerrar processo antes do limite', () => {
      spawn.mockReturnValue(makeMockProcess())
      server._spawnProcess()
      const proc = spawn.mock.results[0].value

      const restartSpy = vi.fn()
      server.on('restart', restartSpy)

      proc.emit('close', 1)
      // Cancela o doRestart pendente para evitar que o timeout contamine testes seguintes
      server.status = 'stopped'

      expect(server.restartCount).toBe(1)
      expect(restartSpy).toHaveBeenCalledWith({
        restartCount: 1,
        projectPath: '/projetos/meu-projeto',
      })
    })

    it('executa doRestart e reinvoca _spawnProcess após o delay de reinicialização', async () => {
      vi.useFakeTimers()

      spawn.mockImplementation(() => makeMockProcess())
      server._spawnProcess()

      const firstProc = spawn.mock.results[0].value
      firstProc.emit('close', 1)

      // Avança o timer para disparar o doRestart (SERVER_RESTART_DELAY_MS = 2000ms)
      await vi.advanceTimersByTimeAsync(3000)

      expect(spawn).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('ativa circuit breaker e emite fatal ao atingir limite de reinicializações', async () => {
      spawn.mockReturnValue(makeMockProcess())
      server.restartCount = 3 // já no limite máximo (0-indexed: próxima falha aciona CB)
      server._spawnProcess()
      const proc = spawn.mock.results[0].value

      const fatalSpy = vi.fn()
      server.on('fatal', fatalSpy)

      // Captura a promise antes de rejeitar para evitar rejeição não tratada
      const readyPromise = server.awaitReady().catch(() => {})

      proc.emit('close', 1)

      expect(server.status).toBe('error')
      expect(server._circuitBreakerUntil).toBeGreaterThan(Date.now())
      expect(fatalSpy).toHaveBeenCalledOnce()

      await readyPromise
    })
  })

  // ─── stop() ─────────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('define status como stopped e aborta a conexão SSE', () => {
      server.sseAbortController = { abort: vi.fn() }

      server.stop()

      expect(server.status).toBe('stopped')
      expect(server.sseAbortController.abort).toHaveBeenCalledOnce()
    })

    it('chama taskkill com o PID correto quando há processo ativo (Windows)', () => {
      // Força o ramo Windows independente do SO que executa os testes
      const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      try {
        server.process = { pid: 12345, kill: vi.fn() }

        server.stop()

        expect(spawn).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', '12345', '/T', '/F'],
          { stdio: 'ignore' }
        )
      } finally {
        if (origDescriptor) Object.defineProperty(process, 'platform', origDescriptor)
      }
    })

    it('usa process.kill(-pid) com SIGTERM no ramo Linux/Mac', () => {
      // Força o ramo Linux/Mac independente do SO que executa os testes
      const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {})

      try {
        server.process = { pid: 12345, kill: vi.fn() }

        server.stop()

        expect(processKillSpy).toHaveBeenCalledWith(-12345, 'SIGTERM')
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        processKillSpy.mockRestore()
        if (origDescriptor) Object.defineProperty(process, 'platform', origDescriptor)
      }
    })

    it('chama this.process.kill quando process.kill de grupo lança ESRCH (Linux/Mac fallback)', () => {
      // Garante cobertura do catch: quando process.kill(-pid) falha, usa child.kill()
      const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      })

      try {
        const killMock = vi.fn()
        server.process = { pid: 12345, kill: killMock }

        server.stop()

        expect(killMock).toHaveBeenCalledWith('SIGTERM')
      } finally {
        processKillSpy.mockRestore()
        if (origDescriptor) Object.defineProperty(process, 'platform', origDescriptor)
      }
    })

    it('não lança erro quando process é nulo', () => {
      expect(() => server.stop()).not.toThrow()
      expect(server.status).toBe('stopped')
    })

    it('não lança erro quando sseAbortController é nulo', () => {
      server.sseAbortController = null
      expect(() => server.stop()).not.toThrow()
      expect(server.status).toBe('stopped')
    })
  })

  // ─── awaitReady() ───────────────────────────────────────────────────────────

  describe('awaitReady()', () => {
    it('retorna a promise interna de prontidão do servidor', () => {
      expect(server.awaitReady()).toBe(server._readyPromise)
    })

    it('rejeita quando o servidor esgota reinicializações e entra em estado fatal', async () => {
      const mockProcess = new EventEmitter()
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockProcess.stdout.setEncoding = vi.fn()
      mockProcess.stderr.setEncoding = vi.fn()
      mockProcess.pid = 12345
      spawn.mockReturnValue(mockProcess)

      server.restartCount = 3
      server._spawnProcess()

      mockProcess.emit('close', 1)

      await expect(server.awaitReady()).rejects.toThrow(/falhou após/)
    })
  })

  // ─── plannotatorBaseUrl ──────────────────────────────────────────────────────

  describe('plannotatorBaseUrl', () => {
    it('retorna URL HTTP com a porta plannotator configurada', () => {
      const srv = new OpenCodeServer('/proj', 4100, null, 5100)
      expect(srv.plannotatorBaseUrl).toBe('http://localhost:5100')
    })
  })

  // ─── reconnectSSE() ──────────────────────────────────────────────────────────

  describe('reconnectSSE()', () => {
    it('lança erro quando servidor está parado', () => {
      server.status = 'stopped'

      expect(() => server.reconnectSSE()).toThrow('Servidor está parado')
    })

    it('retorna imediatamente sem alterar estado quando _reconnecting já é true', () => {
      server.status = 'ready'
      server._reconnecting = true

      expect(() => server.reconnectSSE()).not.toThrow()
      expect(server._reconnecting).toBe(true)
    })

    it('define _reconnecting = true e aborta sseAbortController se presente', () => {
      server.status = 'ready'
      server.sseAbortController = { abort: vi.fn() }

      server.reconnectSSE()

      expect(server._reconnecting).toBe(true)
      expect(server.sseAbortController.abort).toHaveBeenCalled()
    })
  })
})

// ─── ServerManager ────────────────────────────────────────────────────────────

describe('ServerManager', () => {
  /** @type {ServerManager} */
  let sm

  beforeEach(() => {
    vi.clearAllMocks()
    sm = new ServerManager()
  })

  // ─── getAll() ───────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('retorna array vazio quando não há servidores registrados', () => {
      expect(sm.getAll()).toEqual([])
    })

    it('retorna array com o servidor registrado', () => {
      const fakeServer = { status: 'ready', port: 4100 }
      sm._servers.set('/proj/a', fakeServer)

      expect(sm.getAll()).toEqual([fakeServer])
    })

    it('retorna array com todos os servidores quando há múltiplos', () => {
      sm._servers.set('/proj/a', { status: 'ready', port: 4100 })
      sm._servers.set('/proj/b', { status: 'starting', port: 4101 })

      expect(sm.getAll()).toHaveLength(2)
    })
  })

  // ─── getServer() ────────────────────────────────────────────────────────────

  describe('getServer()', () => {
    it('retorna null para projeto não iniciado', () => {
      expect(sm.getServer('/projeto/nao/iniciado')).toBeNull()
    })

    it('retorna o servidor correto para projeto registrado', () => {
      const fakeServer = { status: 'ready', port: 4100 }
      sm._servers.set('/proj/registrado', fakeServer)

      expect(sm.getServer('/proj/registrado')).toBe(fakeServer)
    })

    it('retorna null para path diferente de um já registrado', () => {
      sm._servers.set('/proj/existente', { status: 'ready', port: 4100 })

      expect(sm.getServer('/proj/diferente')).toBeNull()
    })
  })

  // ─── stopAll() ──────────────────────────────────────────────────────────────

  describe('stopAll()', () => {
    it('não lança erro quando não há servidores registrados', async () => {
      await expect(sm.stopAll()).resolves.toBeUndefined()
    })

    it('chama stop() em cada servidor gerenciado', async () => {
      const fakeStop = vi.fn()
      sm._servers.set('/proj/a', { stop: fakeStop, port: 4100 })
      sm._servers.set('/proj/b', { stop: fakeStop, port: 4101 })

      await sm.stopAll()

      expect(fakeStop).toHaveBeenCalledTimes(2)
    })

    it('limpa o mapa de servidores após stopAll()', async () => {
      sm._servers.set('/proj/a', { stop: vi.fn(), port: 4100 })

      await sm.stopAll()

      expect(sm._servers.size).toBe(0)
    })

    it('limpa _usedPorts após stopAll()', async () => {
      sm._usedPorts.add(4100)
      sm._usedPorts.add(4101)

      await sm.stopAll()

      expect(sm._usedPorts.size).toBe(0)
    })
  })

  // ─── _doAllocatePort() ──────────────────────────────────────────────────────

  describe('_doAllocatePort()', () => {
    it('retorna uma porta numérica a partir de OPENCODE_BASE_PORT', async () => {
      const port = await sm._doAllocatePort()

      expect(typeof port).toBe('number')
      expect(port).toBeGreaterThanOrEqual(4100)
    })

    it('adiciona a porta alocada ao conjunto _usedPorts', async () => {
      const port = await sm._doAllocatePort()

      expect(sm._usedPorts.has(port)).toBe(true)
    })

    it('avança _nextPort para port + 1 após alocação bem-sucedida', async () => {
      const port = await sm._doAllocatePort()

      expect(sm._nextPort).toBe(port + 1)
    })

    it('pula porta já marcada como usada e retorna a próxima disponível', async () => {
      sm._usedPorts.add(4100)

      const port = await sm._doAllocatePort()

      expect(port).toBeGreaterThan(4100)
    })

    it('lança erro quando todas as portas do intervalo estão ocupadas', async () => {
      // Ocupa 200 portas consecutivas a partir de OPENCODE_BASE_PORT
      for (let i = 4100; i < 4100 + 200; i++) {
        sm._usedPorts.add(i)
      }

      await expect(sm._doAllocatePort()).rejects.toThrow(/Não foi possível alocar porta/)
    })
  })

  // ─── getOrCreate() ──────────────────────────────────────────────────────────

  describe('getOrCreate()', () => {
    it('reutiliza servidor existente em status ready sem invocar spawn', async () => {
      execSync.mockReturnValue('')
      const fakeServer = { status: 'ready', port: 4100, on: vi.fn() }
      sm._servers.set('/projetos/meu-projeto', fakeServer)

      const result = await sm.getOrCreate('/projetos/meu-projeto')

      expect(result).toBe(fakeServer)
      expect(spawn).not.toHaveBeenCalled()
    })

    it('lança erro durante cooldown ativo do circuit breaker', async () => {
      execSync.mockReturnValue('')
      const fakeServer = {
        status: 'error',
        port: 4100,
        _circuitBreakerUntil: Date.now() + 60_000,
      }
      sm._servers.set('/projetos/meu-projeto', fakeServer)

      await expect(sm.getOrCreate('/projetos/meu-projeto')).rejects.toThrow(/cooldown/i)
    })

    it('cria novo servidor para projeto desconhecido e resolve quando pronto', async () => {
      execSync.mockReturnValue('') // _validateBin passa sem lançar

      // Processo falso com stdout/stderr como EventEmitters reais
      const mockProcess = new EventEmitter()
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockProcess.stdout.setEncoding = vi.fn()
      mockProcess.stderr.setEncoding = vi.fn()
      mockProcess.pid = 12345
      mockProcess.kill = vi.fn()
      spawn.mockReturnValue(mockProcess)

      // Inicia getOrCreate sem awaitar — ainda está aguardando _allocatePort + spawn
      const getOrCreatePromise = sm.getOrCreate('/projetos/novo-projeto')

      // Cede à fila de microtasks (isPortAvailable → _allocatePort → _spawnProcess)
      await new Promise((r) => setTimeout(r, 0))

      // Emite o sinal de prontidão que o binário opencode enviaria via stdout
      mockProcess.stdout.emit('data', 'listening on http://localhost:4100\n')

      const server = await getOrCreatePromise

      expect(server).toBeDefined()
      expect(server.status).toBe('ready')
      expect(spawn).toHaveBeenCalledOnce()
    })

    it('aguarda awaitReady() para servidor em status starting e o retorna sem criar novo', async () => {
      execSync.mockReturnValue('')

      let resolveReady
      const readyPromise = new Promise((resolve) => { resolveReady = resolve })

      const startingServer = {
        status: 'starting',
        port: 4100,
        awaitReady: vi.fn(() => readyPromise),
      }
      sm._servers.set('/projetos/meu-projeto', startingServer)

      const resultPromise = sm.getOrCreate('/projetos/meu-projeto')

      // Resolve a promise antes de aguardar o resultado
      resolveReady()

      const result = await resultPromise

      expect(result).toBe(startingServer)
      expect(startingServer.awaitReady).toHaveBeenCalledOnce()
      expect(spawn).not.toHaveBeenCalled()
    })

    it('cria novo servidor quando o anterior tem status stopped', async () => {
      execSync.mockReturnValue('')

      const stoppedServer = {
        status: 'stopped',
        port: 4100,
        _circuitBreakerUntil: 0,
      }
      sm._servers.set('/projetos/meu-projeto', stoppedServer)
      sm._usedPorts.add(4100)

      const mockProcess = new EventEmitter()
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockProcess.stdout.setEncoding = vi.fn()
      mockProcess.stderr.setEncoding = vi.fn()
      mockProcess.pid = 12345
      spawn.mockReturnValue(mockProcess)

      const promise = sm.getOrCreate('/projetos/meu-projeto')
      await new Promise((r) => setTimeout(r, 0))
      mockProcess.stdout.emit('data', 'listening on http://localhost:4100\n')

      const newServer = await promise

      expect(newServer).toBeDefined()
      expect(newServer).not.toBe(stoppedServer)
      expect(spawn).toHaveBeenCalledOnce()
    })

    it('cria novo servidor após expiração do circuit breaker', async () => {
      execSync.mockReturnValue('')

      const errorServer = {
        status: 'error',
        port: 4100,
        _circuitBreakerUntil: Date.now() - 1000, // expirado no passado
      }
      sm._servers.set('/projetos/meu-projeto', errorServer)
      sm._usedPorts.add(4100)

      const mockProcess = new EventEmitter()
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockProcess.stdout.setEncoding = vi.fn()
      mockProcess.stderr.setEncoding = vi.fn()
      mockProcess.pid = 12345
      spawn.mockReturnValue(mockProcess)

      const promise = sm.getOrCreate('/projetos/meu-projeto')
      await new Promise((r) => setTimeout(r, 0))
      mockProcess.stdout.emit('data', 'listening on http://localhost:4100\n')

      const newServer = await promise

      expect(newServer).toBeDefined()
      expect(newServer).not.toBe(errorServer)
      expect(spawn).toHaveBeenCalledOnce()
    })

    it('handlers de restart e fatal são registrados e executados sem lançar erro', async () => {
      execSync.mockReturnValue('')

      const mockProcess = new EventEmitter()
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockProcess.stdout.setEncoding = vi.fn()
      mockProcess.stderr.setEncoding = vi.fn()
      mockProcess.pid = 12345
      spawn.mockReturnValue(mockProcess)

      const promise = sm.getOrCreate('/projetos/novo-projeto')
      await new Promise((r) => setTimeout(r, 0))
      mockProcess.stdout.emit('data', 'listening on http://localhost:4100\n')

      const server = await promise

      // Emitir os eventos exercita os handlers registrados em getOrCreate()
      expect(() =>
        server.emit('restart', { restartCount: 1, projectPath: '/projetos/novo-projeto' })
      ).not.toThrow()
      expect(() => server.emit('fatal', new Error('erro fatal'))).not.toThrow()
    })
  })

  // ─── _validateBin() ─────────────────────────────────────────────────────────

  describe('_validateBin()', () => {
    it('lança erro descritivo quando o binário opencode não é encontrado', () => {
      execSync.mockImplementation(() => { throw new Error('not found') })

      expect(() => sm._validateBin()).toThrow(/Binário opencode não encontrado/)
    })

    it('não executa execSync novamente se o binário já foi validado anteriormente', () => {
      execSync.mockReturnValue('')

      sm._validateBin()
      sm._validateBin()

      expect(execSync).toHaveBeenCalledTimes(1)
    })
  })

  // ─── _allocatePort() ────────────────────────────────────────────────────────

  describe('_allocatePort()', () => {
    it('serializa chamadas concorrentes e retorna portas distintas', async () => {
      const [p1, p2] = await Promise.all([sm._allocatePort(), sm._allocatePort()])

      expect(p1).not.toBe(p2)
      expect(sm._usedPorts.size).toBe(2)
    })
  })

  // ─── _allocatePlannotatorPort() ──────────────────────────────────────────────

  describe('_allocatePlannotatorPort()', () => {
    it('serializa chamadas concorrentes e retorna portas plannotator distintas', async () => {
      const [p1, p2] = await Promise.all([sm._allocatePlannotatorPort(), sm._allocatePlannotatorPort()])

      expect(p1).not.toBe(p2)
      expect(sm._usedPlannotatorPorts.size).toBe(2)
    })
  })

  // ─── _doAllocatePlannotatorPort() ────────────────────────────────────────────

  describe('_doAllocatePlannotatorPort()', () => {
    it('lança erro quando todas as portas plannotator no intervalo estão ocupadas', async () => {
      const base = sm._nextPlannotatorPort
      for (let i = 0; i < 200; i++) {
        sm._usedPlannotatorPorts.add(base + i)
      }

      await expect(sm._doAllocatePlannotatorPort()).rejects.toThrow(/Não foi possível alocar porta plannotator/)
    })
  })
})
