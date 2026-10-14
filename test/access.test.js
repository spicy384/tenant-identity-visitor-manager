/**
 * Who sees what: the projection every response goes through, the field access grid,
 * site limits, search over visible fields only, and refused writes. The most important
 * tests in the project: a mistake here shows someone data they should not see.
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

const { check, report } = createChecker("Access: field visibility, site limits, search, writes");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-access-"));
const db = openDatabase({ dataDir: tmp, key: generateKey() });
const fields = createFields({ db });
const access = createAccess({ db, fields });
const sites = createSites({ db });
const directory = createDirectory({ db, fields });

const A = sites.create({ name: "Alpha Tower", timeZone: "America/New_York" });
const B = sites.create({ name: "Beta Plaza", timeZone: "Europe/London" });

const ctx = (role, siteIds = null) => access.contextFor({ role, sites: siteIds });
const admin = ctx("admin");
const manager = ctx("manager");
const frontdesk = ctx("frontdesk");
const viewer = ctx("viewer");
const kiosk = ctx("kiosk");
const checkout = ctx("checkout");
const managerA = ctx("manager", [A.id]);

/** Writes the way server.js does: field check first, then the directory. */
function plan(c, entity, body, recordId = null) {
  const list = access.fieldsFor(c, entity, { recordId });
  return { custom: access.checkWrite(c, entity, body, list), editable: list.filter((f) => f.access === "edit"), callerSites: c.sites };
}
const createCompany = (c, body) => directory.createCompany(body, plan(c, "company", body));
const createPerson = (c, body) => directory.createPerson(body, plan(c, "person", body));
const updatePerson = (c, id, body) => directory.updatePerson(id, body, plan(c, "person", body, id));
const updateCompany = (c, id, body) => directory.updateCompany(id, body, plan(c, "company", body, id));
const personAs = (c, id) => {
  const r = directory.getPerson(id, { sites: c.sites });
  return r && access.project(c, "person", r, access.fieldsFor(c, "person", { recordId: id }));
};
const companyAs = (c, id) => {
  const r = directory.getCompany(id, { sites: c.sites });
  return r && access.project(c, "company", r, access.fieldsFor(c, "company", { recordId: id }));
};
const throwsStatus = (fn, status) => {
  try { fn(); return false; } catch (error) { return error.status === status ? true : `${error.status}: ${error.message}`; }
};

// --- custom fields -------------------------------------------------------------------------

const salary = fields.create({ entity: "person", label: "Salary", type: "number" });
access.initCustomField(salary, "admins");
const parking = fields.create({ entity: "person", label: "Parking space", type: "text" });
access.initCustomField(parking, "all");
const badge = fields.create({ entity: "company", label: "Badge colour", type: "choice", choices: ["Red", "Blue"] });
access.initCustomField(badge, "editors");

const acme = createCompany(admin, { name: "Acme Corp", email: "hello@acme.example", sites: [{ siteId: A.id, suite: "Suite 100" }], custom: { badge_colour: "red" } });
const beta = createCompany(admin, { name: "Beta LLC", sites: [{ siteId: B.id, suite: "Floor 3" }] });
const both = createCompany(admin, { name: "Both Partners", sites: [{ siteId: A.id, suite: "Suite 200" }, { siteId: B.id, suite: "Suite 9" }] });

const jane = createPerson(admin, { firstName: "Jane", lastName: "Doe", companyId: acme.id, siteId: A.id, email: "jane@acme.example", mobile: "555-0100", jobTitle: "Director", notes: "Allergic to peanuts", custom: { salary: "95000", parking_space: "P-12" } });
const bob = createPerson(admin, { firstName: "Bob", lastName: "Bee", companyId: both.id, siteId: B.id, email: "bob@both.example" });
const cara = createPerson(admin, { firstName: "Cara", lastName: "Sea", companyId: both.id, email: "cara@both.example" });
const dan = createPerson(admin, { firstName: "Dan", lastName: "Beta", companyId: beta.id });

check("choice values are stored as the defined choice", companyAs(admin, acme.id).custom.badge_colour === "Red");

// --- what each role sees ---------------------------------------------------------------------

const asAdmin = personAs(admin, jane.id);
check("administrators see every field, custom ones included", asAdmin.email && asAdmin.mobile && asAdmin.notes && asAdmin.custom.salary === 95000 && asAdmin.custom.parking_space === "P-12");

const asManager = personAs(manager, jane.id);
check("a field made visible to administrators only is absent for a manager", !("salary" in asManager.custom), JSON.stringify(asManager.custom));
check("a field visible to everyone is there for a manager", asManager.custom.parking_space === "P-12");
check("a viewer sees built-in fields", personAs(viewer, jane.id).email === "jane@acme.example");
check("a viewer doesn't see the administrators-only field", !("salary" in personAs(viewer, jane.id).custom));
check("an editors-only company field is absent for a viewer", !("badge_colour" in companyAs(viewer, acme.id).custom));
check("...and present for a manager", companyAs(manager, acme.id).custom.badge_colour === "Red");

const asCheckout = personAs(checkout, jane.id);
check("Equipment Checkout gets name, company, job title, email, work phone by default", asCheckout.firstName === "Jane" && asCheckout.companyName === "Acme Corp" && asCheckout.jobTitle === "Director" && asCheckout.email === "jane@acme.example");
check("Equipment Checkout doesn't get mobile, notes or custom fields by default", !("mobile" in asCheckout) && !("notes" in asCheckout) && Object.keys(asCheckout.custom).length === 0, JSON.stringify(asCheckout));

const asKiosk = personAs(kiosk, jane.id);
check("the kiosk gets names, company and whether they host", asKiosk.firstName === "Jane" && asKiosk.lastName === "Doe" && asKiosk.companyName === "Acme Corp" && asKiosk.canHost === true);
check("the kiosk gets no contact details", !("email" in asKiosk) && !("mobile" in asKiosk) && !("workPhone" in asKiosk) && !("jobTitle" in asKiosk));
check("the kiosk sees a company's name but not its email", companyAs(kiosk, acme.id).name === "Acme Corp" && !("email" in companyAs(kiosk, acme.id)));

// --- the grid ---------------------------------------------------------------------------------

check("a locked field can't be hidden", throwsStatus(() => access.setPolicies([{ roleId: "viewer", entity: "person", field: "firstName", access: "hidden" }]), 400) === true);
check("a read-only role can't be given edit", throwsStatus(() => access.setPolicies([{ roleId: "viewer", entity: "person", field: "email", access: "edit" }]), 400) === true);
check("the kiosk can't be given edit", throwsStatus(() => access.setPolicies([{ roleId: "kiosk", entity: "person", field: "email", access: "edit" }]), 400) === true);
check("administrators have no column to change", throwsStatus(() => access.setPolicies([{ roleId: "admin", entity: "person", field: "email", access: "hidden" }]), 400) === true);
check("an unknown field is refused", throwsStatus(() => access.setPolicies([{ roleId: "viewer", entity: "person", field: "custom:9999", access: "view" }]), 400) === true);

access.setPolicies([{ roleId: "frontdesk", entity: "person", field: "email", access: "hidden" }, { roleId: "checkout", entity: "person", field: "mobile", access: "view" }]);
const fdCtx = ctx("frontdesk");
check("hiding email from Front desk removes it from what they get", !("email" in personAs(fdCtx, jane.id)));
check("the grid reports the change", access.grid().entities.person.find((f) => f.key === "email").access.frontdesk === "hidden");
check("adding mobile to Equipment Checkout's column takes effect", personAs(ctx("checkout"), jane.id).mobile === "555-0100");

// --- search only looks where the caller can see -------------------------------------------------

const find = (c, q) => directory.listPeople({ q, search: access.searchable(c, "person"), sites: c.sites }).records.map((r) => r.firstName);
check("a manager finds someone by email", find(manager, "jane@acme").includes("Jane"));
check("Front desk, with email hidden, can't find someone by their email", find(fdCtx, "jane@acme").length === 0);
check("Front desk still finds them by name", find(fdCtx, "Jane").includes("Jane"));
check("an administrator finds someone by a custom value", find(admin, "95000").includes("Jane"));
check("a manager can't find someone by a value hidden from them (salary)", find(manager, "95000").length === 0);
check("a viewer finds someone by a custom value they can see", find(viewer, "P-12").includes("Jane"));
check("search words all have to match", find(admin, "Jane Bee").length === 0 && find(admin, "Bob Bee").includes("Bob"));
check("a LIKE wildcard in a search is taken literally", find(admin, "%").length === 0 && find(admin, "_").length === 0);
check("the kiosk can't find someone by notes", find(kiosk, "peanuts").length === 0 && find(admin, "peanuts").includes("Jane"));

// --- writes -------------------------------------------------------------------------------------

check("a viewer can't change anything", throwsStatus(() => updatePerson(viewer, jane.id, { jobTitle: "CEO" }), 403) === true);
check("Front desk (read-only directory) can't change anything", throwsStatus(() => updatePerson(fdCtx, jane.id, { jobTitle: "CEO" }), 403) === true);
check("a manager can't write a field hidden from them, and is told it isn't there (not that it is hidden)", throwsStatus(() => updatePerson(manager, jane.id, { custom: { salary: "1" } }), 400) === true);
check("...and the value is untouched", personAs(admin, jane.id).custom.salary === 95000);
check("a manager can write a field they can edit", updatePerson(manager, jane.id, { custom: { parking_space: "P-14" } }) && personAs(admin, jane.id).custom.parking_space === "P-14");
check("an unknown custom key is refused", throwsStatus(() => updatePerson(manager, jane.id, { custom: { nonsense: "x" } }), 400) === true);
check("a bad value for a typed field is refused", throwsStatus(() => updatePerson(admin, jane.id, { custom: { salary: "lots" } }), 400) === true);
check("an empty value clears a custom field", updatePerson(admin, jane.id, { custom: { parking_space: "" } }) && !("parking_space" in personAs(admin, jane.id).custom));

access.setPolicies([{ roleId: "manager", entity: "person", field: "jobTitle", access: "view" }]);
check("a field set read-only for managers can't be changed by one", throwsStatus(() => updatePerson(ctx("manager"), jane.id, { jobTitle: "CEO" }), 403) === true);
access.setPolicies([{ roleId: "manager", entity: "person", field: "jobTitle", access: "edit" }]);

// --- site limits ----------------------------------------------------------------------------------

const companiesA = directory.listCompanies({ sites: managerA.sites, includeInactive: true }).records.map((r) => r.name);
check("a manager limited to Alpha sees companies at Alpha", companiesA.includes("Acme Corp") && companiesA.includes("Both Partners"));
check("...and not companies only at Beta", !companiesA.includes("Beta LLC"));
check("...and can't open one by id", directory.getCompany(beta.id, { sites: managerA.sites }) === null);
const peopleA = directory.listPeople({ sites: managerA.sites, includeInactive: true }).records.map((r) => r.firstName);
check("people at Alpha, or at any site of an Alpha company, are visible", peopleA.includes("Jane") && peopleA.includes("Cara"));
check("someone at Beta in a company at both sites is not", !peopleA.includes("Bob"));
check("someone in a Beta-only company is not", !peopleA.includes("Dan"));
check("a hidden person can't be opened by id", directory.getPerson(bob.id, { sites: managerA.sites }) === null);
const bothForA = companyAs(managerA, both.id);
check("a company's people count leaves out people at sites the caller can't see", directory.getCompany(both.id, { sites: managerA.sites }).people === 1 && directory.getCompany(both.id).people === 2);
check("...in lists too", directory.listCompanies({ sites: managerA.sites }).records.find((r) => r.id === both.id).people === 1);
check("a company's sites outside the caller's limit are left out",bothForA.sites.length === 1 && bothForA.sites[0].siteName === "Alpha Tower");

updateCompany(managerA, both.id, { sites: [{ siteId: A.id, suite: "Suite 250" }] });
const bothAfter = companyAs(admin, both.id);
check("changing sites keeps the ones the caller can't see", bothAfter.sites.length === 2 && bothAfter.sites.find((s) => s.siteId === A.id).suite === "Suite 250" && bothAfter.sites.find((s) => s.siteId === B.id).suite === "Suite 9");
check("a limited manager can't put a company at another site", throwsStatus(() => createCompany(managerA, { name: "Sneaky", sites: [{ siteId: B.id }] }), 403) === true);
check("a limited manager must place a new company at one of their sites", throwsStatus(() => createCompany(managerA, { name: "Nowhere" }), 400) === true);
const eve = createPerson(managerA, { firstName: "Eve", lastName: "Ng", companyId: both.id });
check("a person added by a limited manager is pinned to their site", eve.siteId === A.id);
check("a limited manager can't add someone to a company they can't see", throwsStatus(() => createPerson(managerA, { firstName: "X", lastName: "Y", companyId: beta.id }), 400) === true);
check("a limited manager can't move someone to a site they can't see", throwsStatus(() => updatePerson(managerA, eve.id, { siteId: B.id }), 403) === true);
check("a site filter narrows to one site", directory.listCompanies({ siteId: B.id }).records.map((r) => r.name).sort().join() === "Beta LLC,Both Partners");

updateCompany(admin, both.id, { sites: [{ siteId: A.id }] });
check("a person tied to a site the company left is no longer tied to one", directory.getPerson(bob.id).siteId === null);

// --- one-record and required fields ------------------------------------------------------------------

const dock = fields.create({ entity: "company", label: "Loading dock", type: "text", recordId: acme.id });
access.initCustomField(dock, "all");
updateCompany(manager, acme.id, { custom: { loading_dock: "Dock 4" } });
check("a one-record field shows on its record", companyAs(manager, acme.id).custom.loading_dock === "Dock 4");
check("...and not on others", !access.fieldsFor(manager, "company", { recordId: beta.id }).some((f) => f.apiKey === "loading_dock"));
check("...and can't be written on others", throwsStatus(() => updateCompany(manager, beta.id, { custom: { loading_dock: "x" } }), 400) === true);
check("one-record fields aren't searchable", !access.searchable(admin, "company").fieldIds.includes(dock.id));
fields.update(dock.id, { promote: true });
check("promoted, it shows on every record and keeps its value", access.fieldsFor(manager, "company", { recordId: beta.id }).some((f) => f.apiKey === "loading_dock") && companyAs(manager, acme.id).custom.loading_dock === "Dock 4");

const centre = fields.create({ entity: "company", label: "Cost centre", type: "text", required: true });
access.initCustomField(centre, "all");
check("a required field must be filled when adding a record", throwsStatus(() => createCompany(manager, { name: "Gamma", sites: [{ siteId: A.id }] }), 400) === true);
check("...and can't be cleared later", (() => {
  const g = createCompany(manager, { name: "Gamma", sites: [{ siteId: A.id }], custom: { cost_centre: "CC-1" } });
  return throwsStatus(() => updateCompany(manager, g.id, { custom: { cost_centre: "" } }), 400) === true;
})());
check("...but records saved before it existed can still be edited", Boolean(updateCompany(manager, beta.id, { phone: "555-0199" })));
check("a required field hidden from the caller doesn't block them", (() => {
  const secret = fields.create({ entity: "company", label: "Contract ref", type: "text", required: true });
  access.initCustomField(secret, "admins");
  const g = createCompany(manager, { name: "Delta", sites: [{ siteId: A.id }], custom: { cost_centre: "CC-2" } });
  return Boolean(g);
})());

const removed = fields.remove(salary.id);
access.forgetCustomField(removed);
check("deleting a field removes its values and its grid cells", db.raw.prepare("SELECT count(*) AS n FROM field_values WHERE field_id = ?").get(salary.id).n === 0 && db.raw.prepare("SELECT count(*) AS n FROM field_policies WHERE field = ?").get(`custom:${salary.id}`).n === 0);

// --- roles ---------------------------------------------------------------------------------------------

const auditor = access.createRole({ name: "Auditor", directory: "read", visitors: "none", copyFrom: "manager" });
check("a new role copies another role's column, capped at its own reach", access.fieldsFor(access.contextFor({ role: auditor.id }), "person").find((f) => f.key === "email").access === "view");
check("the new role can't edit", throwsStatus(() => updatePerson(access.contextFor({ role: auditor.id }), jane.id, { jobTitle: "x" }), 403) === true);
check("a role held by accounts can't be removed", throwsStatus(() => access.deleteRole(auditor.id, 2), 409) === true);
check("a built-in role can't be removed", throwsStatus(() => access.deleteRole("viewer", 0), 400) === true);
check("the Administrator role can't be narrowed", throwsStatus(() => access.updateRole("admin", { directory: "read" }), 400) === true);
access.updateRole("viewer", { directory: "none" });
check("a role with no directory access sees no fields at all", access.fieldsFor(ctx("viewer"), "person").length === 0);
check("an account with an unknown role sees nothing", access.fieldsFor(access.contextFor({ role: "gone" }), "person").length === 0);
check("only staff roles can be given to accounts", access.isAssignable("manager") && !access.isAssignable("kiosk") && !access.isAssignable("checkout"));

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
