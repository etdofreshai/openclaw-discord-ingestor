import pg from 'pg';
import { loadJobs, updateJob, type Job } from './job-store.js';
import { createRun, updateRun } from './run-store.js';
import { loadSession } from './session.js';
import { validateToken } from './token-validator.js';
import { syncChannelToDB } from './live-sync.js';

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

  const startedAt = new Date().toISOString();
  await updateJob(job.id, { lastStatus: 'running', lastRunAt: startedAt });

  const run = await createRun({
    jobId: job.id,
    startedAt,
    status: 'running',
    channel: job.channel,
    params: {
      limit: job.limit,
      after: job.after,
      before: job.before,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    console.log(`[Scheduler] Starting job ${job.id} (${job.name}) — channel ${job.channel}`);

    const result = await syncChannelToDB(pool, session, job.channel, {
      limit: job.limit,
      before: job.before,
      after: job.after,
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
 * Re-reads job from disk inside the timer to catch edits.
 */
export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);

  if (!job.enabled) return;

  const intervalMs = job.intervalMinutes * 60 * 1000;

  // Calculate delay to next run
  let delayMs: number;
  if (job.lastRunAt) {
    const lastRun = new Date(job.lastRunAt).getTime();
    const nextRun = lastRun + intervalMs;
    delayMs = Math.max(0, nextRun - Date.now());
  } else {
    // First ever run — start after a short delay so server finishes starting up
    delayMs = 5_000;
  }

  console.log(
    `[Scheduler] Job ${job.id} (${job.name}) next run in ${Math.round(delayMs / 1000)}s`
  );

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

    // Reschedule for the next interval
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
 * Reschedules from this point after the run completes.
 */
export async function runJobNow(job: Job): Promise<void> {
  // Cancel pending timer so it doesn't double-fire shortly after
  clearJobTimer(job.id);

  await executeJob(job);

  // Reschedule from now
  if (job.enabled) {
    scheduleJob({ ...job, lastRunAt: new Date().toISOString() });
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
