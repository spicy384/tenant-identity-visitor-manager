/**
 * HTTP tests: boots the real server against a temporary data directory, a throwaway
 * database key and a fake Microsoft (for Entra sign-in), then drives the API the way
 * the pages do: first-run setup, CSRF, roles, field access through every route, site
 * limits, CSV import and export, logos, backups and Entra sign-in.
 */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Server: HTTP API, roles, field access, sites, Entra sign-in");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_SERVER_PORT) || 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-server-"));
const DB_KEY = crypto.randomBytes(32).toString("hex");
const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("tiny-logo")]).toString("base64")}`;
const password = () => crypto.randomBytes(12).toString("base64url");
const adminPassword = password();

// --- a fake Microsoft for the Entra flow ---------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
let mockPort = 0;
let nextClaims = null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mock = http.createServer((req, res) => {
  if (req.url.endsWith("/discovery/v2.0/keys")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  if (req.url.endsWith("/oauth2/v2.0/token")) {
    const head = b64({ alg: "RS256", kid: "k1" });
    const body = b64(nextClaims);
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ id_token: `${head}.${body}.${sig}` }));
  }
  res.statusCode = 404;
  res.end();
});

// --- a tiny cookie-keeping client --------------------------------------------------------------

function client() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body, { raw = false, headers = {}, redirect = "follow" } = {}) {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET" && !("x-csrf-token" in headers)) h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [k, v] = pair.split("=");
      if (/Max-Age=0/.test(line)) delete jar[k]; else jar[k] = v;
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, o) => call("GET", u, undefined, o),
    post: (u, b = {}, o) => call("POST", u, b, o),
    put: (u, b = {}, o) => call("PUT", u, b, o),
    del: (u, o) => call("DELETE", u, undefined, o),
    jar
  };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function signIn(username, pw) {
  const c = client();
  const r = await c.post("/api/auth/login", { username, password: pw });
  if (r.status !== 200) throw new Error(`sign-in as ${username} failed: ${r.data.error}`);
  return c;
}

/** The address limit tells its owner once each time an address is blocked, for the audit log. */
function limiterUnit() {
  const { createRateLimiter } = require("../rate-limit");
  let t = 1000000;
  const blocks = [];
  const limiter = createRateLimiter({ maxFailures: 2, windowMs: 60000, now: () => t, keyFor: (req) => req.ip, onBlock: (req, seconds) => blocks.push([req.ip, seconds]) });
  const hit = (ip, status = 401) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json() { return this; }, on(ev, fn) { this.done = fn; } };
    let passed = false;
    limiter.middleware({ ip }, res, () => { passed = true; });
    if (passed) { res.statusCode = status; res.done(); }
    return res.statusCode;
  };
  hit("10.0.0.9"); hit("10.0.0.9");
  const first = [hit("10.0.0.9"), hit("10.0.0.9"), hit("10.0.0.9")];
  check("limit: an address blocked after its failures, told once however often it tries", first.every((s) => s === 429) && blocks.length === 1 && blocks[0][0] === "10.0.0.9" && blocks[0][1] > 0, JSON.stringify([first, blocks]));
  t += 61000;
  hit("10.0.0.9"); hit("10.0.0.9");
  hit("10.0.0.9");
  check("limit: blocked again later, told again", blocks.length === 2);
}

let server;
async function main() {
  limiterUnit();
  // Without a key the server must refuse to start, saying why.
  const noKey = spawnSync(process.execPath, ["server.js"], { cwd: PROJECT, env: { ...process.env, DB_KEY: "", DB_KEY_FILE: "", DATA_DIR, PORT: String(PORT) }, encoding: "utf8", timeout: 20000 });
  check("boot: refuses to start without a database key", noKey.status === 1 && /No database key/.test(noKey.stderr), noKey.stderr);

  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  mockPort = mock.address().port;
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      DB_KEY,
      DB_KEY_FILE: "",
      LOGIN_RATE_LIMIT: "0",
      APP_URL: BASE,
      ENTRA_TENANT_ID: TENANT,
      ENTRA_CLIENT_ID: CLIENT,
      ENTRA_CLIENT_SECRET: "test-secret",
      ENTRA_AUTHORITY: `http://127.0.0.1:${mockPort}`,
      ENTRA_DEFAULT_ROLE: "none"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  if (!(await waitForServer())) {
    console.error(serverLog);
    throw new Error("server did not start");
  }
  check("boot: says the database is encrypted and where the key came from, not the key", /encrypted; key from DB_KEY/.test(serverLog) && !serverLog.includes(DB_KEY));

  const anon = client();
  const admin = client();

  // --- first run and headers ---------------------------------------------------------------
  let r = await anon.get("/api/auth/me");
  check("me: setup required on an empty data directory", r.data.setupRequired === true);
  check("api: setup required before anything else", (await anon.get("/api/companies")).status === 409);
  const headers = (await anon.get("/", { raw: true })).headers;
  check("kiosk: without KIOSK_PORT the kiosk lives at /kiosk/ on this port", (await anon.get("/kiosk/", { raw: true })).status === 200 && (await anon.get("/kiosk/api/config")).status === 401);
  check("headers: CSP self-only scripts, no framing", /script-src 'self'/.test(headers.get("content-security-policy")) && headers.get("x-frame-options") === "DENY");
  r = await admin.post("/api/auth/setup", { username: "admin", password: adminPassword, siteName: "Harbor Point" });
  check("setup: first administrator created and signed in", r.status === 200 && r.data.user.role === "admin");
  r = await admin.get("/api/config");
  check("setup: the building's name becomes the first site's", r.data.siteCount === 1 && r.data.sites[0].name === "Harbor Point");
  const harbor = r.data.sites[0];

  check("csrf: a change without the token is refused", (await admin.post("/api/companies", { name: "No token" }, { headers: { "x-csrf-token": "" } })).status === 403);

  // --- one site: nothing to choose -----------------------------------------------------------
  r = await admin.post("/api/companies", { name: "Solo Ltd" });
  check("companies: with one site, a new company is placed there", r.status === 200 && r.data.company.sites.length === 1 && r.data.company.sites[0].siteName === "Harbor Point", JSON.stringify(r.data));

  // --- sites -------------------------------------------------------------------------------------
  r = await admin.post("/api/sites", { name: "Riverside", timeZone: "Europe/London", endOfDay: "18:00", kioskName: "Welcome to Riverside" });
  check("sites: added with time zone and end of day", r.status === 200 && r.data.site.timeZone === "Europe/London" && r.data.site.endOfDay === "18:00");
  const riverside = r.data.site;
  check("sites: an unknown time zone is refused", (await admin.post("/api/sites", { name: "X", timeZone: "Mars/Olympus" })).status === 400);
  check("sites: a bad end-of-day time is refused", (await admin.put(`/api/sites/${riverside.id}`, { endOfDay: "25:00" })).status === 400);
  check("sites: a duplicate name is refused", (await admin.post("/api/sites", { name: "riverside" })).status === 409);
  check("sites: a logo that isn't PNG or JPEG is refused", (await admin.put(`/api/sites/${riverside.id}/logo`, { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status === 400);
  check("sites: a PNG claiming to be a JPEG is refused", (await admin.put(`/api/sites/${riverside.id}/logo`, { dataUrl: PNG.replace("image/png", "image/jpeg") })).status === 400);
  r = await admin.put(`/api/sites/${riverside.id}/logo`, { dataUrl: PNG });
  check("sites: a PNG logo is stored", r.status === 200 && r.data.site.hasLogo);
  const logo = await admin.get(`/api/sites/${riverside.id}/logo`, { raw: true });
  check("sites: the logo is served as PNG", logo.status === 200 && logo.headers.get("content-type") === "image/png" && Buffer.from(await logo.arrayBuffer()).includes(Buffer.from("tiny-logo")));
  check("sites: a logo isn't public", (await anon.get(`/api/sites/${riverside.id}/logo`, { raw: true })).status === 401);

  // --- companies, people and custom fields --------------------------------------------------------
  r = await admin.post("/api/fields", { entity: "person", label: "Badge number", type: "text", visibility: "all" });
  check("fields: a custom field is added", r.status === 200 && r.data.field.key === "badge_number");
  r = await admin.post("/api/fields", { entity: "person", label: "Emergency contact", type: "longtext", visibility: "admins" });
  const emergency = r.data.field;
  check("fields: an unknown type is refused", (await admin.post("/api/fields", { entity: "person", label: "X", type: "blob" })).status === 400);

  r = await admin.post("/api/companies", { name: "Acme Corp", email: "hello@acme.example", website: "acme.example", sites: [{ siteId: harbor.id, suite: "Suite 100" }] });
  check("companies: added, website given a scheme", r.status === 200 && r.data.company.website === "https://acme.example");
  const acme = r.data.company;
  r = await admin.post("/api/companies", { name: "River Co", sites: [{ siteId: riverside.id, suite: "Floor 2" }] });
  const river = r.data.company;
  check("companies: a duplicate name is refused", (await admin.post("/api/companies", { name: "ACME corp", sites: [{ siteId: harbor.id }] })).status === 409);
  check("companies: a bad email is refused", (await admin.post("/api/companies", { name: "Bad", email: "nope", sites: [{ siteId: harbor.id }] })).status === 400);

  r = await admin.post("/api/people", { firstName: "Jane", lastName: "Doe", companyId: acme.id, siteId: harbor.id, jobTitle: "Director", email: "jane@acme.example", mobile: "555-0100", custom: { badge_number: "B-77", emergency_contact: "John Doe 555-0199" } });
  check("people: added with custom values", r.status === 200 && r.data.person.custom.badge_number === "B-77" && r.data.person.custom.emergency_contact === "John Doe 555-0199");
  const jane = r.data.person;
  r = await admin.post("/api/people", { firstName: "Rita", lastName: "River", companyId: river.id, email: "rita@river.example" });
  const rita = r.data.person;
  check("people: a site the company isn't at is refused", (await admin.post("/api/people", { firstName: "X", lastName: "Y", companyId: acme.id, siteId: riverside.id })).status === 400);
  check("people: a company is required", (await admin.post("/api/people", { firstName: "X", lastName: "Y" })).status === 400);

  // --- accounts with different roles and sites ---------------------------------------------------------
  const pw = { manager: password(), frontdesk: password(), viewer: password(), riverManager: password() };
  check("users: a manager is added", (await admin.post("/api/users", { username: "manny", password: pw.manager, role: "manager" })).status === 200);
  check("users: front desk is added", (await admin.post("/api/users", { username: "fran", password: pw.frontdesk, role: "frontdesk" })).status === 200);
  check("users: a viewer is added", (await admin.post("/api/users", { username: "vic", password: pw.viewer, role: "viewer" })).status === 200);
  r = await admin.post("/api/users", { username: "rivers", password: pw.riverManager, role: "manager", sites: [riverside.id] });
  check("users: a manager limited to Riverside is added", r.status === 200 && JSON.stringify(r.data.user.sites) === JSON.stringify([riverside.id]));
  check("users: a device role can't be given to an account", (await admin.post("/api/users", { username: "kiosky", password: password(), role: "kiosk" })).status === 400);
  check("users: a site that doesn't exist is refused", (await admin.post("/api/users", { username: "nowhere", password: password(), role: "viewer", sites: [9999] })).status === 400);

  const manager = await signIn("manny", pw.manager);
  const frontdesk = await signIn("fran", pw.frontdesk);
  const viewer = await signIn("vic", pw.viewer);
  const riverMgr = await signIn("rivers", pw.riverManager);

  // --- field access through the API ----------------------------------------------------------------------
  r = await manager.get(`/api/people/${jane.id}`);
  check("access: a manager doesn't get an administrators-only field", r.status === 200 && r.data.person.custom.badge_number === "B-77" && !("emergency_contact" in r.data.person.custom));
  check("access: ...and it isn't in the fields they're told about", !r.data.fields.some((f) => f.key === "emergency_contact"));
  check("access: ...and can't write it", (await manager.put(`/api/people/${jane.id}`, { custom: { emergency_contact: "x" } })).status === 400);
  r = await admin.get(`/api/people/${jane.id}`);
  check("access: ...which stays as it was", r.data.person.custom.emergency_contact === "John Doe 555-0199");

  r = await admin.put("/api/field-access", { changes: [{ roleId: "viewer", entity: "person", field: "email", access: "hidden" }, { roleId: "viewer", entity: "person", field: "mobile", access: "hidden" }] });
  check("access: the grid is changed", r.status === 200 && r.data.entities.person.find((f) => f.key === "email").access.viewer === "hidden");
  r = await viewer.get(`/api/people/${jane.id}`);
  check("access: a viewer no longer gets the hidden fields", r.status === 200 && !("email" in r.data.person) && !("mobile" in r.data.person) && r.data.person.jobTitle === "Director");
  r = await viewer.get("/api/people?q=jane@acme");
  check("access: a viewer can't find someone by a hidden email", r.data.people.length === 0);
  r = await manager.get("/api/people?q=jane@acme");
  check("access: a manager can", r.data.people.length === 1);
  r = await viewer.get(`/api/companies/${acme.id}`);
  check("access: a company's people list hides the same fields", r.data.people.length === 1 && !("email" in r.data.people[0]));
  r = await viewer.get("/api/schema");
  check("access: the schema lists only visible fields, each with its level", !r.data.person.some((f) => f.key === "email") && r.data.person.find((f) => f.key === "jobTitle").access === "view");
  r = await manager.get("/api/schema");
  check("access: a manager's schema says which fields are editable", r.data.person.find((f) => f.key === "jobTitle").access === "edit");
  check("access: a locked field can't be hidden through the API", (await admin.put("/api/field-access", { changes: [{ roleId: "viewer", entity: "company", field: "name", access: "hidden" }] })).status === 400);
  check("access: the grid is for administrators", (await manager.get("/api/field-access")).status === 403);

  // --- what each role may change ---------------------------------------------------------------------------
  check("roles: a viewer can't change a person", (await viewer.put(`/api/people/${jane.id}`, { jobTitle: "CEO" })).status === 403);
  check("roles: front desk can't change the directory", (await frontdesk.post("/api/companies", { name: "FD Inc", sites: [{ siteId: harbor.id }] })).status === 403);
  check("roles: front desk can read it", (await frontdesk.get("/api/companies")).status === 200);
  r = await manager.put(`/api/people/${jane.id}`, { jobTitle: "Managing Director", custom: { badge_number: "B-78" } });
  check("roles: a manager changes a person", r.status === 200 && r.data.person.jobTitle === "Managing Director" && r.data.person.custom.badge_number === "B-78");
  check("roles: only administrators delete", (await manager.del(`/api/people/${jane.id}`)).status === 403);
  check("roles: settings are for administrators (managers only add custom fields)", (await manager.get("/api/field-access")).status === 403 && (await manager.post("/api/sites", { name: "Nope" })).status === 403 && (await manager.get("/api/fields")).status === 200);

  // --- site limits --------------------------------------------------------------------------------------------
  r = await riverMgr.get("/api/companies");
  check("sites: a Riverside manager sees Riverside's companies only", r.data.companies.map((c) => c.name).join() === "River Co");
  check("sites: ...can't open one elsewhere", (await riverMgr.get(`/api/companies/${acme.id}`)).status === 404);
  check("sites: ...or its people", (await riverMgr.get(`/api/people/${jane.id}`)).status === 404);
  check("sites: ...or change them", (await riverMgr.put(`/api/people/${jane.id}`, { jobTitle: "x" })).status === 404);
  check("sites: ...or filter by another site", (await riverMgr.get(`/api/companies?site=${harbor.id}`)).status === 403);
  r = await riverMgr.get("/api/config");
  check("sites: ...and is only told about Riverside", r.data.sites.length === 1 && r.data.sites[0].id === riverside.id && r.data.access.sitesLimited === true);
  check("sites: ...can't put a company at Harbor Point", (await riverMgr.post("/api/companies", { name: "Sneaky", sites: [{ siteId: harbor.id }] })).status === 403);
  r = await riverMgr.post("/api/people", { firstName: "Ray", lastName: "Banks", companyId: river.id });
  check("sites: ...adds people at Riverside", r.status === 200 && r.data.person.siteId === riverside.id);
  r = await admin.get(`/api/companies?site=${riverside.id}`);
  check("sites: the site filter narrows a list", r.data.companies.map((c) => c.name).join() === "River Co");

  // --- CSV --------------------------------------------------------------------------------------------------------
  check("csv: exports are for administrators", (await manager.get("/api/people.csv", { raw: true })).status === 403);
  const csv = await (await admin.get("/api/people.csv", { raw: true })).text();
  check("csv: people export has built-in and custom columns", csv.startsWith("id,first_name,last_name") && csv.includes("badge_number") && csv.includes("emergency_contact") && csv.includes("Jane"));
  r = await admin.get("/api/audit?action=export");
  check("csv: an export is audited", r.data.entries.some((e) => e.action === "export.people"));

  const goodCsv = "first_name,last_name,company,email,job_title,badge_number,site\nAmy,Adams,Acme Corp,amy@acme.example,Engineer,B-01,Harbor Point\nJane,Doe,Acme Corp,jane@acme.example,CEO,,\nNew,Person,Brand New Co,new@brand.example,,,Riverside\n";
  r = await manager.post("/api/people/import", { csv: goodCsv });
  check("import: an unknown company is refused unless asked to add it", r.status === 400 && /Brand New Co/.test(r.data.error) && /Nothing was imported/.test(r.data.error));
  check("import: ...and nothing was imported", (await admin.get("/api/people?q=Amy")).data.people.length === 0);
  r = await manager.post("/api/people/import", { csv: goodCsv, createCompanies: true });
  check("import: adds and updates people, adding companies when asked", r.status === 200 && r.data.added === 2 && r.data.updated === 1, JSON.stringify(r.data));
  r = await admin.get("/api/people?q=Amy");
  check("import: custom columns are imported", r.data.people[0].custom.badge_number === "B-01");
  r = await admin.get(`/api/people/${jane.id}`);
  check("import: an existing person (matched by email) is updated", r.data.person.jobTitle === "CEO");
  r = await admin.get("/api/companies?q=Brand");
  check("import: the new company is at the row's site", r.data.companies[0].sites[0].siteName === "Riverside");
  r = await riverMgr.post("/api/people/import", { csv: "first_name,last_name,company\nZed,Zee,Acme Corp\n" });
  check("import: a limited manager can't import into a company they can't see", r.status === 400 && /can't see/.test(r.data.error));
  r = await manager.post("/api/people/import", { csv: "first_name,last_name,company,emergency_contact\nAmy,Adams,Acme Corp,Mum\n" });
  check("import: a column the importer can't see is ignored, not written", r.status === 200 && r.data.ignored.includes("emergency_contact"));
  r = await admin.get("/api/people?q=Amy");
  check("import: ...and the hidden field is untouched", !("emergency_contact" in r.data.people[0].custom));
  r = await admin.post("/api/companies/import", { csv: "name,phone,sites\nAcme Corp,555-1000,Harbor Point: Suite 101\nNorth Ltd,,Riverside; Harbor Point: Suite 5\n" });
  check("import: companies are added and updated, with sites and suites", r.status === 200 && r.data.added === 1 && r.data.updated === 1);
  r = await admin.get(`/api/companies/${acme.id}`);
  check("import: ...the suite was changed", r.data.company.sites[0].suite === "Suite 101" && r.data.company.phone === "555-1000");
  check("import: a header without the needed columns is refused", (await admin.post("/api/people/import", { csv: "name\nx\n" })).status === 400);

  // --- roles -----------------------------------------------------------------------------------------------------
  r = await admin.post("/api/roles", { name: "Security team", directory: "read", visitors: "read", copyFrom: "viewer" });
  check("roles: a custom role is added", r.status === 200 && r.data.role.id === "security-team");
  check("roles: it can be given to an account", (await admin.post("/api/users", { username: "sec", password: password(), role: "security-team" })).data.user.role === "security-team");
  check("roles: a role in use can't be removed", (await admin.del("/api/roles/security-team")).status === 409);
  r = await admin.get("/api/roles");
  check("roles: the list counts accounts per role", r.data.roles.find((x) => x.id === "security-team").accounts === 1);
  r = await admin.get("/api/field-access");
  check("roles: the new role has a column, copied from Viewer", r.data.entities.person.find((f) => f.key === "email").access["security-team"] === "hidden");

  // --- fields -------------------------------------------------------------------------------------------------------
  r = await admin.post("/api/fields", { entity: "company", label: "Loading dock", type: "text", recordId: river.id });
  check("fields: a one-record field is added", r.status === 200 && r.data.field.recordName === "River Co");
  r = await admin.put(`/api/companies/${river.id}`, { custom: { loading_dock: "Dock 2" } });
  check("fields: ...and filled in on its record", r.data.company.custom.loading_dock === "Dock 2");
  check("fields: ...but not on another", (await admin.put(`/api/companies/${acme.id}`, { custom: { loading_dock: "x" } })).status === 400);
  check("fields: deleting removes values", (await admin.del(`/api/fields/${emergency.id}`)).status === 200 && !("emergency_contact" in (await admin.get(`/api/people/${jane.id}`)).data.person.custom));

  // --- backup -----------------------------------------------------------------------------------------------------------
  check("backup: for administrators only", (await manager.get("/api/backup", { raw: true })).status === 403);
  const backup = await admin.get("/api/backup", { raw: true });
  const bytes = Buffer.from(await backup.arrayBuffer());
  check("backup: downloads a copy of the database", backup.status === 200 && bytes.length > 4096);
  check("backup: the copy is encrypted (no names, no SQLite header)", !bytes.includes(Buffer.from("Acme Corp")) && !bytes.includes(Buffer.from("jane@acme.example")) && !bytes.subarray(0, 15).equals(Buffer.from("SQLite format 3")));

  // --- Entra sign-in --------------------------------------------------------------------------------------------------------
  async function entraSignIn(c, claims) {
    const start = await c.get("/api/auth/entra/start", { raw: true, redirect: "manual" });
    for (const line of start.headers.getSetCookie()) { const [pair] = line.split(";"); const [k, v] = pair.split("="); c.jar[k] = v; }
    const location = new URL(start.headers.get("location"));
    nextClaims = {
      iss: `http://127.0.0.1:${mockPort}/${TENANT}/v2.0`, tid: TENANT, aud: CLIENT, nonce: location.searchParams.get("nonce"),
      exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...claims
    };
    const back = await c.get(`/api/auth/entra/callback?state=${location.searchParams.get("state")}&code=abc`, { raw: true, redirect: "manual" });
    for (const line of back.headers.getSetCookie()) { const [pair] = line.split(";"); const [k, v] = pair.split("="); if (/Max-Age=0/.test(line)) delete c.jar[k]; else c.jar[k] = v; }
    return { start, back, location };
  }

  const stranger = client();
  let flow = await entraSignIn(stranger, { oid: "oid-stranger", preferred_username: "stranger@contoso.com", name: "Stranger" });
  check("entra: an unknown user without an app role is refused", /signin_error=.*has%20not%20been%20given%20access/.test(flow.back.headers.get("location")));
  const deskPerson = client();
  flow = await entraSignIn(deskPerson, { oid: "oid-desk", preferred_username: "desk@contoso.com", name: "Desk Person", roles: ["FrontDesk"] });
  r = await deskPerson.get("/api/auth/me");
  check("entra: an app role named FrontDesk gives the Front desk role", r.data.authenticated && r.data.user.role === "frontdesk" && r.data.user.provider === "entra");
  check("entra: ...which can read the directory", (await deskPerson.get("/api/companies")).status === 200);

  // --- site removal and sign-out ---------------------------------------------------------------------------------------------
  check("sites: a site with companies can't be removed", (await admin.del(`/api/sites/${riverside.id}`)).status === 409);
  r = await admin.post("/api/sites", { name: "Empty Annex" });
  check("sites: an unused site can be removed", (await admin.del(`/api/sites/${r.data.site.id}`)).status === 200);

  r = await admin.get("/api/audit");
  check("audit: changes are recorded, values are not", r.data.entries.some((e) => e.action === "person.update" && /jobTitle/.test(e.detail) && !/Managing Director/.test(e.detail)));

  await viewer.post("/api/auth/logout");
  check("logout: session ended", (await viewer.get("/api/companies")).status === 401);

  // --- failed sign-ins, in the audit log ------------------------------------------------------------
  const failures = async () => (await admin.get("/api/audit?action=auth.login_failed&limit=500")).data.entries;
  const typedSecret = "Hunter2-typed-in-the-wrong-box";
  await client().post("/api/auth/login", { username: typedSecret, password: "whatever" });
  let f = await failures();
  check("failed: a username matching no account is recorded, never what was typed", f[0]?.target === "unknown account" && f[0].username === null && /matches no account/.test(f[0].detail)
    && !JSON.stringify(await admin.get("/api/audit?limit=500")).includes(typedSecret));
  await client().post("/api/auth/login", { username: "fran", password: "not her password" });
  f = await failures();
  check("failed: a wrong password, against the account, never the password", f[0]?.username === "fran" && f[0].target === "fran" && f[0].detail === "wrong password" && f[0].ip
    && !JSON.stringify(f).includes("not her password"));
  for (let i = 0; i < 4; i += 1) await client().post("/api/auth/login", { username: "fran", password: `wrong ${i}` });
  f = await failures();
  check("failed: the attempt that locks the account says so", /wrong password; the account is locked for 15 minutes/.test(f[0]?.detail || ""), f[0]?.detail);
  r = await client().post("/api/auth/login", { username: "fran", password: pw.frontdesk });
  f = await failures();
  check("failed: the right password while locked is recorded too", r.status === 429 && /right password, but the account is locked/.test(f[0]?.detail || ""));
  check("failed: among the sign-ins, filtered by user", (await admin.get("/api/audit?signins=only&username=fran&limit=500")).data.entries.filter((e) => e.action === "auth.login_failed").length === 6);
}

main()
  .then(() => report())
  .catch((error) => {
    console.error(error);
    return false;
  })
  .then(async (ok) => {
    // Wait for the server to exit so Windows lets go of the database file.
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await exited;
    }
    mock.close();
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
    process.exit(ok ? 0 : 1);
  });
