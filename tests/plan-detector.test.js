// tests/plan-detector.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanReviewDetector } from '../src/plan-detector.js';

// ─── Mock PlannotatorClient ──────────────────────────────────────────────────

const MockPlannotatorClient = vi.hoisted(() => vi.fn());

vi.mock('../src/plannotator-client.js', () => ({
  PlannotatorClient: MockPlannotatorClient,
}));

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('PlanReviewDetector', () => {
  let detector;

  beforeEach(() => {
    vi.useFakeTimers();
    MockPlannotatorClient.mockImplementation(function () {
      this.getPlan = vi.fn().mockResolvedValue(null);
    });
    detector = new PlanReviewDetector({
      plannotatorBaseUrl: 'http://localhost:5100',
      sessionId: 'test-session-1',
      pollInterval: 100,
    });
  });

  afterEach(() => {
    if (detector) detector.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('não emite eventos antes de start()', async () => {
    const planReadySpy = vi.fn();
    detector.on('plan-ready', planReadySpy);
    await vi.advanceTimersByTimeAsync(500);
    expect(planReadySpy).not.toHaveBeenCalled();
  });

  it('start() é idempotente — chamadas repetidas não criam loops duplos', () => {
    detector.start();
    detector.start();
    detector.start();
    // Não deve lançar erro nem criar múltiplos timers
    expect(() => detector.stop()).not.toThrow();
  });

  it('emite plan-ready quando getPlan() retorna um plano', async () => {
    const planReadySpy = vi.fn();
    detector.on('plan-ready', planReadySpy);

    // Configura getPlan para retornar um plano
    detector.client.getPlan.mockResolvedValue({ content: 'Plano teste', version: 1 });

    detector.start();
    await vi.advanceTimersByTimeAsync(150);

    expect(planReadySpy).toHaveBeenCalledOnce();
    expect(planReadySpy.mock.calls[0][0]).toEqual({ plan: { content: 'Plano teste', version: 1 } });
  });

  it('não emite plan-ready mais de uma vez para o mesmo plano', async () => {
    const planReadySpy = vi.fn();
    detector.on('plan-ready', planReadySpy);
    detector.client.getPlan.mockResolvedValue({ content: 'Plano' });

    detector.start();
    await vi.advanceTimersByTimeAsync(400); // 4 polls

    expect(planReadySpy).toHaveBeenCalledOnce();
  });

  it('emite plan-resolved quando plannotator para de responder após plan-ready', async () => {
    const planResolvedSpy = vi.fn();
    detector.on('plan-resolved', planResolvedSpy);

    // Primeiro poll: plano disponível
    detector.client.getPlan
      .mockResolvedValueOnce({ content: 'Plano' })
      // Segundo poll em diante: plano sumiu (resolvido externamente)
      .mockResolvedValue(null);

    detector.start();
    await vi.advanceTimersByTimeAsync(250); // 2+ polls

    expect(planResolvedSpy).toHaveBeenCalledOnce();
  });

  it('para de fazer polling após plan-resolved', async () => {
    detector.client.getPlan
      .mockResolvedValueOnce({ content: 'Plano' })
      .mockResolvedValue(null);

    detector.start();
    await vi.advanceTimersByTimeAsync(500);

    const callCount = detector.client.getPlan.mock.calls.length;

    // Avança mais tempo — não devem haver mais chamadas
    await vi.advanceTimersByTimeAsync(500);
    expect(detector.client.getPlan.mock.calls.length).toBe(callCount);
  });

  it('stop() cancela o polling imediatamente', async () => {
    detector.client.getPlan.mockResolvedValue({ content: 'Plano' });
    detector.start();
    detector.stop();

    const callsBefore = detector.client.getPlan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(detector.client.getPlan.mock.calls.length).toBe(callsBefore);
  });

  it('reset() permite detectar um novo ciclo de revisão', async () => {
    const planReadySpy = vi.fn();
    detector.on('plan-ready', planReadySpy);

    // Ciclo 1: plan-ready
    detector.client.getPlan.mockResolvedValue({ content: 'Plano v1' });
    detector.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(planReadySpy).toHaveBeenCalledOnce();

    // Reseta para novo ciclo (simula deny + novo plano)
    detector.reset();
    await vi.advanceTimersByTimeAsync(150);

    // Deve emitir plan-ready novamente
    expect(planReadySpy).toHaveBeenCalledTimes(2);
  });

  it('suprime erros de conexão silenciosamente', async () => {
    const errorSpy = vi.fn();
    detector.on('error', errorSpy);
    detector.client.getPlan.mockRejectedValue(new Error('ECONNREFUSED'));

    detector.start();
    await vi.advanceTimersByTimeAsync(350);

    // Não deve emitir 'error' nem crashar
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('registra falha consecutiva quando servidor está inacessível (plan === null, _planReady false)', async () => {
    // Mock padrão retorna null → servidor inacessível e _planReady ainda é false
    detector.start();
    await vi.advanceTimersByTimeAsync(150); // dispara 1 poll

    expect(detector._consecutiveFailures).toBe(1);
  });

  it('_poll() sai silenciosamente quando _active é false', async () => {
    detector.start();
    detector.stop(); // _active = false, timer cancelado

    // Chamada direta a _poll quando inativo: deve retornar sem alterar estado
    await detector._poll();

    expect(detector._consecutiveFailures).toBe(0);
  });
});
