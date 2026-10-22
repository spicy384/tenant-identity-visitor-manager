/**
 * Accounts with several roles: they get the most any of their roles gives, area by area and
 * field by field; Security keeps its own powers; Administrator stands alone; removing a role.
 * Also: roles that manage custom fields (Manager to start with), and the app's name in the header.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Several roles on one account");
const PORT = Number(process.env.TEST_ROLES_PORT) || 3993;
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
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json().catch(() => ({})) : { bytes: (await res.arrayBuffer()).byteLength, type };
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-roles-"));
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
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbour Point" });
  const harbour = (await admin.get("/api/config")).data.sites[0];
  const acme = (await admin.post("/api/companies", { name: "Acme", sites: [{ siteId: harbour.id }] })).data.company;
  // A field only those who can change the directory see.
  const field = (await admin.post("/api/fields", { entity: "company", label: "Lease notes", type: "text", visibility: "editors" })).data.field;
  await admin.put(`/api/companies/${acme.id}`, { custom: { [field.key]: "Renews in May" } });
  const leasing = (await admin.post("/api/roles", { name: "Leasing", directory: "none", visitors: "none", badges: "none", facilities: "edit" })).data.role;

  const pw = { dee: password(), sam: password(), old: password() };
  let r = await admin.post("/api/users", { username: "dee", password: pw.dee, roles: ["frontdesk", leasing.id] });
  const dee = r.data.user;
  check("add: an account with two roles", r.status === 200 && dee.roles.join() === `frontdesk,${leasing.id}` && dee.role === "frontdesk" && dee.roleName === "Front desk, Leasing");
  check("add: roles must exist and be for staff", (await admin.post("/api/users", { username: "bad1", password: password(), roles: ["frontdesk", "kiosk"] })).status === 400
    && (await admin.post("/api/users", { username: "bad2", password: password(), roles: ["nope"] })).status === 400
    && (await admin.post("/api/users", { username: "bad3", password: password(), roles: [] })).status === 400);
  check("add: one role, as before", (await admin.post("/api/users", { username: "old", password: pw.old, role: "viewer" })).data.user.roles.join() === "viewer");
  r = await admin.post("/api/users", { username: "sam", password: pw.sam, roles: ["viewer", "admin"] });
  check("add: Administrator stands alone", r.data.user.roles.join() === "admin" && r.data.user.sites === null);
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const deeC = await as("dee");

  // --- the most any role gives ------------------------------------------------------------------
  let cfg = (await deeC.get("/api/config")).data.access;
  check("areas: the highest of each", cfg.directory === "read" && cfg.visitors === "edit" && cfg.badges === "edit" && cfg.facilities === "edit");
  check("areas: so both roles' pages open", (await deeC.get("/api/floors")).status === 200 && (await deeC.get("/api/visits")).status === 200);
  check("config: names every role", cfg.roleName === "Front desk, Leasing" && cfg.roles.join() === `frontdesk,${leasing.id}`);
  check("me: lists the roles", (await deeC.get("/api/auth/me")).data.user.roles.length === 2);
  check("fields: hidden while no role sees it", (await deeC.get(`/api/companies/${acme.id}`)).data.company.custom[field.key] === undefined);
  check("clearances: neither role sees levels", cfg.clearances === false && (await deeC.get("/api/clearance/queue-count")).status === 403);

  r = await admin.post(`/api/users/${dee.id}/role`, { roles: [leasing.id, "manager", "frontdesk"] });
  check("change: roles put in the roles' order", r.status === 200 && r.data.user.roles.join() === `manager,frontdesk,${leasing.id}`);
  cfg = (await deeC.get("/api/config")).data.access;
  check("change: takes effect at once", cfg.directory === "edit" && cfg.clearances === true);
  const company = (await deeC.get(`/api/companies/${acme.id}`)).data;
  check("fields: shown once one role sees it", company.company.custom[field.key] === "Renews in May"
    && company.fields.find((f) => f.key === field.key).access === "edit");
  check("fields: and changeable through that role", (await deeC.put(`/api/companies/${acme.id}`, { custom: { [field.key]: "Renewed" } })).status === 200);

  await admin.post(`/api/users/${dee.id}/role`, { roles: ["frontdesk", "security"] });
  cfg = (await deeC.get("/api/config")).data.access;
  check("security: with it among the roles, the queue and levels", (await deeC.get("/api/clearance/queue-count")).status === 200 && cfg.clearances === true);
  const prefs = (await deeC.get("/api/me/prefs")).data;
  check("dashboard: starts with every role's modules", prefs.defaults.includes("clearanceQueue") && prefs.defaults.includes("badgeNeeded"));

  // --- administrators ---------------------------------------------------------------------------
  const adminId = (await admin.get("/api/auth/me")).data.user.id;
  check("admin: can't change their own roles", (await admin.post(`/api/users/${adminId}/role`, { roles: ["viewer"] })).status === 400);
  const samC = await as("sam");
  const samId = (await samC.get("/api/auth/me")).data.user.id;
  await admin.post(`/api/users/${samId}/role`, { roles: ["viewer"] });
  r = (await samC.get("/api/config")).data.access;
  check("admin: losing Administrator takes its powers away", r.isAdmin === false && (await samC.get("/api/users")).status === 403);
  r = await samC.post(`/api/users/${adminId}/role`, { roles: ["viewer"] });
  check("admin: the last administrator can't be demoted", r.status === 403 || r.status === 400);
  check("admin: nor demoted by an administrator either", (await admin.post(`/api/users/${adminId}/role`, { roles: ["viewer"] })).status === 400);

  // --- removing a role --------------------------------------------------------------------------
  const solo = (await admin.post("/api/users", { username: "solo", password: password(), roles: [leasing.id] })).data.user;
  await admin.post(`/api/users/${dee.id}/role`, { roles: ["frontdesk", leasing.id] });
  const roles = (await admin.get("/api/roles")).data.roles;
  check("roles: accounts counted under each role they have", roles.find((x) => x.id === leasing.id).accounts === 2 && roles.find((x) => x.id === "frontdesk").accounts === 1);
  r = await admin.del(`/api/roles/${leasing.id}`);
  check("remove: refused while it is someone's only role", r.status === 409 && /only this role/.test(r.data.error));
  await admin.post(`/api/users/${solo.id}/role`, { roles: ["viewer"] });
  r = await admin.del(`/api/roles/${leasing.id}`);
  const after = (await admin.get("/api/users")).data.users.find((u) => u.id === dee.id);
  check("remove: then gone, and taken from accounts with other roles", r.status === 200 && after.roles.join() === "frontdesk" && after.role === "frontdesk");
  check("remove: in the audit log", (await admin.get("/api/audit?action=role.remove")).data.entries.some((e) => /taken from dee/.test(e.detail || "")));
  check("audit: role changes list every role", (await admin.get("/api/audit?action=user.role")).data.entries.some((e) => /manager, frontdesk, /.test(e.detail || "")));

  // --- roles that manage custom fields ------------------------------------------------------------
  const river = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const initech = (await admin.post("/api/companies", { name: "Initech", sites: [{ siteId: river.id }] })).data.company;
  pw.manny = password();
  pw.harbourManny = password();
  pw.desk = password();
  await admin.post("/api/users", { username: "manny", password: pw.manny, roles: ["manager"] });
  await admin.post("/api/users", { username: "harbourManny", password: pw.harbourManny, roles: ["manager"], sites: [harbour.id] });
  await admin.post("/api/users", { username: "desk", password: pw.desk, roles: ["frontdesk"] });
  const manny = await as("manny");
  const desk = await as("desk");
  const builtIn = (await admin.get("/api/roles")).data.roles;
  check("fields: Manager and Security manage them to start with, the others don't", builtIn.find((x) => x.id === "manager").fields === true
    && builtIn.filter((x) => x.fields).map((x) => x.id).sort().join() === "admin,manager,security");
  cfg = (await manny.get("/api/config")).data.access;
  check("fields: for the records the role can change, and badges it issues", cfg.fieldEntities.join() === "company,person,visitor,badge");
  r = (await manny.get("/api/fields")).data;
  check("fields: a manager sees the Fields page, without delete", r.entities.join() === "company,person,visitor,badge" && r.canDelete === false);
  check("fields: front desk doesn't", (await desk.get("/api/fields")).status === 403 && (await desk.get("/api/config")).data.access.fieldEntities.length === 0);
  r = await manny.post("/api/fields", { entity: "person", label: "Desk phone", type: "phone", visibility: "all" });
  const deskPhone = r.data.field;
  check("fields: a manager adds one", r.status === 200 && deskPhone.key === "desk_phone");
  r = await manny.post("/api/fields", { entity: "badge", label: "Locker", type: "text", visibility: "all" });
  const locker = r.data.field;
  check("badge fields: a manager adds one", r.status === 200 && locker.entity === "badge");
  const uncleared = (await admin.get("/api/clearance")).data.classifications.find((c) => !c.requiresClearance);
  const badge = (await admin.post("/api/badges", { number: "M-1", type: "tenant", classificationId: uncleared.id })).data.badge;
  check("badge fields: but filling one in stays with those who manage badges", (await manny.put(`/api/badges/${badge.id}`, { custom: { [locker.key]: "12" } })).status === 403
    && ((await manny.get(`/api/badges/${badge.id}`)).data.badge.custom[locker.key] ?? null) === null);
  pw.sec = password();
  await admin.post("/api/users", { username: "sec", password: pw.sec, roles: ["security"] });
  const sec = await as("sec");
  check("badge fields: Security manages badge fields only", (await sec.get("/api/config")).data.access.fieldEntities.join() === "badge"
    && (await sec.post("/api/fields", { entity: "company", label: "Nope", type: "text" })).status === 403);
  check("badge fields: Security adds one and fills it in", (await sec.post("/api/fields", { entity: "badge", label: "Lanyard", type: "text", visibility: "all" })).status === 200
    && (await sec.put(`/api/badges/${badge.id}`, { custom: { [locker.key]: "12" } })).data.badge.custom[locker.key] === "12");
  check("fields: front desk can't add one", (await desk.post("/api/fields", { entity: "person", label: "X", type: "text" })).status === 403);
  check("fields: a manager changes one", (await manny.put(`/api/fields/${deskPhone.id}`, { label: "Desk phone number" })).data.field.label === "Desk phone number");
  check("fields: but only an administrator deletes one", (await manny.del(`/api/fields/${deskPhone.id}`)).status === 403 && (await admin.del(`/api/fields/${deskPhone.id}`)).status === 200);
  check("fields: nor sets who sees them", (await manny.get("/api/field-access")).status === 403);
  const harbourManny = await as("harbourManny");
  check("fields: one for a single record only at the account's sites", (await harbourManny.post("/api/fields", { entity: "company", label: "Dock", type: "text", recordId: initech.id })).status === 404
    && (await harbourManny.post("/api/fields", { entity: "company", label: "Dock", type: "text", recordId: acme.id })).status === 200);
  const helper = (await admin.post("/api/roles", { name: "Data steward", directory: "edit", visitors: "read", badges: "none", fields: true })).data.role;
  check("fields: any role can be given it", helper.fields === true);
  await admin.post(`/api/users/${dee.id}/role`, { roles: ["frontdesk"] });
  check("fields: an account gets it from any of its roles", (await deeC.get("/api/config")).data.access.fieldEntities.length === 0);
  await admin.post(`/api/users/${dee.id}/role`, { roles: ["frontdesk", helper.id] });
  check("fields: ... for what that role can change", (await deeC.get("/api/config")).data.access.fieldEntities.join() === "company,person");
  check("fields: switched off again", (await admin.put("/api/roles/manager", { fields: false })).data.role.fields === false && (await manny.get("/api/fields")).status === 403);
  const deskWithFields = (await admin.post("/api/roles", { name: "Desk plus", directory: "read", visitors: "edit", badges: "edit", fields: true })).data.role;
  await admin.post(`/api/users/${dee.id}/role`, { roles: [deskWithFields.id] });
  check("badge fields: any role with the switch that issues badges", (await deeC.get("/api/config")).data.access.fieldEntities.join() === "visitor,badge");
  await admin.put("/api/roles/manager", { fields: true });

  // --- the name in the header -------------------------------------------------------------------
  const anon = client();
  check("name: the default, even before sign-in", (await anon.get("/api/auth/me")).data.branding.name === "Identity and Visitor Manager");
  check("name: only administrators set it", (await manny.put("/api/branding", { name: "Harbour Point Tenants" })).status === 403);
  check("name: kept to a sensible length", (await admin.put("/api/branding", { name: "x".repeat(61) })).status === 400);
  r = await admin.put("/api/branding", { name: "  Harbour Point   Tenants ", subtitle: "Front desk" });
  check("name: set", r.status === 200 && r.data.name === "Harbour Point Tenants" && r.data.subtitle === "Front desk");
  check("name: shown on the sign-in page and to everyone", (await anon.get("/api/auth/me")).data.branding.name === "Harbour Point Tenants" && (await desk.get("/api/config")).data.branding.subtitle === "Front desk");
  r = await admin.put("/api/branding", { name: "", subtitle: "" });
  check("name: empty goes back to the default", r.data.name === "Identity and Visitor Manager" && r.data.subtitle === "");

  // --- the page knows which version served it ---------------------------------------------------
  const version = require("../package.json").version;
  const page = await (await fetch(BASE + "/")).text();
  check("page: scripts and styles addressed by version, and the version named", page.includes(`src="/js/01-core.js?v=${version}"`) && page.includes(`href="/styles.css?v=${version}"`)
    && page.includes(`<meta name="app-version" content="${version}" />`));
  check("page: not kept stale", (await fetch(BASE + "/index.html")).headers.get("cache-control") === "no-cache");
  check("api: says which version answers", (await fetch(BASE + "/api/auth/me")).headers.get("x-app-version") === version);
  const kioskPage = await (await fetch(BASE + "/kiosk/")).text();
  check("kiosk: its page too, and its API", kioskPage.includes(`src="/kiosk/kiosk.js?v=${version}"`) && kioskPage.includes(`href="/kiosk/kiosk.css?v=${version}"`)
    && (await fetch(BASE + "/kiosk/api/config")).headers.get("x-app-version") === version);

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
