/**
 * Working on several at once: merging companies (people, visitors' links, visits, events,
 * sites and fields of their own move to the kept one, which may take a merged one's name),
 * changing or deleting several companies or people, all or nothing, and who may.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Merging and bulk changes");
const PORT = Number(process.env.TEST_BULK_PORT) || 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const password = () => crypto.randomBytes(12).toString("base64url");

function client() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body) {
    const h = {};
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data };
  }
  return { get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b), put: (u, b = {}) => call("PUT", u, b), del: (u) => call("DELETE", u) };
}

async function waitFor(fn) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await fn()) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let server;
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-bulk-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), KIOSK_PORT: "", DATA_DIR: dataDir, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitFor(async () => (await fetch(`${BASE}/api/auth/me`)).ok))) {
    console.error(log);
    throw new Error("server did not start");
  }

  const admin = client();
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbor Point" });
  const harbor = (await admin.get("/api/config")).data.sites[0];
  const river = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const field = (await admin.post("/api/fields", { entity: "company", label: "Account manager", type: "text", visibility: "all" })).data.field;
  const mk = async (name, sites, extra = {}) => (await admin.post("/api/companies", { name, sites, ...extra })).data.company;
  const acme = await mk("Acme", [{ siteId: harbor.id, suite: "Suite 100" }], { phone: "555-0100", custom: { [field.key]: "Dana" } });
  const acmeInc = await mk("Acme Inc", [{ siteId: river.id, suite: "Unit 4" }], { phone: "555-0400", custom: { [field.key]: "Eve" } });
  const acmeCorp = await mk("ACME Corporation", [{ siteId: harbor.id, suite: "Suite 200" }]);
  const other = await mk("Globex", [{ siteId: harbor.id }]);
  const person = async (firstName, lastName, companyId, extra = {}) => (await admin.post("/api/people", { firstName, lastName, companyId, ...extra })).data.person;
  const ann = await person("Ann", "Able", acme.id);
  const bob = await person("Bob", "Baker", acmeInc.id, { siteId: river.id });
  const cat = await person("Cat", "Cole", acmeCorp.id);
  const dee = await person("Dee", "Dunn", other.id);
  // A field added to Acme Inc alone, with a value.
  const own = (await admin.post("/api/fields", { entity: "company", label: "Loading dock", type: "text", recordId: acmeInc.id })).data.field;
  await admin.put(`/api/companies/${acmeInc.id}`, { custom: { [own.key]: "Dock 3" } });
  // A visitor linked to Acme Inc and to Acme, a visit and an event at Acme Inc.
  const vera = (await admin.post("/api/visitors", { firstName: "Vera", lastName: "Visitor", links: [{ companyId: acmeInc.id, hostId: bob.id }, { companyId: acme.id, hostId: ann.id }] })).data.visitor;
  const visit = (await admin.post("/api/visits", { visitorId: vera.id, siteId: river.id, companyId: acmeInc.id })).data.visit;
  const event = (await admin.post("/api/events", { siteId: river.id, title: "Review", date: "2099-01-01", companyId: acmeInc.id })).data.event;

  const pw = { manny: password(), desk: password(), harborManager: password() };
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "harborManager", password: pw.harborManager, role: "manager", sites: [harbor.id] });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const desk = await as("desk");
  const harborManager = await as("harborManager");

  // --- merging companies ---------------------------------------------------------------------------
  const mergeBody = { intoId: acme.id, fromIds: [acmeInc.id, acmeCorp.id], company: { name: "Acme Corporation", custom: { [field.key]: "Eve" } } };
  check("merge: front desk can't (it only reads the directory)", (await desk.post("/api/companies/merge", mergeBody)).status === 403);
  check("merge: nor someone who can't see one of them", (await harborManager.post("/api/companies/merge", mergeBody)).status === 404);
  check("merge: needs another company", (await manager.post("/api/companies/merge", { intoId: acme.id, fromIds: [acme.id] })).status === 400);
  let r = await manager.post("/api/companies/merge", mergeBody);
  check("merge: a manager merges two into one", r.status === 200 && r.data.peopleMoved === 2 && r.data.merged.sort().join() === "ACME Corporation,Acme Inc", JSON.stringify(r.data));
  check("merge: the kept company takes a merged one's name", r.data.company.name === "Acme Corporation" && r.data.company.id === acme.id);
  const merged = (await admin.get(`/api/companies/${acme.id}`)).data;
  check("merge: everyone is in it", merged.people.map((p) => p.firstName).sort().join() === "Ann,Bob,Cat");
  check("merge: at every site any of them was, with their suites", merged.company.sites.map((s) => `${s.siteName}: ${s.suite}`).sort().join("; ") === "Harbor Point: Suite 100; Riverside: Unit 4");
  check("merge: a person keeps their site where the company still is", merged.people.find((p) => p.firstName === "Bob").siteId === river.id);
  check("merge: the field value chosen is kept", merged.company.custom[field.key] === "Eve" && merged.company.phone === "555-0100");
  check("merge: a field added to a merged company alone comes along, value and all", merged.company.custom[own.key] === "Dock 3" && merged.fields.some((f) => f.key === own.key && f.recordOnly));
  check("merge: the merged companies are gone", (await admin.get(`/api/companies/${acmeInc.id}`)).status === 404 && (await admin.get(`/api/companies/${acmeCorp.id}`)).status === 404);
  const v = (await admin.get(`/api/visitors/${vera.id}`)).data.visitor;
  check("merge: a visitor linked to both keeps one link, the kept company's", v.companies.length === 1 && v.companies[0].companyId === acme.id && v.companies[0].hostName === "Ann Able");
  check("merge: visits follow", (await admin.get(`/api/visits?companyId=${acme.id}`)).data.visits.some((x) => x.id === visit.id));
  check("merge: and events", (await admin.get(`/api/events/${event.id}`)).data.event.companyId === acme.id);
  check("merge: in the audit log", (await admin.get("/api/audit?action=company.merge")).data.entries.some((e) => /merged in/.test(e.detail)));

  // --- several companies -------------------------------------------------------------------------------
  check("companies: names can't be changed in bulk", (await manager.post("/api/companies/bulk", { ids: [acme.id, other.id], patch: { name: "Same" } })).status === 400);
  check("companies: front desk can't change them", (await desk.post("/api/companies/bulk", { ids: [other.id], patch: { active: false } })).status === 403);
  r = await manager.post("/api/companies/bulk", { ids: [acme.id, other.id], patch: { active: false } });
  check("companies: made inactive together", r.status === 200 && r.data.updated === 2 && (await admin.get(`/api/companies/${other.id}`)).data.company.active === false);
  await manager.post("/api/companies/bulk", { ids: [acme.id, other.id], patch: { active: true } });
  check("companies: only administrators delete them", (await manager.post("/api/companies/bulk-delete", { ids: [other.id] })).status === 403);
  const uncleared = (await admin.get("/api/clearance")).data.classifications.find((c) => !c.requiresClearance);
  const badge = (await admin.post("/api/badges", { number: "T-1", type: "tenant", classificationId: uncleared.id })).data.badge;
  await admin.post(`/api/badges/${badge.id}/assign`, { kind: "person", holderId: dee.id });
  r = await admin.post("/api/companies/bulk-delete", { ids: [other.id] });
  check("companies: not while one of their people holds a badge", r.status === 409 && (await admin.get(`/api/companies/${other.id}`)).status === 200);
  await admin.post(`/api/badges/${badge.id}/return`);

  // --- several people -------------------------------------------------------------------------------------
  const pfield = (await admin.post("/api/fields", { entity: "person", label: "Parking", type: "text", visibility: "all" })).data.field;
  const ids = [ann.id, bob.id, cat.id];
  check("people: names can't be changed in bulk", (await manager.post("/api/people/bulk", { ids, patch: { firstName: "X" } })).status === 400);
  check("people: front desk can't change them", (await desk.post("/api/people/bulk", { ids, patch: { jobTitle: "X" } })).status === 403);
  r = await manager.post("/api/people/bulk", { ids, patch: { jobTitle: "Engineer", canHost: false, custom: { [pfield.key]: "Level 2" } } });
  check("people: fields and custom fields changed for everyone", r.status === 200 && r.data.updated === 3);
  const after = await Promise.all(ids.map(async (id) => (await admin.get(`/api/people/${id}`)).data.person));
  check("people: each has the new values", after.every((p) => p.jobTitle === "Engineer" && p.canHost === false && p.custom[pfield.key] === "Level 2"));
  // Globex (Dee's company) isn't at Riverside, so Dee can't be placed there.
  r = await manager.post("/api/people/bulk", { ids: [...ids, dee.id], patch: { siteId: river.id, jobTitle: "Changed" } });
  check("people: a change one of them can't take changes nobody", r.status === 400 && /Nothing was changed/.test(r.data.error) && (await admin.get(`/api/people/${ann.id}`)).data.person.jobTitle === "Engineer");
  r = await manager.post("/api/people/bulk", { ids: [bob.id, dee.id], patch: { companyId: acme.id } });
  check("people: moved to another company together", r.status === 200 && (await admin.get(`/api/people/${dee.id}`)).data.person.companyId === acme.id);
  r = await manager.post("/api/people/bulk", { ids, patch: { active: false } });
  check("people: made inactive together", r.status === 200 && (await admin.get(`/api/people/${cat.id}`)).data.person.active === false);
  check("people: in the audit log", (await admin.get("/api/audit?action=person.bulk_update")).data.entries.length >= 3);
  check("people: only administrators delete them", (await manager.post("/api/people/bulk-delete", { ids: [cat.id] })).status === 403);
  await admin.post(`/api/badges/${badge.id}/assign`, { kind: "person", holderId: dee.id });
  r = await admin.post("/api/people/bulk-delete", { ids: [cat.id, dee.id] });
  check("people: not while one holds a badge, and then none are deleted", r.status === 409 && (await admin.get(`/api/people/${cat.id}`)).status === 200);
  await admin.post(`/api/badges/${badge.id}/return`);
  r = await admin.post("/api/people/bulk-delete", { ids: [cat.id, dee.id] });
  check("people: deleted together", r.status === 200 && r.data.deleted === 2 && (await admin.get(`/api/people/${dee.id}`)).status === 404);
  check("people: at most 1,000 at once, and at least one", (await manager.post("/api/people/bulk", { ids: [], patch: { jobTitle: "X" } })).status === 400);

  // --- several badges, moving between types (Security) ------------------------------------------------
  pw.sec = password();
  await admin.post("/api/users", { username: "sec", password: pw.sec, role: "security" });
  const security = await as("sec");
  const cleared = (await admin.get("/api/clearance")).data.classifications.find((c) => c.requiresClearance);
  const levels = (await admin.get("/api/clearance")).data.levels;
  const mkBadge = async (number, type = "tenant") => (await security.post("/api/badges", { number, type, classificationId: uncleared.id })).data.badge;
  const b1 = await mkBadge("B-1");
  const b2 = await mkBadge("B-2");
  const b3 = await mkBadge("B-3", "personnel");
  check("badges: only Security changes several", (await manager.post("/api/badges/bulk", { ids: [b1.id, b2.id], patch: { type: "visitor" } })).status === 403);
  r = await security.post("/api/badges/bulk", { ids: [b1.id, b2.id, b3.id], patch: { type: "visitor" } });
  check("badges: moved to visitor badges together", r.status === 200 && r.data.updated === 3 && (await security.get(`/api/badges/${b3.id}`)).data.badge.type === "visitor");
  r = await security.post("/api/badges/bulk", { ids: [b1.id, b2.id], patch: { type: "personnel", classificationId: cleared.id, clearanceLevelId: levels[0].id } });
  check("badges: and to personnel, cleared at a level", r.status === 200 && (await security.get(`/api/badges/${b1.id}`)).data.badge.clearanceLevelName === levels[0].name);
  const mover = (await admin.post("/api/people", { firstName: "Hal", lastName: "Holder", companyId: acme.id })).data.person;
  await security.post("/api/badges/bulk", { ids: [b2.id], patch: { type: "tenant", classificationId: uncleared.id } });
  await security.post(`/api/badges/${b2.id}/assign`, { kind: "person", holderId: mover.id });
  r = await security.post("/api/badges/bulk", { ids: [b2.id, b3.id], patch: { type: "personnel" } });
  check("badges: one that is out can't move, so none does", r.status === 409 && /Badge B-2/.test(r.data.error) && /Nothing was changed/.test(r.data.error) && (await security.get(`/api/badges/${b3.id}`)).data.badge.type === "visitor");
  check("badges: but its notes can change with the rest", (await security.post("/api/badges/bulk", { ids: [b2.id, b3.id], patch: { notes: "Box 4" } })).data.updated === 2);
  check("badges: a temporary visitor badge is refused", (await security.post("/api/badges/bulk", { ids: [b3.id], patch: { temporary: true } })).status === 409);
  check("badges: nothing to change is refused", (await security.post("/api/badges/bulk", { ids: [b3.id], patch: {} })).status === 400);
  r = await security.post("/api/badges/bulk-delete", { ids: [b2.id, b3.id] });
  check("badges: one with history can't be deleted, so none is", r.status === 409 && /retire it instead/.test(r.data.error) && (await security.get(`/api/badges/${b3.id}`)).status === 200);
  await security.post(`/api/badges/${b2.id}/return`);
  check("badges: retired together", (await security.post("/api/badges/bulk", { ids: [b2.id, b1.id], patch: { status: "retired" } })).data.updated === 2);
  r = await security.post("/api/badges/bulk-delete", { ids: [b3.id, b1.id] });
  check("badges: deleted together", r.status === 200 && r.data.deleted === 2 && (await security.get(`/api/badges/${b1.id}`)).status === 404);

  // --- custom badge fields --------------------------------------------------------------------------
  const lanyard = (await admin.post("/api/fields", { entity: "badge", label: "Lanyard color", type: "text", visibility: "all" })).data.field;
  check("badge fields: an administrator adds one", lanyard && lanyard.entity === "badge" && lanyard.key === "lanyard_color");
  const grid = (await admin.get("/api/field-access")).data;
  const gridField = grid.entities.badge.find((f) => f.apiKey === lanyard.key);
  const cell = (role) => gridField.access[role];
  check("badge fields: Security (manage) can change them, others who see badges only read them", cell("security") === "edit" && cell("frontdesk") === "view" && cell("manager") === "view" && cell("viewer") === "view");
  check("badge fields: the grid can't let a role that only issues badges change them", (await admin.put("/api/field-access", { changes: [{ roleId: "frontdesk", entity: "badge", field: gridField.key, access: "edit" }] })).status === 400);
  r = await security.post("/api/badges", { number: "L-1", type: "visitor", classificationId: uncleared.id, custom: { [lanyard.key]: "Red" } });
  check("badge fields: set when a badge is added", r.status === 200 && r.data.badge.custom[lanyard.key] === "Red");
  check("badge fields: front desk sees them", (await desk.get(`/api/badges/${r.data.badge.id}`)).data.badge.custom[lanyard.key] === "Red"
    && (await desk.get("/api/badges?q=L-1")).data.badges[0].custom[lanyard.key] === "Red");
  const l1 = r.data.badge;
  check("badge fields: but can't change them", (await desk.put(`/api/badges/${l1.id}`, { custom: { [lanyard.key]: "Blue" } })).status === 403);
  check("badge fields: Security changes them", (await security.put(`/api/badges/${l1.id}`, { custom: { [lanyard.key]: "Blue" } })).data.badge.custom[lanyard.key] === "Blue");
  check("badge fields: an unknown one is refused", (await security.put(`/api/badges/${l1.id}`, { custom: { nope: "x" } })).status === 400);
  const range = (await security.post("/api/badges/range", { prefix: "R-", from: 1, to: 3, type: "visitor", classificationId: uncleared.id, custom: { [lanyard.key]: "Green" } })).data;
  check("badge fields: a range gets them all", range.count === 3 && range.last.custom[lanyard.key] === "Green");
  const rangeIds = (await security.get("/api/badges?q=R-")).data.badges.map((b) => b.id);
  r = await security.post("/api/badges/bulk", { ids: [l1.id, ...rangeIds], patch: { custom: { [lanyard.key]: "Black" } } });
  check("badge fields: changed on several at once", r.status === 200 && r.data.updated === 4 && (await security.get(`/api/badges/${rangeIds[0]}`)).data.badge.custom[lanyard.key] === "Black");
  const req2 = (await admin.post("/api/fields", { entity: "badge", label: "Box", type: "text", required: true, visibility: "all" })).data.field;
  check("badge fields: a required one must be given for a new badge", (await security.post("/api/badges", { number: "L-2", type: "visitor", classificationId: uncleared.id })).status === 400
    && (await security.post("/api/badges", { number: "L-2", type: "visitor", classificationId: uncleared.id, custom: { [req2.key]: "4" } })).status === 200);
  await security.post("/api/badges/bulk-delete", { ids: rangeIds });
  check("badge fields: deleted with their badge", (await security.get(`/api/badges/${rangeIds[0]}`)).status === 404);

  // --- light or dark, kept with the account ----------------------------------------------------------
  check("theme: follows the device to start with", (await manager.get("/api/me/prefs")).data.theme === "auto");
  check("theme: kept when chosen", (await manager.put("/api/me/prefs", { theme: "light" })).data.theme === "light" && (await manager.get("/api/me/prefs")).data.theme === "light");
  check("theme: only auto, light or dark", (await manager.put("/api/me/prefs", { theme: "purple" })).status === 400);

  server.kill();
  await new Promise((r2) => setTimeout(r2, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  check("ran without throwing", false, error.stack || error.message);
}).finally(() => {
  if (server && server.exitCode === null) server.kill();
  process.exit(report() ? 0 : 1);
});
