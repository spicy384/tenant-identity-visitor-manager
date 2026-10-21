/**
 * Sites: the buildings this installation looks after. Each has the name and logo its
 * kiosk shows, a time zone, and the time its visitors are checked out automatically
 * (used from phase 2). The first start creates one site; with only one, the pages
 * never ask which.
 *
 * Logos are stored in the (encrypted) database, as PNG or JPEG only. The browser turns
 * anything else, SVG included, into PNG before uploading, so the server never serves
 * a file that could carry script.
 */
const MAX_LOGO_BYTES = 1024 * 1024;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host's time zone, or UTC when it has none worth using. */
function hostTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && validTimeZone(tz) ? tz : "UTC";
}

/** { type, data } from a data: URL holding a PNG or JPEG; throws for anything else. */
function decodeLogo(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) throw fail(400, "The logo must be a PNG or JPEG image.");
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw fail(400, "The logo file is empty.");
  if (data.length > MAX_LOGO_BYTES) throw fail(413, "The logo is larger than 1 MB; use a smaller image.");
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (m[1] === "image/png" ? !png : !jpeg) throw fail(400, "The logo's contents are not the PNG or JPEG image it claims to be.");
  return { type: m[1], data };
}

function createSites({ db }) {
  const raw = db.raw;

  function row(r) {
    return r && {
      id: r.id,
      name: r.name,
      kioskName: r.kiosk_name || null,
      welcome: r.welcome || null,
      address: r.address || null,
      timeZone: r.time_zone,
      endOfDay: r.end_of_day || null,
      hasLogo: Boolean(r.has_logo),
      logoUpdatedAt: r.logo_updated_at || null,
      active: Boolean(r.active),
      companies: r.companies ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  const SELECT = `SELECT s.id, s.name, s.kiosk_name, s.welcome, s.address, s.time_zone, s.end_of_day, s.logo IS NOT NULL AS has_logo,
    s.logo_updated_at, s.active, s.created_at, s.updated_at,
    (SELECT count(*) FROM company_sites cs JOIN companies c ON c.id = cs.company_id WHERE cs.site_id = s.id AND c.active = 1) AS companies
    FROM sites s`;

  function list({ includeInactive = true } = {}) {
    return raw.prepare(`${SELECT} ${includeInactive ? "" : "WHERE s.active = 1"} ORDER BY s.name`).all().map(row);
  }

  function get(id) {
    return row(raw.prepare(`${SELECT} WHERE s.id = ?`).get(id));
  }

  function count() {
    return raw.prepare("SELECT count(*) AS n FROM sites").get().n;
  }

  function clean(input, existing = null) {
    const out = {};
    const text = (v, max) => {
      const s = String(v ?? "").trim().slice(0, max);
      return s || null;
    };
    if (input.name !== undefined || !existing) {
      const name = text(input.name, 80);
      if (!name) throw fail(400, "Give the site a name.");
      out.name = name;
    }
    if (input.kioskName !== undefined) out.kioskName = text(input.kioskName, 80);
    if (input.welcome !== undefined) out.welcome = text(input.welcome, 200);
    if (input.address !== undefined) out.address = text(input.address, 400);
    if (input.timeZone !== undefined || !existing) {
      const tz = text(input.timeZone, 60) || hostTimeZone();
      if (!validTimeZone(tz)) throw fail(400, `${tz} is not a time zone this server knows.`);
      out.timeZone = tz;
    }
    if (input.endOfDay !== undefined) {
      const v = text(input.endOfDay, 5);
      if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw fail(400, "End of day must be a time like 18:00, or empty for none.");
      out.endOfDay = v;
    }
    if (input.active !== undefined) out.active = Boolean(input.active);
    return out;
  }

  function nameTaken(name, exceptId = null) {
    const hit = raw.prepare("SELECT id FROM sites WHERE name = ?").get(name);
    return hit && hit.id !== exceptId;
  }

  function create(input = {}) {
    const v = clean(input);
    if (nameTaken(v.name)) throw fail(409, "A site with that name already exists.");
    const now = Date.now();
    const info = raw.prepare("INSERT INTO sites (name, kiosk_name, welcome, address, time_zone, end_of_day, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.name, v.kioskName ?? null, v.welcome ?? null, v.address ?? null, v.timeZone, v.endOfDay ?? null, v.active === false ? 0 : 1, now, now);
    return get(info.lastInsertRowid);
  }

  function update(id, input = {}) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such site.");
    const v = clean(input, existing);
    if (v.name && nameTaken(v.name, id)) throw fail(409, "A site with that name already exists.");
    const next = { ...existing, ...v };
    if (!next.active && existing.active && raw.prepare("SELECT count(*) AS n FROM sites WHERE active = 1").get().n <= 1) {
      throw fail(400, "At least one site must stay active.");
    }
    raw.prepare("UPDATE sites SET name = ?, kiosk_name = ?, welcome = ?, address = ?, time_zone = ?, end_of_day = ?, active = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.kioskName, next.welcome, next.address, next.timeZone, next.endOfDay, next.active ? 1 : 0, Date.now(), id);
    return get(id);
  }

  /** Deletes a site nothing refers to; otherwise it should be made inactive instead. */
  function remove(id) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such site.");
    if (count() <= 1) throw fail(400, "The last site can't be removed.");
    const used = raw.prepare("SELECT (SELECT count(*) FROM company_sites WHERE site_id = ?) + (SELECT count(*) FROM people WHERE site_id = ?) + (SELECT count(*) FROM kiosks WHERE site_id = ?) + (SELECT count(*) FROM badge_sites WHERE site_id = ?) + (SELECT count(*) FROM floors WHERE site_id = ?) AS n").get(id, id, id, id, id).n;
    if (used) throw fail(409, `${existing.name} still has companies, people, kiosks, floors or badges valid there; move them or make the site inactive instead.`);
    if (raw.prepare("SELECT 1 FROM visits WHERE site_id = ? LIMIT 1").get(id)) {
      throw fail(409, `${existing.name} has visits on record; make the site inactive instead, so the visit log keeps it.`);
    }
    raw.prepare("DELETE FROM sites WHERE id = ?").run(id);
    return existing;
  }

  function setLogo(id, dataUrl) {
    if (!get(id)) throw fail(404, "No such site.");
    const { type, data } = decodeLogo(dataUrl);
    raw.prepare("UPDATE sites SET logo = ?, logo_type = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?").run(data, type, Date.now(), Date.now(), id);
    return get(id);
  }

  function clearLogo(id) {
    if (!get(id)) throw fail(404, "No such site.");
    raw.prepare("UPDATE sites SET logo = NULL, logo_type = NULL, logo_updated_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return get(id);
  }

  function getLogo(id) {
    const r = raw.prepare("SELECT logo, logo_type FROM sites WHERE id = ?").get(id);
    return r && r.logo ? { type: r.logo_type, data: r.logo } : null;
  }

  /** The first start's site, so there is always one to put companies in. */
  function ensureDefault(name = "Main site") {
    if (count() === 0) return create({ name, timeZone: hostTimeZone() });
    return null;
  }

  return { list, get, count, create, update, remove, setLogo, clearLogo, getLogo, ensureDefault };
}

module.exports = { createSites, decodeLogo, validTimeZone, hostTimeZone, MAX_LOGO_BYTES };
