import 'dotenv/config';
import http from 'http';
import express from 'express';
import loginRouter, { handleDiscordLoginWs } from './lib/login-server.js';
import syncRouter from './lib/sync-router.js';
import backfillRouter from './lib/backfill-router.js';
import { startScheduler } from './lib/scheduler.js';

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.LOGIN_SERVER_PORT || '3456', 10);

// Parse JSON request bodies (required for /api/sync, /api/jobs, etc.)
app.use(express.json());

// Login server routes
app.use(loginRouter);

// Sync UI + API routes
app.use(syncRouter);

// Backfill UI + API routes
app.use(backfillRouter);

// Health check
app.get('/', (_req, res) => {
  res.json({
    name: 'openclaw-discord-ingestor',
    version: '0.2.0',
    endpoints: {
      login: '/discord-login',
      status: '/discord-login/status',
      validate: '/discord-login/validate',
      syncUi: '/sync',
      syncApi: '/api/sync',
      jobs: '/api/jobs',
      runs: '/api/runs',
      backfillUi: '/backfill',
      backfillApi: {
        start: 'POST /api/backfill/start',
        status: 'GET /api/backfill/status/:runId',
        runs: 'GET /api/backfill/runs',
        pause: 'POST /api/backfill/pause',
        resume: 'POST /api/backfill/resume/:runId',
        events: 'GET /api/backfill/events/:runId (SSE)',
      },
    },
  });
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;

  if (pathname === '/discord-login/ws') {
    handleDiscordLoginWs(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, async () => {
  console.log(`[Discord Ingestor] Running on http://localhost:${PORT}`);
  console.log(`[Discord Ingestor] Login UI:    http://localhost:${PORT}/discord-login`);
  console.log(`[Discord Ingestor] Sync UI:     http://localhost:${PORT}/sync`);
  console.log(`[Discord Ingestor] Backfill UI: http://localhost:${PORT}/backfill`);

  // Start the job scheduler after server is listening
  await startScheduler();
});
