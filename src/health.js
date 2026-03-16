// src/health.js
// Endpoint HTTP de health check para monitoramento externo e Docker HEALTHCHECK

import { createServer } from 'http';
import { HEALTH_PORT } from './config.js';

/**
 * Inicia um servidor HTTP de health check.
 * @param {object} opts
 * @param {import('./session-manager.js').SessionManager} opts.sessionManager
 * @param {import('./server-manager.js').ServerManager} opts.serverManager
 * @param {number} opts.startedAt - Timestamp de início do bot
 */
export function startHealthServer({ sessionManager, serverManager, startedAt }) {
  const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const sessions = sessionManager.getAll();
      const activeSessions = sessions.filter((s) => s.status !== 'finished' && s.status !== 'error');

      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        sessions: {
          total: sessions.length,
          active: activeSessions.length,
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`🩺 Health check disponível em http://0.0.0.0:${HEALTH_PORT}/health`);
  });

  server.on('error', (err) => {
    console.warn('[Health] ⚠️ Não foi possível iniciar health check:', err.message);
  });

  return server;
}
