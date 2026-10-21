/**
 * Facilities: floors with plans, offices drawn on them, assigning offices to companies over
 * time (one at a time, with history), rates per square foot per month (company over office
 * over site), what a company pays, and who may see and change any of it.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Facilities");
const PORT = Number(process.env.TEST_FACILITIES_PORT) || 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const password = () => crypto.randomBytes(12).toString("base64url");
// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-facilities-"));
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
  const river = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const mk = async (name, sites) => (await admin.post("/api/companies", { name, sites })).data.company;
  const acme = await mk("Acme", [{ siteId: harbour.id }]);
  const globex = await mk("Globex", [{ siteId: harbour.id }]);
  const initech = await mk("Initech", [{ siteId: river.id }]);

  // A custom role that only looks at facilities.
  const leasing = (await admin.post("/api/roles", { name: "Leasing", directory: "read", visitors: "none", badges: "none", facilities: "read" })).data.role;
  const pw = { manny: password(), desk: password(), harbourManager: password(), lee: password() };
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "harbourManager", password: pw.harbourManager, role: "manager", sites: [harbour.id] });
  await admin.post("/api/users", { username: "lee", password: pw.lee, role: leasing.id });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const desk = await as("desk");
  const harbourManager = await as("harbourManager");
  const lee = await as("lee");

  // --- who reaches facilities -----------------------------------------------------------------------
  check("access: managers change facilities", (await manager.get("/api/config")).data.access.facilities === "edit");
  check("access: front desk doesn't see them", (await desk.get("/api/config")).data.access.facilities === "none" && (await desk.get("/api/floors")).status === 403);
  check("access: a custom role can be given read", leasing.facilities === "read" && (await lee.get("/api/floors")).status === 200);
  check("access: which can't change anything", (await lee.post("/api/floors", { siteId: harbour.id, name: "Ground" })).status === 403);
  const roles = (await admin.get("/api/roles")).data.roles;
  check("access: Administrator and Manager have it by default, the others don't", roles.filter((r) => r.facilities === "edit").map((r) => r.id).sort().join() === "admin,manager"
    && roles.find((r) => r.id === "security").facilities === "none");
  check("access: a role's facilities level is checked", (await admin.put(`/api/roles/${leasing.id}`, { facilities: "manage" })).status === 400);
  check("access: kiosk and API roles can't have it", (await admin.put("/api/roles/kiosk", { facilities: "read" })).status === 400);
  check("access: the dashboard offers occupancy to those who see facilities", (await manager.get("/api/me/prefs")).data.available.includes("occupancy")
    && !(await desk.get("/api/me/prefs")).data.available.includes("occupancy"));

  // --- floors and plans ------------------------------------------------------------------------------
  let r = await manager.post("/api/floors", { siteId: harbour.id, name: "Level 1" });
  const level1 = r.data.floor;
  check("floors: added", r.status === 200 && level1.siteId === harbour.id && level1.planRef === null);
  check("floors: one name per site", (await manager.post("/api/floors", { siteId: harbour.id, name: "level 1" })).status === 409);
  const riverFloor = (await manager.post("/api/floors", { siteId: river.id, name: "Level 1" })).data.floor;
  check("floors: the same name at another site is fine", Boolean(riverFloor));
  check("floors: not at a site the account can't see", (await harbourManager.post("/api/floors", { siteId: river.id, name: "Level 2" })).status === 403
    && (await harbourManager.get(`/api/floors/${riverFloor.id}`)).status === 404
    && (await harbourManager.get("/api/floors")).data.floors.every((f) => f.siteId === harbour.id));
  check("plans: only PNG or JPEG", (await manager.put(`/api/floors/${level1.id}/plan`, { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" })).status === 400);
  check("plans: whose contents match", (await manager.put(`/api/floors/${level1.id}/plan`, { dataUrl: "data:image/png;base64,aGVsbG8gd29ybGQ=" })).status === 400);
  r = await manager.put(`/api/floors/${level1.id}/plan`, { dataUrl: PNG });
  const ref = r.data.floor?.planRef;
  check("plans: uploaded", r.status === 200 && /^[A-Za-z0-9_-]{16}$/.test(ref));
  r = await lee.get(`/api/floor-plans/${ref}`);
  check("plans: shown to those who see facilities", r.status === 200 && r.data.type === "image/png" && r.data.bytes > 0);
  check("plans: not to others", (await desk.get(`/api/floor-plans/${ref}`)).status === 403);
  const riverPlan = (await manager.put(`/api/floors/${riverFloor.id}/plan`, { dataUrl: PNG })).data.floor.planRef;
  check("plans: nor at sites the account can't see", (await harbourManager.get(`/api/floor-plans/${riverPlan}`)).status === 404);
  check("plans: a new upload gets a new address", (await manager.put(`/api/floors/${level1.id}/plan`, { dataUrl: PNG })).data.floor.planRef !== ref
    && (await manager.get(`/api/floor-plans/${ref}`)).status === 404);

  // --- offices ---------------------------------------------------------------------------------------
  r = await manager.post("/api/offices", { floorId: level1.id, name: "101", sqft: 1200, x: 0.1, y: 0.1, w: 0.2, h: 0.15 });
  const o101 = r.data.office;
  check("offices: drawn on a floor", r.status === 200 && o101.status === "available" && o101.x === 0.1 && o101.w === 0.2);
  check("offices: one name per floor", (await manager.post("/api/offices", { floorId: level1.id, name: "101" })).status === 409);
  r = await manager.post("/api/offices", { floorId: level1.id, name: "102", sqft: 800, x: 0.9, y: 0.5, w: 0.5, h: 0.2 });
  const o102 = r.data.office;
  check("offices: kept on the plan", o102.w === 0.1 && o102.x === 0.9);
  check("offices: too small to see is refused", (await manager.post("/api/offices", { floorId: level1.id, name: "103", x: 0.5, y: 0.5, w: 0, h: 0.1 })).status === 400);
  check("offices: square feet must be a number", (await manager.post("/api/offices", { floorId: level1.id, name: "104", sqft: "big" })).status === 400);
  const o105 = (await manager.post("/api/offices", { floorId: level1.id, name: "105", sqft: 500 })).data.office;
  check("offices: needn't be drawn", o105.x === null && o105.status === "available");
  check("offices: no rate, no cost", o101.effectiveRate === null && o101.monthly === null);

  // --- outlines and scale ------------------------------------------------------------------------------
  // A plan 200 by 100 pixels (the header is all the server reads for its size).
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(200, 8);
  ihdr.writeUInt32BE(100, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const widePng = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from("0000000049454e44ae426082", "hex")]).toString("base64")}`;
  const level2 = (await manager.post("/api/floors", { siteId: harbour.id, name: "Level 2" })).data.floor;
  check("scale: needs a plan first", (await manager.put(`/api/floors/${level2.id}/scale`, { from: [0, 0], to: [1, 0], feet: 100 })).status === 400);
  r = await manager.put(`/api/floors/${level2.id}/plan`, { dataUrl: widePng });
  check("plans: their size is kept", r.data.floor.planWidth === 200 && r.data.floor.planHeight === 100 && r.data.floor.scale === null);
  const ell = [[0, 0], [0.4, 0], [0.4, 0.2], [0.2, 0.2], [0.2, 0.4], [0, 0.4]];
  r = await manager.post("/api/offices", { floorId: level2.id, name: "L", points: ell });
  const lOffice = r.data.office;
  check("outlines: an office of any shape", r.status === 200 && lOffice.points.length === 6 && lOffice.x === 0 && lOffice.w === 0.4 && lOffice.h === 0.4);
  check("outlines: no size measured without a scale", lOffice.measuredSqft === null && lOffice.sqft === null);
  check("outlines: at least 3 points", (await manager.post("/api/offices", { floorId: level2.id, name: "Line", points: [[0, 0], [1, 1]] })).status === 400);
  check("outlines: points are [x, y]", (await manager.post("/api/offices", { floorId: level2.id, name: "Bad", points: [[0, 0], [1, "a"], [1, 1]] })).status === 400);
  check("outlines: kept on the plan", (await manager.post("/api/offices", { floorId: level2.id, name: "Edge", points: [[0.9, 0.9], [1.5, 0.9], [1.5, 1.5]] })).data.office.points.every((p) => p[0] <= 1 && p[1] <= 1));
  check("outlines: a rectangle becomes its corners", JSON.stringify((await manager.get(`/api/offices/${o101.id}`)).data.office.points) === "[[0.1,0.1],[0.3,0.1],[0.3,0.25],[0.1,0.25]]");
  check("scale: needs a longer line", (await manager.put(`/api/floors/${level2.id}/scale`, { from: [0, 0], to: [0.001, 0], feet: 10 })).status === 400);
  check("scale: read-only roles can't set it", (await lee.put(`/api/floors/${level2.id}/scale`, { from: [0, 0], to: [1, 0], feet: 100 })).status === 403);
  // A diagonal line: 0.3 of the width across and 0.8 of the height down, which is 0.4 widths
  // on a plan half as tall as it is wide: 0.5 widths long. 50 feet, so the plan is 100 ft by 50.
  r = await manager.put(`/api/floors/${level2.id}/scale`, { from: [0, 0], to: [0.3, 0.8], feet: 50 });
  check("scale: set from a line of known length", r.status === 200 && r.data.floor.scale.feet === 100 && r.data.floor.scale.line.feet === 50);
  r = (await manager.get(`/api/offices/${lOffice.id}`)).data.office;
  check("scale: an outline's area is measured", r.measuredSqft === 600);
  check("scale: but the size stays what was entered", r.sqft === null && (await manager.put(`/api/offices/${lOffice.id}`, { sqft: 640 })).data.office.sqft === 640);
  r = (await manager.put(`/api/offices/${lOffice.id}`, { points: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] })).data.office;
  check("outlines: reshaped", r.points.length === 4 && r.measuredSqft === 1250 && r.sqft === 640);
  check("scale: kept when the plan is replaced by one of the same shape", (await manager.put(`/api/floors/${level2.id}/plan`, { dataUrl: widePng })).data.floor.scale?.feet === 100);
  check("scale: cleared when the new plan's shape differs", (await manager.put(`/api/floors/${level2.id}/plan`, { dataUrl: PNG })).data.floor.scale === null);
  await manager.put(`/api/floors/${level2.id}/scale`, { from: [0, 0], to: [1, 0], feet: 80 });
  check("scale: cleared on request", (await manager.put(`/api/floors/${level2.id}/scale`, { feet: null })).data.floor.scale === null);
  await manager.del(`/api/floors/${level2.id}`);

  // --- rates -------------------------------------------------------------------------------------------
  check("rates: front desk can't set them", (await desk.put(`/api/facilities/site-rates/${harbour.id}`, { rate: 3 })).status === 403);
  check("rates: nor can read-only roles", (await lee.put(`/api/facilities/site-rates/${harbour.id}`, { rate: 3 })).status === 403);
  check("rates: a site's default", (await manager.put(`/api/facilities/site-rates/${harbour.id}`, { rate: 3 })).data.rate === 3);
  r = (await manager.get(`/api/offices/${o101.id}`)).data.office;
  check("rates: an office without its own uses the site's", r.effectiveRate === 3 && r.rateSource === "site" && r.monthly === 3600);
  r = (await manager.put(`/api/offices/${o101.id}`, { rate: 2.5 })).data.office;
  check("rates: an office's own wins over the site's", r.effectiveRate === 2.5 && r.rateSource === "office" && r.monthly === 3000);
  check("rates: a negative one is refused", (await manager.put(`/api/offices/${o101.id}`, { rate: -1 })).status === 400);
  check("rates: a company's", (await manager.put(`/api/facilities/company-rates/${acme.id}`, { rate: 2 })).data.rate === 2);
  check("rates: not for a company at sites the account can't see", (await harbourManager.put(`/api/facilities/company-rates/${initech.id}`, { rate: 2 })).status === 404);
  r = (await lee.get("/api/facilities/rates")).data;
  check("rates: listed", r.sites.find((s) => s.siteId === harbour.id).rate === 3 && r.companies.some((c) => c.companyId === acme.id && c.rate === 2));

  // --- assigning --------------------------------------------------------------------------------------
  check("assign: front desk can't", (await desk.post(`/api/offices/${o101.id}/assignments`, { companyId: acme.id, startDate: "2020-01-01" })).status === 403);
  check("assign: needs a real date", (await manager.post(`/api/offices/${o101.id}/assignments`, { companyId: acme.id, startDate: "2020-02-30" })).status === 400);
  check("assign: ending after it starts", (await manager.post(`/api/offices/${o101.id}/assignments`, { companyId: acme.id, startDate: "2020-02-01", endDate: "2020-01-01" })).status === 400);
  check("assign: needs a company", (await manager.post(`/api/offices/${o101.id}/assignments`, { companyId: 9999, startDate: "2020-02-01" })).status === 400);
  r = await manager.post(`/api/offices/${o101.id}/assignments`, { companyId: acme.id, startDate: "2020-01-01", notes: "Lease 44" });
  const lease = r.data.assignment;
  check("assign: an office to a company", r.status === 200 && r.data.office.status === "occupied" && r.data.office.current.companyName === "Acme" && lease.createdBy === "manny");
  check("assign: the company's rate wins", r.data.office.effectiveRate === 2 && r.data.office.rateSource === "company" && r.data.office.monthly === 2400);
  r = await manager.post(`/api/offices/${o101.id}/assignments`, { companyId: globex.id, startDate: "2030-01-01" });
  check("assign: one company at a time", r.status === 409 && /overlaps Acme/.test(r.data.error));
  r = await manager.post(`/api/offices/${o102.id}/assignments`, { companyId: globex.id, startDate: "2099-01-01", endDate: "2099-12-31" });
  check("assign: from a later date shows as upcoming", r.status === 200 && r.data.office.status === "upcoming" && r.data.office.next.companyName === "Globex" && r.data.office.current === null);
  check("assign: before it, someone else may have it", (await manager.post(`/api/offices/${o102.id}/assignments`, { companyId: acme.id, startDate: "2098-01-01", endDate: "2098-12-31" })).status === 200);
  check("assign: but not across it", (await manager.post(`/api/offices/${o102.id}/assignments`, { companyId: acme.id, startDate: "2099-12-01" })).status === 409);
  check("unavailable: not while assigned", (await manager.put(`/api/offices/${o102.id}`, { unavailable: true })).status === 409);
  r = await manager.put(`/api/offices/${o105.id}`, { unavailable: true });
  check("unavailable: marked", r.status === 200 && r.data.office.status === "unavailable");
  check("unavailable: can't be assigned", (await manager.post(`/api/offices/${o105.id}/assignments`, { companyId: acme.id, startDate: "2020-01-01" })).status === 409);

  // --- what a company has ----------------------------------------------------------------------------
  r = (await lee.get(`/api/companies/${acme.id}/facilities`)).data;
  check("company: its offices now and later", r.offices.length === 2 && r.offices[0].when === "current" && r.offices[0].officeName === "101" && r.offices[1].when === "upcoming");
  check("company: with its rate and what it pays now", r.rate === 2 && r.totals.offices === 1 && r.totals.sqft === 1200 && r.totals.monthly === 2400);
  r = (await manager.get(`/api/facilities/summary?siteId=${harbour.id}`)).data.summary;
  check("summary: offices by status", r.offices === 3 && r.occupied === 1 && r.upcoming === 1 && r.unavailable === 1 && r.available === 0);
  check("summary: square feet and rent", r.sqft.total === 2500 && r.sqft.occupied === 1200 && r.sqft.available === 800 && r.monthly === 2400 && r.asking === 2400);
  check("summary: by status in the list too", (await manager.get("/api/offices?status=upcoming")).data.offices.map((o) => o.name).join() === "102");

  // --- deleting, merging and ending -------------------------------------------------------------------
  r = await admin.del(`/api/companies/${acme.id}`);
  check("company: not deleted while it has offices", r.status === 409 && /101/.test(r.data.error));
  check("offices: not deleted while assigned", (await manager.del(`/api/offices/${o101.id}`)).status === 409);
  check("floors: nor their floor", (await manager.del(`/api/floors/${level1.id}`)).status === 409);
  r = await manager.post("/api/companies/merge", { intoId: acme.id, fromIds: [globex.id] });
  check("merge: offices follow the company", r.status === 200 && (await manager.get(`/api/offices/${o102.id}`)).data.office.assignments.every((a) => a.companyId === acme.id));
  r = await manager.put(`/api/office-assignments/${lease.id}`, { endDate: "2020-12-31" });
  check("end: an assignment ended frees the office", r.status === 200 && r.data.office.status === "available" && r.data.assignment.endDate === "2020-12-31");
  r = (await manager.get(`/api/offices/${o101.id}`)).data.office;
  check("end: and stays as its history", r.assignments.length === 1 && r.assignments[0].companyName === "Acme" && r.assignments[0].notes === "Lease 44");
  check("end: the office's own rate applies again", r.effectiveRate === 2.5 && r.monthly === 3000);
  check("history: the company keeps it too", (await manager.get(`/api/companies/${acme.id}/facilities`)).data.offices.some((o) => o.when === "ended" && o.officeName === "101"));
  for (const a of (await manager.get(`/api/offices/${o102.id}`)).data.office.assignments) await manager.del(`/api/office-assignments/${a.id}`);
  check("remove: an assignment made by mistake", (await manager.get(`/api/offices/${o102.id}`)).data.office.assignments.length === 0);
  check("company: deleted once it has no offices", (await admin.del(`/api/companies/${acme.id}`)).status === 200);
  check("history: names the company it was", (await manager.get(`/api/offices/${o101.id}`)).data.office.assignments[0].companyName === "Acme");
  check("site: can't be removed while it has floors", (await admin.del(`/api/sites/${river.id}`)).status === 409);
  check("floors: deleted with their offices", (await manager.del(`/api/floors/${level1.id}`)).status === 200 && (await manager.get(`/api/offices/${o101.id}`)).status === 404);
  check("audit: assignments are logged", (await admin.get("/api/audit?action=office.assign")).data.entries.some((e) => /Acme from 2020-01-01/.test(e.detail)));

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
