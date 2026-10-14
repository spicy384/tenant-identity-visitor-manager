/**
 * The API other systems use, under /api/v1, with a key in the Authorization header
 * (Bearer ivm_...). Equipment Checkout is the first client.
 *
 * A client sees only the companies at its sites, and their people who work there or at
 * any site; and only the fields its column of the field access grid allows (Settings >
 * API clients). Everything goes through the same projection as the staff pages.
 *
 * GET  /api/v1/whoami         who the key belongs to: sites, write access, fields
 * GET  /api/v1/sync?since=ms  companies and people changed since then, and the ids of
 *                             everyone visible now (so a client can tell who has gone)
 * GET  /api/v1/companies      ?q= ?updated_since=
 * GET  /api/v1/people         ?q= ?updated_since= ?companyId=
 * GET  /api/v1/people/:id
 * POST /api/v1/people         clients allowed to write; { match: true } returns a person
 *                             already in that company with the same email or name instead
 * POST /api/v1/companies      clients allowed to write; { match: true } likewise, by name
 */
const crypto = require("crypto");
const express = require("express");
const { createRateLimiter } = require("./rate-limit");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function str(value, max = 200) {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === null || v === "" ? undefined : String(v).slice(0, max);
}

function createApiV1({ db, access, directory, sites, apiClients }) {
  const router = express.Router();
  const limiter = createRateLimiter({ maxFailures: 20 });

  /** The client a request's key belongs to, as req.client and req.ctx; 401 otherwise. */
  router.use((req, res, next) => {
    const key = limiter.clientAddress(req);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return res.status(429).json({ error: "Too many requests with a wrong key." });
    }
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
    const client = m ? apiClients.authenticate(m[1], req.ip || null) : null;
    if (!client) {
      limiter.recordFailure(key);
      return res.status(401).json({ error: "A valid API key is required (Authorization: Bearer ivm_...)." });
    }
    req.client = client;
    req.ctx = access.contextFor({ role: client.roleId, sites: client.sites });
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  function audit(req, action, target, detail = null) {
    try {
      db.audit({ username: `api:${req.client.name}`, ip: req.ip || null, action, target, detail });
    } catch (error) {
      console.error(`audit: could not record ${action}: ${error.message}`);
    }
  }

  function fieldList(ctx) {
    return {
      company: access.fieldsFor(ctx, "company").filter((f) => f.recordId === null),
      person: access.fieldsFor(ctx, "person").filter((f) => f.recordId === null)
    };
  }

  /** Changes whenever the client's fields do, so it knows to fetch everything again. */
  function fieldsVersion(lists) {
    const shape = Object.fromEntries(Object.entries(lists).map(([e, l]) => [e, l.map((f) => [f.builtIn ? f.key : f.apiKey, f.type, f.access])]));
    return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
  }

  const describe = (l) => l.map((f) => ({ key: f.builtIn ? f.key : f.apiKey, label: f.label, type: f.type, builtIn: f.builtIn, editable: f.access === "edit" }));

  function companiesOut(ctx, records, list) {
    return records.map((r) => access.project(ctx, "company", r, list));
  }

  function peopleOut(ctx, records, list) {
    return records.map((r) => ({ ...access.project(ctx, "person", r, list), companyActive: r.companyActive }));
  }

  function visibleSites(ctx) {
    return sites.list().filter((s) => access.siteVisible(ctx, s.id)).map((s) => ({ id: s.id, name: s.name, active: s.active }));
  }

  router.get("/whoami", (req, res) => {
    const lists = fieldList(req.ctx);
    res.json({
      client: { id: req.client.id, name: req.client.name, canWrite: req.client.canWrite },
      sites: visibleSites(req.ctx),
      fields: { company: describe(lists.company), person: describe(lists.person) },
      fieldsVersion: fieldsVersion(lists)
    });
  });

  router.get("/sync", (req, res) => {
    const since = Number(str(req.query.since)) || 0;
    const serverTime = Date.now();
    const lists = fieldList(req.ctx);
    const companies = directory.listCompanies({ sites: req.ctx.sites, includeInactive: true, updatedSince: since || null, limit: 100000 }).records;
    const people = directory.listPeople({ sites: req.ctx.sites, includeInactive: true, updatedSince: since || null, limit: 1000000 }).records;
    res.json({
      serverTime,
      fieldsVersion: fieldsVersion(lists),
      sites: visibleSites(req.ctx),
      companies: companiesOut(req.ctx, companies, lists.company),
      people: peopleOut(req.ctx, people, lists.person),
      ...directory.visibleIds(req.ctx.sites)
    });
  });

  router.get("/companies", (req, res) => {
    const lists = fieldList(req.ctx);
    const { records } = directory.listCompanies({ q: str(req.query.q), search: access.searchable(req.ctx, "company"), sites: req.ctx.sites, includeInactive: str(req.query.all) === "1", updatedSince: Number(str(req.query.updated_since)) || null, limit: 100000 });
    res.json({ companies: companiesOut(req.ctx, records, lists.company) });
  });

  router.get("/people", (req, res) => {
    const lists = fieldList(req.ctx);
    const { records } = directory.listPeople({
      q: str(req.query.q),
      search: access.searchable(req.ctx, "person"),
      sites: req.ctx.sites,
      companyId: Number(str(req.query.companyId)) || null,
      includeInactive: str(req.query.all) === "1",
      updatedSince: Number(str(req.query.updated_since)) || null,
      limit: 1000000
    });
    res.json({ people: peopleOut(req.ctx, records, lists.person) });
  });

  router.get("/people/:id", (req, res) => {
    const record = directory.getPerson(Number(req.params.id), { sites: req.ctx.sites });
    if (!record) throw fail(404, "No such person.");
    res.json({ person: peopleOut(req.ctx, [record], fieldList(req.ctx).person)[0] });
  });

  function requireWrite(req) {
    if (!req.client.canWrite) throw fail(403, "This API key can only read. Allow it to add people under Settings > API clients.");
  }

  function writePlan(ctx, entity, body) {
    const list = access.fieldsFor(ctx, entity);
    const custom = access.checkWrite(ctx, entity, body, list);
    return { custom, editable: list.filter((f) => f.access === "edit"), callerSites: ctx.sites };
  }

  router.post("/people", (req, res) => {
    requireWrite(req);
    const body = { ...(req.body || {}) };
    const match = Boolean(body.match);
    delete body.match;
    const lists = fieldList(req.ctx);
    if (match && body.companyId) {
      const id = directory.findPersonMatch(Number(body.companyId), body);
      const existing = id ? directory.getPerson(id, { sites: req.ctx.sites }) : null;
      if (existing) return res.json({ ok: true, matched: true, person: peopleOut(req.ctx, [existing], lists.person)[0] });
    }
    const record = directory.createPerson(body, writePlan(req.ctx, "person", body));
    audit(req, "person.add", `${record.firstName} ${record.lastName}`, record.companyName);
    res.json({ ok: true, matched: false, person: peopleOut(req.ctx, [record], lists.person)[0] });
  });

  router.post("/companies", (req, res) => {
    requireWrite(req);
    const body = { ...(req.body || {}) };
    const match = Boolean(body.match);
    delete body.match;
    const lists = fieldList(req.ctx);
    if (match && body.name) {
      const found = directory.findCompanyByName(body.name);
      const existing = found ? directory.getCompany(found.id, { sites: req.ctx.sites }) : null;
      if (existing) return res.json({ ok: true, matched: true, company: companiesOut(req.ctx, [existing], lists.company)[0] });
      if (found) throw fail(409, `${found.name} exists at a site this key can't see.`);
    }
    if (body.sites === undefined) {
      // Nothing to choose when the client (or the whole installation) has one site.
      const usable = visibleSites(req.ctx).filter((s) => s.active);
      if (usable.length !== 1) throw fail(400, "Say which site the company is at: sites: [{ siteId, suite }].");
      body.sites = [{ siteId: usable[0].id, suite: body.suite || null }];
    }
    delete body.suite;
    const record = directory.createCompany(body, writePlan(req.ctx, "company", body));
    audit(req, "company.add", record.name, record.sites.map((s) => s.siteName).join(", "));
    res.json({ ok: true, matched: false, company: companiesOut(req.ctx, [record], lists.company)[0] });
  });

  router.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  return router;
}

module.exports = { createApiV1 };
