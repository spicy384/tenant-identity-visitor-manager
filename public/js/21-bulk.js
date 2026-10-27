// 21-bulk.js: working on several at once. On Companies, Select turns the list into tick
// boxes: merge the chosen companies into one (choosing which to keep, and editing its name and
// details with the others' values to hand), make them inactive or active, or delete them. On
// People, tick boxes beside each row: change chosen fields for all of them at once (custom
// fields included), make them inactive or active, delete them, or (Security) validate the same
// clearance for them all; on Visitors, Security does that too. The server does each as all or
// nothing.

// --- companies ------------------------------------------------------------------------------------

function companyPickRow(c, sub) {
  const box = h("input", { type: "checkbox", "aria-label": `Choose ${c.name}` });
  box.checked = companiesView.picked.has(c.id);
  box.addEventListener("change", () => {
    if (box.checked) companiesView.picked.set(c.id, c);
    else companiesView.picked.delete(c.id);
    row.classList.toggle("is-picked", box.checked);
    renderCompanyActions();
  });
  const row = h("label", { class: `company-pick${box.checked ? " is-picked" : ""}${c.active ? "" : " inactive"}` }, box,
    h("span", { class: "nav-list-main" }, h("strong", { text: c.name }), h("span", { class: "muted", text: sub })));
  return row;
}

function setCompanyPicking(on) {
  companiesView.picking = on;
  if (!on) companiesView.picked.clear();
  $("companies-pick").textContent = on ? "Done" : "Select";
  loadCompanies();
}

$("companies-pick").addEventListener("click", () => setCompanyPicking(!companiesView.picking));

function renderCompanyActions() {
  const bar = $("companies-actions");
  bar.hidden = !companiesView.picking;
  if (!companiesView.picking) return bar.replaceChildren();
  const list = [...companiesView.picked.values()];
  const n = list.length;
  bar.replaceChildren(
    h("span", { class: "small-text", text: n ? `${n} chosen` : "Tick the companies to work on." }),
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "primary small", text: "Merge…", disabled: n < 2, title: n < 2 ? "Choose two or more" : null, onclick: () => mergeCompaniesDialog(list) }),
      h("button", { type: "button", class: "secondary small", text: "Make inactive", disabled: !n, onclick: () => bulkCompanies(list, { active: false }, "made inactive") }),
      h("button", { type: "button", class: "secondary small", text: "Make active", disabled: !n, onclick: () => bulkCompanies(list, { active: true }, "made active") }),
      isAdmin() ? h("button", { type: "button", class: "secondary small danger-text", text: "Delete", disabled: !n, onclick: () => deleteCompanies(list) }) : null));
  return null;
}

async function bulkCompanies(list, patch, done) {
  try {
    const r = await api("/api/companies/bulk", { method: "POST", body: { ids: list.map((c) => c.id), patch } });
    toast(`${r.updated} ${r.updated === 1 ? "company" : "companies"} ${done}.`);
    loadCompanies();
    if (companiesView.selected) showCompanyDetail(companiesView.selected);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteCompanies(list) {
  const people = list.reduce((n, c) => n + (c.peopleCount || 0), 0);
  if (!(await confirmDialog(`Delete ${list.length} ${list.length === 1 ? "company" : "companies"} (${list.map((c) => c.name).join(", ")})${people ? ` and their ${people} ${people === 1 ? "person" : "people"}` : ""}? This can't be undone. Making them inactive keeps the records.`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    const r = await api("/api/companies/bulk-delete", { method: "POST", body: { ids: list.map((c) => c.id) } });
    toast(`Deleted ${r.deleted} ${r.deleted === 1 ? "company" : "companies"}${r.peopleRemoved ? ` and ${r.peopleRemoved} people` : ""}.`);
    companiesView.picked.clear();
    if (list.some((c) => String(c.id) === String(companiesView.selected))) { companiesView.selected = null; showCompanyDetail(null); }
    loadCompanies();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Merging: first which company to keep, then its details to save, with each other company's
 * value for a field offered beside it. People, visitors' links, visits and events move to the
 * kept company; the others are then deleted.
 */
async function mergeCompaniesDialog(list) {
  const byPeople = [...list].sort((a, b) => (b.peopleCount || 0) - (a.peopleCount || 0));
  const keepId = await formDialog({
    title: `Merge ${list.length} companies`,
    intro: h("p", { text: "Which company do you keep? The others merge into it: their people, visitors' links, visits and visitor events move over, and then they are deleted. You can change the kept company's name and details next." }),
    fields: [{ name: "keep", label: "Keep", type: "select", value: String(byPeople[0].id), options: byPeople.map((c) => ({ value: String(c.id), label: `${c.name} (${c.peopleCount || 0} ${c.peopleCount === 1 ? "person" : "people"})` })) }],
    submitLabel: "Next",
    onSubmit: async (v) => Number(v.keep)
  });
  if (!keepId) return;
  let full;
  try {
    full = await Promise.all(list.map((c) => api(`/api/companies/${c.id}`)));
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  const kept = full.find((d) => d.company.id === keepId);
  const others = full.filter((d) => d !== kept);
  // Every site any of them is at, the kept company's suite first.
  const sites = new Map();
  for (const d of [kept, ...others]) for (const s of d.company.sites || []) if (!sites.has(s.siteId) || (!sites.get(s.siteId).suite && s.suite)) sites.set(s.siteId, { ...s });
  const record = { ...kept.company, sites: [...sites.values()] };
  const fields = kept.fields;
  const form = recordForm(fields, record);
  const byName = new Map(fields.map((f) => [formName(f), f]));
  // Beside each field, the other companies' values for it, to use instead with one click.
  for (const spec of form.fields) {
    const f = byName.get(spec.name);
    if (!f || f.access !== "edit" || f.type === "sites" || spec.type === "readonly") continue;
    const mine = JSON.stringify(fieldValue(record, f) ?? null);
    const values = [];
    for (const d of others) {
      const v = fieldValue(d.company, f);
      if (v === null || v === undefined || v === "" || JSON.stringify(v) === mine || values.some((x) => JSON.stringify(x.v) === JSON.stringify(v))) continue;
      values.push({ v, text: displayValue(f, v, d.company), from: d.company.name });
    }
    if (!values.length) continue;
    const before = spec.onChange;
    let placed = false;
    spec.onChange = (input, inputs, dlg) => {
      if (before) before(input, inputs, dlg);
      if (placed) return;
      placed = true;
      const use = (v) => {
        if (input.type === "checkbox") input.checked = Boolean(v);
        else if (f.type === "boolean" && !f.builtIn) input.value = v ? "yes" : "no";
        else input.value = String(v);
        input.dispatchEvent(new Event("change"));
      };
      (input.closest("label") || input.parentElement).append(h("div", { class: "merge-chips" },
        h("span", { class: "muted small-text", text: "From the others:" }),
        values.map((x) => h("button", { type: "button", class: "chip", title: `From ${x.from}`, text: typeof x.text === "string" ? x.text : x.text?.textContent || String(x.v), onclick: (e) => { e.preventDefault(); use(x.v); } }))));
    };
  }
  const moving = others.reduce((n, d) => n + d.people.length, 0);
  const merged = await formDialog({
    title: `Merge into ${kept.company.name}`,
    wide: true,
    intro: h("div", { class: "stack" },
      h("p", { text: `${others.map((d) => d.company.name).join(", ")} ${others.length === 1 ? "merges" : "merge"} into ${kept.company.name}: ${moving} ${moving === 1 ? "person moves" : "people move"} across, with their visitors' links, visits and events, and ${others.length === 1 ? "it is" : "they are"} then deleted. Fields added to one company only come along.` }),
      h("p", { class: "muted small-text", text: "The details below are what the merged company will have. Each other company's different value is offered under its field; the sites include everywhere any of them is." })),
    fields: form.fields,
    submitLabel: "Merge",
    onSubmit: async (v) => api("/api/companies/merge", { method: "POST", body: { intoId: kept.company.id, fromIds: others.map((d) => d.company.id), company: form.collect(v) } })
  });
  if (!merged) return;
  toast(`Merged ${merged.merged.join(", ")} into ${merged.company.name}; ${merged.peopleMoved} ${merged.peopleMoved === 1 ? "person" : "people"} moved.`);
  companiesView.picked.clear();
  setCompanyPicking(false);
  location.hash = `#company/${merged.company.id}`;
  showCompanyDetail(merged.company.id);
}

// --- people ---------------------------------------------------------------------------------------

/** The people chosen on the People page, across its pages. */
const peopleSelection = {
  ids: new Map(), // id -> the person as listed
  has(id) { return this.ids.has(id); },
  set(ids, on) {
    for (const id of ids) {
      if (on) this.ids.set(id, (peopleView.people || []).find((p) => p.id === id) || this.ids.get(id) || { id });
      else this.ids.delete(id);
    }
    drawPeople();
  },
  clear() { this.ids.clear(); drawPeople(); }
};

function renderPeopleActions() {
  const bar = $("people-actions");
  const n = peopleSelection.ids.size;
  bar.hidden = !n;
  if (!n) return bar.replaceChildren();
  const edits = canEditDirectory();
  bar.replaceChildren(
    h("span", { class: "small-text", text: `${n} ${n === 1 ? "person" : "people"} chosen` }),
    h("div", { class: "btn-row" },
      edits ? h("button", { type: "button", class: "primary small", text: "Edit…", onclick: () => bulkEditPeople() }) : null,
      edits ? h("button", { type: "button", class: "secondary small", text: "Make inactive", onclick: () => bulkPeople({ active: false }, "made inactive") }) : null,
      edits ? h("button", { type: "button", class: "secondary small", text: "Make active", onclick: () => bulkPeople({ active: true }, "made active") }) : null,
      isSecurity() ? h("button", { type: "button", class: edits ? "secondary small" : "primary small", text: "Validate clearance…", onclick: async () => {
        if (await validateClearances("person", [...peopleSelection.ids.values()])) { peopleSelection.ids.clear(); loadPeople(); }
      } }) : null,
      isAdmin() ? h("button", { type: "button", class: "secondary small danger-text", text: "Delete", onclick: () => deletePeople() }) : null,
      h("button", { type: "button", class: "link-btn small-text", text: "Clear", onclick: () => peopleSelection.clear() })));
  return null;
}

async function bulkPeople(patch, done) {
  const ids = [...peopleSelection.ids.keys()];
  if (patch.active === false && !(await confirmDialog(`Make ${ids.length} ${ids.length === 1 ? "person" : "people"} inactive? They stay on record, but drop out of lists, the kiosk's hosts and Equipment Checkout.`, { confirmLabel: "Make inactive" }))) return false;
  try {
    const r = await api("/api/people/bulk", { method: "POST", body: { ids, patch } });
    toast(`${r.updated} ${r.updated === 1 ? "person" : "people"} ${done}.`);
    peopleSelection.ids.clear();
    loadPeople();
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

async function deletePeople() {
  const ids = [...peopleSelection.ids.keys()];
  if (!(await confirmDialog(`Delete ${ids.length} ${ids.length === 1 ? "person" : "people"}? This can't be undone. Making them inactive keeps the records.`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    const r = await api("/api/people/bulk-delete", { method: "POST", body: { ids } });
    toast(`Deleted ${r.deleted} ${r.deleted === 1 ? "person" : "people"}.`);
    peopleSelection.ids.clear();
    loadPeople();
  } catch (error) {
    toast(error.message, "error");
  }
}

/** A control for one field in the bulk edit dialog; .read() gives the value to save. */
function bulkControl(f, companies) {
  const select = (options) => h("select", { "aria-label": f.label }, options.map((o) => h("option", { value: o.value, text: o.label })));
  let el;
  if (f.key === "company" && f.builtIn) el = select(companies.map((c) => ({ value: String(c.id), label: c.name })));
  else if (f.key === "site" && f.builtIn) el = select([{ value: "", label: "Any site" }, ...state.config.sites.filter((s) => s.active).map((s) => ({ value: String(s.id), label: s.name }))]);
  else if (f.type === "boolean") el = select([...(f.builtIn ? [] : [{ value: "", label: "Not set" }]), { value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
  else if (f.type === "choice") el = select([{ value: "", label: "Not set" }, ...f.choices.map((c) => ({ value: c, label: c }))]);
  else if (f.type === "longtext") el = h("textarea", { rows: 2, "aria-label": f.label });
  else el = h("input", { type: INPUT_TYPES[f.type] || "text", "aria-label": f.label, step: f.type === "number" ? "any" : null });
  const read = () => {
    const v = el.value;
    if (f.key === "company" && f.builtIn) return Number(v);
    if (f.key === "site" && f.builtIn) return v ? Number(v) : null;
    if (f.type === "boolean") return v === "yes" ? true : v === "no" ? false : null;
    if (f.type === "number") return v === "" ? null : Number(v);
    return String(v).trim() === "" ? null : String(v).trim();
  };
  return { el, read };
}

/** Changes the ticked fields for everyone chosen; a ticked field left empty is cleared. */
async function bulkEditPeople() {
  const ids = [...peopleSelection.ids.keys()];
  const skip = new Set(["firstName", "lastName", "preferredName", "email"]);
  const fields = (state.schema.person || []).filter((f) => f.access === "edit" && !f.recordOnly && f.type !== "sites" && !(f.builtIn && skip.has(f.key)));
  if (!fields.length) return toast("There are no fields this account can change for several people at once.", "error");
  const needsCompanies = fields.some((f) => f.builtIn && f.key === "company");
  const companies = needsCompanies ? await companyChoices() : [];
  const rows = fields.map((f) => {
    const control = bulkControl(f, companies);
    const change = h("input", { type: "checkbox", "aria-label": `Change ${f.label}` });
    control.el.disabled = true;
    change.addEventListener("change", () => { control.el.disabled = !change.checked; if (change.checked) control.el.focus(); });
    return { f, change, control, node: h("div", { class: "bulk-field" }, h("label", { class: "check-row" }, change, h("span", { text: f.label }), f.builtIn ? null : h("span", { class: "muted small-text", text: " (custom)" })), control.el) };
  });
  const result = await formDialog({
    title: `Change ${ids.length} ${ids.length === 1 ? "person" : "people"}`,
    wide: true,
    intro: h("p", { class: "muted", text: "Tick each field to change, and give its new value; it is set the same for everyone chosen. A ticked field left empty is cleared. Fields left unticked stay as they are. If any of them can't be changed, nothing is." }),
    fields: [{ node: h("div", { class: "full-row bulk-fields" }, rows.map((r) => r.node)) }],
    submitLabel: "Change",
    onSubmit: async () => {
      const patch = {};
      const custom = {};
      for (const r of rows) {
        if (!r.change.checked) continue;
        const value = r.control.read();
        if (r.f.builtIn) {
          if (r.f.key === "company") patch.companyId = value;
          else if (r.f.key === "site") patch.siteId = value;
          else if (r.f.type === "boolean" && value === null) continue;
          else patch[r.f.key] = value;
        } else {
          custom[r.f.key] = value === null ? "" : value;
        }
      }
      if (Object.keys(custom).length) patch.custom = custom;
      if (!Object.keys(patch).length) throw new Error("Tick at least one field to change.");
      return api("/api/people/bulk", { method: "POST", body: { ids, patch } });
    }
  });
  if (!result) return null;
  toast(`${result.updated} ${result.updated === 1 ? "person" : "people"} changed.`);
  peopleSelection.ids.clear();
  loadPeople();
  return null;
}

// --- visitors (Security) --------------------------------------------------------------------------

/** The visitors chosen on the Visitors page, across its pages: Security validates their clearances together. */
const visitorsSelection = {
  ids: new Map(), // id -> the visitor as listed
  has(id) { return this.ids.has(id); },
  set(ids, on) {
    for (const id of ids) {
      if (on) this.ids.set(id, (visitorsView.visitors || []).find((v) => v.id === id) || this.ids.get(id) || { id });
      else this.ids.delete(id);
    }
    drawVisitors();
  },
  clear() { this.ids.clear(); drawVisitors(); }
};

function renderVisitorActions() {
  const bar = $("visitors-actions");
  const n = visitorsSelection.ids.size;
  bar.hidden = !n;
  if (!n) return bar.replaceChildren();
  bar.replaceChildren(
    h("span", { class: "small-text", text: `${n} ${n === 1 ? "visitor" : "visitors"} chosen` }),
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "primary small", text: "Validate clearance…", onclick: async () => {
        if (await validateClearances("visitor", [...visitorsSelection.ids.values()])) { visitorsSelection.ids.clear(); loadVisitors(); }
      } }),
      h("button", { type: "button", class: "link-btn small-text", text: "Clear", onclick: () => visitorsSelection.clear() })));
  return null;
}

// --- badges (Security) ----------------------------------------------------------------------------

function renderBadgeActions() {
  const bar = $("badges-actions");
  const list = [...badgesView.picked.values()];
  bar.hidden = !list.length;
  if (!list.length) return bar.replaceChildren();
  bar.replaceChildren(
    h("span", { class: "small-text", text: `${list.length} ${list.length === 1 ? "badge" : "badges"} chosen` }),
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "primary small", text: "Change…", onclick: () => bulkEditBadges(list) }),
      h("button", { type: "button", class: "secondary small", text: "Retire", onclick: () => bulkBadges(list, { status: "retired" }, "retired") }),
      h("button", { type: "button", class: "secondary small danger-text", text: "Delete", onclick: () => deleteBadges(list) }),
      h("button", { type: "button", class: "link-btn small-text", text: "Clear", onclick: () => { badgesView.picked.clear(); loadBadges(); } })));
  return null;
}

async function bulkBadges(list, patch, done) {
  if (patch.status === "retired" && !(await confirmDialog(`Retire ${list.length} ${list.length === 1 ? "badge" : "badges"}? They stay on record with their history but can't be given out.`, { confirmLabel: "Retire" }))) return;
  try {
    const r = await api("/api/badges/bulk", { method: "POST", body: { ids: list.map((b) => b.id), patch } });
    toast(`${r.updated} ${r.updated === 1 ? "badge" : "badges"} ${done}.`);
    badgesView.picked.clear();
    loadBadges();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteBadges(list) {
  if (!(await confirmDialog(`Delete ${list.length} ${list.length === 1 ? "badge" : "badges"} (${list.map((b) => b.label).slice(0, 12).join(", ")}${list.length > 12 ? ", …" : ""})? A badge that has ever been given out can't be deleted: retire it instead, so its history stays.`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    const r = await api("/api/badges/bulk-delete", { method: "POST", body: { ids: list.map((b) => b.id) } });
    toast(`Deleted ${r.deleted} ${r.deleted === 1 ? "badge" : "badges"}.`);
    badgesView.picked.clear();
    loadBadges();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Changes the ticked things on every chosen badge: move them to another type (visitor,
 * tenant, personnel), classification or clearance level, the sites they're valid at,
 * temporary, status or notes.
 */
async function bulkEditBadges(list) {
  const info = await clearanceInfo(true);
  const options = (pairs) => pairs.map(([value, label]) => h("option", { value, text: label }));
  const rows = [];
  const row = (key, label, el, read, hint = null) => {
    const change = h("input", { type: "checkbox", "aria-label": `Change ${label}` });
    const disable = (on) => { for (const x of el.querySelectorAll ? [el, ...el.querySelectorAll("input, select, textarea")] : [el]) x.disabled = on; };
    disable(true);
    change.addEventListener("change", () => disable(!change.checked));
    rows.push({ key, change, read });
    return h("div", { class: "bulk-field" }, h("label", { class: "check-row" }, change, h("span", { text: label }), hint ? h("span", { class: "muted small-text", text: ` ${hint}` }) : null), el);
  };
  const type = h("select", { "aria-label": "Type" }, options(info.badgeTypes.map((t) => [t.value, t.label])));
  const classification = h("select", { "aria-label": "Classification" }, options(info.classifications.map((c) => [String(c.id), c.name])));
  const level = canSeeClearances() ? h("select", { "aria-label": "Clearance level" }, options([["", "None"], ...info.levels.map((l) => [String(l.id), l.name])])) : null;
  const sites = siteLimitPicker(null);
  sites.node.querySelector(".label").textContent = "";
  const temporary = h("select", { "aria-label": "Temporary" }, options([["no", "No"], ["yes", "Yes, lent for the day"]]));
  const status = h("select", { "aria-label": "Status" }, options(Object.entries(BADGE_STATUS_LABELS)));
  const notes = h("input", { type: "text", "aria-label": "Notes" });
  const facilityCode = h("input", { type: "text", "aria-label": "Facility code", inputmode: "numeric", maxlength: "3", placeholder: "2-3 digits, or empty for none" });
  const nodes = [
    row("facilityCode", "Facility code", facilityCode, () => facilityCode.value.trim(), "(empty takes it away)"),
    row("type", "Move to type", type, () => type.value, "(visitor, tenant or personnel)"),
    row("classificationId", "Classification", classification, () => Number(classification.value)),
    level ? row("clearanceLevelId", "Clearance level", level, () => (level.value ? Number(level.value) : null)) : null,
    multiSite() || state.config.access.sitesLimited ? row("siteIds", "Valid at", sites.node, () => sites.value() || []) : null,
    row("temporary", "Temporary", temporary, () => temporary.value === "yes"),
    row("status", "Status", status, () => status.value),
    row("notes", "Notes", notes, () => notes.value.trim()),
    // Custom badge fields this account can change.
    ...(state.schema.badge || []).filter((f) => !f.builtIn && !f.recordOnly && f.access === "edit").map((f) => {
      const control = bulkControl(f, []);
      return row(`custom:${f.key}`, f.label, control.el, () => control.read(), "(custom)");
    })
  ];
  const result = await formDialog({
    title: `Change ${list.length} ${list.length === 1 ? "badge" : "badges"}`,
    wide: true,
    intro: h("p", { class: "muted", text: `Tick each thing to change; it is set the same on every chosen badge (${list.map((b) => b.label).slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}). A badge that is out can't move to another type or change its classification, level or whether it is temporary: take it back first. If any badge can't take the change, none does.${level ? "" : " Clearance levels are changed by roles that see them."}` }),
    fields: [{ node: h("div", { class: "full-row bulk-fields" }, nodes) }],
    submitLabel: "Change",
    onSubmit: async () => {
      const patch = {};
      for (const r of rows) {
        if (!r.change.checked) continue;
        if (r.key.startsWith("custom:")) {
          const value = r.read();
          (patch.custom ||= {})[r.key.slice(7)] = value === null ? "" : value;
        } else {
          patch[r.key] = r.read();
        }
      }
      if (!Object.keys(patch).length) throw new Error("Tick at least one thing to change.");
      return api("/api/badges/bulk", { method: "POST", body: { ids: list.map((b) => b.id), patch } });
    }
  });
  if (!result) return;
  toast(`${result.updated} ${result.updated === 1 ? "badge" : "badges"} changed.`);
  badgesView.picked.clear();
  loadBadges();
}
