import { loadJobs, updateJob, type Job } from './job-store.js';
import { createRun, updateRun } from './run-store.js';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import { syncChannel, fetchChannelName } from './live-sync.js';
import { isApiMode } from './api-writer.js';
import { computeNextBoundary, sincePresetToMs, timestampToSnowflake } from './since-presets.js';
import { enqueue } from './scheduler-queue.js';

// Timers for each scheduled job
const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearJobTimer(jobId: string): void {
  const t = jobTimers.get(jobId);
  if (t !== undefined) {
    clearTimeout(t);
    jobTimers.delete(jobId);
  }
}

export type JobRunOverrides = {
  limit?: number;
  before?: string;
  after?: string;
  sincePreset?: Job['sincePreset'];
  conflictMode?: string;
};

/**
 * Core execution logic for a scheduled job.
 * This is called from within the queue worker — the queue handles the
 * per-job overlap guard, so this function does NOT need a separate
 * runningJobs Set.
 */
async function executeJob(job: Job, overrides?: JobRunOverrides): Promise<void> {
  if (!isApiMode() && !process.env.DATABASE_URL) {
    console.error(
      '[Scheduler] DATABASE_URL not configured and API mode ' +
      '(MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active — cannot run job.'
    );
    return;
  }

  const session = await loadSession();
  if (!session) {
    console.error(`[Scheduler] No Discord session — skipping job ${job.id} (${job.name}).`);
    await updateJob(job.id, { lastStatus: 'error' });
    return;
  }

  const user = await validateToken(session);
  if (!user) {
    console.error(`[Scheduler] Discord token invalid — skipping job ${job.id} (${job.name}).`);
    await updateJob(job.id, { lastStatus: 'error' });
    return;
  }

  // Resolve effective after snowflake at runtime.
  // Priority order:
  //   1. lastSyncedAt (if set) → fetch since last successful sync
  //   2. startDate (if set, and no lastSyncedAt) → fetch since configured start
  //   3. sincePreset (legacy fallback) → fetch last N hours/days
  //   4. Explicit `after` field (already a snowflake)
  //   5. Nothing → fetch from beginning of time (snowflake '0')
  const now = new Date();
  const runSincePreset = overrides?.sincePreset ?? job.sincePreset;
  const runAfter = overrides?.after ?? job.after;
  const runBefore = overrides?.before ?? job.before;
  const runLimit = overrides?.limit ?? job.limit;

  // Optional overlap window for scheduled runs to avoid edge misses at boundaries.
  // Default 10% (e.g., 1h cadence => 66m lookback). Safe because DB upserts are idempotent.
  const overlapPctRaw = Number(process.env.SCHEDULE_SINCE_OVERLAP_PERCENT ?? '10');
  const overlapPct = Number.isFinite(overlapPctRaw) ? Math.min(Math.max(overlapPctRaw, 0), 100) : 10;

  let afterMs: number | null = null;
  let useStaticAfter = false;

  if (job.lastSyncedAt && !overrides?.after && runSincePreset !== 'all') {
    afterMs = new Date(job.lastSyncedAt).getTime();
  } else if (job.startDate && !job.lastSyncedAt && !overrides?.after && runSincePreset !== 'all') {
    afterMs = new Date(job.startDate).getTime();
  } else if (runSincePreset) {
    const baseMs = sincePresetToMs(runSincePreset);
    const lookbackMs = Math.round(baseMs * (1 + overlapPct / 100));
    afterMs = now.getTime() - lookbackMs;
  } else if (runAfter) {
    useStaticAfter = true;
  }

  // Apply startDate as a floor even when lastSyncedAt is set
  if (job.startDate && afterMs !== null) {
    const startMs = new Date(job.startDate).getTime();
    afterMs = Math.max(afterMs, startMs);
  }

  const effectiveAfter = useStaticAfter
    ? runAfter
    : (afterMs !== null ? timestampToSnowflake(afterMs) : (runAfter || '0'));

  const startedAt = now.toISOString();
  await updateJob(job.id, { lastStatus: 'running', lastRunAt: startedAt });

  const channelName = await fetchChannelName(session, job.channel).catch(() => null);

  const run = await createRun({
    jobId: job.id,
    startedAt,
    status: 'running',
    channel: job.channel,
    channelName: channelName || undefined,
    params: {
      limit: runLimit,
      after: runAfter,
      before: runBefore,
      sincePreset: runSincePreset,
      effectiveAfter,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const writeMode = isApiMode() ? 'api' : 'pg';

  try {
    console.log(
      `[Scheduler] Starting job ${job.id} (${job.name}) — channel ${job.channel}` +
      (job.cadencePreset ? ` — cadence=${job.cadencePreset}` : '') +
      (runSincePreset ? ` — since=${runSincePreset} (after=${effectiveAfter})` : '') +
      ` [write=${writeMode}]`
    );

    const result = await syncChannel(session, job.channel, {
      limit: runLimit,
      before: runBefore,
      after: effectiveAfter,
      verbose: true,
      conflictMode: overrides?.conflictMode,
    });

    const finishedAt = new Date().toISOString();
    await updateJob(job.id, { lastStatus: 'success', lastRunAt: finishedAt, lastSyncedAt: finishedAt });
    await updateRun(run.runId, {
      finishedAt,
      status: 'success',
      fetchedCount: result.fetched,
      insertedCount: result.inserted,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      attachmentsSeen: result.attachmentsSeen,
    });

    console.log(
      `[Scheduler] Job ${job.id} done — fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated}`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Scheduler] Job ${job.id} (${job.name}) failed: ${message}`);

    await updateJob(job.id, { lastStatus: 'error' });
    await updateRun(run.runId, {
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: message,
    });
  }
}

/**
 * Schedule a job to run at its next due time.
 *
 * Scheduling strategy:
 *   - If job has a `cadencePreset`: boundary-aligned UTC scheduling.
 *     The next run is always the next upcoming UTC boundary for that cadence.
 *   - If job has only `intervalMinutes` (legacy): interval-drift scheduling.
 *
 * All executions go through the global scheduler queue (scheduler-queue.ts):
 *   - Concurrent boundary fires for multiple jobs are serialised via the queue.
 *   - SCHEDULER_CONCURRENCY and SCHEDULER_JOB_SPACING_MS control throughput.
 *   - The per-job overlap guard lives in the queue — a job already in the queue
 *     or running will NOT be enqueued again when its boundary fires.
 */
export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);

  if (!job.enabled) return;

  // ── Compute delay to next run ──────────────────────────────────────────────
  let delayMs: number;

  if (job.cadencePreset) {
    const nextBoundary = computeNextBoundary(job.cadencePreset);
    delayMs = Math.max(0, nextBoundary.getTime() - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) — cadence=${job.cadencePreset}` +
      ` next boundary: ${nextBoundary.toISOString()} (in ${Math.round(delayMs / 1000)}s)`
    );
  } else if (job.lastRunAt) {
    const intervalMs = job.intervalMinutes * 60 * 1000;
    const lastRun = new Date(job.lastRunAt).getTime();
    const nextRun = lastRun + intervalMs;
    delayMs = Math.max(0, nextRun - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) [legacy] next run in ${Math.round(delayMs / 1000)}s`
    );
  } else {
    delayMs = 5_000;
    console.log(`[Scheduler] Job ${job.id} (${job.name}) first run in ${delayMs / 1000}s`);
  }

  const timer = setTimeout(async () => {
    jobTimers.delete(job.id);

    // Refresh job from disk to respect any edits/disables that happened since scheduling
    const jobs = await loadJobs();
    const current = jobs.find(j => j.id === job.id);

    if (!current) {
      console.log(`[Scheduler] Job ${job.id} no longer exists — dropping.`);
      return;
    }

    if (!current.enabled) {
      console.log(`[Scheduler] Job ${job.id} (${current.name}) disabled — not running.`);
      return;
    }

    // Enqueue through the global queue — prevents concurrent boundary-trigger bursts.
    // The queue handles the per-job overlap guard (no double-enqueue).
    const { enqueued } = enqueue(current.id, current.name, () => executeJob(current));
    if (!enqueued) {
      console.log(
        `[Scheduler] Job ${current.id} (${current.name}) boundary fired but already queued/running — skipping this tick.`
      );
    }

    // Reschedule at next boundary regardless of enqueue result (drift-free)
    scheduleJob(current);
  }, delayMs);

  jobTimers.set(job.id, timer);
}

export function unscheduleJob(jobId: string): void {
  clearJobTimer(jobId);
  // Note: if the job is currently in the queue or running, it will complete
  // naturally. The queue's per-job guard prevents new enqueues of the same id.
}

/**
 * Immediately enqueue a job outside of the scheduler cadence.
 * After enqueuing, reschedules the timer at the next boundary (cadence jobs)
 * or next interval from now (legacy jobs).
 *
 * Returns the queue promise so callers can optionally await completion.
 */
export function runJobNow(job: Job, overrides?: JobRunOverrides): Promise<void> {
  // Cancel pending timer so it doesn't double-fire shortly after
  clearJobTimer(job.id);

  // Enqueue the job — queue's overlap guard prevents duplicates
  const { promise } = enqueue(job.id, job.name, () => executeJob(job, overrides));

  // Reschedule from now — boundary jobs naturally pick up the next boundary
  if (job.enabled) {
    scheduleJob(job);
  }

  return promise;
}

export async function startScheduler(): Promise<void> {
  const jobs = await loadJobs();
  const enabledJobs = jobs.filter(j => j.enabled);

  console.log(
    `[Scheduler] Starting — ${jobs.length} total jobs, ${enabledJobs.length} enabled.`
  );

  for (const job of enabledJobs) {
    scheduleJob(job);
  }
}
