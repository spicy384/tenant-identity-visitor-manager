/**
 * The clock that keeps visits tidy:
 *
 * - End of day: a visit still open at its site's end-of-day time (in the site's own time
 *   zone) is checked out automatically, at that time, marked "auto". A visit that began
 *   after that day's end-of-day time runs until the next day's. If the server was down at
 *   the time, the visit is closed on the next tick, still at the time it should have been.
 * - Retention: once a day, finished visits older than the set number of months are
 *   deleted (visitors.applyRetention). Off unless set.
 *
 * Times are worked out with Intl, so daylight-saving changes land where they should.
 */
const SETTINGS_KEY = "visits";
const DEFAULTS = { retentionMonths: 0, kioskIdleSeconds: 45, lastRetentionRun: 0 };
const TICK_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  return partsCache.get(tz);
}

/** The wall-clock date and time at instant `ms` in `tz`. */
function localParts(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute, second: p.second };
}

/** How far `tz` is ahead of UTC at instant `ms`, in milliseconds. */
function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `tz`. A time skipped by a spring-forward
 * change resolves to just after the gap; a repeated autumn time to its first occurrence.
 */
function zonedTime(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  if (first === second) return first;
  // The offsets disagree around a change: prefer the earlier instant that reads right.
  const candidates = [first, second].filter((t) => {
    const p = localParts(t, tz);
    return p.hour === hour && p.minute === minute;
  });
  return candidates.length ? Math.min(...candidates) : Math.max(first, second);
}

/** The end-of-day instant ("HH:MM" in `tz`) that closes a visit begun at `checkedInAt`. */
function endOfDayFor(checkedInAt, endOfDay, tz) {
  const [hour, minute] = endOfDay.split(":").map(Number);
  const p = localParts(checkedInAt, tz);
  let cut = zonedTime(p.year, p.month, p.day, hour, minute, tz);
  if (cut <= checkedInAt) {
    // Arrived after closing time: the next day's end of day.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cut = zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, tz);
  }
  return cut;
}

/** The instant `months` calendar months before `now` (UTC calendar). */
function monthsBefore(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

function createVisitClock({ db, visitors, now = Date.now, log = () => {} }) {
  const raw = db.raw;
  let timer = null;

  function settings() {
    let stored = {};
    try {
      stored = JSON.parse(db.getSetting(SETTINGS_KEY) || "{}") || {};
    } catch {
      stored = {};
    }
    return { ...DEFAULTS, ...stored };
  }

  function saveSettings(patch = {}) {
    const next = settings();
    if (patch.retentionMonths !== undefined) {
      const n = Number(patch.retentionMonths);
      if (!Number.isInteger(n) || n < 0 || n > 240) throw fail(400, "Keep visits for 0 (forever) to 240 months.");
      next.retentionMonths = n;
    }
    if (patch.kioskIdleSeconds !== undefined) {
      const n = Number(patch.kioskIdleSeconds);
      if (!Number.isInteger(n) || n < 15 || n > 600) throw fail(400, "The kiosk resets after 15 to 600 seconds without a touch.");
      next.kioskIdleSeconds = n;
    }
    if (patch.lastRetentionRun !== undefined) next.lastRetentionRun = patch.lastRetentionRun;
    db.setSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  /** Closes every open visit whose site's end of day has passed. Returns how many. */
  function runEndOfDay() {
    const t = now();
    const rows = raw.prepare(`SELECT x.id, x.checked_in_at, s.end_of_day, s.time_zone, s.name AS site_name FROM visits x JOIN sites s ON s.id = x.site_id
      WHERE x.checked_out_at IS NULL AND s.end_of_day IS NOT NULL`).all();
    let closed = 0;
    for (const r of rows) {
      let cut;
      try {
        cut = endOfDayFor(r.checked_in_at, r.end_of_day, r.time_zone);
      } catch (error) {
        log(`end of day: ${r.site_name}: ${error.message}`);
        continue;
      }
      if (t >= cut) {
        visitors.checkOut(r.id, { method: "auto", by: "end of day", at: cut });
        closed += 1;
      }
    }
    return closed;
  }

  function retentionCutoff(months = settings().retentionMonths) {
    return months > 0 ? monthsBefore(now(), months) : null;
  }

  /** Deletes old visits when retention is on. Returns { visits, visitors } or null when off. */
  function runRetention() {
    const cutoff = retentionCutoff();
    saveSettings({ lastRetentionRun: now() });
    if (cutoff === null) return null;
    return visitors.applyRetention(cutoff);
  }

  function tick() {
    try {
      const closed = runEndOfDay();
      if (closed) {
        db.audit({ username: "system", action: "visit.auto_checkout", detail: `${closed} visit${closed === 1 ? "" : "s"} checked out at end of day` });
      }
      if (now() - settings().lastRetentionRun >= DAY_MS) {
        const removed = runRetention();
        if (removed && (removed.visits || removed.visitors)) {
          db.audit({ username: "system", action: "visit.retention", detail: `${removed.visits} visits and ${removed.visitors} unchecked visitors deleted` });
        }
      }
    } catch (error) {
      log(`visit clock: ${error.message}`);
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { settings, saveSettings, runEndOfDay, runRetention, retentionCutoff, tick, start, stop };
}

module.exports = { createVisitClock, endOfDayFor, zonedTime, localParts, monthsBefore, DEFAULTS };
