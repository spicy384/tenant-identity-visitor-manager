/**
 * Kiosk devices. An administrator adds a kiosk for a site and gets a one-time pairing
 * code; the iPad opens /kiosk, enters it and receives a long-lived device token in a
 * cookie. Only hashes of the code and token are stored. A new pairing code (or revoking
 * the kiosk) ends the old token, so a lost iPad stops working at once.
 */
const crypto = require("crypto");

const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
// No 0/O, 1/I/L: the code is read off one screen and typed on another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** "K7QM-4P2X": eight characters from the unambiguous alphabet. */
function newPairingCode() {
  let code = "";
  for (const b of crypto.randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A typed code in canonical form: upper case, no spaces or dashes, the dash put back. */
function normalizeCode(input) {
  const s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function createKiosks({ db, now = Date.now }) {
  const raw = db.raw;

  function row(r) {
    if (!r) return null;
    const pending = Boolean(r.pairing_hash && r.pairing_expires_at > now());
    return {
      id: r.id,
      name: r.name,
      siteId: r.site_id,
      siteName: r.site_name,
      status: r.token_hash ? "paired" : pending ? "waiting" : "not paired",
      pairingExpiresAt: pending ? r.pairing_expires_at : null,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at,
      lastIp: r.last_ip,
      createdAt: r.created_at
    };
  }

  const SELECT = "SELECT k.*, s.name AS site_name FROM kiosks k JOIN sites s ON s.id = k.site_id";

  function list() {
    return raw.prepare(`${SELECT} ORDER BY s.name, k.name`).all().map(row);
  }

  function get(id) {
    return row(raw.prepare(`${SELECT} WHERE k.id = ?`).get(id));
  }

  function checkSite(siteId) {
    const site = raw.prepare("SELECT * FROM sites WHERE id = ?").get(Number(siteId));
    if (!site) throw fail(400, "Choose the kiosk's site.");
    return site.id;
  }

  function cleanName(name) {
    const s = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!s) throw fail(400, "Give the kiosk a name, such as \"Lobby iPad\".");
    return s;
  }

  /** A fresh pairing code for kiosk `id`; any device paired before stops working. */
  function issuePairing(id) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newPairingCode();
      try {
        raw.prepare("UPDATE kiosks SET pairing_hash = ?, pairing_expires_at = ?, token_hash = NULL, paired_at = NULL WHERE id = ?").run(hash(code), now() + PAIRING_TTL_MS, id);
        return code;
      } catch (error) {
        if (!/UNIQUE/.test(error.message)) throw error;
      }
    }
    throw fail(500, "Could not make a pairing code; try again.");
  }

  /** Adds a kiosk; returns it with its first pairing code (shown once). */
  function create({ name, siteId }) {
    const info = raw.prepare("INSERT INTO kiosks (name, site_id, created_at) VALUES (?, ?, ?)").run(cleanName(name), checkSite(siteId), now());
    const code = issuePairing(info.lastInsertRowid);
    return { kiosk: get(info.lastInsertRowid), code };
  }

  function update(id, { name, siteId } = {}) {
    const k = get(id);
    if (!k) throw fail(404, "No such kiosk.");
    raw.prepare("UPDATE kiosks SET name = ?, site_id = ? WHERE id = ?").run(name !== undefined ? cleanName(name) : k.name, siteId !== undefined ? checkSite(siteId) : k.siteId, id);
    return get(id);
  }

  function newCode(id) {
    if (!get(id)) throw fail(404, "No such kiosk.");
    const code = issuePairing(id);
    return { kiosk: get(id), code };
  }

  /** Removes a kiosk. Its visits keep their record; they just no longer name the kiosk. */
  function remove(id) {
    const k = get(id);
    if (!k) throw fail(404, "No such kiosk.");
    raw.prepare("DELETE FROM kiosks WHERE id = ?").run(id);
    return k;
  }

  /** Exchanges a pairing code for a device token; null when the code is wrong or expired. */
  function pair(code, ip = null) {
    const r = raw.prepare("SELECT * FROM kiosks WHERE pairing_hash = ?").get(hash(normalizeCode(code)));
    if (!r || !(r.pairing_expires_at > now())) return null;
    const token = crypto.randomBytes(32).toString("base64url");
    raw.prepare("UPDATE kiosks SET token_hash = ?, pairing_hash = NULL, pairing_expires_at = NULL, paired_at = ?, last_seen_at = ?, last_ip = ? WHERE id = ?").run(hash(token), now(), now(), ip, r.id);
    return { token, kiosk: get(r.id) };
  }

  /** The kiosk a device token belongs to, or null. Notes when it was last seen. */
  function authenticate(token, ip = null) {
    if (!token) return null;
    const r = raw.prepare(`${SELECT} WHERE k.token_hash = ?`).get(hash(token));
    if (!r) return null;
    // Written at most once a minute: the kiosk asks often.
    if (!r.last_seen_at || now() - r.last_seen_at > 60 * 1000 || r.last_ip !== ip) {
      raw.prepare("UPDATE kiosks SET last_seen_at = ?, last_ip = ? WHERE id = ?").run(now(), ip, r.id);
    }
    return row(r);
  }

  return { list, get, create, update, newCode, remove, pair, authenticate };
}

module.exports = { createKiosks, newPairingCode, normalizeCode };
