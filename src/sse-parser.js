// ─── SSE Parser ───────────────────────────────────────────────────────────────

/**
 * Lê um `ReadableStream` de uma resposta `fetch()` no formato SSE (Server-Sent Events)
 * e invoca `onEvent` para cada evento completo recebido.
 *
 * @param {Response} response - Resposta fetch com `response.body` legível
 * @param {(event: { type: string, data: unknown, id?: string }) => void} onEvent - Callback por evento
 * @param {(err: Error) => void} [onError] - Callback opcional para erros de leitura
 * @returns {Promise<void>}
 */
export async function parseSSEStream(response, onEvent, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let eventType = 'message';
  let dataLines = [];
  let eventId = undefined;

  /**
   * Despacha o evento acumulado e reinicia o estado do evento atual.
   */
  function dispatchAndReset() {
    if (dataLines.length === 0) return;

    const rawData = dataLines.join('\n');
    let parsedData;
    try {
      parsedData = JSON.parse(rawData);
    } catch (parseErr) {
      // JSON inválido — usa rawData como fallback (esperado para eventos não-JSON)
      if (typeof globalThis.process !== 'undefined' && process.env.DEBUG) {
        console.debug('[SSEParser] JSON.parse fallback — tipo=%s erro=%s raw=%s', eventType, parseErr.message, rawData.slice(0, 100));
      }
      parsedData = rawData;
    }

    onEvent({ type: eventType, data: parsedData, id: eventId });

    eventType = 'message';
    dataLines = [];
    eventId = undefined;
  }

  /**
   * Processa uma única linha do protocolo SSE.
   * @param {string} line
   */
  function processLine(line) {
    if (line === '') {
      dispatchAndReset();
      return;
    }

    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith('id:')) {
      eventId = line.slice(3).trim();
    }
    // Campos desconhecidos e comentários (`:`) são silenciosamente ignorados
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // A última fatia pode ser uma linha incompleta — guardá-la no buffer
      buffer = lines.pop();

      for (const line of lines) {
        processLine(line.replace(/\r$/, ''));
      }
    }

    // Processar qualquer conteúdo restante no buffer após o encerramento do stream
    if (buffer.length > 0) processLine(buffer.replace(/\r$/, ''));
  } catch (err) {
    if (err.name === 'AbortError') return;

    console.error('[SSEParser] ❌ Erro ao ler stream:', err);
    onError?.(err);
    throw err;
  }
}
