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
  // The edit form builds its Visitor type dropdown from the choices sent with the field.
  r = await desk.get(`/api/visitors/${ann.id}`);
  check("record: the visitor type comes with its choices, for the edit form", r.data.fields.find((f) => f.key === "visitorType")?.choices.join() === "Guest,Service Technician", JSON.stringify(r.data.fields.find((f) => f.key === "visitorType")));
  check("record: and the type can be changed and changed back", (await desk.put(`/api/visitors/${ann.id}`, { visitorType: "Service Technician" })).data.visitor?.visitorType === "Service Technician"
    && (await desk.put(`/api/visitors/${ann.id}`, { visitorType: "Guest" })).data.visitor?.visitorType === "Guest");
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

  // --- correcting when a visitor arrived and left ------------------------------------------------------
  const HOUR = 3600 * 1000;
  const inAt = Date.now() - 6 * HOUR;
  const leftAt = Date.now() - 2 * HOUR;
  const times = (id, body) => desk.put(`/api/visits/${id}/times`, body);
  check("times: only those who check visitors in", (await viewer.put(`/api/visits/${tiaVisit.id}/times`, { checkedInAt: inAt, reason: "Arrived earlier" })).status === 403);
  check("times: not without a reason", (await times(tiaVisit.id, { checkedInAt: inAt })).status === 400 && (await times(tiaVisit.id, { checkedInAt: inAt, reason: "   " })).status === 400);
  check("times: not in the future", (await times(tiaVisit.id, { checkedInAt: Date.now() + 2 * HOUR, reason: "Typo in the time" })).status === 400);
  check("times: not leaving before arriving", (await times(tiaVisit.id, { checkedInAt: inAt, checkedOutAt: inAt - HOUR, reason: "Forgot to check out" })).status === 400);
  check("times: not the same as on record", (await times(tiaVisit.id, { checkedInAt: tiaVisit.checkedInAt, reason: "No change at all" })).status === 400);
  r = await times(tiaVisit.id, { checkedInAt: inAt, reason: "Signed in at the kiosk late" });
  check("times: arrival corrected, still in the building", r.status === 200 && r.data.visit.checkedInAt === inAt && !r.data.visit.checkedOutAt && r.data.visit.timesCorrected === 1 && r.data.timeChanges[0].reason === "Signed in at the kiosk late", JSON.stringify(r.data));
  check("times: the visitor's last visit follows the corrected arrival", (await desk.get(`/api/visitors/${tia.id}`)).data.visitor.lastVisitAt === inAt);
  r = await times(tiaVisit.id, { checkedOutAt: leftAt, reason: "Left without checking out; host says 2 hours ago" });
  check("times: a check-out time on an open visit checks them out then", r.status === 200 && r.data.visit.checkedOutAt === leftAt && r.data.visit.checkoutMethod === "staff" && r.data.visit.checkedOutBy === "desk");
  check("times: and they're no longer in the building", !(await desk.get("/api/visits?status=open")).data.visits.some((v) => v.id === tiaVisit.id));
  check("times: an ended visit can't be opened again", (await times(tiaVisit.id, { checkedOutAt: null, reason: "Still here after all" })).status === 400);
  r = await desk.get(`/api/visits/${tiaVisit.id}`);
  check("times: each correction kept with the visit, newest first, with who and why", r.data.visit.timesCorrected === 2 && r.data.timeChanges.length === 2
    && r.data.timeChanges[0].field === "out" && r.data.timeChanges[0].from === null && r.data.timeChanges[0].to === leftAt && r.data.timeChanges[0].by === "desk"
    && r.data.timeChanges[1].field === "in" && r.data.timeChanges[1].from === tiaVisit.checkedInAt && r.data.timeChanges[1].to === inAt);
  const corrected = (await admin.get("/api/audit?action=visit.times_corrected")).data.entries;
  check("times: each in the audit log, before and after, with the reason", corrected.length === 2 && corrected.every((e) => e.target === "Tia Typed")
    && corrected.some((e) => /arrived .+ -> .+\. Reason: Signed in at the kiosk late/.test(e.detail)) && corrected.some((e) => /left not checked out -> .+\. Reason: Left without checking out/.test(e.detail)), JSON.stringify(corrected));
  check("times: the log shows it was corrected", (await desk.get(`/api/visits?visitorId=${tia.id}`)).data.visits[0].timesCorrected === 2);
  const logged = (await desk.get(`/api/visits?visitorId=${tia.id}`)).data.visits[0];
  check("times: which times changed, and the latest reason", logged.timeChanged.in === true && logged.timeChanged.out === true
    && logged.lastCorrection.reason === "Left without checking out; host says 2 hours ago" && logged.lastCorrection.by === "desk");
  r = await desk.get("/api/visits?corrected=1&limit=1000");
  check("times: the log lists only corrected visits when asked", r.data.total === 1 && r.data.visits[0].id === tiaVisit.id && (await desk.get("/api/visits?limit=1000")).data.total > 1);
  check("times: an uncorrected visit has no marks", (await desk.get(`/api/visits?visitorId=${tim.id}`)).data.visits[0].timeChanged === null);
  // Security corrects times too, though it otherwise only reads visitors.
  r = await security.put(`/api/visits/${timVisit.id}/times`, { checkedInAt: timVisit.checkedInAt - HOUR, reason: "The door log shows an earlier arrival" });
  check("times: Security corrects them too", r.status === 200 && r.data.visit.timesCorrected === 1, JSON.stringify(r.data).slice(0, 200));
  check("times: Security still can't change a visitor", (await security.put(`/api/visitors/${tim.id}`, { organization: "Other Co" })).status === 403);

  // --- the badge each visit had, and entering one later ----------------------------------------------
  const visitOf = async (visitorId) => (await desk.get(`/api/visits?visitorId=${visitorId}`)).data.visits[0];
  check("badge: the log shows the badge given at check-in", (await visitOf(tia.id)).badges.join() === "301-777" && (await visitOf(tia.id)).badgeRecordedLater === false);
  await admin.post("/api/roles", { name: "Visit reader", directory: "none", visitors: "read", badges: "none" });
  const vrPw = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await admin.post("/api/users", { username: "visitreader", password: vrPw, role: "visit-reader" });
  const visitReader = await as("visitreader", vrPw);
  r = await visitReader.get(`/api/visits?visitorId=${tia.id}`);
  check("badge: not to those who don't see badges", r.status === 200 && r.data.visits[0].badges === undefined, JSON.stringify(r.data).slice(0, 200));
  // --- a badge reserved on a guest's record, shown with them at the event ---------------------------
  const keptA = (await security.post("/api/badges", { number: "KEPT-A", type: "visitor" })).data.badge;
  const keptB = (await security.post("/api/badges", { number: "KEPT-B", type: "visitor" })).data.badge;
  const keptEvent = (await desk.post("/api/events", { siteId: site.id, title: "Standing meeting", date: day, companyId: acme.id, hostId: host.id })).data.event;
  const regular = (await desk.post(`/api/events/${keptEvent.id}/guests`, { visitor: { firstName: "Reggie", lastName: "Regular", organization: "Guest Co", citizenship: "US" } })).data.event.guests[0];
  const guestNow = async (c = desk) => (await c.get(`/api/events/${keptEvent.id}`)).data.event.guests[0];
  const reserveFor = (badgeId) => desk.put(`/api/visitors/${regular.visitorId}/reserved-badge`, { badgeId });
  const pickKept = (badgeId) => desk.put(`/api/events/${keptEvent.id}/guests/${regular.visitorId}/badge`, { badgeId });
  check("kept: nothing kept, nothing shown", (await guestNow()).badge === null);
  await reserveFor(keptA.id);
  r = await guestNow();
  check("kept: a badge reserved on their record shows with the guest", r.badge?.number === "KEPT-A" && r.badge.source === "reserved", JSON.stringify(r));
  check("kept: and on the day's list", (await desk.get(`/api/events?date=${day}&site=${site.id}`)).data.events.find((e) => e.id === keptEvent.id).guests[0].badge?.number === "KEPT-A");
  check("kept: not to those who don't see badges", (await guestNow(visitReader)).badge === undefined && (await visitReader.get(`/api/events?date=${day}&site=${site.id}`)).data.events.find((e) => e.id === keptEvent.id).guests[0].badge === undefined);
  r = await pickKept(keptB.id);
  check("kept: one picked for the event goes ahead of it", r.status === 200 && r.data.event.guests[0].badge.number === "KEPT-B" && r.data.event.guests[0].badge.source === "event");
  r = await pickKept(null);
  check("kept: clearing the pick goes back to the reserved one", r.data.event.guests[0].badge.number === "KEPT-A" && r.data.event.guests[0].badge.source === "reserved");
  check("kept: and the audit log says no badge is picked", (await admin.get("/api/audit?action=event.guest_badge")).data.entries[0].detail.endsWith("no badge picked"));
  await reserveFor(vRiver.id);
  check("kept: one that can't be used at the event's site isn't shown, as check-in won't hand it over", (await guestNow()).badge === null);
  await reserveFor(keptA.id);
  await desk.post("/api/checkins", { visitorId: regular.visitorId, siteId: site.id, hostId: host.id, purpose: "Standing meeting", idType: "Passport" });
  r = await guestNow();
  check("kept: once they've arrived, the reservation says nothing about this visit", r.status === "here" && r.badge === null, JSON.stringify(r));
  // --- which badges can be picked: as they'll stand at the event, not as they stand now -------------
  const dayAfter = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const optionNames = async (ev, visitorId, c = desk) => (await c.get(`/api/events/${ev.id}/guests/${visitorId}/badge-options`)).data.available.map((b) => b.number);
  const outBadge = (await security.post("/api/badges", { number: "OUT-1", type: "visitor" })).data.badge;
  const soonGone = (await security.post("/api/badges", { number: "SOON-1", type: "visitor", expiresOn: dayAfter(3) })).data.badge;
  const lostOne = (await security.post("/api/badges", { number: "LOST-1", type: "visitor" })).data.badge;
  await security.put(`/api/badges/${lostOne.id}`, { status: "lost" });
  const olive = (await desk.post("/api/visitors", { firstName: "Olive", lastName: "Holder", organization: "Guest Co", citizenship: "US" })).data.visitor;
  r = await desk.post(`/api/badges/${outBadge.id}/assign`, { kind: "visitor", holderId: olive.id });
  check("options: a badge is out with someone now", r.status === 200 && (await desk.get(`/api/badges/${outBadge.id}`)).data.badge.holder.name === "Olive Holder", JSON.stringify(r.data));
  const optionGuest = async (ev, firstName) => (await desk.post(`/api/events/${ev.id}/guests`, { visitor: { firstName, lastName: "Option", organization: "Guest Co", citizenship: "US" } })).data.event.guests.find((g) => g.firstName === firstName).visitorId;
  const eventOn = async (date, title) => (await desk.post("/api/events", { siteId: site.id, title, date, companyId: acme.id, hostId: host.id })).data.event;
  const nowEvent = await eventOn(dayAfter(-1), "Yesterday's");
  const nowGuest = await optionGuest(nowEvent, "Paula");
  let names = await optionNames(nowEvent, nowGuest);
  check("options: today or earlier, only what's free now", !names.includes("OUT-1") && names.includes("SOON-1"), names.join());
  const timedToday = async (startTime) => { const ev = (await desk.post("/api/events", { siteId: site.id, title: `Today ${startTime}`, date: day, startTime, companyId: acme.id, hostId: host.id })).data.event; return { ev, guest: await optionGuest(ev, `Tim${startTime.replace(":", "")}`) }; };
  const started = await timedToday("00:00");
  check("options: today, once it has started, only what's free now", !(await optionNames(started.ev, started.guest)).includes("OUT-1"));
  const toCome = await timedToday("23:59");
  check("options: today, before it starts, those out now too", (await optionNames(toCome.ev, toCome.guest)).includes("OUT-1"));
  const anyTime = await eventOn(day, "Today, any time");
  check("options: today with no start time, those out now too", (await optionNames(anyTime, await optionGuest(anyTime, "Una"))).includes("OUT-1"));
  const later5 = await eventOn(dayAfter(5), "Next week");
  const fran = await optionGuest(later5, "Fran");
  const opts = (await desk.get(`/api/events/${later5.id}/guests/${fran}/badge-options`)).data;
  names = opts.available.map((b) => b.number);
  check("options: a later date lists a badge out now, marked so", opts.later === true && opts.available.find((b) => b.number === "OUT-1")?.outNow === true, names.join());
  check("options: and one free now isn't marked out", opts.available.find((b) => b.number === "KEPT-B")?.outNow === false, names.join());
  check("options: nor one expiring before that date", !names.includes("SOON-1"), names.join());
  check("options: nor a lost one, one valid elsewhere, or one reserved for someone else", !names.includes("LOST-1") && !names.includes("VR-9") && !names.includes("KEPT-A"), names.join());
  check("options: not for a viewer", (await viewer.get(`/api/events/${later5.id}/guests/${fran}/badge-options`)).status === 403);
  check("options: only for a guest of that event", (await desk.get(`/api/events/${later5.id}/guests/${olive.id}/badge-options`)).status === 404);
  r = await desk.put(`/api/events/${later5.id}/guests/${fran}/badge`, { badgeId: outBadge.id });
  check("options: the one that's out can be picked", r.status === 200 && r.data.event.guests[0].badge.number === "OUT-1", JSON.stringify(r.data).slice(0, 200));
  const gus = await optionGuest(later5, "Gus");
  check("options: then it's not offered to another guest that day", !(await optionNames(later5, gus)).includes("OUT-1") && (await optionNames(later5, fran)).includes("OUT-1"));
  const later6 = await eventOn(dayAfter(6), "The day after");
  check("options: but it is the day after", (await optionNames(later6, await optionGuest(later6, "Hal"))).includes("OUT-1"));
  check("badge: a visit with one can't have another entered", (await desk.post(`/api/visits/${tiaVisit.id}/badge-record`, { number: "V-3" })).status === 409);
  const rita = (await desk.post("/api/visitors", { firstName: "Rita", lastName: "Record", organization: "Late Co", citizenship: "US" })).data.visitor;
  const ritaVisit = (await desk.post("/api/checkins", { visitorId: rita.id, siteId: site.id, hostId: host.id, purpose: "Audit", idType: "Passport" })).data.visit;
  await desk.post(`/api/visits/${ritaVisit.id}/badge-not-needed`);
  await desk.post(`/api/visits/${ritaVisit.id}/checkout`);
  check("badge: none recorded", (await visitOf(rita.id)).badges.length === 0);
  const vRec = (await security.post("/api/badges", { number: "V-REC", type: "visitor" })).data.badge;
  const tRec = (await security.post("/api/badges", { number: "T-REC", type: "tenant" })).data.badge;
  check("badge: only those who give badges and check visitors in", (await viewer.post(`/api/visits/${ritaVisit.id}/badge-record`, { number: "V-REC" })).status === 403);
  check("badge: a number that isn't a badge", (await desk.post(`/api/visits/${ritaVisit.id}/badge-record`, { number: "NOPE-1" })).status === 404);
  check("badge: only a visitor badge", (await desk.post(`/api/visits/${ritaVisit.id}/badge-record`, { badgeId: tRec.id })).status === 400);
  r = await desk.post(`/api/visits/${ritaVisit.id}/badge-record`, { number: "101-777" });
  check("badge: not one that was with someone else then", r.status === 409 && /was with Tim Typed then/.test(r.data.error), r.data.error);
  r = await security.post(`/api/visits/${ritaVisit.id}/badge-record`, { number: "v-rec" });
  check("badge: entered (by Security) for a visit that ended, held for its time and back", r.status === 200 && r.data.recorded === true && !r.data.badge.holder, JSON.stringify(r.data));
  const ritaLogged = await visitOf(rita.id);
  check("badge: the log shows it, marked entered later", ritaLogged.badges.join() === "V-REC" && ritaLogged.badgeRecordedLater === true);
  const recHistory = (await desk.get(`/api/badges/${vRec.id}`)).data;
  const recRow = (recHistory.history || recHistory.badge.history || [])[0];
  check("badge: in the badge's history, noted", recRow && recRow.holderName === "Rita Record" && recRow.note === "Recorded after the visit" && recRow.assignedAt === ritaVisit.checkedInAt, JSON.stringify(recHistory).slice(0, 400));
  check("badge: in the audit log", (await admin.get("/api/audit?action=visit.badge_recorded")).data.entries.some((e) => e.target === "Rita Record" && /V-REC, recorded after the visit/.test(e.detail)));
  // Someone still here: entered from the log, it is given to them now.
  const ola = (await desk.post("/api/visitors", { firstName: "Ola", lastName: "Open", organization: "Now Co", citizenship: "US" })).data.visitor;
  const olaVisit = (await desk.post("/api/checkins", { visitorId: ola.id, siteId: site.id, hostId: host.id, purpose: "Audit", idType: "Passport" })).data.visit;
  const vNow = (await security.post("/api/badges", { number: "V-NOW", type: "visitor" })).data.badge;
  r = await desk.post(`/api/visits/${olaVisit.id}/badge-record`, { number: "V-NOW" });
  check("badge: for someone still here, given now", r.status === 200 && r.data.recorded === false && r.data.badge.holder?.name === "Ola Open" && (await visitOf(ola.id)).badges.join() === "V-NOW");
  await desk.post(`/api/badges/${vNow.id}/return`);
  // A badge given from the visitor's page while they're here goes with that visit.
  const vPage = (await security.post("/api/badges", { number: "V-PAGE", type: "visitor" })).data.badge;
  await desk.post(`/api/badges/${vPage.id}/assign`, { kind: "visitor", holderId: ola.id });
  check("badge: given from their page, it goes with the visit they're on", (await visitOf(ola.id)).badges.includes("V-PAGE"));

  // --- a point of contact from anywhere in the directory ------------------------------------------
  const riverCo = (await admin.post("/api/companies", { name: "River Partners", sites: [{ siteId: other.id }] })).data.company;
  const riverRita = (await admin.post("/api/people", { firstName: "Rita", lastName: "Riverton", companyId: riverCo.id, canHost: false })).data.person;
  const guest = async (firstName, extra = {}) => (await desk.post("/api/visitors", { firstName, lastName: "Crossing", organization: "Guest Co", citizenship: "US", ...extra })).data.visitor;
  r = await desk.post("/api/checkins", { visitorId: (await guest("Gail")).id, siteId: site.id, hostId: riverRita.id, purpose: "Conference room", idType: "Passport" });
  check("contact: a guest's can be someone at another site who doesn't host, the visit staying here", r.status === 200 && r.data.visit.siteName === "Harbor Point" && r.data.visit.companyName === "River Partners" && r.data.visit.hostName === "Rita Riverton", JSON.stringify(r.data));
  const moving = (await desk.post("/api/checkins", { visitorId: (await guest("Mo")).id, siteId: site.id, hostId: host.id, purpose: "Meeting", idType: "Passport" })).data.visit;
  r = await desk.post(`/api/visits/${moving.id}/verify-id`, { idType: "Passport", hostId: riverRita.id, companyId: riverCo.id });
  check("contact: changed to someone at another site, once the visit is open", r.status === 200 && r.data.visit.hostName === "Rita Riverton" && r.data.visit.companyName === "River Partners", JSON.stringify(r.data));
  check("contact: not a visitor, or anyone who isn't in the directory", (await desk.post("/api/checkins", { visitorId: (await guest("Vi")).id, siteId: site.id, hostId: 999999, purpose: "Meeting", idType: "Passport" })).status === 400);
  await admin.post("/api/users", { username: "harbordesk", password: pw.desk, role: "frontdesk", sites: [site.id] });
  const harborDesk = await as("harbordesk", pw.desk);
  check("contact: a desk limited to its site can't browse the other site's people", !(await harborDesk.get("/api/people?q=Riverton")).data.people.length);
  r = await harborDesk.get("/api/contacts?q=Riverton");
  check("contact: but finds them as a point of contact, by name", r.status === 200 && r.data.people.map((p) => p.id).join() === String(riverRita.id) && r.data.people[0].companyName === "River Partners", JSON.stringify(r.data));
  check("contact: and opens them", (await harborDesk.get(`/api/contacts/${riverRita.id}`)).data.person?.id === riverRita.id);
  check("contact: which says the sites they're assigned to, for the desk's warning", r.data.people[0].assignedSiteIds.join() === String(other.id));
  const atRiverOnly = (await admin.post("/api/people", { firstName: "Paula", lastName: "Pinned", companyId: (await admin.post("/api/companies", { name: "Two Sites", sites: [{ siteId: site.id }, { siteId: other.id }] })).data.company.id, siteId: other.id })).data.person;
  check("contact: someone with a site of their own is assigned only there", (await harborDesk.get(`/api/contacts?q=Pinned`)).data.people[0].assignedSiteIds.join() === String(other.id), JSON.stringify(atRiverOnly));
  check("contact: a name is needed to search", (await harborDesk.get("/api/contacts")).data.people.length === 0);
  check("contact: not for those who can't check anyone in", (await viewer.get("/api/contacts?q=Riverton")).status === 403);
  const newGuest = { firstName: "Nia", lastName: "Newcomer", organization: "Guest Co", citizenship: "US", links: [{ companyId: riverCo.id, hostId: riverRita.id }] };
  check("contact: a limited desk can't link another site's company without saying where they're arriving", (await harborDesk.post("/api/visitors", newGuest)).status === 403);
  check("contact: nor at a site that isn't its own", (await harborDesk.post("/api/visitors", { ...newGuest, siteId: other.id })).status === 403);
  r = await harborDesk.post("/api/visitors", { ...newGuest, siteId: site.id });
  const nia = r.data.visitor;
  check("contact: arriving at its site, it adds them and can still find them", r.status === 200 && (await harborDesk.get(`/api/visitors/${nia.id}`)).status === 200, JSON.stringify(r.data));
  r = await harborDesk.post("/api/checkins", { visitorId: nia.id, siteId: site.id, hostId: riverRita.id, purpose: "Conference room", idType: "Passport" });
  check("contact: and checks them in with that contact", r.status === 200 && r.data.visit.hostName === "Rita Riverton", JSON.stringify(r.data));
  // --- a clearance decides what can be kept for a visitor ahead of time, too --------------------------
  const levelIds = Object.fromEntries((await security.get("/api/config")).data.clearanceLevels.map((l) => [l.name, l.id]));
  const levelBadge = async (number, level) => (await security.post("/api/badges", { number, type: "visitor", clearanceLevelId: level ? levelIds[level] : null })).data.badge;
  const ofUncleared = await levelBadge("CL-U", null);
  const ofSecret = await levelBadge("CL-S", "Secret");
  const ofTs = await levelBadge("CL-TS", "TS");
  const ofSci = await levelBadge("CL-SCI", "TS//SCI");
  const ofFsp = await levelBadge("CL-FSP", "TS//SCI FSP");
  const cleo = await guest("Cleo");
  await security.post("/api/clearance/validate", { kind: "visitor", id: cleo.id, levelId: levelIds.TS });
  const offered = (list) => list.map((b) => b.number).filter((n) => n.startsWith("CL-")).sort().join();
  const atSite = (await desk.get(`/api/badge-holders/visitor/${cleo.id}?site=${site.id}`)).data.available;
  check("clearance: TS is offered only TS badges, on the list Pick badge shows", offered(atSite) === "CL-TS", offered(atSite));
  check("clearance: so is the list of an event still to come", offered((await desk.get(`/api/badge-holders/visitor/${cleo.id}`)).data.available) === "CL-TS");
  const clearedEvent = (await desk.post("/api/events", { siteId: site.id, title: "Cleared review", date: new Date().toISOString().slice(0, 10), companyId: acme.id, hostId: host.id })).data.event;
  await desk.post(`/api/events/${clearedEvent.id}/guests`, { visitorId: cleo.id });
  const pickFor = (visitor, badge) => desk.put(`/api/events/${clearedEvent.id}/guests/${visitor.id}/badge`, { badgeId: badge.id });
  r = await pickFor(cleo, ofFsp);
  check("clearance: a higher badge can't be picked ahead for a guest, nor its level named to the desk", r.status === 409 && /doesn't cover badge CL-FSP/.test(r.data.error) && !/TS\/\/SCI/.test(r.data.error), JSON.stringify(r.data));
  r = await desk.put(`/api/visitors/${cleo.id}/reserved-badge`, { badgeId: ofSci.id });
  check("clearance: nor reserved", r.status === 409 && /doesn't cover badge CL-SCI/.test(r.data.error), JSON.stringify(r.data));
  check("clearance: their own level can be picked", (await pickFor(cleo, ofTs)).status === 200);
  check("clearance: and a lower one reserved", (await desk.put(`/api/visitors/${cleo.id}/reserved-badge`, { badgeId: ofSecret.id })).status === 200);
  await desk.put(`/api/visitors/${cleo.id}/reserved-badge`, { badgeId: null });
  const nora = await guest("Nora");
  await desk.post(`/api/events/${clearedEvent.id}/guests`, { visitorId: nora.id });
  r = await pickFor(nora, ofSecret);
  check("clearance: with none validated, only uncleared ones", r.status === 409 && (await pickFor(nora, ofUncleared)).status === 200, JSON.stringify(r.data));
  await security.post("/api/clearance/validate", { kind: "visitor", id: cleo.id, levelId: levelIds.Secret });
  const cleoVisit = (await desk.post("/api/checkins", { visitorId: cleo.id, siteId: site.id, hostId: host.id, purpose: "Review", idType: "Passport" })).data.visit;
  r = (await desk.get(`/api/visits/${cleoVisit.id}/badge-plan`)).data;
  check("clearance: one kept before a lower validation can't be handed over, and check-in says why", r.assigned?.number === "CL-TS" && /doesn't cover badge CL-TS/.test(r.assigned.problem || "") && offered(r.available) === "CL-S", JSON.stringify(r).slice(0, 300));
  check("clearance: nor issued by number", (await desk.post(`/api/visits/${cleoVisit.id}/badge`, { number: "CL-TS" })).status === 409);
  check("clearance: a lower badge they may hold isn't offered, but can still be given by its number", (await desk.post(`/api/visits/${cleoVisit.id}/badge`, { number: "CL-U" })).status === 200);

  check("contact: but not at a site that isn't its own", (await harborDesk.post("/api/checkins", { visitorId: nia.id, siteId: other.id, hostId: riverRita.id, purpose: "Conference room", idType: "Passport" })).status === 403);

  // --- several points of contact -------------------------------------------------------------------
  const second = (await admin.post("/api/people", { firstName: "Sol", lastName: "Second", companyId: acme.id })).data.person;
  const third = (await admin.post("/api/people", { firstName: "Tess", lastName: "Third", companyId: acme.id })).data.person;
  r = await desk.post("/api/checkins", { visitorId: (await guest("Pia")).id, siteId: site.id, hostIds: [second.id, host.id], purpose: "Workshop", idType: "Passport" });
  const piaVisit = r.data.visit;
  check("contacts http: the desk checks someone in with two", r.status === 200 && piaVisit.hostIds.join() === `${second.id},${host.id}` && piaVisit.hostId === second.id && piaVisit.hostName === "Sol Second, Hana Host" && piaVisit.companyName === "Acme Corp", JSON.stringify(r.data));
  check("contacts http: the audit log names them", (await admin.get("/api/audit?action=visit.checkin")).data.entries.some((e) => /contact Sol Second, Hana Host;/.test(e.detail)));
  check("contacts http: each at the first one's company", (await desk.post("/api/checkins", { visitorId: (await guest("Quin")).id, siteId: site.id, hostIds: [host.id, riverRita.id], purpose: "Workshop", idType: "Passport" })).status === 400);
  r = await desk.post(`/api/visits/${piaVisit.id}/verify-id`, { idType: "Passport", hostIds: [host.id, second.id, third.id] });
  check("contacts http: changed until the badge is given", r.status === 200 && r.data.visit.hostIds.join() === [host.id, second.id, third.id].join() && r.data.visit.hostName === "Hana Host, Sol Second, Tess Third", JSON.stringify(r.data));
  r = await desk.post(`/api/visits/${piaVisit.id}/verify-id`, { idType: "Passport" });
  check("contacts http: kept when none are sent", r.status === 200 && r.data.visit.hostIds.length === 3);
  check("contacts http: the visit log finds it by any of them", (await desk.get(`/api/visits?hostId=${third.id}`)).data.visits.some((v) => v.id === piaVisit.id)
    && !(await desk.get(`/api/visits?hostId=${riverRita.id}`)).data.visits.some((v) => v.id === piaVisit.id));
  // An event with two: an expected guest who names one at the kiosk gets both on their visit.
  const twoEvent = (await desk.post("/api/events", { siteId: site.id, title: "Two contacts", date: day, companyId: acme.id, hostIds: [host.id, second.id] })).data.event;
  check("contacts http: an event has two", twoEvent.hosts.map((p) => p.name).join() === "Hana Host,Sol Second" && twoEvent.hostName === "Hana Host", JSON.stringify(twoEvent.hosts));
  r = await desk.put(`/api/events/${twoEvent.id}`, { hostIds: [second.id, host.id] });
  check("contacts http: in a new order", r.status === 200 && r.data.event.hosts[0].id === second.id && r.data.event.hostId === second.id);
  check("contacts http: each in the event's company", (await desk.put(`/api/events/${twoEvent.id}`, { hostIds: [second.id, riverRita.id] })).status === 400
    && (await desk.get(`/api/events/${twoEvent.id}`)).data.event.hosts.length === 2);
  await desk.post(`/api/events/${twoEvent.id}/guests`, { visitor: { firstName: "Kit", lastName: "Kiosker", organization: "Guest Co", citizenship: "US" } });
  r = await kiosk.post("/kiosk/api/lookup", { name: "Kit Kiosker" });
  check("contacts http: the kiosk offers the event's first", r.data.matches[0]?.companies[0].hostName === "Sol Second", JSON.stringify(r.data));
  r = await kiosk.post("/kiosk/api/checkin", { ref: r.data.matches[0].ref, companyId: acme.id, hostId: host.id, purpose: "Two contacts" });
  check("contacts http: the kiosk names them all", r.data.ok && r.data.hostName === "Hana Host and Sol Second", JSON.stringify(r.data));
  const kitVisit = (await desk.get("/api/visits?status=open&q=Kiosker")).data.visits[0];
  check("contacts http: the kiosk visit has the event's, the one chosen first", kitVisit?.hostIds.join() === `${host.id},${second.id}`, JSON.stringify(kitVisit?.hostIds));
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
