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
function peopleColumns(withCompany = false, onBadge = () => {}) {
  const visible = new Set(state.schema.person.map((f) => f.key));
  const cols = [{ label: "Name", cell: (p) => h("strong", { text: personName(p) }) }];
  if (withCompany) cols.push({ label: "Company", cell: (p) => p.companyName || "" });
  if (canReadBadges()) cols.push({ label: "Badge", cell: (p) => personBadgeCell(p, onBadge) });
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
function peopleTable(people, { withCompany = false, onOpen, onBadge = () => {}, selection = null, empty = "No people yet." } = {}) {
  const cols = peopleColumns(withCompany, onBadge);
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
    }) : emptyRow(cols.length + (selection ? 1 : 0), empty))));
}

// Whether a company's page lists its inactive people too: off unless chosen, kept in this browser.
const SHOW_INACTIVE_PEOPLE_KEY = "ivm-company-inactive-people";

function showInactivePeople() {
  try {
    return localStorage.getItem(SHOW_INACTIVE_PEOPLE_KEY) === "1";
  } catch {
    return false;
  }
}

function setShowInactivePeople(on) {
  try {
    if (on) localStorage.setItem(SHOW_INACTIVE_PEOPLE_KEY, "1");
    else localStorage.removeItem(SHOW_INACTIVE_PEOPLE_KEY);
  } catch {
    // Storage blocked: it still applies until the page is reloaded.
  }
}

// --- a company's points of contact (PoCs) --------------------------------------------------------

/** A PoC in a few words, to name it in a message: "Jane Doe (Billing)". */
function companyContactName(c) {
  const who = c.name || c.email || c.phone;
  return who ? `${who}${c.role ? ` (${c.role})` : ""}` : c.role || "this PoC";
}

/**
 * Adds a point of contact to a company, or changes one. Each box takes any text; one at least
 * is needed. Choosing one of the company's people (those still active) fills in their name,
 * email and phone, leaving only the role to give; what was filled in can still be changed,
 * and the PoC stays its own record (it doesn't follow the person afterwards).
 */
function companyContactDialog(company, contact = null, people = []) {
  const here = people.filter((p) => p.active);
  const fillFrom = (input, inputs) => {
    const p = here.find((x) => String(x.id) === input.value);
    if (!p) return;
    inputs.name.value = personName(p);
    inputs.email.value = p.email || "";
    inputs.phone.value = p.workPhone || p.mobile || "";
    inputs.role.focus();
  };
  return formDialog({
    title: contact ? `Edit PoC at ${company.name}` : `Add PoC to ${company.name}`,
    submitLabel: contact ? "Save" : "Add PoC",
    fields: [
      ...(here.length ? [{ name: "person", label: `Someone at ${company.name}`, type: "select", value: "", autofocus: !contact,
        options: [{ value: "", label: contact ? "Fill in from a person…" : "Choose a person, or fill in the boxes below" }, ...here.map((p) => ({ value: String(p.id), label: `${personName(p)}${p.jobTitle ? ` · ${p.jobTitle}` : ""}` }))],
        hint: "Fills in their name, email and phone. You can still change them.", onChange: fillFrom }] : []),
      { name: "role", label: "PoC Role", value: contact?.role || "", placeholder: "Office manager, Billing, After hours…", autofocus: Boolean(contact) || !here.length },
      { name: "name", label: "Name", value: contact?.name || "" },
      { name: "email", label: "Email", value: contact?.email || "", half: true },
      { name: "phone", label: "Phone", value: contact?.phone || "", half: true }
    ],
    onSubmit: async (v) => {
      const body = { role: v.role, name: v.name, email: v.email, phone: v.phone };
      if (!Object.values(body).some((x) => String(x || "").trim())) throw new Error("Fill in at least one of the boxes.");
      return api(`/api/companies/${company.id}/contacts${contact ? `/${contact.id}` : ""}`, { method: contact ? "PUT" : "POST", body });
    }
  });
}

async function addCompanyContact(company, people, refresh) {
  const saved = await companyContactDialog(company, null, people);
  if (!saved) return;
  toast(`Added ${companyContactName(saved.contact)} as a PoC.`);
  refresh();
}

async function editCompanyContact(company, contact, people, refresh) {
  const saved = await companyContactDialog(company, contact, people);
  if (!saved) return;
  toast("Saved.");
  refresh();
}

async function removeCompanyContact(company, contact, refresh) {
  if (!(await confirmDialog(`Remove ${companyContactName(contact)} from ${company.name}'s PoCs?`, { danger: true, confirmLabel: "Remove" }))) return;
  try {
    await api(`/api/companies/${company.id}/contacts/${contact.id}`, { method: "DELETE" });
    toast("PoC removed.");
    refresh();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * A company's points of contact, on its panel: role, name, email and phone, as they were typed
 * (an email that is one opens a message; a phone number dials). Nothing when it has none.
 */
function companyContactsSection(company, contacts, people, refresh) {
  if (!contacts.length) return null;
  const mail = (text) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? h("a", { href: `mailto:${text}`, text }) : text);
  const dial = (text) => (/^[\d\s().+-]{7,}$/.test(text) && !/[a-z]/i.test(text) ? h("a", { href: `tel:${text.replace(/[^\d+]/g, "")}`, text }) : text);
  const may = canEditDirectory();
  return h("div", { class: "company-pocs" },
    h("h4", { text: `Points of Contact (PoCs) (${contacts.length})` }),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["PoC Role", "Name", "Email", "Phone"].map((label) => h("th", { text: label })), may ? h("th", {}, h("span", { class: "visually-hidden", text: "Change" })) : null)),
      h("tbody", {}, contacts.map((c) => h("tr", {},
        h("td", {}, c.role ? h("strong", { text: c.role }) : ""),
        h("td", { text: c.name || "" }),
        h("td", {}, c.email ? mail(c.email) : ""),
        h("td", {}, c.phone ? dial(c.phone) : ""),
        may ? h("td", { class: "nowrap poc-actions" },
          h("button", { type: "button", class: "link-btn", text: "Edit", "aria-label": `Edit ${companyContactName(c)}`, onclick: () => editCompanyContact(company, c, people, refresh) }),
          h("button", { type: "button", class: "link-btn", text: "Remove", "aria-label": `Remove ${companyContactName(c)}`, onclick: () => removeCompanyContact(company, c, refresh) })) : null))))));
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
  const { company, fields, people, contacts = [] } = data;
  const head = h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      h("div", {}, h("h2", { text: company.name }), company.active ? null : h("span", { class: "badge muted", text: "Inactive" })),
      h("div", { class: "btn-row" },
        canManageFields("company") ? h("button", { type: "button", class: "link-btn", text: "Add a field to this company", onclick: () => addRecordField("company", company.id, company.name, () => showCompanyDetail(id)) }) : null,
        canEditDirectory() ? h("button", { type: "button", class: "secondary small", text: "Add PoC", onclick: () => addCompanyContact(company, people, () => showCompanyDetail(id)) }) : null,
        canEditDirectory() ? h("button", { type: "button", class: "secondary small", text: "Edit", onclick: () => editCompany(company, fields) }) : null,
        isAdmin() ? h("button", { type: "button", class: "secondary small", text: "Delete", onclick: () => deleteCompany(company) }) : null)),
    recordFacts(fields, company, ["name", "active"]),
    companyContactsSection(company, contacts, people, () => showCompanyDetail(id)));

  // Inactive people are left out unless "Show inactive" is ticked (as on the People page).
  const inactive = people.filter((p) => !p.active).length;
  const title = h("h3");
  const showBox = h("input", { type: "checkbox" });
  showBox.checked = showInactivePeople();
  let table = null;
  const renderPeople = () => {
    const shown = showBox.checked ? people : people.filter((p) => p.active);
    title.textContent = `People (${shown.length})`;
    const fresh = peopleTable(shown, {
      onOpen: (p) => openPerson(p.id, () => showCompanyDetail(id)),
      onBadge: () => showCompanyDetail(id),
      empty: inactive && !showBox.checked ? `No active people. Tick Show inactive to see the ${inactive === 1 ? "one inactive person" : `${inactive} inactive people`}.` : "No people yet."
    });
    if (table) table.replaceWith(fresh);
    table = fresh;
  };
  showBox.addEventListener("change", () => {
    setShowInactivePeople(showBox.checked);
    renderPeople();
  });
  renderPeople();
  const peoplePanel = h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      title,
      h("div", { class: "btn-row" },
        inactive ? h("label", { class: "check-row inline-check" }, showBox, h("span", { text: `Show inactive (${inactive})` })) : null,
        isAdmin() && people.length ? h("button", { type: "button", class: "secondary small", text: "Export CSV", onclick: () => download(`/api/people.csv?companyId=${company.id}`).catch((e) => toast(e.message, "error")) }) : null,
        canEditDirectory() ? h("button", { type: "button", class: "primary small", text: "Add person", onclick: async () => { if (await newPersonDialog({ companyId: company.id })) showCompanyDetail(id); } }) : null)),
    table);
  pane.append(head, peoplePanel, canReadFacilities() ? companyOfficesPanel(company) : "",
    canSeeLeases() ? companyLeasesPanel(company) : "",
    canReadBadges() || canSeeLeases() ? companyBadgeAllotmentPanel(company) : "",
    canSeeLeases() ? companyInsurancePanel(company) : "");
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
  if (canManageFields("person")) actions.push({ label: "Add a field to this person", value: "field", more: true });
  if (isAdmin()) actions.push({ label: "Delete", kind: "danger", value: "delete", more: true });
  actions.push({ label: "Close", kind: canEditDirectory() ? "secondary" : "primary", value: null });
  if (canEditDirectory()) actions.push({ label: "Edit", kind: "primary", value: "edit" });
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
