/**
 * Badge template images and who sees clearance level names: level names (and ids) only for
 * roles that see clearance levels; everyone else gets each badge's image, picks a cleared
 * badge's level by its image, and is shown the image of the badge to give someone.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Badge images and who sees clearance levels");
const PORT = Number(process.env.TEST_TEMPLATES_PORT) || 3985;
const BASE = `http://127.0.0.1:${PORT}`;
const password = () => crypto.randomBytes(12).toString("base64url");
// A 1x1 PNG, and a JPEG's first bytes.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const NOT_A_JPEG = PNG.replace("image/png", "image/jpeg");
// Level names a role that doesn't see them must never be sent.
const NAMES = /TS\/\/SCI|"TS"|Secret|FSP/;

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
    const text = type.startsWith("application/json") ? await res.text() : "";
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, text, type, cache: res.headers.get("cache-control") };
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-templates-"));
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
  const site = (await admin.get("/api/config")).data.sites[0];
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: site.id }] })).data.company;
  const { levels } = (await admin.get("/api/clearance")).data;
  const L = Object.fromEntries(levels.map((l) => [l.name, l]));

  const pw = {};
  // A role that keeps the badge stock without seeing clearance levels: it picks levels by image.
  await admin.post("/api/roles", { name: "Badge office", directory: "read", visitors: "read", badges: "manage" });
  for (const [username, role] of [["desk", "frontdesk"], ["manny", "manager"], ["sec", "security"], ["vic", "viewer"], ["office", "badge-office"]]) {
    pw[username] = password();
    await admin.post("/api/users", { username, password: pw[username], role });
  }
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const desk = await as("desk");
  const manager = await as("manny");
  const security = await as("sec");
  const viewer = await as("vic");
  const office = await as("office");

  // --- who sees level names ---------------------------------------------------------------------
  let r = await desk.get("/api/config");
  check("names: front desk's config has no clearance levels", r.data.access.clearances === false && r.data.clearanceLevels.length === 0);
  r = await manager.get("/api/config");
  check("names: a manager's has them", r.data.access.clearances === true && r.data.clearanceLevels.length === 5);
  check("names: Security's too", (await security.get("/api/config")).data.clearanceLevels.length === 5);
  r = await desk.get("/api/clearance");
  check("names: front desk gets Uncleared but no levels", r.data.levels.length === 0 && r.data.uncleared === "Uncleared" && !NAMES.test(r.text));
  check("names: the level list is never cached", r.cache === "no-store");

  // --- the images -------------------------------------------------------------------------------
  check("images: only an administrator uploads them", (await manager.put(`/api/badge-templates/${L.TS.id}/tenant`, { dataUrl: PNG })).status === 403);
  check("images: a PNG or JPEG that is what it says", (await admin.put(`/api/badge-templates/${L.TS.id}/tenant`, { dataUrl: NOT_A_JPEG })).status === 400
    && (await admin.put(`/api/badge-templates/${L.TS.id}/tenant`, { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status === 400);
  check("images: tenant or visitor only", (await admin.put(`/api/badge-templates/${L.TS.id}/contractor`, { dataUrl: PNG })).status === 400);
  check("images: for a level that exists", (await admin.put("/api/badge-templates/9999/tenant", { dataUrl: PNG })).status === 404);
  const put = async (levelId, kind) => (await admin.put(`/api/badge-templates/${levelId}/${kind}`, { dataUrl: PNG })).data.template.ref;
  const ref = {
    tsTenant: await put(L.TS.id, "tenant"),
    tsVisitor: await put(L.TS.id, "visitor"),
    sciTenant: await put(L["TS//SCI"].id, "tenant"),
    noneTenant: await put(0, "tenant"),
    noneVisitor: await put(0, "visitor")
  };
  check("images: uploaded, each with its own ref", new Set(Object.values(ref)).size === 5);
  const replaced = await put(L.TS.id, "tenant");
  check("images: a new upload gets a new ref, and the old one is gone", replaced !== ref.tsTenant && (await desk.get(`/api/badge-templates/${ref.tsTenant}/image`)).status === 404);
  ref.tsTenant = replaced;
  r = await desk.get("/api/badge-templates");
  check("images: front desk's list says which kind and whether cleared, never the level", r.data.templates.length === 5 && r.data.templates.every((t) => t.levelId === undefined && t.levelName === undefined) && !NAMES.test(r.text));
  r = await manager.get("/api/badge-templates");
  check("images: a manager's list names the levels", r.data.templates.some((t) => t.levelName === "TS//SCI" && t.kind === "tenant"));
  const img = await fetch(`${BASE}/api/badge-templates/${ref.tsVisitor}/image`, { headers: { cookie: "" } });
  check("images: not without signing in", img.status === 401);
  r = await desk.get(`/api/badge-templates/${ref.tsVisitor}/image`);
  check("images: served to staff who see badges, cached as long as the ref lasts", r.status === 200 && r.type === "image/png" && /immutable/.test(r.cache));
  check("images: a made-up ref finds nothing", (await desk.get("/api/badge-templates/AAAAAAAAAAAAAAAA/image")).status === 404);

  // --- badges, as front desk sees them -------------------------------------------------------------
  const ts = (await security.post("/api/badges", { number: "T-1", type: "tenant", clearanceLevelId: L.TS.id })).data.badge;
  const sci = (await security.post("/api/badges", { number: "T-2", type: "tenant", clearanceLevelId: L["TS//SCI"].id })).data.badge;
  const plain = (await security.post("/api/badges", { number: "T-3", type: "tenant" })).data.badge;
  await security.post("/api/badges", { number: "V-1", type: "visitor", clearanceLevelId: L.TS.id });
  r = await desk.get("/api/badges");
  check("badges: front desk's list has each badge's image and no level", r.data.badges.length === 4 && r.data.badges.every((b) => b.clearanceLevelId === undefined && b.clearanceLevelName === undefined) && !NAMES.test(r.text)
    && r.data.badges.find((b) => b.number === "T-1").template === ref.tsTenant && r.data.badges.find((b) => b.number === "T-3").template === ref.noneTenant);
  check("badges: whether a badge is cleared (has a level)", r.data.badges.find((b) => b.number === "T-1").cleared === true && r.data.badges.find((b) => b.number === "T-3").cleared === false);
  check("badges: front desk can't filter by a level", (await desk.get(`/api/badges?levelId=${L.TS.id}`)).data.total === 4);
  check("badges: a manager sees the level", (await manager.get(`/api/badges/${ts.id}`)).data.badge.clearanceLevelName === "TS");
  r = await desk.get(`/api/badges/${sci.id}`);
  check("badges: one badge, as front desk sees it", r.data.badge.template === ref.sciTenant && !NAMES.test(r.text));

  // Choosing a cleared badge's level by its image.
  check("pick: front desk can't add badges at all", (await desk.post("/api/badges", { number: "T-4", type: "tenant" })).status === 403);
  check("pick: a role that manages badges without seeing levels can't give a level id", (await office.post("/api/badges", { number: "T-4", type: "tenant", clearanceLevelId: L.TS.id })).status === 403);
  r = await office.post("/api/badges", { number: "T-4", type: "tenant", templateRef: ref.tsTenant });
  check("pick: it adds a cleared badge by its image", r.status === 200 && r.data.badge.template === ref.tsTenant && !NAMES.test(r.text));
  check("pick: it has that image's level", (await manager.get(`/api/badges/${r.data.badge.id}`)).data.badge.clearanceLevelName === "TS");
  const t4 = r.data.badge;
  check("pick: not a visitor image for a tenant badge", (await office.post("/api/badges", { number: "T-5", type: "tenant", templateRef: ref.tsVisitor })).status === 400);
  r = await office.post("/api/badges", { number: "T-5", type: "tenant", templateRef: ref.noneTenant });
  check("pick: the uncleared image makes it Uncleared", r.status === 200 && r.data.badge.cleared === false);
  r = await office.post("/api/badges", { number: "T-6", type: "tenant", templateRef: "" });
  check("pick: so does no image", r.status === 200 && r.data.badge.cleared === false);
  check("pick: and so does a null level, the one level id it may give", (await office.put(`/api/badges/${r.data.badge.id}`, { clearanceLevelId: null })).status === 200);
  check("pick: a range too", (await office.post("/api/badges/range", { prefix: "S-", from: 1, to: 3, type: "tenant", templateRef: ref.sciTenant })).data.count === 3);
  r = await office.put(`/api/badges/${t4.id}`, { notes: "spare" });
  check("pick: editing anything else keeps the level", r.status === 200 && (await manager.get(`/api/badges/${t4.id}`)).data.badge.clearanceLevelName === "TS");
  r = await office.put(`/api/badges/${t4.id}`, { templateRef: ref.sciTenant });
  check("pick: and choosing another image changes it", r.status === 200 && (await manager.get(`/api/badges/${t4.id}`)).data.badge.clearanceLevelName === "TS//SCI");

  // --- giving a badge: the image of the one to give ---------------------------------------------------
  const person = async (firstName, levelName) => {
    const p = (await admin.post("/api/people", { firstName, lastName: "Tester", companyId: acme.id })).data.person;
    if (levelName !== undefined) await security.post("/api/clearance/validate", { kind: "person", id: p.id, levelId: levelName ? L[levelName].id : null });
    return p;
  };
  const tsPerson = await person("Tina", "TS");
  r = await desk.get(`/api/badge-holders/person/${tsPerson.id}`);
  check("give: front desk is shown the image of the highest badge on offer they may hold", r.data.suggested === ref.tsTenant);
  check("give: offered the badges they may hold, each with its image, no level", r.data.available.map((b) => b.number).sort().join() === "T-1,T-3,T-5,T-6" && r.data.available.every((b) => b.template && b.clearanceLevelName === undefined) && !NAMES.test(r.text));
  const fspPerson = await person("Fran", "TS//SCI FSP");
  check("give: the highest badge on offer, even below their own level", (await desk.get(`/api/badge-holders/person/${fspPerson.id}`)).data.suggested === ref.sciTenant);
  const nobody = await person("Ned");
  check("give: no clearance, the uncleared image", (await desk.get(`/api/badge-holders/person/${nobody.id}`)).data.suggested === ref.noneTenant);
  const unvalidated = await person("Una", null);
  check("give: a validated 'no clearance' gets the uncleared image too", (await desk.get(`/api/badge-holders/person/${unvalidated.id}`)).data.suggested === ref.noneTenant);
  const visitor = (await admin.post("/api/visitors", { firstName: "Vera", lastName: "Visitor" })).data.visitor;
  await security.post("/api/clearance/validate", { kind: "visitor", id: visitor.id, levelId: L.TS.id });
  check("give: a visitor at TS, the TS visitor image", (await desk.get(`/api/badge-holders/visitor/${visitor.id}`)).data.suggested === ref.tsVisitor);
  await security.post("/api/badges", { number: "V-2", type: "visitor" });
  const secretVisitor = (await admin.post("/api/visitors", { firstName: "Sid", lastName: "Secret" })).data.visitor;
  await security.post("/api/clearance/validate", { kind: "visitor", id: secretVisitor.id, levelId: L.Secret.id });
  r = await desk.get(`/api/badge-holders/visitor/${secretVisitor.id}`);
  check("give: with no badge of their level free, the image of the one they can have", r.data.suggested === ref.noneVisitor && r.data.available.map((b) => b.number).join() === "V-2");
  const nobodyFree = (await admin.post("/api/visitors", { firstName: "Bo", lastName: "Blocked", blocked: true })).data.visitor;
  check("give: nothing on offer, no image", (await desk.get(`/api/badge-holders/visitor/${nobodyFree.id}`)).data.suggested === null);
  check("give: someone who only reads badges isn't shown one", (await viewer.get(`/api/badge-holders/person/${tsPerson.id}`)).data.suggested === null);
  r = await desk.post(`/api/badges/${sci.id}/assign`, { kind: "person", holderId: tsPerson.id });
  check("give: a refusal doesn't name the level to front desk", r.status === 409 && !NAMES.test(r.text));
  r = await manager.post(`/api/badges/${sci.id}/assign`, { kind: "person", holderId: tsPerson.id });
  check("give: but does to a manager", r.status === 409 && /TS\/\/SCI/.test(r.data.error));
  check("give: the badge given comes back without its level", !NAMES.test((await desk.post(`/api/badges/${ts.id}/assign`, { kind: "person", holderId: tsPerson.id })).text));
  check("give: plain badges are unaffected", (await desk.post(`/api/badges/${plain.id}/assign`, { kind: "person", holderId: nobody.id })).status === 200);

  // --- records ----------------------------------------------------------------------------------------
  r = await desk.get(`/api/people/${tsPerson.id}`);
  check("records: front desk sees the validation tag, not the clearance", r.data.person.clearanceStatus === "validated" && r.data.person.clearanceLevel === undefined && !NAMES.test(r.text));
  r = await desk.get(`/api/visitors/${visitor.id}`);
  check("records: nor a visitor's", r.data.visitor.clearanceLevel === undefined && !NAMES.test(r.text));
  check("records: a manager sees it", (await manager.get(`/api/people/${tsPerson.id}`)).data.person.clearanceLevelName === "TS");

  // --- the role switch ----------------------------------------------------------------------------------
  check("role: Security can't be switched off", (await admin.put("/api/roles/security", { clearances: false })).status === 400);
  r = await admin.put("/api/roles/frontdesk", { clearances: true });
  check("role: front desk switched on", r.status === 200 && r.data.role.clearances === true);
  check("role: then front desk sees level names", (await desk.get("/api/config")).data.clearanceLevels.length === 5 && (await desk.get(`/api/badges/${ts.id}`)).data.badge.clearanceLevelName === "TS");
  await admin.put("/api/roles/frontdesk", { clearances: false });
  check("role: and switched off again, doesn't", (await desk.get("/api/config")).data.clearanceLevels.length === 0 && (await desk.get(`/api/badges/${ts.id}`)).data.badge.clearanceLevelName === undefined);
  r = await admin.post("/api/roles", { name: "Reception", badges: "edit", visitors: "edit" });
  check("role: a new role starts without them", r.data.role.clearances === false);

  // --- a level's images go with it --------------------------------------------------------------------
  const q = (await admin.post("/api/clearance/levels", { name: "Q", rank: 5 })).data.level;
  await put(q.id, "tenant");
  await admin.del(`/api/clearance/levels/${q.id}`);
  check("levels: removing a level removes its images", !(await admin.get("/api/badge-templates")).data.templates.some((t) => t.levelId === q.id));
  check("images: removed", (await admin.del(`/api/badge-templates/0/visitor`)).status === 200 && (await admin.get("/api/badge-templates")).data.templates.length === 4);

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
