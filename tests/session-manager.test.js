import { describe, it, expect } from 'vitest';
import { isWaitingForInput } from '../src/session-manager.js';

describe('isWaitingForInput', () => {
  // ─── Casos positivos ────────────────────────────────────────────────────────

  describe('positivos — deve detectar input aguardado', () => {
    it('linha terminando com ? detecta aguardo de resposta', () => {
      expect(isWaitingForInput('Deseja continuar?')).toBe(true);
    });

    it('detecta (y/n) como opção binária de confirmação', () => {
      expect(isWaitingForInput('Deseja sobrescrever o arquivo? (y/n)')).toBe(true);
    });

    it('detecta (s/n) como variante PT-BR de confirmação', () => {
      expect(isWaitingForInput('Deseja continuar? (s/n)')).toBe(true);
    });

    it('detecta (yes/no) como opção binária por extenso', () => {
      expect(isWaitingForInput('Aplicar as mudanças? (yes/no)')).toBe(true);
    });

    it('detecta (sim/não) como variante PT-BR por extenso', () => {
      expect(isWaitingForInput('Confirmar operação? (sim/não)')).toBe(true);
    });

    it('detecta "escolha:" como solicitação de seleção', () => {
      expect(isWaitingForInput('Escolha:')).toBe(true);
    });

    it('detecta "selecione:" como solicitação de seleção', () => {
      expect(isWaitingForInput('Selecione uma opção:\n1) Sim\n2) Não')).toBe(true);
    });

    it('detecta "confirma" (sem "r" seguinte) como pedido de confirmação', () => {
      expect(isWaitingForInput('Por favor confirma a operação')).toBe(true);
    });

    it('detecta "digite:" como solicitação de entrada de dados', () => {
      // O padrão busca a substring literal "digite:" — o colon deve seguir imediatamente
      expect(isWaitingForInput('Por favor, digite: seu nome')).toBe(true);
    });

    it('detecta "informe:" como solicitação de entrada de dados', () => {
      // O padrão busca a substring literal "informe:" — o colon deve seguir imediatamente
      expect(isWaitingForInput('Por favor, informe: o valor desejado')).toBe(true);
    });

    it('detecta "press enter" como aguardo de confirmação com teclado', () => {
      expect(isWaitingForInput('Pronto! Press Enter para continuar...')).toBe(true);
    });

    it('detecta "pressione enter" como variante PT-BR de aguardo de teclado', () => {
      expect(isWaitingForInput('Pressione Enter para continuar...')).toBe(true);
    });

    it('linha com > sozinho detecta prompt de input', () => {
      expect(isWaitingForInput('Selecione uma opção:\n>')).toBe(true);
    });

    it('opção numerada com parêntese "1) algo" detecta menu de seleção', () => {
      expect(isWaitingForInput('1) Confirmar\n2) Cancelar')).toBe(true);
    });

    it('opção numerada com ponto "1. algo" detecta menu de seleção', () => {
      expect(isWaitingForInput('1. Instalar dependências\n2. Pular')).toBe(true);
    });
  });

  // ─── Casos negativos ────────────────────────────────────────────────────────

  describe('negativos — não deve detectar em output normal', () => {
    it('retorna false para string vazia', () => {
      expect(isWaitingForInput('')).toBe(false);
    });

    it('retorna false para string com apenas espaços', () => {
      expect(isWaitingForInput('   ')).toBe(false);
    });

    it('retorna false para output normal de agente sem pergunta', () => {
      expect(isWaitingForInput('Analisando o código e gerando resposta...\nConcluído com sucesso.')).toBe(false);
    });

    it('retorna false quando ? está no meio de uma linha (não no final)', () => {
      // /\?\s*$/m exige que ? esteja no final da linha
      expect(isWaitingForInput('O que? é interessante aqui é a implementação')).toBe(false);
    });

    it('retorna false para "confirmar" — regex exclui "r" imediatamente após confirma', () => {
      expect(isWaitingForInput('Pode confirmar o envio do arquivo.')).toBe(false);
    });

    it('não detecta "confirmar" (com r) como pedido de input', () => {
      expect(isWaitingForInput('Para confirmar a operação, clique em OK.')).toBe(false);
    });

    it('retorna false para null', () => {
      expect(isWaitingForInput(null)).toBe(false);
    });

    it('retorna false para undefined', () => {
      expect(isWaitingForInput(undefined)).toBe(false);
    });

    it('retorna false quando > está no meio de uma linha (não sozinho)', () => {
      // /^\s*>\s*$/m exige que > esteja sozinho na linha
      expect(isWaitingForInput('10 > 5 é verdadeiro nesse contexto')).toBe(false);
    });

    it('retorna false para número com ponto sem conteúdo depois ("1. " sem palavra)', () => {
      // /\d+[).]\s+\S/m exige \S (caractere não-espaço) após os espaços
      expect(isWaitingForInput('1. ')).toBe(false);
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('detecta pergunta no final de output longo (>500 chars)', () => {
      // A função analisa apenas os últimos 500 chars; a pergunta deve estar nessa janela
      const prefixo = 'x'.repeat(600);
      const outputLongo = `${prefixo}\nDeseja continuar?`;
      expect(isWaitingForInput(outputLongo)).toBe(true);
    });

    it('retorna false quando pergunta está APENAS no início de output longo (>500 chars)', () => {
      // A pergunta fica fora dos últimos 500 chars — não deve ser detectada
      const pergunta = 'Deseja continuar?\n';
      const sufixo = 'x'.repeat(600);
      const outputLongo = `${pergunta}${sufixo}`;
      expect(isWaitingForInput(outputLongo)).toBe(false);
    });
  });
});
