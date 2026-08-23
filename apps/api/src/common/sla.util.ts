export interface BusinessCalendar {
  workDays: number[]; // 0=Sun..6=Sat, e.g. [1,2,3,4,5]
  startHour: number; // e.g. 8
  endHour: number; // e.g. 17
  holidays: string[]; // ISO dates 'YYYY-MM-DD'
}

export const DEFAULT_CALENDAR: BusinessCalendar = {
  workDays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 17,
  holidays: [],
};

function isWorkingDay(d: Date, cal: BusinessCalendar): boolean {
  const iso = d.toISOString().slice(0, 10);
  if (cal.holidays.includes(iso)) return false;
  return cal.workDays.includes(d.getUTCDay());
}

function nextWorkingMoment(d: Date, cal: BusinessCalendar): Date {
  let cur = new Date(d);
  for (let i = 0; i < 400; i++) {
    if (!isWorkingDay(cur, cal)) {
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 1, cal.startHour, 0, 0));
      continue;
    }
    const hours = cur.getUTCHours() + cur.getUTCMinutes() / 60;
    if (hours < cal.startHour) {
      return new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate(), cal.startHour, 0, 0));
    }
    if (hours >= cal.endHour) {
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 1, cal.startHour, 0, 0));
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * Adds `hours` of working time to `from` according to the calendar.
 * A 24-hour SLA raised at 16:00 Friday lands on the next working day, not Saturday.
 */
export function computeSlaDueAt(from: Date, slaHours: number, calendar?: Partial<BusinessCalendar>): Date {
  const cal = { ...DEFAULT_CALENDAR, ...calendar };
  let remainingMs = slaHours * 3600 * 1000;
  let cursor = nextWorkingMoment(new Date(from), cal);
  let guard = 0;
  while (remainingMs > 0 && guard < 10000) {
    guard++;
    const dayEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), cal.endHour, 0, 0),
    );
    const available = Math.max(0, dayEnd.getTime() - cursor.getTime());
    if (available >= remainingMs) {
      return new Date(cursor.getTime() + remainingMs);
    }
    remainingMs -= available;
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, cal.startHour, 0, 0),
    );
    cursor = nextWorkingMoment(cursor, cal);
  }
  return cursor;
}
