/**
 * The encrypted database. One SQLCipher file (AES-256 pages, HMAC-SHA512) opened with
 * a key that lives outside the data directory (db-key.js). Everything the app keeps is
 * in here: the directory, custom fields, roles and field access, sites and their logos,
 * accounts, sessions, settings and the audit log. Its WAL file is encrypted the same
 * way, and temporary tables stay in memory, so nothing readable is written to disk.
 *
 * Accounts, sessions and the Entra settings are JSON documents in the `documents`
 * table rather than tables of their own: they were JSON files in the apps this one
 * grew from, and keeping their shape keeps the sign-in code the same.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

const DB_FILE = "identity.db";
// 1: directory, fields, roles, sites. 2: visitors, their links, visits, kiosk devices.
// 3: API clients. 4: badges, clearances, building staff, visitor events. 5: clearance validation.
// 6: badge template images, and which roles see clearance levels. 7: kiosk visits waiting for a badge.
// 8: facilities (floors, offices, office assignments, rates) and the roles that reach them.
// 9: room types and classified subcategories, each with a color.
const SCHEMA_VERSION = 10;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Applies the cipher and key to a freshly opened connection. */
function applyKey(db, key) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma("legacy = 4");
  db.pragma(`key = "x'${key}'"`);
}

/** Opens `file` with `key`, failing with a clear message when the key does not fit. */
function openEncrypted(file, key) {
  const db = new Database(file);
  applyKey(db, key);
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    db.close();
    if (/not a database|encrypted/i.test(error.message)) {
      throw fail(500, `The database key does not open ${file}. Use the key this database was created with; without it the data cannot be read.`);
    }
    throw error;
  }
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  username TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kiosk_name TEXT,
  welcome TEXT,
  address TEXT,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  end_of_day TEXT,
  logo BLOB,
  logo_type TEXT,
  logo_updated_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS company_sites (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  suite TEXT,
  PRIMARY KEY (company_id, site_id)
);
CREATE INDEX IF NOT EXISTS company_sites_site ON company_sites(site_id);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER REFERENCES sites(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  job_title TEXT,
  email TEXT,
  work_phone TEXT,
  mobile TEXT,
  can_host INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS people_company ON people(company_id);
CREATE INDEX IF NOT EXISTS people_updated ON people(updated_at);

CREATE TABLE IF NOT EXISTS field_definitions (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  choices TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  record_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (entity, key)
);

CREATE TABLE IF NOT EXISTS field_values (
  field_id INTEGER NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (field_id, record_id)
);
CREATE INDEX IF NOT EXISTS field_values_record ON field_values(record_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL DEFAULT 'user',
  built_in INTEGER NOT NULL DEFAULT 0,
  directory TEXT NOT NULL DEFAULT 'read',
  visitors TEXT NOT NULL DEFAULT 'none',
  position INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS field_policies (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  field TEXT NOT NULL,
  access TEXT NOT NULL,
  PRIMARY KEY (role_id, entity, field)
);

CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  organisation TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'staff',
  last_visit_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visitors_verified ON visitors(verified);

CREATE TABLE IF NOT EXISTS visitor_links (
  visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  host_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, company_id)
);
CREATE INDEX IF NOT EXISTS visitor_links_company ON visitor_links(company_id);

CREATE TABLE IF NOT EXISTS kiosks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  token_hash TEXT UNIQUE,
  pairing_hash TEXT UNIQUE,
  pairing_expires_at INTEGER,
  paired_at INTEGER,
  last_seen_at INTEGER,
  last_ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT,
  host_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  host_name TEXT,
  purpose TEXT,
  checked_in_at INTEGER NOT NULL,
  checked_in_by TEXT,
  kiosk_id INTEGER REFERENCES kiosks(id) ON DELETE SET NULL,
  checked_out_at INTEGER,
  checkout_method TEXT,
  checked_out_by TEXT
);
CREATE INDEX IF NOT EXISTS visits_open ON visits(site_id, checked_out_at);
CREATE INDEX IF NOT EXISTS visits_in ON visits(checked_in_at);
CREATE INDEX IF NOT EXISTS visits_visitor ON visits(visitor_id);

CREATE TABLE IF NOT EXISTS api_clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  sites TEXT,
  can_write INTEGER NOT NULL DEFAULT 0,
  key_hash TEXT UNIQUE,
  key_hint TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_ip TEXT
);
CREATE INDEX IF NOT EXISTS companies_updated ON companies(updated_at);

CREATE TABLE IF NOT EXISTS clearance_levels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_classifications (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  requires_clearance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- A badge is its facility code (optional, 2-3 digits, as in CCURE 9000) and its number; the
-- same number may be under several facility codes. Unique together (badgeKeyIndex below).
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL COLLATE NOCASE,
  facility_code TEXT,
  type TEXT NOT NULL,
  classification_id INTEGER REFERENCES badge_classifications(id),
  clearance_level_id INTEGER REFERENCES clearance_levels(id),
  site_id INTEGER REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The sites a badge is valid at; none listed means every site.
CREATE TABLE IF NOT EXISTS badge_sites (
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  PRIMARY KEY (badge_id, site_id)
);
CREATE INDEX IF NOT EXISTS badge_sites_site ON badge_sites(site_id);

CREATE TABLE IF NOT EXISTS badge_assignments (
  id INTEGER PRIMARY KEY,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  holder_kind TEXT NOT NULL,
  holder_id INTEGER NOT NULL,
  holder_name TEXT NOT NULL,
  holder_company TEXT,
  visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  assigned_at INTEGER NOT NULL,
  assigned_by TEXT,
  returned_at INTEGER,
  returned_by TEXT,
  outcome TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS badge_assignments_badge ON badge_assignments(badge_id, assigned_at);
CREATE INDEX IF NOT EXISTS badge_assignments_holder ON badge_assignments(holder_kind, holder_id);
CREATE UNIQUE INDEX IF NOT EXISTS badge_assignments_one_open ON badge_assignments(badge_id) WHERE returned_at IS NULL;

CREATE TABLE IF NOT EXISTS visitor_events (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  host_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visitor_events_day ON visitor_events(site_id, date);

CREATE TABLE IF NOT EXISTS event_guests (
  event_id INTEGER NOT NULL REFERENCES visitor_events(id) ON DELETE CASCADE,
  visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS event_guests_visitor ON event_guests(visitor_id);

-- Requests for the Security role to validate someone's clearance. The last four of an SSN
-- given with one is never stored here (clearance.js keeps it in memory only); had_digits
-- just says some were given.
CREATE TABLE IF NOT EXISTS clearance_requests (
  id INTEGER PRIMARY KEY,
  holder_kind TEXT NOT NULL,
  holder_id INTEGER NOT NULL,
  requested_by TEXT,
  requested_at INTEGER NOT NULL,
  note TEXT,
  had_digits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER,
  level_id INTEGER REFERENCES clearance_levels(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS clearance_requests_open ON clearance_requests(status, holder_kind, holder_id);

-- What a badge of each clearance level looks like, for staff who may not see level names:
-- one image for tenant (and personnel) badges and one for visitor badges per level, and a
-- pair for uncleared badges (level_key 0). ref is random and changes with each upload, so
-- an image's address says nothing about its level.
CREATE TABLE IF NOT EXISTS badge_templates (
  level_key INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  image BLOB NOT NULL,
  image_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (level_key, kind)
);

-- Facilities (facilities.js): each site's floors with a floor plan image, the offices drawn
-- on them (points: their outline as [x, y] fractions of the plan; x, y, w, h: the box around it),
-- the plan's size in pixels and its scale (scale_feet: how many feet its full width spans,
-- from a line of known length, scale_line), which company has each office and when
-- (dates are YYYY-MM-DD; end_date is the last day, NULL for no end), and rates per square
-- foot per month: a site's default, an office's own, and a company's, which wins.
CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  plan BLOB,
  plan_type TEXT,
  plan_ref TEXT UNIQUE,
  plan_width INTEGER,
  plan_height INTEGER,
  scale_feet REAL,
  scale_line TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS floors_name ON floors(site_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS offices (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sqft REAL,
  rate REAL,
  unavailable INTEGER NOT NULL DEFAULT 0,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  points TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS offices_name ON offices(floor_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS office_assignments (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS office_assignments_office ON office_assignments(office_id, start_date);
CREATE INDEX IF NOT EXISTS office_assignments_company ON office_assignments(company_id);

CREATE TABLE IF NOT EXISTS site_rates (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  rate REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Kinds of room (Office, Conference Room, ...), each with a color for the plan and whether it
-- is assigned to companies; and the subcategories of a classified room (SCAR, SCIF). A room with
-- no subcategory is unclassified (its color is the setting facilities.unclassified_color).
CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT NOT NULL,
  assignable INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS company_rates (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  rate REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Columns added after a table first shipped: [table, column, definition]. CREATE TABLE IF NOT
// EXISTS leaves an older table as it was, so these are added when missing.
const ADDED_COLUMNS = [
  ["companies", "building_staff", "INTEGER NOT NULL DEFAULT 0"],
  ["people", "clearance_level_id", "INTEGER REFERENCES clearance_levels(id)"],
  ["people", "clearance_granted", "TEXT"],
  ["people", "clearance_expires", "TEXT"],
  ["visitors", "clearance_level_id", "INTEGER REFERENCES clearance_levels(id)"],
  ["visitors", "clearance_granted", "TEXT"],
  ["visitors", "clearance_expires", "TEXT"],
  ["roles", "badges", "TEXT NOT NULL DEFAULT 'none'"],
  // Temporary badges, lent for a day to someone who forgot theirs.
  ["badges", "temporary", "INTEGER NOT NULL DEFAULT 0"],
  ["badges", "facility_code", "TEXT"],
  ["badge_assignments", "temporary", "INTEGER NOT NULL DEFAULT 0"],
  ["badge_assignments", "replaces_badge_id", "INTEGER REFERENCES badges(id) ON DELETE SET NULL"],
  ["badge_assignments", "due_at", "INTEGER"],
  // Clearance validation by the Security role.
  ["people", "clearance_validated_at", "INTEGER"],
  ["people", "clearance_validated_by", "TEXT"],
  ["visitors", "clearance_validated_at", "INTEGER"],
  ["visitors", "clearance_validated_by", "TEXT"],
  // Which roles see clearance level names (the rest see badge template images).
  ["roles", "clearances", "INTEGER NOT NULL DEFAULT 0"],
  // A kiosk visit staff marked as needing no badge (it then leaves the "needs a badge" banner).
  ["visits", "badge_waived_at", "INTEGER"],
  ["visits", "badge_waived_by", "TEXT"],
  // Facilities: none, read or edit.
  ["roles", "facilities", "TEXT NOT NULL DEFAULT 'none'"],
  // Offices outlined with any number of points, and a floor's scale.
  ["offices", "points", "TEXT"],
  ["floors", "plan_width", "INTEGER"],
  ["floors", "plan_height", "INTEGER"],
  ["floors", "scale_feet", "REAL"],
  ["floors", "scale_line", "TEXT"],
  // Roles that add and change custom fields (Settings > Roles).
  ["roles", "fields", "INTEGER NOT NULL DEFAULT 0"],
  // A room's type and, when classified, its subcategory.
  ["offices", "room_type_id", "INTEGER REFERENCES room_types(id)"],
  ["offices", "class_id", "INTEGER REFERENCES room_classes(id)"],
  // Checking visitors in: their type, citizenship (an ISO country code; US for a U.S.
  // citizen) and a visitor badge reserved for a regular; each visit's stage (id: waiting for
  // the desk to check their ID; badge: waiting for a badge; done) and the ID check; and a
  // badge picked for an expected guest.
  ["visitors", "visitor_type", "TEXT NOT NULL DEFAULT 'Guest'"],
  ["visitors", "citizenship", "TEXT"],
  ["visitors", "reserved_badge_id", "INTEGER REFERENCES badges(id) ON DELETE SET NULL"],
  ["visits", "visitor_type", "TEXT"],
  ["visits", "checkin_stage", "TEXT"],
  ["visits", "id_type", "TEXT"],
  ["visits", "id_verified_at", "INTEGER"],
  ["visits", "id_verified_by", "TEXT"],
  ["event_guests", "badge_id", "INTEGER REFERENCES badges(id) ON DELETE SET NULL"]
];

function addColumns(db) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  // Badges first had one site (badges.site_id); now a list in badge_sites. Moved once.
  db.exec("INSERT OR IGNORE INTO badge_sites (badge_id, site_id) SELECT id, site_id FROM badges WHERE site_id IS NOT NULL; UPDATE badges SET site_id = NULL WHERE site_id IS NOT NULL;");
  rebuildBadges(db);
  db.exec(BADGE_KEY_INDEX);
}

// A badge's number is unique within its facility code (no code counts as one code of its own).
const BADGE_KEY_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS badges_facility_number ON badges (ifnull(facility_code, ''), number COLLATE NOCASE)";

/**
 * Badge numbers were first unique on their own (number ... UNIQUE). SQLite can't drop that
 * from a table, so a table that still has it is rebuilt as the schema now has it, ids kept,
 * once. Foreign keys are off meanwhile (the tables pointing at badges keep pointing at the
 * rebuilt one by name), and checked before the change is kept.
 */
function rebuildBadges(db) {
  const oldUnique = db.prepare("PRAGMA index_list(badges)").all()
    .some((i) => i.origin === "u" && db.prepare(`PRAGMA index_info("${i.name.replace(/"/g, '""')}")`).all().map((c) => c.name).join() === "number");
  if (!oldUnique) return;
  const create = SCHEMA.match(/CREATE TABLE IF NOT EXISTS badges \(([\s\S]*?)\n\);/);
  const columns = db.prepare("PRAGMA table_info(badges)").all().map((c) => c.name);
  const list = columns.map((c) => `"${c}"`).join(", ");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      // The schema's columns, then any added later (ADDED_COLUMNS) that it doesn't list.
      const schemaColumns = create[1].split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
      const extra = db.prepare("PRAGMA table_info(badges)").all().filter((c) => !schemaColumns.includes(c.name))
        .map((c) => `, ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}`).join("");
      db.exec(`CREATE TABLE badges_rebuilt (${create[1]}${extra}\n)`);
      db.exec(`INSERT INTO badges_rebuilt (${list}) SELECT ${list} FROM badges`);
      db.exec("DROP TABLE badges");
      db.exec("ALTER TABLE badges_rebuilt RENAME TO badges");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw fail(500, `Rebuilding the badges table left ${broken.length} broken reference(s); nothing was changed.`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function openDatabase({ dataDir, key, file = DB_FILE }) {
  if (!key) throw fail(500, "No database key was given.");
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, file);
  const db = openEncrypted(filePath, key);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("busy_timeout = 5000");

  const version = db.pragma("user_version", { simple: true });
  if (version > SCHEMA_VERSION) {
    db.close();
    throw fail(500, `${filePath} was written by a newer version of this app (schema ${version}, this version knows ${SCHEMA_VERSION}).`);
  }
  db.exec(SCHEMA);
  addColumns(db);
  if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);

  const transaction = (fn) => db.transaction(fn)();

  // --- documents (accounts, sessions, Entra settings) ---------------------------

  const getDoc = db.prepare("SELECT value FROM documents WHERE name = ?");
  const putDoc = db.prepare("INSERT INTO documents (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");

  /**
   * The JSON document `name`, or `fallback` when there is none. A document that is
   * there but unreadable is an error, not "empty": unreadable accounts must block
   * sign-in rather than reopen first-run setup.
   */
  function readDoc(name, fallback) {
    const row = getDoc.get(name);
    if (!row) return fallback;
    try {
      const value = JSON.parse(row.value);
      return value === null || value === undefined ? fallback : value;
    } catch (error) {
      throw fail(503, `The stored ${name} document is not valid JSON: ${error.message}. Restore a backup; the application will not start over.`);
    }
  }

  function writeDoc(name, value) {
    putDoc.run(name, JSON.stringify(value), Date.now());
  }

  // --- settings --------------------------------------------------------------------

  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const getSetting = (k) => getSettingStmt.get(k)?.value ?? null;
  const setSetting = (k, v) => setSettingStmt.run(k, v === null || v === undefined ? null : String(v));

  // --- audit -----------------------------------------------------------------------

  const auditStmt = db.prepare("INSERT INTO audit (at, username, ip, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)");
  function audit({ username = null, ip = null, action, target = null, detail = null }) {
    auditStmt.run(Date.now(), username, ip, String(action), target === null ? null : String(target).slice(0, 300), detail === null ? null : String(detail).slice(0, 2000));
  }

  function auditLog({ limit = 100, before = null, action = null, username = null } = {}) {
    const where = [];
    const params = [];
    if (before) { where.push("id < ?"); params.push(before); }
    if (action) { where.push("action LIKE ?"); params.push(`${action}%`); }
    if (username) { where.push("username = ?"); params.push(username); }
    const rows = db.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1);
    return { entries: rows.slice(0, limit), more: rows.length > limit };
  }

  // --- backup ------------------------------------------------------------------------

  /**
   * A consistent copy of the database at `target`, encrypted with the same key (VACUUM
   * INTO keeps the cipher), so a backup is as unreadable without the key as the original.
   */
  function backupTo(target) {
    fs.rmSync(target, { force: true });
    db.prepare("VACUUM INTO ?").run(target);
  }

  return {
    raw: db,
    file: filePath,
    transaction,
    readDoc,
    writeDoc,
    getSetting,
    setSetting,
    audit,
    auditLog,
    backupTo,
    close: () => db.close()
  };
}

/**
 * Changes the key of the database at `filePath` from `oldKey` to `newKey`. The app must
 * be stopped first. Returns nothing; throws when the old key does not open the file.
 */
function rekeyDatabase(filePath, oldKey, newKey) {
  const db = openEncrypted(filePath, oldKey);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma(`rekey = "x'${newKey}'"`);
  } finally {
    db.close();
  }
  // Prove the new key opens it before anyone throws the old one away.
  openEncrypted(filePath, newKey).close();
}

module.exports = { openDatabase, openEncrypted, rekeyDatabase, DB_FILE, SCHEMA_VERSION };
