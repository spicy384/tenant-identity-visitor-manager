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
const lapsed = directory.createPerson({ firstName: "Lee", lastName: "Lapsed", companyId: acme.id, clearanceLevel: L["TS//SCI FSP"].id });
const plain = directory.createPerson({ firstName: "Pat", lastName: "Plain", companyId: acme.id });
check("people: clearance fields are stored", directory.getPerson(guard.id).clearanceLevelName === "TS" && directory.getPerson(guard.id).clearanceGranted === "2024-01-10");
check("people: an unknown clearance level is refused", throwsStatus(() => directory.updatePerson(plain.id, { clearanceLevel: 9999 }), 400) === true);
check("people: a bad clearance date is refused", throwsStatus(() => directory.updatePerson(plain.id, { clearanceGranted: "next year" }), 400) === true);
check("people: an expiry date is no longer taken", directory.updatePerson(plain.id, { clearanceExpires: "2020-01-01" }).clearanceExpires === undefined);
const visitorTs = visitors.create({ firstName: "Vic", lastName: "Visitor", clearanceLevel: L.TS.id });
const visitorNone = visitors.create({ firstName: "Nora", lastName: "None" });
check("visitors: clearance fields are stored", visitors.get(visitorTs.id).clearanceLevelName === "TS");
check("validation: a clearance on record but not validated counts as none", clearance.effectiveLevel({ kind: "person", ...directory.getPerson(guard.id), clearanceLevelId: guard.clearanceLevel }) === null && directory.getPerson(guard.id).clearanceStatus === "unvalidated");
// Security validates what is on record (validate() sets the level, dates and when).
for (const [kind, rec] of [["person", guard], ["person", fsp], ["person", ci], ["person", lapsed], ["visitor", visitorTs]]) {
  clearance.validate({ kind, id: rec.id, levelId: rec.clearanceLevel, granted: rec.clearanceGranted, by: "security" });
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
check("type: a visitor badge goes to a person only lent for the day", (() => {
  const b = give(vUncl, "person", plain)();
  badges.takeBack(vUncl.id);
  return b.holder.temporary === true && b.holder.dueAt > Date.now() && b.holder.replacesNumber === null;
})());
check("type: a person's badge doesn't go to a visitor", throwsStatus(give(tUncl, "visitor", visitorNone), 409, /visitor badges/) === true);

check("clearance: FSP may hold a CI badge", Boolean(give(tCi, "person", fsp)()));
check("clearance: CI may not hold an FSP badge", throwsStatus(give(tFsp, "person", ci), 409, /clearance doesn't cover/) === true);
// Lee leaves: debriefed, and so uncleared from then on.
const debriefedLee = clearance.debrief({ kind: "person", id: lapsed.id, by: "security" });
check("clearance: a debriefed clearance counts as none", debriefedLee.from.name === "TS//SCI FSP" && debriefedLee.level === null && throwsStatus(give(tFsp, "person", lapsed), 409, /clearance doesn't cover/) === true);
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
check("history: a holder's badges, now and before", badges.forHolder("person", plain.id).length === 2 && badges.forHolder("person", plain.id)[0].outcome === "lost" && badges.forHolder("person", plain.id)[1].temporary);
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
const vSpare = make("V-SPARE", "visitor");
check("temporary: a badge can be marked temporary", tmp1.temporary === true && pTs.temporary === false);
check("temporary: not a visitor badge", throwsStatus(() => make("TMP-V", "visitor", null, { temporary: true }), 400) === true);
const forgetful = directory.createPerson({ firstName: "Fay", lastName: "Forgetful", companyId: acme.id, siteId: site.id, clearanceLevel: L.TS.id });
const lendable = (person) => badges.availableFor("person", person.id, { temporary: true });
check("temporary: offered to someone with no badge on record, the temporary stock first, then visitor badges",
  lendable(forgetful).filter((b) => b.type === "tenant").map((b) => b.number).sort().join() === "TMP-1,TMP-2" && lendable(forgetful).some((b) => b.type === "visitor")
  && lendable(forgetful).findIndex((b) => b.type === "visitor") > lendable(forgetful).findIndex((b) => b.temporary));
check("temporary: lent without a badge on record, in place of nothing", (() => {
  const b = badges.assign(tmp1.id, { kind: "person", holderId: forgetful.id });
  badges.takeBack(tmp1.id);
  return b.holder.temporary && b.holder.replacesNumber === null;
})());
const own = make("T-020", "tenant");
badges.assign(own.id, { kind: "person", holderId: forgetful.id }, { by: "desk" });
check("temporary: regular offers leave temporary badges out", !badges.availableFor("person", forgetful.id).some((b) => b.temporary));
check("temporary: offered within their clearance", lendable(forgetful).filter((b) => b.type === "tenant").map((b) => b.number).sort().join() === "TMP-1,TMP-2");
const lent = badges.assign(tmp1.id, { kind: "person", holderId: forgetful.id }, { by: "desk" });
const p = localParts(Date.now(), "America/New_York");
check("temporary: lent in place of their badge, due back at midnight where they work", lent.holder.temporary && lent.holder.replacesNumber === "T-020" && lent.holder.dueAt === zonedTime(p.year, p.month, p.day + 1, 0, 0, "America/New_York"), JSON.stringify(lent.holder));
check("temporary: their own badge stays theirs", badges.get(own.id).holder?.id === forgetful.id);
check("temporary: one at a time", throwsStatus(() => badges.assign(tmp2.id, { kind: "person", holderId: forgetful.id }), 409, /already has badge TMP-1 for the day/) === true);
check("temporary: a visitor badge counts as their one", throwsStatus(() => badges.assign(vSpare.id, { kind: "person", holderId: forgetful.id }), 409, /already has badge TMP-1/) === true
  && !lendable(forgetful).length);
check("temporary: the clearance rule still applies", throwsStatus(() => badges.assign(tmpSci.id, { kind: "person", holderId: guard.id }), 409) === true);
check("temporary: listed as out, not yet overdue", badges.list({ state: "temporary" }).badges.map((b) => b.number).join() === "TMP-1" && badges.overdueCount() === 0);
db.raw.prepare("UPDATE badge_assignments SET due_at = ? WHERE badge_id = ? AND returned_at IS NULL").run(Date.now() - 1000, tmp1.id);
check("temporary: not back by its time, it is overdue", badges.overdueCount() === 1 && badges.list({ state: "overdue" }).badges[0].holder.overdue === true);
check("temporary: overdue is counted per site too", badges.overdueCount(new Set([other.id])) === 1);
badges.takeBack(tmp1.id, {}, { by: "desk" });
check("temporary: taken back, nothing is overdue", badges.overdueCount() === 0 && badges.history(tmp1.id)[0].replacesNumber === "T-020");
const vLend = make("V-LEND", "visitor");
const vCleared = make("V-LEND-TS", "visitor", L["TS//SCI"]);
const vLent = badges.assign(vLend.id, { kind: "person", holderId: forgetful.id }, { by: "desk" });
check("lending a visitor badge: in place of their badge, due back at midnight", vLent.holder.temporary && vLent.holder.replacesNumber === "T-020" && vLent.holder.dueAt === zonedTime(p.year, p.month, p.day + 1, 0, 0, "America/New_York"));
check("lending a visitor badge: listed as out for the day, not as with a visitor who left", badges.list({ state: "temporary" }).badges.some((b) => b.number === "V-LEND") && !badges.list({ state: "left" }).badges.some((b) => b.number === "V-LEND"));
check("lending a visitor badge: never offered as their own badge", !badges.availableFor("person", plain.id).some((b) => b.type === "visitor"));
check("lending a visitor badge: building staff may borrow one too", lendable(guard).some((b) => b.number === "V-SPARE"));
check("lending a visitor badge: the clearance rule still applies", throwsStatus(() => badges.assign(vCleared.id, { kind: "person", holderId: plain.id }), 409) === true && !lendable(plain).some((b) => b.number === "V-LEND-TS"));
badges.takeBack(vLend.id);
check("lending a visitor badge: taken back, it is free for visitors again", badges.availableFor("visitor", visitorNone.id).some((b) => b.number === "V-LEND"));
check("temporary: can't stop being temporary while lent", (() => {
  badges.assign(tmp2.id, { kind: "person", holderId: forgetful.id });
  const r = throwsStatus(() => badges.update(tmp2.id, { temporary: false }), 409);
  badges.takeBack(tmp2.id);
  return r === true;
})());

// --- who sees clearances ---------------------------------------------------------------------
const fieldAccess = (role, entity, key) => access.fieldsFor(access.contextFor({ role }), entity).find((f) => f.key === key)?.access || "hidden";
check("access: managers see a person's clearance but can't change it", fieldAccess("manager", "person", "clearanceLevel") === "view" && fieldAccess("admin", "person", "clearanceGranted") === "view" && fieldAccess("admin", "person", "clearanceDebriefed") === "view"
  && fieldAccess("admin", "person", "clearanceExpires") === "hidden" && fieldAccess("frontdesk", "person", "clearanceDebriefed") === "hidden");
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
check("events: before one, a company from elsewhere isn't at the other site", visitors.companyHere(acme.id, other.id) === null);
const borrowed = events.create({ siteId: other.id, title: "Board meeting", date: day, companyId: acme.id, hostId: plain.id }, { by: "desk" });
check("events: a company may hold one at another site", borrowed.siteId === other.id && borrowed.companyName === "Acme Corp" && borrowed.hostName === "Pat Plain");
check("events: that day its guests check in there", visitors.checkIn({ visitorId: roamer.id, siteId: other.id, companyId: acme.id, hostId: plain.id }).visit.siteId === other.id);
const nextDay = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
events.update(borrowed.id, { date: nextDay });
check("events: on another day, not", visitors.companyHere(acme.id, other.id) === null);
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

// --- a debrief, and the badges still out ------------------------------------------------------
check("debrief: the badges still held that the new level doesn't cover are named", (() => {
  const dee = directory.createPerson({ firstName: "Dee", lastName: "Briefed", companyId: acme.id });
  clearance.validate({ kind: "person", id: dee.id, levelId: L["TS//SCI CI"].id, by: "security" });
  const high = make("D-CI", "tenant", L["TS//SCI CI"]);
  const low = make("D-TS", "tenant", L.TS, { facilityCode: "12" });
  const none = make("D-NONE", "tenant");
  for (const b of [high, low, none]) badges.assign(b.id, { kind: "person", holderId: dee.id }, { by: "desk" });
  const toTs = clearance.debrief({ kind: "person", id: dee.id, levelId: L.TS.id, by: "security" });
  const toNone = clearance.debrief({ kind: "person", id: dee.id, by: "security" });
  return toTs.badges.map((b) => `${b.label}:${b.levelName}`).join() === "D-CI:TS//SCI CI" && toNone.badges.map((b) => b.label).join() === "D-CI,12-D-TS"
    && badges.get(high.id).holder.name === "Dee Briefed";
})());

// --- a badge following its holder's validated clearance ---------------------------------------
{
  const mo = directory.createPerson({ firstName: "Mo", lastName: "Match", companyId: acme.id });
  clearance.validate({ kind: "person", id: mo.id, levelId: L["TS//SCI"].id, by: "security" });
  const own = make("M-OWN", "tenant", L["TS//SCI"], { facilityCode: "34" });
  const same = make("M-SAME", "tenant", L.TS);
  const lent = make("M-LENT", "tenant", null, { temporary: true });
  const pass = make("M-VIS", "visitor");
  for (const b of [own, same]) badges.assign(b.id, { kind: "person", holderId: mo.id }, { by: "desk" });
  check("match: a badge at the holder's level isn't out of step", badges.outOfStep([mo.id]).map((b) => b.label).join() === "M-SAME");
  clearance.validate({ kind: "person", id: mo.id, levelId: L.TS.id, by: "security" });
  badges.assign(lent.id, { kind: "person", holderId: mo.id }, { by: "desk" });
  const step = badges.outOfStep([mo.id, plain.id]);
  check("match: after a new validation, the person's own badge at another level is named", step.length === 1 && step[0].label === "34-M-OWN" && step[0].levelName === "TS//SCI" && step[0].holderName === "Mo Match" && step[0].type === "tenant");
  check("held: without the Security role, a held badge's level can't be changed by editing it", throwsStatus(() => badges.update(own.id, { clearanceLevelId: L.TS.id }), 409, /only the Security role/) === true
    && badges.get(own.id).clearanceLevelId === L["TS//SCI"].id);
  check("held: Security can't raise it above what the holder's clearance covers", throwsStatus(() => badges.update(own.id, { clearanceLevelId: L["TS//SCI CI"].id }, { security: true }), 409, /doesn't cover.*Validate their clearance first/) === true);
  check("held: nor change its type or whether it is temporary while it is out", throwsStatus(() => badges.update(own.id, { type: "personnel" }, { security: true }), 409, /take it back/) === true
    && throwsStatus(() => badges.update(own.id, { temporary: true }, { security: true }), 409, /take it back/) === true);
  check("held: Security changes the level of a badge a person holds, and it stays with them", (() => {
    // Mo is at TS: the badge can go anywhere up to that.
    const down = badges.update(same.id, { clearanceLevelId: L.Secret.id }, { security: true });
    const none = badges.update(same.id, { clearanceLevelId: null }, { security: true });
    const back = badges.update(same.id, { clearanceLevelId: L.TS.id, notes: "as issued" }, { security: true });
    return down.clearanceLevelId === L.Secret.id && none.clearanceLevelId === null && back.clearanceLevelId === L.TS.id && back.notes === "as issued" && back.holder.name === "Mo Match";
  })());
  check("held: never a badge a visitor holds, nor a visitor badge lent to a person", (() => {
    const visitorHeld = throwsStatus(() => badges.update(vTs.id, { clearanceLevelId: null }, { security: true }), 409, /take it back/) === true;
    // Lent to someone with no badge for the day yet (Mo has one).
    const forgot = directory.createPerson({ firstName: "Flo", lastName: "Forgot", companyId: acme.id });
    badges.assign(pass.id, { kind: "person", holderId: forgot.id }, { by: "desk" });
    const lentPass = throwsStatus(() => badges.update(pass.id, { clearanceLevelId: L.TS.id }, { security: true }), 409, /take it back/) === true;
    badges.takeBack(pass.id);
    return visitorHeld && lentPass && badges.get(vTs.id).holder.kind === "visitor";
  })());
  check("held: a badge lent to a person for the day can be changed by Security too", badges.update(lent.id, { clearanceLevelId: L.Secret.id }, { security: true }).clearanceLevelId === L.Secret.id
    && badges.update(lent.id, { clearanceLevelId: null }, { security: true }).clearanceLevelId === null);
  check("match: not a badge lent for the day, a visitor's badge, a free one, or one that doesn't exist", [lent.id, vTs.id, pass.id, 999999].every((id) => throwsStatus(() => badges.matchHolderLevel([id]), 404) === true)
    && throwsStatus(() => badges.matchHolderLevel([own.id, lent.id]), 404) === true && badges.get(own.id).clearanceLevelId === L["TS//SCI"].id);
  check("match: not for someone the caller can't see", throwsStatus(() => badges.matchHolderLevel([own.id], { canSee: () => false }), 404) === true);
  check("match: none chosen is refused", throwsStatus(() => badges.matchHolderLevel([]), 400) === true);
  const changed = badges.matchHolderLevel([own.id, same.id]);
  check("match: the badge takes its holder's validated level, and stays with them", changed.length === 1 && changed[0].label === "34-M-OWN" && changed[0].from === "TS//SCI" && changed[0].to === "TS" && changed[0].holderName === "Mo Match"
    && badges.get(own.id).clearanceLevelId === L.TS.id && badges.get(own.id).holder.name === "Mo Match" && badges.outOfStep([mo.id]).length === 0);
  clearance.validate({ kind: "person", id: mo.id, levelId: null, by: "security" });
  check("match: validated as uncleared, the badge can become uncleared too", badges.outOfStep([mo.id]).length === 2 && badges.matchHolderLevel([own.id])[0].to === null && badges.get(own.id).clearanceLevelId === null);
  // Someone whose clearance was never validated: nothing to match to.
  const raw = directory.createPerson({ firstName: "Rae", lastName: "Raw", companyId: acme.id });
  const rawBadge = make("M-RAW", "tenant");
  badges.assign(rawBadge.id, { kind: "person", holderId: raw.id }, { by: "desk" });
  db.raw.prepare("UPDATE people SET clearance_level_id = ? WHERE id = ?").run(L.TS.id, raw.id);
  check("match: not to a clearance Security hasn't validated", throwsStatus(() => badges.matchHolderLevel([rawBadge.id]), 409) === true && badges.get(rawBadge.id).clearanceLevelId === null);
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
