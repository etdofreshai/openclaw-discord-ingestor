import { Router, Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import { syncChannelToDB } from './live-sync.js';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) {
    // Auth disabled mode: allow access when UI_TOKEN is unset
    next();
    return;
  }

  // Accept token from Authorization header or ?token= query param
  const authHeader = req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;

  const provided = bearer ?? queryToken;

  if (!provided || provided !== uiToken) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing UI_TOKEN.' });
    return;
  }

  next();
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Sync UI page — auth checked client-side (token entered in form, stored in localStorage)
// The page itself is public but all API calls require the token.
// For defense-in-depth, require the token to even view the page.
router.get('/sync', requireAuth, (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(SYNC_UI_HTML);
});

// API: trigger sync
router.post('/api/sync', requireAuth, async (req: Request, res: Response) => {
  const { channel, limit, before, after } = req.body as {
    channel?: string;
    limit?: string | number;
    before?: string;
    after?: string;
  };

  if (!channel || typeof channel !== 'string' || !channel.trim()) {
    res.status(400).json({ error: 'channel is required.' });
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(500).json({ error: 'DATABASE_URL is not configured.' });
    return;
  }

  const session = await loadSession();
  if (!session) {
    res.status(500).json({ error: 'No saved Discord session found. Please log in first via /discord-login.' });
    return;
  }

  const user = await validateToken(session);
  if (!user) {
    res.status(500).json({ error: 'Discord token validation failed. Please log in again via /discord-login.' });
    return;
  }

  const parsedLimit = limit !== undefined && limit !== '' ? parseInt(String(limit), 10) : undefined;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const result = await syncChannelToDB(pool, session, channel.trim(), {
      limit: parsedLimit,
      before: before?.trim() || undefined,
      after: after?.trim() || undefined,
      verbose: false,
    });
    res.json({
      success: true,
      channel: channel.trim(),
      user: `${user.username}#${user.discriminator}`,
      ...result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  } finally {
    await pool.end();
  }
});

// ── HTML UI ────────────────────────────────────────────────────────────────────

const SYNC_UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Discord Live Sync</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:.875rem;margin-bottom:24px}
  .card{width:100%;max-width:560px;background:#2f3136;border:1px solid #444;border-radius:12px;padding:24px;margin-bottom:16px}
  .card h2{font-size:1rem;font-weight:600;color:#ccc;margin-bottom:16px}
  .field{margin-bottom:16px}
  label{display:block;font-size:.8rem;font-weight:600;color:#aaa;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
  .field-hint{font-size:.78rem;color:#666;margin-bottom:6px;line-height:1.4}
  input[type="text"],input[type="password"],input[type="number"]{width:100%;background:#40444b;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:9px 12px;font-size:.9rem;outline:none;transition:border-color .15s}
  input[type="text"]:focus,input[type="password"]:focus,input[type="number"]:focus{border-color:#7289da;box-shadow:0 0 0 2px rgba(114,137,218,.2)}
  input::placeholder{color:#555}
  .required-badge{display:inline-block;background:#7289da;color:#fff;font-size:.65rem;padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.04em}
  .optional-badge{display:inline-block;background:#4f545c;color:#aaa;font-size:.65rem;padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.04em}
  button[type="submit"]{width:100%;background:#7289da;color:#fff;border:none;border-radius:8px;padding:11px;font-size:1rem;font-weight:600;cursor:pointer;transition:background .15s;margin-top:4px}
  button[type="submit"]:hover{background:#5b6eae}
  button[type="submit"]:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  #result{width:100%;max-width:560px}
  .result-card{background:#1e2124;border:1px solid #555;border-radius:10px;padding:20px;font-size:.875rem}
  .result-card.success{border-color:#22c55e}
  .result-card.error{border-color:#ef4444}
  .result-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:8px}
  pre{white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;font-size:.82rem;color:#e0e0e0;line-height:1.5}
  .success-icon{font-size:1.4rem;margin-right:6px}
  .error-icon{font-size:1.4rem;margin-right:6px;color:#ef4444}
  .spinner{display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .nav-link{color:#7289da;font-size:.85rem;text-decoration:none;margin-bottom:20px;display:inline-block}
  .nav-link:hover{text-decoration:underline}
  .token-row{display:flex;gap:8px;align-items:center}
  .token-row input{flex:1}
  .save-btn{background:#4f545c;color:#e0e0e0;border:none;border-radius:6px;padding:9px 14px;cursor:pointer;font-size:.8rem;white-space:nowrap;transition:background .15s}
  .save-btn:hover{background:#67707b}
  .saved-indicator{font-size:.75rem;color:#22c55e;display:none}
</style>
</head>
<body>

<h1>🔄 Discord Live Sync</h1>
<p class="subtitle">Pull messages from a Discord channel into the OpenClaw memory database.</p>

<a class="nav-link" href="/discord-login">← Discord Login (capture session token)</a>

<div class="card">
  <h2>🔑 Auth Token</h2>
  <div class="field">
    <label>UI Token <span class="optional-badge">optional</span></label>
    <p class="field-hint">Only needed when server-side <code>UI_TOKEN</code> is configured. If auth is disabled, leave blank.</p>
    <div class="token-row">
      <input type="password" id="ui-token" placeholder="Paste your UI_TOKEN here" autocomplete="current-password"/>
      <button class="save-btn" onclick="saveToken()">Save</button>
    </div>
    <span class="saved-indicator" id="saved-indicator">✓ Saved</span>
  </div>
</div>

<div class="card">
  <h2>⚙️ Sync Parameters</h2>
  <form id="sync-form" onsubmit="runSync(event)">

    <div class="field">
      <label>Channel ID <span class="required-badge">required</span></label>
      <p class="field-hint">The numeric Discord channel ID to sync from. Right-click a channel → "Copy Channel ID" (requires Developer Mode in Discord settings).</p>
      <input type="text" id="channel" name="channel" placeholder="e.g. 123456789012345678" autocomplete="off"/>
    </div>

    <div class="field">
      <label>Limit <span class="optional-badge">optional</span></label>
      <p class="field-hint">Max number of messages to fetch in one request. Discord caps this at 100. Defaults to 100 if not set.</p>
      <input type="number" id="limit" name="limit" placeholder="e.g. 50" min="1" max="100"/>
    </div>

    <div class="field">
      <label>After <span class="optional-badge">optional</span></label>
      <p class="field-hint">Fetch messages <em>after</em> this message ID (exclusive). Useful for incremental syncs — paste the ID of the last message you already have.</p>
      <input type="text" id="after" name="after" placeholder="e.g. 987654321098765432" autocomplete="off"/>
    </div>

    <div class="field">
      <label>Before <span class="optional-badge">optional</span></label>
      <p class="field-hint">Fetch messages <em>before</em> this message ID (exclusive). Use for paginating backwards through history. Cannot be combined with <code>after</code>.</p>
      <input type="text" id="before" name="before" placeholder="e.g. 987654321098765432" autocomplete="off"/>
    </div>

    <button type="submit" id="submit-btn">▶ Run Sync</button>
  </form>
</div>

<div id="result"></div>

<script>
const REQUIRES_AUTH = ${process.env.UI_TOKEN ? 'true' : 'false'};

// Load saved token from localStorage
const TOKEN_KEY = 'discord_sync_ui_token';
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem(TOKEN_KEY) || '';
  if (saved) document.getElementById('ui-token').value = saved;
});

function saveToken() {
  const val = document.getElementById('ui-token').value.trim();
  localStorage.setItem(TOKEN_KEY, val);
  const ind = document.getElementById('saved-indicator');
  ind.style.display = 'inline';
  setTimeout(() => { ind.style.display = 'none'; }, 2000);
}

async function runSync(event) {
  event.preventDefault();

  const token = document.getElementById('ui-token').value.trim();
  if (REQUIRES_AUTH && !token) {
    showError('Please enter your UI Token above.');
    return;
  }

  const channel = document.getElementById('channel').value.trim();
  if (!channel) {
    showError('Channel ID is required.');
    return;
  }

  const limit = document.getElementById('limit').value.trim();
  const after = document.getElementById('after').value.trim();
  const before = document.getElementById('before').value.trim();

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Syncing…';

  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = '';

  try {
    const body = { channel };
    if (limit) body.limit = parseInt(limit, 10);
    if (after) body.after = after;
    if (before) body.before = before;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/api/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      resultDiv.innerHTML = \`
        <div class="result-card success">
          <div class="result-label">✅ Sync Result</div>
          <pre>\${JSON.stringify(data, null, 2)}</pre>
        </div>
      \`;
    } else {
      resultDiv.innerHTML = \`
        <div class="result-card error">
          <div class="result-label">❌ Error (HTTP \${res.status})</div>
          <pre>\${JSON.stringify(data, null, 2)}</pre>
        </div>
      \`;
    }
  } catch (err) {
    showError(err.message || 'Network error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ Run Sync';
  }
}

function showError(msg) {
  document.getElementById('result').innerHTML = \`
    <div class="result-card error">
      <div class="result-label">❌ Error</div>
      <pre>\${msg}</pre>
    </div>
  \`;
}
</script>
</body>
</html>`;

export default router;
