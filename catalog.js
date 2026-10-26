/**
 * The built-in fields of each record type: what the field access grid lists before any
 * custom field, and what the projection in access.js filters. `locked` fields can't be
 * hidden from a role that can see the record at all (a record without a name is
 * useless); they can still be read-only.
 *
 * Custom fields join these as `custom:<id>` (fields.js).
 *
 * `sensitive` fields (clearances) start hidden from roles that only read an area and from
 * API clients; roles that change the area start able to change them.
 *
 * `security` fields (the clearance itself) are set only by the Security role, by validating
 * a clearance (clearance.js): nobody edits them in a record's form, administrators included.
 */
const ENTITIES = ["company", "person", "visitor", "badge"];

const ENTITY_LABELS = { company: "Companies", person: "People", visitor: "Visitors", badge: "Badges" };

// Which of a role's areas governs each record type.
const AREAS = { company: "directory", person: "directory", visitor: "visitors", badge: "badges" };
const areaOf = (entity) => AREAS[entity] || "directory";

/**
 * Whether a role's level in an area lets it change that area's records. Badges are changed
 * (their fields included) only at the "manage" level: "edit" there means issuing and taking
 * badges back.
 */
const editsArea = (level, entity) => (areaOf(entity) === "badges" ? level === "manage" : level === "edit");
const readsArea = (level) => ["read", "edit", "manage"].includes(level);

const BUILT_IN = {
  company: [
    { key: "name", label: "Company name", type: "text", locked: true, required: true },
    { key: "sites", label: "Sites and suites", type: "sites", locked: true },
    { key: "phone", label: "Main phone", type: "phone" },
    { key: "email", label: "Email", type: "email" },
    { key: "website", label: "Website", type: "url" },
    { key: "address", label: "Address", type: "longtext" },
    { key: "notes", label: "Notes", type: "longtext" },
    { key: "buildingStaff", label: "Building staff", type: "boolean" },
    { key: "active", label: "Active", type: "boolean", locked: true }
  ],
  person: [
    { key: "firstName", label: "First name", type: "text", locked: true, required: true },
    { key: "lastName", label: "Last name", type: "text", locked: true, required: true },
    { key: "preferredName", label: "Preferred name", type: "text" },
    { key: "company", label: "Company", type: "company", locked: true, required: true },
    { key: "jobTitle", label: "Job title", type: "text" },
    { key: "email", label: "Email", type: "email" },
    { key: "workPhone", label: "Work phone", type: "phone" },
    { key: "mobile", label: "Mobile", type: "phone" },
    { key: "site", label: "Site", type: "site" },
    { key: "canHost", label: "Can host visitors", type: "boolean" },
    { key: "notes", label: "Notes", type: "longtext" },
    { key: "clearanceStatus", label: "Clearance validation", type: "clearanceStatus", system: true },
    { key: "clearanceLevel", label: "Clearance level", type: "clearance", sensitive: true, security: true },
    { key: "clearanceGranted", label: "Clearance granted", type: "date", sensitive: true, security: true },
    { key: "clearanceExpires", label: "Clearance expires", type: "date", sensitive: true, security: true },
    { key: "clearanceValidatedAt", label: "Clearance validated", type: "datetime", sensitive: true, system: true },
    { key: "clearanceValidatedBy", label: "Validated by", type: "text", sensitive: true, system: true },
    { key: "active", label: "Active", type: "boolean", locked: true }
  ],
  // `system` fields are kept by the app: anyone may be allowed to see them, nobody edits them.
  visitor: [
    { key: "firstName", label: "First name", type: "text", locked: true, required: true },
    { key: "lastName", label: "Last name", type: "text", locked: true, required: true },
    { key: "organization", label: "Company", type: "text" },
    { key: "visitorType", label: "Visitor type", type: "choice", choices: ["Guest", "Service Technician"] },
    { key: "citizenship", label: "Citizenship", type: "citizenship" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "phone" },
    { key: "companies", label: "Companies they visit", type: "links", locked: true },
    { key: "notes", label: "Notes", type: "longtext" },
    { key: "clearanceStatus", label: "Clearance validation", type: "clearanceStatus", system: true },
    { key: "clearanceLevel", label: "Clearance level", type: "clearance", sensitive: true, security: true },
    { key: "clearanceGranted", label: "Clearance granted", type: "date", sensitive: true, security: true },
    { key: "clearanceExpires", label: "Clearance expires", type: "date", sensitive: true, security: true },
    { key: "clearanceValidatedAt", label: "Clearance validated", type: "datetime", sensitive: true, system: true },
    { key: "clearanceValidatedBy", label: "Validated by", type: "text", sensitive: true, system: true },
    { key: "verified", label: "Checked by staff", type: "boolean", locked: true },
    { key: "blocked", label: "Blocked", type: "boolean", locked: true },
    { key: "lastVisitAt", label: "Last visit", type: "datetime", locked: true, system: true }
  ],
  // Badges' own details (number, type, ...) aren't fields: only custom fields are.
  badge: []
};

// Columns a search may look in, per built-in field. Fields not listed are never searched.
const SEARCH_COLUMNS = {
  company: { name: ["c.name"], phone: ["c.phone"], email: ["c.email"], website: ["c.website"], address: ["c.address"], notes: ["c.notes"], sites: ["(SELECT group_concat(coalesce(cs2.suite, ''), ' ') FROM company_sites cs2 WHERE cs2.company_id = c.id)"] },
  person: {
    firstName: ["p.first_name"],
    lastName: ["p.last_name"],
    preferredName: ["p.preferred_name"],
    company: ["c.name"],
    jobTitle: ["p.job_title"],
    email: ["p.email"],
    workPhone: ["p.work_phone"],
    mobile: ["p.mobile"],
    notes: ["p.notes"]
  },
  visitor: {
    firstName: ["v.first_name"],
    lastName: ["v.last_name"],
    organization: ["v.organization"],
    email: ["v.email"],
    phone: ["v.phone"],
    notes: ["v.notes"],
    companies: ["(SELECT group_concat(c3.name, ' ') FROM visitor_links l3 JOIN companies c3 ON c3.id = l3.company_id WHERE l3.visitor_id = v.id)"]
  }
};

const ACCESS_LEVELS = ["hidden", "view", "edit"];

function builtIn(entity) {
  return BUILT_IN[entity] || [];
}

function builtInField(entity, key) {
  return builtIn(entity).find((f) => f.key === key) || null;
}

module.exports = { ENTITIES, ENTITY_LABELS, AREAS, areaOf, editsArea, readsArea, BUILT_IN, SEARCH_COLUMNS, ACCESS_LEVELS, builtIn, builtInField };
