// 06-settings.js: administrator settings: sites, custom fields, roles, users,
// Microsoft Entra ID, import/export/backup and the audit log. The field access grid
// is in 07-access.js.

let settingsTab = "sites";

/**
 * An inline settings form. fields as for formDialog, plus { section } headings and
 * { note } paragraphs. onSave(values) returns a message to show, or throws.
 */
function settingsForm({ title, intro, fields, onSave, saveLabel = "Save", extra = null }) {
  const form = h("form", { class: "panel settings-form", autocomplete: "off" });
  if (title) form.append(h("h3", { text: title }));
  if (intro) form.append(typeof intro === "string" ? h("p", { class: "muted", text: intro }) : intro);
  const msg = h("p", { class: "message", hidden: true });
  const inputs = {};
  const grid = h("div", { class: "form-grid" });
  for (const f of fields) {
    if (f.section) { grid.append(h("h4", { class: "form-heading", text: f.section })); continue; }
    if (f.note) { grid.append(h("p", { class: "muted full-row", text: f.note })); continue; }
    if (f.node) { grid.append(f.node); continue; }
    let input;
    if (f.type === "textarea") {
      input = h("textarea", { name: f.name, rows: f.rows || 3 });
      input.value = f.value ?? "";
    } else if (f.type === "select") {
      input = h("select", { name: f.name }, f.options.map((o) => h("option", { value: o.value, text: o.label })));
      input.value = f.value ?? f.options[0].value;
    } else if (f.type === "checkbox") {
      input = h("input", { type: "checkbox", name: f.name });
      input.checked = Boolean(f.value);
    } else {
      input = h("input", { type: f.type || "text", name: f.name, placeholder: f.placeholder || "", autocomplete: f.type === "password" ? "new-password" : "off" });
      input.value = f.value ?? "";
    }
    if (f.disabled) input.disabled = true;
    inputs[f.name] = input;
    const hint = f.hint ? h("span", { class: "hint", text: f.hint }) : null;
    grid.append(f.type === "checkbox"
      ? h("label", { class: "check-row full-row" }, input, h("span", { text: f.label }), hint)
      : h("label", { class: f.half ? "half" : "full-row" }, h("span", { text: f.label }), input, hint));
  }
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === "checkbox" ? el.checked : el.value]));
  const save = h("button", { type: "submit", class: "primary", text: saveLabel });
  form.append(grid, msg, h("div", { class: "btn-row" }, save, extra ? extra(values, msg) : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    save.disabled = true;
    msg.hidden = true;
    try {
      const text = await onSave(values());
      msg.className = "message success";
      msg.textContent = text || "Saved.";
      msg.hidden = false;
    } catch (error) {
      msg.className = "message error";
      msg.textContent = error.message;
      msg.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
  return { form, inputs, values, msg };
}

async function reloadConfig() {
  state.config = await api("/api/config");
  await loadSchema();
  applyConfig();
}

async function renderSettings() {
  // Roles that manage custom fields, but aren't administrators, have the Fields page only.
  if (!isAdmin()) settingsTab = "fields";
  for (const b of $("settings-tabs").querySelectorAll("button[data-tab]")) {
    b.classList.toggle("is-active", b.dataset.tab === settingsTab);
    b.hidden = !isAdmin() && b.dataset.tab !== "fields";
  }
  for (const g of $("settings-tabs").querySelectorAll(".settings-group")) g.hidden = ![...g.querySelectorAll("button[data-tab]")].some((b) => !b.hidden);
  const body = clear($("settings-body"));
  try {
    const render = { general: settingsGeneral, sites: settingsSites, fields: settingsFields, access: settingsAccess, visits: settingsVisits, kiosks: settingsKiosks, badges: settingsBadges, "security-mail": settingsSecurityMail, api: settingsApiClients, roles: settingsRoles, users: settingsUsers, entra: settingsEntra, data: settingsData, retention: settingsRetention, audit: settingsAudit }[settingsTab] || settingsSites;
    await render(body);
  } catch (error) {
    body.append(h("p", { class: "message error", text: error.message }));
  }
}

$("settings-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  location.hash = `#settings/${b.dataset.tab}`;
});

// --- general: the name in the header ----------------------------------------------------------

async function settingsGeneral(body) {
  const current = await api("/api/branding");
  const { form } = settingsForm({
    title: "Name",
    intro: "What the header (top left), the sign-in page and the browser's tab call this app.",
    fields: [
      { name: "name", label: "Name", value: current.name === current.defaultName ? "" : current.name, placeholder: current.defaultName, hint: `Up to 60 characters. Empty for "${current.defaultName}".` },
      { name: "subtitle", label: "Line under the name", value: current.subtitle, placeholder: "Tenant directory", hint: "Shown when no single site is chosen; with a site chosen, the line shows that site. Up to 80 characters; empty for the only site's name, or \"Tenant directory\"." }
    ],
    onSave: async (v) => {
      await api("/api/branding", { method: "PUT", body: v });
      await reloadConfig();
      return "Saved.";
    }
  });
  body.append(form);
}

// --- sites ------------------------------------------------------------------------------

async function settingsSites(body) {
  const { sites, timeZones } = await api("/api/sites");
  const panel = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Sites" }), h("button", { type: "button", class: "primary small", text: "Add site", onclick: () => editSite(null, timeZones) })),
    h("p", { class: "muted", text: "Each building has its own name and logo on its kiosk, its own time zone, and the time its visitors are checked out automatically at the end of the day. Visitors and kiosks arrive in the next phase; the settings are kept from now." }),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["", "Site", "Time zone", "End of day", "Companies", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, sites.map((s) => h("tr", { class: s.active ? "" : "inactive" },
        h("td", { class: "logo-cell" }, s.hasLogo ? h("img", { class: "site-logo-thumb", src: `/api/sites/${s.id}/logo?v=${s.logoUpdatedAt}`, alt: "" }) : null),
        h("td", {}, h("strong", { text: s.name }), s.kioskName && s.kioskName !== s.name ? h("div", { class: "muted small-text", text: `Kiosk: ${s.kioskName}` }) : null, s.active ? null : h("span", { class: "badge muted", text: "Inactive" })),
        h("td", { class: "small-text", text: s.timeZone }),
        h("td", { class: "small-text", text: s.endOfDay || "Off" }),
        h("td", { text: String(s.companies) }),
        h("td", {}, h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editSite(s, timeZones) }))))))));
  body.append(panel);
}

/**
 * Turns an image file into a PNG data: URL no larger than 600 px a side, so any
 * format the browser can show (SVG included) is stored as a plain bitmap.
 */
function imageToPng(file, max = 600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 600;
      const hgt = img.naturalHeight || 300;
      const scale = Math.min(1, max / Math.max(w, hgt));
      const canvas = h("canvas", { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(hgt * scale)) });
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL("image/png");
      // A photo can make a large PNG; JPEG keeps it under the server's 1 MB limit.
      if (data.length > 1300000) data = canvas.toDataURL("image/jpeg", 0.88);
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image this browser can read.")); };
    img.src = url;
  });
}

async function editSite(site, timeZones) {
  let logoData = null;   // a new logo, as a data: URL
  let removeLogo = false;
  const preview = h("div", { class: "logo-preview" });
  const showPreview = () => {
    clear(preview);
    if (logoData) preview.append(h("img", { src: logoData, alt: "New logo" }));
    else if (site?.hasLogo && !removeLogo) preview.append(h("img", { src: `/api/sites/${site.id}/logo?v=${site.logoUpdatedAt}`, alt: "Current logo" }));
    else preview.append(h("span", { class: "muted", text: "No logo. The kiosk shows the name only." }));
  };
  showPreview();
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/svg+xml,image/webp,image/gif", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      logoData = await imageToPng(file);
      removeLogo = false;
      showPreview();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  const logoBlock = h("div", { class: "full-row logo-block" },
    h("span", { class: "label", text: "Logo on the kiosk" }),
    preview,
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "secondary small", text: "Choose image", onclick: () => fileInput.click() }),
      h("button", { type: "button", class: "link-btn danger-text", text: "Remove logo", onclick: () => { logoData = null; removeLogo = true; showPreview(); } })),
    h("span", { class: "hint", text: "PNG, JPEG, SVG or WebP. It is resized to fit 600 pixels and stored, encrypted, in the database." }),
    fileInput);

  const tz = site?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const saved = await formDialog({
    title: site ? `Edit ${site.name}` : "Add site",
    wide: true,
    fields: [
      { name: "name", label: "Site name", value: site?.name, required: true, half: true },
      { name: "kioskName", label: "Name shown on the kiosk", value: site?.kioskName, half: true, placeholder: site?.name || "Defaults to the site name" },
      { name: "welcome", label: "Welcome line on the kiosk", value: site?.welcome, placeholder: "Please sign in at reception" },
      { node: logoBlock },
      { name: "address", label: "Address", type: "textarea", rows: 2, value: site?.address },
      { name: "timeZone", label: "Time zone", type: "select", value: tz, half: true, options: (timeZones || [tz]).map((z) => ({ value: z, label: z.replace(/_/g, " ") })) },
      { name: "endOfDay", label: "Check visitors out automatically at", type: "time", value: site?.endOfDay || "", half: true, hint: "Leave empty to keep visits open until someone checks out." },
      ...(site ? [{ name: "active", label: "Active", type: "checkbox", value: site.active }] : [])
    ],
    submitLabel: site ? "Save" : "Add site",
    extraActions: site ? [{ label: "Delete site", kind: "danger", close: true, onClick: async () => {
      if (!(await confirmDialog(`Delete ${site.name}? Only possible while no company or person is there; otherwise make it inactive.`, { danger: true, confirmLabel: "Delete" }))) throw new Error("Not deleted.");
      await api(`/api/sites/${site.id}`, { method: "DELETE" });
      return "deleted";
    } }] : [],
    onSubmit: async (v) => {
      const result = site
        ? await api(`/api/sites/${site.id}`, { method: "PUT", body: v })
        : await api("/api/sites", { method: "POST", body: v });
      if (logoData) await api(`/api/sites/${result.site.id}/logo`, { method: "PUT", body: { dataUrl: logoData } });
      else if (removeLogo && site?.hasLogo) await api(`/api/sites/${result.site.id}/logo`, { method: "DELETE" });
      return result.site;
    }
  });
  if (saved) {
    toast(saved === "deleted" ? "Site deleted." : "Saved.");
    await reloadConfig();
    renderSettings();
  }
}

// --- custom fields --------------------------------------------------------------------------

const ENTITY_TITLES = { company: "Company fields", person: "People fields", visitor: "Visitor fields", badge: "Badge fields" };
const ENTITY_ONE = { company: "company", person: "person", visitor: "visitor", badge: "badge" };
const ENTITY_EVERY = { company: "Every company", person: "Everyone", visitor: "Every visitor", badge: "Every badge" };

async function settingsFields(body) {
  const { fields, types, visibility, entities, canDelete } = await api("/api/fields");
  const typeLabel = Object.fromEntries(types.map((t) => [t.value, t.label]));
  body.append(h("div", { class: "panel" },
    h("p", { class: "muted", text: `Custom fields add to the built-in ones. A field for every record can be required and is searched and exported; a field added from a single record shows on that record only, until you make it a field for every record. ${isAdmin() ? "Set who sees each field under Field access." : "Who sees each field is set by an administrator under Field access; deleting a field is up to an administrator too."}` })));
  // Only the kinds of record this account manages fields for (administrators: all).
  for (const entity of ["company", "person", "visitor", "badge"].filter((e) => entities.includes(e))) {
    const list = fields[entity];
    body.append(h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: ENTITY_TITLES[entity] }), h("button", { type: "button", class: "primary small", text: "Add field", onclick: () => editField(entity, null, types, visibility) })),
      list.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Field", "Key", "Type", "On", ""].map((t) => h("th", { text: t })))),
          h("tbody", {}, list.map((f) => h("tr", {},
            h("td", {}, h("strong", { text: f.label }), f.required ? h("span", { class: "badge", text: "Required" }) : null, f.type === "choice" ? h("div", { class: "muted small-text", text: f.choices.join(", ") }) : null),
            h("td", { class: "mono small-text", text: f.key }),
            h("td", { class: "small-text", text: typeLabel[f.type] || f.type }),
            h("td", { class: "small-text", text: f.recordId === null ? ENTITY_EVERY[entity] : `${f.recordName} only` }),
            h("td", {}, h("div", { class: "btn-row" },
              f.recordId !== null ? h("button", { type: "button", class: "link-btn", text: "Use for every record", onclick: () => promoteField(f) }) : null,
              h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editField(entity, f, types, visibility) }),
              canDelete ? h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: () => deleteField(f) }) : null)))))))
        : h("p", { class: "muted", text: "No custom fields yet." })));
  }
}

async function editField(entity, field, types) {
  const saved = await formDialog({
    title: field ? `Edit "${field.label}"` : `Add a field for every ${ENTITY_ONE[entity]}`,
    fields: [
      { name: "label", label: "Field name", value: field?.label, required: true },
      ...(field ? [{ type: "readonly", name: "type", label: "Type", value: types.find((t) => t.value === field.type)?.label, half: true }] : [
        { name: "type", label: "Type", type: "select", value: "text", options: types, half: true, onChange: (input, inputs) => { inputs.choices.closest("label").hidden = input.value !== "choice"; } }]),
      ...(field ? [] : [{ name: "visibility", label: "Who sees it", type: "select", value: "all", half: true, options: VISIBILITY_OPTIONS }]),
      ...(!field || field.type === "choice" ? [{ name: "choices", label: "Choices, one per line", type: "textarea", rows: 4, value: field?.choices?.join("\n") || "" }] : []),
      ...(!field || field.recordId === null ? [{ name: "required", label: "Required (it must be filled in when a record is added or changed)", type: "checkbox", value: field?.required }] : [])
    ],
    submitLabel: field ? "Save" : "Add field",
    onSubmit: async (v) => (field
      ? await api(`/api/fields/${field.id}`, { method: "PUT", body: v })
      : await api("/api/fields", { method: "POST", body: { ...v, entity } })).field
  });
  if (saved) {
    toast("Saved.");
    await loadSchema();
    renderSettings();
  }
}

async function promoteField(field) {
  if (!(await confirmDialog(`Make "${field.label}" a field every record has? ${field.recordName} keeps its value; the others start empty.`, { confirmLabel: "Use for every record" }))) return;
  try {
    await api(`/api/fields/${field.id}`, { method: "PUT", body: { promote: true } });
    await loadSchema();
    renderSettings();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteField(field) {
  if (!(await confirmDialog(`Delete "${field.label}" and every value stored in it? This can't be undone.`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    await api(`/api/fields/${field.id}`, { method: "DELETE" });
    toast(`Deleted "${field.label}".`);
    await loadSchema();
    renderSettings();
  } catch (error) {
    toast(error.message, "error");
  }
}

// --- roles --------------------------------------------------------------------------------------

const KIND_LABELS = { user: "Staff", kiosk: "Kiosk devices", api: "API clients" };

async function settingsRoles(body) {
  const { roles } = await api("/api/roles");
  const staff = roles.filter((r) => r.kind === "user");
  body.append(h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Roles" }), h("button", { type: "button", class: "primary small", text: "Add role", onclick: () => editRole(null, staff) })),
    h("p", { class: "muted", text: "A role sets how far an account reaches: whether it can see or change the directory (companies and people), visitors (visitors, visits, checking in and out), badges, facilities (floors, offices, rates, leases and charges) and finance (invoices, payments and balances), and whether it reads Security's alarms and guard reports. Which fields each role sees is set under Field access; clearance details only ever reach roles that see clearance levels, and the rest see badge images instead. Administrators can do everything. The kiosk only ever shows names; Equipment Checkout's fields are set under Field access." }),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Role", "For", "Directory", "Visitors", "Badges", "Facilities", "Finance", "Clearance levels", "Custom fields", "Alarms", "Accounts", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, roles.map((r) => h("tr", {},
        h("td", {}, h("strong", { text: r.name }), r.builtIn ? h("span", { class: "badge muted", text: "Built in" }) : null),
        h("td", { class: "small-text", text: r.kind === "api" && r.builtIn ? "Template for new API clients" : KIND_LABELS[r.kind] }),
        h("td", { class: "small-text", text: AREA_LABELS[r.directory] }),
        h("td", { class: "small-text", text: r.kind === "user" ? AREA_LABELS[r.visitors] : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" ? BADGE_LABELS[r.badges] : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" ? AREA_LABELS[r.facilities] : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" ? AREA_LABELS[r.finance || "none"] : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" ? (r.clearances ? "Sees them" : "Badge images") : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" ? (r.id === "admin" ? "Adds, changes, deletes" : r.fields ? "Adds and changes" : "—") : "—" }),
        h("td", { class: "small-text", text: r.kind === "user" && r.alarms ? "Reads them" : "—" }),
        h("td", { text: r.kind === "user" ? String(r.accounts) : "—" }),
        h("td", {}, r.id === "admin" || r.kind !== "user" ? (r.kind === "api" && !r.builtIn ? h("a", { href: "#settings/api", class: "small-text", text: "Set under API clients" }) : null) : h("div", { class: "btn-row" },
          h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editRole(r, staff) }),
          r.builtIn ? null : h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: () => deleteRole(r) }))))))))));
}

async function editRole(role, staff) {
  const levels = ["none", "read", "edit"].map((v) => ({ value: v, label: AREA_LABELS[v] }));
  const saved = await formDialog({
    title: role ? `Edit ${role.name}` : "Add role",
    fields: [
      role?.builtIn ? { type: "readonly", name: "name", label: "Name", value: role.name } : { name: "name", label: "Name", value: role?.name, required: true },
      { name: "directory", label: "Companies and people", type: "select", value: role?.directory || "read", options: levels, half: true },
      { name: "visitors", label: "Visitors and visits", type: "select", value: role?.visitors || "none", options: levels, half: true },
      { name: "badges", label: "Badges", type: "select", value: role?.badges || "none", options: Object.entries(BADGE_LABELS).map(([value, label]) => ({ value, label })), half: true, hint: "Read to look; issue and return to give badges out and take them back; manage also adds, changes and removes badges (Security)." },
      { name: "facilities", label: "Facilities", type: "select", value: role?.facilities || "none", options: levels, half: true, hint: "Floor plans, offices, who has them, what they cost, leases and charges. Read and change also draws offices, assigns them, sets rates, makes leases and logs charges." },
      { name: "finance", label: "Finance", type: "select", value: role?.finance || "none", options: levels, half: true, hint: "Invoices, payments and balances. Read and change also makes and issues invoices, records payments, logs charges and keeps the billing settings and QuickBooks." },
      { name: "fields", label: "Manages custom fields", type: "checkbox", value: Boolean(role?.fields),
        hint: "Adds custom fields, and changes their names, choices and whether they're required, for the records this role can change, and badge fields if it issues or manages badges (Settings > Fields). Filling in a badge's fields stays with roles that manage badges; deleting a field and Field access stay with administrators." },
      { name: "clearances", label: "Sees clearance levels", type: "checkbox", value: Boolean(role?.clearances), disabled: role?.id === "security",
        hint: role?.id === "security" ? "Security validates clearances, so it always sees them." : "Level names on people, visitors and badges. Without it the role sees each badge's image instead, and clearance details stay hidden whatever the field access grid says." },
      { name: "alarms", label: "Reads alarms and guard reports", type: "checkbox", value: Boolean(role?.alarms), disabled: role?.id === "security",
        hint: role?.id === "security" ? "Security always reads them, and is the only role that adds them from a file." : "Opens the alarm notices and guard daily reports under Security (at the account's sites), as an alarm responder does. Only Security adds them from a file; the mailbox is set up under Security mail." },
      ...(role ? [] : [{ name: "copyFrom", label: "Start its field access from", type: "select", value: "viewer", options: staff.map((r) => ({ value: r.id, label: r.name })), hint: "You can change any cell afterwards under Field access." }])
    ],
    submitLabel: role ? "Save" : "Add role",
    onSubmit: async (v) => (role
      ? await api(`/api/roles/${role.id}`, { method: "PUT", body: role.builtIn ? { directory: v.directory, visitors: v.visitors, badges: v.badges, facilities: v.facilities, finance: v.finance, fields: v.fields, ...(role.id === "security" ? {} : { clearances: v.clearances, alarms: v.alarms }) } : v })
      : await api("/api/roles", { method: "POST", body: v })).role
  });
  if (saved) {
    toast("Saved.");
    renderSettings();
  }
}

async function deleteRole(role) {
  if (!(await confirmDialog(`Delete the role ${role.name}?`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    await api(`/api/roles/${role.id}`, { method: "DELETE" });
    renderSettings();
  } catch (error) {
    toast(error.message, "error");
  }
}

// --- users ------------------------------------------------------------------------------------------

async function settingsUsers(body) {
  const [{ users }, { roles }] = await Promise.all([api("/api/users"), api("/api/roles")]);
  const staffRoles = roles.filter((r) => r.kind === "user");
  const siteName = (id) => state.config.sites.find((s) => s.id === id)?.name || `site ${id}`;
  const panel = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Users" }), h("div", { class: "btn-row" },
      h("button", { type: "button", class: "secondary small", text: "Add Microsoft user", onclick: () => addUser("entra", staffRoles) }),
      h("button", { type: "button", class: "primary small", text: "Add local user", onclick: () => addUser("local", staffRoles) }))),
    h("p", { class: "muted", text: `Each account has one or more roles (see Roles); with several, it can do whatever any of them can.${multiSite() ? " It sees every site unless limited to some: a limited account sees only the companies at its sites, and their people who work there." : ""}` }),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["User", "Sign-in", "Roles", ...(multiSite() ? ["Sites"] : []), "Last sign-in", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, users.map((u) => {
        const names = u.roles.map((id) => staffRoles.find((r) => r.id === id)?.name || id);
        const role = u.id === state.me.id
          ? h("span", { class: "small-text", text: names.join(", "), title: "You can't change your own roles" })
          : h("button", { type: "button", class: "link-btn role-list", text: names.join(", "), title: `Change the roles of ${u.username}`, onclick: () => editUserRoles(u, staffRoles) });
        const actions = h("div", { class: "btn-row" });
        if (u.provider === "local" && u.mfaEnrolled) actions.append(h("button", { type: "button", class: "link-btn", text: "Reset 2FA", onclick: async () => { if (await confirmDialog(`Clear two-factor sign-in for ${u.username}? They will be signed out.`)) { await api(`/api/users/${u.id}/reset-mfa`, { method: "POST", body: {} }); renderSettings(); } } }));
        if (u.provider === "local") actions.append(h("button", { type: "button", class: "link-btn", text: "Set password", onclick: () => formDialog({ title: `New password for ${u.username}`, fields: [{ name: "password", label: "New password (12 characters or more)", type: "password", required: true, autocomplete: "new-password" }], onSubmit: async (v) => { await api(`/api/users/${u.id}/password`, { method: "POST", body: v }); toast("Password set."); return true; } }) }));
        if (u.id !== state.me.id) actions.append(h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => { if (await confirmDialog(`Remove ${u.username}? They will be signed out.`, { danger: true, confirmLabel: "Remove" })) { try { await api(`/api/users/${u.id}`, { method: "DELETE" }); renderSettings(); } catch (error) { toast(error.message, "error"); } } } }));
        return h("tr", {},
          h("td", {}, h("strong", { text: u.displayName || u.username }), u.displayName ? h("div", { class: "muted small-text", text: u.username }) : null, u.id === state.me.id ? h("span", { class: "badge", text: "You" }) : null),
          h("td", { class: "small-text" }, u.provider === "entra" ? (u.entraLinked ? "Microsoft" : "Microsoft (not signed in yet)") : ["Password", u.mfaEnrolled ? "+ code" : null, u.passkeys ? `+ ${u.passkeys} passkey${u.passkeys === 1 ? "" : "s"}` : null].filter(Boolean).join(" ")),
          h("td", {}, role),
          multiSite() ? h("td", { class: "small-text" }, u.roles.includes("admin") ? "Every site" : h("button", { type: "button", class: "link-btn", text: u.sites ? u.sites.map(siteName).join(", ") : "Every site", onclick: () => editUserSites(u) })) : null,
          h("td", { class: "small-text", text: u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never" }),
          h("td", {}, actions));
      })))));
  body.append(panel);
}

/** A site chooser for an account: "Every site", or ticks for some. Returns { node, value() }. */
function siteLimitPicker(current = null) {
  const every = h("input", { type: "checkbox" });
  every.checked = !current;
  const ticks = state.config.sites.map((s) => {
    const tick = h("input", { type: "checkbox" });
    tick.checked = Boolean(current && current.includes(s.id));
    return { site: s, tick };
  });
  const list = h("div", { class: "site-ticks" }, ticks.map((t) => h("label", { class: "check-row" }, t.tick, h("span", { text: t.site.name }))));
  const sync = () => { list.hidden = every.checked; };
  every.addEventListener("change", sync);
  sync();
  return {
    node: h("div", { class: "full-row" }, h("span", { class: "label", text: "Sites" }), h("label", { class: "check-row" }, every, h("span", { text: "Every site" })), list),
    value: () => (every.checked ? null : ticks.filter((t) => t.tick.checked).map((t) => t.site.id))
  };
}

async function editUserSites(user) {
  const picker = siteLimitPicker(user.sites);
  const saved = await formDialog({
    title: `Sites for ${user.username}`,
    fields: [{ node: picker.node }],
    onSubmit: async () => (await api(`/api/users/${user.id}/sites`, { method: "POST", body: { sites: picker.value() } })).user
  });
  if (saved) renderSettings();
}

/**
 * Ticks for an account's roles: { node, value() }. Administrator can do everything, so ticking
 * it clears and disables the others.
 */
function rolePicker(staffRoles, current = ["viewer"]) {
  const ticks = staffRoles.map((r) => {
    const tick = h("input", { type: "checkbox", checked: current.includes(r.id) });
    return { role: r, tick };
  });
  const admin = ticks.find((t) => t.role.id === "admin");
  const sync = () => {
    for (const t of ticks) if (t !== admin) t.tick.disabled = Boolean(admin?.tick.checked);
  };
  admin?.tick.addEventListener("change", sync);
  sync();
  const describe = (r) => [`directory ${AREA_LABELS[r.directory].toLowerCase()}`, `visitors ${AREA_LABELS[r.visitors].toLowerCase()}`, `badges ${BADGE_LABELS[r.badges].toLowerCase()}`, `facilities ${AREA_LABELS[r.facilities].toLowerCase()}`, `finance ${AREA_LABELS[r.finance || "none"].toLowerCase()}`].join(", ");
  return {
    node: h("div", { class: "full-row" },
      h("span", { class: "label", text: "Roles" }),
      h("div", { class: "role-ticks" }, ticks.map((t) => h("label", { class: "check-row" }, t.tick,
        h("span", {}, h("strong", { text: t.role.name }), h("span", { class: "muted small-text", text: t.role.id === "admin" ? " everything" : ` ${describe(t.role)}` }))))),
      h("span", { class: "hint", text: "With several roles the account can do whatever any of them can, and sees any field one of them sees." })),
    value: () => (admin?.tick.checked ? ["admin"] : ticks.filter((t) => t.tick.checked).map((t) => t.role.id))
  };
}

async function editUserRoles(user, staffRoles) {
  const picker = rolePicker(staffRoles, user.roles);
  const saved = await formDialog({
    title: `Roles of ${user.username}`,
    fields: [{ node: picker.node }],
    onSubmit: async () => {
      const roles = picker.value();
      if (!roles.length) throw new Error("Choose at least one role.");
      return (await api(`/api/users/${user.id}/role`, { method: "POST", body: { roles } })).user;
    }
  });
  if (saved) {
    toast(`${saved.username}: ${saved.roleName}.`);
    renderSettings();
  }
}

async function addUser(provider, staffRoles) {
  const picker = multiSite() ? siteLimitPicker(null) : null;
  const roles = rolePicker(staffRoles);
  const roleField = { node: roles.node };
  const created = await formDialog({
    title: provider === "entra" ? "Add Microsoft user" : "Add local user",
    intro: provider === "entra" ? h("p", { class: "muted", text: "They sign in with \"Sign in with Microsoft\"; the account links to them the first time they do." }) : null,
    fields: [
      ...(provider === "entra"
        ? [{ name: "username", label: "Microsoft sign-in name (UPN)", type: "email", required: true, placeholder: "jane@contoso.com" }]
        : [{ name: "username", label: "Username", required: true, hint: "3 to 32 letters, digits, dots, dashes or underscores." },
          { name: "password", label: "Password (12 characters or more)", type: "password", required: true, autocomplete: "new-password" }]),
      roleField,
      ...(picker ? [{ node: picker.node }] : [])
    ],
    submitLabel: "Add user",
    onSubmit: async (v) => {
      if (!roles.value().length) throw new Error("Choose at least one role.");
      return (await api("/api/users", { method: "POST", body: { ...v, roles: roles.value(), provider, sites: picker ? picker.value() : null } })).user;
    }
  });
  if (created) {
    toast(`Added ${created.username}.`);
    renderSettings();
  }
}

// --- Microsoft Entra ID -----------------------------------------------------------------------------------

async function settingsEntra(body) {
  const { entra, redirectUri, appUrlSet, roles } = await api("/api/entra");
  const steps = h("div", { class: "panel" },
    h("h3", { text: "Setting up the app registration" }),
    h("ol", { class: "plain-list numbered" },
      h("li", {}, "In the Entra admin center: App registrations > New registration. Supported account types: this organizational directory only."),
      h("li", {}, "Redirect URI: platform Web, ", h("code", { class: "copy", text: redirectUri }), appUrlSet ? null : h("span", { class: "muted", text: " (taken from the address you are using now; set APP_URL to fix it)" })),
      h("li", {}, "Certificates & secrets: either Certificates > Upload certificate, with the .cer file from Certificates below (recommended: nothing secret leaves this server), or Client secrets > New client secret, copying the value (not the ID) into the form below."),
      h("li", {}, `Optional: App roles whose value is a role's name without spaces (${roles.map((r) => r.name.replace(/\s+/g, "")).join(", ")}), assigned to users or groups under Enterprise applications. Roles in the sign-in (every one that matches) replace the roles stored here.`),
      h("li", {}, "Optional: Enterprise applications > this app > Properties > Assignment required = Yes, so only assigned people can sign in at all.")));
  const { form } = settingsForm({
    title: "Microsoft Entra ID sign-in",
    intro: entra.readOnly ? "Configured with ENTRA_* environment variables; change it there." : "People sign in with their Microsoft work account. Local accounts keep working alongside.",
    fields: [
      { name: "enabled", label: "Allow sign-in with Microsoft", type: "checkbox", value: entra.enabled, disabled: entra.readOnly },
      { name: "tenantId", label: "Directory (tenant) ID", value: entra.tenantId, half: true, disabled: entra.readOnly },
      { name: "clientId", label: "Application (client) ID", value: entra.clientId, half: true, disabled: entra.readOnly },
      { name: "credential", label: "The app proves who it is with", type: "select", value: entra.credential, half: true, disabled: entra.readOnly, options: [
        { value: "certificate", label: "A certificate (recommended)" },
        { value: "secret", label: "A client secret" }],
        hint: "A certificate needs one in use under Certificates below, added to the app registration." },
      { name: "clientSecret", label: "Client secret", type: "password", half: true, placeholder: entra.hasSecret ? "Saved; type to replace" : "", disabled: entra.readOnly, hint: "Only used when the app uses a client secret." },
      { name: "buttonLabel", label: "Button text", value: entra.buttonLabel, half: true, disabled: entra.readOnly },
      { name: "defaultRole", label: "Someone who signs in for the first time", type: "select", value: entra.defaultRole, disabled: entra.readOnly, options: [
        { value: "none", label: "Is refused unless an administrator added them under Users (or they have an app role)" },
        ...roles.filter((r) => r.id !== "admin").map((r) => ({ value: r.id, label: `Gets an account with the ${r.name} role, at every site` }))] }
    ],
    onSave: async (v) => {
      if (entra.readOnly) throw new Error("Configured by environment variables.");
      await api("/api/entra", { method: "PUT", body: v });
      return v.enabled ? "Saved. Test it below, then sign out and use \"Sign in with Microsoft\" to try it." : "Saved.";
    },
    extra: (values, msg) => h("button", { type: "button", class: "secondary", text: "Test with Microsoft", title: "Asks Microsoft for a token with the saved settings: no one is signed in", onclick: () => testEntraCredential(null, msg) })
  });
  body.append(form, entraCertificatesPanel(entra), steps);
}

/** Asks Microsoft whether it accepts the saved credential, or one certificate (by id); shows the answer in `msg` or a toast. */
async function testEntraCredential(certificateId, msg = null) {
  try {
    const r = await api("/api/entra/test", { method: "POST", body: certificateId ? { certificateId } : {} });
    if (msg) {
      msg.className = `message ${r.ok ? "success" : "error"}`;
      msg.textContent = r.message;
      msg.hidden = false;
    } else {
      toast(r.message, r.ok ? "ok" : "error");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

const CERT_SOURCES = { generated: "Made here", uploaded: "Uploaded", environment: "From the environment" };

/** The certificates the app can sign in with: made here or uploaded, one in use, each to download, test, use or remove. */
function entraCertificatesPanel(entra) {
  const reload = () => renderSettings();
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  const certs = entra.certificates;
  const inUse = entra.credential === "certificate";
  const status = (c) => {
    if (c.expired) return h("span", { class: "badge bad", text: "Expired" });
    const tags = [];
    if (c.active) tags.push(h("span", { class: `badge${inUse ? " ok" : ""}`, text: inUse ? "In use" : "Chosen", title: inUse ? null : "The one used when the app signs in with a certificate; it uses its client secret for now" }));
    if (c.expiring) tags.push(h("span", { class: "badge warn", text: `Expires in ${c.daysLeft} ${c.daysLeft === 1 ? "day" : "days"}` }));
    return tags;
  };
  const rows = certs.map((c) => h("tr", {},
    h("td", {}, h("div", { text: c.subject }), h("div", { class: "muted small-text", text: CERT_SOURCES[c.source] || c.source }), status(c)),
    h("td", {}, h("code", { class: "copy thumbprint", text: c.thumbprint, title: "SHA-1 thumbprint, as the Entra admin center shows it" })),
    h("td", { class: "small-text nowrap", text: fmtDate(c.notAfter) }),
    h("td", {}, h("div", { class: "btn-row" },
      h("button", { type: "button", class: "link-btn", text: "Download .cer", onclick: run(() => download(`/api/entra/certificates/${c.id}/cer`)) }),
      h("button", { type: "button", class: "link-btn", text: "Test", title: "Asks Microsoft whether it accepts this certificate for the app", onclick: () => testEntraCredential(c.id) }),
      !entra.readOnly && !c.active && !c.expired ? h("button", { type: "button", class: "link-btn", text: "Use this one", onclick: run(async () => {
        if (!(await confirmDialog(`Sign in with the certificate ${c.thumbprint} from now on? Add it to the app registration in Entra first (Test says whether it is there), or Microsoft sign-in will fail.`, { confirmLabel: "Use it" }))) return;
        await api(`/api/entra/certificates/${c.id}/use`, { method: "POST" });
        toast("Now in use. Once you're sure it works, remove the old one here and in Entra.");
        reload();
      }) }) : null,
      !entra.readOnly ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: run(async () => {
        if (!(await confirmDialog(`Remove the certificate ${c.thumbprint} and its private key from this app? Remove it from the app registration in Entra too.`, { danger: true, confirmLabel: "Remove" }))) return;
        await api(`/api/entra/certificates/${c.id}`, { method: "DELETE" });
        toast("Removed.");
        reload();
      }) }) : null))));
  return h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      h("h3", { text: "Certificates" }),
      entra.readOnly ? null : h("div", { class: "btn-row" },
        h("button", { type: "button", class: "secondary small", text: "Upload a certificate", onclick: run(async () => { if (await uploadEntraCertificate()) reload(); }) }),
        h("button", { type: "button", class: "primary small", text: "Make a certificate", onclick: run(async () => { if (await makeEntraCertificate()) reload(); }) }))),
    h("p", { class: "muted", text: entra.readOnly
      ? "Set by ENTRA_CERT_FILE and ENTRA_KEY_FILE, or ENTRA_PFX_FILE."
      : "Instead of a secret, the app can sign each request to Microsoft with a certificate's private key, which is kept in the encrypted database and never leaves this server. Make one here (or upload your own), download its .cer file and upload that to the app registration. To renew, make a new one, add it in Entra, test it, then use it and remove the old one: sign-in carries on throughout." }),
    entra.certificateError ? h("p", { class: "message error", text: entra.certificateError }) : null,
    certs.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Certificate", "Thumbprint", "Valid until", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, rows)))
      : h("p", { class: "muted small-text", text: "No certificates yet." }));
}

async function makeEntraCertificate() {
  const made = await formDialog({
    title: "Make a certificate",
    intro: h("p", { class: "muted", text: "A new key and a self-signed certificate for Microsoft sign-in. The private key stays in the encrypted database; you download only the certificate, to upload to the app registration in Entra (Certificates & secrets > Certificates)." }),
    fields: [{ name: "years", label: "Valid for", type: "select", value: "2", options: [{ value: "1", label: "1 year" }, { value: "2", label: "2 years" }, { value: "3", label: "3 years" }],
      hint: "Settings warns 30 days before it expires; make the next one then." }],
    submitLabel: "Make it",
    onSubmit: async (v) => (await api("/api/entra/certificates/generate", { method: "POST", body: { years: Number(v.years) } })).certificate
  });
  if (!made) return null;
  await download(`/api/entra/certificates/${made.id}/cer`);
  toast(made.active ? "Made. Upload the downloaded .cer file to the app registration in Entra, then test it." : "Made. Upload the downloaded .cer file to Entra, test it, then choose Use this one.");
  return made;
}

/** Reads a chosen file: as base64 (binary) or as text. */
function readChosenFile(input, asText) {
  const file = input.files[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(asText ? reader.result : String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("That file can't be read."));
    if (asText) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function uploadEntraCertificate() {
  const kind = h("select", { name: "kind" },
    h("option", { value: "pfx", text: "A PFX / P12 file (certificate and key together)" }),
    h("option", { value: "pem", text: "PEM files (certificate, and its private key)" }));
  const pfxFile = h("input", { type: "file", accept: ".pfx,.p12,application/x-pkcs12" });
  const pfxPassword = h("input", { type: "password", autocomplete: "off" });
  const certFile = h("input", { type: "file", accept: ".pem,.crt,.cer" });
  const keyFile = h("input", { type: "file", accept: ".pem,.key" });
  const passphrase = h("input", { type: "password", autocomplete: "off" });
  const field = (label, input, hint = null) => h("label", {}, h("span", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
  const pfxPart = h("div", { class: "stack" }, field("PFX file", pfxFile), field("Its password", pfxPassword, "Only used to open the file; it isn't kept."));
  const pemPart = h("div", { class: "stack", hidden: true }, field("Certificate (PEM)", certFile, "May include its chain; the one matching the key is used."), field("Private key (PEM)", keyFile), field("Key passphrase", passphrase, "If the key is encrypted. It isn't kept."));
  kind.addEventListener("change", () => { pfxPart.hidden = kind.value !== "pfx"; pemPart.hidden = kind.value !== "pem"; });
  const done = await openDialog({
    title: "Upload a certificate",
    body: h("div", { class: "stack" },
      h("p", { class: "muted", text: "Your own certificate for Microsoft sign-in, with its private key. It needs an RSA key of 2048 bits or more. The key is kept in the encrypted database; upload the certificate (without the key) to the app registration in Entra too." }),
      field("What you have", kind), pfxPart, pemPart),
    actions: [
      { label: "Cancel", value: null },
      {
        label: "Upload",
        kind: "primary",
        onClick: async () => {
          let bodyData;
          if (kind.value === "pfx") {
            const pfx = await readChosenFile(pfxFile, false);
            if (!pfx) throw new Error("Choose the PFX file.");
            bodyData = { pfx, password: pfxPassword.value };
          } else {
            const [certPem, keyPem] = await Promise.all([readChosenFile(certFile, true), readChosenFile(keyFile, true)]);
            if (!certPem || !keyPem) throw new Error("Choose the certificate and the private key.");
            bodyData = { certPem, keyPem, passphrase: passphrase.value };
          }
          return (await api("/api/entra/certificates/upload", { method: "POST", body: bodyData })).certificate;
        }
      }
    ]
  });
  if (done) toast(done.active ? "Uploaded and in use once the app uses a certificate. Add it to the app registration in Entra, then test it." : "Uploaded. Add it to Entra, test it, then choose Use this one.");
  return done;
}

// --- import, export and backup ----------------------------------------------------------------------------

async function settingsData(body) {
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  body.append(
    h("div", { class: "panel" },
      h("h3", { text: "Import" }),
      h("p", { class: "muted", text: "Add or update companies, people, visitors and badges from an Access database (.accdb or .mdb) or a CSV file, matching its columns to the fields. Import companies first if the people you import name companies that don't exist yet, or let the people import add them." }),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "secondary", text: "Import companies", onclick: run(async () => { if (await importDialog("companies")) loadCompanies(); }) }),
        h("button", { type: "button", class: "secondary", text: "Import people", onclick: run(() => importDialog("people")) }),
        h("button", { type: "button", class: "secondary", text: "Import visitors", onclick: run(() => importDialog("visitors")) }),
        h("button", { type: "button", class: "secondary", text: "Import badges", onclick: run(() => importDialog("badges")) }))),
    h("div", { class: "panel" },
      h("h3", { text: "Export" }),
      h("p", { class: "muted", text: "Every field, custom ones included, as CSV. An export is plain text: keep it somewhere safe and delete it when done. Each export is recorded in the audit log." }),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "secondary", text: "Export companies", onclick: run(() => download("/api/companies.csv")) }),
        h("button", { type: "button", class: "secondary", text: "Export people", onclick: run(() => download("/api/people.csv")) }))),
    h("div", { class: "panel" },
      h("h3", { text: "Backup" }),
      h("p", { text: "A copy of the whole database: directory, fields, roles, accounts, sites and logos. It is encrypted with the same key as the live database and is useless without it. The key is not in the backup." }),
      h("p", { class: "muted", text: "To restore: stop the app, put the file in the data directory as identity.db, and start the app with the key that was in use when the backup was made." }),
      h("button", { type: "button", class: "primary", text: "Download backup", onclick: run(() => download("/api/backup")) })));
}

// --- audit log -------------------------------------------------------------------------------------------------

// --- Settings > Logs and retention ------------------------------------------------------------------

/**
 * How long each log is kept, in one place: the audit log (sign-ins apart from the rest), visits,
 * alarms and guard reports, and how long a validation request's SSN digits are held. What a
 * change to the audit log would delete is shown before it is saved.
 */
async function settingsRetention(body) {
  const r = await api("/api/settings/retention");
  const keepText = (n, unit) => (n ? `${n.toLocaleString()} ${unit}` : "for ever");
  const preview = h("p", { class: "muted small-text full-row", text: "Change the days to see what the next daily run would delete." });
  const fields = [
    { type: "heading", label: "Audit log" },
    { name: "auditDays", label: "Keep changes for (days)", type: "number", half: true, value: r.audit.auditDays,
      hint: `0 keeps them for ever; otherwise ${r.audit.least.auditDays} to ${r.audit.most.toLocaleString()}. Who changed what, everything but sign-ins.`, onChange: (input, inputs) => showPreview(inputs) },
    { name: "signinDays", label: "Keep sign-ins for (days)", type: "number", half: true, value: r.audit.signinDays,
      hint: `0 keeps them for ever; otherwise ${r.audit.least.signinDays} to ${r.audit.most.toLocaleString()}. Signing in and out, failed attempts, and addresses blocked for too many.`, onChange: (input, inputs) => showPreview(inputs) },
    { node: preview },
    { type: "heading", label: "Visits and Security" },
    { name: "visitsMonths", label: "Keep visits for (months)", type: "number", half: true, value: r.visits.retentionMonths,
      hint: "0 keeps them for ever. The visit log, with its corrections; visits still open are never deleted. Also under Settings > Visits." },
    { name: "securityMailDays", label: "Keep alarms and guard reports for (days)", type: "number", half: true, value: r.securityMail.keepDays,
      hint: "30 to 3,650. Also under Settings > Security mail." },
    { type: "heading", label: "Clearance validation requests" },
    { name: "digitsHours", label: "Hold a request's SSN digits for (hours)", type: "number", half: true, value: r.clearance.digitsHours,
      hint: `1 to ${r.clearance.maxDigitsHours} (a week at most). The last four digits given with a request are kept in memory only, never stored or logged, and wiped when Security validates or cancels it, or after this long. A shorter time applies to digits already held.` }
  ];
  const showPreview = debounce(async (inputs) => {
    try {
      const p = await api(`/api/settings/retention/preview?${new URLSearchParams({ auditDays: inputs.auditDays.value || "0", signinDays: inputs.signinDays.value || "0" })}`);
      preview.textContent = p.audit || p.signins
        ? `With these, the next daily run deletes ${p.audit.toLocaleString()} audit ${p.audit === 1 ? "entry" : "entries"} and ${p.signins.toLocaleString()} ${p.signins === 1 ? "sign-in" : "sign-ins"}.`
        : "With these, nothing in the audit log is old enough to delete yet.";
    } catch {
      preview.textContent = "";
    }
  }, 300);
  const form = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Logs and retention" })),
    h("p", { class: "muted", text: `How long each record is kept; older ones are deleted once a day.${(r.audit.auditDays || r.audit.signinDays) && r.audit.lastRun ? ` The audit log was last trimmed ${fmtDateTime(r.audit.lastRun)}.` : ""}` }));
  const editBtn = h("button", { type: "button", class: "primary small", text: "Change", onclick: async () => {
    const saved = await formDialog({
      title: "Logs and retention",
      fields,
      submitLabel: "Save",
      onSubmit: async (v) => {
        await api("/api/settings/retention", { method: "PUT", body: { auditDays: Number(v.auditDays), signinDays: Number(v.signinDays), visitsMonths: Number(v.visitsMonths), securityMailDays: Number(v.securityMailDays), digitsHours: Number(v.digitsHours) } });
        return true;
      }
    });
    if (saved) {
      toast("Saved.");
      await reloadConfig();
      renderSettings();
    }
  } });
  form.querySelector(".panel-head").append(editBtn);
  const rows = [
    ["Audit log: changes", keepText(r.audit.auditDays, "days"), r.audit.wouldDelete.audit ? `${r.audit.wouldDelete.audit.toLocaleString()} older, deleted at the next run` : ""],
    ["Audit log: sign-ins", keepText(r.audit.signinDays, "days"), r.audit.wouldDelete.signins ? `${r.audit.wouldDelete.signins.toLocaleString()} older, deleted at the next run` : ""],
    ["Visits (the visit log)", keepText(r.visits.retentionMonths, "months"), r.visits.wouldDelete?.visits ? `${r.visits.wouldDelete.visits.toLocaleString()} older, deleted at the next run` : ""],
    ["Alarms and guard reports", `${r.securityMail.keepDays.toLocaleString()} days`, ""],
    ["SSN digits with a validation request", `${r.clearance.digitsHours} hours, in memory only`, ""]
  ];
  form.append(h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, ["Record", "Kept", ""].map((t) => h("th", { text: t })))),
    h("tbody", {}, rows.map(([what, kept, note]) => h("tr", {}, h("td", { text: what }), h("td", { text: kept }), h("td", { class: "muted small-text", text: note })))))));
  body.append(form);
}

// --- Settings > Audit log -----------------------------------------------------------------------------

async function settingsAudit(body) {
  let before = null;
  const tbody = h("tbody");
  const more = h("button", { type: "button", class: "secondary small", text: "Older entries", hidden: true });
  // Filters: who, what, sign-ins, where from, and when.
  const facets = await api("/api/audit/facets").catch(() => ({ users: [], actions: [] }));
  const user = h("select", { "aria-label": "User" }, h("option", { value: "", text: "Every user" }), facets.users.map((u) => h("option", { value: u, text: u })));
  const groups = [...new Set(facets.actions.map((a) => a.split(".")[0]))];
  const action = h("select", { "aria-label": "Action" }, h("option", { value: "", text: "Every action" }),
    groups.map((g) => h("optgroup", { label: g }, h("option", { value: `${g}.`, text: `All ${g}` }), facets.actions.filter((a) => a.startsWith(`${g}.`)).map((a) => h("option", { value: a, text: a })))));
  const signins = h("select", { "aria-label": "Sign-ins" }, h("option", { value: "", text: "Sign-ins and changes" }), h("option", { value: "only", text: "Sign-ins only" }), h("option", { value: "hide", text: "Changes only (no sign-ins)" }));
  const ip = h("input", { type: "search", placeholder: "IP address", "aria-label": "IP address", autocomplete: "off", class: "audit-ip" });
  const from = h("input", { type: "date", "aria-label": "From" });
  const to = h("input", { type: "date", "aria-label": "To" });
  const clearBtn = h("button", { type: "button", class: "link-btn small-text", text: "Clear filters", onclick: () => { for (const el of [user, action, signins, ip, from, to]) el.value = ""; restart(); } });
  const query = () => new URLSearchParams(Object.fromEntries([["username", user.value], ["action", action.value], ["signins", signins.value], ["ip", ip.value.trim()], ["from", from.value], ["to", to.value]].filter(([, v]) => v)));
  async function restart() {
    before = null;
    tbody.replaceChildren();
    await page();
  }
  for (const el of [user, action, signins, from, to]) el.addEventListener("change", restart);
  ip.addEventListener("input", debounce(restart, 300));
  async function page() {
    const data = await api(`/api/audit?limit=100${before ? `&before=${before}` : ""}&${query()}`);
    for (const e of data.entries) {
      tbody.append(h("tr", {},
        h("td", { class: "small-text nowrap", text: fmtDateTime(e.at) }),
        h("td", { class: "small-text" }, e.username ? h("button", { type: "button", class: "link-btn small-text", text: e.username, title: `Only ${e.username}`, onclick: () => { user.value = e.username; restart(); } }) : ""),
        h("td", { class: "mono small-text", text: e.action }),
        h("td", { class: "small-text", text: [e.target, e.detail].filter(Boolean).join(": ") }),
        h("td", { class: "small-text mono" }, e.ip ? h("button", { type: "button", class: "link-btn small-text mono", text: e.ip, title: `Only from ${e.ip}`, onclick: () => { ip.value = e.ip; restart(); } }) : "")));
      before = e.id;
    }
    if (!tbody.children.length) tbody.append(emptyRow(5, [...query().keys()].length ? "Nothing matches these filters." : "Nothing recorded yet."));
    more.hidden = !data.more;
  }
  more.addEventListener("click", page);
  body.append(h("div", { class: "panel" }, h("h3", { text: "Audit log" }),
    h("p", { class: "muted", text: "Who changed what, and from where. Changes name the fields that changed, never their values. Click a user or an address to see only theirs. How long entries are kept is under Logs and retention." }),
    h("div", { class: "toolbar audit-filters" }, user, action, signins, ip, h("label", { class: "inline" }, "From ", from), h("label", { class: "inline" }, "To ", to), clearBtn),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact" }, h("thead", {}, h("tr", {}, ["When", "Who", "Action", "Detail", "From"].map((t) => h("th", { text: t })))), tbody)),
    more));
  await page();
}

function showSettings(sub) {
  if (sub) settingsTab = sub;
  renderSettings();
}
