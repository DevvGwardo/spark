// Lightweight standard 5-field cron evaluator — computes the next N fire times.
// No external dependency (keeps clear of the repo's supply-chain preinstall
// guard). Supports: * , */n , lists a,b,c , ranges a-b , and combinations.
// Fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday).
// Evaluated in the caller's local timezone.

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    let step = 1;
    let rangePart = part;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      step = parseInt(part.slice(slash + 1), 10);
      rangePart = part.slice(0, slash);
      if (!Number.isFinite(step) || step <= 0) return null;
    }

    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const dash = rangePart.indexOf('-');
      if (dash !== -1) {
        lo = parseInt(rangePart.slice(0, dash), 10);
        hi = parseInt(rangePart.slice(dash + 1), 10);
      } else {
        lo = hi = parseInt(rangePart, 10);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const daysOfWeek = parseField(parts[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  // Normalize Sunday: cron allows 0 or 7.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function matches(p: ParsedCron, d: Date): boolean {
  if (!p.minutes.has(d.getMinutes())) return false;
  if (!p.hours.has(d.getHours())) return false;
  if (!p.months.has(d.getMonth() + 1)) return false;
  const domOk = p.daysOfMonth.has(d.getDate());
  const dowOk = p.daysOfWeek.has(d.getDay());
  // Standard cron: when both DOM and DOW are restricted, either matching fires.
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true;
}

/**
 * Compute the next `count` fire times strictly after `from`.
 * Iterates minute-by-minute with a bounded horizon (~400 days) so a malformed
 * but parseable expression can never spin forever.
 */
export function nextRuns(expr: string, count: number, from: Date): Date[] {
  const parsed = parseCron(expr);
  if (!parsed) return [];
  const results: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const horizonMinutes = 400 * 24 * 60;
  for (let i = 0; i < horizonMinutes && results.length < count; i++) {
    if (matches(parsed, cursor)) {
      results.push(new Date(cursor.getTime()));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return results;
}

export function formatRunChip(d: Date): string {
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${time}`;
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}
