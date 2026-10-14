/**
 * Companies and their people. This layer stores and finds records; it knows about site
 * limits (which records a caller may reach) but not about field access, which
 * server.js applies through access.js on everything it returns or accepts.
 *
 * Records come back in the internal shape access.project() expects: built-in values
 * under their catalog keys plus `values`, a Map(fieldId -> stored text) of custom fields.
 */
const { normaliseValue } = require("./fields");
const { cleanDate, statusFor, recheckDays } = require("./clearance");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function email(v, label = "Email") {
  const s = text(v, 254);
  if (s && !EMAIL_RE.test(s)) throw fail(400, `${label} must be an email address.`);
  return s ? s.toLowerCase() : null;
}

function url(v) {
  let s = text(v, 300);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s)) throw fail(400, "Website must be a web address such as example.com.");
  return s;
}

/** LIKE pattern for a search word, with %, _ and \ taken literally. */
function likeWord(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * WHERE clause for a search: every word must appear in at least one of `columns` or of
 * the custom fields `fieldIds` (values of `entity` records joined on `idColumn`).
 */
function searchClause(q, { columns, fieldIds }, entity, idColumn) {
  const words = String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return { sql: "", params: [] };
  const parts = [];
  const params = [];
  for (const word of words) {
    const pattern = likeWord(word);
    const ors = columns.map((c) => `coalesce(${c}, '') LIKE ? ESCAPE '\\'`);
    params.push(...columns.map(() => pattern));
    if (fieldIds.length) {
      ors.push(`EXISTS (SELECT 1 FROM field_values fv WHERE fv.record_id = ${idColumn} AND fv.field_id IN (${fieldIds.map(() => "?").join(",")}) AND fv.value LIKE ? ESCAPE '\\')`);
      params.push(...fieldIds, pattern);
    }
    parts.push(ors.length ? `(${ors.join(" OR ")})` : "0");
  }
  return { sql: parts.join(" AND "), params };
}

function createDirectory({ db, fields }) {
  const raw = db.raw;

  // --- site limits ------------------------------------------------------------------

  /** SQL limiting companies (alias c) to `sites` (a Set) or, with `siteId`, to that one site. */
  function companyScope(sites, siteId) {
    const where = [];
    const params = [];
    if (sites) {
      const ids = [...sites];
      where.push(ids.length ? `EXISTS (SELECT 1 FROM company_sites s1 WHERE s1.company_id = c.id AND s1.site_id IN (${ids.map(() => "?").join(",")}))` : "0");
      params.push(...ids);
    }
    if (siteId) {
      where.push("EXISTS (SELECT 1 FROM company_sites s2 WHERE s2.company_id = c.id AND s2.site_id = ?)");
      params.push(siteId);
    }
    return { where, params };
  }

  /** SQL limiting people (alias p, company alias c) the same way. */
  function personScope(sites, siteId) {
    const { where, params } = companyScope(sites, siteId);
    if (sites) {
      const ids = [...sites];
      where.push(`(p.site_id IS NULL${ids.length ? ` OR p.site_id IN (${ids.map(() => "?").join(",")})` : ""})`);
      params.push(...ids);
    }
    if (siteId) {
      where.push("(p.site_id IS NULL OR p.site_id = ?)");
      params.push(siteId);
    }
    return { where, params };
  }

  /**
   * SQL counting a company's (alias c) active people that `sites` can see: everyone at
   * any site, or tied to one of those sites. Returns { sql, params }.
   */
  function peopleCount(sites) {
    if (!sites) return { sql: "(SELECT count(*) FROM people p WHERE p.company_id = c.id AND p.active = 1)", params: [] };
    const ids = [...sites];
    return {
      sql: `(SELECT count(*) FROM people p WHERE p.company_id = c.id AND p.active = 1 AND (p.site_id IS NULL${ids.length ? ` OR p.site_id IN (${ids.map(() => "?").join(",")})` : ""}))`,
      params: ids
    };
  }

  // --- companies --------------------------------------------------------------------

  function companySites(ids) {
    const out = new Map();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = raw.prepare(`SELECT cs.company_id, cs.site_id, cs.suite, s.name FROM company_sites cs JOIN sites s ON s.id = cs.site_id WHERE cs.company_id IN (${chunk.map(() => "?").join(",")}) ORDER BY s.name`).all(...chunk);
      for (const r of rows) {
        if (!out.has(r.company_id)) out.set(r.company_id, []);
        out.get(r.company_id).push({ siteId: r.site_id, siteName: r.name, suite: r.suite || null });
      }
    }
    return out;
  }

  function companyRecords(rows) {
    const ids = rows.map((r) => r.id);
    const sites = companySites(ids);
    const values = fields.valuesFor("company", ids);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      website: r.website,
      address: r.address,
      notes: r.notes,
      buildingStaff: Boolean(r.building_staff),
      active: Boolean(r.active),
      sites: sites.get(r.id) || [],
      people: r.people ?? undefined,
      updatedAt: r.updated_at,
      values: values.get(r.id) || new Map()
    }));
  }

  /**
   * Companies the caller may reach. search: { columns, fieldIds } from access.searchable().
   * Returns { records, total }.
   */
  function listCompanies({ q = "", search = { columns: ["c.name"], fieldIds: [] }, sites = null, siteId = null, includeInactive = false, updatedSince = null, limit = 500, offset = 0 } = {}) {
    const scope = companyScope(sites, siteId);
    const where = [...scope.where];
    const params = [...scope.params];
    if (!includeInactive) where.push("c.active = 1");
    if (updatedSince) { where.push("c.updated_at > ?"); params.push(updatedSince); }
    const s = searchClause(q, search, "company", "c.id");
    if (s.sql) { where.push(s.sql); params.push(...s.params); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = raw.prepare(`SELECT count(*) AS n FROM companies c ${clause}`).get(...params).n;
    const count = peopleCount(sites);
    const rows = raw.prepare(`SELECT c.*, ${count.sql} AS people FROM companies c ${clause} ORDER BY c.name LIMIT ? OFFSET ?`).all(...count.params, ...params, limit, offset);
    return { records: companyRecords(rows), total };
  }

  /** One company, or null when it does not exist or is outside `sites`. */
  function getCompany(id, { sites = null } = {}) {
    const scope = companyScope(sites, null);
    const count = peopleCount(sites);
    const row = raw.prepare(`SELECT c.*, ${count.sql} AS people FROM companies c WHERE c.id = ?${scope.where.length ? ` AND ${scope.where.join(" AND ")}` : ""}`).get(...count.params, id, ...scope.params);
    return row ? companyRecords([row])[0] : null;
  }

  function findCompanyByName(name) {
    const row = raw.prepare("SELECT * FROM companies WHERE name = ?").get(String(name || "").trim());
    return row ? companyRecords([row])[0] : null;
  }

  /**
   * The site list after a change: `wanted` [{ siteId, suite }] replaces what the caller
   * can see, while sites outside the caller's limit are kept as they were.
   */
  function mergeSites(current, wanted, callerSites) {
    if (!Array.isArray(wanted)) throw fail(400, "Sites must be a list.");
    const seen = new Set();
    const out = [];
    for (const w of wanted) {
      const siteId = Number(w?.siteId);
      if (!Number.isInteger(siteId) || seen.has(siteId)) continue;
      if (callerSites && !callerSites.has(siteId)) throw fail(403, "This account can't place companies at that site.");
      if (!raw.prepare("SELECT 1 FROM sites WHERE id = ?").get(siteId)) throw fail(400, "One of the chosen sites does not exist.");
      seen.add(siteId);
      out.push({ siteId, suite: text(w.suite, 60) });
    }
    if (callerSites) {
      for (const c of current) if (!callerSites.has(c.siteId) && !seen.has(c.siteId)) out.push({ siteId: c.siteId, suite: c.suite });
    }
    return out;
  }

  function writeSites(companyId, list) {
    raw.prepare("DELETE FROM company_sites WHERE company_id = ?").run(companyId);
    const put = raw.prepare("INSERT INTO company_sites (company_id, site_id, suite) VALUES (?, ?, ?)");
    for (const s of list) put.run(companyId, s.siteId, s.suite);
  }

  function cleanCompany(input, existing) {
    const out = {};
    if (input.name !== undefined || !existing) {
      const name = text(input.name, 120);
      if (!name) throw fail(400, "Give the company a name.");
      const clash = raw.prepare("SELECT id FROM companies WHERE name = ?").get(name);
      if (clash && clash.id !== existing?.id) throw fail(409, `There is already a company called ${name}.`);
      out.name = name;
    }
    if (input.phone !== undefined) out.phone = text(input.phone, 40);
    if (input.email !== undefined) out.email = email(input.email);
    if (input.website !== undefined) out.website = url(input.website);
    if (input.address !== undefined) out.address = longText(input.address, 400);
    if (input.notes !== undefined) out.notes = longText(input.notes);
    if (input.buildingStaff !== undefined) out.buildingStaff = Boolean(input.buildingStaff);
    if (input.active !== undefined) out.active = Boolean(input.active);
    return out;
  }

  /**
   * Normalised custom values for a write: Map(fieldId -> text|null). `custom` is the
   * Map(definition -> input) access.checkWrite() returned; `editable` the definitions
   * the caller can edit, so a required one left empty on a new record is refused.
   */
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

  /**
   * Adds a company. `sites`: [{ siteId, suite }]; a caller limited to some sites must
   * place it at one of them. Returns the new record.
   */
  function createCompany(input, { custom = new Map(), editable = [], callerSites = null } = {}) {
    const v = cleanCompany(input, null);
    const siteList = mergeSites([], input.sites || [], callerSites);
    if (callerSites && !siteList.length) throw fail(400, "Choose at least one of your sites for the company.");
    const values = customValues(custom, { creating: true, editable });
    const now = Date.now();
    let id;
    db.transaction(() => {
      id = raw.prepare("INSERT INTO companies (name, phone, email, website, address, notes, building_staff, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(v.name, v.phone ?? null, v.email ?? null, v.website ?? null, v.address ?? null, v.notes ?? null, v.buildingStaff ? 1 : 0, v.active === false ? 0 : 1, now, now).lastInsertRowid;
      writeSites(id, siteList);
      fields.writeValues(id, values);
    });
    return getCompany(id);
  }

  function updateCompany(id, input, { custom = new Map(), editable = [], callerSites = null } = {}) {
    const existing = getCompany(id, { sites: callerSites });
    if (!existing) throw fail(404, "No such company.");
    const v = cleanCompany(input, existing);
    const values = customValues(custom, { editable, current: existing.values });
    const next = { ...existing, ...v };
    db.transaction(() => {
      raw.prepare("UPDATE companies SET name = ?, phone = ?, email = ?, website = ?, address = ?, notes = ?, building_staff = ?, active = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.phone, next.email, next.website, next.address, next.notes, next.buildingStaff ? 1 : 0, next.active ? 1 : 0, Date.now(), id);
      if (input.sites !== undefined) {
        const list = mergeSites(existing.sites, input.sites, callerSites);
        writeSites(id, list);
        // People tied to a site the company has left are no longer tied to one.
        const keep = list.map((s) => s.siteId);
        raw.prepare(`UPDATE people SET site_id = NULL, updated_at = ? WHERE company_id = ? AND site_id IS NOT NULL${keep.length ? ` AND site_id NOT IN (${keep.map(() => "?").join(",")})` : ""}`).run(Date.now(), id, ...keep);
      }
      fields.writeValues(id, values);
      if (next.active !== existing.active) {
        // Everyone's copy of the company's people (Checkout's, later) notices through updated_at.
        raw.prepare("UPDATE people SET updated_at = ? WHERE company_id = ?").run(Date.now(), id);
      }
    });
    return getCompany(id);
  }

  /** Deletes a company and its people (administrators only; inactive is usually better). */
  function deleteCompany(id) {
    const existing = getCompany(id);
    if (!existing) throw fail(404, "No such company.");
    let peopleRemoved = 0;
    db.transaction(() => {
      const ids = raw.prepare("SELECT id FROM people WHERE company_id = ?").all(id).map((r) => r.id);
      for (const pid of ids) fields.forgetRecord("person", pid);
      raw.prepare("UPDATE clearance_requests SET status = 'cancelled', resolved_at = ? WHERE holder_kind = 'person' AND status = 'open' AND holder_id IN (SELECT id FROM people WHERE company_id = ?)").run(Date.now(), id);
      peopleRemoved = raw.prepare("DELETE FROM people WHERE company_id = ?").run(id).changes;
      fields.forgetRecord("company", id);
      raw.prepare("DELETE FROM companies WHERE id = ?").run(id);
    });
    return { ...existing, peopleRemoved };
  }

  // --- people -------------------------------------------------------------------------

  const PERSON_SELECT = `SELECT p.*, c.name AS company_name, c.active AS company_active, c.building_staff AS company_staff, s.name AS site_name, cl.name AS clearance_level_name,
    EXISTS (SELECT 1 FROM clearance_requests q WHERE q.holder_kind = 'person' AND q.holder_id = p.id AND q.status = 'open') AS clearance_requested
    FROM people p JOIN companies c ON c.id = p.company_id LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN clearance_levels cl ON cl.id = p.clearance_level_id`;

  function personRecords(rows) {
    const values = fields.valuesFor("person", rows.map((r) => r.id));
    const days = recheckDays(db);
    return rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      companyId: r.company_id,
      companyName: r.company_name,
      companyActive: Boolean(r.company_active),
      jobTitle: r.job_title,
      email: r.email,
      workPhone: r.work_phone,
      mobile: r.mobile,
      siteId: r.site_id,
      siteName: r.site_name,
      canHost: Boolean(r.can_host),
      buildingStaff: Boolean(r.company_staff),
      clearanceLevel: r.clearance_level_id ?? null,
      clearanceLevelName: r.clearance_level_name ?? null,
      clearanceGranted: r.clearance_granted ?? null,
      clearanceExpires: r.clearance_expires ?? null,
      clearanceValidatedAt: r.clearance_validated_at ?? null,
      clearanceValidatedBy: r.clearance_validated_by ?? null,
      clearanceStatus: statusFor("person", { clearanceValidatedAt: r.clearance_validated_at, clearanceRequested: r.clearance_requested }, days),
      notes: r.notes,
      active: Boolean(r.active),
      updatedAt: r.updated_at,
      values: values.get(r.id) || new Map()
    }));
  }

  function listPeople({ q = "", search = { columns: ["p.first_name", "p.last_name"], fieldIds: [] }, sites = null, siteId = null, companyId = null, includeInactive = false, updatedSince = null, limit = 500, offset = 0 } = {}) {
    const scope = personScope(sites, siteId);
    const where = [...scope.where];
    const params = [...scope.params];
    if (companyId) { where.push("p.company_id = ?"); params.push(companyId); }
    if (!includeInactive) where.push("p.active = 1 AND c.active = 1");
    if (updatedSince) { where.push("p.updated_at > ?"); params.push(updatedSince); }
    const s = searchClause(q, search, "person", "p.id");
    if (s.sql) { where.push(s.sql); params.push(...s.params); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = raw.prepare(`SELECT count(*) AS n FROM people p JOIN companies c ON c.id = p.company_id ${clause}`).get(...params).n;
    const rows = raw.prepare(`${PERSON_SELECT} ${clause} ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { records: personRecords(rows), total };
  }

  function getPerson(id, { sites = null } = {}) {
    const scope = personScope(sites, null);
    const row = raw.prepare(`${PERSON_SELECT} WHERE p.id = ?${scope.where.length ? ` AND ${scope.where.join(" AND ")}` : ""}`).get(id, ...scope.params);
    return row ? personRecords([row])[0] : null;
  }

  function cleanPerson(input, existing, callerSites) {
    const out = {};
    for (const [key, label] of [["firstName", "First name"], ["lastName", "Last name"]]) {
      if (input[key] !== undefined || !existing) {
        const v = text(input[key], 80);
        if (!v) throw fail(400, `${label} is required.`);
        out[key] = v;
      }
    }
    if (input.preferredName !== undefined) out.preferredName = text(input.preferredName, 80);
    if (input.jobTitle !== undefined) out.jobTitle = text(input.jobTitle, 120);
    if (input.email !== undefined) out.email = email(input.email);
    if (input.workPhone !== undefined) out.workPhone = text(input.workPhone, 40);
    if (input.mobile !== undefined) out.mobile = text(input.mobile, 40);
    if (input.canHost !== undefined) out.canHost = Boolean(input.canHost);
    if (input.clearanceLevel !== undefined) {
      const v = input.clearanceLevel;
      if (v === null || v === "") out.clearanceLevel = null;
      else if (!raw.prepare("SELECT 1 FROM clearance_levels WHERE id = ?").get(Number(v))) throw fail(400, "That clearance level doesn't exist.");
      else out.clearanceLevel = Number(v);
    }
    if (input.clearanceGranted !== undefined) out.clearanceGranted = cleanDate(input.clearanceGranted, "Clearance granted");
    if (input.clearanceExpires !== undefined) out.clearanceExpires = cleanDate(input.clearanceExpires, "Clearance expires");
    if (input.notes !== undefined) out.notes = longText(input.notes);
    if (input.active !== undefined) out.active = Boolean(input.active);

    if (input.companyId !== undefined || !existing) {
      const companyId = Number(input.companyId);
      if (!Number.isInteger(companyId) || companyId < 1) throw fail(400, "Choose the person's company.");
      if (!getCompany(companyId, { sites: callerSites })) throw fail(400, "That company does not exist, or is not at one of your sites.");
      out.companyId = companyId;
    }
    const companyId = out.companyId ?? existing?.companyId;
    if (input.siteId !== undefined || (out.companyId && existing && existing.siteId)) {
      const wanted = input.siteId !== undefined ? input.siteId : existing.siteId;
      if (wanted === null || wanted === "" || wanted === undefined) {
        if (callerSites) throw fail(400, "Choose which of your sites the person works at.");
        out.siteId = null;
      } else {
        const siteId = Number(wanted);
        const company = getCompany(companyId);
        if (!company.sites.some((s) => s.siteId === siteId)) {
          if (input.siteId !== undefined) throw fail(400, `${company.name} is not at that site.`);
          out.siteId = null; // moved to a company that isn't at the old site
        } else {
          if (callerSites && !callerSites.has(siteId)) throw fail(403, "This account can't place people at that site.");
          out.siteId = siteId;
        }
      }
    } else if (!existing && callerSites) {
      // A limited account must not create someone it then can't see: pin them to one of its sites.
      const company = getCompany(companyId);
      const mine = company.sites.filter((s) => callerSites.has(s.siteId));
      if (mine.length === 1) out.siteId = mine[0].siteId;
      else throw fail(400, "Choose which of your sites the person works at.");
    }
    return out;
  }

  function createPerson(input, { custom = new Map(), editable = [], callerSites = null } = {}) {
    const v = cleanPerson(input, null, callerSites);
    const values = customValues(custom, { creating: true, editable });
    const now = Date.now();
    let id;
    db.transaction(() => {
      id = raw.prepare(`INSERT INTO people (company_id, site_id, first_name, last_name, preferred_name, job_title, email, work_phone, mobile, can_host, notes,
        clearance_level_id, clearance_granted, clearance_expires, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.companyId, v.siteId ?? null, v.firstName, v.lastName, v.preferredName ?? null, v.jobTitle ?? null, v.email ?? null, v.workPhone ?? null, v.mobile ?? null, v.canHost === false ? 0 : 1, v.notes ?? null,
          v.clearanceLevel ?? null, v.clearanceGranted ?? null, v.clearanceExpires ?? null, v.active === false ? 0 : 1, now, now).lastInsertRowid;
      fields.writeValues(id, values);
    });
    return getPerson(id);
  }

  function updatePerson(id, input, { custom = new Map(), editable = [], callerSites = null } = {}) {
    const existing = getPerson(id, { sites: callerSites });
    if (!existing) throw fail(404, "No such person.");
    const v = cleanPerson(input, existing, callerSites);
    const values = customValues(custom, { editable, current: existing.values });
    const next = { ...existing, ...v };
    db.transaction(() => {
      raw.prepare(`UPDATE people SET company_id = ?, site_id = ?, first_name = ?, last_name = ?, preferred_name = ?, job_title = ?, email = ?, work_phone = ?, mobile = ?,
        can_host = ?, notes = ?, clearance_level_id = ?, clearance_granted = ?, clearance_expires = ?, active = ?, updated_at = ? WHERE id = ?`)
        .run(next.companyId, next.siteId ?? null, next.firstName, next.lastName, next.preferredName, next.jobTitle, next.email, next.workPhone, next.mobile, next.canHost ? 1 : 0, next.notes,
          next.clearanceLevel ?? null, next.clearanceGranted ?? null, next.clearanceExpires ?? null, next.active ? 1 : 0, Date.now(), id);
      fields.writeValues(id, values);
    });
    return getPerson(id);
  }

  function deletePerson(id) {
    const existing = getPerson(id);
    if (!existing) throw fail(404, "No such person.");
    db.transaction(() => {
      fields.forgetRecord("person", id);
      raw.prepare("UPDATE clearance_requests SET status = 'cancelled', resolved_at = ? WHERE holder_kind = 'person' AND holder_id = ? AND status = 'open'").run(Date.now(), id);
      raw.prepare("DELETE FROM people WHERE id = ?").run(id);
    });
    return existing;
  }

  /** The ids of every company and person `sites` may reach, active or not (for sync clients). */
  function visibleIds(sites = null) {
    const cs = companyScope(sites, null);
    const ps = personScope(sites, null);
    const where = (list) => (list.length ? ` WHERE ${list.join(" AND ")}` : "");
    return {
      companyIds: raw.prepare(`SELECT c.id FROM companies c${where(cs.where)} ORDER BY c.id`).all(...cs.params).map((r) => r.id),
      personIds: raw.prepare(`SELECT p.id FROM people p JOIN companies c ON c.id = p.company_id${where(ps.where)} ORDER BY p.id`).all(...ps.params).map((r) => r.id)
    };
  }

  /** A person already in `companyId` who looks like this one: same email, else same name. */
  function findPersonMatch(companyId, { email: mail, firstName, lastName }) {
    if (mail) {
      const r = raw.prepare("SELECT id FROM people WHERE company_id = ? AND email = ? COLLATE NOCASE").get(companyId, String(mail).trim().toLowerCase());
      if (r) return r.id;
    }
    const r = raw.prepare("SELECT id FROM people WHERE company_id = ? AND first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE").get(companyId, String(firstName || "").trim(), String(lastName || "").trim());
    return r ? r.id : null;
  }

  return {
    listCompanies,
    getCompany,
    findCompanyByName,
    createCompany,
    updateCompany,
    deleteCompany,
    listPeople,
    getPerson,
    createPerson,
    updatePerson,
    deletePerson,
    findPersonMatch,
    visibleIds
  };
}

module.exports = { createDirectory, searchClause, likeWord };
