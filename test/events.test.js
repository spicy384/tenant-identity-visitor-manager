/**
 * Badges and visitor events over HTTP: who may see and change badges, clearance fields
 * through the API, deleting someone who holds a badge, events and their guests, and an
 * expected guest at the kiosk.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Badges and visitor events over HTTP");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_EVENTS_PORT) || 3982;
const KIOSK_PORT = Number(process.env.TEST_EVENTS_KIOSK_PORT) || 3981;
const BASE = `http://127.0.0.1:${PORT}`;
const KBASE = `http://127.0.0.1:${KIOSK_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-events-"));
const password = () => crypto.randomBytes(12).toString("base64url");

function client({ kiosk = false } = {}) {
  const jar = {};
  let csrf = null;
  async function call(method, url, body) {
    const h = {};
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    if (kiosk && method !== "GET") h["x-kiosk-request"] = "1";
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch((kiosk ? KBASE : BASE) + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), KIOSK_PORT: String(KIOSK_PORT), DATA_DIR, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitFor(async () => (await fetch(`${BASE}/api/auth/me`)).ok)) || !(await waitFor(async () => (await fetch(`${KBASE}/kiosk/`)).ok))) {
    console.error(log);
    throw new Error("server did not start");
  }

  const admin = client();
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbour Point" });
  const site = (await admin.get("/api/config")).data.sites[0];
  await admin.put(`/api/sites/${site.id}`, { timeZone: "UTC" });
  const other = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: site.id }] })).data.company;
  let r = await admin.post("/api/companies", { name: "Harbour Security", buildingStaff: true, sites: [{ siteId: site.id }] });
  check("companies: building staff is set through the API", r.status === 200 && r.data.company.buildingStaff === true);
  const { levels, classifications } = (await admin.get("/api/clearance")).data;
  const L = Object.fromEntries(levels.map((l) => [l.name, l]));
  const cleared = classifications.find((c) => c.name === "Cleared");
  const uncleared = classifications.find((c) => c.name === "Uncleared");
  check("clearance: the levels end with TS//SCI FSP", levels.map((l) => l.name).join(",") === "Secret,TS,TS//SCI,TS//SCI CI,TS//SCI FSP");
  const host = (await admin.post("/api/people", { firstName: "Hana", lastName: "Host", companyId: acme.id })).data.person;
  r = await admin.post("/api/people", { firstName: "Tess", lastName: "Secret", companyId: acme.id, clearanceLevel: L.TS.id });
  check("people: a clearance can't be set in the record, even by an administrator", r.status === 403);
  r = await admin.post("/api/people", { firstName: "Tess", lastName: "Secret", companyId: acme.id });
  const tess = r.data.person;
  check("people: a new person's clearance is unvalidated", tess.clearanceStatus === "unvalidated");

  const pw = { desk: password(), viewer: password(), manager: password(), none: password(), river: password(), security: password() };
  await admin.post("/api/users", { username: "sec", password: pw.security, role: "security" });
  await admin.post("/api/roles", { name: "No badges", directory: "read", visitors: "read", badges: "none" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "vic", password: pw.viewer, role: "viewer" });
  await admin.post("/api/users", { username: "manny", password: pw.manager, role: "manager" });
  await admin.post("/api/users", { username: "nobadge", password: pw.none, role: "no-badges" });
  await admin.post("/api/users", { username: "river", password: pw.river, role: "frontdesk", sites: [other.id] });
  const as = async (u, p) => { const c = client(); await c.post("/api/auth/login", { username: u, password: p }); return c; };
  const desk = await as("desk", pw.desk);
  const viewer = await as("vic", pw.viewer);
  const manager = await as("manny", pw.manager);
  const nobadge = await as("nobadge", pw.none);
  const river = await as("river", pw.river);
  const security = await as("sec", pw.security);
  r = await security.post("/api/clearance/validate", { kind: "person", id: tess.id, levelId: L.TS.id, granted: "2025-05-01" });
  check("people: Security validates the clearance, with its name", r.status === 200 && (await admin.get(`/api/people/${tess.id}`)).data.person.clearanceLevelName === "TS");

  // --- clearance through the API ---------------------------------------------------------------
  check("clearance: front desk doesn't see a person's clearance by default", (await desk.get(`/api/people/${tess.id}`)).data.person.clearanceLevel === undefined);
  check("clearance: a manager sees it but can't change it", (await manager.get(`/api/people/${tess.id}`)).data.person.clearanceLevelName === "TS" && (await manager.put(`/api/people/${tess.id}`, { clearanceLevel: L["TS//SCI"].id })).status === 403);
  check("clearance: front desk can't change it", (await desk.put(`/api/people/${tess.id}`, { clearanceLevel: L.Secret.id })).status === 403);
  check("clearance: a manager can't validate", (await manager.post("/api/clearance/validate", { kind: "person", id: tess.id, levelId: L["TS//SCI"].id })).status === 403);
  check("clearance: Security re-validates at a new level", (await security.post("/api/clearance/validate", { kind: "person", id: tess.id, levelId: L["TS//SCI"].id, granted: "2025-05-01" })).status === 200);
  check("clearance: only administrators change the levels", (await manager.post("/api/clearance/levels", { name: "Q" })).status === 403);
  check("clearance: a level in use can't be removed", (await admin.del(`/api/clearance/levels/${L["TS//SCI"].id}`)).status === 409);

  // --- badges ------------------------------------------------------------------------------------
  check("badges: front desk can't add badges (only Security keeps the stock)", (await desk.post("/api/badges", { number: "T-099", type: "tenant", classificationId: cleared.id, clearanceLevelId: L.TS.id })).status === 403);
  r = await security.post("/api/badges", { number: "T-100", type: "tenant", classificationId: cleared.id, clearanceLevelId: L["TS//SCI"].id });
  check("badges: a manager can't either", (await manager.post("/api/badges", { number: "T-098", type: "tenant", classificationId: uncleared.id })).status === 403);
  check("badges: Security adds one, with its level", r.status === 200 && r.data.badge.clearanceLevelName === "TS//SCI");
  const sciBadge = r.data.badge;
  const tsBadge = (await security.post("/api/badges", { number: "T-101", type: "tenant", classificationId: cleared.id, clearanceLevelId: L.TS.id })).data.badge;
  const fspBadge = (await security.post("/api/badges", { number: "T-102", type: "tenant", classificationId: cleared.id, clearanceLevelId: L["TS//SCI FSP"].id })).data.badge;
  const riverBadge = (await admin.post("/api/badges", { number: "R-1", type: "tenant", classificationId: uncleared.id, siteIds: [other.id] })).data.badge;
  check("badges: a role without badge access sees none", (await nobadge.get("/api/badges")).status === 403);
  check("badges: a viewer sees them", (await viewer.get("/api/badges")).data.total === 4);
  check("badges: a viewer can't give one out", (await viewer.post(`/api/badges/${sciBadge.id}/assign`, { kind: "person", holderId: tess.id })).status === 403);
  r = await desk.post(`/api/badges/${fspBadge.id}/assign`, { kind: "person", holderId: tess.id });
  check("badges: someone whose clearance doesn't cover it is refused, without naming the level to front desk", r.status === 409 && /clearance doesn't cover/.test(r.data.error) && !/TS|FSP/.test(r.data.error));
  r = await desk.post(`/api/badges/${sciBadge.id}/assign`, { kind: "person", holderId: tess.id });
  check("badges: someone whose clearance covers it gets it", r.status === 200 && r.data.badge.holder.name === "Tess Secret" && r.data.badge.holder.assignedBy === "desk");
  r = await desk.get(`/api/badge-holders/person/${tess.id}`);
  check("holders: their badges and what else they could be given", r.data.current.map((a) => a.badgeNumber).join() === "T-100" && r.data.available.map((b) => b.number).sort().join() === "R-1,T-101");
  check("holders: a viewer sees their badges but isn't offered any", (await viewer.get(`/api/badge-holders/person/${tess.id}`)).data.available.length === 0);
  check("sites: a Riverside desk can't see Harbour Point's people to give them badges", (await river.post(`/api/badges/${riverBadge.id}/assign`, { kind: "person", holderId: tess.id })).status === 404);
  const harbourOnly = (await admin.post("/api/badges", { number: "H-1", type: "tenant", classificationId: uncleared.id, siteIds: [site.id] })).data.badge;
  check("sites: nor badges valid only at Harbour Point", (await river.get(`/api/badges/${harbourOnly.id}`)).status === 404 && (await river.get(`/api/badges/${sciBadge.id}`)).status === 200);
  const both = (await admin.post("/api/badges", { number: "B-1", type: "tenant", classificationId: uncleared.id, siteIds: [site.id, other.id] })).data.badge;
  check("sites: a badge valid at both sites is seen at both", both.sites.length === 2 && (await river.get(`/api/badges/${both.id}`)).status === 200);
  r = await admin.post(`/api/badges/${riverBadge.id}/assign`, { kind: "person", holderId: tess.id });
  check("sites: a Riverside badge can go to someone who works at Harbour Point", r.status === 200);
  await admin.post(`/api/badges/${riverBadge.id}/return`);
  check("delete: someone holding a badge can't be deleted", (await admin.del(`/api/people/${tess.id}`)).status === 409);
  check("delete: nor their company", (await admin.del(`/api/companies/${acme.id}`)).status === 409);
  r = await desk.post(`/api/badges/${sciBadge.id}/return`, { note: "left the company" });
  check("return: taken back", r.status === 200 && !r.data.badge.holder);
  r = await desk.get(`/api/badges/${sciBadge.id}`);
  check("history: the badge's history shows who had it", r.data.history.length === 1 && r.data.history[0].holderName === "Tess Secret" && r.data.history[0].returnedBy === "desk");
  check("audit: giving and taking back are recorded", (await admin.get("/api/audit?action=badge.")).data.entries.some((e) => e.action === "badge.assign") && (await admin.get("/api/audit?action=badge.")).data.entries.some((e) => e.action === "badge.return"));
  void tsBadge;

  // --- events and the kiosk --------------------------------------------------------------------------
  const day = new Date().toISOString().slice(0, 10);
  check("events: a viewer can't add one", (await viewer.post("/api/events", { siteId: site.id, title: "X", date: day })).status === 403);
  r = await desk.post("/api/events", { siteId: site.id, title: "Board meeting", date: day, startTime: "09:00", companyId: acme.id, hostId: host.id });
  check("events: front desk adds one", r.status === 200 && r.data.event.hostName === "Hana Host");
  const meeting = r.data.event;
  r = await desk.post(`/api/events/${meeting.id}/guests`, { visitor: { firstName: "Grace", lastName: "Hopper", organisation: "Navy" } });
  check("guests: someone new is added as a visitor, linked to the company and host", r.status === 200 && r.data.event.guests[0].status === "expected");
  const graceId = r.data.event.guests[0].visitorId;
  const grace = (await admin.get(`/api/visitors/${graceId}`)).data.visitor;
  r = await desk.post(`/api/events/${meeting.id}/guests`, { visitor: { firstName: "grace", lastName: "hopper" } });
  check("guests: adding someone new who is already on record asks first", r.status === 409 && r.data.error.startsWith("Already on record: Grace Hopper (Navy)"), r.data.error);
  r = await desk.post(`/api/events/${meeting.id}/guests`, { visitor: { firstName: "Grace", lastName: "Hopper" }, addAnyway: true });
  check("guests: ...and adds them anyway when told to", r.status === 200 && r.data.event.guests.length === 2);
  await desk.del(`/api/events/${meeting.id}/guests/${r.data.event.guests.find((g) => g.visitorId !== graceId).visitorId}`);
  await admin.del(`/api/visitors/${r.data.event.guests.find((g) => g.visitorId !== graceId).visitorId}`);
  check("guests: the new visitor is checked and linked", grace.verified === true && grace.companies[0].hostName === "Hana Host");
  r = await desk.get(`/api/events?date=${day}`);
  check("expected: today's events with their guests", r.data.events.length === 1 && r.data.events[0].guests.length === 1);
  check("expected: counted for the navigation", (await desk.get("/api/visits/summary")).data.expected === 1);

  // A second company, so the kiosk has a choice to skip.
  const beta = (await admin.post("/api/companies", { name: "Beta LLC", sites: [{ siteId: site.id }] })).data.company;
  await admin.post(`/api/visitors/${graceId}/links`, { companyId: beta.id });
  const kiosk = client({ kiosk: true });
  const code = (await admin.post("/api/kiosks", { name: "Lobby", siteId: site.id })).data.code;
  await kiosk.post("/kiosk/api/pair", { code });
  r = await kiosk.post("/kiosk/api/lookup", { name: "Grace Hopper" });
  const match = r.data.matches[0];
  check("kiosk: an expected guest is offered their event's company and host first", match.companies[0].expected === true && match.companies[0].companyName === "Acme Corp" && match.companies[0].hostName === "Hana Host");
  check("kiosk: listed once, not twice", match.companies.filter((c) => c.companyId === acme.id).length === 1 && match.companies.length === 2);
  r = await kiosk.post("/kiosk/api/checkin", { ref: match.ref, companyId: acme.id, hostId: host.id, purpose: "Meeting", details: { organisation: "Navy", citizenship: "US" } });
  check("kiosk: checks in", r.data.ok);
  r = await desk.get(`/api/events?date=${day}`);
  check("expected: the guest shows as here", r.data.events[0].guests[0].status === "here");
  check("expected: no one left to expect", (await desk.get("/api/visits/summary")).data.expected === 0);

  // A visitor badge with the check-in, which stays out after they leave.
  const vBadge = (await security.post("/api/badges", { number: "V-1", type: "visitor", classificationId: uncleared.id })).data.badge;
  const visit = (await desk.get("/api/visits?status=open")).data.visits[0];
  r = await desk.post(`/api/badges/${vBadge.id}/assign`, { kind: "visitor", holderId: graceId, visitId: visit.id });
  check("visitor badge: given with the visit", r.status === 200 && r.data.badge.holder.visitId === visit.id);
  await desk.post(`/api/visits/${visit.id}/checkout`);
  check("visitor badge: still out after check-out", Boolean((await desk.get(`/api/badges/${vBadge.id}`)).data.badge.holder));
  check("visitor badge: counted as out with someone who has left", (await desk.get("/api/visits/summary")).data.badgesLeft === 1 && (await desk.get("/api/badges?state=left")).data.badges[0].number === "V-1");
  check("delete: a visitor holding a badge can't be deleted", (await admin.del(`/api/visitors/${graceId}`)).status === 409);
  await desk.post(`/api/badges/${vBadge.id}/return`);
  check("visitor badge: taken back, the count clears", (await desk.get("/api/visits/summary")).data.badgesLeft === 0);

  // A temporary badge for someone who forgot theirs.
  const own = (await security.post("/api/badges", { number: "T-200", type: "tenant", classificationId: uncleared.id })).data.badge;
  const tmp = (await security.post("/api/badges", { number: "TMP-1", type: "tenant", classificationId: uncleared.id, temporary: true })).data.badge;
  r = await desk.get(`/api/badge-holders/person/${host.id}`);
  check("temporary: not offered to someone without a badge", r.data.temporary.length === 0 && !r.data.available.some((b) => b.number === "TMP-1"));
  await desk.post(`/api/badges/${own.id}/assign`, { kind: "person", holderId: host.id });
  r = await desk.get(`/api/badge-holders/person/${host.id}`);
  check("temporary: offered once they hold one", r.data.temporary.map((b) => b.number).join() === "TMP-1");
  r = await desk.post(`/api/badges/${tmp.id}/assign`, { kind: "person", holderId: host.id, replacesBadgeId: own.id });
  check("temporary: lent for the day, in place of their badge", r.status === 200 && r.data.badge.holder.temporary && r.data.badge.holder.replacesNumber === "T-200" && r.data.badge.holder.dueAt > Date.now());
  check("temporary: the loan is in the audit log", (await admin.get("/api/audit?action=badge.assign")).data.entries.some((e) => /temporary, in place of T-200/.test(e.detail)));
  check("temporary: not overdue yet", (await desk.get("/api/visits/summary")).data.tempOverdue === 0 && (await desk.get("/api/badges?state=temporary")).data.total === 1);
  await desk.post(`/api/badges/${tmp.id}/return`);
  check("temporary: back, nothing out", (await desk.get("/api/badges?state=temporary")).data.total === 0);
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
