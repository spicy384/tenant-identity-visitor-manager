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
const { cellText, csvTable } = require("../import-routes");

// The site as the sample Access file (test/fixtures) spells it: its rows name it, and a binary file isn't rewritten.
const SITE_NAME = "Harbour Point";
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
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: SITE_NAME });
  await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" });
  const harbor = (await admin.get("/api/config")).data.sites.find((s) => s.name === SITE_NAME);
  await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: harbor.id }] });
  const pw = { manny: password(), manny2: password(), desk: password(), sec: password(), vic: password(), office: password() };
  await admin.post("/api/roles", { name: "Badge office", directory: "read", visitors: "read", badges: "manage" });
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "manny2", password: pw.manny2, role: "manager" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "sec", password: pw.sec, role: "security" });
  await admin.post("/api/users", { username: "vic", password: pw.vic, role: "viewer" });
  await admin.post("/api/users", { username: "office", password: pw.office, role: "badge-office" });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const otherManager = await as("manny2");
  const desk = await as("desk");
  const security = await as("sec");
  const viewer = await as("vic");
  const office = await as("office");

  // --- reading the Access file ----------------------------------------------------------------------
  check("read: only those who may import something", (await viewer.upload("/api/import/read?name=directory.mdb", FIXTURE)).status === 403);
  const deskRead = await desk.upload("/api/import/read?name=directory.mdb", FIXTURE);
  check("read: front desk may (it imports visitors), but not people", deskRead.status === 200
    && (await desk.post(`/api/import/${deskRead.data.token}/run`, { table: "Tenant Staff", target: "people", mapping: { first_name: { column: "FirstName" }, last_name: { column: "Surname" }, company: { column: "Firm" } } })).status === 403);
  check("read: not without a file", (await manager.upload("/api/import/read?name=empty.mdb", Buffer.alloc(0))).status === 400);
  let r = await manager.upload("/api/import/read?name=broken.mdb", Buffer.from("not an access database ".repeat(400)));
  check("read: a file that isn't an Access database says so", r.status === 400 && /couldn't be read as an Access database/.test(r.data.error));
  r = await manager.upload("/api/import/read?name=directory.mdb", FIXTURE);
  check("read: the database's tables, with their columns and rows", r.status === 200 && r.data.format === "access" && r.data.tables.map((t) => t.name).join() === "Firms,Tenant Staff,Guests,Badge Stock"
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
  check("run: with their site, suite and phone", globex && globex.phone === "555-0200" && globex.sites[0].siteName === SITE_NAME && globex.sites[0].suite === "Suite 200");
  check("run: the file is let go once imported", (await manager.get(`/api/import/${token}/table?name=Firms`)).status === 404);

  // Read it again for the people, adding the company that is still missing.
  token = (await manager.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  check("run: with two sites, a company it adds needs one", (await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: people, createCompanies: true })).status === 400);
  r = await manager.post(`/api/import/${token}/run`, { table: "Tenant Staff", target: "people", mapping: { ...people, site: { value: SITE_NAME } }, createCompanies: true });
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

  // --- visitors ---------------------------------------------------------------------------------------------
  const guests = { first_name: { column: "GivenName" }, last_name: { column: "FamilyName" }, organization: { column: "Org" }, email: { column: "Email" }, company: { column: "VisitingFirm" }, host: { column: "HostName" }, blocked: { column: "Banned" } };
  token = (await desk.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await desk.post(`/api/import/${token}/run`, { table: "Guests", target: "visitors", mapping: guests });
  check("visitors: front desk imports them", r.status === 200 && r.data.added === 3 && r.data.updated === 0, JSON.stringify(r.data));
  const vlist = (await desk.get("/api/visitors?limit=50")).data.visitors;
  const gh = vlist.find((v) => v.lastName === "Hopper");
  check("visitors: with the company they visit and its host", gh && gh.organization === "US Navy" && gh.companies[0]?.companyName === "Acme Corp" && gh.companies[0]?.hostName === "Ada Lovelace");
  check("visitors: blocked from a yes/no column", vlist.find((v) => v.lastName === "Mischief").blocked === true && vlist.find((v) => v.lastName === "Kiosk").blocked === false);
  check("visitors: they count as checked by staff", vlist.every((v) => v.verified === true) && vlist.every((v) => v.source === "import"));
  token = (await desk.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await desk.post(`/api/import/${token}/run`, { table: "Guests", target: "visitors", mapping: guests });
  check("visitors: importing again updates them (by email, else by name)", r.data.added === 0 && r.data.updated === 3 && (await desk.get("/api/visitors?limit=50")).data.total === 3);
  r = await desk.post(`/api/import/${(await desk.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token}/run`, { table: "Guests", target: "visitors", mapping: { ...guests, host: { value: "Nobody Here" } } });
  check("visitors: a host who isn't in the company stops the lot", r.status === 400 && /Nobody at Acme Corp is called "Nobody Here"/.test(r.data.error));

  // --- badges -----------------------------------------------------------------------------------------------
  const stock = { number: { column: "BadgeNo" }, type: { column: "Kind" }, level: { column: "Lvl" }, sites: { column: "ValidAt" }, temporary: { column: "Spare" } };
  token = (await manager.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  check("badges: a manager issues badges but doesn't import them", (await manager.post(`/api/import/${token}/run`, { table: "Badge Stock", target: "badges", mapping: stock })).status === 403);
  token = (await office.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await office.post(`/api/import/${token}/run`, { table: "Badge Stock", target: "badges", mapping: stock });
  check("badges: a role that doesn't see clearance levels can't import them", r.status === 403 && /doesn't see clearance levels/.test(r.data.error));
  token = (await security.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await security.post(`/api/import/${token}/run`, { table: "Badge Stock", target: "badges", mapping: stock });
  check("badges: Security imports the stock", r.status === 200 && r.data.added === 4, JSON.stringify(r.data));
  const blist = (await security.get("/api/badges?limit=50")).data.badges;
  const by = (n) => blist.find((b) => b.number === n);
  check("badges: types from their own names (Staff is personnel)", by("P-0001").type === "personnel" && by("V-0002").type === "visitor" && by("T-0100").type === "tenant");
  check("badges: the level by name, and empty for Uncleared", by("V-0002").cleared === true && by("V-0002").clearanceLevelName === "Secret" && by("V-0001").clearanceLevelName === null && by("V-0001").cleared === false);
  check("badges: the sites they're valid at, and every site when none", by("T-0100").sites.map((x) => x.name).sort().join() === `${SITE_NAME},Riverside` && by("P-0001").sites.length === 0);
  check("badges: temporary from a yes/no column", by("T-0100").temporary === true && by("V-0001").temporary === false);
  token = (await security.upload("/api/import/read?name=directory.mdb", FIXTURE)).data.token;
  r = await security.post(`/api/import/${token}/run`, { table: "Badge Stock", target: "badges", mapping: { ...stock, level: { value: "Unknown" } } });
  check("badges: an unknown level stops the lot", r.status === 400 && /no clearance level called "Unknown"/.test(r.data.error) && /Uncleared/.test(r.data.error));
  r = await security.post(`/api/import/${token}/run`, { table: "Badge Stock", target: "badges", mapping: stock });
  check("badges: importing again updates them by number", r.data.added === 0 && r.data.updated === 4);
  check("badges: in the audit log", (await admin.get("/api/audit?action=import.badges")).data.entries.length === 2);
  // Facility codes: the same number under two codes is two badges; importing again matches code and number.
  const coded = Buffer.from("FC,Card,Kind,Class\n101,55501,visitor,Uncleared\n205,55501,visitor,Uncleared\n", "utf8");
  const codedMap = { facility_code: { column: "FC" }, number: { column: "Card" }, type: { column: "Kind" }, level: { column: "Class" } };
  r = await security.post(`/api/import/${(await security.upload("/api/import/read?name=coded.csv", coded)).data.token}/run`, { table: "CSV", target: "badges", mapping: codedMap });
  check("badges: the same number under two facility codes is two badges", r.status === 200 && r.data.added === 2, JSON.stringify(r.data));
  r = await security.post(`/api/import/${(await security.upload("/api/import/read?name=coded.csv", coded)).data.token}/run`, { table: "CSV", target: "badges", mapping: codedMap });
  check("badges: importing them again updates each by facility code and number", r.data.added === 0 && r.data.updated === 2);
  check("badges: listed with their facility codes", (await security.get("/api/badges?q=55501")).data.badges.map((b) => b.label).sort().join() === "101-55501,205-55501");
  r = await security.post(`/api/import/${(await security.upload("/api/import/read?name=bad.csv", Buffer.from("FC,Card,Kind,Class\n1234,55502,visitor,Uncleared\n"))).data.token}/run`, { table: "CSV", target: "badges", mapping: codedMap });
  check("badges: a facility code that isn't 2-3 digits is refused", r.status === 400 && /2 or 3 digits/.test(r.data.error));

  // Nothing in a file is passed over without saying so.
  const plainMap = { number: { column: "Card" }, type: { column: "Kind" }, level: { column: "Class" } };
  const csvRun = async (name, text, mapping = plainMap) => security.post(`/api/import/${(await security.upload(`/api/import/read?name=${name}`, Buffer.from(text, "utf8"))).data.token}/run`, { table: "CSV", target: "badges", mapping });
  r = await csvRun("twice.csv", "Card,Kind,Class\n600,visitor,Uncleared\n601,visitor,Uncleared\n600,visitor,Uncleared\n");
  check("badges: a file that gives the same badge twice is refused, naming both lines", r.status === 400 && /Line 4: Badge 600 is in the file already, on line 2/.test(r.data.error) && /facility code column/.test(r.data.error)
    && !(await security.get("/api/badges?q=601")).data.total);
  r = await csvRun("sci.csv", "Card,Kind,Class\n1.23457E+11,visitor,Uncleared\n");
  check("badges: a number a spreadsheet put in scientific notation is refused", r.status === 400 && /scientific notation/.test(r.data.error));
  r = await security.upload("/api/import/read?name=quote.csv", Buffer.from('Card,Kind,Notes\n700,visitor,fine\n701,visitor,"12 in\n702,visitor,lost\n', "utf8"));
  check("csv: a quote never closed is refused, naming its line, not read as one long cell", r.status === 400 && /line 3 is never closed/.test(r.data.error));
  const semi = csvTable(Buffer.from("Card;Kind;Notes\n800;visitor;a, b\n801;tenant;\n", "utf8"));
  check("csv: semicolons, as some spreadsheets save CSV", semi.columns.map((c) => c.name).join() === "Card,Kind,Notes" && semi.rowCount === 2 && semi.rows()[0].Notes === "a, b");
  const tabbed = csvTable(Buffer.from("Card\tKind\n900\tvisitor\n", "utf8"));
  check("csv: or tabs", tabbed.rows()[0].Kind === "visitor");
  const multi = csvTable(Buffer.from('Card,Notes\n1,"two\nlines"\n\n2,x\n', "utf8"));
  check("csv: each row knows the line it starts on", multi.lines.join() === "2,5");
  r = await csvRun("multi.csv", 'Card,Kind,Notes\n910,visitor,"a\nb"\n911,nobody,x\n', { number: { column: "Card" }, type: { column: "Kind" }, notes: { column: "Notes" } });
  check("csv: so a problem names the line it is really on", r.status === 400 && /Line 4:/.test(r.data.error));

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

  // --- skipping rows with problems ---------------------------------------------------------------------
  const messy = Buffer.from("First,Last,Firm\r\nAnn,Able,Acme Corp\r\n,Blank,Acme Corp\r\nCal,Cole,Nowhere Inc\r\n,,\r\nDee,Dunn,Acme Corp\r\n", "utf8");
  const messyMap = { first_name: { column: "First" }, last_name: { column: "Last" }, company: { column: "Firm" } };
  token = (await manager.upload("/api/import/read?name=messy.csv", messy)).data.token;
  r = await manager.post(`/api/import/${token}/run`, { table: "CSV", target: "people", mapping: messyMap });
  check("skip: by default one problem stops the lot, naming the rows", r.status === 400 && /^Nothing was imported\. 2 rows have a problem/.test(r.data.error) && /Line 3:/.test(r.data.error) && /Line 4:/.test(r.data.error)
    && !/Line 5/.test(r.data.error) && (await admin.get("/api/people?q=Able")).data.total === 0, r.data.error);
  r = await manager.post(`/api/import/${token}/run`, { table: "CSV", target: "people", mapping: messyMap, skipProblems: true });
  check("skip: the same file again, skipping the rows with problems", r.status === 200 && r.data.added === 2 && r.data.skippedCount === 2, JSON.stringify(r.data));
  check("skip: each skipped row says where, why, and what it held",
    r.data.skipped.map((x) => x.where).join() === "Line 3,Line 4" && /first name/i.test(r.data.skipped[0].reason) && /Nowhere Inc/.test(r.data.skipped[1].reason)
    && r.data.skipped[1].row.first_name === "Cal" && r.data.skipped[1].row.company === "Nowhere Inc", JSON.stringify(r.data.skipped));
  check("skip: the good rows are in", (await admin.get("/api/people?q=Dunn")).data.total === 1 && (await admin.get("/api/people?q=Able")).data.total === 1);
  check("skip: and the audit log counts the skipped ones", (await admin.get("/api/audit?action=import.people")).data.entries.some((e) => /2 added, 0 updated, 2 skipped/.test(e.target || "")));
  // A row that fails part-way leaves nothing behind: here its new company.
  token = (await manager.upload("/api/import/read?name=half.csv", Buffer.from("First,Last,Firm\nEve,Ever,Acme Corp\n,Nobody,Brand New Co\n"))).data.token;
  r = await manager.post(`/api/import/${token}/run`, { table: "CSV", target: "people", mapping: { ...messyMap, site: { value: SITE_NAME } }, createCompanies: true, skipProblems: true });
  check("skip: a row that fails part-way leaves nothing behind", r.status === 200 && r.data.added === 1 && r.data.skippedCount === 1
    && !(await admin.get("/api/companies?q=Brand New")).data.companies.length, JSON.stringify(r.data));

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
