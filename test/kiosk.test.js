/**
 * Visitors over HTTP: the kiosk (pairing, what it may see, check-in and check-out, refs,
 * blocking, rate limits, revocation) and the staff routes (visitors, links, merge, visits,
 * site limits, settings, exports). The kiosk runs on a port of its own (KIOSK_PORT), and
 * each port is checked to refuse the other's routes.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Kiosk and visitors over HTTP");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_KIOSK_PORT) || 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const KIOSK_PORT = Number(process.env.TEST_KIOSK_ONLY_PORT) || 3983;
const KBASE = `http://127.0.0.1:${KIOSK_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-kiosk-"));
const password = () => crypto.randomBytes(12).toString("base64url");

/** A cookie-keeping client; `kiosk: true` sends the kiosk's request header on POSTs. */
function client({ kiosk = false } = {}) {
  const jar = {};
  let csrf = null;
  async function call(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    if (kiosk && method !== "GET" && !("x-kiosk-request" in headers)) h["x-kiosk-request"] = "1";
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch((kiosk ? KBASE : BASE) + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      const k = pair.slice(0, idx);
      if (/Max-Age=0/.test(line)) delete jar[k]; else jar[k] = pair.slice(idx + 1);
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (u, o) => call("GET", u, undefined, o), post: (u, b = {}, o) => call("POST", u, b, o), put: (u, b = {}, o) => call("PUT", u, b, o), del: (u, o) => call("DELETE", u, undefined, o), jar };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/auth/me`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Every key anywhere in a JSON value. */
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
  return out;
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
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), KIOSK_PORT: String(KIOSK_PORT), DATA_DIR, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitForServer()) || !(await waitFor(async () => (await fetch(`${KBASE}/kiosk/`)).ok))) {
    console.error(log);
    throw new Error("server did not start");
  }

  // --- a building to visit ---------------------------------------------------------------------
  const admin = client();
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbour Point" });
  const harbour = (await admin.get("/api/config")).data.sites[0];
  const river = (await admin.post("/api/sites", { name: "Riverside", timeZone: "Europe/London" })).data.site;
  await admin.put(`/api/sites/${harbour.id}`, { kioskName: "Welcome to Harbour Point", welcome: "Please sign in" });
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: harbour.id }] })).data.company;
  const both = (await admin.post("/api/companies", { name: "Both Partners", sites: [{ siteId: harbour.id }, { siteId: river.id }] })).data.company;
  const riverCo = (await admin.post("/api/companies", { name: "River Co", sites: [{ siteId: river.id }] })).data.company;
  const bob = (await admin.post("/api/people", { firstName: "Bob", lastName: "Host", preferredName: "Bobby", companyId: acme.id, email: "bob@acme.example" })).data.person;
  await admin.post("/api/people", { firstName: "Nora", lastName: "Nohost", companyId: acme.id, canHost: false });
  const riverHost = (await admin.post("/api/people", { firstName: "Rae", lastName: "River", companyId: both.id, siteId: river.id })).data.person;
  await admin.post("/api/people", { firstName: "Ed", lastName: "Gone", companyId: acme.id, active: false });

  // --- pairing -----------------------------------------------------------------------------------
  const kiosk = client({ kiosk: true });
  let r = await kiosk.get("/kiosk/api/config");
  check("kiosk: unpaired, it is told to pair", r.status === 401 && r.data.paired === false);
  const page = await fetch(`${KBASE}/kiosk/`);
  check("kiosk port: the page is served at /kiosk/", page.status === 200 && (await page.text()).includes("kiosk.js"));
  const root = await fetch(`${KBASE}/`, { redirect: "manual" });
  check("kiosk port: its root goes to the kiosk", root.status === 302 && root.headers.get("location") === "/kiosk/");
  check("kiosk port: the kiosk's styles, script and icon are there", (await fetch(`${KBASE}/kiosk/kiosk.js`)).ok && (await fetch(`${KBASE}/kiosk/kiosk.css`)).ok && (await fetch(`${KBASE}/icon.svg`)).ok);
  for (const p of ["/index.html", "/js/01-core.js", "/api/auth/me", "/api/config", "/api/v1/whoami", "/api/companies", "/styles.css"]) {
    check(`kiosk port: ${p} isn't there`, (await fetch(`${KBASE}${p}`)).status === 404);
  }
  check("kiosk port: nor is the staff sign-in", (await fetch(`${KBASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404);
  check("main port: no kiosk page", (await fetch(`${BASE}/kiosk/`)).status === 404 && (await fetch(`${BASE}/kiosk/kiosk.js`)).status === 404);
  check("main port: no kiosk API", (await fetch(`${BASE}/kiosk/api/config`)).status === 404 && (await fetch(`${BASE}/kiosk/api/pair`, { method: "POST", headers: { "content-type": "application/json", "x-kiosk-request": "1" }, body: "{}" })).status === 404);
  check("main port: the staff pages are still there", (await fetch(`${BASE}/`)).ok);
  r = await admin.post("/api/kiosks", { name: "Lobby iPad", siteId: harbour.id });
  check("kiosks: an administrator adds one and gets a code", r.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.code));
  const lobby = r.data.kiosk;
  const lobbyCode = r.data.code;
  check("kiosk: a pairing request without the kiosk header is refused", (await kiosk.post("/kiosk/api/pair", { code: lobbyCode }, { headers: { "x-kiosk-request": "" } })).status === 403);
  check("kiosk: a wrong code is refused", (await kiosk.post("/kiosk/api/pair", { code: "AAAA-AAAA" })).status === 401);
  r = await kiosk.post("/kiosk/api/pair", { code: lobbyCode.toLowerCase().replace("-", "") });
  check("kiosk: the right code pairs it, with an HttpOnly, SameSite=Strict cookie", r.status === 200 && /HttpOnly/.test(r.headers.get("set-cookie")) && /SameSite=Strict/.test(r.headers.get("set-cookie")) && /Path=\/kiosk/.test(r.headers.get("set-cookie")));
  check("kiosk: the code can't pair a second iPad", (await client({ kiosk: true }).post("/kiosk/api/pair", { code: lobbyCode })).status === 401);
  r = await kiosk.get("/kiosk/api/config");
  check("kiosk: config gives the site's kiosk name, welcome line and idle time", r.status === 200 && r.data.site.name === "Welcome to Harbour Point" && r.data.site.welcome === "Please sign in" && r.data.idleSeconds === 45);
  check("kiosk: a kiosk cookie is not a staff session", (await fetch(`${BASE}/api/companies`, { headers: { cookie: Object.entries(kiosk.jar).map(([k, v]) => `${k}=${v}`).join("; ") } })).status === 401);
  r = await admin.get("/api/kiosks");
  check("settings: the kiosk address shown is on the kiosk port", r.data.separatePort === true && r.data.kioskUrl === `http://127.0.0.1:${KIOSK_PORT}/kiosk/`);

  // --- what a kiosk can see --------------------------------------------------------------------------
  r = await kiosk.get("/kiosk/api/companies");
  check("kiosk: lists this site's companies, names only", r.data.companies.map((c) => c.name).join() === "Acme Corp,Both Partners" && [...allKeys(r.data)].sort().join() === "companies,id,name");
  r = await kiosk.get(`/kiosk/api/companies/${acme.id}/hosts`);
  check("kiosk: hosts are people who can host and are active, by the name they go by", r.data.hosts.map((h) => h.name).join() === "Bobby Host" && [...allKeys(r.data)].sort().join() === "hosts,id,name");
  check("kiosk: hosts at another site are left out", (await kiosk.get(`/kiosk/api/companies/${both.id}/hosts`)).data.hosts.length === 0);
  check("kiosk: a company at another site isn't there", (await kiosk.get(`/kiosk/api/companies/${riverCo.id}/hosts`)).status === 404);
  check("kiosk: a lookup needs a full name", (await kiosk.post("/kiosk/api/lookup", { name: "Grace" })).status === 400 && (await kiosk.post("/kiosk/api/lookup", { name: "G H" })).status === 400);
  r = await kiosk.post("/kiosk/api/lookup", { name: "Grace Hopper" });
  check("kiosk: someone new isn't found", r.status === 200 && r.data.matches.length === 0);

  // --- a new visitor ------------------------------------------------------------------------------------
  check("kiosk: a check-in needs a company at this site", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper" }, companyId: riverCo.id })).status === 400);
  check("kiosk: a host who can't host is refused", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "US Navy", citizenship: "US" }, companyId: acme.id, hostId: riverHost.id, purpose: "Meeting" })).status === 400);
  check("kiosk: what the visit is for is needed", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "US Navy", citizenship: "US" }, companyId: acme.id, hostId: bob.id, purpose: " " })).status === 400);
  check("kiosk: so is a new visitor's company", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", citizenship: "US" }, companyId: acme.id, hostId: bob.id, purpose: "Meeting" })).status === 400);
  check("kiosk: and their citizenship, a country on the list", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "US Navy" }, companyId: acme.id, hostId: bob.id, purpose: "Meeting" })).status === 400
    && (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "US Navy", citizenship: "Atlantis" }, companyId: acme.id, hostId: bob.id, purpose: "Meeting" })).status === 400
    && (await admin.get("/api/visitors?q=Hopper")).data.visitors.length === 0);
  check("kiosk: the countries come with its config", (await kiosk.get("/kiosk/api/config")).data.countries.some((c) => c.code === "CA" && c.name === "Canada"));
  r = await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "US Navy", citizenship: "US", contact: "grace@navy.example" }, companyId: acme.id, hostId: bob.id, purpose: "Meeting" });
  check("kiosk: a new visitor checks in", r.status === 200 && r.data.ok && r.data.firstName === "Grace" && r.data.companyName === "Acme Corp" && r.data.hostName === "Bobby Host");
  r = await admin.get("/api/visitors?filter=review");
  const grace = r.data.visitors.find((v) => v.firstName === "Grace");
  check("kiosk: they're on record, to be checked by staff, with their email", grace && grace.verified === false && grace.source === "kiosk" && grace.email === "grace@navy.example" && grace.organisation === "US Navy"
    && grace.citizenship === "US" && grace.visitorType === "Guest");
  r = await admin.get("/api/visits?status=open");
  check("visits: the visit is open, at the kiosk's site, by the kiosk", r.data.visits.length === 1 && r.data.visits[0].siteId === harbour.id && r.data.visits[0].kioskName === "Lobby iPad" && r.data.visits[0].hostName === "Bobby Host");
  check("visits: waiting for the desk to check their ID, with what it's for", r.data.visits[0].checkinStage === "id" && r.data.visits[0].purpose === "Meeting" && r.data.visits[0].visitorType === "Guest");
  check("kiosk: a bad email is refused", (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "X", lastName: "Y", organisation: "Z", citizenship: "US", contact: "not@mail" }, companyId: acme.id, purpose: "x" })).status === 400);

  // --- returning -------------------------------------------------------------------------------------------
  r = await kiosk.post("/kiosk/api/lookup", { name: "grace hoper" });
  const match = r.data.matches[0];
  check("kiosk: found again, typo and all", r.data.matches.length === 1 && match.firstName === "Grace" && match.companies[0].companyName === "Acme Corp" && match.companies[0].hostName === "Bobby Host", JSON.stringify(r));
  const keys = [...allKeys(r.data)].sort().join();
  check("kiosk: a lookup reveals only first name, companies and hosts, and what check-in still needs", keys === "citizenship,companies,companyId,companyName,firstName,hostId,hostName,matches,needs,organisation,ref", keys);
  check("kiosk: ...which for Grace is nothing", match.needs.organisation === false && match.needs.citizenship === false);
  check("kiosk: no surname, email or record id in it", !JSON.stringify(r.data).includes("Hopper") && !JSON.stringify(r.data).includes("navy") && !("id" in match));
  r = await kiosk.post("/kiosk/api/checkin", { ref: match.ref, companyId: acme.id, hostId: bob.id, purpose: "Meeting" });
  check("kiosk: checking in while already in says so", r.data.ok && r.data.already === true);
  r = await kiosk.post("/kiosk/api/checkin", { ref: "made-up", companyId: acme.id, purpose: "x" });
  check("kiosk: an unknown ref is refused", r.status === 409);

  // --- checking out -------------------------------------------------------------------------------------------
  r = await kiosk.post("/kiosk/api/checkout/lookup", { name: "Hopper Grace" });
  check("kiosk: check-out finds the open visit, company only", r.data.matches.length === 1 && r.data.matches[0].companyName === "Acme Corp" && [...allKeys(r.data)].sort().join() === "companyName,firstName,matches,ref");
  const outRef = r.data.matches[0].ref;
  check("kiosk: a visit ref can't be used to check in", (await kiosk.post("/kiosk/api/checkin", { ref: outRef, companyId: acme.id, purpose: "x" })).status === 409);
  r = await kiosk.post("/kiosk/api/checkout", { ref: outRef });
  check("kiosk: checks out", r.data.ok && r.data.firstName === "Grace");
  r = await admin.get("/api/visits");
  check("visits: closed at the kiosk", r.data.visits[0].checkoutMethod === "kiosk" && r.data.visits[0].checkedOutAt);
  check("kiosk: nothing left to check out", (await kiosk.post("/kiosk/api/checkout/lookup", { name: "Grace Hopper" })).data.matches.length === 0);

  // --- a second kiosk elsewhere ---------------------------------------------------------------------------------
  const riverKiosk = client({ kiosk: true });
  r = await admin.post("/api/kiosks", { name: "River iPad", siteId: river.id });
  await riverKiosk.post("/kiosk/api/pair", { code: r.data.code });
  r = await riverKiosk.post("/kiosk/api/lookup", { name: "Grace Hopper" });
  check("kiosk: at another site, a visitor is found but shows no companies from elsewhere", r.data.matches.length === 1 && r.data.matches[0].companies.length === 0);
  check("kiosk: a ref from one kiosk is no good at another", (await kiosk.post("/kiosk/api/checkin", { ref: r.data.matches[0].ref, companyId: acme.id, purpose: "x" })).status === 409);
  r = await riverKiosk.post("/kiosk/api/checkin", { ref: r.data.matches[0].ref, companyId: both.id, hostId: riverHost.id, purpose: "Site visit" });
  check("kiosk: and can check in there", r.data.ok && r.data.hostName === "Rae River");

  // --- staff ---------------------------------------------------------------------------------------------------------
  const pw = { desk: password(), viewer: password(), riverDesk: password() };
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "vic", password: pw.viewer, role: "viewer" });
  await admin.post("/api/users", { username: "riverdesk", password: pw.riverDesk, role: "frontdesk", sites: [river.id] });
  const desk = client();
  await desk.post("/api/auth/login", { username: "desk", password: pw.desk });
  const viewer = client();
  await viewer.post("/api/auth/login", { username: "vic", password: pw.viewer });
  const riverDesk = client();
  await riverDesk.post("/api/auth/login", { username: "riverdesk", password: pw.riverDesk });

  r = await desk.get("/api/config");
  check("staff: config carries who is in the building and how many to check", r.data.visits.here[river.id] === 1 && r.data.visits.review === 1);

  // --- kiosk visitors waiting for a badge (the banner) -------------------------------------------------
  pw.harbourDesk = password();
  await admin.post("/api/users", { username: "harbourdesk", password: pw.harbourDesk, role: "frontdesk", sites: [harbour.id] });
  const harbourDesk = client();
  await harbourDesk.post("/api/auth/login", { username: "harbourdesk", password: pw.harbourDesk });
  r = await desk.get("/api/visits/badge-needed");
  check("badge banner: a visitor who checked in at a kiosk is waiting for a badge", r.data.visits.length === 1 && r.data.visits[0].name === "Grace Hopper" && r.data.visits[0].kioskName === "River iPad" && r.data.visits[0].siteId === river.id && r.data.visits[0].companyName === "Both Partners");
  check("badge banner: shown to staff at that site", (await riverDesk.get("/api/visits/badge-needed")).data.visits.length === 1);
  check("badge banner: not to staff only at another site", (await harbourDesk.get("/api/visits/badge-needed")).data.visits.length === 0);
  check("badge banner: nor for another site chosen in the picker", (await desk.get(`/api/visits/badge-needed?site=${harbour.id}`)).data.visits.length === 0);
  check("badge banner: nor to anyone who can't give badges out", (await viewer.get("/api/visits/badge-needed")).status === 403);
  const walkIn = (await desk.post("/api/visitors", { firstName: "Wally", lastName: "Walkin" })).data.visitor;
  await desk.post("/api/visits", { visitorId: walkIn.id, siteId: river.id, companyId: both.id });
  check("badge banner: a desk check-in that skipped the ID check waits for one too", (await desk.get("/api/visits/badge-needed")).data.visits.some((v) => v.name === "Wally Walkin" && v.stage === "id"));
  const uncleared = (await admin.get("/api/clearance")).data.classifications.find((c) => !c.requiresClearance);
  const harbourBadge = (await admin.post("/api/badges", { number: "VH-1", type: "visitor", classificationId: uncleared.id, siteIds: [harbour.id] })).data.badge;
  const riverBadge = (await admin.post("/api/badges", { number: "VR-1", type: "visitor", classificationId: uncleared.id, siteIds: [river.id] })).data.badge;
  const graceWaiting = (await desk.get("/api/visits/badge-needed")).data.visits[0];
  r = await desk.get(`/api/badge-holders/visitor/${graceWaiting.visitorId}?site=${river.id}`);
  check("badge banner: the badges offered are those valid where they checked in", r.data.available.map((b) => b.number).join() === "VR-1" && harbourBadge.id);
  r = await desk.post(`/api/badges/${riverBadge.id}/assign`, { kind: "visitor", holderId: graceWaiting.visitorId, visitId: graceWaiting.visitId });
  check("badge banner: given a badge, they leave it", r.status === 200 && !(await desk.get("/api/visits/badge-needed")).data.visits.some((v) => v.name === "Grace Hopper"));
  await desk.post(`/api/badges/${riverBadge.id}/return`);
  await riverKiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Kay", lastName: "Kiosk", organisation: "Kiosk Co", citizenship: "Canada", visitorType: "Service Technician" }, companyId: both.id, purpose: "Fix the lift" });
  const kay = (await desk.get("/api/visits/badge-needed")).data.visits.find((v) => v.name === "Kay Kiosk");
  check("badge banner: a new kiosk visitor appears, waiting for their ID to be checked", Boolean(kay) && kay.stage === "id" && kay.visitorType === "Service Technician" && kay.purpose === "Fix the lift");
  check("badge banner: no badge is waived before their ID is checked", (await riverDesk.post(`/api/visits/${kay.visitId}/badge-not-needed`)).status === 409);
  check("id: checking it needs the point of contact, which Kay didn't give", (await riverDesk.post(`/api/visits/${kay.visitId}/verify-id`, { idType: "Passport" })).status === 400);
  check("id: and which ID it was", (await riverDesk.post(`/api/visits/${kay.visitId}/verify-id`, { idType: "Library card", hostId: riverHost.id })).status === 400);
  r = await riverDesk.post(`/api/visits/${kay.visitId}/verify-id`, { idType: "Passport", hostId: riverHost.id });
  check("id: checked, the visit goes on to its badge, with the contact filled in", r.status === 200 && r.data.visit.checkinStage === "badge" && r.data.visit.idType === "Passport" && r.data.visit.idVerifiedBy === "riverdesk" && r.data.visit.hostName === "Rae River", JSON.stringify(r.data));
  check("id: can be checked again before the badge", (await riverDesk.post(`/api/visits/${kay.visitId}/verify-id`, { idType: "State ID" })).data.visit?.idType === "State ID");
  check("badge banner: staff at another site can't mark them", (await harbourDesk.post(`/api/visits/${kay.visitId}/badge-not-needed`)).status === 404);
  check("badge banner: nor can someone who doesn't give badges out", (await viewer.post(`/api/visits/${kay.visitId}/badge-not-needed`)).status === 403);
  r = await riverDesk.post(`/api/visits/${kay.visitId}/badge-not-needed`);
  check("badge banner: marked as needing no badge, they leave it", r.status === 200 && !(await desk.get("/api/visits/badge-needed")).data.visits.some((v) => v.name === "Kay Kiosk"));
  check("badge banner: and it is in the audit log", (await admin.get("/api/audit?action=visit.badge_not_needed")).data.entries.some((e) => e.target === "Kay Kiosk"));
  check("badge banner: once only", (await riverDesk.post(`/api/visits/${kay.visitId}/badge-not-needed`)).status === 404);
  r = await desk.post("/api/visitors", { firstName: "Alan", lastName: "Turing", email: "alan@example.com", links: [{ companyId: acme.id, hostId: bob.id }] });
  check("staff: front desk adds a visitor with a company", r.status === 200 && r.data.visitor.companies[0].hostName === "Bobby Host" && r.data.visitor.verified === true);
  const alan = r.data.visitor;
  check("staff: a viewer can't add visitors", (await viewer.post("/api/visitors", { firstName: "X", lastName: "Y" })).status === 403);
  check("staff: a viewer can read them", (await viewer.get(`/api/visitors/${alan.id}`)).status === 200);
  r = await desk.post("/api/visits", { visitorId: alan.id, siteId: harbour.id, companyId: acme.id, hostId: bob.id, purpose: "Interview" });
  check("staff: checks a visitor in from the desk", r.status === 200 && r.data.visit.purpose === "Interview" && r.data.visit.checkedInBy === "desk");
  const alanVisit = r.data.visit;
  check("staff: a viewer can't check anyone out", (await viewer.post(`/api/visits/${alanVisit.id}/checkout`)).status === 403);
  check("staff: front desk at Riverside can't see Harbour Point's visits", !(await riverDesk.get("/api/visits?status=open")).data.visits.some((v) => v.siteId === harbour.id));
  check("staff: ...or check them out", (await riverDesk.post(`/api/visits/${alanVisit.id}/checkout`)).status === 404);
  check("staff: ...or see Alan, who has only been to Harbour Point", (await riverDesk.get(`/api/visitors/${alan.id}`)).status === 404);
  r = await riverDesk.get(`/api/visitors/${grace.id}`);
  check("staff: ...but sees Grace, who visited Riverside, without her Harbour Point company", r.status === 200 && r.data.visitor.companies.map((c) => c.companyName).join() === "Both Partners" && r.data.visits.every((v) => v.siteId === river.id));
  check("staff: ...and can't filter by a site it can't see", (await riverDesk.get(`/api/visits?site=${harbour.id}`)).status === 403);
  r = await desk.post(`/api/visits/${alanVisit.id}/checkout`);
  check("staff: checks a visitor out", r.data.visit.checkoutMethod === "staff" && r.data.visit.checkedOutBy === "desk");

  // links, field access, blocking, merging
  r = await desk.post(`/api/visitors/${alan.id}/links`, { companyId: both.id });
  check("links: a company is added", r.data.companies.length === 2);
  r = await desk.del(`/api/visitors/${alan.id}/links/${both.id}`);
  check("links: and removed", r.data.companies.length === 1);
  check("links: a host from another company is refused", (await desk.post(`/api/visitors/${alan.id}/links`, { companyId: acme.id, hostId: riverHost.id })).status === 400);
  await admin.put("/api/field-access", { changes: [{ roleId: "frontdesk", entity: "visitor", field: "email", access: "hidden" }] });
  r = await desk.get(`/api/visitors/${alan.id}`);
  check("access: a hidden visitor field is left out for front desk", r.status === 200 && !("email" in r.data.visitor));
  check("access: ...and a search can't find it", (await desk.get("/api/visitors?q=alan@example")).data.visitors.length === 0 && (await admin.get("/api/visitors?q=alan@example")).data.visitors.length === 1);
  check("access: ...and it can't be written", (await desk.put(`/api/visitors/${alan.id}`, { email: "x@y.example" })).status === 403);
  check("access: the last visit time can't be written by anyone", (await admin.put(`/api/visitors/${alan.id}`, { lastVisitAt: 1 })).status === 403);
  await desk.put(`/api/visitors/${grace.id}`, { blocked: true });
  r = await kiosk.post("/kiosk/api/lookup", { name: "Grace Hopper" });
  r = await kiosk.post("/kiosk/api/checkin", { ref: r.data.matches[0].ref, companyId: acme.id, purpose: "Meeting" });
  check("blocked: the kiosk sends a blocked visitor to reception, without a visit", r.data.ok === false && r.data.seeReception === true && !(await admin.get("/api/visits?status=open&site=" + harbour.id)).data.visits.some((v) => v.visitor.firstName === "Grace"));
  check("blocked: the desk is stopped too, unless a manager agreed", (await desk.post("/api/visits", { visitorId: grace.id, siteId: harbour.id, companyId: acme.id })).status === 409 && (await desk.post("/api/visits", { visitorId: grace.id, siteId: harbour.id, companyId: acme.id, overrideBlock: true })).status === 200);
  r = await admin.get("/api/audit?action=kiosk.blocked");
  check("blocked: the attempt is in the audit log", r.data.entries.length === 1);

  const dupe = (await kiosk.post("/kiosk/api/checkin", { visitor: { firstName: "Alan", lastName: "Turing", organisation: "Bletchley", citizenship: "GB", contact: "555-0199" }, companyId: acme.id, purpose: "Interview" })).data;
  r = await desk.get("/api/visitors?filter=review&q=Turing");
  const dupeId = r.data.visitors[0].id;
  r = await desk.post(`/api/visitors/${dupeId}/merge`, { intoId: alan.id });
  check("merge: a kiosk duplicate is merged into the real visitor", dupe.ok && r.status === 200 && (await admin.get(`/api/visitors/${alan.id}`)).data.visitor.phone === "555-0199" && (await admin.get(`/api/visitors/${dupeId}`)).status === 404);

  // --- settings, exports, revocation, limits ----------------------------------------------------------------------
  check("settings: visits settings are for administrators", (await desk.get("/api/settings/visits")).status === 403);
  r = await admin.put("/api/settings/visits", { retentionMonths: 6, kioskIdleSeconds: 30 });
  check("settings: retention and idle time are saved", r.data.retentionMonths === 6 && r.data.kioskIdleSeconds === 30 && (await kiosk.get("/kiosk/api/config")).data.idleSeconds === 30);
  r = await admin.get("/api/settings/visits/preview?months=1");
  check("settings: the preview answers before saving", r.status === 200 && r.data.wouldDelete.visits === 0);
  check("export: visits CSV is for administrators", (await desk.get("/api/visits.csv", { raw: true })).status === 403);
  const csv = await (await admin.get("/api/visits.csv", { raw: true })).text();
  check("export: visits CSV has the visits", csv.startsWith("checked_in,checked_out,site") && csv.includes("Turing") && csv.includes("Interview"));

  r = await admin.post(`/api/kiosks/${lobby.id}/code`);
  check("revoke: a new code signs the kiosk out at once", r.status === 200 && (await kiosk.get("/kiosk/api/config")).status === 401);
  check("revoke: removing a kiosk signs it out", (await admin.del(`/api/kiosks/${(await admin.get("/api/kiosks")).data.kiosks.find((k) => k.name === "River iPad").id}`)).status === 200 && (await riverKiosk.get("/kiosk/api/config")).status === 401);

  const busy = client({ kiosk: true });
  r = await admin.post("/api/kiosks", { name: "Busy iPad", siteId: harbour.id });
  await busy.post("/kiosk/api/pair", { code: r.data.code });
  let limited = false;
  for (let i = 0; i < 35 && !limited; i += 1) limited = (await busy.post("/kiosk/api/lookup", { name: `Someone Number${i}` })).status === 429;
  check("limits: name lookups are rate-limited per kiosk", limited);
  const pairer = client({ kiosk: true });
  let blocked = false;
  for (let i = 0; i < 12 && !blocked; i += 1) blocked = (await pairer.post("/kiosk/api/pair", { code: "ZZZZ-ZZZZ" })).status === 429;
  check("limits: guessing pairing codes is rate-limited", blocked);
}

main()
  .then(() => report())
  .catch((error) => {
    console.error(error);
    return false;
  })
  .then(async (ok) => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await exited;
    }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
    process.exit(ok ? 0 : 1);
  });
