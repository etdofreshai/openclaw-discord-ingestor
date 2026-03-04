import { Router, Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import { syncChannelToDB } from './live-sync.js';
import {
  loadJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
} from './job-store.js';
import { getRecentRuns, createRun, updateRun } from './run-store.js';
import { scheduleJob, unscheduleJob, runJobNow } from './scheduler.js';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) {
    next();
    return;
  }

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

// ── Sync UI page — always public; client-side modal handles auth if UI_TOKEN is set ──

router.get('/sync', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildSyncUI());
});

// ── API: manual sync ────────────────────────────────────────────────────────────

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
    res.status(500).json({ error: 'No saved Discord session. Log in first via /discord-login.' });
    return;
  }

  const user = await validateToken(session);
  if (!user) {
    res.status(500).json({ error: 'Discord token validation failed. Please log in again.' });
    return;
  }

  const parsedLimit =
    limit !== undefined && limit !== '' ? parseInt(String(limit), 10) : undefined;

  const startedAt = new Date().toISOString();
  const run = await createRun({
    startedAt,
    status: 'running',
    channel: channel.trim(),
    params: { limit: parsedLimit, after: after?.trim() || undefined, before: before?.trim() || undefined },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const result = await syncChannelToDB(pool, session, channel.trim(), {
      limit: parsedLimit,
      before: before?.trim() || undefined,
      after: after?.trim() || undefined,
      verbose: false,
    });

    const finishedAt = new Date().toISOString();
    await updateRun(run.runId, {
      finishedAt,
      status: 'success',
      fetchedCount: result.fetched,
      insertedCount: result.inserted,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      attachmentsSeen: result.attachmentsSeen,
    });

    res.json({
      success: true,
      runId: run.runId,
      channel: channel.trim(),
      user: `${user.username}#${user.discriminator}`,
      ...result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await updateRun(run.runId, {
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: message,
    });
    res.status(500).json({ error: message });
  } finally {
    await pool.end();
  }
});

// ── API: jobs ───────────────────────────────────────────────────────────────────

router.get('/api/jobs', requireAuth, async (_req: Request, res: Response) => {
  const jobs = await loadJobs();
  res.json(jobs);
});

router.post('/api/jobs', requireAuth, async (req: Request, res: Response) => {
  const { name, channel, limit, after, before, intervalMinutes, enabled } = req.body as {
    name?: string;
    channel?: string;
    limit?: number;
    after?: string;
    before?: string;
    intervalMinutes?: number;
    enabled?: boolean;
  };

  if (!channel || !channel.trim()) {
    res.status(400).json({ error: 'channel is required.' });
    return;
  }
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'name is required for scheduled jobs.' });
    return;
  }

  const job = await createJob({
    name: name.trim(),
    channel: channel.trim(),
    limit: limit !== undefined ? Number(limit) : undefined,
    after: after?.trim() || undefined,
    before: before?.trim() || undefined,
    intervalMinutes: Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 60,
    enabled: enabled !== false,
  });

  if (job.enabled) {
    scheduleJob(job);
  }

  res.status(201).json(job);
});

router.post('/api/jobs/:id/run', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = await getJob(id);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  // Trigger async — respond immediately; result visible in /api/runs
  runJobNow(job).catch((err: unknown) => {
    console.error(`[API] runJobNow error for job ${job.id}:`, err);
  });

  res.json({ success: true, message: 'Job triggered. Check /api/runs for result.' });
});

router.patch('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const {
    name, channel, limit, after, before, intervalMinutes, enabled,
  } = req.body as {
    name?: string;
    channel?: string;
    limit?: number | null;
    after?: string | null;
    before?: string | null;
    intervalMinutes?: number;
    enabled?: boolean;
  };

  const jobId = String(req.params.id);
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (channel !== undefined) patch.channel = String(channel).trim();
  if (limit !== undefined) patch.limit = limit === null ? undefined : Number(limit);
  if (after !== undefined) patch.after = after === null ? undefined : String(after).trim() || undefined;
  if (before !== undefined) patch.before = before === null ? undefined : String(before).trim() || undefined;
  if (intervalMinutes !== undefined) patch.intervalMinutes = Math.max(1, Number(intervalMinutes));
  if (enabled !== undefined) patch.enabled = Boolean(enabled);

  const updated = await updateJob(jobId, patch as Parameters<typeof updateJob>[1]);
  if (!updated) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  // Reschedule (or cancel) based on new enabled state
  if (updated.enabled) {
    scheduleJob(updated);
  } else {
    unscheduleJob(updated.id);
  }

  res.json(updated);
});

router.delete('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const delId = String(req.params.id);
  unscheduleJob(delId);
  const ok = await deleteJob(delId);
  if (!ok) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  res.json({ success: true });
});

// ── API: runs ───────────────────────────────────────────────────────────────────

router.get('/api/runs', requireAuth, async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const runs = await getRecentRuns(Math.min(Math.max(1, limit), 200));
  res.json(runs);
});

// ── HTML UI builder ─────────────────────────────────────────────────────────────

function buildSyncUI(): string {
  const requiresAuth = Boolean(process.env.UI_TOKEN);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Discord Live Sync</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;padding:24px 16px}
.page{max-width:900px;margin:0 auto}
h1{font-size:1.5rem;font-weight:700;color:#fff}
.subtitle{color:#888;font-size:.875rem;margin-bottom:20px;margin-top:2px}
.card{background:#2f3136;border:1px solid #3d4046;border-radius:12px;padding:20px;margin-bottom:16px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card-title{font-size:1rem;font-weight:600;color:#ccc}
.field{margin-bottom:14px}
label{display:block;font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.field-hint{font-size:.76rem;color:#666;margin-bottom:5px;line-height:1.4}
input[type=text],input[type=password],input[type=number],select{width:100%;background:#40444b;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:8px 11px;font-size:.88rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:#7289da;box-shadow:0 0 0 2px rgba(114,137,218,.2)}
input::placeholder{color:#555}
select option{background:#2f3136}
.badge{display:inline-block;font-size:.62rem;padding:1px 5px;border-radius:4px;vertical-align:middle;margin-left:5px;text-transform:uppercase;letter-spacing:.04em;font-weight:700}
.badge-req{background:#7289da;color:#fff}
.badge-opt{background:#4f545c;color:#aaa}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:6px;padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn-primary{background:#7289da;color:#fff;width:100%;justify-content:center;padding:10px;font-size:.95rem;border-radius:8px;margin-top:4px}
.btn-primary:hover:not(:disabled){background:#5b6eae}
.btn-primary:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
.btn-sm{padding:4px 9px;font-size:.78rem;border-radius:5px}
.btn-success{background:#22c55e;color:#000}
.btn-success:hover{background:#16a34a}
.btn-warn{background:#f59e0b;color:#000}
.btn-warn:hover{background:#d97706}
.btn-danger{background:#ef4444;color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-ghost{background:#4f545c;color:#ccc}
.btn-ghost:hover{background:#67707b}
.btn-run{background:#5865f2;color:#fff}
.btn-run:hover{background:#4752c4}
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.top-bar-left{display:flex;flex-direction:column}
#auth-bar{display:flex;align-items:center;gap:8px;margin-top:4px}
.auth-status{font-size:.78rem;color:#aaa}
.auth-status.ok{color:#22c55e}
.nav-link{color:#7289da;font-size:.82rem;text-decoration:none}
.nav-link:hover{text-decoration:underline}
.result-box{margin-top:12px;background:#1e2124;border:1px solid #555;border-radius:8px;padding:14px;font-size:.82rem}
.result-box.ok{border-color:#22c55e}
.result-box.err{border-color:#ef4444}
.result-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;font-size:.8rem;color:#e0e0e0;line-height:1.5}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead th{color:#888;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid #3d4046;text-align:left}
tbody td{padding:7px 8px;border-bottom:1px solid #2a2d31;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(255,255,255,.03)}
.status-pill{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:99px;letter-spacing:.04em}
.pill-ok{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
.pill-err{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.pill-run{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.pill-dis{background:rgba(100,116,139,.15);color:#64748b;border:1px solid rgba(100,116,139,.3)}
.empty-row{text-align:center;color:#555;padding:20px;font-size:.85rem}
.actions{display:flex;gap:4px;flex-wrap:wrap}
.mono{font-family:'Courier New',monospace;font-size:.78rem;color:#a8b4ff}
.err-text{color:#f87171;font-size:.75rem}
/* Auth modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(3px)}
.modal-card{background:#2f3136;border:1px solid #7289da;border-radius:14px;padding:28px;width:100%;max-width:420px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.modal-card h2{font-size:1.1rem;font-weight:700;color:#fff;margin-bottom:6px}
.modal-card p{color:#888;font-size:.85rem;margin-bottom:18px;line-height:1.5}
.modal-card label{font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px}
.modal-card input{width:100%;background:#40444b;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:10px 12px;font-size:.9rem;outline:none;margin-bottom:12px}
.modal-card input:focus{border-color:#7289da}
.modal-err{color:#f87171;font-size:.8rem;margin-bottom:8px;display:none}
.scroll-x{overflow-x:auto}
</style>
</head>
<body>
<div class="page">

<!-- Auth Modal -->
<div class="modal-overlay" id="auth-modal" style="display:none">
  <div class="modal-card">
    <h2>🔑 Authentication Required</h2>
    <p>This Sync UI requires a token. Enter your <code>UI_TOKEN</code> to unlock access. The token is saved in your browser and used for all API calls.</p>
    <label>UI Token</label>
    <input type="password" id="modal-token-input" placeholder="Paste your UI_TOKEN here" autocomplete="current-password"/>
    <div class="modal-err" id="modal-err">Incorrect token — please try again.</div>
    <button class="btn btn-primary" onclick="submitModalToken()" style="margin-top:0">Unlock</button>
  </div>
</div>

<div class="top-bar">
  <div class="top-bar-left">
    <h1>🔄 Discord Live Sync</h1>
    <p class="subtitle">Pull messages from Discord channels into the OpenClaw memory database.</p>
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
    <a class="nav-link" href="/discord-login">← Discord Login</a>
    <div id="auth-bar" style="display:none">
      <span class="auth-status" id="auth-status-text">🔓 Authenticated</span>
      <button class="btn btn-sm btn-ghost" onclick="clearSavedToken()">Clear Token</button>
    </div>
  </div>
</div>

<!-- ── New Sync Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">⚡ New Sync</span>
  </div>

  <div class="field">
    <label>Mode</label>
    <p class="field-hint">Choose whether to run a one-off sync immediately, or create a scheduled job that repeats on an interval.</p>
    <select id="mode" onchange="onModeChange()">
      <option value="manual">Manual Run — execute immediately</option>
      <option value="scheduled">Scheduled Job — repeat on interval</option>
    </select>
  </div>

  <div class="field" id="field-name" style="display:none">
    <label>Job Name <span class="badge badge-req">required</span></label>
    <p class="field-hint">A human-readable name for this scheduled job (e.g. "General Channel Hourly").</p>
    <input type="text" id="job-name" placeholder="e.g. General Hourly Sync"/>
  </div>

  <div class="field">
    <label>Channel ID <span class="badge badge-req">required</span></label>
    <p class="field-hint">The numeric Discord channel ID to sync. Right-click a channel in Discord → <em>Copy Channel ID</em> (requires Developer Mode in Discord settings).</p>
    <input type="text" id="channel" placeholder="e.g. 123456789012345678" autocomplete="off"/>
  </div>

  <div class="field">
    <label>Limit <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Max messages to fetch per run. Discord caps this at 100. Leave blank for the default (100).</p>
    <input type="number" id="limit" min="1" max="100" placeholder="100"/>
  </div>

  <div class="field">
    <label>After <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Fetch messages <em>after</em> this message ID (exclusive). Paste the ID of the last message you have for incremental syncs.</p>
    <input type="text" id="after" placeholder="e.g. 987654321098765432" autocomplete="off"/>
  </div>

  <div class="field">
    <label>Before <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Fetch messages <em>before</em> this message ID (exclusive). Use for paginating backwards through channel history. Cannot be combined with After.</p>
    <input type="text" id="before" placeholder="e.g. 987654321098765432" autocomplete="off"/>
  </div>

  <div class="field" id="field-interval" style="display:none">
    <label>Schedule Interval (minutes) <span class="badge badge-req">required</span></label>
    <p class="field-hint">How often the job should run. Default is 60 minutes (every hour). Minimum is 1 minute.</p>
    <input type="number" id="interval" min="1" value="60" placeholder="60"/>
  </div>

  <button class="btn btn-primary" id="submit-btn" onclick="handleSubmit()">▶ Run Sync</button>
  <div id="sync-result"></div>
</div>

<!-- ── Scheduled Jobs Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📅 Scheduled Jobs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadJobsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="jobs-container">
    <div style="color:#555;font-size:.85rem">Loading jobs…</div>
  </div>
</div>

<!-- ── Recent Runs Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📋 Recent Runs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadRunsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="runs-container">
    <div style="color:#555;font-size:.85rem">Loading runs…</div>
  </div>
</div>

</div><!-- .page -->
<script>
// ── Constants injected by server ────────────────────────────────────────────
const REQUIRES_AUTH = ${requiresAuth ? 'true' : 'false'};
const TOKEN_KEY = 'discord_sync_ui_token';

// ── Token management ────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function saveToken(val) { localStorage.setItem(TOKEN_KEY, val); }
function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
  updateAuthBar();
  if (REQUIRES_AUTH) showModal();
}
function getHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

// ── Auth modal ──────────────────────────────────────────────────────────────
function showModal() {
  document.getElementById('auth-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('modal-token-input').focus(), 50);
}
function hideModal() { document.getElementById('auth-modal').style.display = 'none'; }

async function submitModalToken() {
  const input = document.getElementById('modal-token-input');
  const errEl = document.getElementById('modal-err');
  const val = input.value.trim();
  if (!val) return;

  // Validate against the server
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/jobs', {
      headers: { 'Authorization': 'Bearer ' + val, 'Content-Type': 'application/json' }
    });
    if (res.status === 401) {
      errEl.style.display = 'block';
      return;
    }
    saveToken(val);
    hideModal();
    updateAuthBar();
    loadJobsTable();
    loadRunsTable();
  } catch {
    errEl.textContent = 'Network error — try again.';
    errEl.style.display = 'block';
  }
}
document.getElementById('modal-token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitModalToken();
});

function updateAuthBar() {
  const bar = document.getElementById('auth-bar');
  const txt = document.getElementById('auth-status-text');
  if (!REQUIRES_AUTH) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (getToken()) {
    txt.textContent = '🔓 Authenticated';
    txt.className = 'auth-status ok';
  } else {
    txt.textContent = '🔒 Not authenticated';
    txt.className = 'auth-status';
  }
}

// ── Mode selector ───────────────────────────────────────────────────────────
function onModeChange() {
  const mode = document.getElementById('mode').value;
  const isScheduled = mode === 'scheduled';
  document.getElementById('field-name').style.display = isScheduled ? '' : 'none';
  document.getElementById('field-interval').style.display = isScheduled ? '' : 'none';
  document.getElementById('submit-btn').textContent = isScheduled ? '📅 Create Scheduled Job' : '▶ Run Sync';
}

// ── Submit handler ──────────────────────────────────────────────────────────
async function handleSubmit() {
  const mode = document.getElementById('mode').value;
  if (mode === 'scheduled') {
    await handleCreateJob();
  } else {
    await handleRunSync();
  }
}

async function handleRunSync() {
  const channel = document.getElementById('channel').value.trim();
  if (!channel) { showResult('error', 'Channel ID is required.'); return; }

  const limit = document.getElementById('limit').value.trim();
  const after = document.getElementById('after').value.trim();
  const before = document.getElementById('before').value.trim();

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing…';

  try {
    const body = { channel };
    if (limit) body.limit = parseInt(limit, 10);
    if (after) body.after = after;
    if (before) body.before = before;

    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showResult('ok', '✅ Sync complete', data);
      loadRunsTable();
    } else {
      showResult('error', '❌ Sync failed (HTTP ' + res.status + ')', data);
    }
  } catch (err) {
    showResult('error', '❌ Network error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Sync';
  }
}

async function handleCreateJob() {
  const name = document.getElementById('job-name').value.trim();
  const channel = document.getElementById('channel').value.trim();
  const limit = document.getElementById('limit').value.trim();
  const after = document.getElementById('after').value.trim();
  const before = document.getElementById('before').value.trim();
  const interval = document.getElementById('interval').value.trim();

  if (!name) { showResult('error', 'Job name is required.'); return; }
  if (!channel) { showResult('error', 'Channel ID is required.'); return; }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  try {
    const body = {
      name,
      channel,
      intervalMinutes: parseInt(interval || '60', 10),
      enabled: true,
    };
    if (limit) body.limit = parseInt(limit, 10);
    if (after) body.after = after;
    if (before) body.before = before;

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok && data.id) {
      showResult('ok', '✅ Scheduled job created', data);
      loadJobsTable();
      // Reset form
      document.getElementById('job-name').value = '';
      document.getElementById('channel').value = '';
      document.getElementById('limit').value = '';
      document.getElementById('after').value = '';
      document.getElementById('before').value = '';
      document.getElementById('interval').value = '60';
    } else {
      showResult('error', '❌ Failed to create job (HTTP ' + res.status + ')', data);
    }
  } catch (err) {
    showResult('error', '❌ Network error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📅 Create Scheduled Job';
  }
}

function showResult(type, label, data) {
  const cls = type === 'ok' ? 'ok' : 'err';
  const body = data ? '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>' : '';
  document.getElementById('sync-result').innerHTML =
    '<div class="result-box ' + cls + '"><div class="result-label">' + esc(label) + '</div>' + body + '</div>';
}

// ── Jobs table ──────────────────────────────────────────────────────────────
async function loadJobsTable() {
  const el = document.getElementById('jobs-container');
  try {
    const res = await fetch('/api/jobs', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const jobs = await res.json();
    el.innerHTML = renderJobsTable(jobs);
  } catch (err) {
    el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error loading jobs: ' + esc(err.message) + '</p>';
  }
}

function renderJobsTable(jobs) {
  if (!jobs.length) {
    return '<p style="color:#555;font-size:.85rem;padding:12px 0">No scheduled jobs yet. Use the form above and select "Scheduled Job" mode.</p>';
  }
  let rows = jobs.map(j => {
    const statusPill = j.lastStatus === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : j.lastStatus === 'error' ? '<span class="status-pill pill-err">error</span>'
      : j.lastStatus === 'running' ? '<span class="status-pill pill-run">running</span>'
      : '<span class="status-pill pill-dis">never</span>';
    const enabledPill = j.enabled
      ? '<span class="status-pill pill-ok">enabled</span>'
      : '<span class="status-pill pill-dis">disabled</span>';
    const lastRun = j.lastRunAt ? reltime(j.lastRunAt) : '—';
    const toggleLabel = j.enabled ? 'Disable' : 'Enable';
    const toggleClass = j.enabled ? 'btn-warn' : 'btn-success';
    return \`<tr>
      <td>\${esc(j.name)}</td>
      <td><span class="mono">\${esc(j.channel)}</span></td>
      <td>\${j.intervalMinutes}m</td>
      <td>\${enabledPill}</td>
      <td>\${lastRun}</td>
      <td>\${statusPill}</td>
      <td><div class="actions">
        <button class="btn btn-sm btn-run" onclick="triggerJobRun('\${esc(j.id)}', this)">▶ Run</button>
        <button class="btn btn-sm \${toggleClass}" onclick="toggleJob('\${esc(j.id)}', \${!j.enabled}, this)">\${toggleLabel}</button>
        <button class="btn btn-sm btn-danger" onclick="removeJob('\${esc(j.id)}', this)">✕</button>
      </div></td>
    </tr>\`;
  }).join('');

  return \`<table>
    <thead><tr>
      <th>Name</th><th>Channel</th><th>Every</th><th>Status</th><th>Last Run</th><th>Last Result</th><th>Actions</th>
    </tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

async function triggerJobRun(id, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/jobs/' + id + '/run', { method: 'POST', headers: getHeaders() });
    const data = await res.json();
    if (res.ok) {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; loadJobsTable(); loadRunsTable(); }, 1500);
    } else {
      alert('Error: ' + (data.error || 'Unknown'));
      btn.textContent = orig;
      btn.disabled = false;
    }
  } catch (err) {
    alert('Network error: ' + err.message);
    btn.textContent = orig;
    btn.disabled = false;
  }
}

async function toggleJob(id, enable, btn) {
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs/' + id, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ enabled: enable }),
    });
    if (res.ok) { loadJobsTable(); }
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

async function removeJob(id, btn) {
  if (!confirm('Delete this scheduled job?')) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs/' + id, { method: 'DELETE', headers: getHeaders() });
    if (res.ok) { loadJobsTable(); }
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

// ── Runs table ──────────────────────────────────────────────────────────────
async function loadRunsTable() {
  const el = document.getElementById('runs-container');
  try {
    const res = await fetch('/api/runs?limit=50', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const runs = await res.json();
    el.innerHTML = renderRunsTable(runs);
  } catch (err) {
    el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error loading runs: ' + esc(err.message) + '</p>';
  }
}

function renderRunsTable(runs) {
  if (!runs.length) {
    return '<p style="color:#555;font-size:.85rem;padding:12px 0">No runs recorded yet. Trigger a sync or wait for a scheduled job to execute.</p>';
  }
  let rows = runs.map(r => {
    const statusPill = r.status === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : r.status === 'error' ? '<span class="status-pill pill-err">error</span>'
      : '<span class="status-pill pill-run">running</span>';
    const source = r.jobId ? '<span class="mono" title="Job ID: ' + esc(r.jobId) + '">scheduled</span>' : 'manual';
    const errCell = r.error ? '<span class="err-text" title="' + esc(r.error) + '">' + esc(r.error.slice(0, 40)) + (r.error.length > 40 ? '…' : '') + '</span>' : '—';
    const dur = r.finishedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + 's' : '…';
    return \`<tr>
      <td title="\${esc(r.startedAt)}">\${reltime(r.startedAt)}</td>
      <td>\${source}</td>
      <td><span class="mono">\${esc(r.channel)}</span></td>
      <td>\${statusPill}</td>
      <td>\${r.fetchedCount}</td>
      <td>\${r.insertedCount}</td>
      <td>\${r.updatedCount}</td>
      <td>\${r.skippedCount}</td>
      <td>\${r.attachmentsSeen}</td>
      <td>\${dur}</td>
      <td>\${errCell}</td>
    </tr>\`;
  }).join('');

  return \`<table>
    <thead><tr>
      <th>Started</th><th>Source</th><th>Channel</th><th>Status</th>
      <th>Fetched</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Attachments</th>
      <th>Duration</th><th>Error</th>
    </tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// ── Utilities ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function reltime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.round(diff/1000) + 's ago';
  if (diff < 3600000) return Math.round(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff/3600000) + 'h ago';
  return Math.round(diff/86400000) + 'd ago';
}

// ── Init ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  updateAuthBar();

  if (REQUIRES_AUTH && !getToken()) {
    showModal();
  } else {
    loadJobsTable();
    loadRunsTable();
  }

  // Auto-refresh every 30s
  setInterval(() => {
    if (REQUIRES_AUTH && !getToken()) return;
    loadJobsTable();
    loadRunsTable();
  }, 30000);
});
</script>
</body>
</html>`;
}

export default router;
