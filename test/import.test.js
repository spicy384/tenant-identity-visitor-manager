/**
 * Importing from an Access database (test/fixtures/directory.mdb, made by
 * make-access-fixture.ps1) and from CSV, with columns matched to fields: reading the file,
 * its tables and a sample, matching, fixed values, all-or-nothing imports, who may import,
 * and that the file is held only by the account that sent it.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { cellText } = require("../import-routes");

const { check, report } = createChecker("Importing from Access and CSV");
const PORT = Number(process.env.TEST_IMPORT_PORT) || 3989;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "directory.mdb"));
const password = () => crypto.randomBytes(12).toString("base64url");

function client() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = raw ? "application/octet-stream" : "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data };
  }
  return {
    get: (u) => call("GET", u),
    post: (u, b = {}) => call("POST", u, b),
    del: (u) => call("DELETE", u),
    upload: (u, buf, headers) => call("POST", u, buf, { raw: true, headers })
  };
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

// --- cells as the import sees them ---------------------------------------------------------------
check("cells: a date alone as YYYY-MM-DD", cellText(new Date("2024-03-01T00:00:00Z")) === "2024-03-01");
check("cells: yes/no as yes or no", cellText(true) === "yes" && cellText(false) === "no");
check("cells: empty as nothing", cellText(null) === "" && cellText(undefined) === "");
check("cells: numbers and text as text, trimmed", cellText(42) === "42" && cellText("  Ada ") === "Ada");

let server;
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-import-"));
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
  await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" });
  const harbour = (await admin.get("/api/config")).data.sites.find((s) => s.name === "Harbour Point");
  await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: harbour.id }] });
  const pw = { manny: password(), manny2: password(), desk: password() };
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "manny2", password: pw.manny2, role: "manager" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const otherManager = await as("manny2");
  const desk = await as("desk");

  // --- reading the Access file ----------------------------------------------------------------------
  check("read: only those who change the directory may import", (await desk.upload("/api/import/read?name=directory.mdb", FIXTURE)).status === 403);
  check("read: not without a file", (await manager.upload("/api/import/read?name=empty.mdb", Buffer.alloc(0))).status === 400);
  let r = await manager.upload("/api/import/read?name=broken.mdb", Buffer.from("not an access database ".repeat(400)));
  check("read: a file that isn't an Access database says so", r.status === 400 && /couldn't be read as an Access database/.test(r.data.error));
  r = await manager.upload("/api/import/read?name=directory.mdb", FIXTURE);
  check("read: the database's tables, with their columns and rows", r.status === 200 && r.data.format === "access" && r.data.tables.map((t) => t.name).join() === "Firms,Tenant Staff"
    && r.data.tables.find((t) => t.name === "Tenant Staff").rowCount === 4 && r.data.tables.find((t) => t.name === "Tenant Staff").columns.some((c) => c.name === "Surname"));
  let token = r.data.token;
  r = await manager.get(`/api/import/${token}/table?name=${encodeURIComponent("Tenant Staff")}`);
  const sample = r.data.sample;
  check("table: a sample of its rows, as text", sample.length === 4 && sample[0].Surname === "Lovelace" && sample[0].StartDate === "2024-03-01" && sample[0].IsCurrent === "yes" && sample[2].EMail === "");
  check("table: accents come through", sample[1].FirstName === "José" && sample[1].Surname === "Núñez");
  check("table: only for whoever sent the file", (await otherManager.get(`/api/import/${token}/table?name=Firms`)).status === 404 && (await admin.get(`/api/import/${token}/table?name=Firms`)).status === 404);
  check("table: a table that isn't there", (await manager.get(`/api/import/${token}/table?name=Nope`)).status === 404);

  // --- matching, and all or nothing --------------------------------------------------------------------
  const people = { first_name: { column: "FirstName" }, last_name: { column: "Surname" }, company: { column: "Firm" }, email: { column: "EMail" }, work_phone: { column: "DeskPhone" }, job_title: { column: "Title" }, active: { column: "IsCurrent" }, notes: { column: "Notes" } };
  check("run: a column that isn't in the table is refused", (await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: { ...people, mobile: { column: "Cell" } } })).status === 400);
  check("run: so is a field name that isn't one", (await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: { ...people, "Bad Key": { column: "Title" } } })).status === 400);
  r = await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: people });
  check("run: companies that don't exist stop the lot, by row", r.status === 400 && /Row 3: There is no company called "Globex"/.test(r.data.error) && /Row 4: There is no company called "Initech"/.test(r.data.error));
  check("run: and nothing was imported", (await admin.get("/api/people")).data.total === 0);

  // Companies first, from the Firms table: site from a column, suite from another.
  r = await manager.post(`/api/import/${token}/run`, { table: "Firms", target: "companies", mapping: { name: { column: "FirmName" }, site: { column: "Building" }, suite: { column: "Suite" }, phone: { column: "MainPhone" } } });
  check("run: companies from another table in the same file", r.status === 200 && r.data.added === 1 && r.data.updated === 1, JSON.stringify(r.data));
  const companies = (await admin.get("/api/companies")).data.companies;
  const globex = companies.find((c) => c.name === "Globex");
  check("run: with their site, suite and phone", globex && globex.phone === "555-0200" && globex.sites[0].siteName === "Harbour Point" && globex.sites[0].suite === "Suite 200");
  check("run: the file is let go once imported", (await manager.get(`/api/import/${token}/table?name=Firms`)).status === 404);

  // Read it again for the people, adding the company that is still missing.
  token = (await manager.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  check("run: with two sites, a company it adds needs one", (await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: people, createCompanies: true })).status === 400);
  r = await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: { ...people, site: { value: "Harbour Point" } }, createCompanies: true });
  check("run: people from Access, adding the missing company at the site given for every row", r.status === 200 && r.data.added === 4 && r.data.updated === 0, JSON.stringify(r.data));
  const all = (await admin.get("/api/people?all=1")).data.people;
  const jose = all.find((p) => p.email === "jose@acme.example");
  const grace = all.find((p) => p.lastName === "Hopper");
  check("run: names, accents and all", jose && jose.firstName === "José" && jose.lastName === "Núñez" && jose.companyName === "Acme Corp" && jose.jobTitle === "Analyst");
  check("run: yes/no columns become active or not", grace && grace.active === false && all.find((p) => p.lastName === "Lovelace").active === true);
  check("run: empty cells stay empty", grace.email === null && all.find((p) => p.lastName === "Turing").workPhone === null);
  check("run: in the audit log, with where it came from", (await admin.get("/api/audit?action=import.people")).data.entries.some((e) => /Access table "Tenant Staff" in directory\.mdb/.test(e.detail || "")));
  token = (await manager.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: people });
  check("run: importing again updates rather than adding twice", r.data.added === 0 && r.data.updated === 4);

  // --- CSV through the same steps, with a value for every row -----------------------------------------------
  const csv = Buffer.from("﻿Given Name,Family Name,E-mail\r\nKay,Kiosk,kay@acme.example\r\nLee,Lobby,\r\n", "utf8");
  r = await manager.upload("/api/import/read?name=new-starters.csv", csv);
  check("csv: one table, with the header's own names", r.status === 200 && r.data.format === "csv" && r.data.tables[0].columns.map((c) => c.name).join() === "Given Name,Family Name,E-mail" && r.data.tables[0].rowCount === 2);
  token = r.data.token;
  r = await manager.post(`/api/import/${token}/run`, { table: "CSV", target: "people", mapping: { first_name: { column: "Given Name" }, last_name: { column: "Family Name" }, email: { column: "E-mail" }, company: { value: "Acme Corp" } } });
  check("csv: imported, with the company given once for every row", r.status === 200 && r.data.added === 2 && (await admin.get("/api/people?q=Lobby")).data.people[0]?.companyName === "Acme Corp");
  r = await manager.upload("/api/import/read?name=x.csv", Buffer.from("a,b\n1,2\n"));
  check("csv: a required field left unmatched is refused", (await manager.post(`/api/import/${r.data.token}/run`, { table: "CSV", target: "people", mapping: { first_name: { column: "a" } } })).status === 400);
  check("cancel: the file can be let go", (await manager.del(`/api/import/${r.data.token}`)).status === 200 && (await manager.get(`/api/import/${r.data.token}/table`)).status === 404);

  // --- never on disk ------------------------------------------------------------------------------------
  const written = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else written.push(p); } };
  walk(dataDir);
  check("disk: the uploaded file is never saved", written.every((p) => !/\.(mdb|accdb|csv)$/i.test(p)) && !written.some((p) => fs.readFileSync(p).includes(FIXTURE.subarray(0, 64))));

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
