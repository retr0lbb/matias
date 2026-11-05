export interface BillingCycle {
  start: Date;
  resetsAt: Date;
}

/**
 * Midnight UTC of `day` in the given month, clamped to the month's last day
 * (an anchor on the 31st falls on Feb 28/29). Out-of-range months roll over.
 */
function cycleDate(year: number, month: number, day: number): Date {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const y = firstOfMonth.getUTCFullYear();
  const m = firstOfMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)));
}

/**
 * Monthly usage cycle that resets on the anchor's day of month (UTC midnight).
 * `start` is inclusive, `resetsAt` is exclusive.
 */
export function getCurrentCycle(anchor: Date, now: Date): BillingCycle {
  const day = anchor.getUTCDate();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  let start = cycleDate(year, month, day);
  if (start.getTime() > now.getTime()) {
    start = cycleDate(year, month - 1, day);
  }

  const resetsAt = cycleDate(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    day,
  );

  return { start, resetsAt };
}
