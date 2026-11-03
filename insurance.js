/**
 * Certificates of insurance: each company's, with the insurer, the dates the cover runs
 * (expiresOn: the earliest policy on the certificate, its last day), what it covers, and a copy
 * of the certificate (stored-files.js).
 *
 * A company's cover is its certificate that runs latest. Its status: current, expiring (within
 * EXPIRING_DAYS), expired, or none (no certificate on file).
 */
const { dateInput, text } = require("./leases");
const { decodeFile } = require("./stored-files");

const EXPIRING_DAYS = 30;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

function createInsurance({ db, files, today, now = Date.now }) {
  const raw = db.raw;

  const statusOf = (expiresOn, day = today()) => {
    if (!expiresOn) return "none";
    if (expiresOn < day) return "expired";
    return dayNumber(expiresOn) - dayNumber(day) <= EXPIRING_DAYS ? "expiring" : "current";
  };

  const SELECT = "SELECT i.*, c.name AS company_name FROM insurance_certificates i JOIN companies c ON c.id = i.company_id";

  function out(r, day = today()) {
    if (!r) return null;
    const file = files.info(r.file_id);
    return {
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_name,
      insurer: r.insurer || null,
      effectiveDate: r.effective_date || null,
      expiresOn: r.expires_on,
      status: statusOf(r.expires_on, day),
      daysLeft: dayNumber(r.expires_on) - dayNumber(day),
      coverage: r.coverage || null,
      notes: r.notes || null,
      file: file ? { ref: file.ref, name: file.name, type: file.type, size: file.size } : null,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
      updatedBy: r.updated_by || null,
      updatedAt: r.updated_at
    };
  }

  const get = (id) => out(raw.prepare(`${SELECT} WHERE i.id = ?`).get(Number(id)));

  /** A company's certificates, the one that runs latest first. */
  function forCompany(companyId) {
    const day = today();
    return raw.prepare(`${SELECT} WHERE i.company_id = ? ORDER BY i.expires_on DESC, i.id DESC`).all(Number(companyId)).map((r) => out(r, day));
  }

  /**
   * Each active company's cover (the certificate that runs latest), for the companies a caller
   * sees (a Set of ids, or null for every one), of a status, or matching words. withOffices:
   * only those with an office now.
   */
  function overview({ companies = null, status = null, q = "", withOffices = false } = {}) {
    const day = today();
    const rows = raw.prepare(`SELECT c.id, c.name,
        (SELECT i.id FROM insurance_certificates i WHERE i.company_id = c.id ORDER BY i.expires_on DESC, i.id DESC LIMIT 1) AS cert_id,
        (SELECT count(*) FROM insurance_certificates i WHERE i.company_id = c.id) AS certs,
        EXISTS (SELECT 1 FROM office_assignments a WHERE a.company_id = c.id AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)) AS has_office
      FROM companies c WHERE c.active = 1 ORDER BY c.name COLLATE NOCASE`).all(day, day);
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .filter((r) => (!companies || companies.has(r.id)) && (!withOffices || r.has_office))
      .map((r) => {
        const cert = r.cert_id ? get(r.cert_id) : null;
        return { companyId: r.id, companyName: r.name, hasOffice: Boolean(r.has_office), certificates: r.certs, status: cert ? cert.status : "none", certificate: cert };
      })
      .filter((c) => (!status || (status === "attention" ? ["expired", "expiring", "none"].includes(c.status) : c.status === status))
        && words.every((w) => [c.companyName, c.certificate?.insurer].some((s) => String(s || "").toLowerCase().includes(w))));
  }

  /** Companies with an office now whose cover has run out, runs out soon, or isn't on file: for Home. */
  function needingAttention({ companies = null } = {}) {
    const list = overview({ companies, status: "attention", withOffices: true });
    const order = { expired: 0, none: 1, expiring: 2 };
    return list.sort((a, b) => order[a.status] - order[b.status] || (a.certificate?.expiresOn || "").localeCompare(b.certificate?.expiresOn || "") || a.companyName.localeCompare(b.companyName));
  }

  function clean(input, existing = null) {
    const v = {};
    if (input.insurer !== undefined) v.insurer = text(input.insurer, 120);
    if (input.effectiveDate !== undefined) v.effectiveDate = dateInput(input.effectiveDate, "date the cover starts", { optional: true });
    if (input.expiresOn !== undefined || !existing) v.expiresOn = dateInput(input.expiresOn, "expiration date");
    if (input.coverage !== undefined) v.coverage = text(input.coverage, 1000);
    if (input.notes !== undefined) v.notes = text(input.notes, 2000);
    const starts = v.effectiveDate !== undefined ? v.effectiveDate : existing?.effectiveDate;
    const ends = v.expiresOn ?? existing?.expiresOn;
    if (starts && ends && ends < starts) throw fail(400, "The expiration date is before the date the cover starts.");
    // A new copy, checked before anything is written.
    if (input.file && typeof input.file === "object") v.file = decodeFile(input.file.dataUrl, input.file.name, "The certificate");
    return v;
  }

  /** A new certificate for a company, with its copy if given. */
  function create(companyId, input = {}, { by = null } = {}) {
    const company = raw.prepare("SELECT id FROM companies WHERE id = ?").get(Number(companyId));
    if (!company) throw fail(404, "No such company.");
    const v = clean(input);
    let id;
    db.transaction(() => {
      const fileId = v.file ? files.save(v.file, { by }).id : null;
      const t = now();
      id = raw.prepare(`INSERT INTO insurance_certificates (company_id, insurer, effective_date, expires_on, coverage, notes, file_id, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, v.insurer ?? null, v.effectiveDate ?? null, v.expiresOn, v.coverage ?? null, v.notes ?? null, fileId, by, t, by, t).lastInsertRowid;
    });
    return get(id);
  }

  /** Changes a certificate; a new file replaces its copy, and removeFile: true takes the copy away. */
  function update(id, input = {}, { by = null } = {}) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such certificate.");
    const v = clean(input, existing);
    const row = raw.prepare("SELECT file_id FROM insurance_certificates WHERE id = ?").get(existing.id);
    db.transaction(() => {
      let fileId = row.file_id;
      if (v.file || input.removeFile === true) {
        files.remove(fileId);
        fileId = v.file ? files.save(v.file, { by }).id : null;
      }
      const pick = (k) => (v[k] !== undefined ? v[k] : existing[k]);
      raw.prepare("UPDATE insurance_certificates SET insurer = ?, effective_date = ?, expires_on = ?, coverage = ?, notes = ?, file_id = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(pick("insurer"), pick("effectiveDate"), pick("expiresOn"), pick("coverage"), pick("notes"), fileId, by, now(), existing.id);
    });
    return get(existing.id);
  }

  /** Deletes a certificate and its copy. */
  function remove(id) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such certificate.");
    const row = raw.prepare("SELECT file_id FROM insurance_certificates WHERE id = ?").get(existing.id);
    db.transaction(() => {
      raw.prepare("DELETE FROM insurance_certificates WHERE id = ?").run(existing.id);
      files.remove(row.file_id);
    });
    return existing;
  }

  /** A certificate's copy, by its ref, with the company it belongs to. */
  function fileByRef(ref) {
    const file = files.byRef(ref);
    if (!file) return null;
    const cert = raw.prepare("SELECT company_id FROM insurance_certificates WHERE file_id = ?").get(file.id);
    return cert ? { ...file, companyId: cert.company_id } : null;
  }

  return { get, forCompany, overview, needingAttention, create, update, remove, fileByRef, statusOf };
}

module.exports = { createInsurance, EXPIRING_DAYS };
