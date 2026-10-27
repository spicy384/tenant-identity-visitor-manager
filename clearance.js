/**
 * Clearance levels.
 *
 * Levels are an ordered list: a higher rank covers every level below it, so someone at
 * TS//SCI FSP may hold a TS//SCI CI badge but not the other way round. Below them all is
 * Uncleared, built in: no level at all (null), which anyone may hold. It isn't a row, so it
 * can't be renamed, reordered or deleted, and no level may take its name.
 *
 * A person's or visitor's clearance counts only while it hasn't expired: an expiry date in
 * the past means no clearance at all for badge purposes.
 *
 * Validation: only the Security role sets a clearance, by validating it. Anyone who may
 * change a record can ask for validation, optionally with the last four digits of the
 * person's SSN. Those digits are held only in this process's memory, never in the database,
 * a log or a response other than the Security role's, and are wiped when the request is
 * validated or canceled, after `digitsHours` (CLEARANCE_DIGITS_HOURS, 36 to start with), or
 * when the process stops. They are kept and handed around as Buffers, never strings: a
 * string can't be overwritten and lingers until the garbage collector reuses its memory. A clearance
 * counts for badges only once validated; a visitor's only within the re-check period
 * (Settings, 90 days to start with).
 */
const SETTINGS_KEY = "clearance";
const DEFAULT_RECHECK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DIGITS_HOURS = 36;
const MAX_DIGITS_HOURS = 168;

/** True for a Buffer of exactly four ASCII digits. */
function isFourDigits(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 4) return false;
  for (const b of buf) if (b < 0x30 || b > 0x39) return false;
  return true;
}

/** The visitor re-check period in days, from the settings. */
function recheckDays(db) {
  try {
    const n = Number(JSON.parse(db.getSetting(SETTINGS_KEY) || "{}").visitorRecheckDays);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_RECHECK_DAYS;
  } catch {
    return DEFAULT_RECHECK_DAYS;
  }
}

/**
 * Where someone's clearance validation stands: "requested" (waiting for Security),
 * "unvalidated", "validated", or for a visitor "recheck" (validated longer ago than the
 * re-check period). rec: { clearanceValidatedAt, clearanceRequested }.
 */
function statusFor(kind, rec, days = DEFAULT_RECHECK_DAYS, now = Date.now()) {
  if (rec.clearanceRequested) return "requested";
  if (!rec.clearanceValidatedAt) return "unvalidated";
  if (kind === "visitor" && rec.clearanceValidatedAt + days * DAY_MS < now) return "recheck";
  return "validated";
}

const DEFAULT_LEVELS = [
  ["Secret", 10],
  ["TS", 20],
  ["TS//SCI", 30],
  ["TS//SCI CI", 40],
  ["TS//SCI FSP", 50]
];
/** The built-in lowest level: no clearance. */
const UNCLEARED = "Uncleared";
/** Names that mean Uncleared where a level is given by name (an import). */
const isUnclearedName = (value) => ["uncleared", "none", "no clearance"].includes(String(value ?? "").trim().toLowerCase());

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Today's date as YYYY-MM-DD in `timeZone` (or the server's), for comparing expiry dates. */
function today(timeZone = undefined, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** A YYYY-MM-DD date, null for empty; throws for anything else. */
function cleanDate(value, label) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw fail(400, `${label} must be a date (YYYY-MM-DD).`);
  return s;
}

function createClearance({ db, now = Date.now, digitsHours = DEFAULT_DIGITS_HOURS }) {
  const digitsTtlMs = digitsHours * HOUR_MS;
  const raw = db.raw;

  // The defaults, once, on an empty database.
  if (!raw.prepare("SELECT 1 FROM clearance_levels LIMIT 1").get() && !db.getSetting("clearance.seeded")) {
    db.transaction(() => {
      for (const [name, rank] of DEFAULT_LEVELS) raw.prepare("INSERT INTO clearance_levels (name, rank, created_at) VALUES (?, ?, ?)").run(name, rank, now());
      db.setSetting("clearance.seeded", "1");
    });
  }

  // --- levels -----------------------------------------------------------------------

  function levelRow(r) {
    return r && { id: r.id, name: r.name, rank: r.rank, inUse: r.in_use ?? undefined };
  }

  function levels() {
    return raw.prepare(`SELECT l.*, (SELECT count(*) FROM people WHERE clearance_level_id = l.id) + (SELECT count(*) FROM visitors WHERE clearance_level_id = l.id)
      + (SELECT count(*) FROM badges WHERE clearance_level_id = l.id) AS in_use FROM clearance_levels l ORDER BY l.rank, l.name`).all().map(levelRow);
  }

  function level(id) {
    return levelRow(raw.prepare("SELECT * FROM clearance_levels WHERE id = ?").get(Number(id)));
  }

  function cleanLevel(input, existing = null) {
    const out = {};
    if (input.name !== undefined || !existing) {
      const name = String(input.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (!name) throw fail(400, "Give the clearance level a name.");
      if (isUnclearedName(name)) throw fail(409, `${UNCLEARED} is built in: it is the level below all the others, no clearance at all.`);
      const clash = raw.prepare("SELECT id FROM clearance_levels WHERE name = ?").get(name);
      if (clash && clash.id !== existing?.id) throw fail(409, "There is already a clearance level with that name.");
      out.name = name;
    }
    if (input.rank !== undefined || !existing) {
      const rank = Number(input.rank ?? ((raw.prepare("SELECT max(rank) AS r FROM clearance_levels").get().r || 0) + 10));
      if (!Number.isInteger(rank) || rank < 0 || rank > 100000) throw fail(400, "The order must be a whole number; higher covers lower.");
      out.rank = rank;
    }
    return out;
  }

  function createLevel(input) {
    const v = cleanLevel(input);
    return level(raw.prepare("INSERT INTO clearance_levels (name, rank, created_at) VALUES (?, ?, ?)").run(v.name, v.rank, now()).lastInsertRowid);
  }

  function updateLevel(id, input) {
    const existing = level(id);
    if (!existing) throw fail(404, "No such clearance level.");
    const next = { ...existing, ...cleanLevel(input, existing) };
    raw.prepare("UPDATE clearance_levels SET name = ?, rank = ? WHERE id = ?").run(next.name, next.rank, id);
    return level(id);
  }

  function removeLevel(id) {
    const existing = levels().find((l) => l.id === Number(id));
    if (!existing) throw fail(404, "No such clearance level.");
    if (existing.inUse) throw fail(409, `${existing.name} is used by ${existing.inUse} ${existing.inUse === 1 ? "person, visitor or badge" : "people, visitors or badges"}; change them first.`);
    db.transaction(() => {
      // Its badge template images go with it (badge-templates.js).
      raw.prepare("DELETE FROM badge_templates WHERE level_key = ?").run(Number(id));
      raw.prepare("DELETE FROM clearance_levels WHERE id = ?").run(id);
    });
    return existing;
  }

  // --- whose clearance covers what ----------------------------------------------------------

  /** A clearance level id from input: null for none, else an existing level. */
  function cleanLevelId(value) {
    if (value === null || value === undefined || value === "") return null;
    const l = level(value);
    if (!l) throw fail(400, "That clearance level doesn't exist.");
    return l.id;
  }

  /**
   * The level a holder's clearance counts as today: null when they have none or it has
   * expired. holder: { clearanceLevelId, clearanceExpires }.
   */
  function effectiveLevel(holder, timeZone = undefined) {
    if (!holder?.clearanceLevelId) return null;
    if (holder.clearanceExpires && holder.clearanceExpires < today(timeZone, now())) return null;
    // Only a validated clearance counts; a visitor's only within the re-check period.
    if (!holder.clearanceValidatedAt) return null;
    if (holder.kind === "visitor" && holder.clearanceValidatedAt + recheckDays(db) * DAY_MS < now()) return null;
    return level(holder.clearanceLevelId);
  }

  /** Why a holder's clearance on record doesn't count today, or null when it does (or they have none). */
  function notCounting(holder, timeZone = undefined) {
    if (!holder?.clearanceLevelId) return null;
    if (holder.clearanceExpires && holder.clearanceExpires < today(timeZone, now())) return "has expired";
    if (!holder.clearanceValidatedAt) return "hasn't been validated by Security";
    if (holder.kind === "visitor" && holder.clearanceValidatedAt + recheckDays(db) * DAY_MS < now()) return "is due to be re-checked by Security";
    return null;
  }

  // --- settings ---------------------------------------------------------------------------

  function settings() {
    return { visitorRecheckDays: recheckDays(db) };
  }

  function saveSettings({ visitorRecheckDays } = {}) {
    const n = Number(visitorRecheckDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw fail(400, "Re-check visitors' clearances every 1 to 3,650 days.");
    db.setSetting(SETTINGS_KEY, JSON.stringify({ visitorRecheckDays: n }));
    return settings();
  }

  // --- the last four digits, in memory only ---------------------------------------------------

  // request id -> { digits: Buffer (four bytes, zero-filled when wiped), expiresAt }. Never written anywhere.
  const digitsStore = new Map();

  function wipeDigits(requestId) {
    const entry = digitsStore.get(requestId);
    if (entry) {
      entry.digits.fill(0);
      digitsStore.delete(requestId);
    }
  }

  /** Wipes digits past their time, and any whose request is no longer waiting (deleted holders). */
  function sweepDigits() {
    if (!digitsStore.size) return;
    const open = new Set(raw.prepare("SELECT id FROM clearance_requests WHERE status = 'open'").all().map((r) => r.id));
    for (const [id, entry] of digitsStore) if (entry.expiresAt <= now() || !open.has(id)) wipeDigits(id);
  }
  const sweeper = setInterval(sweepDigits, 10 * 60 * 1000);
  sweeper.unref();

  /** A copy of one request's digits as a Buffer (the caller zero-fills it when done), or null. */
  function digitsFor(requestId) {
    sweepDigits();
    const entry = digitsStore.get(requestId);
    if (!entry) return null;
    const copy = Buffer.alloc(4);
    entry.digits.copy(copy);
    return copy;
  }

  // --- validation requests ---------------------------------------------------------------------

  function holderRow(kind, id) {
    if (kind === "person") {
      const r = raw.prepare("SELECT p.*, c.name AS company_name FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id = ?").get(Number(id));
      return r && { kind, id: r.id, name: `${r.first_name} ${r.last_name}`, organization: r.company_name };
    }
    if (kind === "visitor") {
      const r = raw.prepare("SELECT * FROM visitors WHERE id = ?").get(Number(id));
      return r && { kind, id: r.id, name: `${r.first_name} ${r.last_name}`, organization: r.organization };
    }
    throw fail(400, "Clearances belong to people and visitors.");
  }

  function closeOpen(kind, id, status, by, levelId = null) {
    const open = raw.prepare("SELECT id FROM clearance_requests WHERE holder_kind = ? AND holder_id = ? AND status = 'open'").all(kind, Number(id));
    for (const r of open) {
      raw.prepare("UPDATE clearance_requests SET status = ?, resolved_by = ?, resolved_at = ?, level_id = ? WHERE id = ?").run(status, by, now(), levelId, r.id);
      wipeDigits(r.id);
    }
    return open.length;
  }

  /**
   * Asks the Security role to validate someone's clearance. `last4` (optional) is the last
   * four digits of their SSN as a Buffer: copied into memory for the Security role, nowhere
   * else (the caller wipes its own). A string is accepted for scripts and tests. A request
   * already open for them is replaced. Returns the request, without the digits.
   */
  function requestValidation({ kind, id, last4 = null, note = null, by = null }) {
    const h = holderRow(kind, id);
    if (!h) throw fail(404, "No such person or visitor.");
    let digits = null;
    const given = typeof last4 === "string" ? Buffer.from(last4.trim(), "latin1") : last4;
    if (given !== null && given !== undefined && given.length) {
      if (!isFourDigits(given)) throw fail(400, "The last four of the SSN are four digits.");
      digits = Buffer.alloc(4);
      given.copy(digits);
    }
    if (typeof last4 === "string" && given) given.fill(0);
    const cleanNote = String(note ?? "").trim().slice(0, 500) || null;
    // The digits go in their own box, never in a note that is kept.
    if (digits && cleanNote && Buffer.from(cleanNote.replace(/\D/g, ""), "latin1").indexOf(digits) !== -1) {
      digits.fill(0);
      throw fail(400, "Leave the SSN digits out of the note: the note is kept, the digits are not.");
    }
    let requestId;
    try {
      db.transaction(() => {
        closeOpen(kind, h.id, "replaced", by);
        requestId = raw.prepare("INSERT INTO clearance_requests (holder_kind, holder_id, requested_by, requested_at, note, had_digits) VALUES (?, ?, ?, ?, ?, ?)")
          .run(kind, h.id, by, now(), cleanNote, digits ? 1 : 0).lastInsertRowid;
      });
    } catch (error) {
      if (digits) digits.fill(0);
      throw error;
    }
    if (digits) digitsStore.set(Number(requestId), { digits, expiresAt: now() + digitsTtlMs });
    digits = null;
    return { id: Number(requestId), holder: h, hadDigits: digitsStore.has(Number(requestId)) };
  }

  /**
   * Open requests, for the Security role's queue: never with the digits themselves, only
   * whether they are still held (digitsOf() gives them, one request at a time).
   */
  function openRequests() {
    sweepDigits();
    return raw.prepare("SELECT * FROM clearance_requests WHERE status = 'open' ORDER BY requested_at").all().map((r) => {
      const h = holderRow(r.holder_kind, r.holder_id);
      const current = r.holder_kind === "person"
        ? raw.prepare("SELECT clearance_level_id, clearance_validated_at FROM people WHERE id = ?").get(r.holder_id)
        : raw.prepare("SELECT clearance_level_id, clearance_validated_at FROM visitors WHERE id = ?").get(r.holder_id);
      return {
        id: r.id,
        kind: r.holder_kind,
        holderId: r.holder_id,
        name: h ? h.name : "(removed)",
        organization: h ? h.organization : null,
        currentLevel: current?.clearance_level_id ? level(current.clearance_level_id)?.name || null : null,
        lastValidatedAt: current?.clearance_validated_at || null,
        requestedBy: r.requested_by,
        requestedAt: r.requested_at,
        note: r.note,
        hadDigits: Boolean(r.had_digits),
        digitsHeld: digitsStore.has(r.id)
      };
    });
  }

  function openCount() {
    return raw.prepare("SELECT count(*) AS n FROM clearance_requests WHERE status = 'open'").get().n;
  }

  /** Whether someone has a request waiting. */
  function hasOpen(kind, id) {
    return Boolean(raw.prepare("SELECT 1 FROM clearance_requests WHERE holder_kind = ? AND holder_id = ? AND status = 'open'").get(kind, Number(id)));
  }

  /**
   * The Security role validates a clearance: sets the level (null for "no clearance"),
   * granted and expiry dates, and when and by whom it was validated. Every open request for
   * them is closed and its digits wiped. Returns how many requests were closed.
   */
  function validate({ kind, id, levelId = null, granted, expires, by }) {
    const h = holderRow(kind, id);
    if (!h) throw fail(404, "No such person or visitor.");
    const lvl = cleanLevelId(levelId);
    const g = cleanDate(granted, "Clearance granted");
    const e = cleanDate(expires, "Clearance expires");
    if (g && e && e < g) throw fail(400, "The clearance can't expire before it was granted.");
    const table = kind === "person" ? "people" : "visitors";
    let closed = 0;
    db.transaction(() => {
      raw.prepare(`UPDATE ${table} SET clearance_level_id = ?, clearance_granted = ?, clearance_expires = ?, clearance_validated_at = ?, clearance_validated_by = ?, updated_at = ? WHERE id = ?`)
        .run(lvl, lvl ? g : null, lvl ? e : null, now(), by, now(), h.id);
      closed = closeOpen(kind, h.id, "validated", by, lvl);
    });
    return { holder: h, level: lvl ? level(lvl) : null, closed };
  }

  /**
   * The Security role validates the same clearance for several people (or visitors) at once,
   * all or nothing: for those already checked outside this system. Returns each holder and
   * how many requests were closed.
   */
  function validateMany({ kind, ids, levelId = null, granted, expires, by }) {
    if (!Array.isArray(ids) || !ids.length) throw fail(400, "Choose at least one.");
    // Everything checked first: validating wipes digits held in memory, which a rollback
    // wouldn't bring back.
    if (ids.some((id) => !holderRow(kind, id))) throw fail(404, "One of them doesn't exist.");
    cleanLevelId(levelId);
    const g = cleanDate(granted, "Clearance granted");
    const e = cleanDate(expires, "Clearance expires");
    if (g && e && e < g) throw fail(400, "The clearance can't expire before it was granted.");
    const results = [];
    db.transaction(() => {
      for (const id of ids) results.push(validate({ kind, id, levelId, granted, expires, by }));
    });
    return { holders: results.map((r) => r.holder), level: results[0].level, closed: results.reduce((n, r) => n + r.closed, 0) };
  }

  /** Cancels a request (and wipes its digits). */
  function cancelRequest(requestId, by) {
    const r = raw.prepare("SELECT * FROM clearance_requests WHERE id = ? AND status = 'open'").get(Number(requestId));
    if (!r) throw fail(404, "No such request waiting.");
    raw.prepare("UPDATE clearance_requests SET status = 'canceled', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, now(), r.id);
    wipeDigits(r.id);
    return { holder: holderRow(r.holder_kind, r.holder_id) };
  }

  /** Someone is being deleted: their waiting requests go, digits and all. */
  function forgetHolder(kind, id, by = null) {
    closeOpen(kind, id, "canceled", by);
    sweepDigits();
  }

  function stop() {
    clearInterval(sweeper);
    for (const id of [...digitsStore.keys()]) wipeDigits(id);
  }

  // --- what is coming up (the Security pages and dashboard) -----------------------------------

  /**
   * Clearances that need attention soon: visitors whose validation runs out (re-check) within
   * \`withinDays\` or already has, clearances on record that expire within \`expiringDays\` or
   * expired in the last 30, and validations of the last \`recentDays\`. Holders only, levels
   * named: for roles that see clearance levels. The caller drops those it can't see.
   */
  function overview({ withinDays = 30, expiringDays = 60, recentDays = 30 } = {}) {
    const t = now();
    const days = recheckDays(db);
    const holders = (where, params = []) => [
      ...raw.prepare(`SELECT 'person' AS kind, p.id, p.first_name, p.last_name, c.name AS org, l.name AS level_name, p.clearance_expires, p.clearance_validated_at, p.clearance_validated_by
        FROM people p JOIN companies c ON c.id = p.company_id LEFT JOIN clearance_levels l ON l.id = p.clearance_level_id WHERE ${where.replace(/\bX\./g, "p.")}`).all(...params),
      ...raw.prepare(`SELECT 'visitor' AS kind, v.id, v.first_name, v.last_name, v.organization AS org, l.name AS level_name, v.clearance_expires, v.clearance_validated_at, v.clearance_validated_by
        FROM visitors v LEFT JOIN clearance_levels l ON l.id = v.clearance_level_id WHERE ${where.replace(/\bX\./g, "v.")}`).all(...params)
    ];
    const item = (r, extra = {}) => ({
      kind: r.kind, id: r.id, name: `${r.first_name} ${r.last_name}`, organization: r.org || null, levelName: r.level_name || null,
      expires: r.clearance_expires || null, validatedAt: r.clearance_validated_at || null, validatedBy: r.clearance_validated_by || null, ...extra
    });
    const recheckBy = t + withinDays * DAY_MS;
    const rechecks = raw.prepare(`SELECT 'visitor' AS kind, v.id, v.first_name, v.last_name, v.organization AS org, l.name AS level_name, v.clearance_expires, v.clearance_validated_at, v.clearance_validated_by
        FROM visitors v JOIN clearance_levels l ON l.id = v.clearance_level_id
        WHERE v.clearance_validated_at IS NOT NULL AND v.clearance_validated_at + ? <= ? ORDER BY v.clearance_validated_at`).all(days * DAY_MS, recheckBy)
      .map((r) => item(r, { dueAt: r.clearance_validated_at + days * DAY_MS, overdue: r.clearance_validated_at + days * DAY_MS < t }));
    const todayStr = today(undefined, t);
    const from = today(undefined, t - 30 * DAY_MS);
    const to = today(undefined, t + expiringDays * DAY_MS);
    const expiring = holders("X.clearance_level_id IS NOT NULL AND X.clearance_expires IS NOT NULL AND X.clearance_expires >= ? AND X.clearance_expires <= ?", [from, to])
      .map((r) => item(r, { expired: r.clearance_expires < todayStr }))
      .sort((a, b) => a.expires.localeCompare(b.expires));
    const recent = holders("X.clearance_validated_at >= ?", [t - recentDays * DAY_MS])
      .map((r) => item(r))
      .sort((a, b) => b.validatedAt - a.validatedAt);
    return { recheckDays: days, withinDays, expiringDays, recentDays, rechecks, expiring, recent };
  }

  /** True when `holderLevel` (a level or null) covers `badgeLevel` (a level or null). */
  function covers(holderLevel, badgeLevel) {
    if (!badgeLevel) return true;
    return Boolean(holderLevel) && holderLevel.rank >= badgeLevel.rank;
  }

  return {
    levels,
    level,
    createLevel,
    updateLevel,
    removeLevel,
    cleanLevelId,
    effectiveLevel,
    notCounting,
    covers,
    settings,
    saveSettings,
    requestValidation,
    openRequests,
    openCount,
    hasOpen,
    digitsOf: digitsFor,
    DIGITS_TTL_HOURS: digitsHours,
    validate,
    validateMany,
    cancelRequest,
    forgetHolder,
    sweepDigits,
    overview,
    stop
  };
}

module.exports = { createClearance, cleanDate, today, DEFAULT_LEVELS, UNCLEARED, isUnclearedName, recheckDays, statusFor, isFourDigits, DEFAULT_DIGITS_HOURS, MAX_DIGITS_HOURS, DEFAULT_RECHECK_DAYS };
