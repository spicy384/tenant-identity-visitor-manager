/**
 * Visitor events: a meeting, an interview day, a delivery window. Each is at a site on a
 * date, optionally for a company and host, with a list of expected guests (visitors).
 *
 * An event can repeat (daily, on weekdays, weekly on chosen days, or monthly) up to a year
 * ahead. Each date is an event of its own in a series (series_id, the first date's id), so a
 * date can be changed, canceled or given guests alone, or with every later date of its series
 * (scope "following").
 *
 * The Expected page lists a day's events and whether each guest has arrived. A guest's
 * arrival is noted against the event when they check in at that site that day, at the
 * kiosk or the desk (visitors.checkIn). The kiosk offers an expected guest their event's
 * company and host first.
 */
const { today } = require("./clearance");

const { badgeLabel } = require("./badges");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const inList = (ids) => ids.map(() => "?").join(",");

const DAY = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["first", "second", "third", "fourth", "last"];
// Every date is worked in UTC, so no time zone or daylight saving shifts a day.
const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Which of its weekday a date is in its month: 1 to 4, or 5 (the fifth, taken as the last). */
const nthOfMonth = (iso) => Math.ceil(new Date(dayOf(iso)).getUTCDate() / 7);
/** Whether a day is the last of its weekday in its month. */
const lastOfMonth = (t) => new Date(t + 7 * DAY).getUTCMonth() !== new Date(t).getUTCMonth();

/**
 * A repeat rule, checked: { freq: "daily" | "weekdays" | "weekly" | "monthly", interval (weekly:
 * 1 or 2 weeks), days (weekly: 0 Sunday to 6 Saturday), by (monthly: "date", the same date, or
 * "weekday", the same weekday of the month, such as the second Tuesday), until (a date at most
 * a year after the first) }.
 */
function cleanRule(input, start) {
  const freq = String(input?.freq || "");
  if (!["daily", "weekdays", "weekly", "monthly"].includes(freq)) throw fail(400, "Choose how the event repeats.");
  const until = String(input.until || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(dayOf(until))) throw fail(400, "Choose the date it repeats until.");
  if (until <= start) throw fail(400, "It must repeat until a later date.");
  const yearOn = new Date(dayOf(start));
  yearOn.setUTCFullYear(yearOn.getUTCFullYear() + 1);
  if (dayOf(until) > yearOn.getTime()) throw fail(400, "An event repeats for at most a year.");
  const rule = { freq, until };
  if (freq === "weekly") {
    rule.interval = Number(input.interval) === 2 ? 2 : 1;
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    rule.days = days.length ? days : [new Date(dayOf(start)).getUTCDay()];
  }
  if (freq === "monthly") rule.by = input.by === "weekday" ? "weekday" : "date";
  return rule;
}

/** The dates a rule gives from `start` (included when it fits the rule) to its end. */
function datesOf(rule, start) {
  const out = [];
  const first = new Date(dayOf(start));
  const nth = nthOfMonth(start);
  // Weeks counted from the Sunday of the first date's week, for every other week.
  const week0 = dayOf(start) - first.getUTCDay() * DAY;
  for (let t = dayOf(start); t <= dayOf(rule.until); t += DAY) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    let fits;
    if (rule.freq === "daily") fits = true;
    else if (rule.freq === "weekdays") fits = wd >= 1 && wd <= 5;
    else if (rule.freq === "weekly") fits = rule.days.includes(wd) && Math.floor((t - week0) / (7 * DAY)) % rule.interval === 0;
    else if (rule.by === "date") fits = d.getUTCDate() === first.getUTCDate(); // a month without that date is skipped
    // The same weekday of the month: the second Tuesday, say; a fifth one means the last.
    else fits = wd === first.getUTCDay() && (nth === 5 ? lastOfMonth(t) : Math.ceil(d.getUTCDate() / 7) === nth);
    if (fits) out.push(isoOf(t));
  }
  return out;
}

/** "Every week on Tuesday and Thursday, until 2026-12-31", and so on. */
function ruleText(rule, start) {
  if (!rule) return null;
  const until = `, until ${rule.until}`;
  const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]);
  if (rule.freq === "daily") return `Every day${until}`;
  if (rule.freq === "weekdays") return `Every weekday${until}`;
  if (rule.freq === "weekly") return `Every ${rule.interval === 2 ? "other week" : "week"} on ${and(rule.days.map((d) => WEEKDAYS[d]))}${until}`;
  const first = new Date(dayOf(start));
  if (rule.by === "date") return `Every month on day ${first.getUTCDate()}${until}`;
  return `Every month on the ${ORDINALS[nthOfMonth(start) - 1]} ${WEEKDAYS[first.getUTCDay()]}${until}`;
}
const hostName = (p) => (p && p.first_name ? `${p.preferred_name || p.first_name} ${p.last_name}` : null);

function createEvents({ db, now = Date.now }) {
  const raw = db.raw;

  const SELECT = `SELECT e.*, s.name AS site_name, s.time_zone, c.name AS company_name, p.first_name, p.last_name, p.preferred_name
    FROM visitor_events e JOIN sites s ON s.id = e.site_id LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN people p ON p.id = e.host_id`;

  function guestsOf(eventIds) {
    const out = new Map();
    if (!eventIds.length) return out;
    const rows = raw.prepare(`SELECT g.event_id, g.visitor_id, g.visit_id, g.badge_id, b.number AS badge_number, b.facility_code AS badge_code, v.first_name, v.last_name, v.organization, v.blocked, x.checked_in_at, x.checked_out_at, x.checkin_stage
      FROM event_guests g JOIN visitors v ON v.id = g.visitor_id LEFT JOIN visits x ON x.id = g.visit_id LEFT JOIN badges b ON b.id = g.badge_id
      WHERE g.event_id IN (${inList(eventIds)}) ORDER BY v.last_name COLLATE NOCASE, v.first_name COLLATE NOCASE`).all(...eventIds);
    for (const r of rows) {
      if (!out.has(r.event_id)) out.set(r.event_id, []);
      out.get(r.event_id).push({
        visitorId: r.visitor_id,
        firstName: r.first_name,
        lastName: r.last_name,
        organization: r.organization,
        blocked: Boolean(r.blocked),
        visitId: r.visit_id,
        status: !r.visit_id ? "expected" : r.checked_out_at ? "left" : "here",
        // Arrived, but the desk hasn't finished checking them in (their ID, or a badge).
        checkinStage: r.visit_id && !r.checked_out_at && ["id", "badge"].includes(r.checkin_stage) ? r.checkin_stage : null,
        // The visitor badge picked for them ahead of time.
        badge: r.badge_id ? { id: r.badge_id, number: r.badge_number, facilityCode: r.badge_code ?? null, label: badgeLabel(r.badge_code, r.badge_number) } : null,
        arrivedAt: r.checked_in_at ?? null,
        leftAt: r.checked_out_at ?? null
      });
    }
    return out;
  }

  function rows(list) {
    const guests = guestsOf(list.map((r) => r.id));
    return list.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      siteName: r.site_name,
      title: r.title,
      date: r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      companyId: r.company_id,
      companyName: r.company_name,
      hostId: r.host_id,
      hostName: hostName(r),
      notes: r.notes,
      // The series a repeating event's date belongs to (null: it doesn't repeat), and how it repeats.
      seriesId: r.series_id ?? null,
      repeat: r.series_rule ? JSON.parse(r.series_rule) : null,
      repeatText: r.series_rule ? ruleText(JSON.parse(r.series_rule), seriesStart(r.series_id)) : null,
      createdBy: r.created_by,
      guests: guests.get(r.id) || []
    }));
  }

  const seriesStart = (seriesId) => raw.prepare("SELECT date FROM visitor_events WHERE id = ?").get(seriesId)?.date
    ?? raw.prepare("SELECT min(date) AS d FROM visitor_events WHERE series_id = ?").get(seriesId).d;

  /** The events a change to `event` reaches: it alone, or (scope "following") it and its series' later dates. */
  function reach(event, scope, sites) {
    if (scope !== "following" || !event.seriesId) return [event.id];
    // Its later dates at the caller's sites (a date moved to another site may not be).
    const sc = siteScope(sites);
    const later = raw.prepare(`SELECT e.id FROM visitor_events e WHERE e.series_id = ? AND e.date >= ? AND e.id != ?${sc.sql ? ` AND ${sc.sql}` : ""} ORDER BY e.date`)
      .all(event.seriesId, event.date, event.id, ...sc.params);
    return [event.id, ...later.map((r) => r.id)];
  }

  function siteScope(sites) {
    if (!sites) return { sql: "", params: [] };
    const ids = [...sites];
    return { sql: ids.length ? `e.site_id IN (${inList(ids)})` : "0", params: ids };
  }

  /** Events from `from` to `to` (YYYY-MM-DD, inclusive), at a site or every site the caller sees. */
  function list({ from, to = from, siteId = null, sites = null } = {}) {
    const where = ["e.date >= ?", "e.date <= ?"];
    const params = [from, to];
    const sc = siteScope(sites);
    if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
    if (siteId) { where.push("e.site_id = ?"); params.push(siteId); }
    return rows(raw.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY e.date, coalesce(e.start_time, '99'), e.title`).all(...params));
  }

  function get(id, { sites = null } = {}) {
    const sc = siteScope(sites);
    const r = raw.prepare(`${SELECT} WHERE e.id = ?${sc.sql ? ` AND ${sc.sql}` : ""}`).get(Number(id), ...sc.params);
    return r ? rows([r])[0] : null;
  }

  function clean(input, existing, sites) {
    const out = {};
    const has = (k) => input[k] !== undefined || !existing;
    if (has("siteId")) {
      const site = raw.prepare("SELECT * FROM sites WHERE id = ?").get(Number(input.siteId));
      if (!site) throw fail(400, "Choose the event's site.");
      if (sites && !sites.has(site.id)) throw fail(403, "This account can't add events at that site.");
      out.siteId = site.id;
    }
    if (has("title")) {
      const t = String(input.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!t) throw fail(400, "Give the event a name.");
      out.title = t;
    }
    if (has("date")) {
      const d = String(input.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw fail(400, "The date must look like 2026-10-14.");
      out.date = d;
    }
    for (const [key, label] of [["startTime", "Start"], ["endTime", "End"]]) {
      if (input[key] !== undefined) {
        const v = String(input[key] || "").trim();
        if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw fail(400, `${label} must be a time like 09:30.`);
        out[key] = v || null;
      }
    }
    // The company needn't be at the event's site: a tenant may use another site's rooms. On
    // the event's date it counts as at that site for checking in (visitors.companyHere).
    if (input.companyId !== undefined) {
      const cid = input.companyId;
      if (cid === null || cid === "" || cid === undefined) out.companyId = null;
      else {
        const c = raw.prepare("SELECT id FROM companies WHERE id = ?").get(Number(cid));
        if (!c) throw fail(400, "That company doesn't exist.");
        out.companyId = c.id;
      }
    }
    const companyId = out.companyId !== undefined ? out.companyId : existing?.companyId ?? null;
    if (input.hostId !== undefined || out.companyId !== undefined) {
      const hid = input.hostId !== undefined ? input.hostId : existing?.hostId;
      if (hid === null || hid === "" || hid === undefined) out.hostId = null;
      else if (!companyId || !raw.prepare("SELECT 1 FROM people WHERE id = ? AND company_id = ?").get(Number(hid), companyId)) throw fail(400, "The host must be someone in the event's company.");
      else out.hostId = Number(hid);
    }
    if (input.notes !== undefined) out.notes = String(input.notes || "").trim().slice(0, 2000) || null;
    return out;
  }

  /**
   * Adds an event; with `repeat` (a rule, see cleanRule), one for each date it gives, as a
   * series. Returns the first, with `count` the number of dates.
   */
  function create(input, { by = null, sites = null } = {}) {
    const v = clean(input, null, sites);
    const rule = input.repeat ? cleanRule(input.repeat, v.date) : null;
    const dates = rule ? datesOf(rule, v.date) : [v.date];
    if (!dates.length) throw fail(400, "Those repeat settings give no dates; check the days chosen.");
    const t = now();
    const insert = raw.prepare(`INSERT INTO visitor_events (site_id, title, date, start_time, end_time, company_id, host_id, notes, series_rule, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = [];
    db.transaction(() => {
      for (const date of dates) {
        ids.push(Number(insert.run(v.siteId, v.title, date, v.startTime ?? null, v.endTime ?? null, v.companyId ?? null, v.hostId ?? null, v.notes ?? null, rule ? JSON.stringify(rule) : null, by, t, t).lastInsertRowid));
      }
      if (rule) raw.prepare(`UPDATE visitor_events SET series_id = ? WHERE id IN (${inList(ids)})`).run(ids[0], ...ids);
    });
    return { ...get(ids[0]), count: dates.length };
  }

  /**
   * Changes an event, or (scope "following") it and its series' later dates; those keep their
   * own dates (a new date applies to this one alone). Returns this one, with `count` changed.
   */
  function update(id, input, { sites = null, scope = "one" } = {}) {
    const existing = get(id, { sites });
    if (!existing) throw fail(404, "No such event.");
    const ids = reach(existing, scope, sites);
    const stmt = raw.prepare("UPDATE visitor_events SET site_id = ?, title = ?, date = ?, start_time = ?, end_time = ?, company_id = ?, host_id = ?, notes = ?, updated_at = ? WHERE id = ?");
    db.transaction(() => {
      for (const eventId of ids) {
        const was = eventId === existing.id ? existing : get(eventId);
        const change = eventId === existing.id ? input : { ...input, date: undefined };
        const next = { ...was, ...clean(change, was, sites) };
        stmt.run(next.siteId, next.title, next.date, next.startTime, next.endTime, next.companyId, next.hostId, next.notes, now(), eventId);
      }
    });
    return { ...get(id), count: ids.length };
  }

  /** Deletes an event, or (scope "following") it and its series' later dates. Returns it, with `count`. */
  function remove(id, { sites = null, scope = "one" } = {}) {
    const existing = get(id, { sites });
    if (!existing) throw fail(404, "No such event.");
    const ids = reach(existing, scope, sites);
    raw.prepare(`DELETE FROM visitor_events WHERE id IN (${inList(ids)})`).run(...ids);
    return { ...existing, count: ids.length };
  }

  /**
   * Adds an expected guest, to the event or (scope "following") to it and its series' later
   * dates; one already at an event is left as they are.
   */
  function addGuest(eventId, visitorId, { sites = null, scope = "one" } = {}) {
    const event = get(eventId, { sites });
    if (!event) throw fail(404, "No such event.");
    if (!raw.prepare("SELECT 1 FROM visitors WHERE id = ?").get(Number(visitorId))) throw fail(404, "No such visitor.");
    db.transaction(() => {
      for (const id of reach(event, scope, sites)) {
        const e = id === event.id ? event : get(id);
        raw.prepare("INSERT OR IGNORE INTO event_guests (event_id, visitor_id, added_at) VALUES (?, ?, ?)").run(e.id, Number(visitorId), now());
        // Already here today at that site (checked in before being added): note it straight away.
        if (e.date === today(raw.prepare("SELECT time_zone FROM sites WHERE id = ?").get(e.siteId).time_zone, now())) {
          const open = raw.prepare("SELECT id FROM visits WHERE visitor_id = ? AND site_id = ? AND checked_out_at IS NULL ORDER BY checked_in_at DESC").get(Number(visitorId), e.siteId);
          if (open) raw.prepare("UPDATE event_guests SET visit_id = ? WHERE event_id = ? AND visitor_id = ? AND visit_id IS NULL").run(open.id, e.id, Number(visitorId));
        }
      }
    });
    return get(event.id);
  }

  /** Takes a guest off the event or (scope "following") it and its series' later dates, where they haven't arrived. */
  function removeGuest(eventId, visitorId, { sites = null, scope = "one" } = {}) {
    const event = get(eventId, { sites });
    if (!event) throw fail(404, "No such event.");
    const ids = reach(event, scope, sites);
    // On this date as asked; on later ones only where they haven't come.
    raw.prepare("DELETE FROM event_guests WHERE event_id = ? AND visitor_id = ?").run(event.id, Number(visitorId));
    const later = ids.filter((id) => id !== event.id);
    if (later.length) raw.prepare(`DELETE FROM event_guests WHERE event_id IN (${inList(later)}) AND visitor_id = ? AND visit_id IS NULL`).run(...later, Number(visitorId));
    return get(event.id);
  }

  /**
   * Picks the visitor badge to hand an expected guest when they arrive (null clears it): an
   * active visitor badge valid at the event's site, not reserved for someone else, and not
   * picked for another guest that day at that site.
   */
  function setGuestBadge(eventId, visitorId, badgeId, { sites = null } = {}) {
    const event = get(eventId, { sites });
    if (!event) throw fail(404, "No such event.");
    if (!raw.prepare("SELECT 1 FROM event_guests WHERE event_id = ? AND visitor_id = ?").get(event.id, Number(visitorId))) throw fail(404, "They aren't a guest at this event.");
    if (badgeId !== null) {
      const badge = raw.prepare("SELECT id, number, facility_code, type, status FROM badges WHERE id = ?").get(Number(badgeId));
      if (!badge) throw fail(404, "No such badge.");
      badge.number = badgeLabel(badge.facility_code, badge.number); // named with its code below
      if (badge.type !== "visitor") throw fail(400, `Badge ${badge.number} isn't a visitor badge.`);
      if (badge.status !== "active") throw fail(400, `Badge ${badge.number} is ${badge.status}.`);
      const sitesOf = raw.prepare("SELECT site_id FROM badge_sites WHERE badge_id = ?").all(badge.id).map((r) => r.site_id);
      if (sitesOf.length && !sitesOf.includes(event.siteId)) throw fail(400, `Badge ${badge.number} isn't valid at ${event.siteName}.`);
      const reserved = raw.prepare("SELECT id, first_name, last_name FROM visitors WHERE reserved_badge_id = ?").get(badge.id);
      if (reserved && reserved.id !== Number(visitorId)) throw fail(409, `Badge ${badge.number} is reserved for ${reserved.first_name} ${reserved.last_name}.`);
      const taken = raw.prepare(`SELECT v.first_name, v.last_name FROM event_guests g JOIN visitor_events e ON e.id = g.event_id JOIN visitors v ON v.id = g.visitor_id
        WHERE g.badge_id = ? AND e.site_id = ? AND e.date = ? AND NOT (g.event_id = ? AND g.visitor_id = ?)`).get(badge.id, event.siteId, event.date, event.id, Number(visitorId));
      if (taken) throw fail(409, `Badge ${badge.number} is picked for ${taken.first_name} ${taken.last_name} that day.`);
    }
    raw.prepare("UPDATE event_guests SET badge_id = ? WHERE event_id = ? AND visitor_id = ?").run(badgeId === null ? null : Number(badgeId), event.id, Number(visitorId));
    return get(event.id);
  }

  /** The badge picked ahead for the event guest this visit is (null if none), with the event's title. */
  function badgeForVisit(visitId) {
    const r = raw.prepare(`SELECT g.badge_id, b.number, b.facility_code, e.title FROM event_guests g JOIN visitor_events e ON e.id = g.event_id JOIN badges b ON b.id = g.badge_id
      WHERE g.visit_id = ? ORDER BY coalesce(e.start_time, '99') LIMIT 1`).get(Number(visitId));
    return r ? { id: r.badge_id, number: r.number, label: badgeLabel(r.facility_code, r.number), eventTitle: r.title } : null;
  }

  /**
   * Today's events at `siteId` a visitor is expected at and hasn't arrived for yet, with
   * the company and host to offer them first (the kiosk).
   */
  function expectedToday(visitorId, siteId) {
    const tz = raw.prepare("SELECT time_zone FROM sites WHERE id = ?").get(siteId)?.time_zone;
    return raw.prepare(`SELECT e.id, e.title, e.company_id, c.name AS company_name, c.active AS company_active, e.host_id, p.first_name, p.last_name, p.preferred_name, p.active AS host_active, g.badge_id
      FROM event_guests g JOIN visitor_events e ON e.id = g.event_id LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN people p ON p.id = e.host_id
      WHERE g.visitor_id = ? AND g.visit_id IS NULL AND e.site_id = ? AND e.date = ? ORDER BY coalesce(e.start_time, '99')`).all(visitorId, siteId, today(tz, now()))
      .filter((r) => r.company_id && r.company_active)
      .map((r) => ({ eventId: r.id, title: r.title, companyId: r.company_id, companyName: r.company_name, hostId: r.host_id && r.host_active ? r.host_id : null, hostName: r.host_active ? hostName(r) : null, badgeId: r.badge_id ?? null }));
  }

  /** Expected guests at the caller's sites today who haven't arrived, for the navigation count. */
  function expectedCount(sites = null) {
    const siteRows = raw.prepare("SELECT id, time_zone FROM sites WHERE active = 1").all().filter((s) => !sites || sites.has(s.id));
    let n = 0;
    for (const s of siteRows) {
      n += raw.prepare("SELECT count(*) AS n FROM event_guests g JOIN visitor_events e ON e.id = g.event_id WHERE e.site_id = ? AND e.date = ? AND g.visit_id IS NULL").get(s.id, today(s.time_zone, now())).n;
    }
    return n;
  }

  return { list, get, create, update, remove, addGuest, removeGuest, setGuestBadge, badgeForVisit, expectedToday, expectedCount };
}

module.exports = { createEvents, cleanRule, datesOf, ruleText };
