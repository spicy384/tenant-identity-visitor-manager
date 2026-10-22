/**
 * Facilities: each site's floors, each with a floor plan image and the offices drawn on it,
 * which company has each office and when, and what it costs.
 *
 * An office's outline is a list of points, [x, y] in fractions of its floor plan (x across,
 * y down), so it stays in place whatever size the plan is shown at; x, y, w, h keep the box
 * around it. A floor's scale says how many feet the plan's full width spans, set from a line
 * of known length drawn on it; with it, each office's area is measured from its outline (a
 * suggestion: the size in square feet is what staff enter). Dates are calendar days (YYYY-MM-DD) at the floor's
 * site, and an assignment's end date is its last day; with no end date it runs on. An
 * office has at most one company on any day, so assignments never overlap, and ended ones
 * stay as its history.
 *
 * Each room has a type (Office, Conference Room, Storage, ...: an editable list, each with a
 * color for the plan) and is unclassified or classified with a subcategory (SCAR, SCIF, ...:
 * also editable, with colors). Only rooms of a type that is assigned to companies can be; the
 * others show as "shared", with no rent.
 *
 * Rates are per square foot per month. A company's own rate wins; otherwise the office's,
 * otherwise its site's default. An office's monthly cost is its square feet times that rate.
 *
 * Plans are PNG or JPEG, checked by their first bytes. Each has a random `ref` that changes
 * with every upload, so a browser may cache one for as long as it lasts.
 */
const crypto = require("crypto");
const { localParts } = require("./visit-clock");

const MAX_PLAN_BYTES = 2.75 * 1024 * 1024;
const REF_RE = /^[A-Za-z0-9_-]{16}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RATE = 100000;
const MAX_SQFT = 10000000;
const STATUSES = ["available", "occupied", "upcoming", "shared", "unavailable"];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// What a new database starts with: [name, color, assigned to companies].
const DEFAULT_ROOM_TYPES = [["Office", "#2563eb", true], ["Conference Room", "#7c3aed", false], ["Meeting Room", "#0d9488", false], ["Storage", "#b45309", true], ["IT Room", "#475569", false]];
const DEFAULT_ROOM_CLASSES = [["SCAR", "#d97706"], ["SCIF", "#dc2626"]];
const DEFAULT_UNCLASSIFIED_COLOR = "#16a34a";

function colorInput(value, fallback = null) {
  if (value === undefined) return fallback;
  const c = String(value || "").trim();
  if (!COLOR_RE.test(c)) throw fail(400, "A color is #RRGGBB, such as #2563eb.");
  return c.toLowerCase();
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const money = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const text = (v, max) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

/** A calendar date as YYYY-MM-DD, or null when blank and `optional`; throws for anything else. */
function dateInput(value, label, { optional = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(400, `Give the ${label}.`);
  }
  const m = DATE_RE.exec(String(value));
  const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!m || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw fail(400, `The ${label} must be a date (YYYY-MM-DD).`);
  }
  return String(value);
}

/** A number from 0 to `max`, or null when blank. */
function amountInput(value, label, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw fail(400, `The ${label} must be a number from 0 to ${max.toLocaleString("en-US")}.`);
  return Math.round(n * 10000) / 10000;
}

/** { type, data } from a data: URL holding a PNG or JPEG; throws for anything else. */
function decodePlan(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) throw fail(400, "The floor plan must be a PNG or JPEG image.");
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw fail(400, "The floor plan is empty.");
  if (data.length > MAX_PLAN_BYTES) throw fail(413, "The floor plan is larger than 2.75 MB; use a smaller image.");
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (m[1] === "image/png" ? !png : !jpeg) throw fail(400, "The floor plan's contents are not the PNG or JPEG it claims to be.");
  return { type: m[1], data };
}

const MAX_POINTS = 200;
const round5 = (n) => Math.round(n * 100000) / 100000;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** The area inside an outline, in the units of its points (shoelace formula). */
function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

const rectPoints = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** One [x, y] point within the plan, or null when it isn't one. */
function pointInput(p) {
  if (!Array.isArray(p) || p.length !== 2) return null;
  const [x, y] = p.map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? [round5(clamp01(x)), round5(clamp01(y))] : null;
}

/**
 * Where an office is drawn: `points` (3 or more [x, y] fractions of the plan), or a rectangle
 * as x, y, w, h; null for not drawn. Gives { points (JSON), x, y, w, h (the box around it) }.
 */
function shapeInput(input, existing = null) {
  const none = { points: null, x: null, y: null, w: null, h: null };
  let points;
  if (input.points !== undefined) {
    if (input.points === null) return none;
    if (!Array.isArray(input.points) || input.points.length < 3) throw fail(400, "An office's outline needs at least 3 points.");
    if (input.points.length > MAX_POINTS) throw fail(400, `An office's outline can have at most ${MAX_POINTS} points.`);
    points = input.points.map(pointInput);
    if (points.some((p) => !p)) throw fail(400, "Each point of an outline is [x, y], fractions of the plan.");
  } else if (["x", "y", "w", "h"].some((k) => input[k] !== undefined)) {
    if (["x", "y", "w", "h"].every((k) => input[k] === null)) return none;
    const v = ["x", "y", "w", "h"].map((k) => Number(input[k]));
    if (v.some((n) => !Number.isFinite(n))) throw fail(400, "An office's place on the plan needs x, y, w and h.");
    const x = clamp01(v[0]);
    const y = clamp01(v[1]);
    points = rectPoints(x, y, Math.min(v[2], 1 - x), Math.min(v[3], 1 - y)).map(pointInput);
  } else {
    if (!existing?.points) return none;
    points = existing.points;
  }
  if (polygonArea(points) < 0.00002) throw fail(400, "Draw the office a little bigger.");
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { points: JSON.stringify(points), x, y, w: round5(Math.max(...xs) - x), h: round5(Math.max(...ys) - y) };
}

/** A PNG's or JPEG's size in pixels, from its header; null when it can't be read. */
function imageSize(data) {
  if (data.length > 24 && data[0] === 0x89 && data.toString("latin1", 12, 16) === "IHDR") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i += 1; continue; }
      const marker = data[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = data.readUInt16BE(i + 2);
      // Start of frame (not DHT, JPG or DAC): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      }
      i += 2 + length;
    }
  }
  return null;
}

function createFacilities({ db, sites, directory, now = Date.now }) {
  const raw = db.raw;

  // Room types and classified subcategories to start with, once; rooms made before them are offices.
  if (!db.getSetting("facilities.rooms_seeded")) {
    db.transaction(() => {
      const t = now();
      if (!raw.prepare("SELECT 1 FROM room_types").get()) {
        DEFAULT_ROOM_TYPES.forEach(([name, color, assignable], i) => raw.prepare("INSERT INTO room_types (name, color, assignable, position, created_at) VALUES (?, ?, ?, ?, ?)").run(name, color, assignable ? 1 : 0, i, t));
      }
      if (!raw.prepare("SELECT 1 FROM room_classes").get()) {
        DEFAULT_ROOM_CLASSES.forEach(([name, color], i) => raw.prepare("INSERT INTO room_classes (name, color, position, created_at) VALUES (?, ?, ?, ?)").run(name, color, i, t));
      }
      const office = raw.prepare("SELECT id FROM room_types WHERE name = 'Office'").get();
      if (office) raw.prepare("UPDATE offices SET room_type_id = ? WHERE room_type_id IS NULL").run(office.id);
      db.setSetting("facilities.rooms_seeded", "1");
    });
  }

  // Plans uploaded before their size was kept: read it from the image once.
  for (const r of raw.prepare("SELECT id, plan FROM floors WHERE plan IS NOT NULL AND plan_width IS NULL").all()) {
    const size = imageSize(r.plan);
    if (size) raw.prepare("UPDATE floors SET plan_width = ?, plan_height = ? WHERE id = ?").run(size.width, size.height, r.id);
  }

  // --- dates and sites --------------------------------------------------------------------------

  /** Today at a site, as YYYY-MM-DD (its own time zone). */
  function todayAt(siteId) {
    const site = sites.get(siteId);
    const p = localParts(now(), site?.timeZone || "UTC");
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }

  /** A function giving today at each site, worked out once per site. */
  function todays() {
    const seen = new Map();
    return (siteId) => {
      if (!seen.has(siteId)) seen.set(siteId, todayAt(siteId));
      return seen.get(siteId);
    };
  }

  /** SQL limiting floors (alias f) to the caller's sites and, given one, to one site. */
  function siteScope(scope, siteId = null) {
    const where = [];
    const params = [];
    if (scope) {
      if (!scope.size) where.push("0");
      else {
        where.push(`f.site_id IN (${[...scope].map(() => "?").join(", ")})`);
        params.push(...scope);
      }
    }
    if (siteId) { where.push("f.site_id = ?"); params.push(Number(siteId)); }
    return { where, params };
  }

  // --- rates ------------------------------------------------------------------------------------

  const siteRateStmt = raw.prepare("SELECT rate FROM site_rates WHERE site_id = ?");
  const companyRateStmt = raw.prepare("SELECT rate FROM company_rates WHERE company_id = ?");
  const siteRate = (siteId) => siteRateStmt.get(siteId)?.rate ?? null;
  const companyRate = (companyId) => (companyId ? companyRateStmt.get(companyId)?.rate ?? null : null);

  function setSiteRate(siteId, value) {
    if (!sites.get(siteId)) throw fail(404, "No such site.");
    const rate = amountInput(value, "rate", MAX_RATE);
    if (rate === null) raw.prepare("DELETE FROM site_rates WHERE site_id = ?").run(siteId);
    else raw.prepare("INSERT INTO site_rates (site_id, rate, updated_at) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at").run(siteId, rate, now());
    return rate;
  }

  function setCompanyRate(companyId, value) {
    if (!directory.getCompany(companyId)) throw fail(404, "No such company.");
    const rate = amountInput(value, "rate", MAX_RATE);
    if (rate === null) raw.prepare("DELETE FROM company_rates WHERE company_id = ?").run(companyId);
    else raw.prepare("INSERT INTO company_rates (company_id, rate, updated_at) VALUES (?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at").run(companyId, rate, now());
    return rate;
  }

  /** The rate that applies to an office for a company (or, with none, its asking rate), and where it came from. */
  function effectiveRate(office, siteId, companyId) {
    const own = companyRate(companyId);
    if (own !== null) return { rate: own, source: "company" };
    if (office.rate !== null && office.rate !== undefined) return { rate: office.rate, source: "office" };
    const site = siteRate(siteId);
    return site !== null ? { rate: site, source: "site" } : { rate: null, source: null };
  }

  /** Every site's default rate and every company that has its own, for the caller's sites. */
  function rates({ scope = null } = {}) {
    const siteList = sites.list({ includeInactive: false }).filter((s) => !scope || scope.has(s.id)).map((s) => ({ siteId: s.id, name: s.name, rate: siteRate(s.id) }));
    const companies = raw.prepare(`SELECT r.company_id, r.rate, c.name FROM company_rates r JOIN companies c ON c.id = r.company_id ORDER BY c.name`).all()
      .map((r) => ({ companyId: r.company_id, name: r.name, rate: r.rate }));
    return { sites: siteList, companies };
  }

  // --- floors -----------------------------------------------------------------------------------

  function floorRow(r) {
    return r && {
      id: r.id,
      siteId: r.site_id,
      siteName: r.site_name,
      name: r.name,
      position: r.position,
      planRef: r.plan_ref || null,
      planWidth: r.plan_width || null,
      planHeight: r.plan_height || null,
      // feet: how many feet the plan's full width spans; line: the line it was set from.
      scale: r.scale_feet ? { feet: r.scale_feet, line: JSON.parse(r.scale_line || "null") } : null,
      offices: r.offices ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  const FLOOR_SELECT = `SELECT f.id, f.site_id, f.name, f.position, f.plan_ref, f.plan_width, f.plan_height, f.scale_feet, f.scale_line, f.created_at, f.updated_at, s.name AS site_name,
    (SELECT count(*) FROM offices o WHERE o.floor_id = f.id) AS offices
    FROM floors f JOIN sites s ON s.id = f.site_id`;

  function listFloors({ scope = null, siteId = null } = {}) {
    const { where, params } = siteScope(scope, siteId);
    return raw.prepare(`${FLOOR_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.name, f.position, f.name`).all(...params).map(floorRow);
  }

  /** A floor, or null when there's none or it is at a site the caller can't see. */
  function getFloor(id, { scope = null } = {}) {
    const floor = floorRow(raw.prepare(`${FLOOR_SELECT} WHERE f.id = ?`).get(id));
    return floor && (!scope || scope.has(floor.siteId)) ? floor : null;
  }

  function mustFloor(id, scope) {
    const floor = getFloor(id, { scope });
    if (!floor) throw fail(404, "No such floor, or not at your sites.");
    return floor;
  }

  function createFloor(input = {}, { scope = null } = {}) {
    const siteId = Number(input.siteId);
    if (!sites.get(siteId)) throw fail(400, "Choose the floor's site.");
    if (scope && !scope.has(siteId)) throw fail(403, "This account can't see that site.");
    const name = text(input.name, 60);
    if (!name) throw fail(400, "Give the floor a name.");
    if (raw.prepare("SELECT 1 FROM floors WHERE site_id = ? AND name = ? COLLATE NOCASE").get(siteId, name)) throw fail(409, "That site already has a floor with that name.");
    const position = Number.isInteger(Number(input.position)) && input.position !== null && input.position !== "" ? Number(input.position)
      : (raw.prepare("SELECT max(position) AS p FROM floors WHERE site_id = ?").get(siteId).p ?? -1) + 1;
    const t = now();
    const id = raw.prepare("INSERT INTO floors (site_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(siteId, name, position, t, t).lastInsertRowid;
    return getFloor(Number(id));
  }

  function updateFloor(id, input = {}, { scope = null } = {}) {
    const floor = mustFloor(id, scope);
    const name = input.name !== undefined ? text(input.name, 60) : floor.name;
    if (!name) throw fail(400, "Give the floor a name.");
    const clash = raw.prepare("SELECT id FROM floors WHERE site_id = ? AND name = ? COLLATE NOCASE").get(floor.siteId, name);
    if (clash && clash.id !== id) throw fail(409, "That site already has a floor with that name.");
    let position = floor.position;
    if (input.position !== undefined) {
      position = Number(input.position);
      if (!Number.isInteger(position)) throw fail(400, "A floor's position is a whole number.");
    }
    raw.prepare("UPDATE floors SET name = ?, position = ?, updated_at = ? WHERE id = ?").run(name, position, now(), id);
    return getFloor(id);
  }

  /** Deletes a floor and its offices (with their history), unless an office on it is let now or later. */
  function removeFloor(id, { scope = null } = {}) {
    const floor = mustFloor(id, scope);
    const today = todayAt(floor.siteId);
    const held = raw.prepare(`SELECT o.name FROM office_assignments a JOIN offices o ON o.id = a.office_id
      WHERE o.floor_id = ? AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY o.name`).all(id, today).map((r) => r.name);
    if (held.length) throw fail(409, `${[...new Set(held)].join(", ")} on ${floor.name} ${held.length === 1 ? "is" : "are"} assigned to a company now or later. End those assignments first.`);
    raw.prepare("DELETE FROM floors WHERE id = ?").run(id);
    return floor;
  }

  /**
   * A new plan. The scale stays when the new plan has the same shape (the same drawing at
   * another size, say); otherwise it is cleared, to be set again.
   */
  function setPlan(id, dataUrl, { scope = null } = {}) {
    const floor = mustFloor(id, scope);
    const plan = decodePlan(dataUrl);
    const size = imageSize(plan.data);
    if (!size || !size.width || !size.height) throw fail(400, "The floor plan's size can't be read from the image.");
    const ref = crypto.randomBytes(12).toString("base64url");
    const sameShape = floor.planWidth && Math.abs(floor.planHeight / floor.planWidth - size.height / size.width) < 0.01 * (size.height / size.width);
    raw.prepare(`UPDATE floors SET plan = ?, plan_type = ?, plan_ref = ?, plan_width = ?, plan_height = ?,
      scale_feet = CASE WHEN ? THEN scale_feet END, scale_line = CASE WHEN ? THEN scale_line END, updated_at = ? WHERE id = ?`)
      .run(plan.data, plan.type, ref, size.width, size.height, sameShape ? 1 : 0, sameShape ? 1 : 0, now(), id);
    return getFloor(id);
  }

  function clearPlan(id, { scope = null } = {}) {
    mustFloor(id, scope);
    raw.prepare("UPDATE floors SET plan = NULL, plan_type = NULL, plan_ref = NULL, plan_width = NULL, plan_height = NULL, scale_feet = NULL, scale_line = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    return getFloor(id);
  }

  /**
   * Sets a floor's scale from a line drawn on its plan (from and to: [x, y] fractions) and how
   * many feet long it really is; feet null clears it.
   */
  function setScale(id, input = {}, { scope = null } = {}) {
    const floor = mustFloor(id, scope);
    if (input.feet === null || input.feet === "") {
      raw.prepare("UPDATE floors SET scale_feet = NULL, scale_line = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      return getFloor(id);
    }
    if (!floor.planRef || !floor.planWidth) throw fail(400, "Upload the floor's plan before setting its scale.");
    const from = pointInput(input.from);
    const to = pointInput(input.to);
    if (!from || !to) throw fail(400, "Draw a line on the plan: from and to are [x, y].");
    const feet = amountInput(input.feet, "length", MAX_SQFT);
    if (!feet) throw fail(400, "Give the line's length in feet.");
    // In widths of the plan: a step down the plan is shorter than one across by its shape.
    const across = Math.hypot(to[0] - from[0], (to[1] - from[1]) * (floor.planHeight / floor.planWidth));
    if (across < 0.02) throw fail(400, "Draw a longer line: the longer it is, the truer the scale.");
    raw.prepare("UPDATE floors SET scale_feet = ?, scale_line = ?, updated_at = ? WHERE id = ?")
      .run(Math.round((feet / across) * 10000) / 10000, JSON.stringify({ from, to, feet }), now(), id);
    return getFloor(id);
  }

  /** The image behind a plan ref, when its floor is at one of the caller's sites; else null. */
  function planImage(ref, { scope = null } = {}) {
    if (!REF_RE.test(String(ref || ""))) return null;
    const r = raw.prepare("SELECT site_id, plan, plan_type FROM floors WHERE plan_ref = ?").get(String(ref));
    if (!r || (scope && !scope.has(r.site_id))) return null;
    return { type: r.plan_type, data: r.plan };
  }

  // --- assignments ------------------------------------------------------------------------------

  function assignmentRow(r) {
    return r && {
      id: r.id,
      officeId: r.office_id,
      companyId: r.company_id,
      // The company's name now; once it has been deleted, the name it had.
      companyName: r.live_name || r.company_name,
      startDate: r.start_date,
      endDate: r.end_date || null,
      notes: r.notes || null,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
      updatedBy: r.updated_by || null,
      updatedAt: r.updated_at
    };
  }

  const ASSIGNMENT_SELECT = "SELECT a.*, c.name AS live_name FROM office_assignments a LEFT JOIN companies c ON c.id = a.company_id";

  const assignmentsOf = (officeIds) => {
    if (!officeIds.length) return new Map();
    const out = new Map(officeIds.map((id) => [id, []]));
    for (const r of raw.prepare(`${ASSIGNMENT_SELECT} WHERE a.office_id IN (${officeIds.map(() => "?").join(", ")}) ORDER BY a.start_date DESC, a.id DESC`).all(...officeIds)) {
      out.get(r.office_id).push(assignmentRow(r));
    }
    return out;
  };

  /** Which of an office's assignments is on `today`, and the next one after it. */
  function placeOf(list, today) {
    const current = list.find((a) => a.startDate <= today && (!a.endDate || a.endDate >= today)) || null;
    const next = list.filter((a) => a.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null;
    return { current, next };
  }

  // --- offices ----------------------------------------------------------------------------------

  const OFFICE_SELECT = `SELECT o.*, f.site_id, f.name AS floor_name, f.plan_width, f.plan_height, f.scale_feet, s.name AS site_name,
    t.name AS type_name, t.color AS type_color, t.assignable AS type_assignable, c.name AS class_name, c.color AS class_color FROM offices o
    JOIN floors f ON f.id = o.floor_id JOIN sites s ON s.id = f.site_id
    LEFT JOIN room_types t ON t.id = o.room_type_id LEFT JOIN room_classes c ON c.id = o.class_id`;

  /** An office as shown: where it is, its status today, who has it, and what it costs. */
  function officeOut(r, list, today, { history = false } = {}) {
    const { current, next } = placeOf(list, today);
    // A room of a type that isn't assigned to companies (a conference room, say) is shared.
    const assignable = r.room_type_id ? Boolean(r.type_assignable) : true;
    const status = r.unavailable ? "unavailable" : current ? "occupied" : next ? "upcoming" : assignable ? "available" : "shared";
    // Occupied: what its company pays. Otherwise what it would cost (the office's or site's rate); a shared room costs nothing.
    const { rate, source } = assignable || current ? effectiveRate(r, r.site_id, current?.companyId ?? null) : { rate: null, source: null };
    // What it costs a company without a rate of its own: the office's rate, else the site's.
    const askingRate = assignable ? effectiveRate(r, r.site_id, null).rate : null;
    // Drawn before outlines: its rectangle's corners.
    const points = r.points ? JSON.parse(r.points) : r.x !== null && r.x !== undefined ? rectPoints(r.x, r.y, r.w, r.h) : null;
    // Its area from the plan, when the floor has a scale: the plan is scale_feet wide and as tall as its shape says.
    const measuredSqft = points && r.scale_feet && r.plan_width
      ? Math.round(polygonArea(points) * r.scale_feet * r.scale_feet * (r.plan_height / r.plan_width))
      : null;
    return {
      id: r.id,
      floorId: r.floor_id,
      floorName: r.floor_name,
      siteId: r.site_id,
      siteName: r.site_name,
      name: r.name,
      sqft: r.sqft ?? null,
      rate: r.rate ?? null,
      unavailable: Boolean(r.unavailable),
      roomTypeId: r.room_type_id || null,
      roomType: r.room_type_id ? { id: r.room_type_id, name: r.type_name, color: r.type_color, assignable } : null,
      assignable,
      // null: unclassified.
      classId: r.class_id || null,
      classification: r.class_id ? { id: r.class_id, name: r.class_name, color: r.class_color } : null,
      x: r.x ?? null,
      y: r.y ?? null,
      w: r.w ?? null,
      h: r.h ?? null,
      points,
      measuredSqft,
      notes: r.notes || null,
      status,
      current,
      next,
      effectiveRate: rate,
      rateSource: source,
      askingRate,
      monthly: rate !== null && r.sqft !== null && r.sqft !== undefined ? money(r.sqft * rate) : null,
      ...(history ? { assignments: list } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  /**
   * Offices at the caller's sites: on one floor, at one site, or held (now or later) by one
   * company; with freeFrom (and freeTo, else no end), only those that can be assigned for those
   * dates: not unavailable, and no assignment overlapping them.
   */
  function listOffices({ scope = null, siteId = null, floorId = null, companyId = null, status = null, roomTypeId = null, freeFrom = null, freeTo = null } = {}) {
    const { where, params } = siteScope(scope, siteId);
    if (roomTypeId) { where.push("o.room_type_id = ?"); params.push(Number(roomTypeId)); }
    if (freeFrom) {
      // Only rooms of a type that is assigned to companies.
      where.push("(o.room_type_id IS NULL OR o.room_type_id IN (SELECT id FROM room_types WHERE assignable = 1))");
      const from = dateInput(freeFrom, "start date");
      const to = dateInput(freeTo, "end date", { optional: true });
      if (to && to < from) throw fail(400, "The end date is before the start date.");
      where.push("o.unavailable = 0 AND NOT EXISTS (SELECT 1 FROM office_assignments a WHERE a.office_id = o.id AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?))");
      params.push(to || "9999-12-31", from);
    }
    if (floorId) { where.push("o.floor_id = ?"); params.push(Number(floorId)); }
    if (companyId) { where.push("o.id IN (SELECT office_id FROM office_assignments WHERE company_id = ?)"); params.push(Number(companyId)); }
    const rows = raw.prepare(`${OFFICE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.name, f.position, f.name, o.name`).all(...params);
    const lists = assignmentsOf(rows.map((r) => r.id));
    const today = todays();
    const out = rows.map((r) => officeOut(r, lists.get(r.id), today(r.site_id)));
    return status ? out.filter((o) => o.status === status) : out;
  }

  /** One office with its whole history, or null when there's none or it is at a site the caller can't see. */
  function getOffice(id, { scope = null } = {}) {
    const r = raw.prepare(`${OFFICE_SELECT} WHERE o.id = ?`).get(id);
    if (!r || (scope && !scope.has(r.site_id))) return null;
    return officeOut(r, assignmentsOf([r.id]).get(r.id), todayAt(r.site_id), { history: true });
  }

  function mustOffice(id, scope) {
    const office = getOffice(id, { scope });
    if (!office) throw fail(404, "No such office, or not at your sites.");
    return office;
  }

  function officeInput(input, existing = null) {
    const out = {};
    out.name = input.name !== undefined ? text(input.name, 60) : existing?.name;
    if (!out.name) throw fail(400, "Give the office a name or number.");
    out.sqft = input.sqft !== undefined ? amountInput(input.sqft, "square footage", MAX_SQFT) : existing?.sqft ?? null;
    out.rate = input.rate !== undefined ? amountInput(input.rate, "rate", MAX_RATE) : existing?.rate ?? null;
    out.unavailable = input.unavailable !== undefined ? input.unavailable === true : Boolean(existing?.unavailable);
    out.notes = input.notes !== undefined ? text(input.notes, 1000) : existing?.notes ?? null;
    // A new room is an office unless it says otherwise.
    if (input.roomTypeId !== undefined) out.roomTypeId = input.roomTypeId === null || input.roomTypeId === "" ? null : mustRoomType(input.roomTypeId).id;
    else out.roomTypeId = existing ? existing.roomTypeId : raw.prepare("SELECT id FROM room_types WHERE name = 'Office'").get()?.id ?? null;
    if (input.classId !== undefined) out.classId = input.classId === null || input.classId === "" ? null : mustRoomClass(input.classId).id;
    else out.classId = existing ? existing.classId : null;
    Object.assign(out, shapeInput(input, existing));
    return out;
  }

  function createOffice(input = {}, { scope = null } = {}) {
    const floor = mustFloor(Number(input.floorId), scope);
    const v = officeInput(input);
    if (raw.prepare("SELECT 1 FROM offices WHERE floor_id = ? AND name = ? COLLATE NOCASE").get(floor.id, v.name)) throw fail(409, `${floor.name} already has an office called ${v.name}.`);
    const t = now();
    const id = raw.prepare("INSERT INTO offices (floor_id, name, sqft, rate, unavailable, room_type_id, class_id, x, y, w, h, points, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(floor.id, v.name, v.sqft, v.rate, v.unavailable ? 1 : 0, v.roomTypeId, v.classId, v.x, v.y, v.w, v.h, v.points, v.notes, t, t).lastInsertRowid;
    return getOffice(Number(id));
  }

  function updateOffice(id, input = {}, { scope = null } = {}) {
    const existing = mustOffice(id, scope);
    const v = officeInput(input, existing);
    const clash = raw.prepare("SELECT id FROM offices WHERE floor_id = ? AND name = ? COLLATE NOCASE").get(existing.floorId, v.name);
    if (clash && clash.id !== id) throw fail(409, `${existing.floorName} already has an office called ${v.name}.`);
    if (v.unavailable && !existing.unavailable && (existing.current || existing.next)) {
      throw fail(409, `${existing.name} is assigned to ${(existing.current || existing.next).companyName}. End that assignment before marking it unavailable.`);
    }
    if (v.roomTypeId !== existing.roomTypeId && v.roomTypeId && !mustRoomType(v.roomTypeId).assignable && (existing.current || existing.next)) {
      throw fail(409, `${existing.name} is assigned to ${(existing.current || existing.next).companyName}, and a ${mustRoomType(v.roomTypeId).name} isn't assigned to companies. End that assignment first.`);
    }
    raw.prepare("UPDATE offices SET name = ?, sqft = ?, rate = ?, unavailable = ?, room_type_id = ?, class_id = ?, x = ?, y = ?, w = ?, h = ?, points = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(v.name, v.sqft, v.rate, v.unavailable ? 1 : 0, v.roomTypeId, v.classId, v.x, v.y, v.w, v.h, v.points, v.notes, now(), id);
    return getOffice(id);
  }

  /** Deletes an office and its history, unless a company has it now or later. */
  function removeOffice(id, { scope = null } = {}) {
    const office = mustOffice(id, scope);
    if (office.current || office.next) throw fail(409, `${office.name} is assigned to ${(office.current || office.next).companyName}. End that assignment first.`);
    raw.prepare("DELETE FROM offices WHERE id = ?").run(id);
    return office;
  }

  // --- several rooms at once ---------------------------------------------------------------------

  // What may be set on several rooms together (names, sizes and places stay one at a time).
  const BULK_KEYS = ["roomTypeId", "classId", "rate", "unavailable", "notes"];

  /** The ids of several rooms: distinct positive whole numbers, at most 500. */
  function roomIds(list) {
    const ids = [...new Set((Array.isArray(list) ? list : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw fail(400, "Choose at least one room.");
    if (ids.length > 500) throw fail(400, "At most 500 rooms at a time.");
    return ids;
  }

  /** Runs fn for each room in one transaction; the first that fails undoes them all, naming its room. */
  function eachRoom(ids, scope, fn) {
    const done = [];
    db.transaction(() => {
      for (const id of ids) {
        try {
          done.push(fn(id));
        } catch (error) {
          const room = getOffice(id, { scope });
          // Name the room (and its floor), once.
          if (room && error.status) error.message = error.message.startsWith(`${room.name} `) ? `${room.name} (${room.floorName})${error.message.slice(room.name.length)}` : `${room.name} (${room.floorName}): ${error.message}`;
          throw error;
        }
      }
    });
    return done;
  }

  /** Sets the same things on several rooms: { roomTypeId, classId, rate, unavailable, notes }, all or none. */
  function updateMany(list, patch = {}, { scope = null } = {}) {
    const ids = roomIds(list);
    const unknown = Object.keys(patch || {}).filter((k) => !BULK_KEYS.includes(k));
    if (unknown.length) throw fail(400, `These can't be changed on several rooms at once: ${unknown.join(", ")}.`);
    const input = Object.fromEntries(BULK_KEYS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    if (!Object.keys(input).length) throw fail(400, "Choose what to change.");
    return eachRoom(ids, scope, (id) => updateOffice(id, input, { scope }));
  }

  /** Deletes several rooms (with their history), all or none: none may be assigned now or later. */
  function removeMany(list, { scope = null } = {}) {
    return eachRoom(roomIds(list), scope, (id) => removeOffice(id, { scope }));
  }

  // --- assigning --------------------------------------------------------------------------------

  /** Refuses dates that overlap another of the office's assignments. */
  function checkOverlap(officeId, startDate, endDate, exceptId = null) {
    const clash = raw.prepare(`${ASSIGNMENT_SELECT} WHERE a.office_id = ? AND a.id IS NOT ? AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY a.start_date LIMIT 1`)
      .get(officeId, exceptId, endDate || "9999-12-31", startDate);
    if (clash) {
      const c = assignmentRow(clash);
      throw fail(409, `That overlaps ${c.companyName}'s assignment (${c.startDate} to ${c.endDate || "no end date"}). An office has one company at a time.`);
    }
  }

  function getAssignment(id, { scope = null } = {}) {
    const a = assignmentRow(raw.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id));
    if (!a) return null;
    return getOffice(a.officeId, { scope }) ? a : null;
  }

  /** Gives an office to a company from startDate, to endDate (its last day) or with no end. */
  function assign(officeId, input = {}, { scope = null, by = null } = {}) {
    const office = mustOffice(officeId, scope);
    if (office.unavailable) throw fail(409, `${office.name} is marked unavailable.`);
    if (!office.assignable) throw fail(409, `${office.name} is a ${office.roomType.name}, which isn't assigned to companies.`);
    const company = directory.getCompany(Number(input.companyId));
    if (!company) throw fail(400, "Choose the company.");
    const startDate = dateInput(input.startDate, "start date");
    const endDate = dateInput(input.endDate, "end date", { optional: true });
    if (endDate && endDate < startDate) throw fail(400, "The end date is before the start date.");
    checkOverlap(officeId, startDate, endDate);
    const t = now();
    const id = raw.prepare("INSERT INTO office_assignments (office_id, company_id, company_name, start_date, end_date, notes, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(officeId, company.id, company.name, startDate, endDate, text(input.notes, 1000), by, t, by, t).lastInsertRowid;
    return { office: getOffice(officeId), assignment: getAssignment(Number(id)) };
  }

  /**
   * Gives several offices to one company for the same dates, all or none: if any can't be
   * assigned, none is, and the error names that office.
   */
  function assignMany(companyId, officeIds, input = {}, { scope = null, by = null } = {}) {
    const ids = [...new Set((Array.isArray(officeIds) ? officeIds : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw fail(400, "Choose at least one office.");
    if (ids.length > 200) throw fail(400, "At most 200 offices at a time.");
    const done = [];
    db.transaction(() => {
      for (const id of ids) {
        try {
          done.push(assign(id, { ...input, companyId }, { scope, by }));
        } catch (error) {
          const office = getOffice(id, { scope });
          if (office) error.message = `Office ${office.name} (${office.floorName}): ${error.message}`;
          throw error;
        }
      }
    });
    return done;
  }

  /** Changes an assignment's dates or notes (setting its end date ends it). */
  function updateAssignment(id, input = {}, { scope = null, by = null } = {}) {
    const existing = getAssignment(id, { scope });
    if (!existing) throw fail(404, "No such assignment, or not at your sites.");
    const startDate = input.startDate !== undefined ? dateInput(input.startDate, "start date") : existing.startDate;
    const endDate = input.endDate !== undefined ? dateInput(input.endDate, "end date", { optional: true }) : existing.endDate;
    if (endDate && endDate < startDate) throw fail(400, "The end date is before the start date.");
    checkOverlap(existing.officeId, startDate, endDate, id);
    const notes = input.notes !== undefined ? text(input.notes, 1000) : existing.notes;
    raw.prepare("UPDATE office_assignments SET start_date = ?, end_date = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(startDate, endDate, notes, by, now(), id);
    return { office: getOffice(existing.officeId), assignment: getAssignment(id) };
  }

  /** Removes an assignment made by mistake (one that ended stays as history: end it instead). */
  function removeAssignment(id, { scope = null } = {}) {
    const existing = getAssignment(id, { scope });
    if (!existing) throw fail(404, "No such assignment, or not at your sites.");
    raw.prepare("DELETE FROM office_assignments WHERE id = ?").run(id);
    return { office: getOffice(existing.officeId), assignment: existing };
  }

  // --- companies and totals ---------------------------------------------------------------------

  /** A company's offices at the caller's sites (now, later and before), its rate, and what it pays a month now. */
  function forCompany(companyId, { scope = null } = {}) {
    const offices = listOffices({ scope, companyId });
    const today = todays();
    const rows = [];
    for (const o of offices) {
      const full = getOffice(o.id, { scope });
      for (const a of full.assignments.filter((x) => x.companyId === companyId)) {
        const day = today(o.siteId);
        const when = a.startDate > day ? "upcoming" : a.endDate && a.endDate < day ? "ended" : "current";
        const { rate, source } = effectiveRate(full, full.siteId, companyId);
        rows.push({
          assignment: a, when, officeId: o.id, officeName: o.name, floorId: o.floorId, floorName: o.floorName, siteId: o.siteId, siteName: o.siteName,
          sqft: o.sqft, rate, rateSource: source, monthly: rate !== null && o.sqft !== null ? money(o.sqft * rate) : null
        });
      }
    }
    const order = { current: 0, upcoming: 1, ended: 2 };
    rows.sort((a, b) => order[a.when] - order[b.when] || b.assignment.startDate.localeCompare(a.assignment.startDate));
    const held = rows.filter((r) => r.when === "current");
    return {
      rate: companyRate(companyId),
      offices: rows,
      totals: { offices: held.length, sqft: money(held.reduce((n, r) => n + (r.sqft || 0), 0)), monthly: money(held.reduce((n, r) => n + (r.monthly || 0), 0)) }
    };
  }

  /** Counts and totals across the caller's sites (or one): offices by status, square feet, and monthly rent now. */
  function summary({ scope = null, siteId = null } = {}) {
    const list = listOffices({ scope, siteId });
    const out = { offices: list.length, floors: listFloors({ scope, siteId }).length, sqft: { total: 0, occupied: 0, available: 0 }, monthly: 0, asking: 0 };
    for (const s of STATUSES) out[s] = 0;
    for (const o of list) {
      out[o.status] += 1;
      out.sqft.total += o.sqft || 0;
      if (o.status === "occupied") {
        out.sqft.occupied += o.sqft || 0;
        out.monthly += o.monthly || 0;
      } else if (o.status === "available" || o.status === "upcoming") {
        out.sqft.available += o.sqft || 0;
        out.asking += o.monthly || 0;
      }
    }
    for (const k of Object.keys(out.sqft)) out.sqft[k] = money(out.sqft[k]);
    out.monthly = money(out.monthly);
    out.asking = money(out.asking);
    return out;
  }

  // --- room types and classifications -----------------------------------------------------------

  const typeRow = (r) => r && { id: r.id, name: r.name, color: r.color, assignable: Boolean(r.assignable), position: r.position, rooms: r.rooms };
  const classRow = (r) => r && { id: r.id, name: r.name, color: r.color, position: r.position, rooms: r.rooms };
  const TYPE_SELECT = "SELECT t.*, (SELECT count(*) FROM offices o WHERE o.room_type_id = t.id) AS rooms FROM room_types t";
  const CLASS_SELECT = "SELECT c.*, (SELECT count(*) FROM offices o WHERE o.class_id = c.id) AS rooms FROM room_classes c";

  function mustRoomType(id) {
    const t = typeRow(raw.prepare(`${TYPE_SELECT} WHERE t.id = ?`).get(Number(id)));
    if (!t) throw fail(400, "No such room type.");
    return t;
  }

  function mustRoomClass(id) {
    const c = classRow(raw.prepare(`${CLASS_SELECT} WHERE c.id = ?`).get(Number(id)));
    if (!c) throw fail(400, "No such classification.");
    return c;
  }

  const unclassifiedColor = () => db.getSetting("facilities.unclassified_color") || DEFAULT_UNCLASSIFIED_COLOR;

  /** Room types and classifications, each with its color and how many rooms have it. */
  function roomKinds() {
    const unclassified = raw.prepare("SELECT count(*) AS n FROM offices WHERE class_id IS NULL").get().n;
    return {
      types: raw.prepare(`${TYPE_SELECT} ORDER BY t.position, t.name`).all().map(typeRow),
      classes: raw.prepare(`${CLASS_SELECT} ORDER BY c.position, c.name`).all().map(classRow),
      unclassified: { name: "Unclassified", color: unclassifiedColor(), rooms: unclassified }
    };
  }

  function nameInput(value, what) {
    const name = text(value, 40);
    if (!name) throw fail(400, `Give the ${what} a name.`);
    return name;
  }

  function createRoomType(input = {}) {
    const name = nameInput(input.name, "room type");
    if (raw.prepare("SELECT 1 FROM room_types WHERE name = ?").get(name)) throw fail(409, "There is a room type with that name already.");
    const position = (raw.prepare("SELECT max(position) AS p FROM room_types").get().p ?? -1) + 1;
    const id = raw.prepare("INSERT INTO room_types (name, color, assignable, position, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(name, colorInput(input.color, "#64748b"), input.assignable === false ? 0 : 1, position, now()).lastInsertRowid;
    return mustRoomType(Number(id));
  }

  function updateRoomType(id, input = {}) {
    const existing = mustRoomType(id);
    const name = input.name !== undefined ? nameInput(input.name, "room type") : existing.name;
    const clash = raw.prepare("SELECT id FROM room_types WHERE name = ?").get(name);
    if (clash && clash.id !== existing.id) throw fail(409, "There is a room type with that name already.");
    const assignable = input.assignable !== undefined ? input.assignable === true : existing.assignable;
    if (existing.assignable && !assignable) {
      // Rooms of this type assigned now or later would be left with companies they can't have.
      const held = listOffices({ roomTypeId: existing.id }).filter((o) => o.current || o.next).map((o) => o.name);
      if (held.length) throw fail(409, `${held.join(", ")} ${held.length === 1 ? "is" : "are"} assigned to a company now or later. End those assignments first.`);
    }
    raw.prepare("UPDATE room_types SET name = ?, color = ?, assignable = ? WHERE id = ?").run(name, colorInput(input.color, existing.color), assignable ? 1 : 0, existing.id);
    return mustRoomType(existing.id);
  }

  function removeRoomType(id) {
    const existing = mustRoomType(id);
    if (existing.rooms) throw fail(409, `${existing.rooms} ${existing.rooms === 1 ? "room is a" : "rooms are"} ${existing.name}; change ${existing.rooms === 1 ? "its" : "their"} type first.`);
    raw.prepare("DELETE FROM room_types WHERE id = ?").run(existing.id);
    return existing;
  }

  function createRoomClass(input = {}) {
    const name = nameInput(input.name, "classification");
    if (/^unclassified$/i.test(name)) throw fail(400, "Unclassified is already there: it is a room with no classification.");
    if (raw.prepare("SELECT 1 FROM room_classes WHERE name = ?").get(name)) throw fail(409, "There is a classification with that name already.");
    const position = (raw.prepare("SELECT max(position) AS p FROM room_classes").get().p ?? -1) + 1;
    const id = raw.prepare("INSERT INTO room_classes (name, color, position, created_at) VALUES (?, ?, ?, ?)").run(name, colorInput(input.color, "#dc2626"), position, now()).lastInsertRowid;
    return mustRoomClass(Number(id));
  }

  function updateRoomClass(id, input = {}) {
    const existing = mustRoomClass(id);
    const name = input.name !== undefined ? nameInput(input.name, "classification") : existing.name;
    if (/^unclassified$/i.test(name)) throw fail(400, "Unclassified is a room with no classification; choose another name.");
    const clash = raw.prepare("SELECT id FROM room_classes WHERE name = ?").get(name);
    if (clash && clash.id !== existing.id) throw fail(409, "There is a classification with that name already.");
    raw.prepare("UPDATE room_classes SET name = ?, color = ? WHERE id = ?").run(name, colorInput(input.color, existing.color), existing.id);
    return mustRoomClass(existing.id);
  }

  function removeRoomClass(id) {
    const existing = mustRoomClass(id);
    if (existing.rooms) throw fail(409, `${existing.rooms} ${existing.rooms === 1 ? "room is" : "rooms are"} ${existing.name}; change ${existing.rooms === 1 ? "its" : "their"} classification first.`);
    raw.prepare("DELETE FROM room_classes WHERE id = ?").run(existing.id);
    return existing;
  }

  function setUnclassifiedColor(value) {
    const color = colorInput(value);
    db.setSetting("facilities.unclassified_color", color);
    return color;
  }

  /** The offices a company has now or later, by name (to refuse deleting it while it does). */
  function heldBy(companyId) {
    const rows = raw.prepare(`SELECT o.name, f.site_id, a.end_date FROM office_assignments a JOIN offices o ON o.id = a.office_id JOIN floors f ON f.id = o.floor_id WHERE a.company_id = ?`).all(companyId);
    const today = todays();
    return [...new Set(rows.filter((r) => !r.end_date || r.end_date >= today(r.site_id)).map((r) => r.name))];
  }

  return {
    todayAt, rates, siteRate, companyRate, setSiteRate, setCompanyRate,
    listFloors, getFloor, createFloor, updateFloor, removeFloor, setPlan, clearPlan, setScale, planImage,
    listOffices, getOffice, createOffice, updateOffice, removeOffice, updateMany, removeMany,
    getAssignment, assign, assignMany, updateAssignment, removeAssignment,
    forCompany, summary, heldBy,
    roomKinds, createRoomType, updateRoomType, removeRoomType, createRoomClass, updateRoomClass, removeRoomClass, setUnclassifiedColor
  };
}

module.exports = { createFacilities, decodePlan, imageSize, polygonArea, STATUSES, MAX_PLAN_BYTES };
