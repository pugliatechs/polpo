const http = require('http');
const express = require('express');
const path = require('path');
const InstanceManager = require('./instances');
const { createApiRouter } = require('./api');
const { setupWebSocket } = require('./websocket');

function createServer(options = {}) {
  const port = options.port || process.env.POLPO_PORT || 7890;
  const host = options.host || process.env.POLPO_HOST || '0.0.0.0';
  const verbose = options.verbose || false;

  const app = express();
  const server = http.createServer(app);
  const instanceManager = new InstanceManager();

  app.use(express.json());

  // Serve mobile web UI
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // API routes
  app.use('/api', createApiRouter(instanceManager));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', instances: instanceManager.getAll().length });
  });

  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
    }
  });

  // WebSocket
  const wss = setupWebSocket(server, instanceManager);

  if (verbose) {
    instanceManager.on('instance:registered', (inst) => {
      console.log(`[polpo] Instance registered: ${inst.name} (${inst.id})`);
    });
    instanceManager.on('instance:disconnected', (inst) => {
      console.log(`[polpo] Instance disconnected: ${inst.name} (${inst.id})`);
    });
    instanceManager.on('instance:status', ({ id, status }) => {
      console.log(`[polpo] Instance ${id} -> ${status}`);
    });
  }

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          console.log(`\n  🐙 Polpo server running on http://${host}:${addr.port}`);
          console.log(`     Open this URL on your phone (same network)\n`);
          resolve(addr);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        server.close(resolve);
      });
    },
    instanceManager,
    server,
  };
}

module.exports = { createServer };
