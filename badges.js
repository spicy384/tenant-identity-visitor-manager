/**
 * Badges: their numbers, type and clearance level (none: Uncleared), and who has held each.
 *
 * Types: personnel badges go to people of companies marked "Building staff", tenant badges
 * to people of every other company, visitor badges to visitors. A badge with a clearance
 * level goes only to someone whose clearance (not expired) covers it (clearance.js). A badge
 * is held by one person at a time; every assignment is kept, with when, by whom and how it
 * ended (returned or lost). Visitor badges stay out until someone marks them returned.
 *
 * A badge is valid at the sites listed for it, or at every site when none are; anyone may
 * be given a badge whatever site they work at. Staff limited to some sites see the badges
 * valid at any of their sites.
 *
 * Lending a badge for the day, to a person who forgot theirs: a badge marked temporary (a
 * stock kept at the desk, of the type they'd wear), or any visitor badge. A visitor badge
 * given to a person is always such a loan. The loan stands in for the badge they hold, when
 * one is on record, and is due back by the end of that day (midnight where they work); one
 * loan at a time. Overdue ones are listed until someone takes them back.
 */
const { zonedTime, localParts } = require("./visit-clock");
const { today, cleanDate } = require("./clearance");
const TYPES = ["personnel", "tenant", "visitor"];
const TYPE_LABELS = { personnel: "Personnel", tenant: "Tenant", visitor: "Visitor" };
const STATUSES = ["active", "lost", "retired"];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const inList = (ids) => ids.map(() => "?").join(",");

// A badge's facility code: 2 or 3 digits (CCURE 9000), optional.
const FACILITY_CODE_RE = /^\d{2,3}$/;

/** How a badge is written for people: its facility code and number ("101-12345"), or the number alone. */
const badgeLabel = (facilityCode, number) => (facilityCode ? `${facilityCode}-${number}` : number);

// The note on a badge recorded for a visit after it ended.
const RECORDED_NOTE = "Recorded after the visit";

function createBadges({ db, clearance, now = Date.now }) {
  const raw = db.raw;

  // --- reading ----------------------------------------------------------------------------

  const SELECT = `SELECT b.*, l.name AS level_name, l.rank AS level_rank,
      (SELECT json_group_array(json_object('id', s.id, 'name', s.name)) FROM badge_sites bs JOIN sites s ON s.id = bs.site_id WHERE bs.badge_id = b.id) AS sites_json,
      a.id AS a_id, a.holder_kind, a.holder_id, a.holder_name, a.holder_company, a.visit_id, a.assigned_at, a.assigned_by,
      a.temporary AS a_temporary, a.due_at AS a_due_at, rb.number AS a_replaces_number, rb.facility_code AS a_replaces_code,
      (SELECT json_object('id', rv.id, 'name', rv.first_name || ' ' || rv.last_name) FROM visitors rv WHERE rv.reserved_badge_id = b.id) AS reserved_json
    FROM badges b
    LEFT JOIN clearance_levels l ON l.id = b.clearance_level_id
    LEFT JOIN badge_assignments a ON a.badge_id = b.id AND a.returned_at IS NULL
    LEFT JOIN badges rb ON rb.id = a.replaces_badge_id`;

  function row(r) {
    if (!r) return null;
    return {
      id: r.id,
      number: r.number,
      facilityCode: r.facility_code ?? null,
      label: badgeLabel(r.facility_code, r.number),
      type: r.type,
      clearanceLevelId: r.clearance_level_id,
      clearanceLevelName: r.level_name,
      // [] means every site.
      sites: JSON.parse(r.sites_json || "[]").sort((x, y) => x.name.localeCompare(y.name)),
      temporary: Boolean(r.temporary),
      // Good through this day (YYYY-MM-DD); after it the badge can't be given out.
      expiresOn: r.expires_on || null,
      expired: Boolean(r.expires_on && r.expires_on < today(undefined, now())),
      status: r.status,
      notes: r.notes,
      // The visitor this badge is kept for, if any (handed to them at each check-in).
      reservedFor: r.reserved_json ? JSON.parse(r.reserved_json) : null,
      holder: r.a_id ? {
        assignmentId: r.a_id, kind: r.holder_kind, id: r.holder_id, name: r.holder_name, company: r.holder_company, visitId: r.visit_id, assignedAt: r.assigned_at, assignedBy: r.assigned_by,
        temporary: Boolean(r.a_temporary), dueAt: r.a_due_at ?? null, replacesNumber: r.a_replaces_number ? badgeLabel(r.a_replaces_code, r.a_replaces_number) : null, overdue: Boolean(r.a_temporary && r.a_due_at && r.a_due_at < now())
      } : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  /** SQL (alias b) for badges valid at any of `ids`: those listing one of them, and those valid everywhere. */
  function validAt(ids) {
    return {
      sql: `(NOT EXISTS (SELECT 1 FROM badge_sites x WHERE x.badge_id = b.id)${ids.length ? ` OR EXISTS (SELECT 1 FROM badge_sites x WHERE x.badge_id = b.id AND x.site_id IN (${inList(ids)}))` : ""})`,
      params: ids
    };
  }

  /** SQL (alias b) limiting badges to `sites` (a Set), or nothing when unlimited. */
  function scope(sites) {
    return sites ? validAt([...sites]) : { sql: "", params: [] };
  }

  /**
   * Badges the caller may see. state: "available" (active, not held), "assigned", "lost",
   * "retired", "left" (visitor badges still out with visitors who have no open visit),
   * "temporary" (temporary badges out), "overdue" (temporary badges not back by their time).
   * temporary: true or false limits to temporary or regular badges.
   */
  function list({ q = "", type = null, state = null, expiringDays = 30, levelId = null, siteId = null, sites = null, temporary = null, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    const sc = scope(sites);
    if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
    if (TYPES.includes(type)) { where.push("b.type = ?"); params.push(type); }
    // "people": the badges people (not visitors) wear, personnel and tenant.
    if (type === "people") where.push("b.type IN ('personnel', 'tenant')");
    // levelId "none": Uncleared badges.
    if (levelId === "none") where.push("b.clearance_level_id IS NULL");
    else if (levelId) { where.push("b.clearance_level_id = ?"); params.push(levelId); }
    if (siteId) { const v = validAt([siteId]); where.push(v.sql); params.push(...v.params); }
    if (state === "available") where.push("b.status = 'active' AND a.id IS NULL");
    if (state === "assigned") where.push("a.id IS NOT NULL");
    if (state === "lost" || state === "retired") { where.push("b.status = ?"); params.push(state); }
    if (state === "left") where.push("a.holder_kind = 'visitor' AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.visitor_id = a.holder_id AND x.checked_out_at IS NULL)");
    if (state === "temporary") where.push("a.id IS NOT NULL AND a.temporary = 1");
    if (state === "overdue") { where.push("a.id IS NOT NULL AND a.temporary = 1 AND a.due_at < ?"); params.push(now()); }
    if (temporary !== null) { where.push("b.temporary = ?"); params.push(temporary ? 1 : 0); }
    // "expiring": good for `expiringDays` more days at most; "expired": past its date. Retired badges aren't counted.
    if (state === "expiring") {
      where.push("b.status <> 'retired' AND b.expires_on IS NOT NULL AND b.expires_on >= ? AND b.expires_on <= ?");
      params.push(today(undefined, now()), today(undefined, now() + expiringDays * 86400000));
    }
    if (state === "expired") { where.push("b.status <> 'retired' AND b.expires_on IS NOT NULL AND b.expires_on < ?"); params.push(today(undefined, now())); }
    for (const word of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const p = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      // The number, the facility code, or both as written ("101-12345").
      where.push("(b.number LIKE ? ESCAPE '\\' OR coalesce(b.facility_code, '') LIKE ? ESCAPE '\\' OR (coalesce(b.facility_code || '-', '') || b.number) LIKE ? ESCAPE '\\' OR coalesce(a.holder_name, '') LIKE ? ESCAPE '\\' OR coalesce(a.holder_company, '') LIKE ? ESCAPE '\\' OR coalesce(b.notes, '') LIKE ? ESCAPE '\\')");
      params.push(p, p, p, p, p, p);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = raw.prepare(`SELECT count(*) AS n FROM badges b LEFT JOIN badge_assignments a ON a.badge_id = b.id AND a.returned_at IS NULL ${clause}`).get(...params).n;
    const rows = raw.prepare(`${SELECT} ${clause} ORDER BY b.number COLLATE NOCASE, coalesce(b.facility_code, '') LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { badges: rows.map(row), total };
  }

  function get(id, { sites = null } = {}) {
    const sc = scope(sites);
    return row(raw.prepare(`${SELECT} WHERE b.id = ?${sc.sql ? ` AND ${sc.sql}` : ""}`).get(Number(id), ...sc.params));
  }

  function history(badgeId, limit = 200) {
    return raw.prepare("SELECT a.*, rb.number AS replaces_number, rb.facility_code AS replaces_code FROM badge_assignments a LEFT JOIN badges rb ON rb.id = a.replaces_badge_id WHERE a.badge_id = ? ORDER BY a.assigned_at DESC, a.id DESC LIMIT ?").all(badgeId, limit).map(assignmentRow);
  }

  function assignmentRow(r) {
    return {
      id: r.id,
      badgeId: r.badge_id,
      badgeNumber: r.number ?? undefined,
      badgeFacilityCode: r.number !== undefined ? r.facility_code ?? null : undefined,
      badgeLabel: r.number !== undefined ? badgeLabel(r.facility_code, r.number) : undefined,
      badgeType: r.type ?? undefined,
      kind: r.holder_kind,
      holderId: r.holder_id,
      holderName: r.holder_name,
      holderCompany: r.holder_company,
      visitId: r.visit_id,
      assignedAt: r.assigned_at,
      assignedBy: r.assigned_by,
      returnedAt: r.returned_at,
      returnedBy: r.returned_by,
      outcome: r.outcome,
      note: r.note,
      temporary: Boolean(r.temporary),
      dueAt: r.due_at ?? null,
      replacesNumber: r.replaces_number ? badgeLabel(r.replaces_code, r.replaces_number) : null,
      overdue: Boolean(r.temporary && !r.returned_at && r.due_at && r.due_at < now())
    };
  }

  /** A holder's badges, held now and before. kind: "person" or "visitor". */
  function forHolder(kind, holderId, limit = 100) {
    return raw.prepare(`SELECT a.*, b.number, b.facility_code, b.type, rb.number AS replaces_number, rb.facility_code AS replaces_code FROM badge_assignments a JOIN badges b ON b.id = a.badge_id LEFT JOIN badges rb ON rb.id = a.replaces_badge_id
      WHERE a.holder_kind = ? AND a.holder_id = ? ORDER BY a.returned_at IS NOT NULL, a.assigned_at DESC LIMIT ?`).all(kind, holderId, limit).map(assignmentRow);
  }

  /** The badges each of these people holds now: Map(personId -> [{ id, label, temporary }]), theirs before any lent for the day. */
  function heldByPeople(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const rows = raw.prepare(`SELECT a.holder_id, a.temporary, b.id, b.number, b.facility_code FROM badge_assignments a JOIN badges b ON b.id = a.badge_id
      WHERE a.holder_kind = 'person' AND a.returned_at IS NULL AND a.holder_id IN (${inList(ids)}) ORDER BY a.temporary, a.assigned_at`).all(...ids);
    for (const r of rows) {
      if (!out.has(r.holder_id)) out.set(r.holder_id, []);
      out.get(r.holder_id).push({ id: r.id, label: badgeLabel(r.facility_code, r.number), temporary: Boolean(r.temporary) });
    }
    return out;
  }

  function openForHolder(kind, holderId) {
    return raw.prepare("SELECT b.number, b.facility_code FROM badge_assignments a JOIN badges b ON b.id = a.badge_id WHERE a.holder_kind = ? AND a.holder_id = ? AND a.returned_at IS NULL").all(kind, holderId).map((r) => badgeLabel(r.facility_code, r.number));
  }

  // --- writing badges ------------------------------------------------------------------------

  function clean(input, existing = null) {
    const out = {};
    if (input.number !== undefined || !existing) {
      const number = String(input.number ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (!number) throw fail(400, "Give the badge a number.");
      out.number = number;
    }
    if (input.facilityCode !== undefined) {
      const code = String(input.facilityCode ?? "").trim();
      if (code && !FACILITY_CODE_RE.test(code)) throw fail(400, `The facility code is 2 or 3 digits, not "${code}".`);
      out.facilityCode = code || null;
    }
    // A number is unique within its facility code.
    if (out.number !== undefined || out.facilityCode !== undefined) {
      const number = out.number ?? existing.number;
      const code = out.facilityCode !== undefined ? out.facilityCode : existing?.facilityCode ?? null;
      const clash = raw.prepare("SELECT id FROM badges WHERE number = ? AND ifnull(facility_code, '') = ?").get(number, code || "");
      if (clash && clash.id !== existing?.id) throw fail(409, `There is already a badge ${badgeLabel(code, number)}${code ? "" : " without a facility code"}.`);
    }
    if (input.type !== undefined || !existing) {
      if (!TYPES.includes(input.type)) throw fail(400, `The badge type must be one of: ${TYPES.join(", ")}.`);
      out.type = input.type;
    }
    // The clearance level: null (or left out on a new badge) is Uncleared.
    if (input.clearanceLevelId !== undefined) out.clearanceLevelId = clearance.cleanLevelId(input.clearanceLevelId);
    // The sites it is valid at: null or [] for every site.
    if (input.siteIds !== undefined) {
      if (input.siteIds !== null && !Array.isArray(input.siteIds)) throw fail(400, "Sites must be a list of site ids, or none for every site.");
      const ids = [...new Set((input.siteIds || []).map(Number))];
      for (const id of ids) if (!Number.isInteger(id) || !raw.prepare("SELECT 1 FROM sites WHERE id = ?").get(id)) throw fail(400, "One of the chosen sites doesn't exist.");
      out.siteIds = ids;
    }
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status)) throw fail(400, `The badge status must be one of: ${STATUSES.join(", ")}.`);
      out.status = input.status;
    }
    if (input.notes !== undefined) out.notes = String(input.notes ?? "").trim().slice(0, 1000) || null;
    if (input.temporary !== undefined) out.temporary = Boolean(input.temporary);
    if (input.expiresOn !== undefined) out.expiresOn = cleanDate(input.expiresOn, "The expiry date");
    if ((out.temporary ?? existing?.temporary) && (out.type ?? existing?.type) === "visitor") throw fail(400, "Temporary badges stand in for a person's own badge; visitors get visitor badges.");
    return out;
  }

  /**
   * The site list after a change by a caller limited to `sites`: they set which of their own
   * sites it is valid at, sites outside their limit stay as they were, and the badge must
   * stay valid at one of theirs (else they couldn't see it). Unlimited callers set it outright.
   */
  function mergeSites(wanted, current, sites) {
    if (!sites) return wanted;
    if (wanted.some((id) => !sites.has(id))) throw fail(403, "This account can only make a badge valid at its own sites.");
    const kept = current.filter((id) => !sites.has(id));
    if (!wanted.length) {
      if (!current.length && !kept.length) throw fail(403, "Choose which of your sites the badge is valid at; only an account that sees every site can make one valid everywhere.");
      if (!kept.length) throw fail(403, "Choose which of your sites the badge is valid at.");
    }
    return [...new Set([...wanted, ...kept])];
  }

  function writeSites(badgeId, ids) {
    raw.prepare("DELETE FROM badge_sites WHERE badge_id = ?").run(badgeId);
    const put = raw.prepare("INSERT INTO badge_sites (badge_id, site_id) VALUES (?, ?)");
    for (const id of ids) put.run(badgeId, id);
  }

  function create(input, { sites = null } = {}) {
    const v = clean(input);
    const siteIds = mergeSites(v.siteIds || [], [], sites);
    const t = now();
    let id;
    db.transaction(() => {
      id = raw.prepare(`INSERT INTO badges (number, facility_code, type, clearance_level_id, temporary, expires_on, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.number, v.facilityCode ?? null, v.type, v.clearanceLevelId ?? null, v.temporary ? 1 : 0, v.expiresOn ?? null, v.status || "active", v.notes ?? null, t, t).lastInsertRowid;
      writeSites(id, siteIds);
    });
    return get(id);
  }

  /**
   * Adds a run of badges: prefix + numbers from..to, zero-padded to `width` (B-0001..B-0050),
   * all with the same facility code (if any).
   * All or nothing; at most 1,000 at once.
   */
  function createRange({ prefix = "", from, to, width = 0, ...common }, { sites = null } = {}) {
    const a = Number(from);
    const b = Number(to);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a) throw fail(400, "Give a range of whole numbers, from the lower to the higher.");
    if (b - a >= 1000) throw fail(400, "Add at most 1,000 badges at once.");
    const pad = Math.min(Math.max(Number(width) || 0, 0), 12);
    const made = [];
    db.transaction(() => {
      for (let n = a; n <= b; n += 1) made.push(create({ ...common, number: `${String(prefix || "").trim()}${String(n).padStart(pad, "0")}` }, { sites }));
    });
    return made;
  }

  /**
   * `security`: the caller has the Security role, which alone may change the clearance level of
   * a badge while a person holds it (never a visitor, never a visitor badge), and only to a
   * level that person's clearance covers.
   */
  function update(id, input, { sites = null, security = false } = {}) {
    const existing = get(id, { sites });
    if (!existing) throw fail(404, "No such badge.");
    const v = clean(input, existing);
    const siteIds = v.siteIds !== undefined ? mergeSites(v.siteIds, existing.sites.map((x) => x.id), sites) : null;
    if (existing.holder) {
      const relevel = v.clearanceLevelId !== undefined && v.clearanceLevelId !== existing.clearanceLevelId;
      const withPerson = existing.holder.kind === "person" && existing.type !== "visitor";
      if ((v.type && v.type !== existing.type) || (v.temporary !== undefined && v.temporary !== existing.temporary) || (relevel && !withPerson)) {
        throw fail(409, `${existing.holder.name} holds this badge; take it back before changing its type, clearance level or whether it is temporary.`);
      }
      if (relevel && !security) throw fail(409, `${existing.holder.name} holds this badge; only the Security role changes its clearance level while it is out.`);
      if (relevel) {
        const why = clearanceRefusal({ ...existing, clearanceLevelId: v.clearanceLevelId }, holder("person", existing.holder.id));
        if (why) throw fail(409, `${why} Validate their clearance first, or take the badge back.`);
      }
      if (v.status && v.status !== "active") throw fail(409, `${existing.holder.name} holds this badge; mark it returned or lost instead.`);
    }
    const next = { ...existing, ...v };
    db.transaction(() => {
      raw.prepare("UPDATE badges SET number = ?, facility_code = ?, type = ?, clearance_level_id = ?, temporary = ?, expires_on = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?")
        .run(next.number, next.facilityCode ?? null, next.type, next.clearanceLevelId ?? null, next.temporary ? 1 : 0, next.expiresOn ?? null, next.status, next.notes ?? null, now(), id);
      if (siteIds) writeSites(id, siteIds);
    });
    return get(id);
  }

  /** Deletes a badge nobody has ever held; one with history should be retired instead. */
  function remove(id, { sites = null } = {}) {
    const existing = get(id, { sites });
    if (!existing) throw fail(404, "No such badge.");
    if (raw.prepare("SELECT 1 FROM badge_assignments WHERE badge_id = ?").get(id)) throw fail(409, `Badge ${existing.label} has been assigned before; retire it instead, so its history stays.`);
    raw.prepare("DELETE FROM badges WHERE id = ?").run(id);
    return existing;
  }

  // --- a badge's level following its holder's clearance -------------------------------------------

  // A person's own badge that is out: never a visitor badge, nor one lent for the day.
  const OWN_BADGES = `FROM badge_assignments a JOIN badges b ON b.id = a.badge_id JOIN people p ON p.id = a.holder_id
    LEFT JOIN clearance_levels l ON l.id = b.clearance_level_id
    WHERE a.holder_kind = 'person' AND a.returned_at IS NULL AND a.temporary = 0 AND b.temporary = 0 AND b.type <> 'visitor'`;

  /**
   * The badges these people hold as their own whose clearance level isn't the one their holder
   * has on record: for Security to bring into line once it has validated the clearance. Each is
   * { id, label, type, levelName, holderId, holderName }.
   */
  function outOfStep(personIds) {
    const ids = [...new Set(personIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    return raw.prepare(`SELECT b.id, b.number, b.facility_code, b.type, l.name AS level_name, p.id AS holder_id, p.first_name, p.last_name ${OWN_BADGES}
      AND p.id IN (${inList(ids)}) AND b.clearance_level_id IS NOT p.clearance_level_id ORDER BY p.last_name, p.first_name, a.assigned_at`).all(...ids)
      .map((r) => ({ id: r.id, label: badgeLabel(r.facility_code, r.number), type: r.type, levelName: r.level_name || null, holderId: r.holder_id, holderName: `${r.first_name} ${r.last_name}` }));
  }

  /**
   * Sets badges to the clearance their holder has on record, while they are out: for Security
   * once it has validated that clearance (update() is the other way, a level it chooses). Only a person's
   * own badge, held by someone `canSee` allows and whose clearance is validated; all or nothing.
   * Returns those changed, each { id, label, holderName, from, to } (level names, null for none).
   */
  function matchHolderLevel(badgeIds, { canSee = () => true } = {}) {
    const ids = [...new Set(badgeIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw fail(400, "Choose at least one badge.");
    const rows = raw.prepare(`SELECT b.id, b.number, b.facility_code, b.clearance_level_id, l.name AS level_name, p.id AS holder_id, p.first_name, p.last_name,
      p.clearance_level_id AS holder_level, p.clearance_validated_at ${OWN_BADGES} AND b.id IN (${inList(ids)})`).all(...ids);
    if (rows.length !== ids.length || rows.some((r) => !canSee(r.holder_id))) {
      throw fail(404, "One of those isn't a person's own badge that is out. A visitor badge, or one lent for the day, keeps its level.");
    }
    const unvalidated = rows.find((r) => !r.clearance_validated_at);
    if (unvalidated) throw fail(409, `${unvalidated.first_name} ${unvalidated.last_name}'s clearance hasn't been validated, so their badge keeps its level.`);
    const changed = [];
    db.transaction(() => {
      for (const r of rows) {
        if (r.clearance_level_id === r.holder_level) continue;
        raw.prepare("UPDATE badges SET clearance_level_id = ?, updated_at = ? WHERE id = ?").run(r.holder_level, now(), r.id);
        changed.push({ id: r.id, label: badgeLabel(r.facility_code, r.number), holderName: `${r.first_name} ${r.last_name}`, from: r.level_name || null, to: r.holder_level ? clearance.level(r.holder_level)?.name ?? null : null });
      }
    });
    return changed;
  }

  // --- who may hold what ----------------------------------------------------------------------

  /** Whether giving `badge` to `h` lends it for the day: a temporary badge, or a visitor badge to a person. */
  const isLoan = (badge, h) => h.kind === "person" && (badge.temporary || badge.type === "visitor");

  /** A holder as the rules need it: name, company, building staff, clearance, active. */
  function holder(kind, id) {
    if (kind === "person") {
      const p = raw.prepare(`SELECT p.*, c.name AS company_name, c.building_staff, c.active AS company_active FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`).get(Number(id));
      if (!p) return null;
      // The badges they hold: their own (to stand in for) and any temporary one already out.
      const held = raw.prepare(`SELECT b.id, b.number, b.facility_code, a.temporary FROM badge_assignments a JOIN badges b ON b.id = a.badge_id
        WHERE a.holder_kind = 'person' AND a.holder_id = ? AND a.returned_at IS NULL ORDER BY a.assigned_at`).all(p.id);
      // Where they work, for the end of their day: their site, else their company's first.
      const tz = raw.prepare(`SELECT s.time_zone FROM sites s WHERE s.id = coalesce(?, (SELECT site_id FROM company_sites WHERE company_id = ? ORDER BY site_id LIMIT 1))`).get(p.site_id, p.company_id)?.time_zone;
      return {
        kind, id: p.id, name: `${p.preferred_name || p.first_name} ${p.last_name}`, company: p.company_name,
        buildingStaff: Boolean(p.building_staff), active: Boolean(p.active && p.company_active),
        clearanceLevelId: p.clearance_level_id, clearanceValidatedAt: p.clearance_validated_at,
        regular: held.filter((x) => !x.temporary), temporaryOut: held.filter((x) => x.temporary), timeZone: tz || null
      };
    }
    if (kind === "visitor") {
      const v = raw.prepare("SELECT * FROM visitors WHERE id = ?").get(Number(id));
      return v && {
        kind, id: v.id, name: `${v.first_name} ${v.last_name}`, company: v.organization, buildingStaff: false, active: true, blocked: Boolean(v.blocked),
        clearanceLevelId: v.clearance_level_id, clearanceValidatedAt: v.clearance_validated_at
      };
    }
    return null;
  }

  /** Why `h`'s clearance doesn't cover `badge`, or null when it does. Without `levelNames` the reason never names the level. */
  function clearanceRefusal(badge, h, { levelNames = true } = {}) {
    if (!badge.clearanceLevelId) return null;
    const needed = clearance.level(badge.clearanceLevelId);
    if (clearance.covers(clearance.effectiveLevel(h), needed)) return null;
    const why = clearance.notCounting(h);
    const level = levelNames ? ` (${needed.name})` : "";
    return why ? `${h.name}'s clearance ${why}, so it doesn't cover badge ${badge.label}${level}.` : `${h.name}'s clearance doesn't cover badge ${badge.label}${level}.`;
  }

  /**
   * Why `h` can't hold `badge`, or null when they can. Without `levelNames` (staff who don't see
   * clearance levels) the reason never names the level.
   */
  function refusal(badge, h, { levelNames = true } = {}) {
    if (badge.status !== "active") return `Badge ${badge.label} is ${badge.status}.`;
    if (badge.expired) return `Badge ${badge.label} expired on ${badge.expiresOn}; give another, or change its expiry date.`;
    if (badge.type !== "visitor" && h.kind === "visitor") return `Badge ${badge.label} is a ${TYPE_LABELS[badge.type].toLowerCase()} badge; visitors get visitor badges.`;
    if (badge.type === "personnel" && !h.buildingStaff) return `Badge ${badge.label} is a personnel badge, for building staff; ${h.company} isn't marked as building staff.`;
    if (badge.type === "tenant" && h.buildingStaff) return `Badge ${badge.label} is a tenant badge; ${h.name} is building staff and gets a personnel badge.`;
    if (badge.reservedFor && !(h.kind === "visitor" && h.id === badge.reservedFor.id)) return `Badge ${badge.label} is reserved for ${badge.reservedFor.name}.`;
    if (!h.active) return `${h.name} is inactive.`;
    if (h.blocked) return `${h.name} is blocked.`;
    if (badge.temporary && h.kind !== "person") return `Badge ${badge.label} is temporary, for people who forgot their own; visitors get visitor badges.`;
    if (isLoan(badge, h) && h.temporaryOut.length) return `${h.name} already has badge ${badgeLabel(h.temporaryOut[0].facility_code, h.temporaryOut[0].number)} for the day; take it back first.`;
    return clearanceRefusal(badge, h, { levelNames });
  }

  /**
   * Whether a badge is one to offer `h`. A visitor is offered only the badges at their own
   * clearance level: the level Security validated, or uncleared badges while their clearance
   * doesn't count. They may still hold a lower one (refusal decides that), given by its number.
   */
  function offered(h) {
    if (h.kind !== "visitor") return () => true;
    const own = clearance.effectiveLevel(h)?.id ?? null;
    return (b) => (b.clearanceLevelId ?? null) === own;
  }

  /**
   * Active, unheld badges `h` may be given, among those `sites` sees: their own kind, or with
   * `temporary` (a person only) the ones they may borrow for the day, the temporary stock of
   * their kind first, then visitor badges. For a visitor, only those at their own clearance level.
   */
  function availableFor(kind, holderId, { sites = null, temporary = false } = {}) {
    const h = holder(kind, holderId);
    if (!h) throw fail(404, "No such person or visitor.");
    const own = kind === "visitor" ? "visitor" : h.buildingStaff ? "personnel" : "tenant";
    const found = list({ state: "available", type: own, temporary: kind === "visitor" ? null : temporary, sites, limit: 5000 }).badges;
    if (temporary && kind === "person") found.push(...list({ state: "available", type: "visitor", sites, limit: 5000 }).badges);
    return found.filter((b) => !refusal(b, h)).filter(offered(h));
  }

  /**
   * The visitor badges a visitor may be given at an event still to come on `day`, among those
   * `sites` sees: those out now count, being due back by then, but not one whose expiry comes
   * before that day. Only those at their own clearance level, as in availableFor.
   */
  function availableLater(visitorId, day, { sites = null } = {}) {
    const h = holder("visitor", visitorId);
    if (!h) throw fail(404, "No such person or visitor.");
    return list({ type: "visitor", sites, limit: 5000 }).badges.filter((b) => !refusal(b, h) && !(b.expiresOn && b.expiresOn < day)).filter(offered(h));
  }

  /** Midnight at the end of today where `timeZone` is (or the server's), as a timestamp. */
  function endOfToday(timeZone) {
    const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const p = localParts(now(), tz);
    return zonedTime(p.year, p.month, p.day + 1, 0, 0, tz);
  }

  /** Gives a badge to a person or visitor; refuses one they may not hold. */
  function assign(badgeId, { kind, holderId, visitId = null, replacesBadgeId = null }, { by = null, sites = null, levelNames = true } = {}) {
    const badge = get(badgeId, { sites });
    if (!badge) throw fail(404, "No such badge.");
    if (badge.holder) throw fail(409, `Badge ${badge.label} is with ${badge.holder.name}; take it back first.`);
    const h = holder(kind, holderId);
    if (!h) throw fail(404, "No such person or visitor.");
    const why = refusal(badge, h, { levelNames });
    if (why) throw fail(409, why);
    if (visitId && !raw.prepare("SELECT 1 FROM visits WHERE id = ? AND visitor_id = ?").get(visitId, h.id)) throw fail(400, "That visit isn't the visitor's.");
    // A visitor's badge goes with the visit they're on now, however it was given (only recorded:
    // their check-in isn't finished by it).
    const onVisit = visitId || (kind === "visitor" ? raw.prepare("SELECT id FROM visits WHERE visitor_id = ? AND checked_out_at IS NULL ORDER BY checked_in_at DESC LIMIT 1").get(h.id)?.id ?? null : null);
    let replaces = null;
    let dueAt = null;
    const loan = isLoan(badge, h);
    if (loan) {
      // Stands in for the badge they forgot: the one named, else their first (if one is on record).
      replaces = replacesBadgeId ? h.regular.find((x) => x.id === Number(replacesBadgeId)) : h.regular[0] || null;
      if (replacesBadgeId && !replaces) throw fail(400, `${h.name} doesn't hold that badge.`);
      dueAt = endOfToday(h.timeZone);
    }
    db.transaction(() => {
      raw.prepare(`INSERT INTO badge_assignments (badge_id, holder_kind, holder_id, holder_name, holder_company, visit_id, assigned_at, assigned_by, temporary, replaces_badge_id, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(badge.id, kind, h.id, h.name, h.company || null, onVisit, now(), by, loan ? 1 : 0, replaces ? replaces.id : null, dueAt);
      // A visitor waiting for a badge has one now: their check-in is done.
      if (kind === "visitor") {
        if (visitId) raw.prepare("UPDATE visits SET checkin_stage = 'done' WHERE id = ? AND checkin_stage IN ('id', 'badge')").run(visitId);
        raw.prepare("UPDATE visits SET checkin_stage = 'done' WHERE visitor_id = ? AND checked_out_at IS NULL AND checkin_stage = 'badge'").run(h.id);
      }
    });
    return get(badge.id);
  }

  /**
   * Records the visitor badge a visitor had on a visit that has ended, when it wasn't recorded
   * at the time: held from their arrival to when they left, and back. Refused when the visit
   * has a badge already, or the badge was with someone else at any time during it.
   */
  function recordForVisit(badgeId, visitId, { by = null, sites = null } = {}) {
    const badge = get(badgeId, { sites });
    if (!badge) throw fail(404, "No such badge.");
    if (badge.type !== "visitor") throw fail(400, `Badge ${badge.label} is a ${TYPE_LABELS[badge.type].toLowerCase()} badge; visitors get visitor badges.`);
    const visit = raw.prepare(`SELECT x.id, x.visitor_id, x.checked_in_at, x.checked_out_at, v.first_name, v.last_name, v.organization
      FROM visits x JOIN visitors v ON v.id = x.visitor_id WHERE x.id = ?`).get(Number(visitId));
    if (!visit) throw fail(404, "No such visit.");
    if (!visit.checked_out_at) throw fail(409, "They're still here: give them the badge instead.");
    if (raw.prepare("SELECT 1 FROM badge_assignments WHERE visit_id = ?").get(visit.id)) throw fail(409, "This visit has a badge recorded already.");
    const clash = raw.prepare(`SELECT holder_kind, holder_id, holder_name, assigned_at, returned_at FROM badge_assignments
      WHERE badge_id = ? AND assigned_at < ? AND (returned_at IS NULL OR returned_at > ?) ORDER BY assigned_at LIMIT 1`).get(badge.id, visit.checked_out_at, visit.checked_in_at);
    // Still theirs from an earlier visit: recorded there already.
    if (clash && clash.holder_kind === "visitor" && clash.holder_id === visit.visitor_id) throw fail(409, `${clash.holder_name} had badge ${badge.label} then already: it was given to them on an earlier visit${clash.returned_at ? "" : " and hasn't been taken back"}.`);
    if (clash) throw fail(409, `Badge ${badge.label} was with ${clash.holder_name} then, so it can't have been this visitor's. Check the number.`);
    raw.prepare(`INSERT INTO badge_assignments (badge_id, holder_kind, holder_id, holder_name, holder_company, visit_id, assigned_at, assigned_by, returned_at, returned_by, outcome, note)
      VALUES (?, 'visitor', ?, ?, ?, ?, ?, ?, ?, ?, 'returned', ?)`)
      .run(badge.id, visit.visitor_id, `${visit.first_name} ${visit.last_name}`, visit.organization || null, visit.id, visit.checked_in_at, by, visit.checked_out_at, by, RECORDED_NOTE);
    return badge;
  }

  /**
   * The badges a visitor still has as `visit` ends, oldest first: [{ id, number, label }]. Theirs
   * now, but for one given with another visit they are still on (at another site).
   */
  function outForVisit(visit) {
    return raw.prepare(`SELECT b.id, b.number, b.facility_code FROM badge_assignments a JOIN badges b ON b.id = a.badge_id
      WHERE a.holder_kind = 'visitor' AND a.holder_id = ? AND a.returned_at IS NULL
        AND (a.visit_id IS NULL OR a.visit_id = ? OR NOT EXISTS (SELECT 1 FROM visits x WHERE x.id = a.visit_id AND x.checked_out_at IS NULL))
      ORDER BY a.assigned_at, a.id`).all(visit.visitorId, visit.id).map((r) => ({ id: r.id, number: r.number, label: badgeLabel(r.facility_code, r.number) }));
  }

  /** Takes a badge back. outcome "lost" also marks the badge lost. */
  function takeBack(badgeId, { outcome = "returned", note = null } = {}, { by = null, sites = null } = {}) {
    if (!["returned", "lost"].includes(outcome)) throw fail(400, "A badge comes back returned, or is lost.");
    const badge = get(badgeId, { sites });
    if (!badge) throw fail(404, "No such badge.");
    if (!badge.holder) throw fail(409, `Badge ${badge.label} isn't with anyone.`);
    db.transaction(() => {
      raw.prepare("UPDATE badge_assignments SET returned_at = ?, returned_by = ?, outcome = ?, note = ? WHERE id = ?")
        .run(now(), by, outcome, note ? String(note).slice(0, 500) : null, badge.holder.assignmentId);
      if (outcome === "lost") raw.prepare("UPDATE badges SET status = 'lost', updated_at = ? WHERE id = ?").run(now(), badge.id);
    });
    return { badge: get(badge.id), from: badge.holder };
  }

  /** How many visitor badges are still out with visitors who have left, per the caller's sites. */
  function leftCount(sites = null) {
    return list({ state: "left", sites, limit: 1 }).total;
  }

  /** Temporary badges not back by the end of the day they were lent, per the caller's sites. */
  function overdueCount(sites = null) {
    return list({ state: "overdue", sites, limit: 1 }).total;
  }

  // --- visits whose check-in the desk hasn't finished ------------------------------------------

  const WAITING_WHERE = "v.checked_out_at IS NULL AND v.checkin_stage IN ('id', 'badge')";

  /**
   * Visitors whose check-in the desk hasn't finished (most checked themselves in at a kiosk):
   * stage "id" waits for the desk to check their ID, "badge" for a badge. Oldest first, at the
   * sites `sites` covers (null for every site), or at `siteId` alone. Each leaves the list once
   * given a badge, checked out, or marked as needing none.
   */
  function waitingForBadge({ sites = null, siteId = null } = {}) {
    const where = [WAITING_WHERE];
    const params = [];
    if (sites) where.push(`v.site_id IN (${[...sites].map(Number).join(",") || "NULL"})`);
    if (siteId) { where.push("v.site_id = ?"); params.push(Number(siteId)); }
    return raw.prepare(`SELECT v.id, v.visitor_id, v.site_id, v.company_name, v.host_name, v.checked_in_at, v.checkin_stage, v.purpose, s.name AS site_name, k.name AS kiosk_name,
        p.first_name, p.last_name, p.organization, coalesce(v.visitor_type, p.visitor_type) AS visitor_type
      FROM visits v JOIN visitors p ON p.id = v.visitor_id JOIN sites s ON s.id = v.site_id LEFT JOIN kiosks k ON k.id = v.kiosk_id
      WHERE ${where.join(" AND ")} ORDER BY v.checked_in_at`).all(...params).map((r) => ({
      visitId: r.id,
      visitorId: r.visitor_id,
      name: `${r.first_name} ${r.last_name}`,
      organization: r.organization,
      siteId: r.site_id,
      siteName: r.site_name,
      kioskName: r.kiosk_name,
      companyName: r.company_name,
      hostName: r.host_name,
      purpose: r.purpose,
      visitorType: r.visitor_type || "Guest",
      stage: r.checkin_stage,
      checkedInAt: r.checked_in_at
    }));
  }

  /**
   * Staff say a visit needs no badge (an escort, a delivery): its check-in is done. Their ID is
   * checked first.
   */
  function waiveVisitBadge(visitId, { by = null, sites = null } = {}) {
    const v = raw.prepare(`SELECT v.id, v.site_id, v.checkin_stage, p.first_name, p.last_name FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ? AND ${WAITING_WHERE}`).get(Number(visitId));
    if (!v || (sites && !sites.has(v.site_id))) throw fail(404, "That visit isn't waiting for a badge.");
    if (v.checkin_stage === "id") throw fail(409, `Check ${v.first_name} ${v.last_name}'s ID first.`);
    raw.prepare("UPDATE visits SET badge_waived_at = ?, badge_waived_by = ?, checkin_stage = 'done' WHERE id = ?").run(now(), by, v.id);
    return { visitId: v.id, name: `${v.first_name} ${v.last_name}` };
  }

  /** The id of the badge with exactly this number and facility code (none for none), or null. */
  function findExact(number, facilityCode = null) {
    return raw.prepare("SELECT id FROM badges WHERE number = ? AND ifnull(facility_code, '') = ?")
      .get(String(number ?? "").trim().replace(/\s+/g, " "), String(facilityCode ?? "").trim())?.id ?? null;
  }

  /**
   * The badges a typed number could be (any case): with `facilityCode`, the one under that
   * code; without, every badge with that number, and the one the text names written with its
   * code ("101-12345" or "101 12345"). [{ id, label }], none when nothing matches.
   */
  function findByNumber(number, { facilityCode = null } = {}) {
    const typed = String(number ?? "").trim().replace(/\s+/g, " ");
    if (!typed) return [];
    const code = String(facilityCode ?? "").trim();
    const out = new Map();
    const add = (rows) => { for (const r of rows) out.set(r.id, { id: r.id, label: badgeLabel(r.facility_code, r.number) }); };
    if (code) {
      add(raw.prepare("SELECT id, number, facility_code FROM badges WHERE number = ? AND facility_code = ?").all(typed, code));
      return [...out.values()];
    }
    add(raw.prepare("SELECT id, number, facility_code FROM badges WHERE number = ?").all(typed));
    const written = /^(\d{2,3})[-\s:](.+)$/.exec(typed);
    if (written) add(raw.prepare("SELECT id, number, facility_code FROM badges WHERE number = ? AND facility_code = ?").all(written[2].trim(), written[1]));
    return [...out.values()];
  }

  return { list, get, history, forHolder, openForHolder, heldByPeople, outOfStep, matchHolderLevel, create, createRange, update, remove, holder, refusal, clearanceRefusal, availableFor, availableLater, assign, recordForVisit, takeBack, outForVisit, leftCount, overdueCount, waitingForBadge, waiveVisitBadge, findByNumber, findExact };
}

module.exports = { createBadges, TYPES, TYPE_LABELS, STATUSES, FACILITY_CODE_RE, badgeLabel, RECORDED_NOTE };
