// 24-leases.js: Facilities > Leases (each company's agreements for offices: dates, rent,
// deposit) and Facilities > Charges (billable items and hours logged against tenants, and the
// price list they come from). Managers change leases; Managers and Finance log charges; both
// pages are seen by anyone who sees facilities or the books.

const LEASE_STATUS = {
  upcoming: { label: "Not started", cls: "muted" },
  active: { label: "Active", cls: "ok" },
  ending: { label: "Ending soon", cls: "warn" },
  ended: { label: "Ended", cls: "" }
};

let financeCompanyList = null;

/** The companies leases and charges can be for (those the account sees). */
async function financeCompanies() {
  if (financeCompanyList) return financeCompanyList;
  try {
    financeCompanyList = (await api("/api/facilities/companies")).companies;
  } catch {
    financeCompanyList = (await api("/api/companies?limit=5000")).companies.map((c) => ({ id: c.id, name: c.name }));
  }
  setTimeout(() => { financeCompanyList = null; }, 60000);
  return financeCompanyList;
}

const rentText = (l) => (l.currentMonthly === null ? (l.rentMode === "fixed" ? "No rent set" : "Office size or rate missing") : `${fmtMoney(l.currentMonthly)}/month`);

// --- leases --------------------------------------------------------------------------------------------

$("leases-search").addEventListener("input", debounce(() => loadLeases(), 250));
$("leases-status").addEventListener("change", () => loadLeases());
$("leases-add").addEventListener("click", async () => {
  const lease = await editLease(null);
  if (lease) {
    loadLeases();
    openLease(lease.id);
  }
});

function showLeases() {
  $("leases-add").hidden = !canEditFacilities();
  loadLeases();
}

async function loadLeases() {
  const table = $("leases-table");
  const head = ["Company", "Reference", "Offices", "Starts", "Ends", "Rent", "Deposit", "Status"];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  let leases;
  try {
    ({ leases } = await api(`/api/leases?${new URLSearchParams({ status: $("leases-status").value, q: $("leases-search").value.trim() })}`));
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  if (state.site) leases = leases.filter((l) => !l.sites.length || l.sites.some((s) => String(s.id) === String(state.site)));
  if (!leases.length) {
    clear(table.tBodies[0]).append(emptyRow(head.length, canEditFacilities() ? "No leases here. Add one with New lease, or assign offices to a company." : "No leases here."));
    return;
  }
  clear(table.tBodies[0]).append(...leases.map((l) => {
    const row = h("tr", { class: "clickable" },
      h("td", {}, h("strong", { text: l.companyName })),
      h("td", { class: "small-text", text: l.reference || "" }),
      h("td", { class: "small-text", text: l.offices.length ? `${l.offices.map((o) => o.name).join(", ")}${multiSite() && l.sites.length ? ` · ${l.sites.map((s) => s.name).join(", ")}` : ""}` : "None" }),
      h("td", { class: "nowrap small-text", text: dateText(l.startDate) }),
      h("td", { class: "nowrap small-text", text: l.endDate ? dateText(l.endDate) : "Runs on" }),
      h("td", { class: "nowrap", text: rentText(l) }),
      h("td", { class: "nowrap small-text", text: l.deposit ? fmtMoney(l.deposit) : "" }),
      h("td", {}, h("span", { class: `badge ${LEASE_STATUS[l.status].cls}`, text: LEASE_STATUS[l.status].label })));
    row.addEventListener("click", () => { location.hash = `#lease/${l.id}`; });
    return row;
  }));
}

async function openLease(id) {
  let lease;
  try {
    ({ lease } = await api(`/api/leases/${id}`));
  } catch (error) {
    toast(error.message, "error");
    if (location.hash.startsWith("#lease/")) history.back();
    return;
  }
  const fact = (label, value) => (value === null || value === undefined || value === "" ? null : [h("dt", { text: label }), h("dd", {}, value)]);
  const body = h("div", { class: "detail" },
    h("p", {}, h("span", { class: `badge ${LEASE_STATUS[lease.status].cls}`, text: LEASE_STATUS[lease.status].label })),
    h("dl", { class: "facts inline-facts" },
      fact("Company", lease.companyId ? h("a", { href: `#company/${lease.companyId}`, text: lease.companyName }) : lease.companyName),
      fact("Reference", lease.reference),
      fact("Term", `${dateText(lease.startDate)} to ${lease.endDate ? dateText(lease.endDate) : "no end date (month to month)"}`),
      fact("Rent", `${lease.rentMode === "fixed" ? `${fmtMoney(lease.monthlyRent)} a month, fixed` : "From the rates: each office's size times its rate (or its fixed monthly rent)"}${lease.escalationPct ? `, up ${lease.escalationPct}% each year` : ""}`),
      fact(lease.status === "upcoming" ? "Rent when it starts" : "Rent now", rentText(lease)),
      fact("Deposit", lease.deposit ? fmtMoney(lease.deposit) : null),
      fact("Space", lease.sqft ? fmtSqft(lease.sqft) : null),
      fact("Invoiced", lease.invoiced.length ? lease.invoiced.map((p) => monthText(p)).join(", ") : "Not yet"),
      fact("Notes", lease.notes ? h("span", { class: "pre", text: lease.notes }) : null)),
    h("h4", { text: "Offices" }),
    lease.offices.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Office", "Floor", ...(multiSite() ? ["Site"] : []), "Size", "Rate", "A month"].map((t) => h("th", { text: t })))),
        h("tbody", {}, lease.offices.map((o) => h("tr", {},
          h("td", {}, h("strong", { text: o.name })),
          h("td", { class: "small-text", text: o.floorName }),
          multiSite() ? h("td", { class: "small-text", text: o.siteName }) : null,
          h("td", { class: "small-text", text: fmtSqft(o.sqft) }),
          h("td", { class: "small-text", text: fmtRate(o.rate) }),
          h("td", { class: "small-text", text: fmtMoney(o.monthly) }))))))
      : h("p", { class: "muted", text: "No offices: a fixed rent only." }),
    h("p", { class: "muted small-text", text: `Added ${fmtDateTime(lease.createdAt)}${lease.createdBy ? ` by ${lease.createdBy}` : ""}${lease.updatedAt !== lease.createdAt ? `; changed ${fmtDateTime(lease.updatedAt)}${lease.updatedBy ? ` by ${lease.updatedBy}` : ""}` : ""}.` }));
  const actions = [];
  if (canEditFacilities()) {
    if (!lease.invoiced.length) actions.push({ label: "Delete", kind: "danger", value: "delete" });
    actions.push({ label: "Edit", value: "edit" });
  }
  actions.push({ label: "Close", kind: "primary", value: null });
  const result = await openDialog({ title: `${lease.companyName}${lease.reference ? `: lease ${lease.reference}` : "'s lease"}`, body, wide: true, actions });
  try {
    if (result === "edit") {
      if (await editLease(lease)) loadLeases();
      return openLease(id);
    }
    if (result === "delete") {
      if (!(await confirmDialog(`Delete this lease? Its offices are no longer assigned to ${lease.companyName}. Only for a lease entered by mistake: to end one, give it an end date.`, { danger: true, confirmLabel: "Delete" }))) return openLease(id);
      await api(`/api/leases/${lease.id}`, { method: "DELETE" });
      toast("Lease deleted.");
      loadLeases();
    }
  } catch (error) {
    toast(error.message, "error");
    return openLease(id);
  }
  if (location.hash.startsWith("#lease/")) history.back();
  return null;
}

const monthText = (period) => new Date(`${period}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/**
 * Ticks for the offices a lease covers: those free for its dates, and its own. Reloads when
 * the dates change. { node, value() (office ids), reload(start, end) }.
 */
function leaseOfficePicker(lease) {
  const own = new Set((lease?.offices || []).map((o) => o.officeId));
  const chosen = new Set(own);
  const list = h("div", { class: "lease-offices" });
  const note = h("p", { class: "muted small-text" });
  const node = h("div", { class: "full-row stack" }, h("span", { class: "label", text: "Offices" }), note, list);
  async function reload(start, end) {
    if (!start) {
      note.textContent = "Give the start date to see the offices free for these dates.";
      list.replaceChildren();
      return;
    }
    note.textContent = "Loading…";
    let offices = [];
    try {
      offices = (await api(`/api/offices?${new URLSearchParams({ freeFrom: start, ...(end ? { freeTo: end } : {}) })}`)).offices;
    } catch (error) {
      note.textContent = error.message;
      return;
    }
    // Its own offices are busy only with this lease.
    for (const o of lease?.offices || []) if (!offices.some((x) => x.id === o.officeId)) offices.push({ id: o.officeId, name: o.name, floorName: o.floorName, siteName: o.siteName, sqft: o.sqft, askingRate: o.rate, monthlyRent: o.rateSource === "monthly" ? o.monthly : null });
    offices.sort((a, b) => `${a.siteName} ${a.floorName} ${a.name}`.localeCompare(`${b.siteName} ${b.floorName} ${b.name}`, undefined, { numeric: true }));
    note.textContent = offices.length ? `Free from ${dateText(start)}${end ? ` to ${dateText(end)}` : " on"}:` : "No office is free for those dates.";
    list.replaceChildren(...offices.map((o) => {
      const box = h("input", { type: "checkbox" });
      box.checked = chosen.has(o.id);
      box.addEventListener("change", () => { if (box.checked) chosen.add(o.id); else chosen.delete(o.id); });
      return h("label", { class: "check-row" }, box, h("span", {}, h("strong", { text: o.name }),
        h("span", { class: "muted small-text", text: ` ${[o.floorName, multiSite() ? o.siteName : null, o.sqft ? fmtSqft(o.sqft) : null, o.monthlyRent !== null && o.monthlyRent !== undefined ? `${fmtMoney(o.monthlyRent)} a month, fixed` : o.askingRate !== null && o.askingRate !== undefined ? fmtRate(o.askingRate) : null].filter(Boolean).join(" · ")}` })));
    }));
  }
  return { node, value: () => [...chosen], reload };
}

/** The lease form: company, reference, dates, offices, rent, deposit, notes. Resolves to the saved lease. */
async function editLease(lease) {
  const companies = await financeCompanies();
  const picker = leaseOfficePicker(lease);
  let start = lease?.startDate || "";
  let end = lease?.endDate || "";
  const reloadOffices = debounce(() => picker.reload(start, end), 300);
  const fixedOnly = (inputs, mode) => {
    inputs.monthlyRent.closest("label").hidden = mode !== "fixed";
  };
  const saved = await formDialog({
    title: lease ? `Edit ${lease.companyName}'s lease` : "New lease",
    wide: true,
    fields: [
      { name: "companyId", label: "Company", type: "select", required: true, value: String(lease?.companyId || ""), half: true, options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] },
      { name: "reference", label: "Reference (optional)", value: lease?.reference || "", half: true, placeholder: "Your lease number" },
      { name: "startDate", label: "Starts", type: "date", required: true, value: start, half: true, onChange: (input) => { start = input.value; reloadOffices(); } },
      { name: "endDate", label: "Ends (its last day)", type: "date", value: end, half: true, hint: "Leave empty for month to month.", onChange: (input) => { end = input.value; reloadOffices(); } },
      { node: picker.node },
      { name: "rentMode", label: "Rent", type: "select", value: lease?.rentMode || "rates", half: true, options: [{ value: "rates", label: "From the rates (size × rate)" }, { value: "fixed", label: "A fixed amount a month" }], onChange: (input, inputs) => fixedOnly(inputs, input.value) },
      { name: "monthlyRent", label: "Monthly rent ($)", type: "number", value: lease?.monthlyRent ?? "", half: true, step: "0.01", min: 0 },
      { name: "escalationPct", label: "Yearly increase (%)", type: "number", value: lease?.escalationPct ?? "", half: true, step: "0.01", min: 0, hint: "On each anniversary of the start, whichever way the rent is worked out." },
      { name: "deposit", label: "Deposit ($, optional)", type: "number", value: lease?.deposit ?? "", half: true, step: "0.01", min: 0 },
      { name: "notes", label: "Notes", type: "textarea", rows: 2, value: lease?.notes || "" }
    ],
    // The form calls each onChange as it opens: the rent fields show or hide, and the offices load.
    submitLabel: lease ? "Save" : "Add lease",
    onSubmit: async (v) => {
      const body = {
        companyId: Number(v.companyId), reference: v.reference, startDate: v.startDate, endDate: v.endDate || null, officeIds: picker.value(),
        rentMode: v.rentMode, monthlyRent: v.rentMode === "fixed" ? v.monthlyRent : null, escalationPct: v.escalationPct, deposit: v.deposit, notes: v.notes
      };
      return (lease ? await api(`/api/leases/${lease.id}`, { method: "PUT", body }) : await api("/api/leases", { method: "POST", body })).lease;
    }
  });
  if (saved) toast(lease ? "Lease saved." : "Lease added; its offices are assigned.");
  return saved;
}

// --- charges --------------------------------------------------------------------------------------------

$("charges-search").addEventListener("input", debounce(() => loadCharges(), 250));
$("charges-status").addEventListener("change", () => loadCharges());
$("charges-company").addEventListener("change", () => loadCharges());
$("charges-add").addEventListener("click", async () => { if (await editCharge(null)) loadCharges(); });
$("charges-items").addEventListener("click", () => priceList());

async function showCharges() {
  $("charges-add").hidden = !canEditCharges();
  const select = $("charges-company");
  const before = select.value;
  try {
    const companies = await financeCompanies();
    select.replaceChildren(h("option", { value: "", text: "All companies" }), ...companies.map((c) => h("option", { value: String(c.id), text: c.name })));
    select.value = companies.some((c) => String(c.id) === before) ? before : "";
  } catch {
    // The list still loads without the filter.
  }
  loadCharges();
}

async function loadCharges() {
  const table = $("charges-table");
  const head = ["Date", "Company", "What", "Quantity", "Rate", "Amount", "Invoice"];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  let data;
  try {
    data = await api(`/api/charges?${new URLSearchParams({ status: $("charges-status").value, q: $("charges-search").value.trim(), ...($("charges-company").value ? { companyId: $("charges-company").value } : {}) })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  $("charges-total").textContent = data.total ? `${data.total} charge${data.total === 1 ? "" : "s"}, ${fmtMoney(data.amount)}${data.total > data.charges.length ? ` (the latest ${data.charges.length} shown)` : ""}.` : "";
  if (!data.charges.length) {
    clear(table.tBodies[0]).append(emptyRow(head.length, "No charges here."));
    return;
  }
  clear(table.tBodies[0]).append(...data.charges.map((c) => {
    const row = h("tr", { class: c.billed ? "" : "clickable" },
      h("td", { class: "nowrap small-text", text: dateText(c.date) }),
      h("td", {}, h("strong", { text: c.companyName })),
      h("td", {}, c.description, c.notes ? h("div", { class: "muted small-text", text: c.notes }) : null),
      h("td", { class: "nowrap small-text", text: `${c.quantity}${c.unit ? ` ${c.unit}${c.quantity === 1 || c.unit.endsWith("s") ? "" : "s"}` : ""}` }),
      h("td", { class: "nowrap small-text", text: fmtMoney(c.rate) }),
      h("td", { class: "nowrap", text: fmtMoney(c.amount) }),
      h("td", { class: "small-text" }, c.invoiceId
        ? (canReadFinance() ? h("a", { href: `#invoice/${c.invoiceId}`, text: c.invoiceNumber || "Draft", onclick: (e) => e.stopPropagation() }) : c.invoiceNumber || "Draft")
        : h("span", { class: "badge warn", text: "Not invoiced" })));
    if (!c.billed && canEditCharges()) row.addEventListener("click", async () => { if (await editCharge(c)) loadCharges(); });
    return row;
  }));
}

/** The charge form: company, date, what (from the price list or one-off), quantity, rate, notes. */
async function editCharge(charge) {
  const [companies, { items }] = await Promise.all([financeCompanies(), api("/api/charge-items")]);
  const itemOf = (id) => items.find((i) => String(i.id) === String(id));
  let opened = false;
  const result = await formDialog({
    title: charge ? "Edit charge" : "Log a charge",
    fields: [
      { name: "companyId", label: "Company", type: "select", required: true, value: String(charge?.companyId || $("charges-company").value || ""), options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] },
      { name: "date", label: "Date", type: "date", required: true, value: charge?.date || localToday(), half: true },
      { name: "itemId", label: "What", type: "select", value: charge ? String(charge.itemId || "") : "", half: true,
        options: [{ value: "", label: "Something else (one-off)" }, ...items.map((i) => ({ value: String(i.id), label: `${i.name} (${fmtMoney(i.rate)} per ${i.unit})` }))],
        onChange: (input, inputs) => {
          // Called once as the form opens: an edited charge keeps its own description and rate.
          if (!opened) { opened = true; return; }
          const item = itemOf(input.value);
          if (item) {
            inputs.description.value = item.name;
            inputs.rate.value = item.rate;
            inputs.unit.value = item.unit;
          }
        } },
      { name: "description", label: "Description", required: true, value: charge?.description || "" },
      { name: "quantity", label: "Quantity or hours", type: "number", required: true, value: charge?.quantity ?? 1, half: true, step: "any", min: 0.01 },
      { name: "unit", label: "Unit", value: charge?.unit || "", half: true, placeholder: "hour, each…" },
      { name: "rate", label: "Rate ($)", type: "number", required: true, value: charge?.rate ?? "", half: true, step: "0.01", min: 0 },
      { name: "notes", label: "Notes (optional)", type: "textarea", rows: 2, value: charge?.notes || "", hint: "Shown on the invoice with the charge." }
    ],
    extraActions: charge ? [{ label: "Delete", kind: "danger", onClick: async () => {
      await api(`/api/charges/${charge.id}`, { method: "DELETE" });
      return "deleted";
    } }] : [],
    submitLabel: charge ? "Save" : "Log charge",
    onSubmit: async (v) => {
      const body = { companyId: Number(v.companyId), date: v.date, itemId: v.itemId ? Number(v.itemId) : null, description: v.description, quantity: v.quantity, unit: v.unit, rate: v.rate, notes: v.notes };
      return (charge ? await api(`/api/charges/${charge.id}`, { method: "PUT", body }) : await api("/api/charges", { method: "POST", body })).charge;
    }
  });
  if (result === "deleted") toast("Charge deleted.");
  else if (result) toast(charge ? "Charge saved." : `Logged ${fmtMoney(result.amount)} for ${result.companyName}.`);
  return result;
}

/** The price list: what is charged and at what rate; kept by Managers and Finance. */
async function priceList() {
  const may = canEditCharges();
  const box = h("div", { class: "stack" });
  let dlg = null;
  async function render() {
    let items;
    try {
      ({ items } = await api("/api/charge-items?all=1"));
    } catch (error) {
      box.replaceChildren(h("p", { class: "message error", text: error.message }));
      return;
    }
    box.replaceChildren(
      h("p", { class: "muted", text: "Standard charges to tenants, picked when logging a charge so the rate is filled in. One-off charges need no item here." }),
      items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Item", "Rate", "", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, items.map((i) => h("tr", { class: i.active ? "" : "inactive" },
          h("td", {}, h("strong", { text: i.name }), i.active ? null : h("span", { class: "badge muted", text: "Off" })),
          h("td", { text: `${fmtMoney(i.rate)} per ${i.unit}` }),
          h("td", { class: "muted small-text", text: i.used ? `Charged ${i.used} time${i.used === 1 ? "" : "s"}` : "" }),
          h("td", {}, may ? h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: async () => { if (await editItem(i)) render(); } }),
            h("button", { type: "button", class: "link-btn", text: i.active ? "Turn off" : "Turn on", onclick: async () => {
              await api(`/api/charge-items/${i.id}`, { method: "PUT", body: { active: !i.active } });
              render();
            } }),
            i.used ? null : h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
              try {
                await api(`/api/charge-items/${i.id}`, { method: "DELETE" });
                render();
              } catch (error) {
                dlg?.showError(error.message);
              }
            } })) : null)))))) : h("p", { class: "muted", text: "Nothing on the price list yet." }),
      may ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary small", text: "Add an item", onclick: async () => { if (await editItem(null)) render(); } })) : "");
  }
  render();
  await openDialog({ title: "Price list", body: box, wide: true, onOpen: (d) => { dlg = d; } });
}

async function editItem(item) {
  return formDialog({
    title: item ? `Edit ${item.name}` : "Add to the price list",
    fields: [
      { name: "name", label: "Name", required: true, value: item?.name || "", placeholder: "After-hours HVAC" },
      { name: "rate", label: "Rate ($)", type: "number", required: true, value: item?.rate ?? "", half: true, step: "0.01", min: 0 },
      { name: "unit", label: "Per", value: item?.unit || "hour", half: true, placeholder: "hour, each, month…" }
    ],
    submitLabel: item ? "Save" : "Add",
    onSubmit: async (v) => (item ? await api(`/api/charge-items/${item.id}`, { method: "PUT", body: v }) : await api("/api/charge-items", { method: "POST", body: v })).item
  });
}
