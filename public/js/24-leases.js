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

const LEASE_DOCUMENT_KINDS = { agreement: "Lease agreement", amendment: "Mod/Amendments", supporting: "Supporting document" };

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

/** A lease's dialog. onChange: called after the lease or its documents change, for the page behind it. */
async function openLease(id, onChange = () => {}) {
  let lease;
  try {
    ({ lease } = await api(`/api/leases/${id}`));
  } catch (error) {
    toast(error.message, "error");
    if (location.hash.startsWith("#lease/")) history.back();
    return;
  }
  const fact = (label, value) => (value === null || value === undefined || value === "" ? null : [h("dt", { text: label }), h("dd", {}, value)]);
  const fixed = lease.rentMode === "fixed";
  const raised = lease.increases > 0;
  const customRooms = lease.offices.filter((o) => o.rateSource === "leaseRoom").length;
  const nextYear = lease.schedule.find((y) => y.when === "next");
  const rentBasis = fixed ? `${fmtMoney(lease.monthlyRent)} a month${lease.escalationPct ? " in the first year" : ", fixed"}`
    : lease.classRates.length || customRooms ? [lease.classRates.length ? `Rates at the start: ${lease.classRates.map((c) => `${c.name} ${fmtRate(c.rate)}`).join(", ")} a month` : null, customRooms ? `${customRooms} ${customRooms === 1 ? "room" : "rooms"} at a custom rate` : null].filter(Boolean).join("; ")
    : "From the rates: each office's size times its rate (or its fixed monthly rent)";
  const asOfWord = lease.status === "upcoming" ? "when it starts" : lease.status === "ended" ? null : "now";
  const body = h("div", { class: "detail" },
    h("p", {}, h("span", { class: `badge ${LEASE_STATUS[lease.status].cls}`, text: LEASE_STATUS[lease.status].label })),
    h("dl", { class: "facts inline-facts" },
      fact("Company", lease.companyId ? h("a", { href: `#company/${lease.companyId}`, text: lease.companyName }) : lease.companyName),
      fact("Reference", lease.reference),
      fact("Term", `${dateText(lease.startDate)} to ${lease.endDate ? dateText(lease.endDate) : "no end date (month to month)"}`),
      fact("Commences", lease.commencementSet ? dateText(lease.commencementDate) : null),
      fact("Rent", `${rentBasis}${lease.escalationPct ? `, up ${lease.escalationPct}% each year from ${lease.commencementSet ? "its commencement" : "its start"} (${dateText(lease.commencementDate)})` : ""}`),
      fact(asOfWord ? `Rent ${asOfWord}` : "Last rent", h("span", {}, h("strong", { text: rentText(lease) }), lease.currentYearly === null ? "" : ` (${fmtMoney(lease.currentYearly)} a year)`, raised ? ` after ${lease.increases} yearly ${lease.increases === 1 ? "increase" : "increases"}` : "")),
      fact(asOfWord ? `Rate ${asOfWord}` : "Last rate", lease.currentRate === null ? null : `${fmtRate(lease.currentRate)} a month`),
      fact("Next increase", nextYear ? `${dateText(nextYear.from)}: ${nextYear.rate !== null ? `${fmtRate(nextYear.rate)}, ` : ""}${nextYear.monthly === null ? "" : `${fmtMoney(nextYear.monthly)}/month`}` : null),
      fact("Deposit", lease.deposit ? fmtMoney(lease.deposit) : null),
      fact("Space", lease.sqft ? fmtSqft(lease.sqft) : null),
      fact("Invoiced", lease.invoiced.length ? lease.invoiced.map((p) => monthText(p)).join(", ") : "Not yet"),
      fact("Notes", lease.notes ? h("span", { class: "pre", text: lease.notes }) : null)),
    h("h4", { text: "Offices" }),
    lease.offices.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Office", "Floor", ...(multiSite() ? ["Site"] : []), "Size", ...(fixed ? [] : raised ? ["Base rate", "Base a month", "Rate now", "A month now", "A year now"] : ["Rate", "A month", "A year"])].map((t) => h("th", { text: t })))),
        h("tbody", {}, lease.offices.map((o) => h("tr", {},
          h("td", {}, h("strong", { text: o.name }), fixed ? null : h("div", { class: "muted small-text", text: `${o.className}${o.rateSource === "leaseRoom" ? " · custom rate" : ""}` })),
          h("td", { class: "small-text", text: o.floorName }),
          multiSite() ? h("td", { class: "small-text", text: o.siteName }) : null,
          h("td", { class: "small-text", text: fmtSqft(o.sqft) }),
          fixed ? null : h("td", { class: "small-text", text: fmtRate(o.rate) }),
          !fixed && raised ? h("td", { class: "small-text", text: fmtMoney(o.monthly) }) : null,
          !fixed && raised ? h("td", { class: "small-text", text: fmtRate(o.currentRate) }) : null,
          fixed ? null : h("td", { class: "small-text", text: fmtMoney(o.currentMonthly) }),
          fixed ? null : h("td", { class: "small-text", text: fmtMoney(o.currentYearly) }))))))
      : h("p", { class: "muted", text: "No offices: a fixed rent only." }),
    lease.schedule.length ? [h("h4", { text: "Rent by year" }), leaseScheduleTable(lease)] : null,
    h("div", { class: "panel-head" }, h("h4", { text: "Documents" }),
      canEditFacilities() ? h("button", { type: "button", class: "secondary small", text: "Add documents", onclick: () => leaseDialog?.finish("add-documents") }) : null),
    lease.documents.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Document", "What it is", "Size", "Added", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, lease.documents.map((d) => h("tr", {},
          h("td", {}, h("a", { href: `/api/lease-documents/${encodeURIComponent(d.ref)}`, target: "_blank", rel: "noopener", text: d.name }), d.description ? h("div", { class: "muted small-text", text: d.description }) : null),
          h("td", { class: "small-text", text: LEASE_DOCUMENT_KINDS[d.kind] }),
          h("td", { class: "nowrap small-text", text: fileSizeText(d.size) }),
          h("td", { class: "small-text", text: `${fmtDateTime(d.createdAt)}${d.createdBy ? ` by ${d.createdBy}` : ""}` }),
          h("td", {}, canEditFacilities() ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => leaseDialog?.finish({ removeDocument: d }) }) : null))))))
      : h("p", { class: "muted small-text", text: canEditFacilities() ? "No documents yet. Add the lease agreement, its mods and amendments, and anything that supports them." : "No documents yet." }),
    h("p", { class: "muted small-text", text: `Added ${fmtDateTime(lease.createdAt)}${lease.createdBy ? ` by ${lease.createdBy}` : ""}${lease.updatedAt !== lease.createdAt ? `; changed ${fmtDateTime(lease.updatedAt)}${lease.updatedBy ? ` by ${lease.updatedBy}` : ""}` : ""}.` }));
  let leaseDialog = null;
  const actions = [];
  if (canEditFacilities() && !lease.invoiced.length) actions.push({ label: "Delete", kind: "danger", value: "delete", more: true });
  actions.push({ label: "Close", kind: canEditFacilities() ? "secondary" : "primary", value: null });
  if (canEditFacilities()) actions.push({ label: "Edit", kind: "primary", value: "edit" });
  const result = await openDialog({ title: `${lease.companyName}${lease.reference ? `: lease ${lease.reference}` : "'s lease"}`, body, wide: true, actions, onOpen: (d) => { leaseDialog = d; } });
  try {
    if (result === "add-documents") {
      if (await addLeaseDocuments(lease)) onChange();
      return openLease(id, onChange);
    }
    if (result?.removeDocument) {
      const d = result.removeDocument;
      if (await confirmDialog(`Remove ${d.name} from this lease? Its file is deleted.`, { danger: true, confirmLabel: "Remove" })) {
        await api(`/api/lease-documents/${d.id}`, { method: "DELETE" });
        toast("Document removed.");
        onChange();
      }
      return openLease(id, onChange);
    }
    if (result === "edit") {
      if (await editLease(lease)) {
        loadLeases();
        onChange();
      }
      return openLease(id, onChange);
    }
    if (result === "delete") {
      if (!(await confirmDialog(`Delete this lease? Its offices are no longer assigned to ${lease.companyName}. ${lease.documents.length ? ` Its ${lease.documents.length === 1 ? "document is" : `${lease.documents.length} documents are`} deleted too.` : ""} Only for a lease entered by mistake: to end one, give it an end date.`, { danger: true, confirmLabel: "Delete" }))) return openLease(id, onChange);
      await api(`/api/leases/${lease.id}`, { method: "DELETE" });
      toast("Lease deleted.");
      loadLeases();
      onChange();
    }
  } catch (error) {
    toast(error.message, "error");
    return openLease(id, onChange);
  }
  if (location.hash.startsWith("#lease/")) history.back();
  return null;
}

/** A lease's rent year by year, with the year it is in and the next one marked. */
function leaseScheduleTable(lease) {
  const rated = lease.schedule.some((y) => y.rate !== null);
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, ["From", ...(rated ? ["Rate"] : []), "A month", "A year", ""].map((t) => h("th", { text: t })))),
    h("tbody", {}, lease.schedule.map((y) => h("tr", { class: y.when === "past" ? "muted" : "" },
      h("td", { class: "nowrap small-text", text: dateText(y.from) }),
      rated ? h("td", { class: "small-text", text: fmtRate(y.rate) }) : null,
      h("td", { class: "small-text" }, y.when === "now" ? h("strong", { text: fmtMoney(y.monthly) }) : fmtMoney(y.monthly)),
      h("td", { class: "small-text", text: fmtMoney(y.yearly) }),
      h("td", {}, y.when === "now" ? h("span", { class: "badge ok", text: lease.status === "ended" ? "Last" : lease.status === "upcoming" ? "First" : "Now" }) : y.when === "next" ? h("span", { class: "badge muted", text: "Next" }) : null))))));
}

/** Whole years from one date to another, and a date's nth anniversary, as the server counts them. */
function yearsSince(start, date) {
  const years = Number(date.slice(0, 4)) - Number(start.slice(0, 4));
  return Math.max(0, date.slice(5) < start.slice(5) ? years - 1 : years);
}
function anniversaryOf(start, n) {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10);
}

/** In the lease form, what the rent comes to with its yearly increases; empty without one. */
function leaseRentPreview(inputs, classRates) {
  const pct = Number(inputs.escalationPct.value);
  const start = inputs.startDate.value;
  const end = inputs.endDate.value;
  const commences = inputs.commencementDate.value || start;
  // A date still being typed can read as year 0020.
  if (!pct || !start || !commences || commences < "1900") return "";
  const today = localToday();
  const asOf = start > today ? start : end && end < today ? end : today;
  const n = yearsSince(commences, asOf);
  const fixed = inputs.rentMode.value === "fixed";
  // A monthly amount rounds to the cent each year, as the server does; a rate keeps its decimals.
  const up = (x, count) => {
    if (!fixed) return x * (1 + pct / 100) ** count;
    let cents = Math.round(x * 100);
    for (let i = 0; i < count; i += 1) cents = Math.floor((cents * (10000 + Math.round(pct * 100)) + 5000) / 10000);
    return cents / 100;
  };
  const base = fixed ? Number(inputs.monthlyRent.value) || null : null;
  const show = (x) => (fixed ? `${fmtMoney(x)}/month` : `${fmtRate(Math.round(x * 10000) / 10000)} a month`);
  const when = start > today ? "When it starts" : end && end < today ? "When it ended" : "Today";
  const increases = `${n} yearly ${n === 1 ? "increase" : "increases"} of ${pct}%`;
  const nextDay = anniversaryOf(commences, n + 1);
  const next = end && nextDay > end ? "" : ` ${n ? "Next increase" : `First increase of ${pct}%`} ${dateText(n ? nextDay : anniversaryOf(commences, 1))}${base ? `, to ${show(up(base, n + 1))}` : ""}.`;
  if (!fixed && classRates.length) return `${when}: ${classRates.map((c) => `${c.name} ${show(up(c.rate, n))}`).join(", ")}${n ? `, after ${increases}` : ""}.${next}`;
  if (!base) return fixed ? "" : `${when}: ${n ? `each office's rate times ${up(1, n).toFixed(4)}, after ${increases}.` : "each office's rate as it is."}${next}`;
  return `${when}: ${show(up(base, n))}${fixed ? ` (${fmtMoney(up(base, n) * 12)} a year)` : ""}${n ? `, from ${show(base)} with ${increases}` : ""}.${next}`;
}

/** Sends one document, as the file itself. */
async function uploadLeaseDocument(leaseId, file, kind, description) {
  const headers = { "content-type": "application/octet-stream" };
  if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  const res = await fetch(`/api/leases/${leaseId}/documents?${new URLSearchParams({ name: file.name, kind, description })}`, { method: "POST", headers, body: file, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${file.name}: ${res.status === 413 ? "larger than 25 MB; save it smaller (a scan in black and white, or at a lower resolution)." : data.error || `it couldn't be added (HTTP ${res.status}).`}`);
}

/** Adds one or more documents to a lease, all of one kind. Resolves to how many were added. */
async function addLeaseDocuments(lease) {
  const fileInput = h("input", { type: "file", multiple: true, accept: ".pdf,.docx,.xlsx,.png,.jpg,.jpeg" });
  const hasAgreement = lease.documents.some((d) => d.kind === "agreement");
  let added = 0;
  // Of the files chosen now, how many are in: choosing others starts again.
  let sent = 0;
  fileInput.addEventListener("change", () => { sent = 0; });
  await formDialog({
    title: `Add documents to ${lease.companyName}'s lease`,
    fields: [
      { node: h("label", { class: "full-row" }, h("span", { text: "Files" }), fileInput, h("span", { class: "hint", text: "PDF, Word (.docx), Excel (.xlsx), PNG or JPEG, up to 25 MB each. You can choose several." })) },
      { name: "kind", label: "What they are", type: "select", value: hasAgreement ? "amendment" : "agreement", options: Object.entries(LEASE_DOCUMENT_KINDS).map(([value, label]) => ({ value, label })) },
      { name: "description", label: "Description (optional)", value: "", placeholder: "Mod 1, adds suite 204" }
    ],
    submitLabel: "Add",
    onSubmit: async (v) => {
      const chosen = [...fileInput.files].slice(sent);
      if (!chosen.length) throw new Error("Choose a file.");
      for (const file of chosen) {
        if (file.size > 25 * 1048576) throw new Error(`${file.name}: larger than 25 MB; save it smaller (a scan in black and white, or at a lower resolution).`);
      }
      // One at a time. If one is refused, those before it are kept, and adding again carries on from it.
      for (const file of chosen) {
        try {
          await uploadLeaseDocument(lease.id, file, v.kind, v.description);
        } catch (error) {
          throw added ? new Error(`${added} added, and stopped there. ${error.message}`) : error;
        }
        added += 1;
        sent += 1;
      }
      return true;
    }
  });
  if (added) toast(`${added} ${added === 1 ? "document" : "documents"} added.`);
  return added;
}

const monthText = (period) => new Date(`${period}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/**
 * Ticks for the offices a lease covers: those free for its dates, and its own. A ticked office goes
 * by the lease's rate for its classification, or has a custom rate at the start of the lease when
 * that is ticked too. Reloads when the dates change. { node, value() (office ids), rents() ({ officeId,
 * rate, monthly }; throws for a custom rate not given), setFixed(a fixed rent: no such rents),
 * setClassRate(fn: a classification's rate in the form), showRates() (after one changes), reload(start, end) }.
 */
function leaseOfficePicker(lease) {
  const own = new Set((lease?.offices || []).map((o) => o.officeId));
  const chosen = new Set(own);
  // As typed, kept while the offices reload.
  const rents = new Map((lease?.offices || []).map((o) => [o.officeId, { name: o.name, custom: o.ownRate !== null || o.ownMonthly !== null, rate: o.ownRate ?? "", monthly: o.ownMonthly ?? "" }]));
  let classRate = () => null;
  let rateNotes = [];
  const list = h("div", { class: "lease-offices" });
  const note = h("p", { class: "muted small-text" });
  const node = h("div", { class: "full-row stack" }, h("span", { class: "label", text: "Offices" }), note, h("p", { class: "hint lease-office-rents-note", text: "A ticked office goes by the rate below for its classification. Tick Custom rate on a room with its own, and give it as it was at the start of the lease, not today's: the yearly increases are added." }), list);
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
    for (const o of lease?.offices || []) if (!offices.some((x) => x.id === o.officeId)) offices.push({ id: o.officeId, name: o.name, floorName: o.floorName, siteName: o.siteName, sqft: o.sqft, classId: o.classKey || null, classification: { name: o.className }, askingRate: o.rateSource === "lease" || o.rateSource === "leaseRoom" ? undefined : o.rate, monthlyRent: o.rateSource === "monthly" ? o.monthly : null });
    offices.sort((a, b) => `${a.siteName} ${a.floorName} ${a.name}`.localeCompare(`${b.siteName} ${b.floorName} ${b.name}`, undefined, { numeric: true }));
    note.textContent = offices.length ? `Free from ${dateText(start)}${end ? ` to ${dateText(end)}` : " on"}:` : "No office is free for those dates.";
    rateNotes = [];
    list.replaceChildren(...offices.map((o) => {
      const box = h("input", { type: "checkbox" });
      box.checked = chosen.has(o.id);
      const typed = rents.get(o.id) || { custom: false, rate: "", monthly: "" };
      const custom = h("input", { type: "checkbox" });
      custom.checked = typed.custom;
      const rate = h("input", { type: "number", step: "0.0001", min: "0" });
      const monthly = h("input", { type: "number", step: "0.01", min: "0" });
      rate.value = typed.rate;
      monthly.value = typed.monthly;
      const save = () => rents.set(o.id, { name: o.name, custom: custom.checked, rate: rate.value, monthly: monthly.value });
      // One or the other.
      const keep = (other) => {
        if (other === monthly && rate.value) monthly.value = "";
        if (other === rate && monthly.value) rate.value = "";
        save();
      };
      rate.addEventListener("input", () => keep(monthly));
      monthly.addEventListener("input", () => keep(rate));
      const rentFields = h("div", { class: "lease-office-rent", hidden: !custom.checked },
        h("label", {}, h("span", { class: "hint", text: "Start rate, $/sq ft" }), rate),
        h("span", { class: "muted small-text", text: "or" }),
        h("label", {}, h("span", { class: "hint", text: "Start $/month" }), monthly));
      // What it goes by without a custom rate.
      const rateNote = h("span", { class: "muted small-text" });
      const showRate = () => {
        const onLease = classRate(o.classId || 0);
        rateNote.hidden = custom.checked;
        rateNote.textContent = o.monthlyRent !== null && o.monthlyRent !== undefined ? `Its own ${fmtMoney(o.monthlyRent)} a month, fixed`
          : onLease ? `${fmtRate(onLease)} a month, from this lease`
          : o.askingRate === undefined ? "Its rate from Rates" : o.askingRate === null ? "No rate on Rates yet" : `${fmtRate(o.askingRate)} a month, from Rates`;
      };
      rateNotes.push(showRate);
      showRate();
      const extra = h("div", { class: "lease-office-extra", hidden: !box.checked }, rateNote, h("label", { class: "check-row" }, custom, h("span", { text: "Custom rate" })), rentFields);
      custom.addEventListener("change", () => {
        rentFields.hidden = !custom.checked;
        save();
        showRate();
      });
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(o.id); else chosen.delete(o.id);
        extra.hidden = !box.checked;
      });
      return h("div", {}, h("label", { class: "check-row" }, box, h("span", {}, h("strong", { text: o.name }),
        h("span", { class: "muted small-text", text: ` ${[o.floorName, multiSite() ? o.siteName : null, o.classification?.name || "Unclassified", o.sqft ? fmtSqft(o.sqft) : null].filter(Boolean).join(" · ")}` }))), extra);
    }));
  }
  return {
    node,
    reload,
    value: () => [...chosen],
    rents: () => [...chosen].map((officeId) => {
      const r = rents.get(officeId);
      if (!r?.custom) return { officeId };
      if (!r.rate && !r.monthly) throw new Error(`Give ${r.name} its custom rate or monthly rent, or untick Custom rate.`);
      return { officeId, rate: r.rate, monthly: r.monthly };
    }),
    setClassRate: (fn) => { classRate = fn; },
    showRates: () => rateNotes.forEach((show) => show()),
    setFixed: (fixed) => node.classList.toggle("no-office-rents", fixed)
  };
}

/** The lease form: company (companyId: chosen already, for a new one), reference, dates, offices, rent, deposit, notes. Resolves to the saved lease. */
async function editLease(lease, { companyId = null } = {}) {
  const [companies, { classes }] = await Promise.all([financeCompanies(), api("/api/facilities/rates")]);
  const picker = leaseOfficePicker(lease);
  let start = lease?.startDate || "";
  let end = lease?.endDate || "";
  const reloadOffices = debounce(() => picker.reload(start, end), 300);
  // A rate for each classification, as it was at the start of the lease.
  const rateInputs = new Map(classes.map((c) => {
    const input = h("input", { type: "number", step: "0.0001", min: "0" });
    input.value = lease?.classRates.find((x) => x.key === c.key)?.rate ?? "";
    return [c.key, input];
  }));
  const classRate = (key) => Number(rateInputs.get(key)?.value) || null;
  picker.setClassRate(classRate);
  const rateBlock = h("div", { class: "full-row stack" },
    h("span", { class: "label", text: "Rates at the start of the lease" }),
    h("p", { class: "hint", text: "Dollars per square foot a month, by classification, as they were when the lease began: the yearly increases are added. Empty: the rate from Rates." }),
    h("div", { class: "lease-class-rates" }, classes.map((c) => h("label", {}, h("span", { text: c.name }), rateInputs.get(c.key)))));
  const fixedOnly = (inputs, mode) => {
    inputs.monthlyRent.closest("label").hidden = mode !== "fixed";
    rateBlock.hidden = mode === "fixed";
    picker.setFixed(mode === "fixed");
  };
  const rentPreview = h("p", { class: "message full-row small-text", hidden: true });
  const showRent = (inputs) => {
    rentPreview.textContent = leaseRentPreview(inputs, classes.filter((c) => classRate(c.key)).map((c) => ({ name: c.name, rate: classRate(c.key) })));
    rentPreview.hidden = !rentPreview.textContent;
  };
  const saved = await formDialog({
    title: lease ? `Edit ${lease.companyName}'s lease` : "New lease",
    wide: true,
    fields: [
      { name: "companyId", label: "Company", type: "select", required: true, value: String(lease?.companyId || companyId || ""), half: true, options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] },
      { name: "reference", label: "Reference (optional)", value: lease?.reference || "", half: true, placeholder: "Your lease number" },
      { name: "startDate", label: "Starts", type: "date", required: true, value: start, half: true, onChange: (input, inputs) => {
        // A commencement that was the start (or empty) moves with it.
        const commences = inputs.commencementDate;
        if (commences && (!commences.value || commences.value === start)) commences.value = input.value;
        start = input.value;
        reloadOffices();
        showRent(inputs);
      } },
      { name: "endDate", label: "Ends (its last day)", type: "date", value: end, half: true, hint: "Leave empty for month to month.", onChange: (input) => { end = input.value; reloadOffices(); } },
      { node: picker.node },
      { name: "rentMode", label: "Rent", type: "select", value: lease?.rentMode || "rates", half: true, options: [{ value: "rates", label: "From the rates (size × rate)" }, { value: "fixed", label: "A fixed amount a month" }], onChange: (input, inputs, dlg) => {
        fixedOnly(inputs, input.value);
        showRent(inputs);
        // As the form opens: the sum follows the figures as they are typed.
        if (dlg) {
          for (const name of ["monthlyRent", "commencementDate", "escalationPct", "endDate"]) inputs[name].addEventListener("input", () => showRent(inputs));
          for (const input of rateInputs.values()) input.addEventListener("input", () => { showRent(inputs); picker.showRates(); });
        }
      } },
      { name: "monthlyRent", label: "Monthly rent in the first year ($)", type: "number", value: lease?.monthlyRent ?? "", half: true, step: "0.01", min: 0, hint: "As it was when the lease began; the yearly increases are added." },
      { node: rateBlock },
      { name: "commencementDate", label: "Commences", type: "date", value: lease?.commencementDate || "", half: true, hint: "Usually the start. Rent is billed from the start; the yearly increase counts from here." },
      { name: "escalationPct", label: "Yearly increase (%)", type: "number", value: lease?.escalationPct ?? "", half: true, step: "0.01", min: 0, hint: "On each anniversary of the commencement, whichever way the rent is worked out." },
      { node: rentPreview },
      { name: "deposit", label: "Deposit ($, optional)", type: "number", value: lease?.deposit ?? "", half: true, step: "0.01", min: 0 },
      { name: "notes", label: "Notes", type: "textarea", rows: 2, value: lease?.notes || "" }
    ],
    // The form calls each onChange as it opens: the rent fields show or hide, and the offices load.
    submitLabel: lease ? "Save" : "Add lease",
    onSubmit: async (v) => {
      const body = {
        companyId: Number(v.companyId), reference: v.reference, startDate: v.startDate, commencementDate: v.commencementDate || null, endDate: v.endDate || null, officeIds: picker.value(), officeRents: v.rentMode === "fixed" ? [] : picker.rents(),
        rentMode: v.rentMode, monthlyRent: v.rentMode === "fixed" ? v.monthlyRent : null, classRates: v.rentMode === "fixed" ? {} : Object.fromEntries([...rateInputs].map(([key, input]) => [key, input.value])), escalationPct: v.escalationPct, deposit: v.deposit, notes: v.notes
      };
      return (lease ? await api(`/api/leases/${lease.id}`, { method: "PUT", body }) : await api("/api/leases", { method: "POST", body })).lease;
    }
  });
  if (saved) toast(lease ? "Lease saved." : "Lease added; its offices are assigned.");
  return saved;
}

/** The Leases panel on a company's page: those in force first, then those to come, then those that ended. */
function companyLeasesPanel(company) {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Leases" }), skeletonLines());
  // A lease also sets the rent the Offices panel shows, so the whole page is drawn again.
  const changed = () => showCompanyDetail(company.id);
  api(`/api/leases?companyId=${company.id}`).then(({ leases }) => {
    const editor = canEditFacilities();
    const standing = { active: 0, ending: 0, upcoming: 1, ended: 2 };
    const rows = [...leases].sort((a, b) => standing[a.status] - standing[b.status]).map((l) => h("tr", { class: `clickable${l.status === "ended" ? " inactive" : ""}`, onclick: () => openLease(l.id, changed) },
      h("td", {}, h("strong", { text: l.reference || "Lease" })),
      h("td", { class: "small-text", text: l.offices.length ? `${l.offices.map((o) => o.name).join(", ")}${multiSite() && l.sites.length ? ` · ${l.sites.map((s) => s.name).join(", ")}` : ""}` : "None" }),
      h("td", { class: "nowrap small-text", text: `${dateText(l.startDate)} – ${l.endDate ? dateText(l.endDate) : "runs on"}` }),
      h("td", { class: "nowrap", text: rentText(l) }),
      h("td", { class: "small-text", text: l.documents.length ? `${l.documents.length} ${l.documents.length === 1 ? "document" : "documents"}` : "None" }),
      h("td", {}, h("span", { class: `badge ${LEASE_STATUS[l.status].cls}`, text: LEASE_STATUS[l.status].label }))));
    panel.replaceChildren(
      h("div", { class: "panel-head" },
        h("h3", { text: "Leases" }),
        editor ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "primary small", text: "New lease", onclick: async () => {
          const lease = await editLease(null, { companyId: company.id });
          if (!lease) return;
          changed();
          openLease(lease.id, changed);
        } })) : null),
      rows.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Lease", "Offices", "Term", "Rent", "Documents", "Status"].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows)))
        : h("p", { class: "muted small-text", text: editor ? "No leases yet. New lease adds one and assigns its offices." : "No leases yet." }));
  }).catch((error) => panel.replaceChildren(h("h3", { text: "Leases" }), h("p", { class: "message error", text: error.message })));
  return panel;
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

/** A price list item's price: "$75.00 per hour", or "$20.00 each". */
const itemPrice = (i) => `${fmtMoney(i.rate)} ${i.unit === "each" ? "each" : `per ${i.unit}`}`;

/** The charge form: company, date, what (from the price list or one-off), quantity, rate, notes. */
async function editCharge(charge) {
  const [companies, { items }] = await Promise.all([financeCompanies(), api("/api/charge-items")]);
  const itemOf = (id) => items.find((i) => String(i.id) === String(id));
  let opened = false;
  const forBadges = (id) => itemOf(id)?.kind === "tenant_badge";
  const badgeNote = h("p", { class: "message", hidden: true, text: "This adds the quantity to the tenant badges the company may hold, as soon as it's logged. Deleting the charge takes them away again." });
  const result = await formDialog({
    title: charge ? "Edit charge" : "Log a charge",
    fields: [
      { name: "companyId", label: "Company", type: "select", required: true, value: String(charge?.companyId || $("charges-company").value || ""), options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] },
      { name: "date", label: "Date", type: "date", required: true, value: charge?.date || localToday(), half: true },
      { name: "itemId", label: "What", type: "select", value: charge ? String(charge.itemId || "") : "", half: true,
        options: [{ value: "", label: "Something else (one-off)" }, ...items.map((i) => ({ value: String(i.id), label: `${i.name} (${itemPrice(i)})` }))],
        onChange: (input, inputs) => {
          // Tenant badges come in whole numbers.
          badgeNote.hidden = !forBadges(input.value);
          inputs.quantity.step = forBadges(input.value) ? "1" : "any";
          inputs.quantity.min = forBadges(input.value) ? "1" : "0.01";
          // Called once as the form opens: an edited charge keeps its own description and rate.
          if (!opened) { opened = true; return; }
          const item = itemOf(input.value);
          if (item) {
            inputs.description.value = item.name;
            inputs.rate.value = item.rate;
            inputs.unit.value = item.unit;
          }
        } },
      { node: badgeNote },
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
      const saved = charge ? await api(`/api/charges/${charge.id}`, { method: "PUT", body }) : await api("/api/charges", { method: "POST", body });
      return { ...saved.charge, allotment: saved.allotment };
    }
  });
  if (result === "deleted") toast(forBadges(charge.itemId) ? "Charge deleted, and its tenant badges taken away." : "Charge deleted.");
  else if (result) toast(`${charge ? "Charge saved." : `Logged ${fmtMoney(result.amount)} for ${result.companyName}.`}${result.allotment ? ` ${result.companyName} may now hold ${result.allotment.allowed} tenant badges.` : ""}`);
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
          h("td", {}, h("strong", { text: i.name }), i.active ? null : h("span", { class: "badge muted", text: "Off" }),
            i.builtIn ? h("div", { class: "muted small-text", text: "Built in: a charge for it adds that many tenant badges to the company." }) : null),
          h("td", { text: itemPrice(i) }),
          h("td", { class: "muted small-text", text: i.used ? `Charged ${i.used} time${i.used === 1 ? "" : "s"}` : "" }),
          h("td", {}, may ? h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: async () => { if (await editItem(i)) render(); } }),
            i.builtIn ? null : h("button", { type: "button", class: "link-btn", text: i.active ? "Turn off" : "Turn on", onclick: async () => {
              await api(`/api/charge-items/${i.id}`, { method: "PUT", body: { active: !i.active } });
              render();
            } }),
            i.used || i.builtIn ? null : h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
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
