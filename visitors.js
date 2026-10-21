/**
 * Visitors, the companies they visit (each with a usual host), and their visits.
 *
 * A visitor is not a tenant person: they belong to no company of the building, but may
 * be linked to any number of them. Visits record where (site), whom (company, host) and
 * when; the company's and host's names are copied onto the visit so the log still reads
 * correctly after a company or person is removed.
 *
 * Site limits: an account limited to some sites sees a visitor when they are linked to a
 * company it can see or have visited one of its sites, sees only those links, and only
 * the visits at its sites.
 */
const { normaliseValue } = require("./fields");
const { matchNames } = require("./names");
const { likeWord } = require("./directory");
const { cleanDate, today, statusFor, recheckDays } = require("./clearance");

const VISITOR_SELECT = `SELECT v.*, (SELECT name FROM clearance_levels WHERE id = v.clearance_level_id) AS clearance_level_name,
  EXISTS (SELECT 1 FROM clearance_requests q WHERE q.holder_kind = 'visitor' AND q.holder_id = v.id AND q.status = 'open') AS clearance_requested FROM visitors v`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHECKOUT_METHODS = ["kiosk", "staff", "auto"];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text(v, max = 200) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
  return s || null;
}

function longText(v, max = 4000) {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
  return s || null;
}

const inList = (ids) => ids.map(() => "?").join(",");

/** "Jane Doe", or "Janie Doe" when she goes by another name: how a host is shown. */
function hostDisplayName(p) {
  return `${p.preferred_name || p.first_name} ${p.last_name}`.trim();
}

function createVisitors({ db, fields }) {
  const raw = db.raw;

  // --- scope -------------------------------------------------------------------------

  /** SQL (alias v) limiting visitors to those `sites` may see; empty when unlimited. */
  function visitorScope(sites) {
    if (!sites) return { sql: "", params: [] };
    const ids = [...sites];
    if (!ids.length) return { sql: "0", params: [] };
    return {
      sql: `(EXISTS (SELECT 1 FROM visitor_links l JOIN company_sites cs ON cs.company_id = l.company_id WHERE l.visitor_id = v.id AND cs.site_id IN (${inList(ids)}))
        OR EXISTS (SELECT 1 FROM visits x WHERE x.visitor_id = v.id AND x.site_id IN (${inList(ids)})))`,
      params: [...ids, ...ids]
    };
  }

  function companyVisible(companyId, sites) {
    if (!sites) return true;
    const ids = [...sites];
    return ids.length > 0 && Boolean(raw.prepare(`SELECT 1 FROM company_sites WHERE company_id = ? AND site_id IN (${inList(ids)})`).get(companyId, ...ids));
  }

  // --- reading ------------------------------------------------------------------------

  /** Links of the given visitors: Map(visitorId -> [{ companyId, companyName, hostId, hostName, notes }]). */
  function linksFor(ids, sites = null) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = raw.prepare(`SELECT l.visitor_id, l.company_id, l.host_id, l.notes, c.name AS company_name, p.first_name, p.last_name, p.preferred_name
        FROM visitor_links l JOIN companies c ON c.id = l.company_id LEFT JOIN people p ON p.id = l.host_id
        WHERE l.visitor_id IN (${inList(chunk)}) ORDER BY c.name`).all(...chunk);
      for (const r of rows) {
        if (!companyVisible(r.company_id, sites)) continue;
        if (!out.has(r.visitor_id)) out.set(r.visitor_id, []);
        out.get(r.visitor_id).push({ companyId: r.company_id, companyName: r.company_name, hostId: r.host_id, hostName: r.first_name ? hostDisplayName(r) : null, notes: r.notes || null });
      }
    }
    return out;
  }

  function records(rows, sites) {
    const ids = rows.map((r) => r.id);
    const links = linksFor(ids, sites);
    const values = fields.valuesFor("visitor", ids);
    const days = recheckDays(db);
    return rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      organisation: r.organisation,
      email: r.email,
      phone: r.phone,
      notes: r.notes,
      clearanceLevel: r.clearance_level_id ?? null,
      clearanceLevelName: r.clearance_level_name ?? null,
      clearanceGranted: r.clearance_granted ?? null,
      clearanceExpires: r.clearance_expires ?? null,
      clearanceValidatedAt: r.clearance_validated_at ?? null,
      clearanceValidatedBy: r.clearance_validated_by ?? null,
      clearanceStatus: statusFor("visitor", { clearanceValidatedAt: r.clearance_validated_at, clearanceRequested: r.clearance_requested }, days),
      verified: Boolean(r.verified),
      blocked: Boolean(r.blocked),
      source: r.source,
      lastVisitAt: r.last_visit_at,
      companies: links.get(r.id) || [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      values: values.get(r.id) || new Map()
    }));
  }

  /**
   * Visitors the caller may see. filter: "review" (registered at a kiosk, not yet checked
   * by staff), "blocked", or null. search: { columns, fieldIds } from access.searchable().
   */
  function list({ q = "", search = { columns: ["v.first_name", "v.last_name"], fieldIds: [] }, sites = null, filter = null, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    const scope = visitorScope(sites);
    if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
    if (filter === "review") where.push("v.verified = 0");
    if (filter === "blocked") where.push("v.blocked = 1");
    const words = String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
    // The companies column must only match companies the caller can see.
    const columns = search.columns.map((c) => (c.includes("visitor_links") && sites
      ? `(SELECT group_concat(c3.name, ' ') FROM visitor_links l3 JOIN companies c3 ON c3.id = l3.company_id WHERE l3.visitor_id = v.id AND EXISTS (SELECT 1 FROM company_sites cs3 WHERE cs3.company_id = c3.id AND cs3.site_id IN (${[...sites].join(",") || "NULL"})))`
      : c));
    for (const word of words) {
      const pattern = likeWord(word);
      const ors = columns.map((c) => `coalesce(${c}, '') LIKE ? ESCAPE '\\'`);
      params.push(...columns.map(() => pattern));
      if (search.fieldIds.length) {
        ors.push(`EXISTS (SELECT 1 FROM field_values fv WHERE fv.record_id = v.id AND fv.field_id IN (${inList(search.fieldIds)}) AND fv.value LIKE ? ESCAPE '\\')`);
        params.push(...search.fieldIds, pattern);
      }
      where.push(ors.length ? `(${ors.join(" OR ")})` : "0");
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = raw.prepare(`SELECT count(*) AS n FROM visitors v ${clause}`).get(...params).n;
    const rows = raw.prepare(`${VISITOR_SELECT} ${clause} ORDER BY v.verified, coalesce(v.last_visit_at, v.created_at) DESC, v.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { records: records(rows, sites), total };
  }

  function get(id, { sites = null } = {}) {
    const scope = visitorScope(sites);
    const row = raw.prepare(`${VISITOR_SELECT} WHERE v.id = ?${scope.sql ? ` AND ${scope.sql}` : ""}`).get(id, ...scope.params);
    return row ? records([row], sites)[0] : null;
  }

  function reviewCount(sites = null) {
    const scope = visitorScope(sites);
    return raw.prepare(`SELECT count(*) AS n FROM visitors v WHERE v.verified = 0${scope.sql ? ` AND ${scope.sql}` : ""}`).get(...scope.params).n;
  }

  // --- writing ------------------------------------------------------------------------

  function clean(input, existing) {
    const out = {};
    for (const [key, label] of [["firstName", "First name"], ["lastName", "Last name"]]) {
      if (input[key] !== undefined || !existing) {
        const v = text(input[key], 80);
        if (!v) throw fail(400, `${label} is required.`);
        out[key] = v;
      }
    }
    if (input.organisation !== undefined) out.organisation = text(input.organisation, 120);
    if (input.email !== undefined) {
      const v = text(input.email, 254);
      if (v && !EMAIL_RE.test(v)) throw fail(400, "Email must be an email address.");
      out.email = v ? v.toLowerCase() : null;
    }
    if (input.phone !== undefined) out.phone = text(input.phone, 40);
    if (input.notes !== undefined) out.notes = longText(input.notes);
    if (input.verified !== undefined) out.verified = Boolean(input.verified);
    if (input.blocked !== undefined) out.blocked = Boolean(input.blocked);
    if (input.clearanceLevel !== undefined) {
      const v = input.clearanceLevel;
      if (v === null || v === "") out.clearanceLevel = null;
      else if (!raw.prepare("SELECT 1 FROM clearance_levels WHERE id = ?").get(Number(v))) throw fail(400, "That clearance level doesn't exist.");
      else out.clearanceLevel = Number(v);
    }
    if (input.clearanceGranted !== undefined) out.clearanceGranted = cleanDate(input.clearanceGranted, "Clearance granted");
    if (input.clearanceExpires !== undefined) out.clearanceExpires = cleanDate(input.clearanceExpires, "Clearance expires");
    return out;
  }

  function customValues(custom, { creating = false, editable = [], current = new Map() } = {}) {
    const out = new Map();
    for (const [def, value] of custom) out.set(def.id, normaliseValue(def, value));
    for (const def of editable) {
      if (!def.required || def.builtIn) continue;
      const after = out.has(def.id) ? out.get(def.id) : current.get(def.id) ?? null;
      if (after === null && (creating || out.has(def.id))) throw fail(400, `${def.label} is required.`);
    }
    return out;
  }

  /** The usual host for a link: someone in that company who can host, or null. */
  function checkHost(companyId, hostId) {
    if (hostId === null || hostId === undefined || hostId === "") return null;
    const id = Number(hostId);
    const p = raw.prepare("SELECT id, can_host, active FROM people WHERE id = ? AND company_id = ?").get(id, companyId);
    if (!p) throw fail(400, "The host must be someone in that company.");
    return id;
  }

  /** Adds or updates a link; the company must be one the caller can see. */
  function setLink(visitorId, { companyId, hostId = null, notes } = {}, { sites = null } = {}) {
    const cid = Number(companyId);
    if (!Number.isInteger(cid) || !raw.prepare("SELECT 1 FROM companies WHERE id = ?").get(cid)) throw fail(400, "Choose a company.");
    if (!companyVisible(cid, sites)) throw fail(403, "That company is not at one of your sites.");
    const host = checkHost(cid, hostId);
    raw.prepare(`INSERT INTO visitor_links (visitor_id, company_id, host_id, notes, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(visitor_id, company_id) DO UPDATE SET host_id = excluded.host_id, notes = coalesce(excluded.notes, visitor_links.notes)`)
      .run(visitorId, cid, host, notes === undefined ? null : text(notes, 200), Date.now());
    raw.prepare("UPDATE visitors SET updated_at = ? WHERE id = ?").run(Date.now(), visitorId);
  }

  function removeLink(visitorId, companyId, { sites = null } = {}) {
    if (!companyVisible(Number(companyId), sites)) throw fail(403, "That company is not at one of your sites.");
    const info = raw.prepare("DELETE FROM visitor_links WHERE visitor_id = ? AND company_id = ?").run(visitorId, companyId);
    if (!info.changes) throw fail(404, "The visitor isn't linked to that company.");
    raw.prepare("UPDATE visitors SET updated_at = ? WHERE id = ?").run(Date.now(), visitorId);
  }

  /**
   * Adds a visitor. `links`: [{ companyId, hostId }]; an account limited to some sites
   * must link at least one company it can see, or it couldn't find the visitor again.
   */
  function create(input, { custom = new Map(), editable = [], sites = null, source = "staff", verified = true } = {}) {
    const v = clean(input, null);
    const links = Array.isArray(input.links) ? input.links : [];
    if (sites && !links.length) throw fail(400, "Link the visitor to a company at one of your sites.");
    const values = customValues(custom, { creating: true, editable });
    const now = Date.now();
    let id;
    db.transaction(() => {
      id = raw.prepare(`INSERT INTO visitors (first_name, last_name, organisation, email, phone, notes, clearance_level_id, clearance_granted, clearance_expires, verified, blocked, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.firstName, v.lastName, v.organisation ?? null, v.email ?? null, v.phone ?? null, v.notes ?? null, v.clearanceLevel ?? null, v.clearanceGranted ?? null, v.clearanceExpires ?? null,
          (v.verified ?? verified) ? 1 : 0, v.blocked ? 1 : 0, source, now, now).lastInsertRowid;
      for (const link of links) setLink(id, link, { sites });
      fields.writeValues(id, values);
    });
    nameCache = null;
    return get(id);
  }

  function update(id, input, { custom = new Map(), editable = [], sites = null } = {}) {
    const existing = get(id, { sites });
    if (!existing) throw fail(404, "No such visitor.");
    const v = clean(input, existing);
    const values = customValues(custom, { editable, current: existing.values });
    const next = { ...existing, ...v };
    db.transaction(() => {
      raw.prepare(`UPDATE visitors SET first_name = ?, last_name = ?, organisation = ?, email = ?, phone = ?, notes = ?, clearance_level_id = ?, clearance_granted = ?, clearance_expires = ?,
        verified = ?, blocked = ?, updated_at = ? WHERE id = ?`)
        .run(next.firstName, next.lastName, next.organisation, next.email, next.phone, next.notes, next.clearanceLevel ?? null, next.clearanceGranted ?? null, next.clearanceExpires ?? null,
          next.verified ? 1 : 0, next.blocked ? 1 : 0, Date.now(), id);
      fields.writeValues(id, values);
    });
    nameCache = null;
    return get(id, { sites });
  }

  function remove(id) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such visitor.");
    db.transaction(() => {
      fields.forgetRecord("visitor", id);
      raw.prepare("UPDATE clearance_requests SET status = 'cancelled', resolved_at = ? WHERE holder_kind = 'visitor' AND holder_id = ? AND status = 'open'").run(Date.now(), id);
      raw.prepare("DELETE FROM visitors WHERE id = ?").run(id);
    });
    nameCache = null;
    return existing;
  }

  /**
   * Folds visitor `fromId` into `intoId`: visits move across, links the target lacks are
   * added, custom values the target lacks are copied, then `fromId` is deleted.
   */
  function merge(fromId, intoId, { sites = null } = {}) {
    if (Number(fromId) === Number(intoId)) throw fail(400, "Choose a different visitor to merge into.");
    const from = get(fromId, { sites });
    const into = get(intoId, { sites });
    if (!from || !into) throw fail(404, "No such visitor.");
    let moved = 0;
    db.transaction(() => {
      moved = raw.prepare("UPDATE visits SET visitor_id = ? WHERE visitor_id = ?").run(intoId, fromId).changes;
      raw.prepare(`INSERT OR IGNORE INTO visitor_links (visitor_id, company_id, host_id, notes, created_at)
        SELECT ?, company_id, host_id, notes, created_at FROM visitor_links WHERE visitor_id = ?`).run(intoId, fromId);
      raw.prepare(`INSERT OR IGNORE INTO field_values (field_id, record_id, value)
        SELECT v.field_id, ?, v.value FROM field_values v JOIN field_definitions d ON d.id = v.field_id WHERE d.entity = 'visitor' AND d.record_id IS NULL AND v.record_id = ?`).run(intoId, fromId);
      const fill = (a, b) => a ?? b ?? null;
      raw.prepare("UPDATE visitors SET organisation = ?, email = ?, phone = ?, notes = ?, last_visit_at = (SELECT max(checked_in_at) FROM visits WHERE visitor_id = ?), blocked = max(blocked, ?), updated_at = ? WHERE id = ?")
        .run(fill(into.organisation, from.organisation), fill(into.email, from.email), fill(into.phone, from.phone), [into.notes, from.notes].filter(Boolean).join("\n\n") || null, intoId, from.blocked ? 1 : 0, Date.now(), intoId);
      // A clearance only one of them has on record is kept.
      // A clearance only one of them has on record is kept, with when it was validated.
      if (!into.clearanceLevel && from.clearanceLevel) {
        raw.prepare("UPDATE visitors SET clearance_level_id = ?, clearance_granted = ?, clearance_expires = ?, clearance_validated_at = ?, clearance_validated_by = ? WHERE id = ?")
          .run(from.clearanceLevel, from.clearanceGranted, from.clearanceExpires, from.clearanceValidatedAt, from.clearanceValidatedBy, intoId);
      }
      // Waiting validation requests follow them too.
      raw.prepare("UPDATE clearance_requests SET holder_id = ? WHERE holder_kind = 'visitor' AND holder_id = ?").run(intoId, fromId);
      // Badges they held, and events they were expected at, follow them.
      raw.prepare("UPDATE badge_assignments SET holder_id = ? WHERE holder_kind = 'visitor' AND holder_id = ?").run(intoId, fromId);
      raw.prepare("INSERT OR IGNORE INTO event_guests (event_id, visitor_id, visit_id, added_at) SELECT event_id, ?, visit_id, added_at FROM event_guests WHERE visitor_id = ?").run(intoId, fromId);
      fields.forgetRecord("visitor", fromId);
      raw.prepare("DELETE FROM visitors WHERE id = ?").run(fromId);
    });
    nameCache = null;
    return { from, into: get(intoId, { sites }), visitsMoved: moved };
  }

  // --- finding by name (the kiosk) ------------------------------------------------------

  let nameCache = null; // [{ id, firstName, lastName }], rebuilt after any change

  /** Visitors whose name matches `typed` (see names.js), best first. */
  function findByName(typed) {
    if (!nameCache) nameCache = raw.prepare("SELECT id, first_name AS firstName, last_name AS lastName FROM visitors").all();
    return matchNames(typed, nameCache).map((c) => c.id);
  }

  // --- visits ---------------------------------------------------------------------------

  function visitRow(r) {
    return r && {
      id: r.id,
      siteId: r.site_id,
      siteName: r.site_name,
      visitorId: r.visitor_id,
      visitor: { id: r.visitor_id, firstName: r.first_name, lastName: r.last_name, organisation: r.organisation, verified: Boolean(r.verified), blocked: Boolean(r.blocked) },
      companyId: r.company_id,
      companyName: r.company_name,
      hostId: r.host_id,
      hostName: r.host_name,
      purpose: r.purpose,
      checkedInAt: r.checked_in_at,
      checkedInBy: r.checked_in_by,
      kioskId: r.kiosk_id,
      kioskName: r.kiosk_name,
      checkedOutAt: r.checked_out_at,
      checkoutMethod: r.checkout_method,
      checkedOutBy: r.checked_out_by
    };
  }

  const VISIT_SELECT = `SELECT x.*, s.name AS site_name, v.first_name, v.last_name, v.organisation, v.verified, v.blocked, k.name AS kiosk_name
    FROM visits x JOIN sites s ON s.id = x.site_id JOIN visitors v ON v.id = x.visitor_id LEFT JOIN kiosks k ON k.id = x.kiosk_id`;

  function getVisit(id, { sites = null } = {}) {
    const ids = sites ? [...sites] : null;
    const r = raw.prepare(`${VISIT_SELECT} WHERE x.id = ?${ids ? ` AND x.site_id IN (${inList(ids) || "NULL"})` : ""}`).get(id, ...(ids || []));
    return visitRow(r);
  }

  /**
   * Visits the caller may see. status: "open", "closed" or "all". from/to: timestamps on
   * the check-in time. q: words matched against visitor, company and host names.
   */
  function listVisits({ sites = null, siteId = null, status = "all", from = null, to = null, companyId = null, hostId = null, visitorId = null, q = "", limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (sites) {
      const ids = [...sites];
      where.push(ids.length ? `x.site_id IN (${inList(ids)})` : "0");
      params.push(...ids);
    }
    if (siteId) { where.push("x.site_id = ?"); params.push(siteId); }
    if (status === "open") where.push("x.checked_out_at IS NULL");
    if (status === "closed") where.push("x.checked_out_at IS NOT NULL");
    if (from) { where.push("x.checked_in_at >= ?"); params.push(from); }
    if (to) { where.push("x.checked_in_at < ?"); params.push(to); }
    if (companyId) { where.push("x.company_id = ?"); params.push(companyId); }
    if (hostId) { where.push("x.host_id = ?"); params.push(hostId); }
    if (visitorId) { where.push("x.visitor_id = ?"); params.push(visitorId); }
    for (const word of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const p = likeWord(word);
      where.push("(v.first_name LIKE ? ESCAPE '\\' OR v.last_name LIKE ? ESCAPE '\\' OR coalesce(v.organisation, '') LIKE ? ESCAPE '\\' OR coalesce(x.company_name, '') LIKE ? ESCAPE '\\' OR coalesce(x.host_name, '') LIKE ? ESCAPE '\\')");
      params.push(p, p, p, p, p);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = raw.prepare(`SELECT count(*) AS n FROM visits x JOIN visitors v ON v.id = x.visitor_id ${clause}`).get(...params).n;
    const rows = raw.prepare(`${VISIT_SELECT} ${clause} ORDER BY ${status === "open" ? "x.checked_in_at" : "x.checked_in_at DESC"}, x.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { visits: rows.map(visitRow), total };
  }

  /** The visitor's open visit at `siteId`, if any. */
  function openVisit(visitorId, siteId) {
    const r = raw.prepare(`${VISIT_SELECT} WHERE x.visitor_id = ? AND x.site_id = ? AND x.checked_out_at IS NULL ORDER BY x.checked_in_at DESC`).get(visitorId, siteId);
    return visitRow(r);
  }

  /**
   * Checks a visitor in at `siteId` to see `companyId` (and `hostId`, optional). The
   * company must be at that site and the host in that company. A visitor already in the
   * building at that site gets their open visit back rather than a second one.
   * Links the visitor to the company, with the host as their usual one when given.
   */
  function checkIn({ visitorId, siteId, companyId, hostId = null, purpose = null, by = null, kioskId = null, now = Date.now() }) {
    const visitor = raw.prepare("SELECT * FROM visitors WHERE id = ?").get(visitorId);
    if (!visitor) throw fail(404, "No such visitor.");
    const site = raw.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    if (!site || !site.active) throw fail(400, "That site isn't open.");
    const company = raw.prepare("SELECT c.* FROM companies c JOIN company_sites cs ON cs.company_id = c.id WHERE c.id = ? AND cs.site_id = ? AND c.active = 1").get(companyId, siteId);
    if (!company) throw fail(400, "That company isn't at this site.");
    let host = null;
    if (hostId !== null && hostId !== undefined && hostId !== "") {
      host = raw.prepare("SELECT * FROM people WHERE id = ? AND company_id = ? AND active = 1").get(Number(hostId), company.id);
      if (!host) throw fail(400, "The host must be someone in that company.");
    }
    const already = openVisit(visitorId, siteId);
    if (already) return { visit: already, already: true };
    let id;
    db.transaction(() => {
      id = raw.prepare(`INSERT INTO visits (site_id, visitor_id, company_id, company_name, host_id, host_name, purpose, checked_in_at, checked_in_by, kiosk_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(siteId, visitorId, company.id, company.name, host ? host.id : null, host ? hostDisplayName(host) : null, text(purpose, 200), now, by, kioskId).lastInsertRowid;
      const link = raw.prepare("SELECT host_id FROM visitor_links WHERE visitor_id = ? AND company_id = ?").get(visitorId, company.id);
      if (!link) raw.prepare("INSERT INTO visitor_links (visitor_id, company_id, host_id, created_at) VALUES (?, ?, ?, ?)").run(visitorId, company.id, host ? host.id : null, now);
      else if (host && link.host_id !== host.id) raw.prepare("UPDATE visitor_links SET host_id = ? WHERE visitor_id = ? AND company_id = ?").run(host.id, visitorId, company.id);
      raw.prepare("UPDATE visitors SET last_visit_at = ?, updated_at = ? WHERE id = ?").run(now, now, visitorId);
      // Expected today at this site: the arrival is noted against the event.
      raw.prepare(`UPDATE event_guests SET visit_id = ? WHERE visitor_id = ? AND visit_id IS NULL
        AND event_id IN (SELECT id FROM visitor_events WHERE site_id = ? AND date = ?)`).run(id, visitorId, siteId, today(site.time_zone, now));
    });
    return { visit: getVisit(id), already: false };
  }

  /** Ends a visit. method: kiosk, staff or auto; `at` defaults to now. */
  function checkOut(visitId, { method = "staff", by = null, at = Date.now(), sites = null } = {}) {
    if (!CHECKOUT_METHODS.includes(method)) throw fail(400, "Unknown check-out method.");
    const visit = getVisit(visitId, { sites });
    if (!visit) throw fail(404, "No such visit.");
    if (visit.checkedOutAt) return { visit, already: true };
    raw.prepare("UPDATE visits SET checked_out_at = ?, checkout_method = ?, checked_out_by = ? WHERE id = ? AND checked_out_at IS NULL").run(Math.max(at, visit.checkedInAt), method, by, visitId);
    return { visit: getVisit(visitId), already: false };
  }

  /** Open visits at a site with their visitors' names, for the kiosk's check-out. */
  function openAtSite(siteId) {
    return listVisits({ siteId, status: "open", limit: 5000 }).visits;
  }

  /** How many are in the building now, per site the caller can see. */
  function hereNow(sites = null) {
    const ids = sites ? [...sites] : null;
    const rows = raw.prepare(`SELECT site_id, count(*) AS n FROM visits WHERE checked_out_at IS NULL${ids ? ` AND site_id IN (${inList(ids) || "NULL"})` : ""} GROUP BY site_id`).all(...(ids || []));
    return Object.fromEntries(rows.map((r) => [r.site_id, r.n]));
  }

  // --- retention -----------------------------------------------------------------------------

  /** What deleting visits that started before `cutoff` would remove. */
  function retentionPreview(cutoff) {
    const visits = raw.prepare("SELECT count(*) AS n FROM visits WHERE checked_in_at < ? AND checked_out_at IS NOT NULL").get(cutoff).n;
    const visitors = raw.prepare(`SELECT count(*) AS n FROM visitors v WHERE v.verified = 0 AND v.source = 'kiosk'
      AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.visitor_id = v.id AND NOT (x.checked_in_at < ? AND x.checked_out_at IS NOT NULL))`).get(cutoff).n;
    return { visits, visitors };
  }

  /**
   * Deletes finished visits that started before `cutoff`, then visitors who registered
   * themselves at a kiosk, were never checked by staff, and have no visits left.
   * Open visits are never deleted.
   */
  function applyRetention(cutoff) {
    let visits = 0;
    let visitors = 0;
    db.transaction(() => {
      visits = raw.prepare("DELETE FROM visits WHERE checked_in_at < ? AND checked_out_at IS NOT NULL").run(cutoff).changes;
      const orphans = raw.prepare(`SELECT id FROM visitors v WHERE v.verified = 0 AND v.source = 'kiosk' AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.visitor_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM badge_assignments b WHERE b.holder_kind = 'visitor' AND b.holder_id = v.id AND b.returned_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM clearance_requests q WHERE q.holder_kind = 'visitor' AND q.holder_id = v.id AND q.status = 'open')`).all().map((r) => r.id);
      for (const id of orphans) fields.forgetRecord("visitor", id);
      if (orphans.length) visitors = raw.prepare(`DELETE FROM visitors WHERE id IN (${inList(orphans)})`).run(...orphans).changes;
      raw.prepare("UPDATE visitors SET last_visit_at = (SELECT max(checked_in_at) FROM visits WHERE visitor_id = visitors.id)").run();
    });
    if (visitors) nameCache = null;
    return { visits, visitors };
  }

  /**
   * The visitor an imported row is: the one with this email, else the one with exactly this
   * name (any case). Null when there is none; an error when the name alone fits several.
   */
  function findMatch({ email = null, firstName, lastName }) {
    const mail = String(email || "").trim().toLowerCase();
    if (mail) {
      const byMail = raw.prepare("SELECT id FROM visitors WHERE email = ?").get(mail);
      if (byMail) return byMail.id;
    }
    const byName = raw.prepare("SELECT id, email FROM visitors WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)").all(String(firstName || "").trim(), String(lastName || "").trim())
      .filter((r) => !mail || !r.email);
    if (byName.length > 1) throw fail(409, `More than one visitor is called ${firstName} ${lastName}; give an email to tell them apart.`);
    return byName[0]?.id ?? null;
  }

  return {
    list,
    get,
    findMatch,
    reviewCount,
    create,
    update,
    remove,
    merge,
    setLink,
    removeLink,
    companyVisible,
    findByName,
    getVisit,
    listVisits,
    openVisit,
    openAtSite,
    checkIn,
    checkOut,
    hereNow,
    retentionPreview,
    applyRetention,
    hostDisplayName
  };
}

module.exports = { createVisitors, hostDisplayName, CHECKOUT_METHODS };
