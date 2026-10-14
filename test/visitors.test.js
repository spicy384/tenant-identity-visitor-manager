/**
 * Visitors without HTTP: name matching, end-of-day check-out in two time zones and across
 * daylight-saving changes, retention, merging, site limits and visitor field access.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { openDatabase } = require("../db");
const { generateKey } = require("../db-key");
const { createFields } = require("../fields");
const { createAccess } = require("../access");
const { createSites } = require("../sites");
const { createDirectory } = require("../directory");
const { createVisitors } = require("../visitors");
const { createVisitClock, endOfDayFor, zonedTime } = require("../visit-clock");
const { matchNames, isFullName, normaliseName } = require("../names");
const { createKiosks, normaliseCode } = require("../kiosks");

const { check, report } = createChecker("Visitors: names, end of day, retention, merge, site limits");
const throwsStatus = (fn, status) => {
  try { fn(); return false; } catch (error) { return error.status === status ? true : `${error.status}: ${error.message}`; }
};

// --- names --------------------------------------------------------------------------------

const people = [
  { id: 1, firstName: "Jane", lastName: "Doe" },
  { id: 2, firstName: "José", lastName: "Núñez" },
  { id: 3, firstName: "Ana", lastName: "de la Cruz" },
  { id: 4, firstName: "Jonathan", lastName: "Smith", preferredName: "Jon" },
  { id: 5, firstName: "John", lastName: "Smith" },
  { id: 6, firstName: "Siobhan", lastName: "O'Neill" },
  { id: 7, firstName: "Al", lastName: "Wu" }
];
const ids = (typed) => matchNames(typed, people).map((p) => p.id).join(",");
check("names: exact, any case and spacing", ids("jane doe") === "1" && ids("  JANE   DOE. ") === "1");
check("names: either order", ids("Doe Jane") === "1");
check("names: accents don't matter", ids("jose nunez") === "2" && ids("JOSÉ NÚÑEZ") === "2");
check("names: multi-word surnames, with or without spaces", ids("Ana de la Cruz") === "3" && ids("ana delacruz") === "3");
check("names: apostrophes don't matter", ids("Siobhan ONeill") === "6" && ids("siobhan o’neill") === "6");
check("names: a preferred name counts as a first name", ids("Jon Smith") === "4");
check("names: one typo per part is forgiven", ids("Jame Doe") === "1" && ids("Jonahtan Smith") === "4");
check("names: an exact match hides near ones", ids("John Smith") === "5");
check("names: two typos in one part is too many", ids("Jmae Deo") === "");
check("names: short names must be exact", ids("Al Wu") === "7" && ids("Ai Wu") === "");
check("names: one word finds nobody", ids("Jane") === "" && !isFullName("Jane"));
check("names: initials find nobody", ids("J D") === "" && !isFullName("J D"));
check("names: normalised form", normaliseName("  Zoë  O'Brien-Smith ") === "zoe obrien smith");

// --- end of day -----------------------------------------------------------------------------

const iso = (t) => new Date(t).toISOString();
check("end of day: New York 18:00 in summer is 22:00 UTC", iso(endOfDayFor(Date.parse("2026-07-01T14:00:00Z"), "18:00", "America/New_York")) === "2026-07-01T22:00:00.000Z");
check("end of day: New York 18:00 in winter is 23:00 UTC", iso(endOfDayFor(Date.parse("2026-12-01T14:00:00Z"), "18:00", "America/New_York")) === "2026-12-01T23:00:00.000Z");
check("end of day: arriving after closing runs to the next day's", iso(endOfDayFor(Date.parse("2026-10-13T23:30:00Z"), "18:00", "America/New_York")) === "2026-10-14T22:00:00.000Z");
check("end of day: the night the clocks go back", iso(endOfDayFor(Date.parse("2026-11-01T00:30:00Z"), "18:00", "America/New_York")) === "2026-11-01T23:00:00.000Z");
check("end of day: London after BST ends", iso(endOfDayFor(Date.parse("2026-10-26T09:00:00Z"), "17:30", "Europe/London")) === "2026-10-26T17:30:00.000Z");
check("end of day: a half-hour zone", iso(endOfDayFor(Date.parse("2026-10-13T04:00:00Z"), "18:00", "Asia/Kolkata")) === "2026-10-13T12:30:00.000Z");
check("local time: a time skipped in spring lands just after the gap", iso(zonedTime(2026, 3, 8, 2, 30, "America/New_York")) === "2026-03-08T07:30:00.000Z");
check("local time: a repeated autumn time is the first one", iso(zonedTime(2026, 11, 1, 1, 30, "America/New_York")) === "2026-11-01T05:30:00.000Z");

// --- the database side ------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-visitors-"));
const db = openDatabase({ dataDir: tmp, key: generateKey() });
const fields = createFields({ db });
const access = createAccess({ db, fields });
const sites = createSites({ db });
const directory = createDirectory({ db, fields });
const visitors = createVisitors({ db, fields });
let clockNow = Date.parse("2026-10-13T12:00:00Z");
const clock = createVisitClock({ db, visitors, now: () => clockNow });

const ny = sites.create({ name: "New York", timeZone: "America/New_York", endOfDay: "18:00" });
const ldn = sites.create({ name: "London", timeZone: "Europe/London", endOfDay: "17:30" });
const nyCo = directory.createCompany({ name: "Empire Co", sites: [{ siteId: ny.id }] });
const ldnCo = directory.createCompany({ name: "Thames Ltd", sites: [{ siteId: ldn.id }] });
const host = directory.createPerson({ firstName: "Hana", lastName: "Host", companyId: nyCo.id });
const other = directory.createPerson({ firstName: "Otto", lastName: "Other", companyId: ldnCo.id });

const vA = visitors.create({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });
const vB = visitors.create({ firstName: "Alan", lastName: "Turing" });

const inNy = visitors.checkIn({ visitorId: vA.id, siteId: ny.id, companyId: nyCo.id, hostId: host.id, now: Date.parse("2026-10-13T14:00:00Z") }).visit;
const inLdn = visitors.checkIn({ visitorId: vB.id, siteId: ldn.id, companyId: ldnCo.id, now: Date.parse("2026-10-13T09:00:00Z") }).visit;
check("check-in: links the visitor to the company with the host as usual host", visitors.get(vA.id).companies[0].hostName === "Hana Host");
check("check-in: notes the last visit", visitors.get(vA.id).lastVisitAt === Date.parse("2026-10-13T14:00:00Z"));
check("check-in: the host must be in that company", throwsStatus(() => visitors.checkIn({ visitorId: vB.id, siteId: ny.id, companyId: nyCo.id, hostId: other.id }), 400) === true);
check("check-in: the company must be at that site", throwsStatus(() => visitors.checkIn({ visitorId: vB.id, siteId: ny.id, companyId: ldnCo.id }), 400) === true);
const again = visitors.checkIn({ visitorId: vA.id, siteId: ny.id, companyId: nyCo.id });
check("check-in: someone already in gets their open visit back", again.already && again.visit.id === inNy.id);
check("visits: names are copied onto the visit", inNy.companyName === "Empire Co" && inNy.hostName === "Hana Host");

clockNow = Date.parse("2026-10-13T16:00:00Z");
check("end of day: nothing closes before closing time", clock.runEndOfDay() === 0);
clockNow = Date.parse("2026-10-13T16:31:00Z");
check("end of day: London closes at 17:30 local (16:30 UTC in BST)", clock.runEndOfDay() === 1 && visitors.getVisit(inLdn.id).checkoutMethod === "auto" && iso(visitors.getVisit(inLdn.id).checkedOutAt) === "2026-10-13T16:30:00.000Z");
check("end of day: New York is still open", visitors.getVisit(inNy.id).checkedOutAt === null);
clockNow = Date.parse("2026-10-15T10:00:00Z");
check("end of day: after a server outage, closed at the time it should have been", clock.runEndOfDay() === 1 && iso(visitors.getVisit(inNy.id).checkedOutAt) === "2026-10-13T22:00:00.000Z");
sites.update(ny.id, { endOfDay: "" });
visitors.checkIn({ visitorId: vA.id, siteId: ny.id, companyId: nyCo.id, now: clockNow });
clockNow += 3 * 24 * 3600 * 1000;
check("end of day: a site with it switched off keeps visits open", clock.runEndOfDay() === 0);

// --- retention -------------------------------------------------------------------------------

const kioskVisitor = visitors.create({ firstName: "Kim", lastName: "Kiosk" }, { source: "kiosk", verified: false });
visitors.checkIn({ visitorId: kioskVisitor.id, siteId: ldn.id, companyId: ldnCo.id, now: Date.parse("2025-01-10T10:00:00Z") });
visitors.checkOut(visitors.listVisits({ visitorId: kioskVisitor.id }).visits[0].id, { at: Date.parse("2025-01-10T11:00:00Z") });
clockNow = Date.parse("2026-10-20T12:00:00Z");
clock.saveSettings({ retentionMonths: 12 });
const preview = visitors.retentionPreview(clock.retentionCutoff());
check("retention: the preview counts what would go", preview.visits === 1 && preview.visitors === 1, JSON.stringify(preview));
const removed = clock.runRetention();
check("retention: old visits and unchecked kiosk visitors left with none are deleted", removed.visits === 1 && removed.visitors === 1 && !visitors.get(kioskVisitor.id));
check("retention: recent visits and open visits stay", visitors.listVisits({}).total === 3);
check("retention: a checked visitor stays even with no visits", (() => {
  const old = visitors.create({ firstName: "Olde", lastName: "Timer" });
  visitors.applyRetention(Date.parse("2020-01-01T00:00:00Z"));
  return Boolean(visitors.get(old.id));
})());
check("retention: months must be sensible", throwsStatus(() => clock.saveSettings({ retentionMonths: -1 }), 400) === true && throwsStatus(() => clock.saveSettings({ kioskIdleSeconds: 2 }), 400) === true);

// --- merge ------------------------------------------------------------------------------------

const dup = visitors.create({ firstName: "Ada", lastName: "Lovelace", phone: "555-0101" }, { source: "kiosk", verified: false });
visitors.checkIn({ visitorId: dup.id, siteId: ldn.id, companyId: ldnCo.id, now: clockNow });
const merged = visitors.merge(dup.id, vA.id);
const ada = visitors.get(vA.id);
check("merge: visits move across", merged.visitsMoved === 1 && visitors.listVisits({ visitorId: vA.id }).total === 3, `moved ${merged.visitsMoved}, total ${visitors.listVisits({ visitorId: vA.id }).total}`);
check("merge: links are combined", ada.companies.map((c) => c.companyName).sort().join() === "Empire Co,Thames Ltd");
check("merge: missing details are filled, existing ones kept", ada.phone === "555-0101" && ada.email === "ada@example.com");
check("merge: the duplicate is gone", !visitors.get(dup.id));
check("merge: not into itself", throwsStatus(() => visitors.merge(vA.id, vA.id), 400) === true);
check("names: the lookup sees changes straight away", visitors.findByName("Ada Lovelace").join() === String(vA.id));

// --- site limits and field access --------------------------------------------------------------

const ldnOnly = new Set([ldn.id]);
const nyOnly = new Set([ny.id]);
const listed = (sitesSet) => visitors.list({ sites: sitesSet }).records.map((r) => r.firstName).sort().join();
check("sites: a London account sees visitors linked to or visiting London", listed(ldnOnly) === "Ada,Alan");
check("sites: a New York account sees only those linked to New York companies", listed(nyOnly) === "Ada");
check("sites: links to companies elsewhere are left out", visitors.get(vA.id, { sites: nyOnly }).companies.map((c) => c.companyName).join() === "Empire Co");
check("sites: visits elsewhere are left out", visitors.listVisits({ sites: nyOnly, visitorId: vA.id }).visits.every((v) => v.siteId === ny.id));
check("sites: a visitor out of reach can't be opened", visitors.get(vB.id, { sites: nyOnly }) === null);
check("sites: a limited account must link a new visitor", throwsStatus(() => visitors.create({ firstName: "No", lastName: "Link" }, { sites: nyOnly }), 400) === true);
check("sites: nor link one to a company elsewhere", throwsStatus(() => visitors.setLink(vB.id, { companyId: ldnCo.id }, { sites: nyOnly }), 403) === true);
check("sites: checking out a visit elsewhere is refused", throwsStatus(() => visitors.checkOut(visitors.listVisits({ siteId: ldn.id, status: "open" }).visits[0].id, { sites: nyOnly }), 404) === true);
check("sites: here-now counts are per site", JSON.stringify(visitors.hereNow(nyOnly)) === JSON.stringify({ [ny.id]: 1 }));

const viewer = access.contextFor({ role: "viewer" });
const frontdesk = access.contextFor({ role: "frontdesk" });
const checkoutApi = access.contextFor({ role: "checkout" });
check("access: front desk can change visitors", access.fieldsFor(frontdesk, "visitor").find((f) => f.key === "email").access === "edit");
check("access: a viewer can only read them", access.fieldsFor(viewer, "visitor").find((f) => f.key === "email").access === "view");
check("access: Equipment Checkout sees no visitors", access.fieldsFor(checkoutApi, "visitor").length === 0);
check("access: nobody edits the last visit time", access.fieldsFor(access.contextFor({ role: "admin" }), "visitor").find((f) => f.key === "lastVisitAt").access === "view");
check("access: a viewer can't change a visitor", throwsStatus(() => access.checkWrite(viewer, "visitor", { firstName: "X" }, access.fieldsFor(viewer, "visitor")), 403) === true);
access.setPolicies([{ roleId: "frontdesk", entity: "visitor", field: "phone", access: "hidden" }]);
const fdSearch = access.searchable(access.contextFor({ role: "frontdesk" }), "visitor");
check("access: a search never looks in a hidden visitor field", !fdSearch.columns.includes("v.phone") && visitors.list({ q: "555-0101", search: fdSearch }).total === 0 && visitors.list({ q: "555-0101", search: access.searchable(access.contextFor({ role: "admin" }), "visitor") }).total === 1);
check("access: the kiosk has no column in the grid", !access.grid().roles.some((r) => r.id === "kiosk"));
check("access: visitor fields follow the visitors area, not the directory", throwsStatus(() => access.setPolicies([{ roleId: "viewer", entity: "visitor", field: "email", access: "edit" }]), 400) === true);

// --- kiosks -------------------------------------------------------------------------------------

const kiosks = createKiosks({ db });
const { kiosk, code } = kiosks.create({ name: "Lobby", siteId: ny.id });
check("kiosks: a pairing code looks like XXXX-XXXX with no look-alike letters", /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code));
check("kiosks: codes are forgiving about case and dashes", normaliseCode(` ${code.toLowerCase().replace("-", "")} `) === code);
check("kiosks: a wrong code pairs nothing", kiosks.pair("AAAA-AAAA") === null);
const paired = kiosks.pair(code.toLowerCase());
check("kiosks: the right code gives a token", paired && paired.token.length > 30 && kiosks.authenticate(paired.token).id === kiosk.id);
check("kiosks: a code works once", kiosks.pair(code) === null);
check("kiosks: the token itself isn't stored", !db.raw.prepare("SELECT token_hash FROM kiosks").get().token_hash.includes(paired.token));
const fresh = kiosks.newCode(kiosk.id);
check("kiosks: a new code signs the old device out", kiosks.authenticate(paired.token) === null && fresh.kiosk.status === "waiting");
check("kiosks: a site with a kiosk can't be removed", throwsStatus(() => sites.remove(ny.id), 409) === true);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
