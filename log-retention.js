/**
 * How long the audit log keeps its entries, in two parts each with its own number of days
 * (0: for ever): sign-ins (signing in and out, failed attempts, addresses blocked) and
 * everything else. Once a day the older entries are deleted, and that is itself recorded.
 * Settings > Logs and retention sets both, beside how long visits, alarms and guard reports,
 * and a validation request's SSN digits are kept (each kept by its own module).
 */
const SETTINGS_KEY = "log_retention";
const DEFAULTS = { auditDays: 0, signinDays: 0, lastRun: 0 };
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
// Sign-in entries: what the sign-in pages record (auth.login, auth.logout, auth.entra_failed...).
const SIGNIN = "action LIKE 'auth.%'";
// The shortest a part may be kept, when it isn't kept for ever.
const LEAST = { auditDays: 30, signinDays: 7 };
const MOST = 3650;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createLogRetention({ db, now = Date.now, log = (m) => console.error(m) }) {
  const raw = db.raw;

  function settings() {
    let stored = {};
    try {
      stored = JSON.parse(db.getSetting(SETTINGS_KEY) || "{}") || {};
    } catch {
      stored = {};
    }
    return { ...DEFAULTS, ...stored };
  }

  function days(value, key, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || (n !== 0 && (n < LEAST[key] || n > MOST))) throw fail(400, `Keep ${label} for 0 (for ever) or ${LEAST[key]} to ${MOST.toLocaleString("en-US")} days.`);
    return n;
  }

  /** Saves what is given: auditDays, signinDays. */
  function save(patch = {}) {
    const next = settings();
    if (patch.auditDays !== undefined) next.auditDays = days(patch.auditDays, "auditDays", "the audit log");
    if (patch.signinDays !== undefined) next.signinDays = days(patch.signinDays, "signinDays", "sign-ins");
    if (patch.lastRun !== undefined) next.lastRun = patch.lastRun;
    db.setSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  const cutoff = (n) => (n > 0 ? now() - n * DAY_MS : null);

  /** How many entries a run with these days ({ auditDays, signinDays }, else as saved) would delete. */
  function preview(s = settings()) {
    const a = cutoff(Number(s.auditDays) || 0);
    const g = cutoff(Number(s.signinDays) || 0);
    return {
      audit: a ? raw.prepare(`SELECT count(*) AS n FROM audit WHERE NOT (${SIGNIN}) AND at < ?`).get(a).n : 0,
      signins: g ? raw.prepare(`SELECT count(*) AS n FROM audit WHERE ${SIGNIN} AND at < ?`).get(g).n : 0
    };
  }

  /** Deletes the entries older than each part keeps, and records it. Returns the counts. */
  function run() {
    const s = settings();
    const a = cutoff(s.auditDays);
    const g = cutoff(s.signinDays);
    const removed = {
      audit: a ? raw.prepare(`DELETE FROM audit WHERE NOT (${SIGNIN}) AND at < ?`).run(a).changes : 0,
      signins: g ? raw.prepare(`DELETE FROM audit WHERE ${SIGNIN} AND at < ?`).run(g).changes : 0
    };
    save({ lastRun: now() });
    if (removed.audit || removed.signins) {
      db.audit({ username: "system", action: "audit.retention", detail: `${removed.audit} audit entries older than ${s.auditDays} days and ${removed.signins} sign-ins older than ${s.signinDays} days deleted` });
    }
    return removed;
  }

  let timer = null;
  function tick() {
    try {
      if (now() - settings().lastRun >= DAY_MS) run();
    } catch (error) {
      log(`log retention: ${error.message}`);
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { settings, save, preview, run, start, stop, LEAST, MOST };
}

module.exports = { createLogRetention, SIGNIN };
