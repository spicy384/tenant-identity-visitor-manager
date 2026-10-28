/**
 * Checking a visitor in at the desk, step by step, over HTTP: visitor type and citizenship
 * on the record, the desk's check-in with the ID checked, the ID step for kiosk arrivals,
 * the badge step (the badge picked for an event, or reserved for a regular, or typed in),
 * and who may do each.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Checking visitors in at the desk");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_CHECKIN_PORT) || 3995;
const KIOSK_PORT = Number(process.env.TEST_CHECKIN_KIOSK_PORT) || 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const KBASE = `http://127.0.0.1:${KIOSK_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-checkin-"));
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
  const mgmt = (await admin.post("/api/companies", { name: "Harbor Management", buildingStaff: true, sites: [{ siteId: site.id }] })).data.company;
  const host = (await admin.post("/api/people", { firstName: "Hana", lastName: "Host", companyId: acme.id, phone: "555-0100" })).data.person;
  const facilities = (await admin.post("/api/people", { firstName: "Fred", lastName: "Fixit", companyId: mgmt.id, canHost: false })).data.person;

  const pw = { desk: password(), viewer: password(), security: password() };
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "vic", password: pw.viewer, role: "viewer" });
  await admin.post("/api/users", { username: "sec", password: pw.security, role: "security" });
  const as = async (u, p) => { const c = client(); await c.post("/api/auth/login", { username: u, password: p }); return c; };
  const desk = await as("desk", pw.desk);
  const viewer = await as("vic", pw.viewer);
  const security = await as("sec", pw.security);

  // --- the record: visitor type and citizenship -------------------------------------------------
  let r = await desk.get("/api/config");
  check("config: the countries and the IDs the desk checks", r.data.checkin.countries.length > 200 && r.data.checkin.countries.some((c) => c.code === "US") && r.data.checkin.idTypes.includes("Passport"));
  check("record: citizenship must be a country", (await desk.post("/api/visitors", { firstName: "A", lastName: "B", citizenship: "Narnia" })).status === 400);
  check("record: the visitor type is Guest or Service Technician", (await desk.post("/api/visitors", { firstName: "A", lastName: "B", visitorType: "Plumber" })).status === 400);
  r = await desk.post("/api/visitors", { firstName: "Ann", lastName: "Arrival", organization: "Arrival Ltd", citizenship: "united kingdom" });
  const ann = r.data.visitor;
  check("record: a country by name is kept as its code, and the type starts as Guest", r.status === 200 && ann.citizenship === "GB" && ann.visitorType === "Guest", JSON.stringify(r.data));
  const tech = (await desk.post("/api/visitors", { firstName: "Tom", lastName: "Tech", organization: "Lift Co", citizenship: "US", visitorType: "Service Technician" })).data.visitor;
  check("record: a service technician", tech.visitorType === "Service Technician" && tech.citizenship === "US");
  const bare = (await desk.post("/api/visitors", { firstName: "Ben", lastName: "Bare" })).data.visitor;

  // --- the desk checks someone in ---------------------------------------------------------------
  const base = { visitorId: ann.id, siteId: site.id, hostId: host.id, purpose: "Quarterly review", idType: "Driver's license" };
  check("desk: a viewer can't check anyone in", (await viewer.post("/api/checkins", base)).status === 403);
  check("desk: the company and citizenship must be on record first", (await desk.post("/api/checkins", { ...base, visitorId: bare.id })).status === 400);
  check("desk: what the visit is for is needed", (await desk.post("/api/checkins", { ...base, purpose: "" })).status === 400);
  check("desk: so is the point of contact", (await desk.post("/api/checkins", { ...base, hostId: null })).status === 400);
  check("desk: and which ID was checked", (await desk.post("/api/checkins", { ...base, idType: undefined })).status === 400 && (await desk.post("/api/checkins", { ...base, idType: "Gym card" })).status === 400
    && (await desk.post("/api/checkins", { ...base, idType: "Other government ID" })).status === 400);
  r = await desk.post("/api/checkins", base);
  const annVisit = r.data.visit;
  check("desk: checked in, the company from the contact, the ID on record, waiting for a badge", r.status === 200 && annVisit.companyName === "Acme Corp" && annVisit.hostName === "Hana Host"
    && annVisit.checkinStage === "badge" && annVisit.idType === "Driver's license" && annVisit.idVerifiedBy === "desk" && annVisit.visitorType === "Guest" && annVisit.purpose === "Quarterly review", JSON.stringify(r.data));
  check("desk: and in the audit log, which ID but no number", (await admin.get("/api/audit?action=visit.checkin")).data.entries.some((e) => e.target === "Ann Arrival" && /ID checked \(Driver's license\)/.test(e.detail)));
  check("desk: on the list waiting for a badge", (await desk.get("/api/visits/badge-needed")).data.visits.some((v) => v.visitId === annVisit.id && v.stage === "badge"));
  r = await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "Passport", purpose: "Quarterly review and lunch" });
  check("id: back a step before the badge, the ID is checked again and the purpose changed", r.status === 200 && r.data.visit.checkinStage === "badge" && r.data.visit.idType === "Passport" && r.data.visit.purpose === "Quarterly review and lunch", JSON.stringify(r.data));
  check("id: the audit log says it was checked again", (await admin.get("/api/audit?action=visit.id_checked")).data.entries.some((e) => e.target === "Ann Arrival" && e.detail.includes("checked again (was Driver's license)")));
  // An Other government ID: the desk says what it was.
  check("id: an other government ID needs saying what it was", (await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "Other government ID" })).status === 400
    && (await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "Other government ID", idOther: "   " })).status === 400);
  r = await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "Other government ID", idOther: "  Military   ID " });
  check("id: what it was is kept with the visit", r.status === 200 && r.data.visit.idType === "Other government ID" && r.data.visit.idOther === "Military ID", JSON.stringify(r.data));
  check("id: and written in the audit log", (await admin.get("/api/audit?action=visit.id_checked")).data.entries.some((e) => e.target === "Ann Arrival" && e.detail.includes("Other government ID: Military ID")));
  r = await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "Passport", idOther: "ignored" });
  check("id: another type drops it", r.data.visit.idType === "Passport" && r.data.visit.idOther === null
    && (await admin.get("/api/audit?action=visit.id_checked")).data.entries.some((e) => e.target === "Ann Arrival" && e.detail.includes("checked again (was Other government ID: Military ID)")));

  // A service technician: the point of contact can be anyone in the directory, not only hosts.
  r = await desk.post("/api/checkins", { visitorId: tech.id, siteId: site.id, hostId: facilities.id, purpose: "Lift service", idType: "State ID" });
  const techVisit = r.data.visit;
  check("technician: anyone in the directory can be their contact, the visit going to that company", r.status === 200 && techVisit.companyName === "Harbor Management" && techVisit.visitorType === "Service Technician", JSON.stringify(r.data));

  // --- the badge step ---------------------------------------------------------------------------
  const v1 = (await security.post("/api/badges", { number: "V-1", type: "visitor" })).data.badge;
  const v2 = (await security.post("/api/badges", { number: "V-2", type: "visitor" })).data.badge;
  const v3 = (await security.post("/api/badges", { number: "V-3", type: "visitor" })).data.badge;
  const vRiver = (await security.post("/api/badges", { number: "VR-9", type: "visitor", siteIds: [other.id] })).data.badge;
  const tenantBadge = (await security.post("/api/badges", { number: "T-1", type: "tenant" })).data.badge;
  r = await desk.get(`/api/visits/${annVisit.id}/badge-plan`);
  check("plan: nothing kept for Ann, the visitor badges valid here on offer", r.status === 200 && r.data.assigned === null && r.data.available.map((b) => b.number).join() === "V-1,V-2,V-3" && r.data.holding.length === 0, JSON.stringify(r.data));
  check("plan: not for a viewer", (await viewer.get(`/api/visits/${annVisit.id}/badge-plan`)).status === 403);
  check("badge: a number that isn't a badge", (await desk.post(`/api/visits/${annVisit.id}/badge`, { number: "V-99" })).status === 404);
  check("badge: a tenant badge isn't for visitors", (await desk.post(`/api/visits/${annVisit.id}/badge`, { number: "T-1" })).status === 400 && tenantBadge.id);
  check("badge: one valid only at another site", (await desk.post(`/api/visits/${annVisit.id}/badge`, { number: "VR-9" })).status === 400 && vRiver.id);
  check("badge: nothing typed", (await desk.post(`/api/visits/${annVisit.id}/badge`, { number: "  " })).status === 400);
  r = await desk.post(`/api/visits/${annVisit.id}/badge`, { number: "v-1" });
  check("badge: typed in (any case), given, and the check-in is done", r.status === 200 && r.data.badge.number === "V-1" && r.data.badge.holder.visitId === annVisit.id
    && (await desk.get(`/api/visits?status=open`)).data.visits.find((v) => v.id === annVisit.id).checkinStage === "done"
    && !(await desk.get("/api/visits/badge-needed")).data.visits.some((v) => v.visitId === annVisit.id));
  check("badge: the visit is done, so there's no more badge step for it", (await desk.post(`/api/visits/${annVisit.id}/badge`, { badgeId: v2.id })).status === 409 && (await desk.get(`/api/visits/${annVisit.id}/badge-plan`)).status === 409);
  check("id: once the badge is given, the check-in stands", (await desk.post(`/api/visits/${annVisit.id}/verify-id`, { idType: "CAC" })).status === 409);
  check("badge: a badge that's out is refused", (await desk.post(`/api/visits/${techVisit.id}/badge`, { badgeId: v1.id })).status === 409);

  // --- a badge reserved for a regular -----------------------------------------------------------
  check("reserve: only a visitor badge", (await desk.put(`/api/visitors/${tech.id}/reserved-badge`, { badgeId: tenantBadge.id })).status === 400);
  check("reserve: not by a viewer", (await viewer.put(`/api/visitors/${tech.id}/reserved-badge`, { badgeId: v3.id })).status === 403);
  r = await desk.put(`/api/visitors/${tech.id}/reserved-badge`, { badgeId: v3.id });
  check("reserve: V-3 is kept for Tom", r.status === 200 && r.data.reservedBadge.number === "V-3" && (await desk.get(`/api/visitors/${tech.id}`)).data.visitor.reservedBadge.number === "V-3");
  check("reserve: for one visitor at a time", (await desk.put(`/api/visitors/${ann.id}/reserved-badge`, { badgeId: v3.id })).status === 409);
  check("reserve: nobody else is offered it, or can be given it", !(await desk.get(`/api/badge-holders/visitor/${bare.id}`)).data.available.some((b) => b.number === "V-3")
    && (await desk.post(`/api/badges/${v3.id}/assign`, { kind: "visitor", holderId: bare.id })).status === 409);
  r = await desk.get(`/api/visits/${techVisit.id}/badge-plan`);
  check("plan: Tom is to be handed his reserved badge", r.data.assigned && r.data.assigned.number === "V-3" && r.data.assigned.source === "reserved" && r.data.assigned.problem === null, JSON.stringify(r.data));
  check("plan: his badge is the one on offer to him too", r.data.available.some((b) => b.number === "V-3"));
  r = await desk.post(`/api/visits/${techVisit.id}/badge`, { badgeId: v3.id });
  check("reserve: handed over, and still his", r.status === 200 && (await desk.get(`/api/visitors/${tech.id}`)).data.visitor.reservedBadge.number === "V-3");
  await desk.post(`/api/visits/${techVisit.id}/checkout`);
  await desk.post(`/api/badges/${v3.id}/return`);
  check("reserve: back in stock after the visit, still kept for him", !(await desk.get(`/api/badges/${v3.id}`)).data.badge.holder && (await desk.get(`/api/visitors/${tech.id}`)).data.visitor.reservedBadge.number === "V-3");
  r = await desk.put(`/api/visitors/${tech.id}/reserved-badge`, { badgeId: null });
  check("reserve: released", r.status === 200 && r.data.reservedBadge === null);
  check("reserve: in the audit log", (await admin.get("/api/audit?action=visitor.reserved_badge")).data.entries.length === 2);

  // --- a badge picked for an expected guest --------------------------------------------------------
  const day = new Date().toISOString().slice(0, 10);
  const event = (await desk.post("/api/events", { siteId: site.id, title: "Board meeting", date: day, companyId: acme.id, hostId: host.id })).data.event;
  r = await desk.post(`/api/events/${event.id}/guests`, { visitor: { firstName: "Gail", lastName: "Guest", organization: "Guest Co", citizenship: "CA" } });
  const gail = r.data.event.guests.find((g) => g.lastName === "Guest");
  check("event: a new guest with their citizenship", (await desk.get(`/api/visitors/${gail.visitorId}`)).data.visitor.citizenship === "CA");
  check("event: a badge valid at another site can't be picked", (await desk.put(`/api/events/${event.id}/guests/${gail.visitorId}/badge`, { badgeId: vRiver.id })).status === 400);
  check("event: nor a viewer pick one", (await viewer.put(`/api/events/${event.id}/guests/${gail.visitorId}/badge`, { badgeId: v2.id })).status === 403);
  r = await desk.put(`/api/events/${event.id}/guests/${gail.visitorId}/badge`, { badgeId: v2.id });
  check("event: V-2 picked for Gail, shown with the guest", r.status === 200 && r.data.event.guests.find((g) => g.visitorId === gail.visitorId).badge.number === "V-2");
  r = await desk.post(`/api/events/${event.id}/guests`, { visitorId: bare.id });
  check("event: the same badge isn't picked for two guests that day", (await desk.put(`/api/events/${event.id}/guests/${bare.id}/badge`, { badgeId: v2.id })).status === 409);

  // Gail checks in at the kiosk; the desk checks her ID, then hands over V-2.
  const kiosk = client({ kiosk: true });
  await kiosk.post("/kiosk/api/pair", { code: (await admin.post("/api/kiosks", { name: "Lobby", siteId: site.id })).data.code });
  r = await kiosk.post("/kiosk/api/lookup", { name: "Gail Guest" });
  check("kiosk: Gail's record has what check-in needs", r.data.matches[0].needs.organization === false && r.data.matches[0].needs.citizenship === false);
  await kiosk.post("/kiosk/api/checkin", { ref: r.data.matches[0].ref, companyId: acme.id, hostId: host.id, purpose: "Board meeting" });
  const gailWaiting = (await desk.get("/api/visits/badge-needed")).data.visits.find((v) => v.name === "Gail Guest");
  check("kiosk: she's waiting for the desk to check her ID", gailWaiting && gailWaiting.stage === "id");
  check("expected: shown at the event as arrived, check-in not finished", (await desk.get(`/api/events/${event.id}`)).data.event.guests.find((g) => g.visitorId === gail.visitorId).checkinStage === "id");
  check("badge: not before her ID is checked", (await desk.get(`/api/visits/${gailWaiting.visitId}/badge-plan`)).status === 409 && (await desk.post(`/api/visits/${gailWaiting.visitId}/badge`, { badgeId: v2.id })).status === 409);
  r = await desk.post(`/api/visits/${gailWaiting.visitId}/verify-id`, { idType: "Passport", purpose: "Board meeting, then lunch" });
  check("id: checked, with the purpose changed", r.status === 200 && r.data.visit.checkinStage === "badge" && r.data.visit.purpose === "Board meeting, then lunch");
  check("id: in the audit log", (await admin.get("/api/audit?action=visit.id_checked")).data.entries.some((e) => e.target === "Gail Guest" && /Passport/.test(e.detail)));
  r = await desk.get(`/api/visits/${gailWaiting.visitId}/badge-plan`);
  check("plan: the badge picked for her event", r.data.assigned && r.data.assigned.number === "V-2" && r.data.assigned.source === "event" && r.data.assigned.eventTitle === "Board meeting" && r.data.assigned.problem === null, JSON.stringify(r.data));
  // V-2 has gone missing: she gets another, V-3 being free again.
  r = await desk.post(`/api/visits/${gailWaiting.visitId}/badge`, { badgeId: v3.id });
  check("badge: a different badge when the picked one can't be found", r.status === 200 && r.data.badge.number === "V-3");
  check("expected: and she shows as here", (await desk.get(`/api/events/${event.id}`)).data.event.guests.find((g) => g.visitorId === gail.visitorId).checkinStage === null);

  // A visitor already holding a badge: the desk confirms it rather than giving another.
  const ann2 = (await desk.post(`/api/visits/${annVisit.id}/checkout`)).data.visit;
  check("visit: Ann leaves with V-1 still on her", ann2.checkedOutAt && (await desk.get(`/api/badges/${v1.id}`)).data.badge.holder.name === "Ann Arrival");
  r = await desk.post("/api/checkins", base);
  const again = r.data.visit;
  r = await desk.get(`/api/visits/${again.id}/badge-plan`);
  check("plan: she holds V-1 already", r.data.holding.map((b) => b.number).join() === "V-1");
  r = await desk.post(`/api/visits/${again.id}/badge`, { badgeId: v1.id });
  check("badge: one she holds is confirmed, not given twice", r.status === 200 && r.data.already === true && (await desk.get(`/api/visits?status=open`)).data.visits.find((v) => v.id === again.id).checkinStage === "done");

  // No badge needed (an escort, say): only once the ID is checked.
  r = await desk.post("/api/checkins", { visitorId: tech.id, siteId: site.id, hostId: facilities.id, purpose: "Inspection", idType: "CAC" });
  check("no badge: marked, the check-in is done", (await desk.post(`/api/visits/${r.data.visit.id}/badge-not-needed`)).status === 200
    && (await desk.get(`/api/visits?status=open`)).data.visits.find((v) => v.id === r.data.visit.id).checkinStage === "done");

  // --- the badge image: uncleared until Security validates their clearance ---------------------------
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const secret = (await admin.get("/api/clearance")).data.levels.find((l) => l.name === "Secret");
  const unclearedImage = (await admin.put("/api/badge-templates/0/visitor", { dataUrl: PNG })).data.template.ref;
  const secretImage = (await admin.put(`/api/badge-templates/${secret.id}/visitor`, { dataUrl: PNG })).data.template.ref;
  await security.post("/api/badges", { number: "VC-1", type: "visitor", clearanceLevelId: secret.id });
  // The only uncleared visitor badge left is retired: just the cleared one is in stock.
  await security.put(`/api/badges/${v2.id}`, { status: "retired" });
  const val = (await desk.post("/api/visitors", { firstName: "Val", lastName: "Idated", organization: "Clear Co", citizenship: "US" })).data.visitor;
  const valVisit = (await desk.post("/api/checkins", { visitorId: val.id, siteId: site.id, hostId: host.id, purpose: "Briefing", idType: "CAC" })).data.visit;
  r = await desk.get(`/api/visits/${valVisit.id}/badge-plan`);
  check("image: not validated, the uncleared visitor badge is shown, even with none free", r.data.uncleared === true && r.data.suggested === unclearedImage && r.data.available.length === 0, JSON.stringify(r.data));
  check("image: the same on their visitor page", (await desk.get(`/api/badge-holders/visitor/${val.id}`)).data.suggested === unclearedImage);
  await security.post("/api/clearance/validate", { kind: "visitor", id: val.id, levelId: secret.id, granted: "2025-01-01" });
  r = await desk.get(`/api/visits/${valVisit.id}/badge-plan`);
  check("image: once Security validates it, the badge their clearance allows", r.data.uncleared === false && r.data.suggested === secretImage && r.data.available.map((b) => b.number).join() === "VC-1", JSON.stringify(r.data));

  // --- facility codes: optional, 2-3 digits, the same number under several -----------------------------
  const add = (body) => security.post("/api/badges", { type: "visitor", ...body });
  check("code: 2 or 3 digits", (await add({ number: "777", facilityCode: "7" })).status === 400 && (await add({ number: "777", facilityCode: "1234" })).status === 400 && (await add({ number: "777", facilityCode: "1a" })).status === 400);
  r = await add({ number: "777", facilityCode: "101" });
  const fc101 = r.data.badge;
  check("code: kept apart from the number, and written together", r.status === 200 && fc101.facilityCode === "101" && fc101.number === "777" && fc101.label === "101-777");
  const fc205 = (await add({ number: "777", facilityCode: "205" })).data.badge;
  check("code: the same number under another code is another badge", fc205 && fc205.label === "205-777");
  check("code: but not twice under the same code", (await add({ number: "777", facilityCode: "101" })).status === 409);
  const uncoded = (await add({ number: "777" })).data.badge;
  check("code: without one is a code of its own", uncoded && uncoded.label === "777" && uncoded.facilityCode === null && (await add({ number: "777" })).status === 409);
  check("code: only Security adds them", (await desk.post("/api/badges", { type: "visitor", number: "778", facilityCode: "101" })).status === 403);
  check("code: anyone who sees badges sees it", (await viewer.get(`/api/badges/${fc101.id}`)).data.badge.facilityCode === "101");
  check("code: found by search, alone or written with the number", (await desk.get("/api/badges?q=205-777")).data.badges.map((b) => b.id).join() === String(fc205.id)
    && (await desk.get("/api/badges?q=101")).data.badges.some((b) => b.id === fc101.id));
  check("code: changed, or taken away, when editing", (await security.put(`/api/badges/${fc205.id}`, { facilityCode: "206" })).data.badge?.label === "206-777"
    && (await security.put(`/api/badges/${fc205.id}`, { facilityCode: "" })).status === 409);
  r = await security.post("/api/badges/bulk", { ids: [fc205.id], patch: { facilityCode: "301" } });
  check("code: set on several at once", r.status === 200 && (await desk.get(`/api/badges/${fc205.id}`)).data.badge.label === "301-777");

  // At check-in, a number under several codes needs its code.
  const tia = (await desk.post("/api/visitors", { firstName: "Tia", lastName: "Typed", organization: "Code Co", citizenship: "US" })).data.visitor;
  const tiaVisit = (await desk.post("/api/checkins", { visitorId: tia.id, siteId: site.id, hostId: host.id, purpose: "Audit", idType: "Passport" })).data.visit;
  r = await desk.post(`/api/visits/${tiaVisit.id}/badge`, { number: "777" });
  check("check-in: a number under several codes asks for the code, naming them", r.status === 409 && /101-777/.test(r.data.error) && /301-777/.test(r.data.error) && /facility code/.test(r.data.error), r.data.error);
  check("check-in: a code with no badge of that number", (await desk.post(`/api/visits/${tiaVisit.id}/badge`, { number: "777", facilityCode: "999" })).status === 404);
  r = await desk.post(`/api/visits/${tiaVisit.id}/badge`, { number: "777", facilityCode: "301" });
  check("check-in: with its code, that badge", r.status === 200 && r.data.badge.label === "301-777");
  const tim = (await desk.post("/api/visitors", { firstName: "Tim", lastName: "Typed", organization: "Code Co", citizenship: "US" })).data.visitor;
  const timVisit = (await desk.post("/api/checkins", { visitorId: tim.id, siteId: site.id, hostId: host.id, purpose: "Audit", idType: "Passport" })).data.visit;
  r = await desk.post(`/api/visits/${timVisit.id}/badge`, { number: "101-777" });
  check("check-in: or written together", r.status === 200 && r.data.badge.label === "101-777");
  check("check-in: the audit names the code too", (await admin.get("/api/audit?action=badge.assign")).data.entries.some((e) => e.target === "101-777"));
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
