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
const { createNameMatcher, wordSimilarity } = require("../name-match");

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
    put: (u, b = {}) => call("PUT", u, b),
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

// --- a name in a file, against the names on record --------------------------------------------------
const roster = [
  { id: 1, firstName: "Robert", lastName: "Smith" }, { id: 2, firstName: "Jane", lastName: "Smith" }, { id: 3, firstName: "John", lastName: "Smith" },
  { id: 4, firstName: "John", lastName: "Smith" }, { id: 5, firstName: "Christopher", lastName: "Nguyen", preferredName: "Topher" }, { id: 6, firstName: "Maria", lastName: "De La Cruz" },
  { id: 7, firstName: "Sean", lastName: "O'Brien" }, { id: 8, firstName: "Anne", lastName: "Smith-Jones" }, { id: 9, firstName: "Elizabeth", lastName: "Warren" }, { id: 10, firstName: "Jonathan", lastName: "Doe" }
];
const { match: matchName } = createNameMatcher(roster);
const ids = (name) => matchName(name).map((m) => m.person.id).sort((a, b) => a - b).join();
const top = (name) => matchName(name)[0];
check("names: the same, in any order", top("Elizabeth Warren").exact && top("Warren, Elizabeth").exact && top("Warren Elizabeth").exact && ids("Warren, Elizabeth") === "9");
check("names: initials and a suffix don't matter", top("Elizabeth Q. Warren Jr.").exact);
check("names: accents and punctuation don't matter", top("Séan O'Brien").exact && top("SEAN OBRIEN")?.person.id === 7);
check("names: two with one name are both offered, both exact", ids("John Smith").startsWith("3,4") && matchName("John Smith").filter((m) => m.exact).length === 2);
check("names: a sharing surname isn't enough when the first name is another's", !ids("John Smith").split(",").includes("2") && !ids("Robert Smith").split(",").includes("2"));
check("names: a nickname", top("Bob Smith")?.person.id === 1 && !top("Bob Smith").exact && top("Liz Warren")?.person.id === 9);
check("names: a shortened name", top("Chris Nguyen")?.person.id === 5 && top("Jon Doe")?.person.id === 10);
check("names: a preferred name is exact", top("Topher Nguyen").exact);
check("names: typos, in either name", top("Elizabth Warren")?.person.id === 9 && top("Elizabeth Warrne")?.person.id === 9 && top("Robert Smyth")?.person.id === 1);
check("names: an initial for the first name", top("E Warren")?.person.id === 9 && !top("E Warren").exact && !top("E Warren").weak);
check("names: with nobody closer, the same last name alone is a guess", top("Q Warren")?.person.id === 9 && top("Moe Warren").weak && !top("Moe Warren").exact && ids("Moe Warren") === "9");
check("names: and only the very same last name", ids("Moe Warrne") === "" && ids("Zebedee Smith").split(",").length === 4 && matchName("Zebedee Smith").every((m) => m.weak));
check("names: a middle name not on record is close, not exact", top("Elizabeth Ann Warren")?.person.id === 9 && !top("Elizabeth Ann Warren").exact);
check("names: written apart or together", top("Maria Delacruz")?.person.id === 6 && top("Maria De La Cruz").exact);
check("names: one of a double surname", top("Anne Jones")?.person.id === 8 && !top("Anne Jones").exact);
check("names: a last name alone offers everyone with it, none exact", ["1", "2", "3", "4"].every((i) => ids("Smith").split(",").includes(i)) && matchName("Smith").every((m) => !m.exact));
check("names: nobody close is nobody", ids("Zebedee Quux") === "" && ids("") === "" && ids("J") === "");
check("names: similar words are similar, others aren't", wordSimilarity("jonh", "john") > 0.7 && wordSimilarity("tim", "tom") === 0 && wordSimilarity("bill", "will") > 0.9);

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
  r = await csvRun("expires.csv", "Card,Kind,Expiration Date\n7001,tenant,2031-01-15\n7002,visitor,3/9/2031\n7003,personnel,\n", { number: { column: "Card" }, type: { column: "Kind" }, expires: { column: "Expiration Date" } });
  const exp = async (n) => (await security.get(`/api/badges?q=${n}`)).data.badges.find((b) => b.number === n)?.expiresOn;
  check("badges: expiry dates imported, as YYYY-MM-DD or M/D/YYYY, empty for none", r.status === 200 && r.data.added === 3 && await exp("7001") === "2031-01-15" && await exp("7002") === "2031-03-09" && await exp("7003") === null, JSON.stringify(r.data));
  r = await csvRun("bad-expires.csv", "Card,Kind,Expires\n7004,tenant,13/40/2031\n", { number: { column: "Card" }, type: { column: "Kind" }, expires: { column: "Expires" } });
  check("badges: a date that isn't one is refused", r.status === 400 && /isn't a date for expires/.test(r.data.error));

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

  // --- clearances validated elsewhere, onto people already here (Security) ------------------------------
  // A second Dee Dunn, at another company, to tell apart.
  token = (await manager.upload("/api/import/read?name=dunn.csv", Buffer.from("First,Last,Firm\nDee,Dunn,Dunn Partners\n"))).data.token;
  await manager.post(`/api/import/${token}/run`, { table: "CSV", target: "people", mapping: { ...messyMap, site: { value: SITE_NAME } }, createCompanies: true });
  const cleared = 'Name,Clearance,Date Validated\n"Able, Ann",Secret,3/1/2025\nKay Q. Kiosk,TS,2025-02-10\nNobody Here,Secret,2025-01-01\nDee Dunn,Secret,2025-01-01\nLee Lobby,Top Banana,2025-01-01\nEve Ever,Secret,2099-01-01\n';
  const clearMap = { name: { column: "Name" }, kind: { value: "person" }, level: { column: "Clearance" }, validated: { column: "Date Validated" } };
  // Files with Name and Level columns, of people or visitors.
  const anyMap = { name: { column: "Name" }, level: { column: "Level" } };
  // Each lets go of its file after (the server holds only a few at once).
  const clearRun = async (who, text, extra = {}, mapping = clearMap) => {
    const read = await who.upload("/api/import/read?name=cleared.csv", Buffer.from(text, "utf8"));
    const result = await who.post(`/api/import/${read.data.token}/run`, { table: "CSV", target: "clearances", mapping, ...extra });
    await who.del(`/api/import/${read.data.token}`);
    return result;
  };
  const refused = [(await clearRun(manager, cleared)).status, (await clearRun(admin, cleared)).status, (await clearRun(office, cleared)).status];
  check("clearances: only Security imports them", refused.every((s) => s === 403), refused.join());
  r = await clearRun(security, cleared);
  check("clearances: names that match nobody, or two people, stop the lot, each said", r.status === 400
    && /Line 4: Nobody called "Nobody Here" is in the directory. Add them first/.test(r.data.error) && /Line 5: 2 are called "Dee Dunn": Dee Dunn \(Acme Corp\), Dee Dunn \(Dunn Partners\)\. Add a Person or visitor, Company or Email column/.test(r.data.error)
    && /Line 6: There is no clearance level called "Top Banana"/.test(r.data.error) && /Line 7: The date validated, 2099-01-01, is still to come/.test(r.data.error), r.data.error);
  const personAs = async (who, q) => (await who.get(`/api/people?q=${encodeURIComponent(q)}`)).data.people[0];
  check("clearances: and nothing changed", !(await personAs(security, "Able")).clearanceValidatedAt);
  r = await clearRun(security, cleared, { skipProblems: true });
  check("clearances: the rest imported, the problem rows skipped", r.status === 200 && r.data.updated === 2 && r.data.added === 0 && r.data.skippedCount === 4, JSON.stringify(r.data));
  let ann = await personAs(security, "Able");
  const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  check("clearances: \"Last, First\" found, validated on the day given, by Security", ann.clearanceLevelName === "Secret" && localDay(ann.clearanceValidatedAt) === "2025-03-01" && ann.clearanceValidatedBy === "sec" && ann.clearanceStatus === "validated", JSON.stringify(ann));
  const kay = await personAs(security, "Kiosk");
  check("clearances: a middle initial needn't be on record", kay.clearanceLevelName === "TS" && localDay(kay.clearanceValidatedAt) === "2025-02-10");
  check("clearances: each one in the audit log, and the import", (await admin.get("/api/audit?action=clearance.validate")).data.entries.some((e) => e.target === "Ann Able" && /validated 2025-03-01, imported from CSV/.test(e.detail))
    && (await admin.get("/api/audit?action=import.clearances")).data.entries.some((e) => /0 added, 2 updated, 4 skipped/.test(e.target || "")));
  r = await clearRun(security, "Name,Company,Level,Validated,Expires\nDee Dunn,Dunn Partners,TS,2025-04-01,2030-01-31\nAnn Able,,Uncleared,2024-01-01,\n", {}, { ...clearMap, company: { column: "Company" }, level: { column: "Level" }, validated: { column: "Validated" }, expires: { column: "Expires" } });
  check("clearances: a company tells two people apart; one validated more recently here is left as it is", r.status === 200 && r.data.updated === 1 && r.data.unchanged === 1, JSON.stringify(r.data));
  const dunns = (await security.get("/api/people?q=Dunn")).data.people;
  check("clearances: the right Dee Dunn; an expiry column is no longer read", dunns.find((p) => p.companyName === "Dunn Partners").clearanceLevelName === "TS" && dunns.find((p) => p.companyName === "Dunn Partners").clearanceExpires === undefined
    && !dunns.find((p) => p.companyName === "Acme Corp").clearanceLevelName);
  ann = await personAs(security, "Able");
  check("clearances: the newer validation kept", ann.clearanceLevelName === "Secret");
  r = await clearRun(security, "First,Last,Level\nLee,Lobby,Uncleared\nLee,Lobby,Secret\n", {}, { first_name: { column: "First" }, last_name: { column: "Last" }, level: { column: "Level" } });
  check("clearances: first and last name columns; the same person twice is refused", r.status === 400 && /Line 3: Lee Lobby is in the file already, on line 2/.test(r.data.error), r.data.error);
  r = await clearRun(security, "First,Last,Level\nLee,Lobby,Uncleared\n", {}, { first_name: { column: "First" }, last_name: { column: "Last" }, level: { column: "Level" } });
  const lee = await personAs(security, "Lobby");
  check("clearances: Uncleared, validated today", r.status === 200 && !lee.clearanceLevelName && lee.clearanceStatus === "validated" && localDay(lee.clearanceValidatedAt) === localDay(Date.now()));
  check("clearances: nobody was added", (await admin.get("/api/people?q=Nobody")).data.total === 0);

  // Visitors too, by name in any order; a person and a visitor with the same name told apart.
  await desk.post("/api/visitors", { firstName: "Vera", lastName: "Visitor", organization: "Contoso" });
  await desk.post("/api/visitors", { firstName: "Ann", lastName: "Able", organization: "Elsewhere Ltd" });
  r = await clearRun(security, "Name,Level,Validated\nVisitor Vera,Secret,2025-05-05\n", {}, { ...anyMap, validated: { column: "Validated" } });
  const vera = (await security.get("/api/visitors?q=Vera")).data.visitors[0];
  check("clearances: a visitor, written last name first without a comma", r.status === 200 && r.data.updated === 1 && vera.clearanceLevelName === "Secret" && localDay(vera.clearanceValidatedAt) === "2025-05-05", JSON.stringify([r.data, vera]));
  check("clearances: the visitor's validation in the audit log", (await admin.get("/api/audit?action=clearance.validate")).data.entries.some((e) => e.target === "Vera Visitor" && /^visitor; Secret/.test(e.detail)));
  r = await clearRun(security, "Name,Level\nAnn Able,TS\n", {}, anyMap);
  check("clearances: a person and a visitor with the same name aren't guessed between", r.status === 400 && /2 are called "Ann Able": Ann Able \(Acme Corp\), Ann Able \(visitor, Elsewhere Ltd\)/.test(r.data.error), r.data.error);
  r = await clearRun(security, "Name,Kind,Level\nAnn Able,Visitor,TS\n", {}, { ...anyMap, kind: { column: "Kind" } });
  const annVisitor = (await security.get("/api/visitors?q=Able")).data.visitors[0];
  check("clearances: a Person or visitor column tells them apart", r.status === 200 && annVisitor.clearanceLevelName === "TS" && (await personAs(security, "Able")).clearanceLevelName === "Secret", JSON.stringify(r.data));
  r = await clearRun(security, "Name,Company,Level\nAnn Able,Elsewhere Ltd,Uncleared\n", {}, { ...anyMap, company: { column: "Company" } });
  check("clearances: or a visitor's own company", r.status === 200 && r.data.updated === 1 && !(await security.get("/api/visitors?q=Able")).data.visitors[0].clearanceLevelName);
  r = await clearRun(security, "Name,Kind,Level\nVera Visitor,person,TS\n", {}, { ...anyMap, kind: { column: "Kind" } });
  check("clearances: ruled out by a column, it says who is on record", r.status === 400 && /Nobody called "Vera Visitor" is in the directory; on record: Vera Visitor \(visitor, Contoso\)\. Check the Person or visitor column/.test(r.data.error), r.data.error);
  r = await clearRun(security, "Name,Level\nVera Vistor,TS\n", {}, anyMap);
  check("clearances: a misspelled name says the nearest", r.status === 400 && /The nearest: Vera Visitor \(visitor, Contoso\)/.test(r.data.error), r.data.error);
  r = await clearRun(security, "Name,Level\nSgt Kay Kiosk,TS\n", {}, { ...anyMap, kind: { value: "person" } });
  check("clearances: a rank in front still finds them", r.status === 200 && r.data.unchanged + r.data.updated === 1, JSON.stringify(r.data));

  // Adding visitors who aren't on record yet, with their clearance (Security).
  const addRun = (text, mapping, extra = {}) => clearRun(security, text, { addVisitors: true, ...extra }, mapping);
  r = await clearRun(security, "Name,Level\nNew Comer,Secret\n", {}, anyMap);
  check("add visitors: not without the box ticked", r.status === 400 && /Nobody called "New Comer"/.test(r.data.error));
  r = await addRun("Name,Organization,Visiting,Email,Citizenship,Level,Validated\n\"Comer, New\",Fabrikam,Acme Corp,new@fabrikam.example,US,Secret,2025-06-01\nFirst Timer,,,,,TS,\n", { ...anyMap, company: { column: "Organization" }, visiting: { column: "Visiting" }, email: { column: "Email" }, citizenship: { column: "Citizenship" }, validated: { column: "Validated" } });
  const comer = (await security.get("/api/visitors?q=Comer")).data.visitors[0];
  check("add visitors: added, with their clearance and details", r.status === 200 && r.data.added === 2 && comer?.firstName === "New" && comer.lastName === "Comer" && comer.organization === "Fabrikam"
    && comer.email === "new@fabrikam.example" && comer.citizenship === "US" && comer.companies?.[0]?.companyName === "Acme Corp" && comer.clearanceLevelName === "Secret" && localDay(comer.clearanceValidatedAt) === "2025-06-01", JSON.stringify([r.data, comer]));
  const timer = (await security.get("/api/visitors?q=Timer")).data.visitors[0];
  check("add visitors: \"First Last\" split at the last word, validated today", timer?.firstName === "First" && timer.lastName === "Timer" && timer.clearanceLevelName === "TS" && localDay(timer.clearanceValidatedAt) === localDay(Date.now()));
  check("add visitors: in the audit log", (await admin.get("/api/audit?action=visitor.add")).data.entries.some((e) => e.target === "New Comer" && /with their clearance/.test(e.detail || "")));
  r = await addRun("Name,Level\nNew Comer,TS\n", anyMap);
  check("add visitors: found next time, not added twice", r.status === 200 && r.data.added === 0 && r.data.updated + r.data.unchanged === 1 && (await security.get("/api/visitors?q=Comer")).data.total === 1, JSON.stringify(r.data));
  r = await addRun("Name,Level\nTwice Over,TS\nTwice Over,TS\n", anyMap);
  check("add visitors: the same new name twice in a file is one visitor, and refused", r.status === 400 && /Line 3: Twice Over is in the file already, on line 2/.test(r.data.error) && (await security.get("/api/visitors?q=Twice")).data.total === 0, r.data.error);
  r = await addRun("Name,Kind,Level\nNo Body,person,TS\n", { ...anyMap, kind: { column: "Kind" } });
  check("add visitors: never a person in the directory", r.status === 400 && /Nobody called "No Body" is in the directory/.test(r.data.error));
  r = await addRun("Name,Visiting,Level\nLost Soul,Nowhere Inc,TS\n", { ...anyMap, visiting: { column: "Visiting" } });
  check("add visitors: the company they visit must be a tenant", r.status === 400 && /no company called "Nowhere Inc" at your sites for them to visit/.test(r.data.error));

  // The visitor import takes clearance columns, from Security only.
  const vmap = { first_name: { column: "First" }, last_name: { column: "Last" }, organization: { column: "Org" }, level: { column: "Level" }, validated: { column: "Validated" } };
  const vcsv = "First,Last,Org,Level,Validated\nCleo Cleared,Visitor,Initech,TS,2025-07-07\n";
  const visitorRun = async (who, text) => {
    const read = await who.upload("/api/import/read?name=visitors.csv", Buffer.from(text, "utf8"));
    const result = await who.post(`/api/import/${read.data.token}/run`, { table: "CSV", target: "visitors", mapping: vmap });
    await who.del(`/api/import/${read.data.token}`);
    return result;
  };
  r = await visitorRun(desk, vcsv);
  check("visitor import: front desk can't import clearances", r.status === 403 && /Only Security imports clearances/.test(r.data.error));
  r = await visitorRun(desk, "First,Last,Org,Level,Validated\nPlain,Guest,Initech,,\n");
  check("visitor import: without them, as before", r.status === 200 && r.data.added === 1);
  check("visitor import: Security alone can't import visitors", (await visitorRun(security, vcsv)).status === 403);
  pw.secdesk = password();
  await admin.post("/api/users", { username: "secdesk", password: pw.secdesk, roles: ["security", "frontdesk"] });
  const secDesk = await as("secdesk");
  r = await visitorRun(secDesk, vcsv + "Bad,Date,Initech,TS,2099-01-01\n");
  check("visitor import: a clearance problem stops the lot", r.status === 400 && /Line 3: The date validated, 2099-01-01, is still to come/.test(r.data.error));
  r = await visitorRun(secDesk, vcsv);
  const cleo = (await security.get("/api/visitors?q=Cleo")).data.visitors[0];
  check("visitor import: Security with visitor access adds them with their clearance", r.status === 200 && r.data.added === 1 && cleo?.clearanceLevelName === "TS" && localDay(cleo.clearanceValidatedAt) === "2025-07-07" && cleo.clearanceValidatedBy === "secdesk", JSON.stringify([r.data, cleo]));
  r = await visitorRun(secDesk, "First,Last,Org,Level,Validated\nCleo Cleared,Visitor,Initech,Secret,2024-01-01\n");
  check("visitor import: an older validation leaves the newer one", r.status === 200 && r.data.updated === 1 && (await security.get("/api/visitors?q=Cleo")).data.visitors[0].clearanceLevelName === "TS");

  // --- tenant badges, assigned to people by name ---------------------------------------------------------
  const tb = async (client_, csv, choices, mapping = { name: { column: "Name" }, number: { column: "Badge" } }) => {
    const read1 = (await client_.upload("/api/import/read?name=badges.csv", Buffer.from(csv))).data;
    const review = await client_.post(`/api/import/${read1.token}/tenant-badges/review`, { table: "CSV", mapping });
    const pick = choices ? choices(review.data) : null;
    const run = pick ? await client_.post(`/api/import/${read1.token}/run`, { table: "CSV", target: "tenant_badges", mapping, choices: pick }) : null;
    return { review, run, token: read1.token };
  };
  const preselected = (rv) => Object.fromEntries(rv.rows.filter((x) => x.personId && x.status !== "done").map((x) => [x.row, x.personId]));
  const tbCompany = (await admin.post("/api/companies", { name: "Tessera Labs", sites: [{ siteId: harbor.id }] })).data.company;
  const tbOther = (await admin.post("/api/companies", { name: "Northwind Partners", sites: [{ siteId: harbor.id }] })).data.company;
  const tbStaff = (await admin.post("/api/companies", { name: "Tower Services", buildingStaff: true, sites: [{ siteId: harbor.id }] })).data.company;
  const tbPerson = async (firstName, lastName, company, extra = {}) => (await admin.post("/api/people", { firstName, lastName, companyId: company.id, ...extra })).data.person;
  const roberta = await tbPerson("Roberta", "Quimby", tbCompany);
  const zed1 = await tbPerson("Zed", "Barlowe", tbCompany);
  const zed2 = await tbPerson("Zed", "Barlowe", tbOther);
  const mo = await tbPerson("Thomas", "Fennimore", tbCompany);
  const lena = await tbPerson("Lena", "Ostrander", tbOther);
  await tbPerson("Gus", "Staffer", tbStaff);
  const gone = await tbPerson("Hank", "Departed", tbCompany);
  await admin.put(`/api/people/${gone.id}`, { active: false });

  const tbCsv = "Name,Badge\nQuimby; Roberta,TB-1\n\"Quimby, Roberta\",TB-2\nZed Barlowe,TB-3\nTom Fennimore,TB-4\nNobody Atall,TB-5\nGus Staffer,TB-6\nHank Departed,TB-7\n\"Ostrander, Lena\",1.23E+11\n\"Ostrander, Lena\",TB-1\n";
  r = await tb(manager, tbCsv);
  check("tenant badges: a manager, who issues badges but doesn't add them, may not", r.review.status === 403);
  const deskRead2 = (await desk.upload("/api/import/read?name=badges.csv", Buffer.from(tbCsv))).data;
  check("tenant badges: nor the front desk, reviewing or running", (await desk.post(`/api/import/${deskRead2.token}/tenant-badges/review`, { table: "CSV", mapping: {} })).status === 403
    && (await desk.post(`/api/import/${deskRead2.token}/run`, { table: "CSV", target: "tenant_badges", mapping: {}, choices: {} })).status === 403);

  r = await tb(security, tbCsv);
  const rv = r.review.data;
  const onLine = (n) => rv.rows.find((x) => x.where === `Line ${n}`);
  check("tenant badges: review answers", r.review.status === 200 && rv.rows.length === 9, JSON.stringify(r.review.data).slice(0, 400));
  check("tenant badges: the same name is chosen for you", onLine(3).status === "exact" && onLine(3).personId === roberta.id && onLine(2).status === "exact");
  check("tenant badges: two with one name are to choose from, with their companies", onLine(4).status === "several" && onLine(4).personId === null && onLine(4).candidates.length === 2 && onLine(4).candidates.map((c) => c.company).sort().join() === "Northwind Partners,Tessera Labs");
  check("tenant badges: a nickname is close, chosen to check", onLine(5).status === "close" && onLine(5).personId === mo.id && onLine(5).candidates[0].exact === false);
  check("tenant badges: nobody like it isn't found", onLine(6).status === "none" && onLine(6).candidates.length === 0);
  check("tenant badges: building staff and people who left aren't offered", onLine(7).status === "none" && onLine(8).status === "none");
  check("tenant badges: a shortened number is a problem", onLine(9).status === "problem" && /scientific notation/.test(onLine(9).problem));
  check("tenant badges: a badge given twice is a problem, naming the line", onLine(10).status === "problem" && /line 2/i.test(onLine(10).problem), onLine(10).problem);
  check("tenant badges: new badges are counted, and nothing was saved", rv.newBadges === 7 && (await security.get("/api/badges?q=TB-")).data.badges.length === 0, String(rv.newBadges));
  await security.del(`/api/import/${r.token}`);

  // Counted, with one badge to spare: the second is past what it may hold.
  await admin.post(`/api/companies/${tbCompany.id}/badge-allotment`, { quantity: 1, note: "test" });
  const chargesBefore = (await admin.get(`/api/charges?companyId=${tbCompany.id}`)).data.charges?.length || 0;
  const tbFile = "Name,Badge\n\"Quimby, Roberta\",TB-10\nZed Barlowe,TB-11\nTom Fennimore,TB-12\nNobody Atall,TB-13\n\"Ostrander, Lena\",TB-10\n";
  r = await tb(security, tbFile, (data) => ({ ...preselected(data), 1: zed2.id }));
  check("tenant badges: assigns what was chosen, and lists the rest", r.run.status === 200 && r.run.data.added === 3 && r.run.data.skippedCount === 2, JSON.stringify(r.run.data).slice(0, 500));
  check("tenant badges: a row with nobody chosen says so", r.run.data.skipped.some((x) => x.where === "Line 5" && /Nobody was chosen/.test(x.reason)));
  check("tenant badges: a row with a problem says why", r.run.data.skipped.some((x) => x.where === "Line 6" && /in the file already/.test(x.reason)));
  const heldNow = async (p) => (await security.get(`/api/people?companyId=${p.companyId}`)).data.people.find((x) => x.id === p.id).heldBadges.map((b) => b.label).join();
  check("tenant badges: each to the person shown", (await heldNow(roberta)) === "TB-10" && (await heldNow(zed2)) === "TB-11" && (await heldNow(mo)) === "TB-12" && (await heldNow(zed1)) === "");
  const added = (await security.get("/api/badges?q=TB-12")).data.badges[0];
  check("tenant badges: added as a tenant badge, Uncleared, valid everywhere", added.type === "tenant" && !added.clearanceLevelId && added.sites.length === 0);
  const allot = (await admin.get(`/api/companies/${tbCompany.id}/badge-allotment`)).data.allotment;
  check("tenant badges: past the allotment isn't charged, and is added to it", allot.held === 2 && allot.allowed === 2 && allot.over === 0 && ((await admin.get(`/api/charges?companyId=${tbCompany.id}`)).data.charges?.length || 0) === chargesBefore && r.run.data.notes.some((n) => /Tessera Labs now may hold 1 more/.test(n)), JSON.stringify([allot, r.run.data.notes]));
  check("tenant badges: its ledger says why", allot.held === 2 && (await admin.get(`/api/companies/${tbCompany.id}/badge-allotment`)).data.allotment.entries.some((e) => e.kind === "adjust" && /TB-12, already held by .* when imported/.test(e.note)));
  check("tenant badges: a company not being counted is left uncounted", !(await admin.get(`/api/companies/${tbOther.id}/badge-allotment`)).data.allotment.counted);
  const tbAudit = (await admin.get("/api/audit?limit=50")).data;
  const tbEntries = tbAudit.entries || tbAudit.events || tbAudit.records || [];
  check("tenant badges: in the audit log", tbEntries.some((e) => e.action === "badge.assign" && e.target === "TB-10") && tbEntries.some((e) => e.action === "import.tenant_badges"), JSON.stringify(tbAudit).slice(0, 300));

  r = await tb(security, "Name,Badge\n\"Quimby, Roberta\",TB-10\n\"Ostrander, Lena\",TB-11\n", preselected);
  check("tenant badges: importing again leaves one already theirs", r.review.data.rows[0].status === "done" && r.review.data.counts.done === 1);
  check("tenant badges: one with someone else is a problem", r.review.data.rows[1].status === "problem" && /is with Zed Barlowe; take it back first/.test(r.review.data.rows[1].problem), r.review.data.rows[1].problem);
  check("tenant badges: and running it changes nothing", r.run.data.added === 0 && r.run.data.updated === 0 && (await heldNow(lena)) === "" && (await heldNow(roberta)) === "TB-10", JSON.stringify(r.run.data).slice(0, 300));

  // A choice can't reach what the caller couldn't choose, nor another's badge, nor a higher clearance.
  const tbLevels = Object.fromEntries((await security.get("/api/config")).data.clearanceLevels.map((l) => [l.name, l.id]));
  await security.post("/api/badges", { number: "TB-V", type: "visitor" });
  const ownStock = (await security.post("/api/badges", { number: "TB-OWN", type: "tenant" })).data.badge;
  await security.post("/api/badges", { number: "TB-TS", type: "tenant", clearanceLevelId: tbLevels.TS });
  r = await tb(security, "Name,Badge\nLena Ostrander,TB-V\nLena Ostrander,TB-TS\nLena Ostrander,TB-NEWTS\n", (data) => Object.fromEntries(data.rows.map((x) => [x.row, lena.id])), { name: { column: "Name" }, number: { column: "Badge" }, level: { value: "TS" } });
  check("tenant badges: a visitor badge isn't a tenant's", /visitor badge, not a tenant badge/.test(r.review.data.rows[0].problem || ""), JSON.stringify(r.review.data.rows[0]));
  check("tenant badges: review warns of a clearance that doesn't cover it", /doesn't cover badge TB-TS/.test(r.review.data.rows[1].candidates[0].problem || ""), JSON.stringify(r.review.data.rows[1]));
  check("tenant badges: clearance still decides, on the badge and on a new one with a level", r.run.data.added === 0 && r.run.data.updated === 0 && r.run.data.skipped.filter((x) => /doesn't cover badge/.test(x.reason)).length === 2, JSON.stringify(r.run.data).slice(0, 500));
  check("tenant badges: a badge refused isn't left added", (await security.get("/api/badges?q=TB-NEWTS")).data.badges.length === 0);
  r = await tb(security, "Name,Badge\nLena Ostrander,TB-OWN\n", () => ({ 0: gone.id }));
  check("tenant badges: someone who left is refused even if asked for", r.run.data.updated === 0 && /inactive/.test(r.run.data.skipped[0]?.reason || ""), JSON.stringify(r.run.data).slice(0, 300));
  r = await tb(security, "Name,Badge\nLena Ostrander,TB-OWN\n", preselected);
  check("tenant badges: a badge on record is given, not added", r.run.data.updated === 1 && r.run.data.added === 0 && (await heldNow(lena)) === ownStock.label);
  r = await tb(security, "Name,Company,Badge\nZed Barlowe,Tessera Labs,TB-20\n", preselected, { name: { column: "Name" }, company: { column: "Company" }, number: { column: "Badge" } });
  check("tenant badges: a company tells apart two with one name", r.review.data.rows[0].status === "exact" && r.review.data.rows[0].personId === zed1.id && (await heldNow(zed1)) === "TB-20", JSON.stringify(r.review.data.rows[0]));
  r = await tb(security, "First,Last,Badge\nThomas,Fennimore,FC-1\n", null, { first_name: { column: "First" }, last_name: { column: "Last" }, number: { column: "Badge" } });
  r = await tb(security, "Name,Badge\nMoe Fennimore,WK-1\n");
  check("tenant badges: only a last name in common is offered, never chosen for you", r.review.data.rows[0].status === "several" && r.review.data.rows[0].personId === null && r.review.data.rows[0].candidates[0]?.id === mo.id, JSON.stringify(r.review.data.rows[0]));
  await security.del(`/api/import/${r.token}`);
  r = await tb(security, "First,Last,Badge\nThomas,Fennimore,FC-1\n", null, { first_name: { column: "First" }, last_name: { column: "Last" }, number: { column: "Badge" } });
  check("tenant badges: first and last name columns", r.review.data.rows[0].status === "exact" && r.review.data.rows[0].personId === mo.id);
  await security.del(`/api/import/${r.token}`);
  r = await tb(admin, "Name,Badge\nThomas Fennimore,FC-2\n", null, { name: { column: "Name" }, number: { column: "Badge" }, facility_code: { value: "ABCD" } });
  check("tenant badges: a bad facility code is a problem", r.review.data.rows[0].status === "problem" && /2 or 3 digits/.test(r.review.data.rows[0].problem));
  await admin.del(`/api/import/${r.token}`);
  await security.post("/api/badges", { number: "SAME", facilityCode: "101", type: "tenant" });
  await security.post("/api/badges", { number: "SAME", facilityCode: "102", type: "tenant" });
  r = await tb(security, "Name,Badge\nThomas Fennimore,SAME\n");
  check("tenant badges: a number under two facility codes asks for the code", r.review.data.rows[0].status === "problem" && /101-SAME or 102-SAME/.test(r.review.data.rows[0].problem), r.review.data.rows[0].problem);
  await security.del(`/api/import/${r.token}`);

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
