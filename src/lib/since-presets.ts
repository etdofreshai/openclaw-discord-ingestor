/**
 * since-presets.ts
 *
 * Relative lookback window presets for Discord sync.
 *
 * Precedence rule: sincePreset overrides explicit `after` when both are set.
 * The effective `after` snowflake is computed at runtime from `now - presetMs`.
 */

export const SINCE_PRESETS = [
  '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d',
  '1w', '2w',
  '1mo', '2mo', '3mo', '4mo', '6mo',
  '1y', '3y', '5y', '10y', '20y',
  'all',
] as const;

export type SincePreset = typeof SINCE_PRESETS[number];

export const SINCE_PRESET_LABELS: Record<SincePreset, string> = {
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '2h': '2 hours',
  '4h': '4 hours',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
  '2w': '2 weeks',
  '1mo': '1 month',
  '2mo': '2 months',
  '3mo': '3 months',
  '4mo': '4 months',
  '6mo': '6 months',
  '1y': '1 year',
  '3y': '3 years',
  '5y': '5 years',
  '10y': '10 years',
  '20y': '20 years',
  'all': 'All time',
};

/** Milliseconds for each preset. Months/year use calendar approximations. */
function presetToMs(preset: SincePreset): number {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  switch (preset) {
    case '15m':  return 15 * MINUTE;
    case '30m':  return 30 * MINUTE;
    case '1h':   return HOUR;
    case '2h':   return 2 * HOUR;
    case '4h':   return 4 * HOUR;
    case '6h':   return 6 * HOUR;
    case '12h':  return 12 * HOUR;
    case '1d':   return DAY;
    case '3d':   return 3 * DAY;
    case '1w':   return 7 * DAY;
    case '2w':   return 14 * DAY;
    case '1mo':  return 30 * DAY;
    case '2mo':  return 60 * DAY;
    case '3mo':  return 90 * DAY;
    case '4mo':  return 120 * DAY;
    case '6mo':  return 180 * DAY;
    case '1y':   return 365 * DAY;
    case '3y':   return 3 * 365 * DAY;
    case '5y':   return 5 * 365 * DAY;
    case '10y':  return 10 * 365 * DAY;
    case '20y':  return 20 * 365 * DAY;
    case 'all':  return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Discord epoch: 2015-01-01T00:00:00.000Z
 * Snowflake bits: upper 42 = ms since epoch, lower 22 = worker/sequence (0 for boundary use)
 */
const DISCORD_EPOCH = 1_420_070_400_000n;

/**
 * Convert a Unix timestamp (ms) to the lowest Discord snowflake >= that timestamp.
 * Safe to use as the `after` parameter in the Discord messages API.
 */
export function timestampToSnowflake(timestampMs: number): string {
  const ms = BigInt(timestampMs);
  const offset = ms - DISCORD_EPOCH;
  if (offset < 0n) {
    // Timestamp predates Discord — return snowflake 0 (fetch from beginning)
    return '0';
  }
  return (offset << 22n).toString();
}

/**
 * Resolve a SincePreset to a Discord snowflake string representing the
 * effective `after` message ID boundary.
 *
 * @param preset - the lookback preset
 * @param now    - reference time (defaults to current time); injectable for testing
 */
export function resolveSincePreset(preset: SincePreset, now: Date = new Date()): string {
  const cutoffMs = now.getTime() - presetToMs(preset);
  return timestampToSnowflake(cutoffMs);
}

/**
 * Type-guard: checks whether a string is a valid SincePreset.
 */
export function isSincePreset(value: unknown): value is SincePreset {
  return typeof value === 'string' && (SINCE_PRESETS as readonly string[]).includes(value);
}
