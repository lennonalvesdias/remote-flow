// src/health.js
// Endpoint HTTP de health check para monitoramento externo e Docker HEALTHCHECK

import { createServer } from 'http';
import { HEALTH_PORT, HEALTH_HOST } from './config.js';

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

      const allServers = serverManager.getAll();
      const servers = allServers.map((srv) => srv.toHealthInfo());

      // Degrada se mais de 50% dos servidores estão em estado de erro
      const errorCount = allServers.filter((srv) => srv.toHealthInfo().status === 'error').length;
      const isDegraded = allServers.length > 0 && errorCount / allServers.length > 0.5;

      const statusCode = isDegraded ? 503 : 200;
      const statusText = isDegraded ? 'degraded' : 'ok';

      const body = JSON.stringify({
        status: statusText,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        sessions: {
          total: sessions.length,
          active: activeSessions.length,
        },
        servers,
      });

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.method === 'GET' && req.url === '/metrics') {
      const allSessions = sessionManager.getAll();
      const byStatus = {};
      for (const s of allSessions) {
        byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      }
      const active = allSessions.filter(s => !['finished', 'error'].includes(s.status)).length;
      const servers = serverManager.getAll();
      const serversByStatus = { ready: 0, error: 0, starting: 0, stopped: 0 };
      for (const srv of servers) {
        const sst = srv.status || 'stopped';
        serversByStatus[sst] = (serversByStatus[sst] || 0) + 1;
      }
      const metrics = {
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        sessions: {
          total_created: sessionManager.totalCreated ?? allSessions.length,
          active,
          by_status: byStatus
        },
        servers: {
          total: servers.length,
          ...serversByStatus
        }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics, null, 2));
      return;
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    console.log(`🩺 Health check disponível em http://${HEALTH_HOST}:${HEALTH_PORT}/health`);
  });

  server.on('error', (err) => {
    console.warn('[Health] ⚠️ Não foi possível iniciar health check:', err.message);
  });

  return server;
}
