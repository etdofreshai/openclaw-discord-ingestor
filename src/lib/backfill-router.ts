/**
 * Backfill Router — Two Modes
 *
 * **Default backfill** (attachmentMode: 'missing'):
 *   - Non-existing messages → download message, content, and create attachment links
 *   - Existing messages → check if they have attachment links and content.
 *     If missing, download those. If message + attachment links + content all exist → skip.
 *
 * **Force backfill** (attachmentMode: 'force'):
 *   - Re-download message, attachment links, and content, overriding any existing values.
 *
 * Endpoints:
 *   POST /api/backfill/start   — Start attachment backfill from local DB
 *   POST /api/refetch/start    — Refetch from Discord API + download + ingest
 *   GET  /api/backfill/status/:runId — Get run status & progress
 *   GET  /api/backfill/runs    — List recent runs
 *   POST /api/backfill/pause   — Pause active run
 *   POST /api/backfill/resume/:runId — Resume paused run
 *   GET  /api/backfill/events/:runId — SSE stream for live progress
 */
import crypto from 'node:crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  backfillAttachments,
  refetchAndIngestAttachments,
  BackfillProgress,
  BackfillOptions,
  type RefetchOptions,
} from '../commands/backfill-attachments.js';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import {
  loadBackfillRuns,
  createBackfillRun,
  updateBackfillRun,
  getBackfillRun,
  getRecentBackfillRuns,
  getActiveBackfillRun,
} from './backfill-store.js';

const router = Router();

// Track active runs and their progress
const activeRuns = new Map<
  string,
  {
    progress: BackfillProgress;
    controller?: AbortController;
    cancelRequested?: boolean;
  }
>();

// Track SSE clients for each run
const sseClients = new Map<string, Set<Response>>();

// ── Backfill Queue ────────────────────────────────────────────────────────────

interface QueuedBackfill {
  runId: string;
  channelId?: string;
  options: BackfillOptions;
  queuedAt: Date;
}

const backfillQueue: QueuedBackfill[] = [];

async function processNextInQueue() {
  if (backfillQueue.length === 0) return;

  // Check if something is already running
  const existingActive = await getActiveBackfillRun();
  if (existingActive) return;

  const next = backfillQueue.shift();
  if (!next) return;

  // Start the queued backfill
  try {
    const run = await createBackfillRun(next.options, next.runId, next.channelId);

    activeRuns.set(run.runId, {
      progress: {
        runId: run.runId,
        page: next.options.resumeFrom,
        totalPages: 0,
        messagesProcessed: 0,
        downloadedCount: 0,
        ingestedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        startTime: new Date(),
        currentTime: new Date(),
      },
    });

    sseClients.set(run.runId, new Set());

    runBackfillInBackground(run.runId, next.options);
  } catch (err) {
    console.error(`[backfill-queue] Error starting queued run ${next.runId}:`, err);
    // Try next in queue
    processNextInQueue();
  }
}

function runBackfillInBackground(runId: string, options: BackfillOptions) {
  backfillAttachments(options, (progress) => {
    const existing = activeRuns.get(runId);
    if (existing?.cancelRequested) {
      throw new Error('CANCELLED');
    }
    activeRuns.set(runId, { ...existing, progress });

    const clients = sseClients.get(runId);
    if (clients) {
      const msg = 'data: ' + JSON.stringify(progress) + '\n\n';
      clients.forEach(client => client.write(msg));
    }
  })
    .then(async (stats) => {
      await updateBackfillRun(runId, {
        status: 'complete',
        completedAt: new Date().toISOString(),
        stats: {
          totalMessages: stats.messagesProcessed,
          messagesWithAttachments: stats.messagesWithAttachments,
          downloadedAttachments: stats.attachmentsDownloaded,
          ingestedAttachments: stats.attachmentsIngested,
          skipped: stats.attachmentsSkipped,
          errors: stats.errors.length,
        },
      });

      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: complete\ndata: ' + JSON.stringify({ runId, status: 'complete' }) + '\n\n';
        clients.forEach(client => { client.write(msg); client.end(); });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
      processNextInQueue();
    })
    .catch(async (err) => {
      const wasCancelled = err?.message === 'CANCELLED';
      if (!wasCancelled) console.error(`[backfill] Error in backfill run ${runId}:`, err);
      await updateBackfillRun(runId, {
        status: wasCancelled ? 'paused' : 'error',
        completedAt: new Date().toISOString(),
        error: wasCancelled ? undefined : (err.message || String(err)),
      });

      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: error\ndata: ' + JSON.stringify({ runId, status: 'error', message: err.message || String(err) }) + '\n\n';
        clients.forEach(client => { client.write(msg); client.end(); });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
      processNextInQueue();
    });
}

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

// ── Backfill UI page ────────────────────────────────────────────────────────────

router.get('/backfill', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const requiresAuth = Boolean(process.env.UI_TOKEN);
  res.send(buildBackfillUI(requiresAuth));
});

// ── API: Start backfill ────────────────────────────────────────────────────────────

router.post('/api/backfill/start', requireAuth, async (req: Request, res: Response) => {
  const { batchSize = 10, limit, dryRun = false, resumeFrom = 1, attachmentMode = 'missing', channelId } = req.body as {
    batchSize?: number;
    limit?: number;
    dryRun?: boolean;
    resumeFrom?: number;
    attachmentMode?: 'missing' | 'force';
    channelId?: string;
  };

  const options: BackfillOptions = {
    batchSize: Math.max(1, batchSize),
    limit,
    dryRun,
    resumeFrom: Math.max(1, resumeFrom),
    attachmentMode: attachmentMode === 'force' ? 'force' : 'missing',
  };

  // Check if there's already an active backfill
  const existingActive = await getActiveBackfillRun();
  if (existingActive || backfillQueue.length > 0) {
    // Queue the request instead of rejecting
    const queuedRunId = crypto.randomUUID();
    backfillQueue.push({
      runId: queuedRunId,
      channelId,
      options,
      queuedAt: new Date(),
    });
    const position = backfillQueue.length;

    res.status(202).json({
      queued: true,
      runId: queuedRunId,
      channelId,
      position,
    });
    return;
  }

  try {
    const run = await createBackfillRun(options, undefined, channelId);

    activeRuns.set(run.runId, {
      progress: {
        runId: run.runId,
        page: resumeFrom,
        totalPages: 0,
        messagesProcessed: 0,
        downloadedCount: 0,
        ingestedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        startTime: new Date(),
        currentTime: new Date(),
      },
    });

    sseClients.set(run.runId, new Set());

    res.json({
      runId: run.runId,
      status: 'running',
      startedAt: run.startedAt,
      progress: activeRuns.get(run.runId)?.progress,
    });

    runBackfillInBackground(run.runId, options);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Start refetch (Discord fetch + in-place UPDATE + download + ingest) ────────────────

router.post('/api/refetch/start', requireAuth, async (req: Request, res: Response) => {
  const { batchSize = 10, limit, dryRun = false, attachmentMode = 'missing' } = req.body as {
    batchSize?: number;
    limit?: number;
    dryRun?: boolean;
    attachmentMode?: 'missing' | 'force';
  };

  // Load Discord session
  let session;
  let user;
  
  try {
    session = await loadSession();
  } catch (err) {
    console.error('[refetch] Error loading session:', err);
    res.status(400).json({ 
      error: 'Failed to load Discord session. Please log in via /discord-login first.',
      requiresLogin: true 
    });
    return;
  }

  if (!session) {
    res.status(400).json({ 
      error: 'No Discord session found. Please log in via /discord-login first.',
      requiresLogin: true 
    });
    return;
  }

  try {
    user = await validateToken(session);
  } catch (err) {
    console.error('[refetch] Error validating token:', err);
  }

  if (!user) {
    res.status(400).json({ 
      error: 'Discord token validation failed. Please log in again via /discord-login.',
      requiresLogin: true 
    });
    return;
  }

  // Check if there's already an active refetch
  const existingActive = await getActiveBackfillRun();
  if (existingActive) {
    res.status(409).json({
      error: 'A refetch is already running.',
      runId: existingActive.runId,
    });
    return;
  }

  const options: RefetchOptions = {
    batchSize: Math.max(1, batchSize),
    limit,
    dryRun,
  };

  try {
    const run = await createBackfillRun({ ...options, resumeFrom: 1 });

    // Initialize active run tracking
    activeRuns.set(run.runId, {
      progress: {
        runId: run.runId,
        page: 1,
        totalPages: 1, // Unknown for refetch
        messagesProcessed: 0,
        downloadedCount: 0,
        ingestedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        startTime: new Date(),
        currentTime: new Date(),
      },
    });

    sseClients.set(run.runId, new Set());

    res.json({
      runId: run.runId,
      status: 'running',
      startedAt: run.startedAt,
      progress: activeRuns.get(run.runId)?.progress,
    });

    // Start refetch in background (don't await)
    const apiUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
    const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ??
      process.env.MEMORY_DATABASE_API_TOKEN ?? '';

    refetchAndIngestAttachments(session, apiUrl, writeToken, options, (progress) => {
      const current = activeRuns.get(run.runId);
      if (current) {
        current.progress = {
          ...current.progress,
          messagesProcessed: progress.messagesProcessed,
          downloadedCount: progress.downloadedCount,
          ingestedCount: progress.ingestedCount,
          currentTime: new Date(),
          lastEvent: progress.lastMessage,
          recentItems: progress.recentItems as any,
        };
        activeRuns.set(run.runId, current);

        // Broadcast to all SSE clients
        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg = 'data: ' + JSON.stringify(current.progress) + '\n\n';
          clients.forEach(client => {
            client.write(msg);
          });
        }
      }
    })
      .then(async (stats) => {
        // Mark as complete
        await updateBackfillRun(run.runId, {
          status: 'complete',
          completedAt: new Date().toISOString(),
          stats: {
            totalMessages: stats.messagesProcessed,
            messagesWithAttachments: stats.messagesUpdated,
            downloadedAttachments: stats.attachmentsDownloaded,
            ingestedAttachments: stats.attachmentsIngested,
            skipped: stats.attachmentsSkipped,
            errors: stats.errors.length,
          },
        });

        // Broadcast completion
        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg = 'event: complete\ndata: ' + JSON.stringify({
            runId: run.runId,
            status: 'complete',
          }) + '\n\n';
          clients.forEach(client => {
            client.write(msg);
            client.end();
          });
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
        processNextInQueue();
      })
      .catch(async (err) => {
        console.error(`[refetch] Error in refetch run ${run.runId}:`, err);
        
        // Mark as error
        await updateBackfillRun(run.runId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: err.message || String(err),
        });

        // Broadcast error
        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg = 'event: error\ndata: ' + JSON.stringify({
            runId: run.runId,
            status: 'error',
            message: err.message || String(err),
          }) + '\n\n';
          clients.forEach(client => {
            client.write(msg);
            client.end();
          });
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
        processNextInQueue();
      });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to start refetch' });
  }
});

// ── API: Get backfill status ────────────────────────────────────────────────────────────

router.get('/api/backfill/status/:runId', requireAuth, async (req: Request, res: Response) => {
  const runId = String(req.params.runId);

  // Check if it's in the queue (not yet started)
  const queueIdx = backfillQueue.findIndex(q => q.runId === runId);
  if (queueIdx !== -1) {
    const queued = backfillQueue[queueIdx];
    res.json({
      runId,
      status: 'queued',
      position: queueIdx + 1,
      channelId: queued.channelId,
      queuedAt: queued.queuedAt,
    });
    return;
  }

  const run = await getBackfillRun(runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found.' });
    return;
  }

  const activeData = activeRuns.get(runId);
  const progress = activeData?.progress;

  res.json({
    runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    paused: run.paused,
    progress: progress || {
      page: run.lastPage,
      totalPages: run.totalPages,
      messagesProcessed: run.stats.totalMessages,
      downloadedCount: run.stats.downloadedAttachments,
      ingestedCount: run.stats.ingestedAttachments,
      skippedCount: run.stats.skipped,
      errorCount: run.stats.errors,
    },
    stats: run.stats,
  });
});

// ── API: Get backfill queue ────────────────────────────────────────────────────────────

router.get('/api/backfill/queue', requireAuth, (_req: Request, res: Response) => {
  res.json({
    queue: backfillQueue.map((q, i) => ({
      runId: q.runId,
      channelId: q.channelId,
      queuedAt: q.queuedAt,
      position: i + 1,
    })),
    length: backfillQueue.length,
  });
});

// ── API: Remove from queue ────────────────────────────────────────────────────────────

router.delete('/api/backfill/queue/:runId', requireAuth, (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const idx = backfillQueue.findIndex(q => q.runId === runId);
  if (idx === -1) {
    res.status(404).json({ error: 'Not found in queue.' });
    return;
  }
  backfillQueue.splice(idx, 1);
  res.json({ removed: true, runId });
});

// ── API: List backfill runs ────────────────────────────────────────────────────────────

router.get('/api/backfill/runs', requireAuth, async (_req: Request, res: Response) => {
  const runs = await getRecentBackfillRuns(50);
  res.json({
    runs: runs.map(run => ({
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      attachmentMode: (run.options as any)?.attachmentMode ?? 'missing',
      stats: run.stats,
    })),
  });
});

// ── API: Pause backfill ────────────────────────────────────────────────────────────

router.post('/api/backfill/pause', requireAuth, async (req: Request, res: Response) => {
  const { runId } = req.body as { runId?: string };

  if (!runId) {
    res.status(400).json({ error: 'runId is required.' });
    return;
  }

  const run = await getBackfillRun(runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found.' });
    return;
  }

  if (run.status !== 'running') {
    res.status(400).json({ error: 'Run is not currently running.' });
    return;
  }

  const activeData = activeRuns.get(runId);
  const currentPage = activeData?.progress.page ?? run.lastPage;

  // Signal the running loop to stop at next progress callback
  if (activeData) {
    activeRuns.set(runId, { ...activeData, cancelRequested: true });
  }

  await updateBackfillRun(runId, {
    paused: true,
    pausedAt: new Date().toISOString(),
    lastPage: currentPage,
  });

  res.json({
    runId,
    status: 'paused',
    lastPage: currentPage,
  });
});

// ── API: Force-cancel (ghost cleanup) ─────────────────────────────────────────────

router.post('/api/backfill/runs/:runId/force-cancel', requireAuth, async (req: Request, res: Response) => {
  const { runId } = req.params;
  try {
    await updateBackfillRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Force-cancelled by user',
    });
    // Also remove from activeRuns if somehow still there
    activeRuns.delete(runId);
    res.json({ runId, status: 'cancelled' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Resume backfill ────────────────────────────────────────────────────────────

router.post('/api/backfill/resume/:runId', requireAuth, async (req: Request, res: Response) => {
  const runId = String(req.params.runId);

  const run = await getBackfillRun(runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found.' });
    return;
  }

  if (!run.paused) {
    res.status(400).json({ error: 'Run is not paused.' });
    return;
  }

  // Check if there's already an active backfill
  const existingActive = await getActiveBackfillRun();
  if (existingActive && existingActive.runId !== runId) {
    res.status(409).json({ error: 'Another backfill is already running.' });
    return;
  }

  await updateBackfillRun(runId, {
    paused: false,
    pausedAt: undefined,
    status: 'running',
  });

  // Re-initialize active run tracking
  activeRuns.set(runId, {
    progress: {
      runId,
      page: run.lastPage,
      totalPages: run.totalPages,
      messagesProcessed: run.stats.totalMessages,
      downloadedCount: run.stats.downloadedAttachments,
      ingestedCount: run.stats.ingestedAttachments,
      skippedCount: run.stats.skipped,
      errorCount: run.stats.errors,
      startTime: new Date(),
      currentTime: new Date(),
    },
  });

  sseClients.set(runId, new Set());

  res.json({
    runId,
    status: 'running',
    lastPage: run.lastPage,
  });

  // Restart backfill in background
  backfillAttachments(
    {
      ...run.options,
      resumeFrom: run.lastPage,
    },
    (progress) => {
      activeRuns.set(runId, { progress });
      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'data: ' + JSON.stringify(progress) + '\n\n';
        clients.forEach(client => {
          client.write(msg);
        });
      }
    }
  )
    .then(async (stats) => {
      await updateBackfillRun(runId, {
        status: 'complete',
        completedAt: new Date().toISOString(),
        stats: {
          totalMessages: stats.messagesProcessed,
          messagesWithAttachments: stats.messagesWithAttachments,
          downloadedAttachments: stats.attachmentsDownloaded,
          ingestedAttachments: stats.attachmentsIngested,
          skipped: stats.attachmentsSkipped,
          errors: stats.errors.length,
        },
      });

      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: complete\ndata: ' + JSON.stringify({
          runId,
          status: 'complete',
        }) + '\n\n';
        clients.forEach(client => {
          client.write(msg);
          client.end();
        });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
      processNextInQueue();
    })
    .catch(async (err) => {
      await updateBackfillRun(runId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: err.message,
      });

      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: error\ndata: ' + JSON.stringify({
          runId,
          status: 'error',
          message: err.message,
        }) + '\n\n';
        clients.forEach(client => {
          client.write(msg);
          client.end();
        });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
      processNextInQueue();
    });
});

// ── API: SSE progress events ────────────────────────────────────────────────────────────

router.get('/api/backfill/events/:runId', requireAuth, (req: Request, res: Response) => {
  const runId = String(req.params.runId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Initialize client set if needed
  if (!sseClients.has(runId)) {
    sseClients.set(runId, new Set());
  }

  const clients = sseClients.get(runId)!;
  clients.add(res);

  // Send initial progress if available
  const activeData = activeRuns.get(runId);
  if (activeData?.progress) {
    res.write('data: ' + JSON.stringify(activeData.progress) + '\n\n');
  }

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(runId);
    }
  });
});

// ── HTML UI Template ────────────────────────────────────────────────────────────

function buildBackfillUI(requiresAuth: boolean = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Discord Ingestor — Attachment Refetch</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f9fafb;
      color: #111827;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      padding: 24px;
    }
    h1 {
      margin: 0 0 24px 0;
      font-size: 1.875rem;
      color: #1f2937;
    }
    .auth-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      display: none;
    }
    .auth-modal.active {
      display: flex;
    }
    .auth-modal-content {
      background: white;
      padding: 24px;
      border-radius: 8px;
      box-shadow: 0 20px 25px rgba(0, 0, 0, 0.15);
      text-align: center;
    }
    .auth-modal input {
      width: 100%;
      padding: 10px;
      margin: 10px 0;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 1rem;
    }
    .auth-modal button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1rem;
    }
    .auth-modal button:hover {
      background: #2563eb;
    }

    .control-panel {
      background: #f3f4f6;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
    }
    .control-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 768px) {
      .control-row {
        grid-template-columns: 1fr;
      }
    }
    .control-group {
      display: flex;
      flex-direction: column;
    }
    label {
      font-weight: 600;
      font-size: 0.875rem;
      color: #374151;
      margin-bottom: 6px;
    }
    input[type="number"],
    input[type="text"],
    select {
      padding: 8px 12px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 0.95rem;
      background: white;
    }
    input[type="checkbox"] {
      margin-right: 6px;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      margin-top: 6px;
    }
    .checkbox-group label {
      margin: 0;
    }

    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      padding: 10px 16px;
      border: none;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #3b82f6;
      color: white;
    }
    .btn-primary:hover {
      background: #2563eb;
    }
    .btn-primary:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: #6b7280;
      color: white;
    }
    .btn-secondary:hover {
      background: #4b5563;
    }
    .btn-secondary:disabled {
      background: #d1d5db;
      cursor: not-allowed;
    }

    .status-section {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
    }
    .status-section.error {
      background: #fef2f2;
      border-color: #fecaca;
    }
    .status-label {
      font-weight: 700;
      font-size: 0.875rem;
      color: #7c2d12;
    }
    .status-section.error .status-label {
      color: #7c2d12;
    }
    .status-value {
      font-size: 1.25rem;
      margin-top: 6px;
      font-weight: 600;
    }

    .progress-container {
      margin-bottom: 24px;
    }
    .progress-bar {
      width: 100%;
      height: 24px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #3b82f6, #2563eb);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 600;
      font-size: 0.75rem;
    }
    .progress-stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 768px) {
      .progress-stats {
        grid-template-columns: 1fr 1fr;
      }
    }
    .stat-box {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      padding: 12px;
      border-radius: 4px;
      text-align: center;
    }
    .stat-label {
      font-size: 0.75rem;
      color: #6b7280;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #1f2937;
    }

    .events-section {
      margin-bottom: 24px;
    }
    .events-header {
      font-weight: 700;
      font-size: 1rem;
      margin-bottom: 12px;
      color: #1f2937;
    }
    .events-list {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      max-height: 300px;
      overflow-y: auto;
      font-family: "Monaco", "Courier New", monospace;
      font-size: 0.8rem;
    }
    .event-item {
      padding: 8px 12px;
      border-bottom: 1px solid #e5e7eb;
      color: #4b5563;
      display: flex;
      gap: 12px;
    }
    .event-item:last-child {
      border-bottom: none;
    }
    .event-time {
      color: #9ca3af;
      white-space: nowrap;
      min-width: 60px;
    }
    .event-text {
      word-break: break-word;
    }

    .runs-section {
      margin-top: 32px;
    }
    .runs-header {
      font-weight: 700;
      font-size: 1rem;
      margin-bottom: 12px;
      color: #1f2937;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    thead {
      background: #f3f4f6;
      border-bottom: 2px solid #e5e7eb;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th {
      font-weight: 600;
      color: #374151;
    }
    tbody tr:hover {
      background: #f9fafb;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.75rem;
    }
    .status-badge.complete {
      background: #d1fae5;
      color: #065f46;
    }
    .status-badge.running {
      background: #dbeafe;
      color: #1e40af;
    }
    .status-badge.error {
      background: #fee2e2;
      color: #991b1b;
    }
    .status-badge.paused {
      background: #fef3c7;
      color: #92400e;
    }
  </style>
</head>
<body>
  <div class="auth-modal" id="authModal">
    <div class="auth-modal-content">
      <h2>Authentication Required</h2>
      <input type="password" id="tokenInput" placeholder="Enter UI_TOKEN" />
      <button onclick="submitToken()">Submit</button>
    </div>
  </div>

  <div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <h1 style="margin:0">📥 Discord Ingestor — Attachment Backfill</h1>
      <a href="/sync" style="color:#7289da;font-size:0.85rem;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid #7289da;transition:all 0.15s">← Back to Sync</a>
    </div>

    <div id="statusSection" class="status-section" style="display: none;">
      <div class="status-label">STATUS</div>
      <div class="status-value" id="statusValue">Idle</div>
    </div>

    <div class="control-panel">
      <div class="control-row">
        <div class="control-group">
          <label for="attachmentModeSelect">Attachment Mode</label>
          <select id="attachmentModeSelect">
            <option value="missing" selected>Missing only (skip if already downloaded)</option>
            <option value="force">Force re-download all</option>
          </select>
        </div>
        <div class="control-group">
          <label for="batchSize">Batch Size</label>
          <input type="number" id="batchSize" value="10" min="1" max="50">
          <small style="color:#6b7280">Concurrent downloads</small>
        </div>
        <div class="control-group">
          <label for="limit">Limit</label>
          <input type="number" id="limit" placeholder="blank = all">
          <small style="color:#6b7280">Total messages to process</small>
        </div>
        <div class="control-group">
          <label for="resumeFrom">Resume From Page</label>
          <input type="number" id="resumeFrom" value="1" min="1">
          <small style="color:#6b7280">Page number to start from</small>
        </div>
      </div>
      <div class="checkbox-group">
        <input type="checkbox" id="dryRun">
        <label for="dryRun">Dry Run (download only, don't ingest)</label>
      </div>
      <div class="button-group">
        <button id="startBtn" class="btn-primary" onclick="startBackfill()">▶ Start Refetch</button>
        <button id="pauseBtn" class="btn-secondary" onclick="pauseBackfill()" disabled>❚❚ Pause</button>
        <button id="resumeBtn" class="btn-secondary" onclick="resumeBackfill()" disabled>⟳ Resume</button>
      </div>
    </div>

    <div class="progress-container" id="progressContainer" style="display: none;">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill" style="width: 0%">
          <span id="progressPercent">0%</span>
        </div>
      </div>
      <div class="progress-stats">
        <div class="stat-box">
          <div class="stat-label">Pages</div>
          <div class="stat-value"><span id="statPages">0</span>/<span id="statTotalPages">?</span></div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Downloaded</div>
          <div class="stat-value" id="statDownloaded">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Ingested</div>
          <div class="stat-value" id="statIngested">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Errors</div>
          <div class="stat-value" id="statErrors">0</div>
        </div>
      </div>
      <div style="margin-top: 12px; padding: 8px; background: #f0f9ff; border-radius: 4px; border-left: 4px solid #3b82f6;">
        <strong>ETA:</strong> <span id="eta">—</span>
      </div>
    </div>

    <div class="events-section">
      <div class="events-header">Live Events</div>
      <div class="events-list" id="eventsList"></div>
    </div>

    <div class="runs-section">
      <div class="runs-header">Recent Runs</div>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Att. Mode</th>
            <th>Status</th>
            <th>Pages</th>
            <th>Downloaded</th>
            <th>Ingested</th>
            <th>Errors</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody id="runsTable">
          <tr><td colspan="8" style="text-align: center; color: #9ca3af;">Loading...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="runs-section" id="recentItemsContainer" style="margin-top: 24px;">
      <div class="runs-header">Last 10 Items Backfilled</div>
      <table>
        <thead>
          <tr>
            <th>Filename</th>
            <th>Message ID</th>
            <th>Status</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody id="recentItemsTable">
          <tr><td colspan="4" style="text-align: center; color: #9ca3af;">No items yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const REQUIRES_AUTH = ${requiresAuth};
    let currentRunId = null;
    let eventSource = null;
    const eventLog = [];
    const MAX_EVENTS = 50;

    function getToken() {
      return localStorage.getItem('backfill-token');
    }

    function setToken(token) {
      localStorage.setItem('backfill-token', token);
    }

    function getHeaders() {
      const token = getToken();
      return token ? { 'Authorization': 'Bearer ' + token } : {};
    }

    function submitToken() {
      const token = document.getElementById('tokenInput').value;
      if (!token) return;
      setToken(token);
      document.getElementById('authModal').classList.remove('active');
      location.reload();
    }

    function updateAuthBar() {
      const uiToken = REQUIRES_AUTH ? true : false;
      if (uiToken && !getToken()) {
        document.getElementById('authModal').classList.add('active');
      }
    }

    async function startBackfill() {
      const attachmentMode = document.getElementById('attachmentModeSelect').value;
      const batchSize = parseInt(document.getElementById('batchSize').value) || 10;
      const limit = document.getElementById('limit').value ? parseInt(document.getElementById('limit').value) : null;
      const resumeFrom = parseInt(document.getElementById('resumeFrom').value) || 1;
      const dryRun = document.getElementById('dryRun').checked;

      try {
        const res = await fetch('/api/refetch/start', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
          body: JSON.stringify({ attachmentMode, batchSize, limit, dryRun }),
        });

        if (res.status === 401) {
          alert('Unauthorized. Your token may be incorrect or expired.\\n\\nClearing token and reloading...');
          localStorage.removeItem('backfill-token');
          location.reload();
          return;
        }

        if (!res.ok) {
          const data = await res.json();
          
          // Check if login is required
          if (data.requiresLogin) {
            alert('Discord session expired or not found.\\n\\nRedirecting to login...');
            window.location.href = '/discord-login';
            return;
          }
          
          alert('Error: ' + (data.error || res.statusText));
          return;
        }

        const data = await res.json();
        currentRunId = data.runId;

        // Update UI
        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('progressContainer').style.display = 'block';
        document.getElementById('statusSection').style.display = 'block';
        document.getElementById('statusValue').textContent = 'Running';
        document.getElementById('statusSection').className = 'status-section';
        eventLog.length = 0;
        updateEventsList();

        // Start listening to SSE
        listenToBackfillEvents(currentRunId);

        // Load runs periodically
        setInterval(() => loadRuns(), 5000);
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function listenToBackfillEvents(runId) {
      if (eventSource) eventSource.close();

      const token = getToken();
      const params = new URLSearchParams();
      if (token) params.append('token', token);
      const url = '/api/backfill/events/' + runId + '?' + params.toString();
      eventSource = new EventSource(url);

      eventSource.addEventListener('message', (event) => {
        const progress = JSON.parse(event.data);
        updateProgress(progress);
      });

      eventSource.addEventListener('complete', (event) => {
        const data = JSON.parse(event.data);
        document.getElementById('statusValue').textContent = 'Complete';
        document.getElementById('statusSection').className = 'status-section';
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resumeBtn').disabled = true;
        eventSource.close();
        loadRuns();
      });

      eventSource.addEventListener('error', (event) => {
        try {
          const data = JSON.parse(event.data);
          document.getElementById('statusValue').textContent = 'Error: ' + data.message;
        } catch (e) {
          document.getElementById('statusValue').textContent = 'Error';
        }
        document.getElementById('statusSection').className = 'status-section error';
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resumeBtn').disabled = true;
        eventSource.close();
        loadRuns();
      });

      eventSource.onerror = () => {
        eventSource.close();
      };
    }

    function updateProgress(progress) {
      const percent = progress.totalPages > 0 ? Math.round((progress.page / progress.totalPages) * 100) : 0;
      document.getElementById('progressFill').style.width = percent + '%';
      document.getElementById('progressPercent').textContent = percent + '%';
      document.getElementById('statPages').textContent = progress.page;
      document.getElementById('statTotalPages').textContent = progress.totalPages;
      document.getElementById('statDownloaded').textContent = progress.downloadedCount;
      document.getElementById('statIngested').textContent = progress.ingestedCount;
      document.getElementById('statErrors').textContent = progress.errorCount;

      // Calculate and display ETA
      if (progress.estimatedRemaining && progress.estimatedRemaining > 0) {
        const minutes = Math.round(progress.estimatedRemaining / 1000 / 60);
        if (minutes < 60) {
          document.getElementById('eta').textContent = '~' + minutes + 'm remaining';
        } else {
          const hours = Math.floor(minutes / 60);
          const mins = minutes % 60;
          document.getElementById('eta').textContent = '~' + hours + 'h ' + mins + 'm remaining';
        }
      }

      // Update recent items
      if (progress.recentItems && progress.recentItems.length > 0) {
        updateRecentItems(progress.recentItems);
      }

      // Add event to log
      if (progress.lastEvent) {
        addEvent(progress.lastEvent);
      }
    }

    function updateRecentItems(items) {
      const tbody = document.getElementById('recentItemsTable');
      
      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #9ca3af;">No items yet</td></tr>';
        return;
      }
      
      tbody.innerHTML = items.map(item => {
        const sizeStr = item.size ? (item.size / 1024 / 1024).toFixed(2) + ' MB' : '—';
        const statusColor = item.status === 'ingested' ? '#22c55e' : item.status === 'downloaded' ? '#3b82f6' : item.status === 'error' ? '#ef4444' : '#f59e0b';
        const statusBadge = '<span style="background:' + statusColor + '; color:white; padding:2px 6px; border-radius:3px; font-size:0.75rem; font-weight:600">' + item.status.toUpperCase() + '</span>';
        return '<tr><td>' + escapeHtml(item.filename) + '</td><td style="font-size:0.85rem; font-family:monospace">' + item.messageId.slice(0, 12) + '...</td><td>' + statusBadge + '</td><td>' + sizeStr + '</td></tr>';
      }).join('');
    }

    function addEvent(message) {
      const time = new Date().toLocaleTimeString();
      eventLog.unshift({ time, message });
      if (eventLog.length > MAX_EVENTS) eventLog.pop();
      updateEventsList();
    }

    function updateEventsList() {
      const list = document.getElementById('eventsList');
      list.innerHTML = eventLog.length === 0
        ? '<div style="padding: 12px; color: #9ca3af; text-align: center;">No events yet</div>'
        : eventLog.map(e => '<div class="event-item"><span class="event-time">[' + e.time + ']</span><span class="event-text">' + escapeHtml(e.message) + '</span></div>').join('');
    }

    async function pauseBackfill() {
      if (!currentRunId) return;

      try {
        const res = await fetch('/api/backfill/pause', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
          body: JSON.stringify({ runId: currentRunId }),
        });

        if (res.status === 401) {
          alert('Unauthorized. Your token may be incorrect or expired.\\n\\nClearing token and reloading...');
          localStorage.removeItem('backfill-token');
          location.reload();
          return;
        }

        if (res.ok) {
          const data = await res.json();
          document.getElementById('statusValue').textContent = 'Paused';
          document.getElementById('statusSection').className = 'status-section';
          document.getElementById('pauseBtn').disabled = true;
          document.getElementById('resumeBtn').disabled = false;
          addEvent('Backfill paused');
          if (eventSource) eventSource.close();
        } else {
          alert('Error pausing backfill');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function resumeBackfill() {
      if (!currentRunId) return;

      try {
        const res = await fetch('/api/backfill/resume/' + currentRunId, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
        });

        if (res.status === 401) {
          alert('Unauthorized. Your token may be incorrect or expired.\\n\\nClearing token and reloading...');
          localStorage.removeItem('backfill-token');
          location.reload();
          return;
        }

        if (res.ok) {
          document.getElementById('statusValue').textContent = 'Running';
          document.getElementById('statusSection').className = 'status-section';
          document.getElementById('pauseBtn').disabled = false;
          document.getElementById('resumeBtn').disabled = true;
          addEvent('Backfill resumed');
          listenToBackfillEvents(currentRunId);
        } else {
          alert('Error resuming backfill');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function loadRuns() {
      try {
        const res = await fetch('/api/backfill/runs', { headers: getHeaders() });
        if (res.status === 401) return;

        const data = await res.json();
        const tbody = document.getElementById('runsTable');
        tbody.innerHTML = data.runs.length === 0
          ? '<tr><td colspan="7" style="text-align: center; color: #9ca3af;">No runs yet</td></tr>'
          : data.runs.map(run => {
              const started = new Date(run.startedAt);
              const completed = run.completedAt ? new Date(run.completedAt) : null;
              const duration = completed ? Math.round((completed - started) / 1000) : '—';
              const durationStr = duration === '—' ? '—' : (duration < 60 ? duration + 's' : Math.round(duration / 60) + 'm');
              const statusClass = 'status-badge ' + run.status;
              const attMode = run.attachmentMode || 'missing';
              return '<tr><td>' + started.toLocaleString() + '</td><td>' + attMode + '</td><td><span class="' + statusClass + '">' + run.status + '</span></td><td>' + run.stats.totalMessages + '</td><td>' + run.stats.downloadedAttachments + '</td><td>' + run.stats.ingestedAttachments + '</td><td>' + run.stats.errors + '</td><td>' + durationStr + '</td></tr>';
            }).join('');
      } catch (err) {
        console.error('Error loading runs:', err);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    window.addEventListener('DOMContentLoaded', () => {
      updateAuthBar();
      loadRuns();
      checkDiscordSession();
      setInterval(loadRuns, 10000);
    });

    function checkDiscordSession() {
      // Show a helpful message if no Discord session is active
      const infoBox = document.createElement('div');
      infoBox.id = 'session-info';
      infoBox.style.cssText = 'background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; margin-bottom: 16px; border-radius: 4px; color: #92400e; font-size: 0.9rem;';
      infoBox.innerHTML = '💡 <strong>Tip:</strong> Refetch requires an active Discord session. If you haven\\'t logged in yet, <a href="/discord-login" style="color: #b45309; text-decoration: underline;">click here to log in</a>.';
      
      const controlPanel = document.querySelector('.control-panel');
      if (controlPanel) {
        controlPanel.parentNode.insertBefore(infoBox, controlPanel);
      }
    }
  </script>
</body>
</html>`;
}

export default router;
