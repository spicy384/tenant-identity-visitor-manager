/**
 * Staff routes for validating clearances. Mounted after the sign-in check, so req.user and
 * req.ctx are set.
 *
 * Anyone who may change a person (directory edit) or a visitor (visitors edit), and the
 * Security role, can ask for someone's clearance to be validated, optionally giving the last
 * four digits of their SSN. Only the Security role sees the queue, reads the digits (one
 * request at a time, never in a list) and validates, which is the only way a clearance is
 * set. The digits never go into the audit log, a URL, or any response but the one that
 * shows them to Security, and responses here are never cached.
 *
 * The digits never become a JavaScript string here: a string can't be overwritten and stays
 * in memory until the garbage collector reuses the space. The request arrives as raw bytes
 * (server.js), takeDigits() copies the digits out and blanks them before the rest is parsed
 * as JSON, and the answer that shows them to Security is written as bytes. Every Buffer that
 * held them is zero-filled once done.
 */
const express = require("express");
const { isFourDigits } = require("./clearance");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const LAST4_KEY = Buffer.from('"last4"', "latin1");
const NULL_BYTES = Buffer.from("null", "latin1");
const isSpace = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * Takes the value of "last4" out of a raw JSON body without making a string of it: returns
 * the digits as a new four-byte Buffer (or null when there are none) and overwrites them in
 * `buf` with `null`, so the rest parses as JSON without them. Anything but a plain string of
 * four digits, null or "" is refused; the caller zero-fills `buf` whatever happens.
 */
function takeDigits(buf) {
  const at = buf.indexOf(LAST4_KEY);
  if (at === -1) return null;
  if (buf.indexOf(LAST4_KEY, at + 1) !== -1) throw fail(400, "Give the last four of the SSN once.");
  let i = at + LAST4_KEY.length;
  while (i < buf.length && isSpace(buf[i])) i += 1;
  if (buf[i] !== 0x3a) throw fail(400, "The request couldn't be read.");
  i += 1;
  while (i < buf.length && isSpace(buf[i])) i += 1;
  if (NULL_BYTES.compare(buf, i, i + 4) === 0) return null; // compared as bytes: no string of whatever is there
  if (buf[i] !== 0x22) throw fail(400, "The last four of the SSN are four digits, sent as text.");
  let end = i + 1;
  while (end < buf.length && buf[end] !== 0x22 && end - i <= 8) end += 1;
  if (buf[end] !== 0x22) throw fail(400, "The last four of the SSN are four digits.");
  if (end === i + 1) return null; // ""
  const digits = Buffer.alloc(end - i - 1);
  buf.copy(digits, 0, i + 1, end);
  if (!isFourDigits(digits)) {
    digits.fill(0);
    throw fail(400, "The last four of the SSN are four digits.");
  }
  // "dddd" (six bytes) becomes `null  `, still valid JSON.
  buf.write("null  ", i, "latin1");
  return digits;
}

/** {"last4":"dddd"} as bytes, built from the digits without a string; zero-fill it once sent. */
function digitsBody(digits) {
  const head = Buffer.from('{"last4":"', "latin1");
  const out = Buffer.alloc(head.length + digits.length + 2);
  head.copy(out);
  digits.copy(out, head.length);
  out.write('"}', head.length + digits.length, "latin1");
  return out;
}

function positiveInt(value, fallback = null) {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function createClearanceRoutes({ access, clearance, directory, visitors, admin, auditFrom }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;

  router.use("/api/clearance", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const security = (req, res, next) => (access.isSecurity(req.ctx) ? next() : res.status(403).json({ error: "Only the Security role validates clearances." }));

  function kindOf(value) {
    if (value === "person" || value === "visitor") return value;
    throw fail(400, "Clearances belong to people and visitors.");
  }

  /** The holder, if the caller can see them. */
  function visibleHolder(req, kind, id) {
    return kind === "person" ? directory.getPerson(id, { sites: req.ctx.sites }) : visitors.get(id, { sites: req.ctx.sites });
  }

  const nameOf = (r) => `${r.preferredName || r.firstName} ${r.lastName}`;

  /** Waiting requests whose holder the caller can see. */
  function visibleRequests(req) {
    const list = clearance.openRequests();
    if (!req.ctx.sites) return list;
    return list.filter((r) => visibleHolder(req, r.kind, r.holderId));
  }

  // --- asking -------------------------------------------------------------------------------

  router.post("/api/clearance/requests", (req, res) => {
    // The body must have come in as bytes (server.js); anything else could hold the digits
    // in a string already, so it is refused rather than used.
    if (!Buffer.isBuffer(req.body)) throw fail(400, "The request couldn't be read.");
    let digits = null;
    try {
      digits = takeDigits(req.body);
      let body;
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        throw fail(400, "The request couldn't be read.");
      }
      req.body.fill(0);
      if (!body || typeof body !== "object") throw fail(400, "The request couldn't be read.");
      const kind = kindOf(body.kind);
      const id = positiveInt(body.id);
      const mayAsk = access.isSecurity(req.ctx) || (kind === "person" ? access.canEditDirectory(req.ctx) : access.canEditVisitors(req.ctx));
      if (!mayAsk) throw fail(403, kind === "person" ? "This account can't change the directory." : "This account can't change visitors.");
      const holder = id && visibleHolder(req, kind, id);
      if (!holder) throw fail(404, kind === "person" ? "No such person." : "No such visitor.");
      const result = clearance.requestValidation({ kind, id, last4: digits, note: body.note, by: staffName(req) });
      // Whether digits came with it, never what they were.
      auditFrom(req, "clearance.request", nameOf(holder), `${kind}${result.hadDigits ? "; with the last four of the SSN (held in memory for Security, not stored)" : ""}`);
      res.json({ ok: true, request: { id: result.id, hadDigits: result.hadDigits } });
    } finally {
      if (digits) digits.fill(0);
      req.body.fill(0);
    }
  });

  // --- the Security role's queue ---------------------------------------------------------------

  router.get("/api/clearance/requests", security, (req, res) => {
    res.json({ requests: visibleRequests(req), digitsHeldHours: clearance.DIGITS_TTL_HOURS });
  });

  router.get("/api/clearance/queue-count", security, (req, res) => {
    res.json({ count: visibleRequests(req).length });
  });

  /** One request's digits, when Security asks to see them. */
  router.post("/api/clearance/requests/:id/digits", security, (req, res) => {
    const request = visibleRequests(req).find((r) => r.id === positiveInt(req.params.id));
    if (!request) throw fail(404, "No such request waiting.");
    const digits = clearance.digitsOf(request.id);
    if (!digits) throw fail(410, request.hadDigits ? "Those digits have been wiped: they're kept only for a limited time. Ask for them again." : "No digits were given with this request.");
    auditFrom(req, "clearance.digits_view", request.name, "the last four of the SSN shown to Security");
    // Written as bytes, not res.json(): no string, and no ETag (a hash of four digits is
    // no secret).
    const out = digitsBody(digits);
    digits.fill(0);
    const wipe = () => out.fill(0);
    res.once("finish", wipe);
    res.once("close", wipe);
    res.status(200).set({ "Content-Type": "application/json; charset=utf-8", "Content-Length": String(out.length) });
    res.end(out);
  });

  router.post("/api/clearance/requests/:id/cancel", security, (req, res) => {
    const request = visibleRequests(req).find((r) => r.id === positiveInt(req.params.id));
    if (!request) throw fail(404, "No such request waiting.");
    clearance.cancelRequest(request.id, staffName(req));
    auditFrom(req, "clearance.cancel", request.name, request.hadDigits ? "digits wiped" : null);
    res.json({ ok: true });
  });

  router.post("/api/clearance/validate", security, (req, res) => {
    const body = req.body || {};
    const kind = kindOf(body.kind);
    const id = positiveInt(body.id);
    const holder = id && visibleHolder(req, kind, id);
    if (!holder) throw fail(404, kind === "person" ? "No such person." : "No such visitor.");
    const result = clearance.validate({ kind, id, levelId: body.levelId, granted: body.granted, expires: body.expires, by: staffName(req) });
    auditFrom(req, "clearance.validate", nameOf(holder), `${kind}; ${result.level ? result.level.name : "no clearance"}${body.expires ? `, expires ${body.expires}` : ""}${result.closed ? "; request closed, digits wiped" : ""}`);
    res.json({ ok: true, level: result.level, closed: result.closed });
  });

  /** The same clearance for up to 1,000 people (or visitors) already checked: all or nothing. */
  router.post("/api/clearance/validate-bulk", security, (req, res) => {
    const body = req.body || {};
    const kind = kindOf(body.kind);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => positiveInt(v)))];
    if (!ids.length || ids.includes(null)) throw fail(400, "Choose at least one.");
    if (ids.length > 1000) throw fail(400, "At most 1,000 at once.");
    const holders = ids.map((id) => visibleHolder(req, kind, id));
    if (holders.some((x) => !x)) throw fail(404, kind === "person" ? "One of those people doesn't exist, or is at a site this account can't see." : "One of those visitors doesn't exist, or visits a site this account can't see.");
    const result = clearance.validateMany({ kind, ids, levelId: body.levelId, granted: body.granted, expires: body.expires, by: staffName(req) });
    // One entry each, as when validated one at a time.
    const detail = `${kind}; ${result.level ? result.level.name : "no clearance"}${body.expires ? `, expires ${body.expires}` : ""}; one of ${ids.length} validated together`;
    for (const holder of holders) auditFrom(req, "clearance.validate", nameOf(holder), detail);
    res.json({ ok: true, validated: ids.length, level: result.level, closed: result.closed });
  });

  // --- settings --------------------------------------------------------------------------------

  // --- what is coming up: the Security pages and dashboard (Security and administrators) --------

  const securityOrAdmin = (req, res, next) => ((access.isSecurity(req.ctx) || req.ctx.isAdmin) && access.canSeeClearances(req.ctx)
    ? next() : res.status(403).json({ error: "Only Security and administrators see clearances coming up." }));

  router.get("/api/clearance/overview", securityOrAdmin, (req, res) => {
    const days = (v, fallback) => Math.min(Math.max(positiveInt(v, fallback), 1), 365);
    const o = clearance.overview({ withinDays: days(req.query.within, 30), expiringDays: days(req.query.expiring, 60), recentDays: days(req.query.recent, 30) });
    // Only people and visitors the caller can see (site limits).
    const visible = (x) => !req.ctx.sites || Boolean(visibleHolder(req, x.kind, x.id));
    res.json({ ...o, rechecks: o.rechecks.filter(visible), expiring: o.expiring.filter(visible), recent: o.recent.filter(visible) });
  });

  router.get("/api/clearance/settings", (req, res) => {
    res.json(clearance.settings());
  });

  router.put("/api/clearance/settings", admin, (req, res) => {
    const saved = clearance.saveSettings(req.body || {});
    auditFrom(req, "clearance.settings", "Visitor clearance re-check", `every ${saved.visitorRecheckDays} days`);
    res.json({ ok: true, ...saved });
  });

  return { router, queueCount: (req) => (access.isSecurity(req.ctx) ? visibleRequests(req).length : 0) };
}

module.exports = { createClearanceRoutes, takeDigits, digitsBody };
