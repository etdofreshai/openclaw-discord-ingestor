import 'dotenv/config';
import http from 'http';
import express from 'express';
import loginRouter, { handleDiscordLoginWs } from './lib/login-server.js';

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.LOGIN_SERVER_PORT || '3456', 10);

// Login server routes
app.use(loginRouter);

// Health check
app.get('/', (_req, res) => {
  res.json({
    name: 'openclaw-discord-ingestor',
    version: '0.1.0',
    endpoints: {
      login: '/discord-login',
      status: '/discord-login/status',
      validate: '/discord-login/validate',
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

server.listen(PORT, () => {
  console.log(`[Discord Login Server] Running on http://localhost:${PORT}`);
  console.log(`[Discord Login Server] Login UI: http://localhost:${PORT}/discord-login`);
});
