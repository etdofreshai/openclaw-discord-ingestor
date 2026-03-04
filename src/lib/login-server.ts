import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { Router } from 'express';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { createDiscordLoginTab, cdpListTabs, cdpCloseTab } from './browser.js';
import { saveSession, loadSession, type DiscordSession } from './session.js';
import { validateToken } from './token-validator.js';

const router = Router();
const wss = new WebSocketServer({ noServer: true });

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

type SessionStatus = 'idle' | 'running' | 'success' | 'timeout' | 'error';

interface LoginSession {
  tabId: string;
  webSocketDebuggerUrl: string;
  status: SessionStatus;
  message: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let session: LoginSession | null = null;

function closeSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timeoutHandle);
  // Close the tab asynchronously
  cdpListTabs()
    .then(tabs => {
      for (const tab of tabs) {
        if (tab.id === s.tabId) {
          cdpCloseTab(tab.id).catch(() => {});
        }
      }
    })
    .catch(() => {});
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve self-contained HTML UI
router.get('/discord-login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(REMOTE_LOGIN_HTML);
});

// Start the browser session
router.post('/discord-login/start', async (_req, res) => {
  if (session && session.status === 'running') {
    return res.status(409).json({ error: 'Session already running' });
  }

  // Close any stale session
  closeSession();

  try {
    console.log('[Discord Login] Starting Chromium and creating login tab...');
    const tabInfo = await createDiscordLoginTab();

    const timeoutHandle = setTimeout(() => {
      if (session && session.status === 'running') {
        console.log('[Discord Login] Session timed out.');
        session.status = 'timeout';
        session.message = '⏰ Session timed out after 5 minutes.';
        closeSession();
      }
    }, SESSION_TIMEOUT_MS);

    session = {
      tabId: tabInfo.id,
      webSocketDebuggerUrl: tabInfo.webSocketDebuggerUrl,
      status: 'running',
      message: 'Browser started. Please log in to your Discord account.',
      startedAt: Date.now(),
      timeoutHandle,
    };

    console.log('[Discord Login] Session started, tab:', tabInfo.id);
    res.json({ success: true, message: 'Browser session started.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Discord Login] Failed to start:', message);
    res.status(500).json({ error: message });
  }
});

// Session status
router.get('/discord-login/status', async (_req, res) => {
  if (!session) {
    // Check if we have a persisted session
    const saved = await loadSession();
    if (saved) {
      return res.json({
        status: 'idle',
        message: 'Saved session found. Use /discord-login/validate to verify.',
        hasSavedSession: true,
      });
    }
    return res.json({ status: 'idle', message: 'No session active.' });
  }
  const remainingMs = SESSION_TIMEOUT_MS - (Date.now() - session.startedAt);
  res.json({
    status: session.status,
    message: session.message,
    remainingMs: Math.max(0, remainingMs),
  });
});

// Validate saved token
router.post('/discord-login/validate', async (_req, res) => {
  const saved = await loadSession();
  if (!saved) {
    return res.status(404).json({ error: 'No saved session found' });
  }

  const user = await validateToken(saved);
  if (!user) {
    return res.status(401).json({ error: 'Token validation failed. Please log in again.' });
  }

  res.json({ success: true, user });
});

// Stop / abort the session
router.post('/discord-login/stop', (_req, res) => {
  closeSession();
  res.json({ success: true });
});

// ── WebSocket upgrade handler ──────────────────────────────────────────────────

export function handleDiscordLoginWs(req: IncomingMessage, socket: Duplex, head: Buffer) {
  wss.handleUpgrade(req, socket, head, clientWs => {
    if (!session || session.status !== 'running') {
      clientWs.close(1008, 'No active login session');
      return;
    }

    const cdpWsUrl = session.webSocketDebuggerUrl;
    const cdpWs = new NodeWebSocket(cdpWsUrl);
    let cmdId = 1;
    let capturedToken: string | null = null;

    function cdpCommand(method: string, params: any = {}) {
      const id = cmdId++;
      if (cdpWs.readyState === NodeWebSocket.OPEN) {
        cdpWs.send(JSON.stringify({ method, params, id }));
      }
      return id;
    }

    async function checkAndCaptureToken() {
      if (capturedToken && session) {
        console.log('[Discord Login] Token captured successfully!');

        const user = await validateToken({ token: capturedToken, capturedAt: new Date().toISOString() });
        if (!user) {
          console.error('[Discord Login] Token validation failed after capture');
          return;
        }

        const discordSession: DiscordSession = {
          token: capturedToken,
          userId: user.id,
          username: user.username,
          capturedAt: new Date().toISOString(),
        };

        await saveSession(discordSession);

        session.status = 'success';
        session.message = '✅ Login successful! Token captured and validated.';
        if (clientWs.readyState === NodeWebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'success', user }));
        }
        setTimeout(() => closeSession(), 4000);
      }
    }

    cdpWs.on('open', () => {
      cdpCommand('Page.enable');
      cdpCommand('Network.enable');
      cdpCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        maxWidth: VIEWPORT_WIDTH,
        maxHeight: VIEWPORT_HEIGHT,
      });
    });

    cdpWs.on('message', async data => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.method === 'Page.screencastFrame') {
          const { sessionId, metadata } = msg.params;
          if (clientWs.readyState === NodeWebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: 'frame',
                data: msg.params.data,
                metadata,
              })
            );
          }
          cdpCommand('Page.screencastFrameAck', { sessionId });
        } else if (msg.method === 'Network.responseReceived') {
          // Check for Discord API responses that indicate successful login
          const url = msg.params?.response?.url || '';
          if (url.includes('discord.com/api') && url.includes('@me')) {
            // Try to extract token from localStorage
            const result = await new Promise<string | null>(resolve => {
              const id = cmdId++;
              cdpWs.send(
                JSON.stringify({
                  id,
                  method: 'Runtime.evaluate',
                  params: {
                    expression: `(
                      function() {
                        const raw = localStorage.getItem('token');
                        if (!raw) return null;
                        try {
                          const parsed = JSON.parse(raw);
                          if (typeof parsed === 'string') return parsed;
                          if (parsed && typeof parsed.token === 'string') return parsed.token;
                          return String(parsed);
                        } catch {
                          return raw.replace(/^\"|\"$/g, '');
                        }
                      }
                    )()`,
                    returnByValue: true,
                  },
                })
              );

              const handler = (data: Buffer) => {
                try {
                  const resp = JSON.parse(data.toString());
                  if (resp.id === id) {
                    cdpWs.off('message', handler);
                    resolve(resp.result?.result?.value || null);
                  }
                } catch {}
              };
              cdpWs.on('message', handler);

              // Timeout after 2 seconds
              setTimeout(() => {
                cdpWs.off('message', handler);
                resolve(null);
              }, 2000);
            });

            if (result && typeof result === 'string') {
              capturedToken = result;
              await checkAndCaptureToken();
            }
          }
        }
      } catch {}
    });

    // Periodically check localStorage for token (every 2 seconds)
    const tokenCheckInterval = setInterval(async () => {
      if (!session || session.status !== 'running') {
        clearInterval(tokenCheckInterval);
        return;
      }

      try {
        const result = await new Promise<string | null>(resolve => {
          const id = cmdId++;
          cdpWs.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: {
                expression: `(
                  function() {
                    const raw = localStorage.getItem('token');
                    if (!raw) return null;
                    try {
                      const parsed = JSON.parse(raw);
                      if (typeof parsed === 'string') return parsed;
                      if (parsed && typeof parsed.token === 'string') return parsed.token;
                      return String(parsed);
                    } catch {
                      return raw.replace(/^\"|\"$/g, '');
                    }
                  }
                )()`,
                returnByValue: true,
              },
            })
          );

          const handler = (data: Buffer) => {
            try {
              const resp = JSON.parse(data.toString());
              if (resp.id === id) {
                cdpWs.off('message', handler);
                resolve(resp.result?.result?.value || null);
              }
            } catch {}
          };
          cdpWs.on('message', handler);

          setTimeout(() => {
            cdpWs.off('message', handler);
            resolve(null);
          }, 1000);
        });

        if (result && typeof result === 'string' && result !== capturedToken) {
          capturedToken = result;
          await checkAndCaptureToken();
        }
      } catch {}
    }, 2000);

    // Handle input events from client
    clientWs.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'click') {
          const { x, y } = msg;
          cdpCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          setTimeout(() => {
            cdpCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x,
              y,
              button: 'left',
              clickCount: 1,
            });
            setTimeout(() => {
              cdpCommand('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x,
                y,
                button: 'left',
                clickCount: 1,
              });
            }, 50);
          }, 30);
        } else if (msg.type === 'keydown') {
          const key = msg.key as string;
          const keyInfo = SPECIAL_KEY_MAP[key];
          if (keyInfo) {
            cdpCommand('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              key,
              code: keyInfo.code,
              windowsVirtualKeyCode: keyInfo.keyCode,
            });
            if (keyInfo.text) {
              cdpCommand('Input.dispatchKeyEvent', { type: 'char', text: keyInfo.text });
            }
            cdpCommand('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key,
              code: keyInfo.code,
              windowsVirtualKeyCode: keyInfo.keyCode,
            });
          } else {
            cdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
            cdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
          }
        } else if (msg.type === 'type') {
          cdpCommand('Input.insertText', { text: msg.text });
        }
      } catch {}
    });

    const cleanup = () => {
      clearInterval(tokenCheckInterval);
      try {
        cdpCommand('Page.stopScreencast');
      } catch {}
      try {
        cdpWs.close();
      } catch {}
      try {
        clientWs.close();
      } catch {}
    };

    clientWs.on('close', cleanup);
    cdpWs.on('close', () => {
      try {
        clientWs.close();
      } catch {}
    });
    cdpWs.on('error', err => {
      console.error('[Discord Login] CDP WS error:', err.message);
      try {
        clientWs.close();
      } catch {}
    });
    clientWs.on('error', () => cleanup());
  });
}

// ── Special key map ───────────────────────────────────────────────────────────

const SPECIAL_KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'Prior', keyCode: 33 },
  PageDown: { code: 'Next', keyCode: 34 },
  F5: { code: 'F5', keyCode: 116 },
  F12: { code: 'F12', keyCode: 123 },
};

// ── HTML UI ───────────────────────────────────────────────────────────────────

const REMOTE_LOGIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Discord Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px 8px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#fff}
  .notice{background:#7289da;color:#fff;padding:12px;border-radius:8px;margin-bottom:12px;max-width:900px;width:100%;font-size:.85rem}
  #status-bar{width:100%;max-width:900px;background:#2f3136;border:1px solid #444;border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:.9rem;min-height:42px;display:flex;align-items:center;gap:8px}
  #status-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;transition:background .3s}
  #status-dot.running{background:#22c55e;animation:pulse 1.2s infinite}
  #status-dot.success{background:#22c55e}
  #status-dot.timeout,#status-dot.error{background:#ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #timer{margin-left:auto;font-size:.8rem;color:#888;white-space:nowrap}
  .controls{width:100%;max-width:900px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
  button{background:#7289da;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:.85rem;font-weight:500;transition:background .15s;white-space:nowrap}
  button:hover{background:#5b6eae}
  button:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  button.danger{background:#ed4245}
  button.danger:hover{background:#c03537}
  button.secondary{background:#4f545c}
  button.secondary:hover{background:#67707b}
  #type-input{flex:1;min-width:180px;background:#40444b;border:1px solid #444;color:#e0e0e0;border-radius:6px;padding:8px 12px;font-size:.85rem}
  #type-input:focus{outline:none;border-color:#7289da}
  .key-group{display:flex;gap:4px}
  #canvas-wrap{width:100%;max-width:900px;position:relative;background:#111;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;outline:none;transition:border-color .2s}
  #canvas-wrap.inactive{cursor:default;pointer-events:none}
  #canvas-wrap.canvas-focused{border-color:#7289da;box-shadow:0 0 0 2px rgba(114,137,218,.3)}
  #screen{display:block;width:100%;height:auto;user-select:none}
  #placeholder{width:100%;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;color:#555;font-size:1rem}
  #click-flash{position:absolute;pointer-events:none;border-radius:50%;width:28px;height:28px;background:rgba(114,137,218,.5);border:2px solid rgba(114,137,218,.9);transform:translate(-50%,-50%) scale(0);transition:transform .08s ease-out,opacity .35s ease-out;opacity:0}
  #click-flash.active{transform:translate(-50%,-50%) scale(1);opacity:1}
  #overlay-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-size:1.3rem;font-weight:600;color:#fff}
  #focus-hint{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#aaa;font-size:.75rem;padding:3px 10px;border-radius:20px;pointer-events:none;transition:opacity .3s}
  #canvas-wrap.canvas-focused #focus-hint{opacity:0}
</style>
</head>
<body>
<h1>👾 Discord Login</h1>
<div class="notice">
  <strong>⚠️ Security Notice:</strong> Your Discord user token will be stored locally. Never share this token with anyone. Treat it like a password.
</div>
<div id="status-bar">
  <span id="status-dot"></span>
  <span id="status-text">Click "Start Login" to open the browser.</span>
  <span id="timer"></span>
</div>
<div class="controls">
  <button id="start-btn" onclick="startSession()">▶ Start Login</button>
  <button id="stop-btn" class="danger" onclick="stopSession()" disabled>■ Stop</button>
  <input id="type-input" type="text" placeholder="Paste or type text here then press Enter to send…" onkeydown="onInputKey(event)"/>
  <div class="key-group">
    <button class="secondary" onclick="sendKey('Enter')" disabled id="key-enter">↵ Enter</button>
    <button class="secondary" onclick="sendKey('Tab')" disabled id="key-tab">⇥ Tab</button>
    <button class="secondary" onclick="sendKey('Backspace')" disabled id="key-bs">⌫ Back</button>
    <button class="secondary" onclick="sendKey('Escape')" disabled id="key-esc">Esc</button>
  </div>
</div>
<div id="canvas-wrap" class="inactive" tabindex="0">
  <canvas id="screen"></canvas>
  <div id="placeholder">Screenshot will appear here after starting the session.</div>
  <div id="click-flash"></div>
  <div id="overlay-msg"></div>
  <div id="focus-hint">Click to focus • keyboard input will be forwarded</div>
</div>
<script>
const BASE = '';
let ws = null;
let sessionActive = false;
let startTime = null;
let timerInterval = null;
let hasFirstFrame = false;
let canvasFocused = false;
let frameDeviceWidth = ${VIEWPORT_WIDTH};
let frameDeviceHeight = ${VIEWPORT_HEIGHT};
let frameOffsetTop = 0;
let framePageScale = 1;
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const canvasWrap = document.getElementById('canvas-wrap');
const clickFlash = document.getElementById('click-flash');
canvas.width = ${VIEWPORT_WIDTH};
canvas.height = ${VIEWPORT_HEIGHT};

function setStatus(text, dotClass) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = dotClass || '';
}

function setControlsEnabled(enabled) {
  sessionActive = enabled;
  document.getElementById('stop-btn').disabled = !enabled;
  ['key-enter','key-tab','key-bs','key-esc'].forEach(id => { document.getElementById(id).disabled = !enabled; });
  canvasWrap.classList.toggle('inactive', !enabled);
  if (!enabled) { canvasFocused = false; canvasWrap.classList.remove('canvas-focused'); }
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    if (!startTime) return;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 300000 - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer').textContent = remaining > 0 ? \`⏱ \${m}:\${s.toString().padStart(2,'0')} left\` : '';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('timer').textContent = '';
}

function connectWs() {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/discord-login/ws';
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { console.log('[WS] Connected to screencast'); };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'frame') {
        if (msg.metadata) {
          frameDeviceWidth = msg.metadata.deviceWidth || ${VIEWPORT_WIDTH};
          frameDeviceHeight = msg.metadata.deviceHeight || ${VIEWPORT_HEIGHT};
          frameOffsetTop = msg.metadata.offsetTop || 0;
          framePageScale = msg.metadata.pageScaleFactor || 1;
        }
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
          if (!hasFirstFrame) { hasFirstFrame = true; placeholder.style.display = 'none'; canvas.style.display = 'block'; }
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'success') {
        stopTimer();
        setStatus('✅ Login successful! Token captured. Redirecting…', 'success');
        setControlsEnabled(false);
        showOverlay('✅ Login successful! Redirecting…');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
        setTimeout(() => { window.location.href = '/'; }, 3000);
      }
    } catch(e) {}
  };
  ws.onclose = () => { console.log('[WS] Disconnected from screencast'); };
  ws.onerror = (e) => { console.error('[WS] Error', e); };
}

async function startSession() {
  document.getElementById('start-btn').disabled = true;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Starting browser…';
  setStatus('Starting browser…', 'running');
  try {
    const r = await fetch(BASE + '/discord-login/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start');
    setStatus('Browser started. Connecting to screencast…', 'running');
    setControlsEnabled(true);
    startTimer();
    setTimeout(() => { connectWs(); startStatusPolling(); }, 500);
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('start-btn').disabled = false;
    placeholder.textContent = 'Failed to start. Try again.';
  }
}

async function stopSession() {
  stopTimer();
  stopStatusPolling();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  await fetch(BASE + '/discord-login/stop', { method: 'POST' }).catch(() => {});
  setControlsEnabled(false);
  setStatus('Session stopped.', '');
  document.getElementById('start-btn').disabled = false;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Session stopped.';
}

let statusPollTimer = null;
function startStatusPolling() {
  statusPollTimer = setInterval(async () => {
    try {
      const r = await fetch(BASE + '/discord-login/status');
      const data = await r.json();
      if (data.status === 'timeout') {
        stopStatusPolling();
        stopTimer();
        setStatus(data.message, 'timeout');
        setControlsEnabled(false);
        showOverlay('⏰ Timed out. Please try again.');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
      } else if (data.status === 'error') {
        stopStatusPolling();
        stopTimer();
        setStatus(data.message || 'An error occurred.', 'error');
        setControlsEnabled(false);
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
      }
    } catch {}
  }, 3000);
}
function stopStatusPolling() {
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function showOverlay(msg) {
  const o = document.getElementById('overlay-msg');
  o.textContent = msg;
  o.style.display = 'flex';
}

canvasWrap.addEventListener('click', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!canvasFocused) { canvasFocused = true; canvasWrap.classList.add('canvas-focused'); canvasWrap.focus(); }
  const rect = canvas.getBoundingClientRect();
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  const bx = Math.round(relX * frameDeviceWidth / framePageScale);
  const by = Math.round(relY * frameDeviceHeight / framePageScale + frameOffsetTop);
  const wrapRect = canvasWrap.getBoundingClientRect();
  clickFlash.style.left = (event.clientX - wrapRect.left) + 'px';
  clickFlash.style.top = (event.clientY - wrapRect.top) + 'px';
  clickFlash.classList.add('active');
  setTimeout(() => { clickFlash.classList.remove('active'); }, 400);
  ws.send(JSON.stringify({ type: 'click', x: bx, y: by }));
});

document.addEventListener('click', (event) => {
  if (!canvasWrap.contains(event.target) && canvasFocused) {
    canvasFocused = false;
    canvasWrap.classList.remove('canvas-focused');
  }
});

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F5', 'F12']);

document.addEventListener('keydown', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (document.activeElement === document.getElementById('type-input')) return;
  event.preventDefault();
  if (SPECIAL_KEYS.has(event.key)) {
    ws.send(JSON.stringify({ type: 'keydown', key: event.key }));
  } else if (event.key.length === 1) {
    if (event.ctrlKey || event.metaKey) {
      ws.send(JSON.stringify({ type: 'keydown', key: event.key }));
    } else {
      ws.send(JSON.stringify({ type: 'type', text: event.key }));
    }
  }
});

function onInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendTypeBarText();
  }
}

function sendTypeBarText() {
  const input = document.getElementById('type-input');
  const text = input.value;
  if (!text || !sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'type', text }));
  input.value = '';
}

function sendKey(key) {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'keydown', key }));
}
</script>
</body>
</html>`;

export default router;
