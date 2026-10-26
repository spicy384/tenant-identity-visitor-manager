const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const { loadKey } = require("./db-key");
const { openDatabase } = require("./db");
const { createFields, normaliseValue: normaliseFieldValue, TYPES: FIELD_TYPES, TYPE_LABELS: FIELD_TYPE_LABELS } = require("./fields");
const { createAccess, AREA_LEVELS, BADGE_LEVELS, NEW_FIELD_VISIBILITY } = require("./access");
const { createSites } = require("./sites");
const { createDirectory } = require("./directory");
const { createVisitors } = require("./visitors");
const { createKiosks } = require("./kiosks");
const { createVisitClock } = require("./visit-clock");
const { createKioskRoutes } = require("./kiosk-routes");
const { createVisitorRoutes } = require("./visitor-routes");
const { COUNTRIES } = require("./countries");
const { ID_TYPES } = require("./visitors");
const { createApiClients } = require("./api-clients");
const { createApiV1 } = require("./api-v1");
const { createClearance, DEFAULT_DIGITS_HOURS, MAX_DIGITS_HOURS } = require("./clearance");
const { createBadges } = require("./badges");
const { createEvents } = require("./events");
const { createBadgeRoutes } = require("./badge-routes");
const { createFacilities } = require("./facilities");
const { createFacilityRoutes } = require("./facility-routes");
const { createClearanceRoutes } = require("./clearance-routes");
const { createBadgeTemplates } = require("./badge-templates");
const { createPrefs } = require("./prefs");
const { createImportRoutes } = require("./import-routes");
const { createAuth } = require("./auth-routes");
const { createEntra } = require("./entra");
const { resolveTlsOptions } = require("./tls-setup");
const { parseCsvObjects, toCsv } = require("./csv");
const { ENTITIES } = require("./catalog");
const pkg = require("./package.json");

const app = express();
// The kiosk's own listener, when KIOSK_PORT is set (see below).
const kioskApp = express();
// Which proxies may set X-Forwarded-For (and so what req.ip means for the sign-in
// throttle, the sessions list and the audit log). The default trusts a proxy on this
// host or on a private network, which covers Nginx Proxy Manager on another LAN host;
// TRUST_PROXY takes Express's forms: "false", a hop count, or a comma-separated list
// of addresses/CIDRs/"loopback"/"uniquelocal".
const TRUST_PROXY = process.env.TRUST_PROXY === undefined || process.env.TRUST_PROXY === "" ? "loopback, uniquelocal" : process.env.TRUST_PROXY;
const TRUST_PROXY_SETTING = /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === "false" ? false : TRUST_PROXY === "true" ? true : TRUST_PROXY;
app.set("trust proxy", TRUST_PROXY_SETTING);
kioskApp.set("trust proxy", TRUST_PROXY_SETTING);

const PORT = process.env.PORT || 3000;
// Override with DATA_DIR when running in a container so the database lives on a volume.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
// The public address people use (https://directory.example.com). Used for the Entra
// redirect URI; without it the address is taken from each request's Host header.
const APP_URL = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
// KIOSK_PORT puts the lobby kiosks on a port of their own, serving the kiosk page and its
// API and nothing else; the main port then has no /kiosk at all. The kiosk and the staff
// pages can then have separate hostnames in the proxy, and the staff port can be closed
// to the lobby network. Unset, the kiosk lives at /kiosk/ on the main port.
const KIOSK_PORT = (() => {
  const raw = String(process.env.KIOSK_PORT || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535 || String(n) === String(PORT)) {
    console.error(`\n  !! KIOSK_PORT must be a port number different from PORT (${PORT}); got "${raw}".\n`);
    process.exit(1);
  }
  return n;
})();
// How long the SSN digits given with a clearance validation request are held in memory
// before they are wiped, if Security hasn't validated or cancelled by then.
const CLEARANCE_DIGITS_HOURS = (() => {
  const raw = String(process.env.CLEARANCE_DIGITS_HOURS || "").trim();
  if (!raw) return DEFAULT_DIGITS_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DIGITS_HOURS) {
    console.error(`\n  !! CLEARANCE_DIGITS_HOURS must be a number of hours above 0 and at most ${MAX_DIGITS_HOURS}; got "${raw}".\n`);
    process.exit(1);
  }
  return n;
})();
// The kiosk's public address (https://visitors.example.com), shown on Settings > Kiosks.
const KIOSK_URL = String(process.env.KIOSK_URL || "").trim().replace(/\/+$/, "");

/** One string out of a query value (Express 5 may hand over an array for a repeated key). */
function str(value, max = 200) {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === null || v === "" ? undefined : String(v).slice(0, max);
}

function positiveInt(value, fallback = null) {
  const n = Number(str(value));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Security headers. The page loads only its own scripts and styles; inline styles are
// allowed because dialogs set element styles from JavaScript, and data: and blob:
// images carry logos being resized before upload.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");
function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
}
app.use(securityHeaders);
kioskApp.use(securityHeaders);

/** Not found, as JSON under an API path and plain text elsewhere. */
function notFound(req, res) {
  if (req.path.startsWith("/kiosk/api") || req.path.startsWith("/api")) return res.status(404).json({ error: "Not found." });
  return res.status(404).type("text/plain").send("Not found.");
}

// With a kiosk port, the main port has no kiosk: not its page, not its API.
if (KIOSK_PORT) app.use("/kiosk", notFound);

// A clearance validation request may carry the last four of an SSN. Its body stays bytes,
// never a string, so clearance-routes.js can take the digits out and wipe them; every other
// body is JSON as usual. (The route refuses a body that arrives parsed, so a path spelt
// differently can't slip past this.)
const rawClearanceRequest = express.raw({ type: () => true, limit: "8kb" });
app.use((req, res, next) => {
  if (req.method !== "POST" || req.path !== "/api/clearance/requests") return next();
  // Wiped however the request ends: refused at sign-in, failed, or answered.
  const wipe = () => { if (Buffer.isBuffer(req.body)) req.body.fill(0); };
  res.once("finish", wipe);
  res.once("close", wipe);
  return rawClearanceRequest(req, res, next);
});
// 4 MB: a CSV import of a large directory, or a logo as a data: URL.
app.use(express.json({ limit: "4mb" }));

// The staff page and the kiosk page, with their scripts and styles addressed by version
// (/js/01-core.js?v=0.6.2), so neither a browser nor a proxy in between ever hands out one
// version's scripts with another's server; and the version each was served by, which the page
// compares with what the API says (X-App-Version) to reload after an upgrade.
function versionedPage(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/(src|href)="(\/(?:kiosk\/)?(?:js\/)?[\w.-]+\.(?:js|css))"/g, (m, attr, url) => `${attr}="${url}?v=${encodeURIComponent(pkg.version)}"`)
    .replace("<head>", () => `<head>\n  <meta name="app-version" content="${pkg.version.replace(/[^\w.+-]/g, "")}" />`);
}
const INDEX_HTML = versionedPage(path.join(__dirname, "public", "index.html"));
const KIOSK_HTML = versionedPage(path.join(__dirname, "public", "kiosk", "index.html"));
const sendPage = (html) => (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
};
app.get(["/", "/index.html"], sendPage(INDEX_HTML));
for (const a of [app, kioskApp]) a.get(["/kiosk/", "/kiosk/index.html"], sendPage(KIOSK_HTML));
const sayVersion = (req, res, next) => {
  res.setHeader("X-App-Version", pkg.version);
  next();
};
app.use("/api", sayVersion);
app.use("/kiosk/api", sayVersion);
kioskApp.use("/kiosk/api", sayVersion);
// Directory pages (the kiosk at /kiosk/) still come from here; the main page from the route above.
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

// The kiosk port: the kiosk page (at /kiosk/, where its files expect to be), its icon, and
// its API. Nothing of the staff pages, the staff API or /api/v1 is reachable here.
kioskApp.use(express.json({ limit: "64kb" }));
kioskApp.get("/", (req, res) => res.redirect(302, "/kiosk/"));
kioskApp.get("/icon.svg", (req, res) => res.sendFile(path.join(__dirname, "public", "icon.svg")));
kioskApp.use("/kiosk", express.static(path.join(__dirname, "public", "kiosk"), { index: "index.html" }));

// --- the database and everything built on it ------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
let keyInfo;
try {
  keyInfo = loadKey({ dataDir: DATA_DIR });
} catch (error) {
  if (require.main === module) {
    console.error(`\n  !! ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
const db = openDatabase({ dataDir: DATA_DIR, key: keyInfo.key });
if (keyInfo.created && require.main === module) {
  // Never the key itself: logs are kept on disk.
  console.log(`\n  ** A new database key was made in ${keyInfo.source}. Copy it into your password manager now;`);
  console.log("     without it the data can't be read. In Docker: docker compose exec identity cat /keys/db_key\n");
}
const fields = createFields({ db });
const access = createAccess({ db, fields });
const sites = createSites({ db });
sites.ensureDefault();
const directory = createDirectory({ db, fields });
const facilities = createFacilities({ db, sites, directory });
const visitors = createVisitors({ db, fields });
const kiosks = createKiosks({ db });
const clock = createVisitClock({ db, visitors, log: (message) => console.error(message) });
const apiClients = createApiClients({ db, access, sites });
const clearance = createClearance({ db, digitsHours: CLEARANCE_DIGITS_HOURS });
const badges = createBadges({ db, clearance });
const templates = createBadgeTemplates({ db, clearance });
const prefs = createPrefs({ db, access });
const events = createEvents({ db });
const store = { read: db.readDoc, write: db.writeDoc };
const entra = createEntra({ store, roles: () => access.listRoles({ kind: "user" }) });
// The name in the header, on the sign-in page and in the browser's tab, and the line under it
// (shown when no one site is chosen). Settings > General.
const DEFAULT_APP_NAME = "Identity and Visitor Manager";
function branding() {
  return { name: db.getSetting("branding.name") || DEFAULT_APP_NAME, subtitle: db.getSetting("branding.subtitle") || "" };
}

const authGuard = createAuth({
  store,
  branding,
  roles: access,
  sites: { exists: (id) => Boolean(sites.get(id)) },
  audit: (entry) => db.audit(entry),
  entra,
  appUrl: APP_URL,
  // The setup form asks for the building's name; it becomes the first site's.
  onSetup: ({ siteName }) => {
    const [only] = sites.list();
    if (siteName && only && sites.count() === 1) sites.update(only.id, { name: siteName });
  }
});

/** Writes an audit entry attributed to the signed-in user. */
function auditFrom(req, action, target, detail = null) {
  try {
    db.audit({ username: req.user?.username || null, ip: req.ip || null, action, target, detail });
  } catch (error) {
    console.error(`audit: could not record ${action}: ${error.message}`);
  }
}

// Other systems (Equipment Checkout) sign in with an API key, not a session.
app.use("/api/v1", createApiV1({ db, access, directory, sites, apiClients }));

// The kiosk signs in as a device, not a person, so its API sits outside /api: on the
// kiosk port when there is one, else on the main port.
const kioskRoutes = createKioskRoutes({ db, kiosks, visitors, events, sites, clock, cookieSecure: authGuard.cookieSecure });
(KIOSK_PORT ? kioskApp : app).use("/kiosk/api", kioskRoutes.router);
kioskApp.use(notFound);

app.use(authGuard.router);
app.use("/api", authGuard.requireAuth, (req, res, next) => {
  req.ctx = access.contextFor(req.user);
  next();
});
const admin = authGuard.requireAdmin;
const clearanceRoutes = createClearanceRoutes({ access, clearance, directory, visitors, admin, auditFrom });

/** Requires at least `level` ("read" or "edit") on the directory. */
function directoryAccess(level) {
  return (req, res, next) => {
    const ok = level === "edit" ? access.canEditDirectory(req.ctx) : access.canReadDirectory(req.ctx);
    if (!ok) return res.status(403).json({ error: level === "edit" ? "This account can't change the directory." : "This account can't see the directory." });
    return next();
  };
}
const readDir = directoryAccess("read");
const editDir = directoryAccess("edit");

// --- what leaves the server ------------------------------------------------------------

/** Fields the caller sees, in the shape the pages build forms and columns from. */
function publicFields(list) {
  return list.map((f) => ({
    key: f.builtIn ? f.key : f.apiKey,
    id: f.id ?? null,
    label: f.label,
    type: f.type,
    builtIn: f.builtIn,
    locked: f.locked,
    required: f.required,
    choices: f.choices,
    recordOnly: f.recordId !== null,
    access: f.access
  }));
}

function companiesOut(ctx, records) {
  const list = access.fieldsFor(ctx, "company");
  return records.map((r) => ({ ...access.project(ctx, "company", r, list), peopleCount: r.people }));
}

function peopleOut(ctx, records) {
  const list = access.fieldsFor(ctx, "person");
  return records.map((r) => access.project(ctx, "person", r, list));
}

/** One record with its own one-record fields too, as a detail page or a save answers. */
function recordOut(ctx, entity, record) {
  const out = access.project(ctx, entity, record, access.fieldsFor(ctx, entity, { recordId: record.id }));
  return entity === "company" ? { ...out, peopleCount: record.people } : out;
}

/** The sites the caller can see, in the short form lists and pickers use. */
function visibleSites(ctx, { includeInactive = true } = {}) {
  return sites.list({ includeInactive }).filter((s) => access.siteVisible(ctx, s.id));
}

/** A site filter from the query string, refused when it is outside the caller's sites. */
function siteFilter(req) {
  const siteId = positiveInt(req.query.site);
  if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
  return siteId;
}

// --- configuration ---------------------------------------------------------------------

app.get("/api/config", (req, res) => {
  const ctx = req.ctx;
  res.json({
    version: pkg.version,
    access: { role: ctx.role?.id || null, roles: ctx.roles.map((r) => r.id), roleName: ctx.roles.map((r) => r.name).join(", ") || null, isAdmin: ctx.isAdmin, directory: ctx.directory, visitors: ctx.visitors, badges: ctx.badges, clearances: access.canSeeClearances(ctx), facilities: ctx.facilities, fieldEntities: access.fieldEntitiesFor(ctx), sitesLimited: Boolean(ctx.sites) },
    branding: branding(),
    visits: access.canReadVisitors(ctx) ? { here: visitors.hereNow(ctx.sites), review: visitors.reviewCount(ctx.sites), expected: events.expectedCount(ctx.sites), badgesLeft: access.canReadBadges(ctx) ? badges.leftCount(ctx.sites) : 0, tempOverdue: access.canReadBadges(ctx) ? badges.overdueCount(ctx.sites) : 0 } : null,
    // Level names only for roles that see them; the rest see badge template images.
    clearanceLevels: access.canSeeClearances(ctx) ? clearance.levels().map((l) => ({ id: l.id, name: l.name, rank: l.rank })) : [],
    clearance: { security: access.isSecurity(ctx), queue: clearanceRoutes.queueCount(req), digitsHeldHours: clearance.DIGITS_TTL_HOURS, ...clearance.settings() },
    sites: visibleSites(ctx).map((s) => ({ id: s.id, name: s.name, active: s.active, hasLogo: s.hasLogo, logoUpdatedAt: s.logoUpdatedAt })),
    siteCount: sites.count(),
    // For a visitor's citizenship, and the IDs the desk checks at check-in.
    checkin: access.canReadVisitors(ctx) ? { countries: COUNTRIES, idTypes: ID_TYPES } : null
  });
});

/** The fields the caller sees for each record type, with whether each is editable. */
// --- the signed-in person's own preferences (site, dashboard) -----------------------------------

app.get("/api/me/prefs", (req, res) => {
  res.json(prefs.get(req.user, req.ctx));
});

app.put("/api/me/prefs", (req, res) => {
  res.json(prefs.save(req.user, req.ctx, req.body || {}, { siteExists: (id) => Boolean(sites.get(id)) }));
});

app.get("/api/schema", (req, res) => {
  res.json(Object.fromEntries(ENTITIES.map((e) => [e, publicFields(access.fieldsFor(req.ctx, e))])));
});

// --- sites -------------------------------------------------------------------------------

app.get("/api/sites", (req, res) => {
  res.json({ sites: visibleSites(req.ctx), timeZones: req.ctx.isAdmin ? Intl.supportedValuesOf("timeZone") : undefined });
});

app.get("/api/sites/:id/logo", (req, res) => {
  const id = positiveInt(req.params.id);
  if (!id || !access.siteVisible(req.ctx, id)) throw fail(404, "No such site.");
  const logo = sites.getLogo(id);
  if (!logo) throw fail(404, "This site has no logo.");
  res.setHeader("Content-Type", logo.type);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(logo.data);
});

app.post("/api/sites", admin, (req, res) => {
  const site = sites.create(req.body || {});
  auditFrom(req, "site.add", site.name, site.timeZone);
  res.json({ ok: true, site });
});

app.put("/api/sites/:id", admin, (req, res) => {
  const site = sites.update(positiveInt(req.params.id), req.body || {});
  auditFrom(req, "site.update", site.name, `${site.timeZone}; end of day ${site.endOfDay || "off"}${site.active ? "" : "; inactive"}`);
  res.json({ ok: true, site });
});

app.delete("/api/sites/:id", admin, (req, res) => {
  const site = sites.remove(positiveInt(req.params.id));
  // Accounts limited to it lose it; one left with no site at all is limited to nothing.
  const users = authGuard.loadUsers();
  for (const u of users) {
    if (Array.isArray(u.sites) && u.sites.includes(site.id)) u.sites = u.sites.filter((s) => s !== site.id);
  }
  store.write("users", users);
  // API clients limited to it lose it too.
  for (const c of apiClients.list()) {
    if (c.sites && c.sites.includes(site.id)) apiClients.update(c.id, { sites: c.sites.length > 1 ? c.sites.filter((x) => x !== site.id) : null });
  }
  auditFrom(req, "site.remove", site.name);
  res.json({ ok: true });
});

app.put("/api/sites/:id/logo", admin, (req, res) => {
  const site = sites.setLogo(positiveInt(req.params.id), req.body?.dataUrl);
  auditFrom(req, "site.logo", site.name, "logo changed");
  res.json({ ok: true, site });
});

app.delete("/api/sites/:id/logo", admin, (req, res) => {
  const site = sites.clearLogo(positiveInt(req.params.id));
  auditFrom(req, "site.logo", site.name, "logo removed");
  res.json({ ok: true, site });
});

// --- companies ---------------------------------------------------------------------------

app.get("/api/companies", readDir, (req, res) => {
  const { records, total } = directory.listCompanies({
    q: str(req.query.q),
    search: access.searchable(req.ctx, "company"),
    sites: req.ctx.sites,
    siteId: siteFilter(req),
    includeInactive: str(req.query.all) === "1",
    limit: Math.min(positiveInt(req.query.limit, 500), 2000),
    offset: Math.max(0, Number(str(req.query.offset)) || 0)
  });
  res.json({ companies: companiesOut(req.ctx, records), total });
});

app.get("/api/companies/:id", readDir, (req, res) => {
  const record = directory.getCompany(positiveInt(req.params.id), { sites: req.ctx.sites });
  if (!record) throw fail(404, "No such company.");
  const list = access.fieldsFor(req.ctx, "company", { recordId: record.id });
  const people = directory.listPeople({ companyId: record.id, sites: req.ctx.sites, includeInactive: true, limit: 5000 });
  res.json({
    company: { ...access.project(req.ctx, "company", record, list), peopleCount: record.people },
    fields: publicFields(list),
    people: peopleOut(req.ctx, people.records)
  });
});

/** The pieces a write needs: which custom values it sets, and which fields the caller edits. */
function writePlan(ctx, entity, body, recordId = null) {
  const list = access.fieldsFor(ctx, entity, { recordId });
  const custom = access.checkWrite(ctx, entity, body || {}, list);
  return { custom, editable: list.filter((f) => f.access === "edit"), callerSites: ctx.sites };
}

app.post("/api/companies", editDir, (req, res) => {
  const body = { ...(req.body || {}) };
  // With a single site there is nothing to choose: the company is there.
  if (body.sites === undefined && sites.count() === 1) body.sites = [{ siteId: sites.list()[0].id }];
  const record = directory.createCompany(body, writePlan(req.ctx, "company", body));
  auditFrom(req, "company.add", record.name, record.sites.map((s) => s.siteName).join(", ") || "no site");
  res.json({ ok: true, company: recordOut(req.ctx, "company", record) });
});

app.put("/api/companies/:id", editDir, (req, res) => {
  const id = positiveInt(req.params.id);
  if (!directory.getCompany(id, { sites: req.ctx.sites })) throw fail(404, "No such company.");
  const record = directory.updateCompany(id, req.body || {}, writePlan(req.ctx, "company", req.body, id));
  auditFrom(req, "company.update", record.name, changedKeys(req.body));
  res.json({ ok: true, company: recordOut(req.ctx, "company", record) });
});

/** Refuses to delete someone who still holds a badge: it has to come back (or be marked lost) first. */
function noBadgesOut(kind, ids, who) {
  const out = ids.flatMap((id) => badges.openForHolder(kind, id));
  if (out.length) throw fail(409, `${who} still ${out.length === 1 ? "holds badge" : "hold badges"} ${out.join(", ")}. Take ${out.length === 1 ? "it" : "them"} back first.`);
}

/** Refuses to delete a company that has an office now or later: end those assignments first. */
function noOfficesHeld(company) {
  const held = facilities.heldBy(company.id);
  if (held.length) throw fail(409, `${company.name} ${held.length === 1 ? "has office" : "has offices"} ${held.join(", ")} now or later. End ${held.length === 1 ? "that assignment" : "those assignments"} under Facilities first.`);
}

app.delete("/api/companies/:id", admin, (req, res) => {
  const target = directory.getCompany(positiveInt(req.params.id));
  if (target) noBadgesOut("person", directory.listPeople({ companyId: target.id, includeInactive: true, limit: 100000 }).records.map((p) => p.id), `People at ${target.name}`);
  if (target) noOfficesHeld(target);
  const record = directory.deleteCompany(positiveInt(req.params.id));
  clearance.sweepDigits();
  auditFrom(req, "company.remove", record.name, `${record.peopleRemoved} people removed with it`);
  res.json({ ok: true });
});

/** Which fields a change named, for the audit log (never their values). */
function changedKeys(body) {
  const keys = Object.keys(body || {}).filter((k) => k !== "custom");
  const custom = Object.keys(body?.custom || {}).map((k) => `custom.${k}`);
  return [...keys, ...custom].join(", ") || null;
}

// --- people --------------------------------------------------------------------------------

app.get("/api/people", readDir, (req, res) => {
  const { records, total } = directory.listPeople({
    q: str(req.query.q),
    search: access.searchable(req.ctx, "person"),
    sites: req.ctx.sites,
    siteId: siteFilter(req),
    companyId: positiveInt(req.query.companyId),
    includeInactive: str(req.query.all) === "1",
    limit: Math.min(positiveInt(req.query.limit, 500), 5000),
    offset: Math.max(0, Number(str(req.query.offset)) || 0)
  });
  res.json({ people: peopleOut(req.ctx, records), total });
});

app.get("/api/people/:id", readDir, (req, res) => {
  const record = directory.getPerson(positiveInt(req.params.id), { sites: req.ctx.sites });
  if (!record) throw fail(404, "No such person.");
  const list = access.fieldsFor(req.ctx, "person", { recordId: record.id });
  res.json({ person: access.project(req.ctx, "person", record, list), fields: publicFields(list) });
});

app.post("/api/people", editDir, (req, res) => {
  const record = directory.createPerson(req.body || {}, writePlan(req.ctx, "person", req.body));
  auditFrom(req, "person.add", `${record.firstName} ${record.lastName}`, record.companyName);
  res.json({ ok: true, person: recordOut(req.ctx, "person", record) });
});

app.put("/api/people/:id", editDir, (req, res) => {
  const id = positiveInt(req.params.id);
  if (!directory.getPerson(id, { sites: req.ctx.sites })) throw fail(404, "No such person.");
  const record = directory.updatePerson(id, req.body || {}, writePlan(req.ctx, "person", req.body, id));
  auditFrom(req, "person.update", `${record.firstName} ${record.lastName}`, changedKeys(req.body));
  res.json({ ok: true, person: recordOut(req.ctx, "person", record) });
});

app.delete("/api/people/:id", admin, (req, res) => {
  const target = directory.getPerson(positiveInt(req.params.id));
  if (target) noBadgesOut("person", [target.id], `${target.firstName} ${target.lastName}`);
  const record = directory.deletePerson(positiveInt(req.params.id));
  clearance.sweepDigits();
  auditFrom(req, "person.remove", `${record.firstName} ${record.lastName}`, record.companyName);
  res.json({ ok: true });
});

// --- several at once: merging companies, bulk changes and deletes ----------------------------------

/** Up to 1,000 record ids from a request body, each once. */
function idsFrom(body) {
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw fail(400, "Choose at least one.");
  if (ids.length > 1000) throw fail(400, "At most 1,000 at once.");
  return ids;
}

/** The change to make to each: no names (each keeps its own), nothing that isn't a plain field. */
function bulkPatch(body, refusedKeys) {
  const patch = body?.patch && typeof body.patch === "object" ? { ...body.patch } : null;
  if (!patch || !Object.keys(patch).length) throw fail(400, "Choose what to change.");
  const refused = refusedKeys.filter((k) => patch[k] !== undefined);
  if (refused.length) throw fail(400, "Each keeps its own name: change names one at a time.");
  return patch;
}

const personName = (p) => `${p.firstName} ${p.lastName}`;

app.post("/api/companies/merge", editDir, (req, res) => {
  const body = req.body || {};
  const intoId = positiveInt(body.intoId);
  if (!intoId || !directory.getCompany(intoId, { sites: req.ctx.sites })) throw fail(404, "No such company to merge into.");
  const input = body.company && typeof body.company === "object" ? body.company : {};
  const result = directory.mergeCompanies(intoId, body.fromIds, input, writePlan(req.ctx, "company", input, intoId));
  auditFrom(req, "company.merge", result.company.name, `merged in ${result.merged.join(", ")}; ${result.peopleMoved} people moved`);
  res.json({ ok: true, company: recordOut(req.ctx, "company", result.company), merged: result.merged, peopleMoved: result.peopleMoved });
});

app.post("/api/companies/bulk", editDir, (req, res) => {
  const ids = idsFrom(req.body);
  const patch = bulkPatch(req.body, ["name"]);
  const names = ids.map((id) => directory.getCompany(id, { sites: req.ctx.sites })?.name || `Company ${id}`);
  const counts = importRows(ids, (id) => {
    if (!directory.getCompany(id, { sites: req.ctx.sites })) throw fail(404, "No such company, or it is at a site this account can't see.");
    directory.updateCompany(id, patch, writePlan(req.ctx, "company", patch, id));
    return "updated";
  }, (i) => names[i], "changed");
  auditFrom(req, "company.bulk_update", `${counts.updated} companies`, changedKeys(patch));
  res.json({ ok: true, updated: counts.updated });
});

app.post("/api/companies/bulk-delete", admin, (req, res) => {
  const ids = idsFrom(req.body);
  const found = ids.map((id) => directory.getCompany(id));
  if (found.some((c) => !c)) throw fail(404, "One of those companies doesn't exist.");
  for (const c of found) noBadgesOut("person", directory.listPeople({ companyId: c.id, includeInactive: true, limit: 100000 }).records.map((p) => p.id), `People at ${c.name}`);
  for (const c of found) noOfficesHeld(c);
  let peopleRemoved = 0;
  db.transaction(() => { for (const c of found) peopleRemoved += directory.deleteCompany(c.id).peopleRemoved; });
  clearance.sweepDigits();
  auditFrom(req, "company.remove", `${found.length} companies`, `${found.map((c) => c.name).join(", ")}; ${peopleRemoved} people removed with them`);
  res.json({ ok: true, deleted: found.length, peopleRemoved });
});

app.post("/api/people/bulk", editDir, (req, res) => {
  const ids = idsFrom(req.body);
  const patch = bulkPatch(req.body, ["firstName", "lastName", "preferredName"]);
  const names = ids.map((id) => { const p = directory.getPerson(id, { sites: req.ctx.sites }); return p ? personName(p) : `Person ${id}`; });
  const counts = importRows(ids, (id) => {
    if (!directory.getPerson(id, { sites: req.ctx.sites })) throw fail(404, "No such person, or at a site this account can't see.");
    directory.updatePerson(id, patch, writePlan(req.ctx, "person", patch, id));
    return "updated";
  }, (i) => names[i], "changed");
  auditFrom(req, "person.bulk_update", `${counts.updated} people`, changedKeys(patch));
  res.json({ ok: true, updated: counts.updated });
});

app.post("/api/people/bulk-delete", admin, (req, res) => {
  const ids = idsFrom(req.body);
  const found = ids.map((id) => directory.getPerson(id));
  if (found.some((p) => !p)) throw fail(404, "One of those people doesn't exist.");
  noBadgesOut("person", found.map((p) => p.id), found.length === 1 ? personName(found[0]) : "Some of them");
  db.transaction(() => { for (const p of found) directory.deletePerson(p.id); });
  clearance.sweepDigits();
  auditFrom(req, "person.remove", `${found.length} people`, found.map(personName).slice(0, 50).join(", "));
  res.json({ ok: true, deleted: found.length });
});

// --- CSV export and import ------------------------------------------------------------------

const yesNo = (v) => (v === true ? "yes" : v === false ? "no" : "");
const sitesCell = (list) => (list || []).map((s) => (s.suite ? `${s.siteName}: ${s.suite}` : s.siteName)).join("; ");

function customColumns(entity) {
  return fields.list(entity).filter((d) => d.recordId === null);
}

function sendCsv(res, name, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}

// Exports are plain text by nature, so they are for administrators and always audited.
app.get("/api/companies.csv", admin, (req, res) => {
  const { records } = directory.listCompanies({ includeInactive: true, limit: 100000, siteId: siteFilter(req) });
  const extra = customColumns("company");
  const rows = companiesOut(req.ctx, records).map((c) => [c.id, c.name, sitesCell(c.sites), c.phone, c.email, c.website, c.address, c.notes, yesNo(c.active), ...extra.map((d) => (typeof c.custom[d.key] === "boolean" ? yesNo(c.custom[d.key]) : c.custom[d.key]))]);
  auditFrom(req, "export.companies", `${rows.length} companies`);
  sendCsv(res, "companies", toCsv(["id", "name", "sites", "phone", "email", "website", "address", "notes", "active", ...extra.map((d) => d.key)], rows));
});

app.get("/api/people.csv", admin, (req, res) => {
  const { records } = directory.listPeople({ includeInactive: true, limit: 1000000, siteId: siteFilter(req), companyId: positiveInt(req.query.companyId) });
  const extra = customColumns("person");
  const rows = peopleOut(req.ctx, records).map((p) => [p.id, p.firstName, p.lastName, p.preferredName, p.companyName, p.jobTitle, p.email, p.workPhone, p.mobile, p.siteName, yesNo(p.canHost), p.notes, yesNo(p.active), ...extra.map((d) => (typeof p.custom[d.key] === "boolean" ? yesNo(p.custom[d.key]) : p.custom[d.key]))]);
  auditFrom(req, "export.people", `${rows.length} people`);
  sendCsv(res, "people", toCsv(["id", "first_name", "last_name", "preferred_name", "company", "job_title", "email", "work_phone", "mobile", "site", "can_host", "notes", "active", ...extra.map((d) => d.key)], rows));
});

const COMPANY_COLUMNS = { name: "name", phone: "phone", email: "email", website: "website", address: "address", notes: "notes", active: "active" };
const PERSON_COLUMNS = { first_name: "firstName", last_name: "lastName", preferred_name: "preferredName", job_title: "jobTitle", email: "email", work_phone: "workPhone", mobile: "mobile", can_host: "canHost", notes: "notes", active: "active" };
const VISITOR_COLUMNS = { first_name: "firstName", last_name: "lastName", organisation: "organisation", visitor_type: "visitorType", citizenship: "citizenship", email: "email", phone: "phone", notes: "notes", blocked: "blocked" };
const BOOLEAN_KEYS = new Set(["active", "canHost", "blocked"]);

function parseYesNo(value, label) {
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  throw fail(400, `${label} must be yes or no.`);
}

/** A site by name among those the caller may use. */
function siteByName(ctx, name) {
  const site = sites.list().find((s) => s.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!site) throw fail(400, `There is no site called "${name}".`);
  if (!access.siteVisible(ctx, site.id)) throw fail(403, `This account can't use the site "${name}".`);
  return site;
}

/** "Site A: Suite 100; Site B" -> [{ siteId, suite }]. */
function parseSitesCell(ctx, cell) {
  return String(cell).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const idx = part.indexOf(":");
    const name = idx >= 0 ? part.slice(0, idx) : part;
    return { siteId: siteByName(ctx, name).id, suite: idx >= 0 ? part.slice(idx + 1).trim() : null };
  });
}

/**
 * What an import may write for this caller: the built-in keys and custom field keys
 * they can edit. Columns for anything else are skipped and reported, never written.
 */
function writableColumns(ctx, entity) {
  const list = access.fieldsFor(ctx, entity).filter((f) => f.access === "edit");
  return { builtIn: new Set(list.filter((f) => f.builtIn).map((f) => f.key)), custom: new Set(list.filter((f) => !f.builtIn && f.recordId === null).map((f) => f.apiKey)) };
}

/** Builds a patch from a CSV row: built-in columns, then custom columns by field key. */
function rowPatch(row, columns, writable) {
  const patch = {};
  const custom = {};
  for (const [col, value] of Object.entries(row)) {
    if (value === "") continue;
    if (columns[col] && writable.builtIn.has(columns[col])) {
      patch[columns[col]] = BOOLEAN_KEYS.has(columns[col]) ? parseYesNo(value, col) : value;
    } else if (writable.custom.has(col)) {
      custom[col] = value;
    }
  }
  if (Object.keys(custom).length) patch.custom = custom;
  return patch;
}

/**
 * Runs `fn(row)` for every row in one transaction; any failure undoes the lot. `where(i)`
 * names a row in the problems listed: a CSV line by default (the header is line 1).
 */
// At most this many skipped rows are sent back with their values (all are counted).
const MAX_SKIPPED_SHOWN = 5000;

/** A row of an import with nothing in any of its cells (the tail of many exports). */
const isBlankRow = (row) => Boolean(row) && typeof row === "object" && Object.values(row).every((v) => v === undefined || v === null || String(v).trim() === "");

/**
 * Applies fn to each row in one transaction, each row in a savepoint of its own so a row that
 * fails part-way leaves nothing behind. By default all or nothing: if any row has a problem,
 * nothing is kept and the problems are listed. With skipProblems, the rows with problems are
 * left out and the rest kept: { added, updated, blank, skipped: [{ where, reason, row }],
 * skippedCount }. Rows with nothing in them are passed over either way (counted as blank).
 */
function importRows(rows, fn, where = (i) => `Line ${i + 2}`, verb = "imported", { skipProblems = false } = {}) {
  const errors = [];
  const counts = { added: 0, updated: 0, blank: 0 };
  const skipped = [];
  let skippedCount = 0;
  try {
    db.transaction(() => {
      rows.forEach((row, i) => {
        if (isBlankRow(row)) {
          counts.blank += 1;
          return;
        }
        try {
          let outcome;
          db.transaction(() => { outcome = fn(row); });
          counts[outcome] += 1;
        } catch (error) {
          if (skipProblems) {
            skippedCount += 1;
            if (skipped.length < MAX_SKIPPED_SHOWN) skipped.push({ where: where(i), reason: error.message, row });
          } else {
            errors.push(`${where(i)}: ${error.message}`);
          }
        }
      });
      if (errors.length) throw fail(400, "rollback");
    });
  } catch (error) {
    if (!errors.length) throw error;
    const shown = errors.slice(0, 10).join("\n");
    throw fail(400, `Nothing was ${verb}. ${errors.length} ${verb === "imported" ? "row" : "of them"}${errors.length === 1 ? (verb === "imported" ? " has" : " has") : (verb === "imported" ? "s have" : " have")} a problem:\n${shown}${errors.length > 10 ? `\n...and ${errors.length - 10} more.` : ""}`);
  }
  return { ...counts, skipped, skippedCount };
}

/** What an import did, for the audit log. */
const importSummary = (counts) => `${counts.added} added, ${counts.updated} updated${counts.skippedCount ? `, ${counts.skippedCount} skipped` : ""}`;

function checkImport(rows, required) {
  if (!rows.length) throw fail(400, "The file has no rows under its header.");
  if (rows.length > 20000) throw fail(400, "Import at most 20,000 rows at a time.");
  const missing = required.filter((c) => !Object.prototype.hasOwnProperty.call(rows[0], c));
  if (missing.length) throw fail(400, `The first row must be a header with the column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
}

/** A company's sites from its row: a "sites" cell, or a site (and suite) of its own. */
function companySitesOf(ctx, row) {
  if (row.sites) return parseSitesCell(ctx, row.sites);
  if (row.site) return [{ siteId: siteByName(ctx, row.site).id, suite: row.suite || null }];
  return null;
}

function ignoredColumns(rows, columns, writable) {
  return Object.keys(rows[0]).filter((c) => !["id", "sites", "site", "company"].includes(c) && !(columns[c] && writable.builtIn.has(columns[c])) && !writable.custom.has(c));
}

/** The sites a new company gets when the file does not say: the only site, or the caller's only one. */
function defaultSitesFor(ctx) {
  const usable = visibleSites(ctx, { includeInactive: false });
  if (usable.length === 1) return [{ siteId: usable[0].id }];
  throw fail(400, "Add a \"sites\" column: there is more than one site to choose from.");
}

/**
 * Imports companies from rows keyed by column (name, sites or site and suite, phone, ...,
 * custom field keys), from a CSV file or a matched table. `from` goes in the audit log.
 */
function importCompanies(req, rows, { where, from = "CSV", skipProblems = false } = {}) {
  checkImport(rows, ["name"]);
  const writable = writableColumns(req.ctx, "company");
  const counts = importRows(rows, (row) => {
    const patch = rowPatch(row, COMPANY_COLUMNS, writable);
    const sitesOfRow = companySitesOf(req.ctx, row);
    if (sitesOfRow) patch.sites = sitesOfRow;
    const existing = directory.findCompanyByName(row.name);
    if (existing && directory.getCompany(existing.id, { sites: req.ctx.sites })) {
      delete patch.name;
      directory.updateCompany(existing.id, patch, writePlan(req.ctx, "company", patch, existing.id));
      return "updated";
    }
    if (existing) throw fail(403, `${row.name} exists at a site this account can't see.`);
    if (!patch.sites) patch.sites = defaultSitesFor(req.ctx);
    directory.createCompany(patch, writePlan(req.ctx, "company", patch));
    return "added";
  }, where, "imported", { skipProblems });
  const ignored = ignoredColumns(rows, COMPANY_COLUMNS, writable).filter((c) => c !== "suite");
  auditFrom(req, "import.companies", importSummary(counts), `from ${from}`);
  return { ...counts, ignored };
}

app.post("/api/companies/import", editDir, (req, res) => {
  res.json({ ok: true, ...importCompanies(req, parseCsvObjects(req.body?.csv), { skipProblems: req.body?.skipProblems === true }) });
});

/** Imports people from rows keyed by column (first_name, last_name, company, ..., custom field keys). */
function importPeople(req, rows, { createCompanies = false, where, from = "CSV", skipProblems = false } = {}) {
  checkImport(rows, ["first_name", "last_name", "company"]);
  const writable = writableColumns(req.ctx, "person");
  const counts = importRows(rows, (row) => {
    const patch = rowPatch(row, PERSON_COLUMNS, writable);
    let company = row.company ? directory.findCompanyByName(row.company) : null;
    if (!row.company) throw fail(400, "Company is empty.");
    if (company && !directory.getCompany(company.id, { sites: req.ctx.sites })) throw fail(403, `${row.company} is at a site this account can't see.`);
    if (!company) {
      if (!createCompanies) throw fail(400, `There is no company called "${row.company}". Add it first, or tick "Add companies that don't exist yet".`);
      const cpatch = { name: row.company, sites: row.site ? [{ siteId: siteByName(req.ctx, row.site).id }] : defaultSitesFor(req.ctx) };
      company = directory.createCompany(cpatch, writePlan(req.ctx, "company", cpatch));
    }
    patch.companyId = company.id;
    if (row.site) patch.siteId = siteByName(req.ctx, row.site).id;
    const existingId = directory.findPersonMatch(company.id, { email: row.email, firstName: row.first_name, lastName: row.last_name });
    if (existingId) {
      directory.updatePerson(existingId, patch, writePlan(req.ctx, "person", patch, existingId));
      return "updated";
    }
    directory.createPerson(patch, writePlan(req.ctx, "person", patch));
    return "added";
  }, where, "imported", { skipProblems });
  const ignored = ignoredColumns(rows, PERSON_COLUMNS, writable);
  auditFrom(req, "import.people", importSummary(counts), `from ${from}`);
  return { ...counts, ignored };
}

app.post("/api/people/import", editDir, (req, res) => {
  res.json({ ok: true, ...importPeople(req, parseCsvObjects(req.body?.csv), { createCompanies: Boolean(req.body?.createCompanies), skipProblems: req.body?.skipProblems === true }) });
});

/** Someone in a company, by the name they go by ("Bobby Host" or "Robert Host"), or null. */
function personInCompanyByName(companyId, name) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (!n) return null;
  return db.raw.prepare(`SELECT id FROM people WHERE company_id = ? AND active = 1
    AND (lower(first_name || ' ' || last_name) = lower(?) OR lower(coalesce(preferred_name, first_name) || ' ' || last_name) = lower(?))`).get(companyId, n, n)?.id ?? null;
}

/**
 * Imports visitors from rows keyed by column (first_name, last_name, organisation,
 * visitor_type, citizenship, email, phone, notes, blocked, company and host they visit,
 * custom field keys). A visitor with the
 * same email, else exactly the same name, is updated. Imported visitors count as checked by
 * staff. Clearances aren't imported: only the Security role sets them, by validating.
 */
function importVisitors(req, rows, { where, from = "CSV", skipProblems = false } = {}) {
  checkImport(rows, ["first_name", "last_name"]);
  const writable = writableColumns(req.ctx, "visitor");
  const list = access.fieldsFor(req.ctx, "visitor");
  const linksWritable = list.some((f) => f.key === "companies" && f.access === "edit");
  const plan = (patch, id = null) => {
    const fieldList = access.fieldsFor(req.ctx, "visitor", { recordId: id });
    return { custom: access.checkWrite(req.ctx, "visitor", patch, fieldList), editable: fieldList.filter((f) => f.access === "edit"), sites: req.ctx.sites };
  };
  const counts = importRows(rows, (row) => {
    const patch = rowPatch(row, VISITOR_COLUMNS, writable);
    let link = null;
    if (row.company && linksWritable) {
      const company = directory.findCompanyByName(row.company);
      if (!company || !directory.getCompany(company.id, { sites: req.ctx.sites })) throw fail(400, `There is no company called "${row.company}" at your sites.`);
      const hostId = row.host ? personInCompanyByName(company.id, row.host) : null;
      if (row.host && !hostId) throw fail(400, `Nobody at ${company.name} is called "${row.host}".`);
      link = { companyId: company.id, hostId };
    } else if (row.host && linksWritable) {
      throw fail(400, "A host needs the company they work for.");
    }
    const existingId = visitors.findMatch({ email: row.email, firstName: row.first_name, lastName: row.last_name });
    if (existingId) {
      if (!visitors.get(existingId, { sites: req.ctx.sites })) throw fail(403, `${row.first_name} ${row.last_name} is on record at a site this account can't see.`);
      visitors.update(existingId, patch, plan(patch, existingId));
      if (link) visitors.setLink(existingId, link, { sites: req.ctx.sites });
      return "updated";
    }
    visitors.create({ ...patch, links: link ? [link] : [] }, { ...plan(patch), source: "import" });
    return "added";
  }, where, "imported", { skipProblems });
  const ignored = ignoredColumns(rows, VISITOR_COLUMNS, writable).filter((c) => linksWritable ? !["host"].includes(c) : true);
  auditFrom(req, "import.visitors", importSummary(counts), `from ${from}`);
  return { ...counts, ignored };
}

const BADGE_COLUMNS = ["number", "type", "classification", "level", "sites", "temporary", "status", "notes"];
const BADGE_TYPE_NAMES = { personnel: "personnel", staff: "personnel", building: "personnel", tenant: "tenant", visitor: "visitor", guest: "visitor" };

/**
 * Imports badges from rows keyed by column (number, type, classification, level, sites,
 * temporary, status, notes). A badge with the same number is updated (one that is out can't
 * change its type, classification, level or temporary flag). Level names only for roles that
 * see clearance levels.
 */
function importBadges(req, rows, { where, from = "CSV", skipProblems = false } = {}) {
  checkImport(rows, ["number", "type", "classification"]);
  const seesLevels = access.canSeeClearances(req.ctx);
  if (!seesLevels && rows.some((r) => r.level)) throw fail(403, "This account doesn't see clearance levels, so it can't import them; leave the level out, or ask Security.");
  const classes = clearance.classifications();
  const levels = clearance.levels();
  // Custom badge fields the caller may change, by their key.
  const customDefs = new Map(access.fieldsFor(req.ctx, "badge").filter((f) => !f.builtIn && f.access === "edit" && f.recordId === null).map((f) => [f.apiKey, f]));
  const counts = importRows(rows, (row) => {
    const input = { number: row.number };
    const values = new Map();
    for (const [key, def] of customDefs) if (row[key] !== undefined && row[key] !== "") values.set(def.id, normaliseFieldValue(def, row[key]));
    const type = BADGE_TYPE_NAMES[String(row.type || "").trim().toLowerCase()];
    if (!type) throw fail(400, `"${row.type}" isn't a badge type: personnel, tenant or visitor.`);
    input.type = type;
    const cls = classes.find((c) => c.name.toLowerCase() === String(row.classification || "").trim().toLowerCase());
    if (!cls) throw fail(400, `There is no classification called "${row.classification}" (${classes.map((c) => c.name).join(", ")}).`);
    input.classificationId = cls.id;
    if (row.level) {
      const level = levels.find((l) => l.name.toLowerCase() === String(row.level).trim().toLowerCase());
      if (!level) throw fail(400, `There is no clearance level called "${row.level}".`);
      input.clearanceLevelId = level.id;
    } else if (!cls.requiresClearance) {
      input.clearanceLevelId = null;
    }
    if (row.sites) input.siteIds = String(row.sites).split(";").map((s) => s.trim()).filter(Boolean).map((s) => siteByName(req.ctx, s).id);
    if (row.temporary) input.temporary = parseYesNo(row.temporary, "temporary");
    if (row.status) {
      const status = String(row.status).trim().toLowerCase();
      if (!["active", "lost", "retired"].includes(status)) throw fail(400, `"${row.status}" isn't a badge status: active, lost or retired.`);
      input.status = status;
    }
    if (row.notes) input.notes = row.notes;
    const existingId = badges.findByNumber(row.number);
    if (existingId) {
      if (!badges.get(existingId, { sites: req.ctx.sites })) throw fail(403, `Badge ${row.number} is valid only at sites this account can't see.`);
      badges.update(existingId, input, { sites: req.ctx.sites });
      fields.writeValues(existingId, values);
      return "updated";
    }
    const status = input.status;
    delete input.status;
    const made = badges.create(input, { sites: req.ctx.sites });
    fields.writeValues(made.id, values);
    if (status && status !== "active") badges.update(made.id, { status }, { sites: req.ctx.sites });
    return "added";
  }, where, "imported", { skipProblems });
  const ignored = Object.keys(rows[0]).filter((c) => !BADGE_COLUMNS.includes(c) && !customDefs.has(c));
  auditFrom(req, "import.badges", importSummary(counts), `from ${from}`);
  return { ...counts, ignored };
}

// Importing from an Access database or a CSV file, with its columns matched to fields.
app.use(createImportRoutes({ access, importCompanies, importPeople, importVisitors, importBadges, auditFrom }));

// --- custom fields (administrators) ------------------------------------------------------------

function fieldOut(d) {
  let recordName = null;
  if (d.recordId !== null) {
    const rec = d.entity === "company" ? directory.getCompany(d.recordId) : d.entity === "visitor" ? visitors.get(d.recordId) : d.entity === "badge" ? badges.get(d.recordId) : directory.getPerson(d.recordId);
    recordName = rec ? (d.entity === "company" ? rec.name : d.entity === "badge" ? `Badge ${rec.number}` : `${rec.firstName} ${rec.lastName}`) : "(removed)";
  }
  return { ...d, recordName };
}

// Custom fields: administrators, and roles that manage custom fields (Settings > Roles) for the
// records they can change. Deleting a field (and every value in it) stays with administrators.
const fieldManager = (req, res, next) => (access.canManageFields(req.ctx) ? next() : res.status(403).json({ error: "This account can't add custom fields." }));

/** Refuses a field for a kind of record the caller doesn't manage fields for. */
function checkFieldEntity(req, entity) {
  if (!access.fieldEntitiesFor(req.ctx).includes(entity)) {
    throw fail(403, `This account can't add or change ${({ company: "company", person: "people", visitor: "visitor", badge: "badge" })[entity] || "those"} fields.`);
  }
}

/** A field for one record: only for a record the caller can see. */
function checkFieldRecord(req, entity, recordId) {
  if (req.ctx.isAdmin) return;
  const sitesLimit = { sites: req.ctx.sites };
  const rec = entity === "company" ? directory.getCompany(recordId, sitesLimit) : entity === "person" ? directory.getPerson(recordId, sitesLimit) : entity === "visitor" ? visitors.get(recordId, sitesLimit) : badges.get(recordId, sitesLimit);
  if (!rec) throw fail(404, "No such record, or not at your sites.");
}

app.get("/api/fields", fieldManager, (req, res) => {
  const mine = new Set(access.fieldEntitiesFor(req.ctx));
  res.json({
    // Every kind of record is listed; those the caller doesn't manage are empty.
    fields: Object.fromEntries(ENTITIES.map((e) => [e, mine.has(e) ? fields.list(e, { allRecords: true }).map(fieldOut) : []])),
    entities: [...mine],
    canDelete: req.ctx.isAdmin,
    types: FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] })),
    visibility: NEW_FIELD_VISIBILITY
  });
});

app.post("/api/fields", fieldManager, (req, res) => {
  const body = req.body || {};
  checkFieldEntity(req, body.entity);
  if (body.recordId) checkFieldRecord(req, body.entity, positiveInt(body.recordId));
  let def;
  db.transaction(() => {
    def = fields.create({ entity: body.entity, label: body.label, type: body.type, choices: body.choices, required: body.required, recordId: body.recordId ? positiveInt(body.recordId) : null });
    access.initCustomField(def, body.visibility || "all");
  });
  auditFrom(req, "field.add", `${def.entity}.${def.key}`, `${def.type}${def.recordId ? ` on record ${def.recordId} only` : ""}; visible to ${body.visibility || "all"}`);
  res.json({ ok: true, field: fieldOut(def) });
});

app.put("/api/fields/:id", fieldManager, (req, res) => {
  const before = fields.get(positiveInt(req.params.id));
  if (!before) throw fail(404, "No such field.");
  checkFieldEntity(req, before.entity);
  if (before.recordId !== null) checkFieldRecord(req, before.entity, before.recordId);
  const def = fields.update(positiveInt(req.params.id), req.body || {});
  auditFrom(req, "field.update", `${def.entity}.${def.key}`, before && before.recordId !== null && def.recordId === null ? "made database-wide" : changedKeys(req.body));
  res.json({ ok: true, field: fieldOut(def) });
});

app.delete("/api/fields/:id", admin, (req, res) => {
  let def;
  db.transaction(() => {
    def = fields.remove(positiveInt(req.params.id));
    access.forgetCustomField(def);
  });
  auditFrom(req, "field.remove", `${def.entity}.${def.key}`, "and every value in it");
  res.json({ ok: true });
});

// --- roles and the field access grid (administrators) -------------------------------------------

function rolesOut() {
  const users = authGuard.loadUsers();
  return access.listRoles().map((r) => ({ ...r, accounts: users.filter((u) => authGuard.rolesOf(u).includes(r.id)).length }));
}

app.get("/api/roles", admin, (req, res) => {
  res.json({ roles: rolesOut(), levels: AREA_LEVELS, badgeLevels: BADGE_LEVELS });
});

app.post("/api/roles", admin, (req, res) => {
  const role = access.createRole(req.body || {});
  auditFrom(req, "role.add", role.name, `directory ${role.directory}, visitors ${role.visitors}, badges ${role.badges}, facilities ${role.facilities}${role.clearances ? ", sees clearance levels" : ""}${role.fields ? ", manages custom fields" : ""}; fields copied from ${req.body?.copyFrom || "viewer"}`);
  res.json({ ok: true, role });
});

app.put("/api/roles/:id", admin, (req, res) => {
  const role = access.updateRole(String(req.params.id), req.body || {});
  auditFrom(req, "role.update", role.name, `directory ${role.directory}, visitors ${role.visitors}, badges ${role.badges}, facilities ${role.facilities}${role.clearances ? ", sees clearance levels" : ""}${role.fields ? ", manages custom fields" : ""}`);
  res.json({ ok: true, role });
});

app.delete("/api/roles/:id", admin, (req, res) => {
  const id = String(req.params.id);
  const users = authGuard.loadUsers();
  // Refused while it is someone's only role; accounts with other roles just lose it.
  const role = access.deleteRole(id, users.filter((u) => authGuard.rolesOf(u).length === 1 && authGuard.rolesOf(u)[0] === id).length);
  const losing = users.filter((u) => authGuard.rolesOf(u).includes(id));
  for (const u of losing) {
    u.roles = authGuard.rolesOf(u).filter((r) => r !== id);
    u.role = u.roles[0];
  }
  if (losing.length) store.write("users", users);
  auditFrom(req, "role.remove", role.name, losing.length ? `taken from ${losing.map((u) => u.username).join(", ")}` : null);
  res.json({ ok: true });
});

// --- API clients (administrators) ----------------------------------------------------------------

/** A client with the fields it receives: { company: [keys], person: [keys] }. */
function apiClientOut(client) {
  const ctx = access.contextFor({ role: client.roleId });
  const keys = (entity) => access.fieldsFor(ctx, entity).filter((f) => f.recordId === null).map((f) => (f.builtIn ? f.key : f.apiKey));
  return { ...client, fields: { company: keys("company"), person: keys("person") } };
}

/** Every field a client could be given, database-wide ones only. */
function apiFieldChoices() {
  // Clearance details are never given to API clients.
  const choices = (entity) => access.allFields(entity).filter((f) => !f.sensitive).map((f) => ({ key: f.builtIn ? f.key : f.apiKey, label: f.label, locked: f.locked, builtIn: f.builtIn }));
  return { company: choices("company"), person: choices("person") };
}

app.get("/api/api-clients", admin, (req, res) => {
  res.json({ clients: apiClients.list().map(apiClientOut), fields: apiFieldChoices() });
});

app.post("/api/api-clients", admin, (req, res) => {
  const body = req.body || {};
  let result;
  db.transaction(() => {
    result = apiClients.create({ name: body.name, sites: body.sites ?? null, canWrite: body.canWrite });
    if (body.fields) access.setApiFields(result.client.roleId, body.fields);
  });
  const out = apiClientOut(result.client);
  auditFrom(req, "api_client.add", out.name, `${out.canWrite ? "may add people" : "read only"}; sites ${out.sites ? out.sites.join(", ") : "all"}; fields ${[...out.fields.company.map((k) => `company.${k}`), ...out.fields.person.map((k) => `person.${k}`)].join(", ")}`);
  res.json({ ok: true, client: out, key: result.key });
});

app.put("/api/api-clients/:id", admin, (req, res) => {
  const id = positiveInt(req.params.id);
  const body = req.body || {};
  let client;
  db.transaction(() => {
    client = apiClients.update(id, { name: body.name, sites: body.sites, canWrite: body.canWrite });
    if (body.fields) access.setApiFields(client.roleId, body.fields);
  });
  const out = apiClientOut(client);
  auditFrom(req, "api_client.update", out.name, `${out.canWrite ? "may add people" : "read only"}; sites ${out.sites ? out.sites.join(", ") : "all"}; fields ${[...out.fields.company.map((k) => `company.${k}`), ...out.fields.person.map((k) => `person.${k}`)].join(", ")}`);
  res.json({ ok: true, client: out });
});

app.post("/api/api-clients/:id/key", admin, (req, res) => {
  const { client, key } = apiClients.newKey(positiveInt(req.params.id));
  auditFrom(req, "api_client.key", client.name, "new key; the old one stopped working");
  res.json({ ok: true, client: apiClientOut(client), key });
});

app.delete("/api/api-clients/:id", admin, (req, res) => {
  const client = apiClients.remove(positiveInt(req.params.id));
  auditFrom(req, "api_client.remove", client.name);
  res.json({ ok: true });
});

app.get("/api/field-access", admin, (req, res) => {
  res.json(access.grid());
});

app.put("/api/field-access", admin, (req, res) => {
  const changes = req.body?.changes;
  const count = access.setPolicies(changes);
  auditFrom(req, "field_access.update", `${count} cell${count === 1 ? "" : "s"}`, changes.slice(0, 20).map((c) => `${c.roleId} ${c.entity}.${c.field}=${c.access}`).join("; "));
  res.json({ ok: true, ...access.grid() });
});

// --- backup (administrators) ---------------------------------------------------------------------

/**
 * A copy of the database, still encrypted with the same key: useless without it, and
 * the key is not in it. Restore by stopping the app and putting the file in place.
 */
app.get("/api/backup", admin, (req, res) => {
  const tmp = path.join(os.tmpdir(), `ivm-backup-${process.pid}-${Date.now()}.db`);
  db.backupTo(tmp);
  auditFrom(req, "backup.download", path.basename(db.file), `${fs.statSync(tmp).size} bytes`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="identity-${new Date().toISOString().slice(0, 10)}.db"`);
  res.sendFile(tmp, (error) => {
    fs.rm(tmp, { force: true }, () => {});
    if (error && !res.headersSent) res.status(500).json({ error: "The backup could not be sent." });
  });
});

// --- the name in the header (administrators) ------------------------------------------------------

app.get("/api/branding", admin, (req, res) => {
  res.json({ ...branding(), defaultName: DEFAULT_APP_NAME });
});

app.put("/api/branding", admin, (req, res) => {
  const name = String(req.body?.name ?? "").replace(/\s+/g, " ").trim();
  const subtitle = String(req.body?.subtitle ?? "").replace(/\s+/g, " ").trim();
  if (name.length > 60) throw fail(400, "Keep the name to 60 characters.");
  if (subtitle.length > 80) throw fail(400, "Keep the line under it to 80 characters.");
  // Empty: back to the default.
  db.setSetting("branding.name", name && name !== DEFAULT_APP_NAME ? name : null);
  db.setSetting("branding.subtitle", subtitle || null);
  auditFrom(req, "branding.update", branding().name, subtitle ? `subtitle "${subtitle}"` : "no subtitle");
  res.json({ ok: true, ...branding() });
});

// --- Microsoft Entra ID and the audit log (administrators) -------------------------------------------

app.get("/api/entra", admin, (req, res) => {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const base = APP_URL || `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
  res.json({ entra: entra.publicConfig(), redirectUri: `${base}/api/auth/entra/callback`, appUrlSet: Boolean(APP_URL), roles: access.listRoles({ kind: "user" }) });
});

app.put("/api/entra", admin, (req, res) => {
  const saved = entra.save(req.body || {});
  auditFrom(req, "entra.update", saved.tenantId || "(none)", `${saved.enabled ? "on" : "off"}; ${saved.credential === "certificate" ? "certificate" : "client secret"}; default role ${saved.defaultRole}${req.body?.clientSecret ? "; secret changed" : ""}`);
  res.json({ ok: true, entra: saved });
});

// Certificates instead of a client secret. Private keys and PFX passwords never leave the
// server or reach the audit log; only thumbprints do.
app.post("/api/entra/certificates/generate", admin, (req, res) => {
  const certificate = entra.newCertificate(req.body || {});
  auditFrom(req, "entra.certificate_add", certificate.thumbprint, `made here, valid to ${new Date(certificate.notAfter).toISOString().slice(0, 10)}`);
  res.json({ ok: true, certificate });
});

app.post("/api/entra/certificates/upload", admin, (req, res) => {
  const certificate = entra.uploadCertificate(req.body || {});
  auditFrom(req, "entra.certificate_add", certificate.thumbprint, `uploaded, valid to ${new Date(certificate.notAfter).toISOString().slice(0, 10)}`);
  res.json({ ok: true, certificate });
});

app.post("/api/entra/certificates/:id/use", admin, (req, res) => {
  const certificate = entra.useCertificate(req.params.id);
  auditFrom(req, "entra.certificate_use", certificate.thumbprint);
  res.json({ ok: true, certificate });
});

app.delete("/api/entra/certificates/:id", admin, (req, res) => {
  const certificate = entra.removeCertificate(req.params.id);
  auditFrom(req, "entra.certificate_remove", certificate.thumbprint);
  res.json({ ok: true });
});

app.get("/api/entra/certificates/:id/cer", admin, (req, res) => {
  const file = entra.certificateFile(req.params.id);
  res.setHeader("Content-Type", "application/pkix-cert");
  res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
  res.send(file.der);
});

app.post("/api/entra/test", admin, async (req, res) => {
  const result = await entra.testCredential({ certificateId: req.body?.certificateId ? String(req.body.certificateId) : null });
  auditFrom(req, "entra.test", result.ok ? "accepted" : "refused", result.message.slice(0, 300));
  res.json(result);
});

app.get("/api/audit", admin, (req, res) => {
  res.json(db.auditLog({ limit: Math.min(positiveInt(req.query.limit, 100), 500), before: positiveInt(req.query.before), action: str(req.query.action), username: str(req.query.username) }));
});

/** Where an iPad opens the kiosk, for Settings > Kiosks. */
function kioskAddress(req) {
  if (KIOSK_URL) return `${KIOSK_URL}/kiosk/`;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  if (!KIOSK_PORT) return `${APP_URL || `${proto}://${host}`}/kiosk/`;
  // Its own port on this host; through a proxy, set KIOSK_URL to the kiosk's hostname.
  const hostname = host.replace(/:\d+$/, "");
  return `${proto}://${hostname}:${KIOSK_PORT}/kiosk/`;
}

app.use(createVisitorRoutes({ access, visitors, kiosks, clock, admin, auditFrom, publicFields, kioskAddress, kioskPort: KIOSK_PORT, badges, events, clearance }));
// The clearance routes first: they mark everything under /api/clearance no-store, the
// level list the badge routes answer included.
app.use(clearanceRoutes.router);
app.use(createFacilityRoutes({ access, facilities, directory, sites, auditFrom }));
app.use(createBadgeRoutes({ access, badges, clearance, templates, events, visitors, directory, fields, admin, auditFrom, transaction: (fn) => db.transaction(fn) }));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Anything thrown in a route (Express 5 passes rejected promises here too) answers as
// JSON with its status instead of an HTML page.
function jsonErrors(error, req, res, next) { // eslint-disable-line no-unused-vars
  const status = Number(error.status) || (error.type === "entity.too.large" ? 413 : 500);
  if (status >= 500 && !error.status) console.error(`request failed: ${error.stack || error.message}`);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 && !error.status ? "Internal error." : error.message });
}
app.use(jsonErrors);
kioskApp.use(jsonErrors);

// --- boot ------------------------------------------------------------------

// Only boot when run directly, so tests (and the image build's smoke check) can
// require this file without starting a listener.
if (require.main === module) {
  let tlsOptions = null;
  try {
    tlsOptions = resolveTlsOptions({ dataDir: DATA_DIR });
  } catch (error) {
    // Failing loudly beats silently falling back to plain HTTP when TLS was asked for.
    console.error(`\n  !! TLS could not be configured: ${error.message}\n`);
    process.exit(1);
  }

  const scheme = tlsOptions ? "https" : "http";
  const listen = (handler) => (tlsOptions
    ? require("https").createServer({ key: tlsOptions.key, cert: tlsOptions.cert }, handler)
    : require("http").createServer(handler));
  const server = listen(app);
  // The kiosk port uses the same certificate as the main one.
  const kioskServer = KIOSK_PORT ? listen(kioskApp) : null;
  if (kioskServer) {
    kioskServer.on("error", (error) => {
      console.error(`\n  !! The kiosk port ${KIOSK_PORT} could not be opened: ${error.message}\n`);
      process.exit(1);
    });
    kioskServer.listen(KIOSK_PORT, () => console.log(`Kiosk: its own port, ${scheme}://localhost:${KIOSK_PORT}/kiosk/ (the main port has no /kiosk)`));
  }

  server.listen(PORT, () => {
    console.log(`Identity and Visitor Manager ${pkg.version} running at ${scheme}://localhost:${PORT}`);
    console.log(`Database: ${db.file} (encrypted; key from ${keyInfo.source})`);
    if (tlsOptions) {
      console.log(`TLS: on (${tlsOptions.mode}) - ${tlsOptions.detail}`);
      if (tlsOptions.mode === "self-signed") {
        console.log("     Self-signed: fine for a reverse proxy upstream, but browsers connecting directly will warn.");
      }
    } else {
      console.log("TLS: off (plain HTTP)");
    }
    console.log(`Sites: ${sites.list().map((s) => s.name).join(", ")}`);
    console.log(authGuard.hasUsers() ? `Accounts: ${authGuard.loadUsers().length} user(s) configured.` : "Accounts: none yet - open the app to create the first administrator.");
    console.log(`Kiosks: ${kiosks.list().length} (${KIOSK_PORT ? `on port ${KIOSK_PORT}` : "pages at /kiosk/ on this port"})`);
    console.log(`API clients: ${apiClients.list().length} (API at /api/v1)`);
    clock.start();
    console.log(`Entra ID sign-in: ${entra.isReady() ? `on (tenant ${entra.config().tenantId}, ${entra.config().credential === "certificate" ? "certificate" : "client secret"}${entra.config().source === "env" ? ", from environment" : ""})` : "off"}`);
    const entraCert = entra.config().credential === "certificate" ? entra.activeCertificate() : null;
    if (entraCert && entraCert.notAfter - Date.now() < 30 * 24 * 60 * 60 * 1000) {
      console.warn(`Entra ID: the sign-in certificate ${entraCert.thumbprint} ${entraCert.notAfter <= Date.now() ? "has expired" : `expires on ${new Date(entraCert.notAfter).toISOString().slice(0, 10)}`}; make a new one under Settings > Microsoft Entra ID.`);
    }
    if (entra.publicConfig().certificateError) console.warn(`Entra ID: ${entra.publicConfig().certificateError}`);
    if (authGuard.cookieSecure) {
      console.log("Session cookie: Secure (requires HTTPS end to end - sign-in fails over plain HTTP)");
    } else {
      console.log("Session cookie: not Secure (fine on loopback; set COOKIE_SECURE=true behind HTTPS)");
    }
  });

  const shutdown = () => {
    clock.stop();
    clearance.stop();
    if (kioskServer) kioskServer.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { app, kioskApp };
