/**
 * The kiosk's API, under /kiosk/api. It is separate from the staff API: a kiosk signs in
 * as a device (kiosks.js), not as a person, and can only look a visitor up by full name,
 * check them in or out, and list the tenants and hosts of its own site.
 *
 * What a kiosk ever shows about anyone is what a visitor already knows: their own first
 * name, the company they visit and their host's name. Never an email, a phone number or a
 * visit history. Lookups hand back short-lived references rather than record ids, so a
 * check-in can only be for someone a name lookup just found, and they are rate-limited
 * per kiosk.
 */
const crypto = require("crypto");
const express = require("express");
const { COUNTRIES, countryCode } = require("./countries");
const { VISITOR_TYPES } = require("./visitors");
const { createRateLimiter } = require("./rate-limit");
const { isFullName } = require("./names");
const { today } = require("./clearance");

const COOKIE = "ivm_kiosk";
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // the longest browsers keep a cookie
const REF_TTL_MS = 10 * 60 * 1000;
const LOOKUPS_PER_MINUTE = 30;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function createKioskRoutes({ db, kiosks, visitors, events = null, sites, clock, cookieSecure = false }) {
  const router = express.Router();
  const raw = db.raw;

  // References handed out by a lookup: ref -> { kioskId, kind: "visitor" | "visit", id, expiresAt }.
  const refs = new Map();
  function makeRef(kioskId, kind, id) {
    const ref = crypto.randomBytes(12).toString("base64url");
    refs.set(ref, { kioskId, kind, id, expiresAt: Date.now() + REF_TTL_MS });
    if (refs.size > 5000) for (const [k, v] of refs) if (v.expiresAt < Date.now()) refs.delete(k);
    return ref;
  }
  function takeRef(kioskId, kind, ref) {
    const r = refs.get(String(ref || ""));
    if (!r || r.kioskId !== kioskId || r.kind !== kind || r.expiresAt < Date.now()) return null;
    return r.id;
  }

  function cookieValue(token, maxAge = COOKIE_MAX_AGE_S) {
    return [`${COOKIE}=${token}`, "Path=/kiosk", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`, cookieSecure ? "Secure" : null].filter(Boolean).join("; ");
  }

  function audit(req, action, target, detail = null) {
    try {
      db.audit({ username: req.kiosk ? `kiosk:${req.kiosk.name}` : "kiosk", ip: req.ip || null, action, target, detail });
    } catch (error) {
      console.error(`audit: could not record ${action}: ${error.message}`);
    }
  }

  // A state change must come from the kiosk page itself: the header forces a CORS
  // preflight from any other origin, and the cookie is SameSite=Strict besides.
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.headers["x-kiosk-request"] !== "1") return res.status(403).json({ error: "Refused." });
    next();
  });

  const pairLimiter = createRateLimiter({ maxFailures: 10 });
  router.post("/pair", (req, res) => {
    const key = pairLimiter.clientAddress(req);
    const wait = pairLimiter.retryAfter(key);
    if (wait > 0) return res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} minutes.` });
    const result = kiosks.pair(req.body?.code, req.ip || null);
    if (!result) {
      pairLimiter.recordFailure(key);
      return res.status(401).json({ error: "That code isn't right, or it has expired. Ask an administrator for a new one." });
    }
    res.setHeader("Set-Cookie", cookieValue(result.token));
    db.audit({ username: `kiosk:${result.kiosk.name}`, ip: req.ip || null, action: "kiosk.pair", target: result.kiosk.name, detail: result.kiosk.siteName });
    res.json({ ok: true });
  });

  /** The kiosk this request comes from, or 401 (the page then shows the pairing screen). */
  router.use((req, res, next) => {
    const kiosk = kiosks.authenticate(parseCookies(req.headers.cookie)[COOKIE], req.ip || null);
    if (!kiosk) return res.status(401).json({ error: "This kiosk isn't paired.", paired: false });
    const site = sites.get(kiosk.siteId);
    if (!site || !site.active) return res.status(503).json({ error: "This kiosk's site is closed." });
    req.kiosk = kiosk;
    req.site = site;
    next();
  });

  router.get("/config", (req, res) => {
    // Keep the cookie fresh, so a kiosk in daily use never reaches the browser's limit.
    res.setHeader("Set-Cookie", cookieValue(parseCookies(req.headers.cookie)[COOKIE]));
    res.json({
      kiosk: { name: req.kiosk.name },
      site: { name: req.site.kioskName || req.site.name, welcome: req.site.welcome, hasLogo: req.site.hasLogo, logoVersion: req.site.logoUpdatedAt },
      idleSeconds: clock.settings().kioskIdleSeconds,
      // For a visitor's citizenship (U.S. citizen, or which country).
      countries: COUNTRIES,
      visitorTypes: VISITOR_TYPES
    });
  });

  router.get("/logo", (req, res) => {
    const logo = sites.getLogo(req.site.id);
    if (!logo) throw fail(404, "No logo.");
    res.setHeader("Content-Type", logo.type);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(logo.data);
  });

  /** Today's date at the kiosk's site (YYYY-MM-DD). */
  const siteToday = (siteId) => today(raw.prepare("SELECT time_zone FROM sites WHERE id = ?").get(siteId)?.time_zone, Date.now());

  /**
   * The site's tenants, names only: what a lobby directory board shows. With them, for the
   * day, companies from elsewhere holding a visitor event here.
   */
  router.get("/companies", (req, res) => {
    const rows = raw.prepare(`SELECT c.id, c.name FROM companies c WHERE c.active = 1
      AND (c.id IN (SELECT company_id FROM company_sites WHERE site_id = ?) OR c.id IN (SELECT company_id FROM visitor_events WHERE site_id = ? AND date = ?))
      ORDER BY c.name`).all(req.site.id, req.site.id, siteToday(req.site.id));
    res.json({ companies: rows });
  });

  function hostsOf(companyId, siteId) {
    return raw.prepare(`SELECT p.id, p.first_name, p.last_name, p.preferred_name FROM people p
      WHERE p.company_id = ? AND p.active = 1 AND p.can_host = 1
        AND (p.site_id IS NULL OR p.site_id = ? OR p.id IN (SELECT host_id FROM visitor_events WHERE company_id = p.company_id AND site_id = ? AND date = ?))
      ORDER BY coalesce(p.preferred_name, p.first_name) COLLATE NOCASE, p.last_name COLLATE NOCASE`).all(companyId, siteId, siteId, siteToday(siteId))
      .map((p) => ({ id: p.id, name: visitors.hostDisplayName(p) }));
  }

  function companyAtSite(companyId, siteId) {
    const c = visitors.companyHere(companyId, siteId, Date.now());
    return c && { id: c.id, name: c.name };
  }

  router.get("/companies/:id/hosts", (req, res) => {
    const company = companyAtSite(req.params.id, req.site.id);
    if (!company) throw fail(404, "That company isn't here.");
    res.json({ hosts: hostsOf(company.id, req.site.id) });
  });

  const lookupLimiter = createRateLimiter({ windowMs: 60 * 1000, maxFailures: LOOKUPS_PER_MINUTE, keyFor: (req) => `kiosk:${req.kiosk.id}` });
  function countLookup(req) {
    const key = `kiosk:${req.kiosk.id}`;
    if (lookupLimiter.retryAfter(key) > 0) throw fail(429, "Please wait a moment and try again.");
    lookupLimiter.recordFailure(key);
  }

  function needFullName(name) {
    if (!isFullName(name)) throw fail(400, "Please enter your first and last name.");
  }

  /**
   * Check-in lookup: visitors with this name, each with the companies at this site they
   * are linked to (and their usual host there). First names only, and which of their company
   * and citizenship check-in still needs (not what they are).
   */
  router.post("/lookup", (req, res) => {
    const name = String(req.body?.name || "").slice(0, 120);
    needFullName(name);
    countLookup(req);
    const ids = visitors.findByName(name).slice(0, 5);
    const matches = ids.map((id) => {
      const v = raw.prepare("SELECT id, first_name, organization, citizenship FROM visitors WHERE id = ?").get(id);
      const links = raw.prepare(`SELECT l.company_id, c.name AS company_name, p.id AS host_id, p.first_name, p.last_name, p.preferred_name, p.active AS host_active
        FROM visitor_links l JOIN companies c ON c.id = l.company_id JOIN company_sites cs ON cs.company_id = c.id AND cs.site_id = ?
        LEFT JOIN people p ON p.id = l.host_id WHERE l.visitor_id = ? AND c.active = 1 ORDER BY c.name`).all(req.site.id, id);
      // Expected here today: that event's company and host come first.
      const expected = events ? events.expectedToday(id, req.site.id).map((e) => ({ companyId: e.companyId, companyName: e.companyName, hostId: e.hostId, hostName: e.hostName, expected: true })) : [];
      const seen = new Set(expected.map((e) => e.companyId));
      return {
        ref: makeRef(req.kiosk.id, "visitor", id),
        firstName: v.first_name,
        needs: { organization: !v.organization, citizenship: !v.citizenship },
        companies: [...expected.filter((e, i) => expected.findIndex((x) => x.companyId === e.companyId) === i), ...links.filter((l) => !seen.has(l.company_id)).map((l) => ({
          companyId: l.company_id,
          companyName: l.company_name,
          hostId: l.host_id && l.host_active ? l.host_id : null,
          hostName: l.host_id && l.host_active ? visitors.hostDisplayName(l) : null
        }))]
      };
    });
    res.json({ matches });
  });

  /**
   * Checks someone in, for the front desk to check their ID and give them a badge. Either
   * `ref` (from a lookup), with `details` { organization, citizenship } filling in what their
   * record lacks (never changing what it has), or `visitor` { firstName, lastName,
   * organization, citizenship, visitorType, contact } for someone new; plus `companyId`,
   * optional `hostId`, and `purpose`.
   */
  router.post("/checkin", (req, res) => {
    const body = req.body || {};
    const company = companyAtSite(body.companyId, req.site.id);
    if (!company) throw fail(400, "Please choose who you are visiting.");
    const purpose = String(body.purpose || "").trim().slice(0, 200);
    if (!purpose) throw fail(400, "Please tell us what brings you in today.");
    const citizenshipOf = (value) => {
      const code = countryCode(value);
      if (!code) throw fail(400, "Please tell us your citizenship.");
      return code;
    };
    // Everything is checked before anyone new is saved, so a refused check-in leaves nothing behind.
    let hostId = null;
    if (body.hostId !== undefined && body.hostId !== null && body.hostId !== "") {
      hostId = Number(body.hostId);
      if (!hostsOf(company.id, req.site.id).some((h) => h.id === hostId)) throw fail(400, "Please choose your host again.");
    }
    let visitorId;
    let created = false;
    if (body.ref) {
      visitorId = takeRef(req.kiosk.id, "visitor", body.ref);
      if (!visitorId) throw fail(409, "That took a little long. Please start again.");
      const known = raw.prepare("SELECT organization, citizenship FROM visitors WHERE id = ?").get(visitorId);
      const d = body.details || {};
      const fill = {};
      if (!known.organization) {
        fill.organization = String(d.organization ?? d.organisation ?? "").trim().slice(0, 120);
        if (!fill.organization) throw fail(400, "Please enter your company.");
      }
      if (!known.citizenship) fill.citizenship = citizenshipOf(d.citizenship);
      if (Object.keys(fill).length) visitors.update(visitorId, fill, {});
    } else {
      const v = body.visitor || {};
      if (!String(v.firstName || "").trim() || !String(v.lastName || "").trim()) throw fail(400, "Please enter your first and last name.");
      const contact = String(v.contact || "").trim().slice(0, 254);
      const isEmail = contact.includes("@");
      if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw fail(400, "That email address doesn't look right.");
      // A kiosk page from before the spelling changed sends the British one, until it reloads.
      if (v.organization === undefined && v.organisation !== undefined) v.organization = v.organisation;
      if (!String(v.organization || "").trim()) throw fail(400, "Please enter your company.");
      const visitor = visitors.create({
        firstName: v.firstName,
        lastName: v.lastName,
        organization: v.organization,
        citizenship: citizenshipOf(v.citizenship),
        visitorType: VISITOR_TYPES.includes(v.visitorType) ? v.visitorType : "Guest",
        email: isEmail ? contact : undefined,
        phone: !isEmail && contact ? contact : undefined
      }, { source: "kiosk", verified: false });
      visitorId = visitor.id;
      created = true;
      audit(req, "visitor.add", `${visitor.firstName} ${visitor.lastName}`, `registered at the kiosk (${req.site.name})`);
    }
    const blocked = raw.prepare("SELECT blocked, first_name, last_name FROM visitors WHERE id = ?").get(visitorId);
    if (blocked.blocked) {
      audit(req, "kiosk.blocked", `${blocked.first_name} ${blocked.last_name}`, `tried to check in to see ${company.name}`);
      return res.json({ ok: false, seeReception: true });
    }
    const { visit, already } = visitors.checkIn({ visitorId, siteId: req.site.id, companyId: company.id, hostId, purpose, by: `kiosk:${req.kiosk.name}`, kioskId: req.kiosk.id });
    if (!already) audit(req, "visit.checkin", `${visit.visitor.firstName} ${visit.visitor.lastName}`, `${visit.companyName}${visit.hostName ? `, host ${visit.hostName}` : ""}${created ? "; new visitor" : ""}`);
    res.json({ ok: true, already, firstName: visit.visitor.firstName, companyName: visit.companyName, hostName: visit.hostName });
  });

  /** Check-out lookup: open visits at this site for this name, with the company only. */
  router.post("/checkout/lookup", (req, res) => {
    const name = String(req.body?.name || "").slice(0, 120);
    needFullName(name);
    countLookup(req);
    const wanted = new Set(visitors.findByName(name));
    const open = visitors.openAtSite(req.site.id).filter((v) => wanted.has(v.visitorId)).slice(0, 5);
    res.json({ matches: open.map((v) => ({ ref: makeRef(req.kiosk.id, "visit", v.id), firstName: v.visitor.firstName, companyName: v.companyName })) });
  });

  router.post("/checkout", (req, res) => {
    const visitId = takeRef(req.kiosk.id, "visit", req.body?.ref);
    if (!visitId) throw fail(409, "That took a little long. Please start again.");
    const { visit } = visitors.checkOut(visitId, { method: "kiosk", by: `kiosk:${req.kiosk.name}` });
    audit(req, "visit.checkout", `${visit.visitor.firstName} ${visit.visitor.lastName}`, visit.companyName);
    res.json({ ok: true, firstName: visit.visitor.firstName });
  });

  return { router, COOKIE };
}

module.exports = { createKioskRoutes };
