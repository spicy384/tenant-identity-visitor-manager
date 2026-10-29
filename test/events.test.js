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
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbor Point" });
  const site = (await admin.get("/api/config")).data.sites[0];
  await admin.put(`/api/sites/${site.id}`, { timeZone: "UTC" });
  const other = (await admin.post("/api/sites", { name: "Riverside", timeZone: "UTC" })).data.site;
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", sites: [{ siteId: site.id }] })).data.company;
  let r = await admin.post("/api/companies", { name: "Harbor Security", buildingStaff: true, sites: [{ siteId: site.id }] });
  check("companies: building staff is set through the API", r.status === 200 && r.data.company.buildingStaff === true);
  const { levels } = (await admin.get("/api/clearance")).data;
  const L = Object.fromEntries(levels.map((l) => [l.name, l]));
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
  check("badges: front desk can't add badges (only Security keeps the stock)", (await desk.post("/api/badges", { number: "T-099", type: "tenant", clearanceLevelId: L.TS.id })).status === 403);
  r = await security.post("/api/badges", { number: "T-100", type: "tenant", clearanceLevelId: L["TS//SCI"].id });
  check("badges: a manager can't either", (await manager.post("/api/badges", { number: "T-098", type: "tenant" })).status === 403);
  check("badges: Security adds one, with its level", r.status === 200 && r.data.badge.clearanceLevelName === "TS//SCI");
  const sciBadge = r.data.badge;
  const tsBadge = (await security.post("/api/badges", { number: "T-101", type: "tenant", clearanceLevelId: L.TS.id })).data.badge;
  const fspBadge = (await security.post("/api/badges", { number: "T-102", type: "tenant", clearanceLevelId: L["TS//SCI FSP"].id })).data.badge;
  const riverBadge = (await admin.post("/api/badges", { number: "R-1", type: "tenant", siteIds: [other.id] })).data.badge;
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
  check("sites: a Riverside desk can't see Harbor Point's people to give them badges", (await river.post(`/api/badges/${riverBadge.id}/assign`, { kind: "person", holderId: tess.id })).status === 404);
  const harborOnly = (await admin.post("/api/badges", { number: "H-1", type: "tenant", siteIds: [site.id] })).data.badge;
  check("sites: nor badges valid only at Harbor Point", (await river.get(`/api/badges/${harborOnly.id}`)).status === 404 && (await river.get(`/api/badges/${sciBadge.id}`)).status === 200);
  const both = (await admin.post("/api/badges", { number: "B-1", type: "tenant", siteIds: [site.id, other.id] })).data.badge;
  check("sites: a badge valid at both sites is seen at both", both.sites.length === 2 && (await river.get(`/api/badges/${both.id}`)).status === 200);
  r = await admin.post(`/api/badges/${riverBadge.id}/assign`, { kind: "person", holderId: tess.id });
  check("sites: a Riverside badge can go to someone who works at Harbor Point", r.status === 200);
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
  r = await desk.post(`/api/events/${meeting.id}/guests`, { visitor: { firstName: "Grace", lastName: "Hopper", organization: "Navy" } });
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
  r = await kiosk.post("/kiosk/api/checkin", { ref: match.ref, companyId: acme.id, hostId: host.id, purpose: "Meeting", details: { organization: "Navy", citizenship: "US" } });
  check("kiosk: checks in", r.data.ok);
  r = await desk.get(`/api/events?date=${day}`);
  check("expected: the guest shows as here", r.data.events[0].guests[0].status === "here");
  check("expected: no one left to expect", (await desk.get("/api/visits/summary")).data.expected === 0);

  // A visitor badge with the check-in, which stays out after they leave.
  const vBadge = (await security.post("/api/badges", { number: "V-1", type: "visitor" })).data.badge;
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
  const own = (await security.post("/api/badges", { number: "T-200", type: "tenant" })).data.badge;
  const tmp = (await security.post("/api/badges", { number: "TMP-1", type: "tenant", temporary: true })).data.badge;
  r = await desk.get(`/api/badge-holders/person/${host.id}`);
  check("temporary: offered to lend, not to give for good", r.data.temporary.some((b) => b.number === "TMP-1") && !r.data.available.some((b) => b.number === "TMP-1"));
  await desk.post(`/api/badges/${own.id}/assign`, { kind: "person", holderId: host.id });
  r = await desk.get(`/api/badge-holders/person/${host.id}`);
  check("temporary: the temporary stock offered first, then visitor badges", r.data.temporary[0].number === "TMP-1" && r.data.temporary.slice(1).every((b) => b.type === "visitor"));
  r = await desk.post(`/api/badges/${tmp.id}/assign`, { kind: "person", holderId: host.id, replacesBadgeId: own.id });
  check("temporary: lent for the day, in place of their badge", r.status === 200 && r.data.badge.holder.temporary && r.data.badge.holder.replacesNumber === "T-200" && r.data.badge.holder.dueAt > Date.now());
  check("temporary: the loan is in the audit log", (await admin.get("/api/audit?action=badge.assign")).data.entries.some((e) => /lent for the day, in place of T-200/.test(e.detail)));
  check("temporary: not overdue yet", (await desk.get("/api/visits/summary")).data.tempOverdue === 0 && (await desk.get("/api/badges?state=temporary")).data.total === 1);
  await desk.post(`/api/badges/${tmp.id}/return`);
  check("temporary: back, nothing out", (await desk.get("/api/badges?state=temporary")).data.total === 0);
  // Or a visitor badge, lent the same way.
  const vLend = (await security.post("/api/badges", { number: "V-LEND", type: "visitor" })).data.badge;
  r = await desk.post(`/api/badges/${vLend.id}/assign`, { kind: "person", holderId: host.id });
  check("temporary: a visitor badge lent to a tenant for the day", r.status === 200 && r.data.badge.holder.temporary && r.data.badge.holder.replacesNumber === "T-200"
    && (await desk.get("/api/badges?state=temporary")).data.badges.map((b) => b.number).join() === "V-LEND");
  await desk.post(`/api/badges/${vLend.id}/return`);

  // --- repeating events -------------------------------------------------------------------------------
  const { datesOf, cleanRule } = require("../events");
  const dates = (rule, start) => datesOf(cleanRule(rule, start), start).join();
  check("repeat: every other week on Tuesday and Thursday", dates({ freq: "weekly", interval: 2, days: [2, 4], until: "2026-11-21" }, "2026-10-27") === "2026-10-27,2026-10-29,2026-11-10,2026-11-12");
  check("repeat: every weekday", dates({ freq: "weekdays", until: "2026-11-03" }, "2026-10-30") === "2026-10-30,2026-11-02,2026-11-03");
  check("repeat: monthly on the second Tuesday", dates({ freq: "monthly", by: "weekday", until: "2027-01-31" }, "2026-10-13") === "2026-10-13,2026-11-10,2026-12-08,2027-01-12");
  check("repeat: monthly on the last Friday", dates({ freq: "monthly", by: "weekday", until: "2026-12-31" }, "2026-10-30") === "2026-10-30,2026-11-27,2026-12-25");
  check("repeat: monthly on day 31 skips the shorter months", dates({ freq: "monthly", by: "date", until: "2027-03-31" }, "2026-10-31") === "2026-10-31,2026-12-31,2027-01-31,2027-03-31");
  let tooLong = null;
  try { cleanRule({ freq: "daily", until: "2027-10-28" }, "2026-10-27"); } catch (error) { tooLong = error; }
  check("repeat: for at most a year", tooLong?.status === 400 && cleanRule({ freq: "daily", until: "2027-10-27" }, "2026-10-27").until === "2027-10-27");

  r = await desk.post("/api/events", { siteId: site.id, title: "Standup", date: "2099-03-01", startTime: "09:00", companyId: acme.id, hostId: host.id, repeat: { freq: "daily", until: "2099-03-05" } });
  check("series: one event a date", r.status === 200 && r.data.event.count === 5 && r.data.event.seriesId === r.data.event.id && r.data.event.repeatText === "Every day, until 2099-03-05", JSON.stringify(r.data));
  check("series: not more than a year ahead", (await desk.post("/api/events", { siteId: site.id, title: "Too long", date: "2099-03-01", repeat: { freq: "daily", until: "2100-03-02" } })).status === 400);
  const standup = r.data.event;
  const series = async () => (await desk.get("/api/events?from=2099-03-01&to=2099-03-31")).data.events.filter((e) => e.seriesId === standup.id);
  r = await desk.post(`/api/events/${standup.id}/guests`, { visitor: { firstName: "Ada", lastName: "Lovelace", organization: "Engines" }, scope: "following" });
  const ada = r.data.event.guests[0].visitorId;
  let list = await series();
  check("series: a guest added at the start is expected on every date", list.length === 5 && list.every((e) => e.guests.some((g) => g.visitorId === ada)));
  const third = list[2];
  r = await desk.put(`/api/events/${third.id}`, { title: "Standup B", startTime: "09:30", scope: "following" });
  list = await series();
  check("series: a change to a date and the later ones", r.data.event.count === 3 && list.map((e) => e.title).join() === "Standup,Standup,Standup B,Standup B,Standup B" && list[4].startTime === "09:30" && list[1].startTime === "09:00");
  check("series: the later ones keep their dates", list.map((e) => e.date.slice(-2)).join() === "01,02,03,04,05");
  await desk.put(`/api/events/${list[1].id}`, { date: "2099-03-10", scope: "one" });
  list = await series();
  check("series: a date moved alone", list.map((e) => e.date.slice(-2)).join() === "01,03,04,05,10");
  r = await desk.post(`/api/events/${list[2].id}/guests`, { visitor: { firstName: "Alan", lastName: "Turing" } });
  const alan = r.data.event.guests.find((g) => g.lastName === "Turing").visitorId;
  list = await series();
  check("series: a guest added to one date only", list.filter((e) => e.guests.some((g) => g.visitorId === alan)).map((e) => e.date).join() === "2099-03-04");
  await desk.del(`/api/events/${list[2].id}/guests/${ada}?scope=following`);
  list = await series();
  check("series: a guest taken off a date and the later ones", list.filter((e) => e.guests.some((g) => g.visitorId === ada)).map((e) => e.date.slice(-2)).join() === "01,03");
  r = await desk.del(`/api/events/${list[3].id}?scope=following`);
  list = await series();
  check("series: a date and the later ones canceled", r.data.count === 2 && list.map((e) => e.date.slice(-2)).join() === "01,03,04");
  r = await desk.del(`/api/events/${list[0].id}`);
  check("series: one date canceled alone", r.data.count === 1 && (await series()).length === 2);
  check("series: in the audit log", (await admin.get("/api/audit?action=event.add")).data.entries.some((e) => /every day, until 2099-03-05 \(5 dates\)/.test(e.detail)));

  // A guest who came stays on that date; they can only be taken off the later ones.
  check("remove: a guest who came stays on a one-off event", (await desk.del(`/api/events/${meeting.id}/guests/${graceId}`)).status === 409
    && (await desk.get(`/api/events/${meeting.id}`)).data.event.guests.some((g) => g.visitorId === graceId));
  const soon = (n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  r = await desk.post("/api/events", { siteId: site.id, title: "Daily walk-through", date: day, companyId: acme.id, hostId: host.id, repeat: { freq: "daily", until: soon(2) } });
  const walk = r.data.event;
  await desk.post(`/api/events/${walk.id}/guests`, { visitorId: graceId, scope: "following" });
  const walks = async () => (await desk.get(`/api/events?from=${day}&to=${soon(2)}`)).data.events.filter((e) => e.seriesId === walk.id);
  r = await desk.post("/api/checkins", { visitorId: graceId, siteId: site.id, hostId: host.id, purpose: "Walk-through", idType: "Passport" });
  check("remove: she came to today's walk-through", r.status === 200 && (await walks())[0].guests.find((g) => g.visitorId === graceId)?.status === "here", JSON.stringify(r.data));
  check("remove: not from today's, where she came", (await desk.del(`/api/events/${walk.id}/guests/${graceId}?scope=one`)).status === 409);
  r = await desk.del(`/api/events/${walk.id}/guests/${graceId}?scope=following`);
  const after = await walks();
  check("remove: from the later dates, keeping today's", r.status === 200 && after.length === 3 && after[0].guests.some((g) => g.visitorId === graceId) && after.slice(1).every((e) => !e.guests.some((g) => g.visitorId === graceId)));
  check("remove: in the audit log, saying she came", (await admin.get("/api/audit?action=event.guest_remove")).data.entries.some((e) => e.target === "Daily walk-through" && /the dates after .+ \(came on it\)/.test(e.detail)));
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
