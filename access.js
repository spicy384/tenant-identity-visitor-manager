/**
 * Who sees what: roles, the field access grid, site limits, and the one function every
 * directory response goes through.
 *
 * A role says how far it reaches into each area: the directory (companies and people)
 * and visitors, each none / read / edit. The grid then sets, per role, record type and
 * field, whether the field is hidden, read-only or editable. The effective level is the
 * lower of the two: a read-only role never edits a field whatever its cell says.
 * Administrators see and edit everything and have no column of their own.
 *
 * Site limits come from the account: an account limited to some sites sees only the
 * companies at those sites, and people of those companies who work there (or at any site).
 *
 * project() builds what leaves the server for a record; checkWrite() refuses changes to
 * fields the caller can't edit; searchable() lists only the columns the caller can see,
 * so a search can't reveal a hidden value by matching on it.
 */
const { ENTITIES, ACCESS_LEVELS, builtIn, builtInField, SEARCH_COLUMNS, areaOf } = require("./catalog");
const { outputValue } = require("./fields");

const AREA_LEVELS = ["none", "read", "edit"];
// Badges: read to look, edit to issue and take back, manage to add, change and remove them too.
const BADGE_LEVELS = ["none", "read", "edit", "manage"];
const ROLE_KINDS = { user: "Staff accounts", kiosk: "Kiosk devices", api: "API clients" };

const DEFAULT_ROLES = [
  // clearances: sees clearance level names (the rest see badge template images instead).
  { id: "admin", name: "Administrator", kind: "user", directory: "edit", visitors: "edit", badges: "manage", clearances: true, position: 0 },
  { id: "manager", name: "Manager", kind: "user", directory: "edit", visitors: "edit", badges: "edit", clearances: true, position: 10 },
  { id: "frontdesk", name: "Front desk", kind: "user", directory: "read", visitors: "edit", badges: "edit", position: 20 },
  // The only role that validates and sets clearances, and sees the validation queue.
  // Security also keeps the badge stock: only it (and administrators) add, change and remove badges.
  { id: "security", name: "Security", kind: "user", directory: "read", visitors: "read", badges: "manage", clearances: true, position: 25 },
  { id: "viewer", name: "Viewer", kind: "user", directory: "read", visitors: "read", badges: "read", position: 30 },
  { id: "kiosk", name: "Kiosk", kind: "kiosk", directory: "read", visitors: "none", badges: "none", position: 90 },
  { id: "checkout", name: "Equipment Checkout", kind: "api", directory: "read", visitors: "none", badges: "none", position: 91 }
];

// What the two non-person roles see of the built-in fields until an administrator changes it.
const DEVICE_DEFAULTS = {
  kiosk: {
    company: ["name", "sites", "active"],
    person: ["firstName", "lastName", "preferredName", "company", "site", "canHost", "active"]
  },
  api: {
    company: ["name", "sites", "phone", "email", "active"],
    person: ["firstName", "lastName", "preferredName", "company", "jobTitle", "email", "workPhone", "active"]
  }
};

// Who sees a new custom field, as chosen when it is created.
const NEW_FIELD_VISIBILITY = ["all", "editors", "admins"];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const rank = (level) => ACCESS_LEVELS.indexOf(level);
const lower = (a, b) => (rank(a) <= rank(b) ? a : b);
const customKey = (id) => `custom:${id}`;

function createAccess({ db, fields }) {
  const raw = db.raw;

  // --- roles -----------------------------------------------------------------------

  function roleRow(r) {
    return r && { id: r.id, name: r.name, kind: r.kind, builtIn: Boolean(r.built_in), directory: r.directory, visitors: r.visitors, badges: r.badges || "none",
      clearances: r.id === "admin" || r.id === "security" || (r.kind === "user" && Boolean(r.clearances)), position: r.position };
  }

  function listRoles({ kind = null } = {}) {
    const rows = kind
      ? raw.prepare("SELECT * FROM roles WHERE kind = ? ORDER BY position, name").all(kind)
      : raw.prepare("SELECT * FROM roles ORDER BY position, name").all();
    return rows.map(roleRow);
  }

  function getRole(id) {
    return roleRow(raw.prepare("SELECT * FROM roles WHERE id = ?").get(String(id || "")));
  }

  /** A role an account can be given (not a device or API role). */
  function isAssignable(id) {
    const role = getRole(id);
    return Boolean(role && role.kind === "user");
  }

  /** The default cell for a built-in field, before anyone touches the grid. */
  function builtInDefault(role, entity, key) {
    if (role.kind === "kiosk" || role.kind === "api") {
      return DEVICE_DEFAULTS[role.kind][entity]?.includes(key) ? "view" : "hidden";
    }
    const area = role[areaOf(entity)];
    // Clearances start with the roles that change the area (and Security), hidden from those that only read it.
    if (builtInField(entity, key)?.sensitive) return role.id === "security" || area === "edit" ? "edit" : "hidden";
    return area === "edit" ? "edit" : area === "read" ? "view" : "hidden";
  }

  function customDefault(role, visibility, entity) {
    if (role.kind !== "user" || visibility === "admins") return "hidden";
    const area = role[areaOf(entity)];
    if (visibility === "editors") return area === "edit" ? "edit" : "hidden";
    return area === "edit" ? "edit" : area === "read" ? "view" : "hidden";
  }

  const putPolicy = raw.prepare("INSERT INTO field_policies (role_id, entity, field, access) VALUES (?, ?, ?, ?) ON CONFLICT(role_id, entity, field) DO UPDATE SET access = excluded.access");

  function seedRoles() {
    const now = Date.now();
    db.transaction(() => {
      for (const r of DEFAULT_ROLES) {
        if (getRole(r.id)) continue;
        raw.prepare("INSERT INTO roles (id, name, kind, built_in, directory, visitors, badges, clearances, position, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)")
          .run(r.id, r.name, r.kind, r.directory, r.visitors, r.badges, r.clearances ? 1 : 0, r.position, now);
        if (r.id === "admin") continue;
        for (const entity of ENTITIES) {
          for (const f of builtIn(entity)) putPolicy.run(r.id, entity, f.key, builtInDefault(r, entity, f.key));
        }
      }
    });
  }
  seedRoles();
  // Badges came later: built-in roles made before then get their badge access once.
  if (!db.getSetting("roles.badges_seeded")) {
    db.transaction(() => {
      for (const r of DEFAULT_ROLES) raw.prepare("UPDATE roles SET badges = ? WHERE id = ? AND built_in = 1").run(r.badges, r.id);
      db.setSetting("roles.badges_seeded", "1");
    });
  }
  // Managing the badge stock came later still: once, Security and Administrator get it, and
  // the other built-in roles keep issuing and taking badges back.
  if (!db.getSetting("roles.badges_manage_seeded")) {
    db.transaction(() => {
      raw.prepare("UPDATE roles SET badges = 'manage' WHERE id IN ('admin', 'security') AND built_in = 1").run();
      db.setSetting("roles.badges_manage_seeded", "1");
    });
  }
  // As did seeing clearance level names: once, for the built-in roles that start with it.
  if (!db.getSetting("roles.clearances_seeded")) {
    db.transaction(() => {
      for (const r of DEFAULT_ROLES) if (r.clearances) raw.prepare("UPDATE roles SET clearances = 1 WHERE id = ? AND built_in = 1").run(r.id);
      db.setSetting("roles.clearances_seeded", "1");
    });
  }

  function roleId(name) {
    const base = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "role";
    let id = base;
    for (let n = 2; getRole(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  function checkArea(value, label, levels = AREA_LEVELS) {
    if (!levels.includes(value)) throw fail(400, `${label} must be one of: ${levels.join(", ")}.`);
    return value;
  }

  /** A new account role; its grid column starts as a copy of `copyFrom` (default: Viewer). */
  function createRole({ name, directory = "read", visitors = "none", badges = "none", clearances = false, copyFrom = "viewer" }) {
    const clean = String(name || "").trim().slice(0, 40);
    if (!clean) throw fail(400, "Give the role a name.");
    if (raw.prepare("SELECT 1 FROM roles WHERE name = ?").get(clean)) throw fail(409, "A role with that name already exists.");
    checkArea(directory, "Directory access");
    checkArea(visitors, "Visitor access");
    checkArea(badges, "Badge access", BADGE_LEVELS);
    const source = getRole(copyFrom);
    if (!source || source.kind !== "user") throw fail(400, "Copy the field access of a staff role.");
    const id = roleId(clean);
    db.transaction(() => {
      raw.prepare("INSERT INTO roles (id, name, kind, built_in, directory, visitors, badges, clearances, position, created_at) VALUES (?, ?, 'user', 0, ?, ?, ?, ?, 50, ?)").run(id, clean, directory, visitors, badges, clearances === true ? 1 : 0, Date.now());
      if (source.id === "admin") {
        // Administrators have no stored column: everything is editable.
        for (const entity of ENTITIES) {
          for (const f of builtIn(entity)) putPolicy.run(id, entity, f.key, "edit");
          for (const d of fields.list(entity, { allRecords: true })) putPolicy.run(id, entity, customKey(d.id), "edit");
        }
      } else {
        raw.prepare("INSERT INTO field_policies (role_id, entity, field, access) SELECT ?, entity, field, access FROM field_policies WHERE role_id = ?").run(id, source.id);
      }
    });
    return getRole(id);
  }

  function updateRole(id, patch = {}) {
    const role = getRole(id);
    if (!role) throw fail(404, "No such role.");
    if (role.id === "admin") throw fail(400, "The Administrator role always has full access.");
    if (role.kind === "api" && !role.builtIn) throw fail(400, "An API client's fields are set under Settings > API clients.");
    if (role.kind !== "user" && (patch.directory !== undefined || patch.visitors !== undefined || patch.badges !== undefined || patch.clearances !== undefined)) throw fail(400, `What the ${role.name} role reaches is fixed; set which fields it sees in the field access grid.`);
    if (role.id === "security" && patch.clearances === false) throw fail(400, "The Security role validates clearances, so it always sees clearance levels.");
    const next = { ...role };
    if (patch.name !== undefined) {
      if (role.builtIn) throw fail(400, "Built-in roles keep their names.");
      const clean = String(patch.name || "").trim().slice(0, 40);
      if (!clean) throw fail(400, "Give the role a name.");
      const clash = raw.prepare("SELECT id FROM roles WHERE name = ?").get(clean);
      if (clash && clash.id !== id) throw fail(409, "A role with that name already exists.");
      next.name = clean;
    }
    if (patch.directory !== undefined) next.directory = checkArea(patch.directory, "Directory access");
    if (patch.visitors !== undefined) next.visitors = checkArea(patch.visitors, "Visitor access");
    if (patch.badges !== undefined) next.badges = checkArea(patch.badges, "Badge access", BADGE_LEVELS);
    if (patch.clearances !== undefined) next.clearances = patch.clearances === true;
    raw.prepare("UPDATE roles SET name = ?, directory = ?, visitors = ?, badges = ?, clearances = ? WHERE id = ?").run(next.name, next.directory, next.visitors, next.badges, next.clearances ? 1 : 0, id);
    return getRole(id);
  }

  // --- API client roles ----------------------------------------------------------------
  //
  // Each API client has a role of its own (kind "api"), so each can be given its own
  // fields. A new one starts as a copy of the built-in Equipment Checkout column, which is
  // the template. They are managed from Settings > API clients, not Settings > Roles.

  function apiRoleName(clientName) {
    return `API: ${clientName}`.slice(0, 60);
  }

  function createApiRole(clientName, { canWrite = false } = {}) {
    let id;
    for (let n = 1; ; n += 1) {
      id = `api-${n}`;
      if (!getRole(id)) break;
    }
    db.transaction(() => {
      raw.prepare("INSERT INTO roles (id, name, kind, built_in, directory, visitors, position, created_at) VALUES (?, ?, 'api', 0, ?, 'none', 95, ?)")
        .run(id, apiRoleName(clientName), canWrite ? "edit" : "read", Date.now());
      raw.prepare("INSERT INTO field_policies (role_id, entity, field, access) SELECT ?, entity, field, access FROM field_policies WHERE role_id = 'checkout'").run(id);
      // A client that may write may set what it receives.
      if (canWrite) raw.prepare("UPDATE field_policies SET access = 'edit' WHERE role_id = ? AND access = 'view' AND entity IN ('company', 'person')").run(id);
    });
    return getRole(id);
  }

  function updateApiRole(id, { clientName, canWrite } = {}) {
    const role = getRole(id);
    if (!role || role.kind !== "api" || role.builtIn) throw fail(400, "Not an API client's role.");
    if (clientName !== undefined) raw.prepare("UPDATE roles SET name = ? WHERE id = ?").run(apiRoleName(clientName), id);
    // Only a change of write access moves the cells, so a grid choice made since is kept.
    if (canWrite !== undefined && (role.directory === "edit") !== Boolean(canWrite)) {
      raw.prepare("UPDATE roles SET directory = ? WHERE id = ?").run(canWrite ? "edit" : "read", id);
      // Read-only again: what it could change, it can now only receive; and the reverse.
      if (!canWrite) raw.prepare("UPDATE field_policies SET access = 'view' WHERE role_id = ? AND access = 'edit'").run(id);
      else raw.prepare("UPDATE field_policies SET access = 'edit' WHERE role_id = ? AND access = 'view' AND entity IN ('company', 'person')").run(id);
    }
    return getRole(id);
  }

  function deleteApiRole(id) {
    const role = getRole(id);
    if (role && role.kind === "api" && !role.builtIn) raw.prepare("DELETE FROM roles WHERE id = ?").run(id);
  }

  /**
   * An API client's fields as a checklist: { company: [keys], person: [keys] } it receives.
   * Each ticked field becomes "view" (or "edit" when the client may write), the rest hidden;
   * fields that can't be hidden stay ticked whatever is sent.
   */
  function setApiFields(roleId, wanted) {
    const role = getRole(roleId);
    if (!role || role.kind !== "api") throw fail(400, "Not an API client's role.");
    const changes = [];
    for (const entity of ["company", "person"]) {
      const keep = new Set(Array.isArray(wanted?.[entity]) ? wanted[entity].map(String) : []);
      for (const f of allFields(entity, { allRecords: false })) {
        const on = f.locked || (!f.sensitive && keep.has(f.builtIn ? f.key : f.apiKey));
        changes.push({ roleId, entity, field: f.key, access: on ? (role.directory === "edit" && !f.system ? "edit" : "view") : "hidden" });
      }
    }
    return setPolicies(changes);
  }

  /** Removes a custom role; `inUse` is how many accounts hold it (they must be moved first). */
  function deleteRole(id, inUse = 0) {
    const role = getRole(id);
    if (!role) throw fail(404, "No such role.");
    if (role.builtIn) throw fail(400, "Built-in roles can't be removed.");
    if (role.kind === "api") throw fail(400, "Remove the API client instead, under Settings > API clients.");
    if (inUse) throw fail(409, `${inUse} account${inUse === 1 ? " has" : "s have"} this role; give ${inUse === 1 ? "it" : "them"} another role first.`);
    raw.prepare("DELETE FROM roles WHERE id = ?").run(id);
    return role;
  }

  // --- the field access grid -----------------------------------------------------------

  function storedPolicies() {
    const map = new Map();
    for (const r of raw.prepare("SELECT role_id, entity, field, access FROM field_policies").all()) {
      map.set(`${r.role_id}|${r.entity}|${r.field}`, r.access);
    }
    return map;
  }

  /** The level a role has on a field, from the grid, capped by its area and the field's lock. */
  function levelFor(role, entity, field, stored) {
    if (!role) return "hidden";
    // A system field (when someone last visited) is kept by the app, never typed in.
    // Clearances themselves are set only by validating (Security), never in a form.
    if (role.id === "admin") return field.system || field.security ? "view" : "edit";
    const area = role[areaOf(entity)];
    if (area === "none") return "hidden";
    // Clearance details only for roles that see clearance levels, whatever the grid says.
    if (field.sensitive && !role.clearances) return "hidden";
    let level = stored.get(`${role.id}|${entity}|${field.key}`);
    // A built-in field nobody has set yet has its default; a custom field without a cell
    // is hidden, so a missing row can only ever hide data, never show it.
    if (!level) level = field.builtIn ? builtInDefault(role, entity, field.key) : "hidden";
    // Kiosks never edit; an API client edits only when it is allowed to write.
    if (area === "read" || role.kind === "kiosk" || field.system || field.security) level = lower(level, "view");
    if (field.locked && level === "hidden") level = "view";
    return level;
  }

  /** Every field of `entity` (built-in, then custom) in the shape the grid and forms use. */
  function allFields(entity, { recordId = null, allRecords = false } = {}) {
    return [
      ...builtIn(entity).map((f) => ({ key: f.key, label: f.label, type: f.type, builtIn: true, locked: Boolean(f.locked), system: Boolean(f.system), security: Boolean(f.security), sensitive: Boolean(f.sensitive), required: Boolean(f.required), choices: [], recordId: null })),
      ...fields.list(entity, { recordId, allRecords }).map((d) => ({ key: customKey(d.id), id: d.id, apiKey: d.key, label: d.label, type: d.type, builtIn: false, locked: false, required: d.required, choices: d.choices, recordId: d.recordId }))
    ];
  }

  /**
   * The grid: every role but Administrator (everything) and Kiosk, which only ever shows
   * a visitor the names of the company and host they came to see, whatever a grid says.
   */
  function grid() {
    const roles = listRoles().filter((r) => r.id !== "admin" && r.kind !== "kiosk");
    const stored = storedPolicies();
    const entities = {};
    for (const entity of ENTITIES) {
      entities[entity] = allFields(entity, { allRecords: true }).map((f) => ({
        ...f,
        access: Object.fromEntries(roles.map((r) => [r.id, levelFor(r, entity, f, stored)]))
      }));
    }
    return { roles, entities, areas: Object.fromEntries(ENTITIES.map((e) => [e, areaOf(e)])) };
  }

  /** Applies grid changes: [{ roleId, entity, field, access }]. Returns how many changed. */
  function setPolicies(changes) {
    if (!Array.isArray(changes) || !changes.length) throw fail(400, "Nothing to change.");
    if (changes.length > 5000) throw fail(400, "Too many changes at once.");
    const prepared = changes.map((c) => {
      const role = getRole(c.roleId);
      if (!role) throw fail(400, `No role ${c.roleId}.`);
      if (role.id === "admin") throw fail(400, "Administrators always see and edit every field.");
      if (role.kind === "kiosk") throw fail(400, "The kiosk only ever shows names; it has no fields to set.");
      if (!ENTITIES.includes(c.entity)) throw fail(400, `No record type ${c.entity}.`);
      if (!ACCESS_LEVELS.includes(c.access)) throw fail(400, `Access must be one of: ${ACCESS_LEVELS.join(", ")}.`);
      const field = allFields(c.entity, { allRecords: true }).find((f) => f.key === c.field);
      if (!field) throw fail(400, `No field ${c.field}.`);
      if (field.locked && c.access === "hidden") throw fail(400, `${field.label} can't be hidden: anyone who sees a record sees it.`);
      if (c.access === "edit" && field.system) throw fail(400, `${field.label} is kept by the app and can't be edited.`);
      if (c.access === "edit" && field.security) throw fail(400, `${field.label} is set only by the Security role, by validating a clearance.`);
      if (c.access !== "hidden" && field.sensitive && !role.clearances) {
        throw fail(400, role.kind === "user" ? `${role.name} doesn't see clearance levels: turn that on for the role under Settings > Roles first.` : `${field.label} isn't given to ${role.kind === "api" ? "API clients" : "kiosks"}.`);
      }
      if (c.access === "edit" && (role.kind === "kiosk" || role[areaOf(c.entity)] !== "edit")) {
        throw fail(400, `${role.name} can't change ${areaOf(c.entity) === "visitors" ? "visitors" : "the directory"}, so these fields can only be hidden or read-only.`);
      }
      return [role.id, c.entity, field.key, c.access];
    });
    db.transaction(() => { for (const p of prepared) putPolicy.run(...p); });
    return prepared.length;
  }

  /** Sets every role's cell for a new custom field, from the visibility chosen when adding it. */
  function initCustomField(def, visibility = "all") {
    if (!NEW_FIELD_VISIBILITY.includes(visibility)) throw fail(400, `Visibility must be one of: ${NEW_FIELD_VISIBILITY.join(", ")}.`);
    db.transaction(() => {
      for (const role of listRoles()) {
        if (role.id !== "admin") putPolicy.run(role.id, def.entity, customKey(def.id), customDefault(role, visibility, def.entity));
      }
    });
  }

  function forgetCustomField(def) {
    raw.prepare("DELETE FROM field_policies WHERE entity = ? AND field = ?").run(def.entity, customKey(def.id));
  }

  // --- the caller ------------------------------------------------------------------------

  /**
   * What a request may do, from its account (or, later, its kiosk or API client).
   * sites: null for every site, else the Set of site ids it is limited to.
   */
  function contextFor(principal) {
    const role = getRole(principal?.role);
    const isAdmin = role?.id === "admin";
    const limited = !isAdmin && Array.isArray(principal?.sites);
    return {
      role,
      isAdmin,
      directory: role ? role.directory : "none",
      visitors: role ? role.visitors : "none",
      badges: role ? role.badges : "none",
      // Sees clearance level names; everyone else sees badge template images instead.
      clearances: Boolean(role?.clearances),
      sites: limited ? new Set(principal.sites.map(Number)) : null,
      // Read when used, so a context never answers from a grid that has since changed.
      get stored() {
        return storedPolicies();
      }
    };
  }

  const canReadDirectory = (ctx) => ctx.directory === "read" || ctx.directory === "edit";
  const canEditDirectory = (ctx) => ctx.directory === "edit";
  const canReadVisitors = (ctx) => ctx.visitors === "read" || ctx.visitors === "edit";
  const canEditVisitors = (ctx) => ctx.visitors === "edit";
  /** The Security role: validates clearances and sees the validation queue. */
  const isSecurity = (ctx) => ctx.role?.id === "security";
  /** Sees clearance level names (Settings > Roles); everyone else sees badge template images. */
  const canSeeClearances = (ctx) => Boolean(ctx.clearances);
  const canReadBadges = (ctx) => ["read", "edit", "manage"].includes(ctx.badges);
  /** Issues badges and takes them back. */
  const canEditBadges = (ctx) => ctx.badges === "edit" || ctx.badges === "manage";
  /** Keeps the badge stock: adds, changes and removes badges. */
  const canManageBadges = (ctx) => ctx.badges === "manage";

  /** Fields of `entity` the caller can see (for `recordId`'s own fields too), each with its level. */
  function fieldsFor(ctx, entity, { recordId = null } = {}) {
    const stored = ctx.stored;
    return allFields(entity, { recordId })
      .map((f) => ({ ...f, access: levelFor(ctx.role, entity, f, stored) }))
      .filter((f) => f.access !== "hidden");
  }

  function siteVisible(ctx, siteId) {
    return !ctx.sites || ctx.sites.has(Number(siteId));
  }

  /**
   * A record as the caller may see it. `record` carries the built-in values under their
   * keys, `values` a Map(fieldId -> stored text), and `fieldList` comes from fieldsFor().
   */
  function project(ctx, entity, record, fieldList) {
    const out = { id: record.id };
    const custom = {};
    for (const f of fieldList) {
      if (f.builtIn) {
        let value = record[f.key];
        if (f.key === "sites" && Array.isArray(value)) value = value.filter((s) => siteVisible(ctx, s.siteId));
        if (f.key === "company") {
          out.companyId = record.companyId;
          value = record.companyName;
          out.companyName = value;
          continue;
        }
        if (f.key === "site") {
          out.siteId = record.siteId ?? null;
          out.siteName = record.siteName ?? null;
          continue;
        }
        if (f.type === "clearance") {
          out[f.key] = value ?? null;
          out[`${f.key}Name`] = record[`${f.key}Name`] ?? null;
          continue;
        }
        out[f.key] = value ?? null;
      } else if (record.values && record.values.has(f.id)) {
        custom[f.apiKey] = outputValue(f, record.values.get(f.id));
      }
    }
    out.custom = custom;
    if (record.updatedAt) out.updatedAt = record.updatedAt;
    return out;
  }

  /**
   * Refuses a change that touches a field the caller can't edit. `patch` holds built-in
   * keys and `custom: { key: value }`; companyId and siteId stand for company and site.
   * Returns the custom field definitions being written, keyed by their api key.
   */
  function checkWrite(ctx, entity, patch, fieldList) {
    if (ctx[areaOf(entity)] !== "edit") throw fail(403, areaOf(entity) === "visitors" ? "This account can't change visitors." : "This account can't change the directory.");
    const byKey = new Map(fieldList.map((f) => [f.key, f]));
    const refused = [];
    const alias = entity === "visitor" ? { links: "companies" } : { companyId: "company", siteId: "site", siteIds: "sites", sites: "sites" };
    for (const key of Object.keys(patch)) {
      if (key === "custom" || key === "id") continue;
      const fieldKey = alias[key] || key;
      if (!builtInField(entity, fieldKey)) continue; // not a field (validated by the directory)
      const f = byKey.get(fieldKey);
      if (!f || f.access !== "edit") refused.push(builtInField(entity, fieldKey).label);
    }
    const custom = new Map();
    const byApiKey = new Map(fieldList.filter((f) => !f.builtIn).map((f) => [f.apiKey, f]));
    for (const [key, value] of Object.entries(patch.custom || {})) {
      const f = byApiKey.get(key);
      if (!f) throw fail(400, `There is no field "${key}" on this record.`);
      if (f.access !== "edit") refused.push(f.label);
      else custom.set(f, value);
    }
    if (refused.length) throw fail(403, `This account can't change ${refused.join(", ")}.`);
    return custom;
  }

  /** The columns and custom field ids a search by this caller may look in. */
  function searchable(ctx, entity) {
    const columns = [];
    const fieldIds = [];
    for (const f of fieldsFor(ctx, entity)) {
      if (f.builtIn) columns.push(...(SEARCH_COLUMNS[entity][f.key] || []));
      else if (f.recordId === null && ["text", "longtext", "email", "phone", "url", "choice", "number", "date"].includes(f.type)) fieldIds.push(f.id);
    }
    return { columns, fieldIds };
  }

  return {
    listRoles,
    getRole,
    isAssignable,
    createRole,
    updateRole,
    deleteRole,
    createApiRole,
    updateApiRole,
    deleteApiRole,
    setApiFields,
    grid,
    setPolicies,
    initCustomField,
    forgetCustomField,
    contextFor,
    canReadDirectory,
    canEditDirectory,
    canReadVisitors,
    canEditVisitors,
    canReadBadges,
    canEditBadges,
    isSecurity,
    canSeeClearances,
    canManageBadges,
    fieldsFor,
    siteVisible,
    project,
    checkWrite,
    searchable,
    allFields
  };
}

module.exports = { createAccess, DEFAULT_ROLES, AREA_LEVELS, BADGE_LEVELS, ROLE_KINDS, NEW_FIELD_VISIBILITY, customKey };
