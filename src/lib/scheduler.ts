import pg from 'pg';
import { loadJobs, updateJob, type Job } from './job-store.js';
import { createRun, updateRun } from './run-store.js';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import { syncChannelToDB, fetchChannelName } from './live-sync.js';
import { resolveSincePreset, computeNextBoundary } from './since-presets.js';

// Track which jobs are currently executing (prevent overlapping runs)
const runningJobs = new Set<string>();
// Timers for each scheduled job
const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearJobTimer(jobId: string): void {
  const t = jobTimers.get(jobId);
  if (t !== undefined) {
    clearTimeout(t);
    jobTimers.delete(jobId);
  }
}

async function executeJob(job: Job): Promise<void> {
  if (runningJobs.has(job.id)) {
    console.log(`[Scheduler] Job ${job.id} (${job.name}) already running — skipping overlap.`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[Scheduler] DATABASE_URL not configured — cannot run job.');
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

  runningJobs.add(job.id);

  // Resolve sincePreset → effective after snowflake at runtime.
  // Precedence: sincePreset overrides explicit `after` when both are set.
  const now = new Date();
  const effectiveAfter = job.sincePreset
    ? resolveSincePreset(job.sincePreset, now)
    : job.after;

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
      limit: job.limit,
      after: job.after,
      before: job.before,
      sincePreset: job.sincePreset,
      effectiveAfter,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    console.log(
      `[Scheduler] Starting job ${job.id} (${job.name}) — channel ${job.channel}` +
      (job.cadencePreset ? ` — cadence=${job.cadencePreset}` : '') +
      (job.sincePreset ? ` — since=${job.sincePreset} (after=${effectiveAfter})` : '')
    );

    const result = await syncChannelToDB(pool, session, job.channel, {
      limit: job.limit,
      before: job.before,
      after: effectiveAfter,
      verbose: true,
    });

    const finishedAt = new Date().toISOString();
    await updateJob(job.id, { lastStatus: 'success', lastRunAt: finishedAt });
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
  } finally {
    await pool.end();
    runningJobs.delete(job.id);
  }
}

/**
 * Schedule a job to run at its next due time.
 *
 * Scheduling strategy:
 *   - If job has a `cadencePreset`: boundary-aligned UTC scheduling.
 *     The next run is always the next upcoming UTC boundary for that cadence
 *     (e.g., hourly → top of next hour, daily → next midnight UTC).
 *     This eliminates drift — the job fires at predictable wall-clock times
 *     regardless of when it last ran or when the server started.
 *
 *   - If job has only `intervalMinutes` (old/manual jobs): legacy interval-drift
 *     scheduling (lastRun + interval). Maintained for backward compatibility.
 *
 * Overlapping runs are prevented via the `runningJobs` guard inside executeJob.
 * Re-reads the job from disk inside the timer to respect edits/disables.
 */
export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);

  if (!job.enabled) return;

  // ── Compute delay to next run ──────────────────────────────────────────────
  let delayMs: number;

  if (job.cadencePreset) {
    // Boundary-aligned: always schedule for the next upcoming UTC boundary.
    // This is deterministic and never drifts regardless of server restarts.
    const nextBoundary = computeNextBoundary(job.cadencePreset);
    delayMs = Math.max(0, nextBoundary.getTime() - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) — cadence=${job.cadencePreset}` +
      ` next boundary: ${nextBoundary.toISOString()} (in ${Math.round(delayMs / 1000)}s)`
    );
  } else if (job.lastRunAt) {
    // Legacy: interval-drift scheduling for jobs without cadencePreset.
    const intervalMs = job.intervalMinutes * 60 * 1000;
    const lastRun = new Date(job.lastRunAt).getTime();
    const nextRun = lastRun + intervalMs;
    delayMs = Math.max(0, nextRun - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) [legacy] next run in ${Math.round(delayMs / 1000)}s`
    );
  } else {
    // First ever run — short delay for legacy jobs without cadencePreset.
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

    await executeJob(current);

    // Reschedule at the next boundary (boundary jobs always call computeNextBoundary
    // fresh, so no drift accumulates across multiple runs)
    scheduleJob(current);
  }, delayMs);

  jobTimers.set(job.id, timer);
}

export function unscheduleJob(jobId: string): void {
  clearJobTimer(jobId);
  runningJobs.delete(jobId);
}

/**
 * Immediately execute a job outside of the scheduler cadence.
 * After the run, reschedules at the next boundary (cadence jobs) or
 * next interval from now (legacy jobs).
 */
export async function runJobNow(job: Job): Promise<void> {
  // Cancel pending timer so it doesn't double-fire shortly after
  clearJobTimer(job.id);

  await executeJob(job);

  // Reschedule from now — boundary jobs will naturally pick up the next boundary
  if (job.enabled) {
    scheduleJob(job);
  }
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
