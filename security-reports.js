/**
 * Security's mail, kept: alarm notices and guard daily activity reports (read by
 * security-mail.js), whether they came from the shared mailbox (security-mailbox.js) or were
 * dropped in by hand. Each email is kept once, by its Message-ID (else a hash of what it
 * holds), so the mailbox and a file of the same email don't make two.
 *
 * Alarms and reports are unread until someone opens them, like mail: read_at and read_by say
 * when and who. They are kept for `keepDays` (Settings > Security mail), then deleted.
 *
 * Sites: an alarm account, or the site name on a guard report, is placed at one of the app's
 * sites under Settings (security_sources). Staff limited to some sites see what is placed at
 * theirs; what isn't placed anywhere yet only staff who see every site.
 */
const crypto = require("crypto");
const { classify } = require("./security-mail");

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = { alarm: "security_alarms", guard: "guard_reports" };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createSecurityReports({ db, now = Date.now }) {
  const raw = db.raw;

  /** Who an email is: its Message-ID, else a hash of its subject, sender, time and contents. */
  function messageKey(message, pdf = null) {
    if (message.messageId) return String(message.messageId).trim().slice(0, 500);
    const h = crypto.createHash("sha256");
    h.update(String(message.subject || ""));
    h.update("\0");
    h.update(String(message.from || ""));
    h.update("\0");
    h.update(String(message.html || message.text || ""));
    if (pdf) h.update(pdf);
    return `sha256:${h.digest("hex")}`;
  }

  /** Notes an alarm account or guard site the first time it is seen, for Settings to place. */
  function noteSource(kind, key, label) {
    if (!key) return;
    // With only one site, that is where it is.
    const only = raw.prepare("SELECT id FROM sites").all();
    raw.prepare("INSERT OR IGNORE INTO security_sources (kind, key, label, site_id, first_seen) VALUES (?, ?, ?, ?, ?)").run(kind, key, label || null, only.length === 1 ? only[0].id : null, now());
    // A name given under Settings stays; one only from the mail is filled in.
    if (label) raw.prepare("UPDATE security_sources SET label = ? WHERE kind = ? AND key = ? AND label IS NULL").run(label, kind, key);
  }

  /**
   * Keeps a message if it is an alarm notice or a guard report: { kind, id, duplicate } or,
   * for anything else, { kind: null, reason }. source: "mailbox" or "upload".
   */
  function ingest(message, { source = "upload" } = {}) {
    const found = classify(message);
    if (!found.kind) return { kind: null, reason: found.reason };
    const receivedAt = Number(message.receivedAt) || now();
    if (found.kind === "alarm") {
      const a = found.alarm;
      const key = messageKey(message);
      const had = raw.prepare("SELECT id FROM security_alarms WHERE message_key = ?").get(key);
      if (had) return { kind: "alarm", id: had.id, duplicate: true };
      let id;
      db.transaction(() => {
        noteSource("alarm", a.account, a.accountName);
        id = raw.prepare(`INSERT INTO security_alarms (message_key, received_at, account, account_name, event, zone, zone_name, data, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, receivedAt, a.account, a.accountName, a.event, a.zone, a.zoneName, JSON.stringify({ ...a, subject: message.subject || null }), source, now()).lastInsertRowid;
      });
      return { kind: "alarm", id, duplicate: false };
    }
    const r = found.report;
    const key = messageKey(message, found.pdf);
    const had = raw.prepare("SELECT id FROM guard_reports WHERE message_key = ?").get(key);
    if (had) return { kind: "guard", id: had.id, duplicate: true };
    let id;
    db.transaction(() => {
      noteSource("guard", r.site, r.site);
      id = raw.prepare(`INSERT INTO guard_reports (message_key, received_at, report_date, site_name, company, data, pdf, pdf_name, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, receivedAt, r.date, r.site, r.company, JSON.stringify({ ...r, subject: message.subject || null }), found.pdf, found.pdfName, source, now()).lastInsertRowid;
    });
    return { kind: "guard", id, duplicate: false };
  }

  // --- reading -----------------------------------------------------------------------------------

  /** SQL (alias x, sources s) limiting rows to `sites` (a Set), or nothing when unlimited. */
  function scope(sites) {
    if (!sites) return { sql: "", params: [] };
    const ids = [...sites];
    return { sql: ids.length ? `s.site_id IN (${ids.map(() => "?").join(", ")})` : "0", params: ids };
  }

  const join = (kind) => (kind === "alarm"
    ? "LEFT JOIN security_sources s ON s.kind = 'alarm' AND s.key = x.account"
    : "LEFT JOIN security_sources s ON s.kind = 'guard' AND s.key = x.site_name");

  /** The text an alarm or report is found by. */
  const SEARCH = {
    alarm: "coalesce(x.account, '') || ' ' || coalesce(x.account_name, '') || ' ' || coalesce(x.event, '') || ' ' || coalesce(x.zone, '') || ' ' || coalesce(x.zone_name, '') || ' ' || x.data",
    guard: "coalesce(x.site_name, '') || ' ' || coalesce(x.company, '') || ' ' || x.data"
  };

  function where(kind, { q = "", unread = false, siteId = null, sites = null } = {}) {
    const parts = [];
    const params = [];
    const sc = scope(sites);
    if (sc.sql) { parts.push(sc.sql); params.push(...sc.params); }
    if (siteId) { parts.push("s.site_id = ?"); params.push(Number(siteId)); }
    if (unread) parts.push("x.read_at IS NULL");
    for (const word of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      parts.push(`(${SEARCH[kind]}) LIKE ? ESCAPE '\\'`);
      params.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }

  const siteName = (id) => (id ? raw.prepare("SELECT name FROM sites WHERE id = ?").get(id)?.name || null : null);

  /** An alarm for a list: what it was, where, and what it came to. */
  function alarmRow(r, full = false) {
    const data = JSON.parse(r.data);
    const s = data.summary || {};
    const out = {
      id: r.id,
      receivedAt: r.received_at,
      when: data.when || null,
      account: r.account,
      accountName: r.account_name,
      event: r.event,
      zone: r.zone,
      zoneName: r.zone_name,
      area: data.area || null,
      siteId: r.site_id ?? null,
      siteName: siteName(r.site_id),
      read: Boolean(r.read_at),
      readAt: r.read_at,
      readBy: r.read_by,
      source: r.source,
      outcome: {
        disarmedBy: s.disarmedBy || null,
        verifiedBy: s.verified?.[0]?.who || null,
        dispatch: s.dispatch || null,
        cleared: Boolean(s.clearedAt)
      }
    };
    return full ? { ...out, alarm: data } : out;
  }

  function reportRow(r, full = false) {
    const data = JSON.parse(r.data);
    const s = data.summary || {};
    const out = {
      id: r.id,
      receivedAt: r.received_at,
      date: r.report_date,
      range: data.range || null,
      site: r.site_name,
      company: r.company,
      siteId: r.site_id ?? null,
      siteName: siteName(r.site_id),
      officers: s.officers || [],
      counts: data.counts || {},
      reports: s.reports?.length || 0,
      tours: s.tours?.length || 0,
      incidents: s.incidents?.length || 0,
      missed: s.missed?.length || 0,
      answeredNo: s.answeredNo?.length || 0,
      hasPdf: Boolean(r.has_pdf),
      read: Boolean(r.read_at),
      readAt: r.read_at,
      readBy: r.read_by,
      source: r.source
    };
    return full ? { ...out, report: data } : out;
  }

  // A guard report's columns but its PDF (read only to send it).
  const columns = (kind) => (kind === "guard" ? "x.id, x.received_at, x.report_date, x.site_name, x.company, x.data, x.read_at, x.read_by, x.source, x.pdf IS NOT NULL AS has_pdf" : "x.*");

  function list(kind, { limit = 50, offset = 0, ...filters } = {}) {
    const table = KINDS[kind];
    const w = where(kind, filters);
    const cols = columns(kind);
    const total = raw.prepare(`SELECT count(*) AS n FROM ${table} x ${join(kind)} ${w.sql}`).get(...w.params).n;
    const rows = raw.prepare(`SELECT ${cols}, s.site_id FROM ${table} x ${join(kind)} ${w.sql} ORDER BY x.received_at DESC, x.id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, Math.min(Math.max(Number(limit) || 50, 1), 500), Math.max(Number(offset) || 0, 0));
    return { items: rows.map((r) => (kind === "alarm" ? alarmRow(r) : reportRow(r))), total };
  }

  /** One alarm or report, whole, if the caller may see it (null otherwise). */
  function get(kind, id, { sites = null } = {}) {
    const w = where(kind, { sites });
    const r = raw.prepare(`SELECT ${columns(kind)}, s.site_id FROM ${KINDS[kind]} x ${join(kind)} ${w.sql ? `${w.sql} AND` : "WHERE"} x.id = ?`).get(...w.params, Number(id));
    if (!r) return null;
    return kind === "alarm" ? alarmRow(r, true) : reportRow(r, true);
  }

  /** A guard report's original PDF: { data, name } or null. */
  function pdf(id, { sites = null } = {}) {
    const w = where("guard", { sites });
    const r = raw.prepare(`SELECT x.pdf, x.pdf_name FROM guard_reports x ${join("guard")} ${w.sql ? `${w.sql} AND` : "WHERE"} x.id = ?`).get(...w.params, Number(id));
    return r?.pdf ? { data: r.pdf, name: r.pdf_name || "report.pdf" } : null;
  }

  /** Marks one read (the first time only: who first read it stays) or unread again. */
  function setRead(kind, id, read, { by = null, sites = null } = {}) {
    const item = get(kind, id, { sites });
    if (!item) throw fail(404, kind === "alarm" ? "No such alarm." : "No such report.");
    if (read && !item.read) raw.prepare(`UPDATE ${KINDS[kind]} SET read_at = ?, read_by = ? WHERE id = ?`).run(now(), by, item.id);
    if (!read) raw.prepare(`UPDATE ${KINDS[kind]} SET read_at = NULL, read_by = NULL WHERE id = ?`).run(item.id);
    return get(kind, id, { sites });
  }

  /** How many the caller hasn't seen opened: { alarms, reports }. */
  function unread({ sites = null } = {}) {
    const count = (kind) => {
      const w = where(kind, { sites, unread: true });
      return raw.prepare(`SELECT count(*) AS n FROM ${KINDS[kind]} x ${join(kind)} ${w.sql}`).get(...w.params).n;
    };
    return { alarms: count("alarm"), reports: count("guard") };
  }

  // --- where they are ------------------------------------------------------------------------------

  /** Every alarm account and guard site seen, with the site it is placed at and how many there are. */
  function sources() {
    return raw.prepare(`SELECT s.*, (SELECT name FROM sites WHERE id = s.site_id) AS site_name,
        CASE s.kind WHEN 'alarm' THEN (SELECT count(*) FROM security_alarms WHERE account = s.key) ELSE (SELECT count(*) FROM guard_reports WHERE site_name = s.key) END AS n
      FROM security_sources s ORDER BY s.kind, s.label COLLATE NOCASE, s.key`).all()
      .map((s) => ({ kind: s.kind, key: s.key, label: s.label, siteId: s.site_id, siteName: s.site_name, count: s.n, firstSeen: s.first_seen }));
  }

  const cleanKind = (kind) => {
    if (!KINDS[kind]) throw fail(400, "That isn't an alarm account or a guard report site.");
    return kind;
  };
  /** A site id from input: null for none, else an existing site. */
  const siteFrom = (siteId) => {
    if (siteId === null || siteId === undefined || siteId === "") return null;
    const site = raw.prepare("SELECT id, name FROM sites WHERE id = ?").get(Number(siteId));
    if (!site) throw fail(400, "That site doesn't exist.");
    return site;
  };
  const cleanLabel = (label) => String(label ?? "").trim().replace(/\s+/g, " ").slice(0, 120) || null;
  const sourceOut = (kind, key) => sources().find((x) => x.kind === kind && x.key.toLowerCase() === String(key).toLowerCase());

  /**
   * Adds an alarm account (or a guard report's site name) before anything has come from it,
   * so its alarms are at the right site from the first: { kind, key (the account number),
   * label (a name for it), siteId }. A site may have any number of accounts.
   */
  function addSource({ kind = "alarm", key, label = null, siteId = null } = {}) {
    cleanKind(kind);
    const k = String(key ?? "").trim();
    if (kind === "alarm" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(k)) throw fail(400, "Give the account number as the monitoring center writes it (letters and digits, such as K1234567).");
    if (kind === "guard" && !k) throw fail(400, "Give the site's name as the guard reports write it.");
    if (raw.prepare("SELECT 1 FROM security_sources WHERE kind = ? AND key = ?").get(kind, k)) throw fail(409, kind === "alarm" ? `Account ${k} is listed already.` : `${k} is listed already.`);
    const site = siteFrom(siteId);
    raw.prepare("INSERT INTO security_sources (kind, key, label, site_id, first_seen) VALUES (?, ?, ?, ?, ?)").run(kind, k, cleanLabel(label), site ? site.id : null, now());
    return sourceOut(kind, k);
  }

  /** Changes an account's (or guard site's) name or site: { label, siteId }, either or both. */
  function updateSource(kind, key, { label, siteId } = {}) {
    cleanKind(kind);
    const s = raw.prepare("SELECT * FROM security_sources WHERE kind = ? AND key = ?").get(kind, String(key || ""));
    if (!s) throw fail(404, kind === "alarm" ? "There is no such alarm account." : "There is no such guard report site.");
    if (siteId !== undefined) raw.prepare("UPDATE security_sources SET site_id = ? WHERE kind = ? AND key = ?").run(siteFrom(siteId)?.id ?? null, kind, s.key);
    if (label !== undefined) raw.prepare("UPDATE security_sources SET label = ? WHERE kind = ? AND key = ?").run(cleanLabel(label), kind, s.key);
    return sourceOut(kind, s.key);
  }

  const placeSource = (kind, key, siteId) => updateSource(kind, key, { siteId });

  /**
   * Takes an account (or guard site) off the list. Its alarms stay, but aren't at a site any
   * more; if another comes from it, it is listed again, not placed.
   */
  function removeSource(kind, key) {
    cleanKind(kind);
    const s = sourceOut(kind, String(key || ""));
    if (!s) throw fail(404, kind === "alarm" ? "There is no such alarm account." : "There is no such guard report site.");
    raw.prepare("DELETE FROM security_sources WHERE kind = ? AND key = ?").run(kind, s.key);
    return s;
  }

  /** Deletes what came in more than `keepDays` ago: { alarms, reports }. */
  function sweep(keepDays) {
    const days = Number(keepDays);
    if (!Number.isInteger(days) || days < 1) return { alarms: 0, reports: 0 };
    const before = now() - days * DAY_MS;
    return {
      alarms: raw.prepare("DELETE FROM security_alarms WHERE received_at < ?").run(before).changes,
      reports: raw.prepare("DELETE FROM guard_reports WHERE received_at < ?").run(before).changes
    };
  }

  return { ingest, list, get, pdf, setRead, unread, sources, addSource, updateSource, placeSource, removeSource, sweep, messageKey };
}

module.exports = { createSecurityReports };
