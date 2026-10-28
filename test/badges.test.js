/**
 * Badges, clearances and visitor events without HTTP: who may hold which badge (type,
 * building staff, clearance level and its expiry), assignment history, taking back and
 * losing, site limits, clearance field access, and expected guests' arrivals.
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
const { createClearance, today } = require("../clearance");
const { createBadges } = require("../badges");
const { createEvents } = require("../events");
const { zonedTime, localParts } = require("../visit-clock");

const { check, report } = createChecker("Badges, clearances and visitor events");
const throwsStatus = (fn, status, pattern = null) => {
  try { fn(); return false; } catch (error) { return error.status === status && (!pattern || pattern.test(error.message)) ? true : `${error.status}: ${error.message}`; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-badges-"));
const db = openDatabase({ dataDir: tmp, key: generateKey() });
const fields = createFields({ db });
const access = createAccess({ db, fields });
const sites = createSites({ db });
const directory = createDirectory({ db, fields });
const visitors = createVisitors({ db, fields });
const clearance = createClearance({ db });
const badges = createBadges({ db, clearance });
const events = createEvents({ db });

// --- clearance levels ---------------------------------------------------------------------
const levels = clearance.levels();
check("levels: the defaults, in order", levels.map((l) => l.name).join(" < ") === "Secret < TS < TS//SCI < TS//SCI CI < TS//SCI FSP");
const L = Object.fromEntries(levels.map((l) => [l.name, l]));
check("levels: higher covers lower", clearance.covers(L["TS//SCI FSP"], L["TS//SCI CI"]) && clearance.covers(L.TS, L.Secret) && clearance.covers(L.TS, L.TS));
check("levels: lower doesn't cover higher", !clearance.covers(L["TS//SCI CI"], L["TS//SCI FSP"]) && !clearance.covers(L.Secret, L.TS) && !clearance.covers(null, L.Secret));
check("levels: no level needed is covered by anyone", clearance.covers(null, null));
check("levels: Uncleared is built in, and no level takes its name", throwsStatus(() => clearance.createLevel({ name: "uncleared" }), 409) === true && throwsStatus(() => clearance.updateLevel(clearance.levels()[0].id, { name: "Uncleared" }), 409) === true);
check("levels: a duplicate name is refused", throwsStatus(() => clearance.createLevel({ name: "ts" }), 409) === true);
const conf = clearance.createLevel({ name: "Confidential", rank: 5 });
check("levels: a new one can go anywhere in the order", clearance.levels()[0].name === "Confidential");
clearance.removeLevel(conf.id);

// --- the building ---------------------------------------------------------------------------
const site = sites.create({ name: "Harbor Point", timeZone: "America/New_York" });
const other = sites.create({ name: "Riverside", timeZone: "America/New_York" });
const security = directory.createCompany({ name: "Harbor Security", buildingStaff: true, sites: [{ siteId: site.id }] });
const acme = directory.createCompany({ name: "Acme Corp", sites: [{ siteId: site.id }] });
check("companies: building staff is stored", directory.getCompany(security.id).buildingStaff === true && directory.getCompany(acme.id).buildingStaff === false);
const guard = directory.createPerson({ firstName: "Gail", lastName: "Guard", companyId: security.id, clearanceLevel: L.TS.id, clearanceGranted: "2024-01-10" });
const fsp = directory.createPerson({ firstName: "Fran", lastName: "Poly", companyId: acme.id, clearanceLevel: L["TS//SCI FSP"].id });
const ci = directory.createPerson({ firstName: "Cal", lastName: "Counter", companyId: acme.id, clearanceLevel: L["TS//SCI CI"].id });
const lapsed = directory.createPerson({ firstName: "Lee", lastName: "Lapsed", companyId: acme.id, clearanceLevel: L["TS//SCI FSP"].id, clearanceExpires: "2020-01-01" });
const plain = directory.createPerson({ firstName: "Pat", lastName: "Plain", companyId: acme.id });
check("people: clearance fields are stored", directory.getPerson(guard.id).clearanceLevelName === "TS" && directory.getPerson(guard.id).clearanceGranted === "2024-01-10");
check("people: an unknown clearance level is refused", throwsStatus(() => directory.updatePerson(plain.id, { clearanceLevel: 9999 }), 400) === true);
check("people: a bad clearance date is refused", throwsStatus(() => directory.updatePerson(plain.id, { clearanceExpires: "next year" }), 400) === true);
const visitorTs = visitors.create({ firstName: "Vic", lastName: "Visitor", clearanceLevel: L.TS.id });
const visitorNone = visitors.create({ firstName: "Nora", lastName: "None" });
check("visitors: clearance fields are stored", visitors.get(visitorTs.id).clearanceLevelName === "TS");
check("validation: a clearance on record but not validated counts as none", clearance.effectiveLevel({ kind: "person", ...directory.getPerson(guard.id), clearanceLevelId: guard.clearanceLevel }) === null && directory.getPerson(guard.id).clearanceStatus === "unvalidated");
// Security validates what is on record (validate() sets the level, dates and when).
for (const [kind, rec] of [["person", guard], ["person", fsp], ["person", ci], ["person", lapsed], ["visitor", visitorTs]]) {
  clearance.validate({ kind, id: rec.id, levelId: rec.clearanceLevel, granted: rec.clearanceGranted, expires: rec.clearanceExpires, by: "security" });
}
check("validation: validated, it is marked so", directory.getPerson(guard.id).clearanceStatus === "validated" && directory.getPerson(guard.id).clearanceValidatedBy === "security" && directory.getPerson(guard.id).clearanceGranted === "2024-01-10");

// --- badges -----------------------------------------------------------------------------------
const make = (number, type, level = null, extra = {}) => badges.create({ number, type, clearanceLevelId: level ? level.id : null, ...extra });
const pUncl = make("P-001", "personnel");
const pTs = make("P-002", "personnel", L.TS);
const tFsp = make("T-001", "tenant", L["TS//SCI FSP"]);
const tCi = make("T-002", "tenant", L["TS//SCI CI"]);
const tUncl = make("T-003", "tenant");
const vTs = make("V-001", "visitor", L.TS);
const vUncl = make("V-002", "visitor");
check("badges: without a level, Uncleared", make("X-1", "tenant").clearanceLevelId === null && badges.list({ levelId: "none", q: "X-1" }).total === 1 && badges.list({ levelId: "none", q: "P-002" }).total === 0);
check("badges: an unknown level is refused", throwsStatus(() => badges.create({ number: "X-2", type: "tenant", clearanceLevelId: 9999 }), 400) === true);
check("badges: a duplicate number is refused", throwsStatus(() => make("p-001", "tenant"), 409) === true);
check("badges: an unknown type is refused", throwsStatus(() => make("X-3", "contractor"), 400) === true);

const give = (badge, kind, holder) => () => badges.assign(badge.id, { kind, holderId: holder.id }, { by: "desk" });
check("type: a personnel badge goes to building staff", Boolean(give(pTs, "person", guard)()));
check("type: not to a tenant's person", throwsStatus(give(pUncl, "person", plain), 409, /building staff/) === true);
check("type: a tenant badge doesn't go to building staff", throwsStatus(give(tUncl, "person", guard), 409, /personnel badge/) === true);
check("type: a visitor badge doesn't go to a person", throwsStatus(give(vUncl, "person", plain), 409, /visitor badge/) === true);
check("type: a person's badge doesn't go to a visitor", throwsStatus(give(tUncl, "visitor", visitorNone), 409, /visitor badges/) === true);

check("clearance: FSP may hold a CI badge", Boolean(give(tCi, "person", fsp)()));
check("clearance: CI may not hold an FSP badge", throwsStatus(give(tFsp, "person", ci), 409, /clearance doesn't cover/) === true);
check("clearance: an expired clearance counts as none", throwsStatus(give(tFsp, "person", lapsed), 409, /has expired/) === true);
check("clearance: no clearance, no cleared badge", throwsStatus(give(tFsp, "person", plain), 409) === true);
check("clearance: anyone of the right type may hold an uncleared badge", Boolean(give(tUncl, "person", plain)()));
check("clearance: a cleared visitor may hold a cleared visitor badge", Boolean(give(vTs, "visitor", visitorTs)()));
check("clearance: an uncleared visitor may not", throwsStatus(() => badges.assign(vTs.id, { kind: "visitor", holderId: visitorNone.id }), 409) === true);

check("holding: a badge held can't be given again", throwsStatus(give(tCi, "person", ci), 409, /is with/) === true);
check("holding: the holder is named on the badge", badges.get(tCi.id).holder.name === "Fran Poly" && badges.get(tCi.id).holder.company === "Acme Corp");
check("available: only badges the holder may hold are offered", badges.availableFor("person", fsp.id).map((b) => b.number).join() === "T-001,X-1");
check("available: building staff are offered personnel badges", badges.availableFor("person", guard.id).map((b) => b.number).join() === "P-001");
check("available: a visitor is offered visitor badges their clearance covers", badges.availableFor("visitor", visitorNone.id).map((b) => b.number).join() === "V-002");

const back = badges.takeBack(tCi.id, { note: "end of contract" }, { by: "desk" });
check("taking back: the badge is free again", !back.badge.holder && back.from.name === "Fran Poly");
check("taking back: it can't be taken back twice", throwsStatus(() => badges.takeBack(tCi.id), 409) === true);
const lost = badges.takeBack(tUncl.id, { outcome: "lost" }, { by: "desk" });
check("lost: the badge is marked lost and can't be given", lost.badge.status === "lost" && throwsStatus(give(tUncl, "person", plain), 409, /lost/) === true);
const hist = badges.history(tCi.id);
check("history: who had it, when, given and taken back by whom", hist.length === 1 && hist[0].holderName === "Fran Poly" && hist[0].assignedBy === "desk" && hist[0].returnedBy === "desk" && hist[0].note === "end of contract" && hist[0].outcome === "returned");
check("history: a holder's badges, now and before", badges.forHolder("person", plain.id).length === 1 && badges.forHolder("person", plain.id)[0].outcome === "lost");
check("history: a badge with history can't be deleted", throwsStatus(() => badges.remove(tCi.id), 409, /retire/) === true);
check("changing: a held badge's level can't change", throwsStatus(() => badges.update(pTs.id, { clearanceLevelId: L.Secret.id }), 409) === true);
check("changing: nor can it be retired while held", throwsStatus(() => badges.update(pTs.id, { status: "retired" }), 409) === true);

const range = badges.createRange({ prefix: "B-", from: 1, to: 25, width: 4, type: "visitor" });
check("range: badges are numbered and padded", range.length === 25 && range[0].number === "B-0001" && range[24].number === "B-0025");
check("range: all or nothing", throwsStatus(() => badges.createRange({ prefix: "B-", from: 20, to: 30, width: 4, type: "visitor" }), 409) === true && !badges.list({ q: "B-0030" }).total);
check("range: at most 1,000 at once", throwsStatus(() => badges.createRange({ prefix: "Z", from: 1, to: 2000, type: "visitor" }), 400) === true);

// Visitor badges stay out until taken back, and are listed when their visitor has left.
const visit = visitors.checkIn({ visitorId: visitorNone.id, siteId: site.id, companyId: acme.id }).visit;
badges.assign(vUncl.id, { kind: "visitor", holderId: visitorNone.id, visitId: visit.id }, { by: "desk" });
check("left: a visitor in the building isn't counted", badges.leftCount() === 0 || badges.list({ state: "left" }).badges.every((b) => b.holder.id !== visitorNone.id));
visitors.checkOut(visit.id, { method: "staff" });
check("left: checking out doesn't take the badge back", badges.get(vUncl.id).holder?.id === visitorNone.id);
check("left: it is listed as out with a visitor who has left", badges.list({ state: "left" }).badges.some((b) => b.id === vUncl.id));

// Sites: a badge is valid at the sites listed for it, or everywhere; anyone may hold one.
const third = sites.create({ name: "Lakeside", timeZone: "America/New_York" });
const riverBadge = make("R-001", "tenant", null, { siteIds: [other.id] });
const twoSites = make("R-002", "tenant", null, { siteIds: [other.id, third.id] });
check("sites: a badge can be valid at several sites", twoSites.sites.map((x) => x.name).join() === "Lakeside,Riverside");
check("sites: a badge with no sites is valid everywhere", tCi.sites.length === 0);
check("sites: staff see badges valid at one of their sites", badges.list({ sites: new Set([third.id]) }).badges.some((b) => b.id === twoSites.id) && badges.get(twoSites.id, { sites: new Set([third.id]) }) !== null);
check("sites: and not badges valid only elsewhere", !badges.list({ sites: new Set([site.id]) }).badges.some((b) => b.id === riverBadge.id) && badges.get(riverBadge.id, { sites: new Set([site.id]) }) === null);
check("sites: badges valid everywhere are seen by all", badges.list({ sites: new Set([site.id]) }).badges.some((b) => b.id === tCi.id));
check("sites: anyone may be given a badge, whatever site they work at", Boolean(badges.assign(riverBadge.id, { kind: "person", holderId: plain.id })));
badges.takeBack(riverBadge.id);
check("sites: the site filter finds badges valid there, and those valid everywhere", badges.list({ siteId: third.id }).badges.some((b) => b.id === twoSites.id) && badges.list({ siteId: third.id }).badges.some((b) => b.id === tCi.id) && !badges.list({ siteId: third.id }).badges.some((b) => b.id === riverBadge.id));
check("sites: a limited account must make a badge valid at one of its sites", throwsStatus(() => badges.create({ number: "S-1", type: "tenant" }, { sites: new Set([site.id]) }), 403) === true);
check("sites: nor at a site it doesn't see", throwsStatus(() => badges.create({ number: "S-1", type: "tenant", siteIds: [other.id] }, { sites: new Set([site.id]) }), 403) === true);
const limitedEdit = badges.update(twoSites.id, { siteIds: [] }, { sites: new Set([other.id, site.id]) });
check("sites: a limited account changing sites keeps those it doesn't see", limitedEdit.sites.map((x) => x.name).join() === "Lakeside");
check("sites: a site with badges valid there can't be removed", throwsStatus(() => sites.remove(third.id), 409) === true);
check("sites: an unknown site is refused", throwsStatus(() => badges.create({ number: "S-9", type: "tenant", siteIds: [9999] }), 400) === true);

// --- temporary badges ----------------------------------------------------------------------------
const tmp1 = make("TMP-1", "tenant", null, { temporary: true });
const tmp2 = make("TMP-2", "tenant", null, { temporary: true });
const tmpSci = make("TMP-S", "tenant", L["TS//SCI"], { temporary: true });
check("temporary: a badge can be marked temporary", tmp1.temporary === true && pTs.temporary === false);
check("temporary: not a visitor badge", throwsStatus(() => make("TMP-V", "visitor", null, { temporary: true }), 400) === true);
const forgetful = directory.createPerson({ firstName: "Fay", lastName: "Forgetful", companyId: acme.id, siteId: site.id, clearanceLevel: L.TS.id });
check("temporary: only for someone who holds a badge of their own", throwsStatus(() => badges.assign(tmp1.id, { kind: "person", holderId: forgetful.id }), 409, /doesn't hold a badge/) === true);
check("temporary: not offered to someone without a badge", badges.availableFor("person", forgetful.id, { temporary: true }).length === 0);
const own = make("T-020", "tenant");
badges.assign(own.id, { kind: "person", holderId: forgetful.id }, { by: "desk" });
check("temporary: regular offers leave temporary badges out", !badges.availableFor("person", forgetful.id).some((b) => b.temporary));
check("temporary: offered once they hold one, within their clearance", badges.availableFor("person", forgetful.id, { temporary: true }).map((b) => b.number).sort().join() === "TMP-1,TMP-2");
const lent = badges.assign(tmp1.id, { kind: "person", holderId: forgetful.id }, { by: "desk" });
const p = localParts(Date.now(), "America/New_York");
check("temporary: lent in place of their badge, due back at midnight where they work", lent.holder.temporary && lent.holder.replacesNumber === "T-020" && lent.holder.dueAt === zonedTime(p.year, p.month, p.day + 1, 0, 0, "America/New_York"), JSON.stringify(lent.holder));
check("temporary: their own badge stays theirs", badges.get(own.id).holder?.id === forgetful.id);
check("temporary: one at a time", throwsStatus(() => badges.assign(tmp2.id, { kind: "person", holderId: forgetful.id }), 409, /already has temporary badge TMP-1/) === true);
check("temporary: the clearance rule still applies", throwsStatus(() => badges.assign(tmpSci.id, { kind: "person", holderId: guard.id }), 409) === true);
check("temporary: listed as out, not yet overdue", badges.list({ state: "temporary" }).badges.map((b) => b.number).join() === "TMP-1" && badges.overdueCount() === 0);
db.raw.prepare("UPDATE badge_assignments SET due_at = ? WHERE badge_id = ? AND returned_at IS NULL").run(Date.now() - 1000, tmp1.id);
check("temporary: not back by its time, it is overdue", badges.overdueCount() === 1 && badges.list({ state: "overdue" }).badges[0].holder.overdue === true);
check("temporary: overdue is counted per site too", badges.overdueCount(new Set([other.id])) === 1);
badges.takeBack(tmp1.id, {}, { by: "desk" });
check("temporary: taken back, nothing is overdue", badges.overdueCount() === 0 && badges.history(tmp1.id)[0].replacesNumber === "T-020");
check("temporary: can't stop being temporary while lent", (() => {
  badges.assign(tmp2.id, { kind: "person", holderId: forgetful.id });
  const r = throwsStatus(() => badges.update(tmp2.id, { temporary: false }), 409);
  badges.takeBack(tmp2.id);
  return r === true;
})());

// --- who sees clearances ---------------------------------------------------------------------
const fieldAccess = (role, entity, key) => access.fieldsFor(access.contextFor({ role }), entity).find((f) => f.key === key)?.access || "hidden";
check("access: managers see a person's clearance but can't change it", fieldAccess("manager", "person", "clearanceLevel") === "view" && fieldAccess("admin", "person", "clearanceExpires") === "view");
check("access: Security sees it (and sets it only by validating)", fieldAccess("security", "person", "clearanceLevel") === "view" && fieldAccess("security", "visitor", "clearanceLevel") === "view");
check("access: read-only roles don't see it by default", fieldAccess("frontdesk", "person", "clearanceLevel") === "hidden" && fieldAccess("viewer", "person", "clearanceExpires") === "hidden");
check("access: Equipment Checkout doesn't get it", fieldAccess("checkout", "person", "clearanceLevel") === "hidden");
check("access: front desk doesn't see a visitor's clearance (it doesn't see clearance levels)", fieldAccess("frontdesk", "visitor", "clearanceLevel") === "hidden");
check("access: everyone who reads the directory sees the validation tag", fieldAccess("viewer", "person", "clearanceStatus") === "view" && fieldAccess("frontdesk", "visitor", "clearanceStatus") === "view");
check("access: nobody can be given edit on a clearance in the grid", throwsStatus(() => access.setPolicies([{ roleId: "manager", entity: "person", field: "clearanceLevel", access: "edit" }]), 400) === true);
check("access: the grid can't show it to a role that doesn't see clearance levels", throwsStatus(() => access.setPolicies([{ roleId: "frontdesk", entity: "person", field: "clearanceLevel", access: "view" }]), 400, /Settings > Roles/) === true);
access.updateRole("frontdesk", { clearances: true });
check("access: once the role sees clearance levels, the grid can show it", access.setPolicies([{ roleId: "frontdesk", entity: "person", field: "clearanceLevel", access: "view" }]) === 1 && fieldAccess("frontdesk", "person", "clearanceLevel") === "view");
access.updateRole("frontdesk", { clearances: false });
check("access: and turning it off hides it again, whatever the grid says", fieldAccess("frontdesk", "person", "clearanceLevel") === "hidden");
check("roles: Security always sees clearance levels", throwsStatus(() => access.updateRole("security", { clearances: false }), 400) === true && access.getRole("security").clearances === true);
check("roles: who sees clearance levels to start with", ["admin", "manager", "security"].every((id) => access.getRole(id).clearances) && !["frontdesk", "viewer", "kiosk", "checkout"].some((id) => access.getRole(id).clearances));
check("roles: a new role doesn't, unless asked", !access.createRole({ name: "Desk two", badges: "edit" }).clearances && access.createRole({ name: "Supervisors", clearances: true }).clearances);
check("roles: badge access per role", access.getRole("frontdesk").badges === "edit" && access.getRole("viewer").badges === "read" && access.getRole("checkout").badges === "none");
check("roles: a new role can be given badge access", access.createRole({ name: "Badge office", directory: "read", visitors: "none", badges: "edit" }).badges === "edit");
check("roles: badge access must be a known level", throwsStatus(() => access.createRole({ name: "Odd", badges: "sometimes" }), 400) === true);
const listed = access.project(access.contextFor({ role: "admin" }), "person", directory.getPerson(fsp.id), access.fieldsFor(access.contextFor({ role: "admin" }), "person"));
check("projection: the clearance comes with its name", listed.clearanceLevel === L["TS//SCI FSP"].id && listed.clearanceLevelName === "TS//SCI FSP");

// --- visitor events -----------------------------------------------------------------------------------
const day = today("America/New_York");
const meeting = events.create({ siteId: site.id, title: "Quarterly review", date: day, startTime: "10:00", companyId: acme.id, hostId: plain.id }, { by: "desk" });
check("events: added with company and host", meeting.companyName === "Acme Corp" && meeting.hostName === "Pat Plain");
check("events: the host must be in the company", throwsStatus(() => events.create({ siteId: site.id, title: "X", date: day, companyId: acme.id, hostId: guard.id }), 400) === true);
check("events: a bad time is refused", throwsStatus(() => events.create({ siteId: site.id, title: "X", date: day, startTime: "25:00" }), 400) === true);
check("events: a limited account only adds them at its sites", throwsStatus(() => events.create({ siteId: other.id, title: "X", date: day }, { sites: new Set([site.id]) }), 403) === true);
const guest = visitors.create({ firstName: "Gus", lastName: "Guest" });
events.addGuest(meeting.id, guest.id);
events.addGuest(meeting.id, guest.id);
check("events: a guest is added once", events.get(meeting.id).guests.length === 1 && events.get(meeting.id).guests[0].status === "expected");
check("expected: today's event is offered at that site", events.expectedToday(guest.id, site.id)[0]?.companyName === "Acme Corp" && events.expectedToday(guest.id, site.id)[0]?.hostName === "Pat Plain");
check("expected: not at another site", events.expectedToday(guest.id, other.id).length === 0);
check("expected: counted for the navigation", events.expectedCount() === 1 && events.expectedCount(new Set([other.id])) === 0);
const arrival = visitors.checkIn({ visitorId: guest.id, siteId: site.id, companyId: acme.id }).visit;
check("arrival: checking in notes the arrival against the event", events.get(meeting.id).guests[0].status === "here" && events.get(meeting.id).guests[0].visitId === arrival.id);
check("arrival: no longer expected", events.expectedToday(guest.id, site.id).length === 0 && events.expectedCount() === 0);
visitors.checkOut(arrival.id, { method: "staff" });
check("arrival: and shows when they left", events.get(meeting.id).guests[0].status === "left");
const tomorrow = events.create({ siteId: site.id, title: "Tomorrow", date: "2099-01-01" });
events.addGuest(tomorrow.id, visitorTs.id);
visitors.checkIn({ visitorId: visitorTs.id, siteId: site.id, companyId: acme.id });
check("arrival: checking in today doesn't count for another day's event", events.get(tomorrow.id).guests[0].status === "expected");
check("events: listed by day", events.list({ from: day }).map((e) => e.title).join() === "Quarterly review" && events.list({ from: "2099-01-01" }).length === 1);

// A tenant using another site's room: the event may be there, and on its date the company
// counts as at that site for checking in.
const roamer = visitors.create({ firstName: "Rory", lastName: "Roamer" });
check("events: before one, a company from elsewhere can't be visited at the other site", throwsStatus(() => visitors.checkIn({ visitorId: roamer.id, siteId: other.id, companyId: acme.id }), 400) === true);
const borrowed = events.create({ siteId: other.id, title: "Board meeting", date: day, companyId: acme.id, hostId: plain.id }, { by: "desk" });
check("events: a company may hold one at another site", borrowed.siteId === other.id && borrowed.companyName === "Acme Corp" && borrowed.hostName === "Pat Plain");
check("events: that day its guests check in there", visitors.checkIn({ visitorId: roamer.id, siteId: other.id, companyId: acme.id, hostId: plain.id }).visit.siteId === other.id);
const nextDay = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
events.update(borrowed.id, { date: nextDay });
const latecomer = visitors.create({ firstName: "Lee", lastName: "Latecomer" });
check("events: on another day, not", throwsStatus(() => visitors.checkIn({ visitorId: latecomer.id, siteId: other.id, companyId: acme.id }), 400) === true);
events.remove(borrowed.id);
const merged = visitors.create({ firstName: "Gus", lastName: "Guest", phone: "555" });
const late = events.create({ siteId: site.id, title: "Later", date: "2099-02-02" });
events.addGuest(late.id, merged.id);
visitors.merge(merged.id, guest.id);
check("merge: a merged visitor's events follow them", events.get(late.id).guests.map((g) => g.visitorId).join() === String(guest.id));


// --- expiry dates -------------------------------------------------------------------------------------------
const dayFromNow = (n) => today(undefined, Date.now() + n * 86400000);
check("expiry: a real date or none", throwsStatus(() => badges.create({ number: "E-0", type: "tenant", expiresOn: "2027-02-30" }), 400) === true
  && throwsStatus(() => badges.create({ number: "E-0", type: "tenant", expiresOn: "soon" }), 400) === true);
const eSoon = badges.create({ number: "E-1", type: "tenant", expiresOn: dayFromNow(10) });
const eToday = badges.create({ number: "E-2", type: "visitor", expiresOn: dayFromNow(0) });
const ePast = badges.create({ number: "E-3", type: "personnel", expiresOn: dayFromNow(-1) });
const eLater = badges.create({ number: "E-4", type: "tenant", expiresOn: dayFromNow(45) });
const eRetired = badges.create({ number: "E-5", type: "tenant", expiresOn: dayFromNow(-3) });
badges.update(eRetired.id, { status: "retired" });
check("expiry: any type of badge may have one", eSoon.expiresOn === dayFromNow(10) && eToday.type === "visitor" && ePast.type === "personnel");
check("expiry: good through its day, expired after", eToday.expired === false && ePast.expired === true && eSoon.expired === false);
check("expiry: an expired badge isn't given out", throwsStatus(() => badges.assign(ePast.id, { kind: "person", holderId: guard.id }), 409, /expired on/) === true);
check("expiry: nor offered", !badges.availableFor("person", guard.id).some((b) => b.number === "E-3") && badges.availableFor("visitor", visitorNone.id).some((b) => b.number === "E-2"));
const nums = (state) => badges.list({ state, limit: 5000 }).badges.map((b) => b.number).filter((n) => n.startsWith("E-")).sort().join();
check("expiry: expiring within 30 days (today's too)", nums("expiring") === "E-1,E-2", nums("expiring"));
check("expiry: expired (not counting retired badges)", nums("expired") === "E-3", nums("expired"));
check("expiry: within other days", badges.list({ state: "expiring", expiringDays: 60, limit: 5000 }).badges.some((b) => b.number === "E-4"));
check("expiry: renewed, it can be given again", badges.update(ePast.id, { expiresOn: dayFromNow(365) }).expired === false && Boolean(badges.assign(ePast.id, { kind: "person", holderId: guard.id })));
check("expiry: a held badge's date can change", badges.update(ePast.id, { expiresOn: dayFromNow(-1) }).expired === true && badges.get(ePast.id).holder.name === "Gail Guard");
check("expiry: and taken away", badges.update(eSoon.id, { expiresOn: null }).expiresOn === null && badges.update(eLater.id, { expiresOn: "" }).expiresOn === null);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
