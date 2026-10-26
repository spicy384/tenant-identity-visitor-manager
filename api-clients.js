/**
 * API clients: other systems (Equipment Checkout first) that read the directory with a
 * key. Each has its own role (access.js), so its own column of fields; the sites it may
 * see; and whether it may add people and companies.
 *
 * A key looks like ivm_<id>_<secret>. Only a hash of the secret is stored, with its first
 * characters as a hint; the whole key is shown once, when it is made.
 */
const crypto = require("crypto");

const KEY_RE = /^ivm_(\d+)_([A-Za-z0-9_-]{40,})$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function createApiClients({ db, access, sites, now = Date.now }) {
  const raw = db.raw;

  function row(r) {
    return r && {
      id: r.id,
      name: r.name,
      roleId: r.role_id,
      sites: r.sites ? JSON.parse(r.sites) : null,
      canWrite: Boolean(r.can_write),
      keyHint: r.key_hint,
      hasKey: Boolean(r.key_hash),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      lastIp: r.last_ip
    };
  }

  function list() {
    return raw.prepare("SELECT * FROM api_clients ORDER BY name").all().map(row);
  }

  function get(id) {
    return row(raw.prepare("SELECT * FROM api_clients WHERE id = ?").get(id));
  }

  function cleanName(name, exceptId = null) {
    const s = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!s) throw fail(400, "Give the client a name, such as \"Equipment Checkout, Harbor Point\".");
    const clash = raw.prepare("SELECT id FROM api_clients WHERE name = ?").get(s);
    if (clash && clash.id !== exceptId) throw fail(409, "An API client with that name already exists.");
    return s;
  }

  /** null for every site, else a non-empty list of existing site ids. */
  function cleanSites(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || !value.length) throw fail(400, "Choose at least one site, or every site.");
    const ids = [...new Set(value.map(Number))];
    for (const id of ids) if (!Number.isInteger(id) || !sites.get(id)) throw fail(400, "One of the chosen sites does not exist.");
    return ids;
  }

  function issueKey(id) {
    const secret = crypto.randomBytes(32).toString("base64url");
    raw.prepare("UPDATE api_clients SET key_hash = ?, key_hint = ? WHERE id = ?").run(hash(secret), `ivm_${id}_${secret.slice(0, 4)}…`, id);
    return `ivm_${id}_${secret}`;
  }

  /** Adds a client; returns it with its key (shown once). */
  function create({ name, sites: siteIds = null, canWrite = false }) {
    const clean = cleanName(name);
    const limit = cleanSites(siteIds);
    let id;
    let key;
    db.transaction(() => {
      const role = access.createApiRole(clean, { canWrite: Boolean(canWrite) });
      id = raw.prepare("INSERT INTO api_clients (name, role_id, sites, can_write, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(clean, role.id, limit ? JSON.stringify(limit) : null, canWrite ? 1 : 0, now()).lastInsertRowid;
      key = issueKey(id);
    });
    return { client: get(id), key };
  }

  function update(id, { name, sites: siteIds, canWrite } = {}) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such API client.");
    const next = { ...existing };
    if (name !== undefined) next.name = cleanName(name, id);
    if (siteIds !== undefined) next.sites = cleanSites(siteIds);
    if (canWrite !== undefined) next.canWrite = Boolean(canWrite);
    db.transaction(() => {
      raw.prepare("UPDATE api_clients SET name = ?, sites = ?, can_write = ? WHERE id = ?").run(next.name, next.sites ? JSON.stringify(next.sites) : null, next.canWrite ? 1 : 0, id);
      access.updateApiRole(existing.roleId, { clientName: next.name, canWrite: next.canWrite });
    });
    return get(id);
  }

  /** A new key; the old one stops working at once. */
  function newKey(id) {
    if (!get(id)) throw fail(404, "No such API client.");
    return { client: get(id), key: issueKey(id) };
  }

  function remove(id) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such API client.");
    db.transaction(() => {
      raw.prepare("DELETE FROM api_clients WHERE id = ?").run(id);
      access.deleteApiRole(existing.roleId);
    });
    return existing;
  }

  /** The client a key belongs to, or null. Notes when it was last used. */
  function authenticate(key, ip = null) {
    const m = KEY_RE.exec(String(key || ""));
    if (!m) return null;
    const r = raw.prepare("SELECT * FROM api_clients WHERE id = ?").get(Number(m[1]));
    if (!r || !r.key_hash) return null;
    const a = Buffer.from(hash(m[2]));
    const b = Buffer.from(r.key_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (!r.last_used_at || now() - r.last_used_at > 60 * 1000 || r.last_ip !== ip) {
      raw.prepare("UPDATE api_clients SET last_used_at = ?, last_ip = ? WHERE id = ?").run(now(), ip, r.id);
    }
    return row(r);
  }

  return { list, get, create, update, newKey, remove, authenticate };
}

module.exports = { createApiClients };
