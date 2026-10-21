/**
 * Clearance validation: asking for it (optionally with the last four of the SSN), the
 * Security role's queue, validating and cancelling, the digits held only in memory and
 * wiped (on validation, cancelling, deletion, expiry and shutdown), the visitor re-check
 * period, and that the digits never reach the database, the audit log or the server's log.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { openDatabase, openEncrypted, DB_FILE } = require("../db");
const { generateKey } = require("../db-key");
const { createFields } = require("../fields");
const { createDirectory } = require("../directory");
const { createVisitors } = require("../visitors");
const { createClearance, statusFor } = require("../clearance");
const { takeDigits, digitsBody } = require("../clearance-routes");

const { check, report } = createChecker("Clearance validation");
const throwsStatus = (fn, status, pattern = null) => {
  try { fn(); return false; } catch (error) { return error.status === status && (!pattern || pattern.test(error.message)) ? true : `${error.status}: ${error.message}`; }
};
const DAY = 24 * 60 * 60 * 1000;

// The digits used throughout, and a test for them standing on their own (not inside a
// hash or a timestamp, where any four digits turn up by chance).
const DIGITS = "6042";
const OTHER = "3187";
const standsAlone = (digits) => new RegExp(`(?<![0-9a-fA-F])${digits}(?![0-9a-fA-F])`);
const mentions = (text, digits = DIGITS) => standsAlone(digits).test(String(text));

/** Every text value in every table of an open database, joined. */
function everyText(raw) {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  const out = [];
  for (const t of tables) {
    for (const row of raw.prepare(`SELECT * FROM "${t}"`).all()) {
      for (const v of Object.values(row)) if (typeof v === "string") out.push(v);
    }
  }
  return out.join("\n");
}

// --- without HTTP, on a clock we move ------------------------------------------------------------
function inProcess() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-clearance-"));
  const db = openDatabase({ dataDir: tmp, key: generateKey() });
  const fields = createFields({ db });
  const directory = createDirectory({ db, fields });
  const visitors = createVisitors({ db, fields });
  let t = Date.now();
  const clearance = createClearance({ db, now: () => t });
  const L = Object.fromEntries(clearance.levels().map((l) => [l.name, l]));

  const acme = directory.createCompany({ name: "Acme Corp" });
  const person = directory.createPerson({ firstName: "Pat", lastName: "Person", companyId: acme.id });
  const visitor = visitors.create({ firstName: "Val", lastName: "Visitor" });
  check("status: someone new is unvalidated", directory.getPerson(person.id).clearanceStatus === "unvalidated" && visitors.get(visitor.id).clearanceStatus === "unvalidated");

  check("request: the digits must be four digits", throwsStatus(() => clearance.requestValidation({ kind: "person", id: person.id, last4: "60a2" }), 400) === true);
  check("request: and an error never repeats them", throwsStatus(() => clearance.requestValidation({ kind: "person", id: person.id, last4: "12345" }), 400, /^(?!.*12345)/) === true);
  check("request: the digits can't go in the note, which is kept", throwsStatus(() => clearance.requestValidation({ kind: "person", id: person.id, last4: DIGITS, note: `SSN ends 60-42` }), 400, /note/) === true);
  check("request: nothing is kept from a refused request", clearance.openCount() === 0);

  const first = clearance.requestValidation({ kind: "person", id: person.id, last4: DIGITS, note: "New starter", by: "manny" });
  check("request: made, with the digits held", first.hadDigits === true && !mentions(JSON.stringify(first)));
  check("status: someone waiting is marked requested", directory.getPerson(person.id).clearanceStatus === "requested");
  const queue = clearance.openRequests();
  check("queue: lists the request, never the digits", queue.length === 1 && queue[0].name === "Pat Person" && queue[0].digitsHeld === true && queue[0].note === "New starter" && !mentions(JSON.stringify(queue)));
  check("queue: the digits come one request at a time, as bytes", Buffer.isBuffer(clearance.digitsOf(first.id)) && clearance.digitsOf(first.id).toString() === DIGITS);
  check("database: the digits aren't in it", !mentions(everyText(db.raw)));

  const second = clearance.requestValidation({ kind: "person", id: person.id, last4: OTHER, by: "manny" });
  check("request: asking again replaces the waiting request, and wipes its digits", clearance.openCount() === 1 && clearance.digitsOf(first.id) === null && clearance.digitsOf(second.id).toString() === OTHER);
  check("expiry: 36 hours to start with", clearance.DIGITS_TTL_HOURS === 36);
  t += 35 * 60 * 60 * 1000;
  check("expiry: still held before then", clearance.digitsOf(second.id) !== null);
  t += 60 * 60 * 1000 + 1000;
  check("expiry: the digits are wiped after their time", clearance.digitsOf(second.id) === null && clearance.openRequests()[0].digitsHeld === false);
  check("expiry: the request itself still waits", clearance.openCount() === 1 && clearance.openRequests()[0].hadDigits === true);

  const third = clearance.requestValidation({ kind: "person", id: person.id, last4: DIGITS, by: "manny" });
  const done = clearance.validate({ kind: "person", id: person.id, levelId: L.TS.id, granted: "2025-01-02", expires: "2030-01-02", by: "sec" });
  check("validate: the request is closed and its digits wiped", done.closed === 1 && clearance.openCount() === 0 && clearance.digitsOf(third.id) === null);
  const p = directory.getPerson(person.id);
  check("validate: the level, dates, when and by whom are recorded", p.clearanceLevel === L.TS.id && p.clearanceGranted === "2025-01-02" && p.clearanceExpires === "2030-01-02" && p.clearanceValidatedAt === t && p.clearanceValidatedBy === "sec" && p.clearanceStatus === "validated");
  check("validate: it now counts for badges", clearance.effectiveLevel({ kind: "person", clearanceLevelId: p.clearanceLevel, clearanceExpires: p.clearanceExpires, clearanceValidatedAt: p.clearanceValidatedAt })?.name === "TS");
  check("validate: no clearance at all can be validated too", clearance.validate({ kind: "visitor", id: visitor.id, levelId: null, by: "sec" }).level === null && visitors.get(visitor.id).clearanceStatus === "validated");
  check("validate: an expiry before the grant is refused", throwsStatus(() => clearance.validate({ kind: "person", id: person.id, levelId: L.TS.id, granted: "2025-01-02", expires: "2024-01-01" }), 400) === true);
  check("validate: an unknown level is refused", throwsStatus(() => clearance.validate({ kind: "person", id: person.id, levelId: 9999 }), 400) === true);

  const cancelled = clearance.requestValidation({ kind: "visitor", id: visitor.id, last4: DIGITS });
  clearance.cancelRequest(cancelled.id, "sec");
  check("cancel: the request goes and its digits are wiped", clearance.openCount() === 0 && clearance.digitsOf(cancelled.id) === null);

  // Visitors are re-checked every so often; people aren't.
  clearance.validate({ kind: "visitor", id: visitor.id, levelId: L.Secret.id, by: "sec" });
  const vRec = () => ({ kind: "visitor", clearanceLevelId: L.Secret.id, clearanceValidatedAt: visitors.get(visitor.id).clearanceValidatedAt });
  check("re-check: 90 days to start with", clearance.settings().visitorRecheckDays === 90);
  t += 89 * DAY;
  check("re-check: within the period a visitor's clearance counts", clearance.effectiveLevel(vRec())?.name === "Secret" && visitors.get(visitor.id).clearanceStatus === "validated");
  t += 2 * DAY;
  check("re-check: after it, it doesn't, and they're marked for re-checking", clearance.effectiveLevel(vRec()) === null && statusFor("visitor", visitors.get(visitor.id), 90, t) === "recheck" && /re-checked/.test(clearance.notCounting(vRec())));
  check("re-check: a person's validation doesn't lapse", directory.getPerson(person.id).clearanceStatus === "validated");
  clearance.saveSettings({ visitorRecheckDays: 120 });
  check("re-check: the period is a setting", clearance.settings().visitorRecheckDays === 120 && clearance.effectiveLevel(vRec())?.name === "Secret");
  check("re-check: it must be 1 to 3,650 days", throwsStatus(() => clearance.saveSettings({ visitorRecheckDays: 0 }), 400) === true && throwsStatus(() => clearance.saveSettings({ visitorRecheckDays: 4000 }), 400) === true);

  // Deleting someone wipes what was held for them.
  const gone = directory.createPerson({ firstName: "Gone", lastName: "Soon", companyId: acme.id });
  const goneReq = clearance.requestValidation({ kind: "person", id: gone.id, last4: DIGITS });
  directory.deletePerson(gone.id);
  clearance.sweepDigits();
  check("delete: their request is cancelled and the digits wiped", clearance.openCount() === 0 && clearance.digitsOf(goneReq.id) === null);
  const mergeFrom = visitors.create({ firstName: "Val", lastName: "Visitor", phone: "555" });
  clearance.requestValidation({ kind: "visitor", id: mergeFrom.id, last4: DIGITS });
  visitors.merge(mergeFrom.id, visitor.id);
  check("merge: a waiting request follows the visitor merged into", clearance.openRequests()[0]?.holderId === visitor.id && visitors.get(visitor.id).clearanceStatus === "requested");
  const held = clearance.openRequests()[0].id;
  clearance.stop();
  check("shutdown: everything held is wiped", clearance.digitsOf(held) === null);
  check("database: the digits were never written, after all of that", !mentions(everyText(db.raw)) && !mentions(everyText(db.raw), OTHER));

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- reading the digits out of a raw body ----------------------------------------------------------
function rawBodies() {
  const take = (text) => {
    const buf = Buffer.from(text, "latin1");
    const digits = takeDigits(buf);
    return { digits: digits && digits.toString(), left: buf.toString("latin1"), parsed: JSON.parse(buf.toString("latin1")) };
  };
  let r = take(`{"kind":"person","id":1,"last4":"${DIGITS}","note":"New starter"}`);
  check("raw: the digits come out as bytes", r.digits === DIGITS);
  check("raw: and are blanked in the body, which still parses", !mentions(r.left) && r.parsed.last4 === null && r.parsed.note === "New starter" && r.parsed.id === 1);
  r = take(`{ "last4" :  "${DIGITS}" , "kind": "visitor" }`);
  check("raw: spaces around the key are fine", r.digits === DIGITS && !mentions(r.left) && r.parsed.kind === "visitor");
  check("raw: null or empty means no digits", take('{"last4":null,"kind":"person"}').digits === null && take('{"last4":"","kind":"person"}').digits === null && take('{"kind":"person"}').digits === null);
  const refuses = (text) => throwsStatus(() => takeDigits(Buffer.from(text, "latin1")), 400) === true;
  check("raw: digits sent as a number are refused", refuses(`{"last4":${DIGITS}}`));
  check("raw: anything but four digits is refused", refuses('{"last4":"60a2"}') && refuses('{"last4":"60421"}') && refuses(String.raw`{"last4":"\u0036042"}`));
  check("raw: the key given twice is refused", refuses(`{"last4":"${DIGITS}","last4":"${OTHER}"}`));
  const out = digitsBody(Buffer.from(DIGITS, "latin1"));
  check("raw: the answer to Security is valid JSON", JSON.parse(out.toString()).last4 === DIGITS);
}

// --- over HTTP --------------------------------------------------------------------------------------
const PORT = Number(process.env.TEST_CLEARANCE_PORT) || 3984;
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
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, text, cache: res.headers.get("cache-control"), etag: res.headers.get("etag") };
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

/** A lifetime that makes no sense stops the server before it starts. */
function badLifetime() {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, CLEARANCE_DIGITS_HOURS: "0", DB_KEY: "", DB_KEY_FILE: "" }, encoding: "utf8", timeout: 15000 });
  check("lifetime: CLEARANCE_DIGITS_HOURS=0 is refused at start", r.status === 1 && /CLEARANCE_DIGITS_HOURS/.test(r.stderr), r.stderr);
}

let server;
async function overHttp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-clearance-http-"));
  const key = crypto.randomBytes(32).toString("hex");
  server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), KIOSK_PORT: "", DATA_DIR: dataDir, DB_KEY: key, DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", CLEARANCE_DIGITS_HOURS: "12", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", TZ: "UTC" },
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
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbour Point" });
  const site = (await admin.get("/api/config")).data.sites[0];
  const other = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: site.id }] })).data.company;
  const person = (await admin.post("/api/people", { firstName: "Pat", lastName: "Person", companyId: acme.id })).data.person;
  const visitor = (await admin.post("/api/visitors", { firstName: "Val", lastName: "Visitor" })).data.visitor;
  const { levels } = (await admin.get("/api/clearance")).data;
  const L = Object.fromEntries(levels.map((l) => [l.name, l]));

  const pw = {};
  for (const [username, role, extra] of [["manny", "manager"], ["desk", "frontdesk"], ["vic", "viewer"], ["sec", "security"], ["riversec", "security", { sites: [other.id] }]]) {
    pw[username] = password();
    await admin.post("/api/users", { username, password: pw[username], role, ...(extra || {}) });
  }
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const desk = await as("desk");
  const viewer = await as("vic");
  const security = await as("sec");
  const riverSecurity = await as("riversec");

  // Asking.
  let r = await manager.post("/api/clearance/requests", { kind: "person", id: person.id, last4: DIGITS, note: "New starter" });
  check("http: a manager asks for a person's validation, with the digits", r.status === 200 && r.data.request.hadDigits === true && !mentions(r.text));
  check("http: the answer isn't cached", r.cache === "no-store");
  check("http: front desk can't ask for a person (they only read the directory)", (await desk.post("/api/clearance/requests", { kind: "person", id: person.id })).status === 403);
  check("http: but can for a visitor (they manage visitors)", (await desk.post("/api/clearance/requests", { kind: "visitor", id: visitor.id, last4: OTHER })).status === 200);
  check("http: a viewer can't ask", (await viewer.post("/api/clearance/requests", { kind: "person", id: person.id })).status === 403);
  check("http: the tag shows the request to anyone who reads the directory", (await viewer.get(`/api/people/${person.id}`)).data.person.clearanceStatus === "requested");
  check("http: a JSON body that skipped the byte reader is refused (path spelt differently)", (await manager.post("/API/clearance/requests", { kind: "person", id: person.id, last4: OTHER })).status === 400
    && (await manager.post("/api/clearance/requests/", { kind: "person", id: person.id, last4: OTHER })).status === 400);
  check("http: digits sent as a number are refused", (await manager.post("/api/clearance/requests", `{"kind":"person","id":${person.id},"last4":${OTHER}}`)).status === 400);
  r = await manager.post("/api/clearance/requests", { kind: "person", id: person.id, last4: "60421" });
  check("http: bad digits are refused without repeating them", r.status === 400 && !/60421/.test(r.text));

  // Only Security sees the queue and the digits.
  for (const [who, c] of [["a manager", manager], ["front desk", desk], ["an administrator", admin]]) {
    check(`http: ${who} can't see the queue`, (await c.get("/api/clearance/requests")).status === 403);
  }
  r = await security.get("/api/clearance/requests");
  check("http: Security sees the queue, without the digits", r.status === 200 && r.data.requests.length === 2 && !mentions(r.text) && !mentions(r.text, OTHER));
  const personReq = r.data.requests.find((q) => q.kind === "person");
  const visitorReq = r.data.requests.find((q) => q.kind === "visitor");
  check("http: the queue names who asked, and that digits are held", personReq.requestedBy && personReq.name === "Pat Person" && personReq.digitsHeld === true);
  check("http: nobody else can read the digits", (await admin.post(`/api/clearance/requests/${personReq.id}/digits`)).status === 403 && (await manager.post(`/api/clearance/requests/${personReq.id}/digits`)).status === 403);
  check("http: Security limited to another site doesn't see these requests", (await riverSecurity.get("/api/clearance/requests")).data.requests.filter((q) => q.kind === "person").length === 0
    && (await riverSecurity.post(`/api/clearance/requests/${personReq.id}/digits`)).status === 404);
  r = await security.post(`/api/clearance/requests/${personReq.id}/digits`);
  check("http: Security reads them, one request at a time, never cached", r.status === 200 && r.data.last4 === DIGITS && r.cache === "no-store");
  check("http: with no ETag (a hash of four digits gives them away)", r.etag === null);
  check("http: the lifetime comes from CLEARANCE_DIGITS_HOURS", (await security.get("/api/clearance/requests")).data.digitsHeldHours === 12 && (await manager.get("/api/config")).data.clearance.digitsHeldHours === 12);
  check("http: the config tells Security how many wait", (await security.get("/api/config")).data.clearance.queue === 2 && (await manager.get("/api/config")).data.clearance.queue === 0);

  // Only Security sets a clearance.
  check("http: a manager can't validate", (await manager.post("/api/clearance/validate", { kind: "person", id: person.id, levelId: L.TS.id })).status === 403);
  check("http: nor an administrator", (await admin.post("/api/clearance/validate", { kind: "person", id: person.id, levelId: L.TS.id })).status === 403);
  check("http: nor set it in the record", (await admin.put(`/api/people/${person.id}`, { clearanceLevel: L.TS.id })).status === 403 && (await manager.put(`/api/visitors/${visitor.id}`, { clearanceLevel: L.TS.id })).status === 403);
  check("http: nor be given edit on it in the grid", (await admin.put("/api/field-access", { changes: [{ roleId: "manager", entity: "person", field: "clearanceLevel", access: "edit" }] })).status === 400);
  r = await security.post("/api/clearance/validate", { kind: "person", id: person.id, levelId: L.TS.id, granted: "2025-01-02" });
  check("http: Security validates", r.status === 200 && r.data.level.name === "TS" && r.data.closed === 1);
  check("http: the digits are gone with the request", (await security.post(`/api/clearance/requests/${personReq.id}/digits`)).status === 404);
  const p = (await manager.get(`/api/people/${person.id}`)).data.person;
  check("http: the person is validated, by whom and when", p.clearanceStatus === "validated" && p.clearanceLevelName === "TS" && p.clearanceValidatedBy === "sec" && p.clearanceValidatedAt > 0);
  check("http: Security limited to another site can't validate them", (await riverSecurity.post("/api/clearance/validate", { kind: "person", id: person.id, levelId: L.Secret.id })).status === 404);
  check("http: cancelling is Security's too", (await manager.post(`/api/clearance/requests/${visitorReq.id}/cancel`)).status === 403);
  check("http: Security cancels a request", (await security.post(`/api/clearance/requests/${visitorReq.id}/cancel`)).status === 200 && (await security.get("/api/clearance/requests")).data.requests.length === 0);

  // The re-check period is an administrator's setting.
  check("http: Security can't change the re-check period", (await security.put("/api/clearance/settings", { visitorRecheckDays: 30 })).status === 403);
  r = await admin.put("/api/clearance/settings", { visitorRecheckDays: 30 });
  check("http: an administrator can", r.status === 200 && r.data.visitorRecheckDays === 30 && (await viewer.get("/api/config")).data.clearance.visitorRecheckDays === 30);

  // --- clearances coming up (Security > Re-checks and expiry, and the dashboard) -----------------------
  r = await security.get("/api/clearance/overview");
  check("overview: Security sees what was validated lately, with the level", r.status === 200 && r.data.recent.some((x) => x.name === "Pat Person" && x.levelName === "TS" && x.validatedBy === "sec"));
  check("overview: so do administrators", (await admin.get("/api/clearance/overview")).status === 200);
  check("overview: nobody else", (await manager.get("/api/clearance/overview")).status === 403 && (await desk.get("/api/clearance/overview")).status === 403 && (await viewer.get("/api/clearance/overview")).status === 403);
  check("overview: Security at another site doesn't see Harbour Point's people", !(await riverSecurity.get("/api/clearance/overview")).data.recent.some((x) => x.name === "Pat Person"));
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await security.post("/api/clearance/validate", { kind: "visitor", id: visitor.id, levelId: L.Secret.id, expires: soon });
  r = await security.get("/api/clearance/overview?within=60");
  check("overview: a visitor's re-check, with its due date", r.data.rechecks.some((x) => x.name === "Val Visitor" && x.dueAt > Date.now() && !x.overdue));
  check("overview: and a clearance expiring soon", r.data.expiring.some((x) => x.name === "Val Visitor" && x.expires === soon && !x.expired));
  check("overview: never the SSN digits", !mentions(JSON.stringify(r.data)) && !mentions(JSON.stringify(r.data), OTHER));

  // --- each person's preferences: their site and dashboard ----------------------------------------
  r = await security.get("/api/me/prefs");
  check("prefs: Security starts with the clearance modules", r.data.dashboard[0] === "clearanceQueue" && r.data.dashboard.includes("rechecks") && r.data.site === null);
  r = await desk.get("/api/me/prefs");
  check("prefs: front desk with its own, and no clearance modules on offer", r.data.dashboard[0] === "badgeNeeded" && !r.data.available.some((m) => ["clearanceQueue", "rechecks", "expiring", "validations"].includes(m)));
  check("prefs: a module they may not have is refused", (await desk.put("/api/me/prefs", { dashboard: ["here", "clearanceQueue"] })).status === 403);
  r = await desk.put("/api/me/prefs", { dashboard: ["tenants", "here"], site: other.id });
  check("prefs: their own order and site are kept", r.status === 200 && r.data.dashboard.join() === "tenants,here" && r.data.site === other.id && (await desk.get("/api/me/prefs")).data.site === other.id);
  check("prefs: only their own", (await security.get("/api/me/prefs")).data.site === null);
  check("prefs: not a site they can't see", (await riverSecurity.put("/api/me/prefs", { site: site.id })).status === 403);
  check("prefs: nor one that doesn't exist", (await desk.put("/api/me/prefs", { site: 9999 })).status === 400);
  r = await desk.put("/api/me/prefs", { dashboard: null, site: null });
  check("prefs: back to the defaults", r.data.dashboard[0] === "badgeNeeded" && r.data.site === null);
  check("prefs: administrators see re-checks but not the queue", (await admin.get("/api/me/prefs")).data.available.includes("rechecks") && !(await admin.get("/api/me/prefs")).data.available.includes("clearanceQueue"));

  // --- who keeps the badge stock --------------------------------------------------------------------
  const uncl = (await admin.get("/api/clearance")).data.classifications.find((c) => !c.requiresClearance);
  check("badges: Security adds them", (await security.post("/api/badges", { number: "SEC-1", type: "visitor", classificationId: uncl.id })).status === 200);
  check("badges: front desk and managers don't", (await desk.post("/api/badges", { number: "D-1", type: "visitor", classificationId: uncl.id })).status === 403
    && (await manager.post("/api/badges", { number: "M-1", type: "visitor", classificationId: uncl.id })).status === 403);
  const secBadge = (await security.get("/api/badges?q=SEC-1")).data.badges[0];
  check("badges: but they issue and take them back", (await desk.post(`/api/badges/${secBadge.id}/assign`, { kind: "visitor", holderId: visitor.id })).status === 200
    && (await manager.post(`/api/badges/${secBadge.id}/return`)).status === 200);
  check("badges: only Security changes one", (await desk.put(`/api/badges/${secBadge.id}`, { notes: "x" })).status === 403 && (await security.put(`/api/badges/${secBadge.id}`, { notes: "spare" })).status === 200);
  check("roles: badge access has a manage level", (await admin.get("/api/roles")).data.badgeLevels.join() === "none,read,edit,manage"
    && (await admin.get("/api/roles")).data.roles.find((x) => x.id === "security").badges === "manage" && (await admin.get("/api/roles")).data.roles.find((x) => x.id === "frontdesk").badges === "edit");

  // Where the digits must never be.
  const audit = await admin.get("/api/audit?limit=500");
  check("audit: requests, views and validations are recorded", ["clearance.request", "clearance.digits_view", "clearance.validate", "clearance.cancel"].every((a) => audit.data.entries.some((e) => e.action === a)));
  check("audit: the digits aren't in it", !mentions(audit.text) && !mentions(audit.text, OTHER));
  const raw = openEncrypted(path.join(dataDir, DB_FILE), key);
  const stored = everyText(raw);
  raw.close();
  check("database: the digits aren't in it (WAL included)", stored.length > 0 && !mentions(stored) && !mentions(stored, OTHER));
  const files = fs.readdirSync(dataDir).filter((f) => f.startsWith(DB_FILE)).map((f) => fs.readFileSync(path.join(dataDir, f)).toString("latin1")).join("");
  check("database: nor readable in its files on disk", !files.includes(`"${DIGITS}"`) && !files.includes("Pat Person"));
  check("log: the server never logged them", !mentions(log) && !mentions(log, OTHER));

  server.kill();
  await new Promise((r2) => setTimeout(r2, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

(async () => {
  try {
    inProcess();
    rawBodies();
    badLifetime();
    await overHttp();
  } catch (error) {
    check("ran without throwing", false, error.stack || error.message);
  } finally {
    if (server && server.exitCode === null) server.kill();
  }
  process.exit(report() ? 0 : 1);
})();
