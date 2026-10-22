// 04-companies.js: the companies list, a company's details and people, and the person
// dialog (also used by the People page).

// picking: choosing several (21-bulk.js); picked: id -> the company as listed.
const companiesView = { selected: null, picking: false, picked: new Map() };

async function loadCompanies() {
  const q = $("companies-search").value.trim();
  const list = clear($("companies-list"));
  let data;
  try {
    data = await api(`/api/companies?${new URLSearchParams({ ...(q ? { q } : {}), ...($("companies-inactive").checked ? { all: "1" } : {}), ...siteQuery() })}`);
  } catch (error) {
    list.append(h("li", { class: "empty", text: error.message }));
    return;
  }
  if (!data.companies.length) list.append(h("li", { class: "empty", text: q ? "No companies match." : "No companies yet." }));
  for (const c of data.companies) {
    const where = (c.sites || []).filter((s) => !state.site || String(s.siteId) === String(state.site));
    const sub = [multiSite() && !state.site ? where.map((s) => s.siteName).join(", ") : where.map((s) => s.suite).filter(Boolean).join(", "), `${c.peopleCount} ${c.peopleCount === 1 ? "person" : "people"}`].filter(Boolean).join(" · ");
    if (companiesView.picking) {
      list.append(h("li", {}, companyPickRow(c, sub)));
      continue;
    }
    list.append(h("li", {}, h("a", {
      href: `#company/${c.id}`,
      class: `${String(companiesView.selected) === String(c.id) ? "is-active" : ""}${c.active ? "" : " inactive"}`
    }, h("span", { class: "nav-list-main" }, h("strong", { text: c.name }), h("span", { class: "muted", text: sub })))));
  }
  $("companies-count").textContent = data.total > data.companies.length ? `Showing ${data.companies.length} of ${data.total}. Search to narrow the list.` : "";
  renderCompanyActions();
}

$("companies-search").addEventListener("input", debounce(loadCompanies, 250));
$("companies-inactive").addEventListener("change", loadCompanies);

$("companies-add").addEventListener("click", async () => {
  const form = recordForm(state.schema.company, null);
  const company = await formDialog({
    title: "Add company",
    fields: form.fields,
    submitLabel: "Add company",
    wide: true,
    onSubmit: async (v) => (await api("/api/companies", { method: "POST", body: form.collect(v) })).company
  });
  if (company) {
    toast(`Added ${company.name}.`);
    location.hash = `#company/${company.id}`;
  }
});

/** The people table's columns: what the person sees of a few useful fields. */
function peopleColumns(withCompany = false) {
  const visible = new Set(state.schema.person.map((f) => f.key));
  const cols = [{ label: "Name", cell: (p) => h("strong", { text: personName(p) }) }];
  if (withCompany) cols.push({ label: "Company", cell: (p) => p.companyName || "" });
  if (visible.has("jobTitle")) cols.push({ label: "Job title", cell: (p) => p.jobTitle || "" });
  if (visible.has("email")) cols.push({ label: "Email", cell: (p) => p.email || "" });
  if (visible.has("workPhone") || visible.has("mobile")) cols.push({ label: "Phone", cell: (p) => p.workPhone || p.mobile || "" });
  if (visible.has("site") && multiSite()) cols.push({ label: "Site", cell: (p) => p.siteName || "Any" });
  if (visible.has("clearanceStatus")) cols.push({ label: "Clearance", cell: (p) => clearanceTag(p) || "" });
  return cols;
}

/**
 * The people table. With `selection` ({ has(id), set(ids, on) }), each row and the header
 * get a tick box for choosing several (21-bulk.js).
 */
function peopleTable(people, { withCompany = false, onOpen, selection = null } = {}) {
  const cols = peopleColumns(withCompany);
  const tick = (checked, label, onToggle) => {
    const box = h("input", { type: "checkbox", "aria-label": label });
    box.checked = checked;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => onToggle(box.checked));
    return h("td", { class: "pick-cell", onclick: (e) => e.stopPropagation() }, box);
  };
  const all = selection && people.length > 0 && people.every((p) => selection.has(p.id));
  const headTick = selection ? (() => { const cell = tick(all, "Choose everyone on this page", (on) => selection.set(people.map((p) => p.id), on)); return h("th", { class: "pick-cell" }, cell.firstChild); })() : null;
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, headTick, cols.map((c) => h("th", { text: c.label })))),
    h("tbody", {}, people.length ? people.map((p) => {
      const row = h("tr", { class: `clickable${p.active ? "" : " inactive"}${selection?.has(p.id) ? " is-picked" : ""}` },
        selection ? tick(selection.has(p.id), `Choose ${personName(p)}`, (on) => selection.set([p.id], on)) : null,
        cols.map((c, i) => h("td", {}, c.cell(p), i === 0 && !p.active ? h("span", { class: "badge muted", text: "Inactive" }) : null)));
      row.addEventListener("click", () => onOpen(p));
      return row;
    }) : emptyRow(cols.length + (selection ? 1 : 0), "No people yet."))));
}

async function showCompanyDetail(id) {
  companiesView.selected = id;
  const pane = clear($("company-detail"));
  if (!id) {
    pane.append(h("div", { class: "placeholder", text: "Choose a company to see its details and people." }));
    return;
  }
  let data;
  try {
    data = await api(`/api/companies/${id}`);
  } catch (error) {
    pane.append(h("p", { class: "message error", text: error.message }));
    return;
  }
  const { company, fields, people } = data;
  const head = h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      h("div", {}, h("h2", { text: company.name }), company.active ? null : h("span", { class: "badge muted", text: "Inactive" })),
      h("div", { class: "btn-row" },
        canManageFields("company") ? h("button", { type: "button", class: "link-btn", text: "Add a field to this company", onclick: () => addRecordField("company", company.id, company.name, () => showCompanyDetail(id)) }) : null,
        canEditDirectory() ? h("button", { type: "button", class: "secondary small", text: "Edit", onclick: () => editCompany(company, fields) }) : null,
        isAdmin() ? h("button", { type: "button", class: "secondary small", text: "Delete", onclick: () => deleteCompany(company) }) : null)),
    recordFacts(fields, company, ["name", "active"]));

  const peoplePanel = h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      h("h3", { text: `People (${people.length})` }),
      h("div", { class: "btn-row" },
        isAdmin() && people.length ? h("button", { type: "button", class: "secondary small", text: "Export CSV", onclick: () => download(`/api/people.csv?companyId=${company.id}`).catch((e) => toast(e.message, "error")) }) : null,
        canEditDirectory() ? h("button", { type: "button", class: "primary small", text: "Add person", onclick: async () => { if (await newPersonDialog({ companyId: company.id })) showCompanyDetail(id); } }) : null)),
    peopleTable(people, { onOpen: (p) => openPerson(p.id, () => showCompanyDetail(id)) }));
  pane.append(head, peoplePanel, canReadFacilities() ? companyOfficesPanel(company) : null);
  loadCompanies();
}

async function editCompany(company, fields) {
  const form = recordForm(fields, company);
  const saved = await formDialog({
    title: `Edit ${company.name}`,
    fields: form.fields,
    wide: true,
    onSubmit: async (v) => {
      const body = form.collect(v);
      if (!Object.keys(body).length) return company;
      return (await api(`/api/companies/${company.id}`, { method: "PUT", body })).company;
    }
  });
  if (saved) {
    toast("Saved.");
    showCompanyDetail(company.id);
  }
}

async function deleteCompany(company) {
  const n = company.peopleCount || 0;
  if (!(await confirmDialog(`Delete ${company.name}${n ? ` and its ${n} ${n === 1 ? "person" : "people"}` : ""}? This can't be undone. To keep the record, edit it and untick Active instead.`, { danger: true, confirmLabel: "Delete" }))) return;
  try {
    await api(`/api/companies/${company.id}`, { method: "DELETE" });
    toast(`Deleted ${company.name}.`);
    companiesView.selected = null;
    location.hash = "#companies";
  } catch (error) {
    toast(error.message, "error");
  }
}

// --- a person -------------------------------------------------------------------------

/** Every company the person can see, for the company picker (with their sites). */
async function companyChoices() {
  return (await api("/api/companies?all=1&limit=2000")).companies;
}

async function newPersonDialog({ companyId = null } = {}) {
  const companies = await companyChoices();
  if (!companies.length) {
    toast("Add a company first: everyone belongs to one.", "error");
    return null;
  }
  const form = recordForm(state.schema.person, null, { companies, fixedCompanyId: companyId });
  const person = await formDialog({
    title: "Add person",
    fields: form.fields,
    submitLabel: "Add person",
    wide: true,
    onSubmit: async (v) => (await api("/api/people", { method: "POST", body: form.collect(v) })).person
  });
  if (person) toast(`Added ${personName(person)}.`);
  return person;
}

/** The person dialog. `onChange` runs after an edit or delete so the page behind can refresh. */
async function openPerson(id, onChange = () => {}) {
  let data;
  try {
    data = await api(`/api/people/${id}`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  const { person, fields } = data;
  let dlgRef = null;
  const body = h("div", { class: "detail" },
    person.active ? null : h("p", {}, h("span", { class: "badge muted", text: "Inactive" })),
    recordFacts(fields, person, ["firstName", "lastName", "preferredName", "active", ...CLEARANCE_KEYS]),
    clearanceSection("person", person, () => dlgRef?.finish("refresh")),
    badgeSection("person", person.id));
  const actions = [];
  if (isAdmin()) actions.push({ label: "Delete", kind: "danger", value: "delete" });
  if (canManageFields("person")) actions.push({ label: "Add a field to this person", value: "field" });
  if (canEditDirectory()) actions.push({ label: "Edit", value: "edit" });
  actions.push({ label: "Close", kind: "primary", value: null });
  const result = await openDialog({ title: personName(person), body, wide: true, actions, onOpen: (d) => { dlgRef = d; } });
  if (result === "refresh") {
    onChange();
    return openPerson(id, onChange);
  }
  if (result === "edit") {
    if (await editPerson(person, fields)) onChange();
    return openPerson(id, onChange);
  }
  if (result === "field") {
    await addRecordField("person", person.id, personName(person), async () => {});
    return openPerson(id, onChange);
  }
  if (result === "delete") {
    if (!(await confirmDialog(`Delete ${personName(person)}? This can't be undone. To keep the record, edit it and untick Active instead.`, { danger: true, confirmLabel: "Delete" }))) return openPerson(id, onChange);
    try {
      await api(`/api/people/${person.id}`, { method: "DELETE" });
      toast(`Deleted ${personName(person)}.`);
      onChange();
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (location.hash.startsWith("#person/")) history.back();
}

async function editPerson(person, fields) {
  const companies = await companyChoices();
  const form = recordForm(fields, person, { companies });
  const saved = await formDialog({
    title: `Edit ${personName(person)}`,
    fields: form.fields,
    wide: true,
    onSubmit: async (v) => {
      const body = form.collect(v);
      if (!Object.keys(body).length) return person;
      return (await api(`/api/people/${person.id}`, { method: "PUT", body })).person;
    }
  });
  if (saved) toast("Saved.");
  return saved;
}

function showCompanies(sub) {
  loadCompanies();
  if (sub !== undefined) showCompanyDetail(sub);
  else if (companiesView.selected) showCompanyDetail(companiesView.selected);
}
