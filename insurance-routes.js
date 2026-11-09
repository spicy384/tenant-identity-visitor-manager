/**
 * Routes for certificates of insurance (insurance.js): seen by those who see facilities or the
 * books, kept by those who change facilities or keep the books (Managers and Finance). Each
 * follows the caller's sites: the companies they see.
 */
const express = require("express");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function str(value, max = 200) {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === null || v === "" ? undefined : String(v).slice(0, max);
}

function positiveInt(value, fallback = null) {
  const n = Number(str(value));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function createInsuranceRoutes({ access, insurance, directory, auditFrom }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const need = (test, message) => (req, res, next) => (test(req.ctx) ? next() : res.status(403).json({ error: message }));
  const seesInsurance = need((ctx) => access.canReadFacilities(ctx) || access.canReadFinance(ctx), "This account can't see certificates of insurance.");
  const editInsurance = need(access.canEditCharges, "This account can't change certificates of insurance.");

  /** The companies the caller sees, at the site asked for if any (a Set of ids), or null when that's every one. */
  function companies(req) {
    const siteId = positiveInt(req.query.site);
    if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
    if (!req.ctx.sites && !siteId) return null;
    return new Set(directory.listCompanies({ sites: req.ctx.sites, siteId, limit: 1000000, includeInactive: true }).records.map((c) => c.id));
  }

  function mustCompany(req, id) {
    const company = directory.getCompany(positiveInt(id), { sites: req.ctx.sites });
    if (!company) throw fail(404, "No such company, or not at your sites.");
    return company;
  }

  function mustCertificate(req) {
    const cert = insurance.get(positiveInt(req.params.id));
    if (!cert || !directory.getCompany(cert.companyId, { sites: req.ctx.sites })) throw fail(404, "No such certificate.");
    return cert;
  }

  const words = (c) => `${c.insurer || "insurer not given"}, expires ${c.expiresOn}${c.file ? `; copy ${c.file.name}` : ""}`;

  /** Every tenant's cover: status (current, expiring, expired, none, attention: any but current, or soon: expiring or expired lately), words. */
  router.get("/api/insurance", seesInsurance, (req, res) => {
    res.json({ companies: insurance.overview({ companies: companies(req), status: str(req.query.status, 20) || null, q: str(req.query.q) || "" }) });
  });

  /** Tenants with an office now whose cover has run out, runs out soon or isn't on file. */
  router.get("/api/insurance/attention", seesInsurance, (req, res) => {
    res.json({ companies: insurance.needingAttention({ companies: companies(req) }) });
  });

  router.get("/api/companies/:id/insurance", seesInsurance, (req, res) => {
    const company = mustCompany(req, req.params.id);
    res.json({ certificates: insurance.forCompany(company.id) });
  });

  router.post("/api/companies/:id/insurance", editInsurance, (req, res) => {
    const company = mustCompany(req, req.params.id);
    const cert = insurance.create(company.id, req.body || {}, { by: staffName(req) });
    auditFrom(req, "insurance.add", company.name, words(cert));
    res.json({ ok: true, certificate: cert });
  });

  router.put("/api/insurance/:id", editInsurance, (req, res) => {
    mustCertificate(req);
    const cert = insurance.update(positiveInt(req.params.id), req.body || {}, { by: staffName(req) });
    auditFrom(req, "insurance.update", cert.companyName, words(cert));
    res.json({ ok: true, certificate: cert });
  });

  router.delete("/api/insurance/:id", editInsurance, (req, res) => {
    mustCertificate(req);
    const cert = insurance.remove(positiveInt(req.params.id));
    auditFrom(req, "insurance.remove", cert.companyName, words(cert));
    res.json({ ok: true });
  });

  /** A certificate's copy, shown in the browser: only a PDF or an image, checked when it came in, and taken as nothing else. */
  router.get("/api/insurance/files/:ref", seesInsurance, (req, res) => {
    const file = insurance.fileByRef(str(req.params.ref, 64));
    const company = file && directory.getCompany(file.companyId, { sites: req.ctx.sites });
    if (!company) throw fail(404, "No such file.");
    auditFrom(req, "insurance.file_open", company.name, file.name);
    res.set({
      "Content-Type": file.type,
      "Content-Length": String(file.data.length),
      "Content-Disposition": `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    });
    res.end(file.data);
  });

  return router;
}

module.exports = { createInsuranceRoutes };
