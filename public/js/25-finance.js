// 25-finance.js: Finance > Invoices (a month's invoices from rent and charges, adjusting and
// issuing them, payments, printing), Balances (what each company owes, by how late), Payments,
// and Billing settings (what invoices say, QuickBooks account names, exports, and the
// QuickBooks Online connection). Managers read; Finance (and administrators) change.

const INVOICE_STATE = {
  draft: { label: "Draft", cls: "muted" },
  open: { label: "Open", cls: "" },
  partial: { label: "Partly paid", cls: "warn" },
  overdue: { label: "Overdue", cls: "bad" },
  paid: { label: "Paid", cls: "ok" },
  void: { label: "Void", cls: "muted" }
};
const PAYMENT_METHODS = ["Check", "ACH", "Wire", "Card", "Cash", "Other"];

const stateBadge = (inv) => h("span", { class: `badge ${INVOICE_STATE[inv.state].cls}`, text: INVOICE_STATE[inv.state].label });
const invoiceName = (inv) => inv.number || `Draft for ${inv.companyName}`;
const thisMonth = () => localToday().slice(0, 7);

/** Opens the printable invoice in a new tab (to print or save as PDF). */
const printInvoice = (id) => window.open(`/api/invoices/${id}/print`, "_blank", "noopener");

// --- invoices ---------------------------------------------------------------------------------------------

$("invoices-search").addEventListener("input", debounce(() => loadInvoices(), 250));
$("invoices-state").addEventListener("change", () => loadInvoices());
$("invoices-period").addEventListener("change", () => loadInvoices());
$("invoices-generate").addEventListener("click", () => generateInvoices());
$("invoices-new").addEventListener("click", () => newInvoice());
$("invoices-export").addEventListener("click", () => exportDialog());

function showInvoices() {
  for (const id of ["invoices-generate", "invoices-new"]) $(id).hidden = !canEditFinance();
  loadInvoices();
}

async function loadInvoices() {
  const table = $("invoices-table");
  const head = ["Invoice", "Company", "For", "Date", "Due", "Total", "Balance", "State"];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  let invoices;
  try {
    ({ invoices } = await api(`/api/invoices?${new URLSearchParams({ state: $("invoices-state").value, q: $("invoices-search").value.trim(), ...($("invoices-period").value ? { period: $("invoices-period").value } : {}) })}`));
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  const owed = invoices.reduce((n, i) => n + (i.balance || 0), 0);
  $("invoices-total").textContent = invoices.length ? `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}${owed ? `, ${fmtMoney(owed)} owed` : ""}.` : "";
  if (!invoices.length) {
    clear(table.tBodies[0]).append(emptyRow(head.length, canEditFinance() ? "No invoices here. Invoice a month to draft them from rent and charges." : "No invoices here."));
    return;
  }
  clear(table.tBodies[0]).append(...invoices.map((i) => {
    const row = h("tr", { class: `clickable${i.state === "void" ? " inactive" : ""}` },
      h("td", {}, h("strong", { class: i.number ? "mono" : "", text: i.number || "Draft" })),
      h("td", { text: i.companyName }),
      h("td", { class: "small-text", text: i.period ? monthText(i.period) : "" }),
      h("td", { class: "nowrap small-text", text: dateText(i.issueDate) }),
      h("td", { class: "nowrap small-text", text: dateText(i.dueDate) }),
      h("td", { class: "nowrap", text: fmtMoney(i.total) }),
      h("td", { class: "nowrap", text: i.status === "issued" ? fmtMoney(i.balance) : "" }),
      h("td", {}, stateBadge(i), i.qboId ? h("span", { class: "badge muted", title: "Sent to QuickBooks", text: "QB" }) : null));
    row.addEventListener("click", () => { location.hash = `#invoice/${i.id}`; });
    return row;
  }));
}

/** Drafts a month's invoices from leases' rent and unbilled charges, then says what was made. */
async function generateInvoices() {
  const result = await formDialog({
    title: "Invoice a month",
    intro: h("p", { class: "muted", text: "Drafts an invoice for each company: its leases' rent for the month (part months for the days covered) and its charges not invoiced yet, up to the month's end. A month's rent is invoiced once. Check the drafts, then issue them." }),
    fields: [
      { name: "period", label: "Month", type: "month", required: true, value: thisMonth(), half: true },
      { name: "issueDate", label: "Invoice date", type: "date", required: true, value: localToday(), half: true, hint: "Due after the payment terms in Billing settings." }
    ],
    submitLabel: "Draft invoices",
    onSubmit: (v) => api("/api/invoices/generate", { method: "POST", body: { period: v.period, issueDate: v.issueDate } })
  });
  if (!result) return;
  $("invoices-state").value = "draft";
  $("invoices-period").value = "";
  loadInvoices();
  await openDialog({
    title: `${monthText(result.period)}: ${result.invoices.length} draft${result.invoices.length === 1 ? "" : "s"}`,
    wide: true,
    body: h("div", { class: "stack" },
      result.invoices.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Company", "Rent lines", "Charges", "Total", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, result.invoices.map((i) => h("tr", {},
          h("td", {}, h("strong", { text: i.companyName })),
          h("td", { text: String(i.rentLines) }),
          h("td", { text: String(i.chargeLines) }),
          h("td", { text: fmtMoney(i.total) }),
          h("td", { class: "muted small-text", text: i.newDraft ? "New draft" : "Added to its draft" })))))) : h("p", { class: "muted", text: "Nothing new to invoice for that month: its rent is invoiced and there are no charges waiting." }),
      result.skipped.length ? h("div", { class: "message warn" }, h("strong", { text: "Left out:" }), h("ul", {}, result.skipped.map((s) => h("li", { text: `${s.companyName}: ${s.reason}` })))) : ""),
    actions: [{ label: "Close", kind: "primary", value: null }]
  });
}

async function newInvoice() {
  const companies = await financeCompanies();
  const inv = await formDialog({
    title: "New invoice",
    intro: h("p", { class: "muted", text: "A blank draft for one company, to add lines to by hand: rent for a month, charges, or anything else." }),
    fields: [
      { name: "companyId", label: "Company", type: "select", required: true, options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] },
      { name: "issueDate", label: "Invoice date", type: "date", required: true, value: localToday(), half: true },
      { name: "period", label: "For the month (optional)", type: "month", value: "", half: true }
    ],
    submitLabel: "Make draft",
    onSubmit: async (v) => (await api("/api/invoices", { method: "POST", body: { companyId: Number(v.companyId), issueDate: v.issueDate, period: v.period || null } })).invoice
  });
  if (inv) {
    loadInvoices();
    location.hash = `#invoice/${inv.id}`;
  }
}

async function openInvoice(id) {
  let inv;
  try {
    ({ invoice: inv } = await api(`/api/invoices/${id}`));
  } catch (error) {
    toast(error.message, "error");
    if (location.hash.startsWith("#invoice/")) history.back();
    return;
  }
  const edit = canEditFinance();
  const draft = inv.status === "draft";
  // Offered only while QuickBooks is connected.
  const qboConnected = edit && inv.status === "issued" && !inv.qboId ? Boolean((await api("/api/quickbooks").catch(() => null))?.quickbooks?.connected) : false;
  let dlgRef = null;
  const act = async (fn) => {
    try {
      await fn();
      dlgRef?.finish("refresh");
    } catch (error) {
      dlgRef?.showError(error.message);
    }
  };
  const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", {}, value)] : null);
  const body = h("div", { class: "detail" },
    h("p", {}, stateBadge(inv), inv.qboId ? h("span", { class: "badge muted", text: "In QuickBooks" }) : null),
    h("dl", { class: "facts inline-facts" },
      fact("Company", inv.companyId ? h("a", { href: `#company/${inv.companyId}`, text: inv.companyName }) : inv.companyName),
      fact("For", inv.period ? monthText(inv.period) : null),
      fact("Invoice date", dateText(inv.issueDate)),
      fact("Due", `${dateText(inv.dueDate)}${inv.daysOverdue ? ` (${inv.daysOverdue} day${inv.daysOverdue === 1 ? "" : "s"} ago)` : ""}`),
      fact("Notes", inv.notes ? h("span", { class: "pre", text: inv.notes }) : null)),
    h("div", { class: "table-wrap" }, h("table", { class: "table compact invoice-lines" },
      h("thead", {}, h("tr", {}, ["Description", "Quantity", "Rate", "Amount", ""].map((t) => h("th", { text: t })))),
      h("tbody", {},
        inv.lines.length ? inv.lines.map((l) => h("tr", {},
          h("td", {}, l.description, l.kind === "rent" && l.leaseId ? h("div", { class: "small-text" }, h("a", { href: `#lease/${l.leaseId}`, text: "Lease" })) : null),
          h("td", { class: "nowrap small-text", text: `${l.quantity}${l.unit ? ` ${l.unit}` : ""}` }),
          h("td", { class: "nowrap small-text", text: fmtMoney(l.rate) }),
          h("td", { class: "nowrap", text: fmtMoney(l.amount) }),
          h("td", {}, draft && edit ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => act(() => api(`/api/invoices/${inv.id}/lines/${l.id}`, { method: "DELETE" })) }) : null)))
          : h("tr", {}, h("td", { colspan: 5, class: "muted", text: "No lines yet." })),
        h("tr", { class: "total-row" }, h("td", { colspan: 3 }, h("strong", { text: "Total" })), h("td", {}, h("strong", { text: fmtMoney(inv.total) })), h("td", {}))))),
    draft && edit ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary small", text: "Add a line", onclick: async () => { if (await addInvoiceLine(inv)) dlgRef?.finish("refresh"); } })) : "",
    inv.status !== "draft" ? h("div", { class: "stack" },
      h("h4", { text: "Payments" }),
      inv.payments.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Date", "Amount", "Method", "Reference", "", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, inv.payments.map((p) => h("tr", {},
          h("td", { class: "nowrap small-text", text: dateText(p.date) }),
          h("td", { class: "nowrap", text: fmtMoney(p.amount) }),
          h("td", { class: "small-text", text: p.method }),
          h("td", { class: "small-text", text: [p.reference, p.notes].filter(Boolean).join(" · ") }),
          h("td", { class: "muted small-text", text: p.source === "quickbooks" ? "From QuickBooks" : p.createdBy ? `by ${p.createdBy}` : "" }),
          h("td", {}, edit ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
            if (await confirmDialog(`Remove the payment of ${fmtMoney(p.amount)} on ${dateText(p.date)}?`, { danger: true, confirmLabel: "Remove" })) act(() => api(`/api/payments/${p.id}`, { method: "DELETE" }));
          } }) : null)))))) : h("p", { class: "muted", text: "None yet." }),
      inv.status === "issued" ? h("p", {}, h("strong", { text: `Paid ${fmtMoney(inv.paid)}, ${fmtMoney(inv.balance)} owed.` })) : "") : "",
    h("p", { class: "muted small-text", text: [
      `Made ${fmtDateTime(inv.createdAt)}${inv.createdBy ? ` by ${inv.createdBy}` : ""}.`,
      inv.issuedAt ? `Issued ${fmtDateTime(inv.issuedAt)}${inv.issuedBy ? ` by ${inv.issuedBy}` : ""}.` : null,
      inv.voidedAt ? `Voided ${fmtDateTime(inv.voidedAt)}${inv.voidedBy ? ` by ${inv.voidedBy}` : ""}.` : null
    ].filter(Boolean).join(" ") }));
  const actions = [{ label: "Print", value: "print" }];
  if (edit && draft) actions.unshift({ label: "Delete draft", kind: "danger", value: "delete" });
  if (edit && inv.status === "issued" && !inv.payments.length) actions.unshift({ label: "Void", kind: "danger", value: "void" });
  if (edit && inv.status !== "void") actions.push({ label: draft ? "Dates and notes" : "Notes", value: "edit" });
  if (qboConnected) actions.push({ label: "Send to QuickBooks", value: "qbo" });
  if (edit && inv.status === "issued" && inv.balance > 0) actions.push({ label: "Record payment", kind: "primary", value: "pay" });
  if (edit && draft) actions.push({ label: "Issue", kind: "primary", value: "issue" });
  actions.push({ label: "Close", kind: inv.status === "issued" && inv.balance > 0 && edit ? "secondary" : draft && edit ? "secondary" : "primary", value: null });
  const result = await openDialog({ title: invoiceName(inv), body, wide: true, actions, onOpen: (d) => { dlgRef = d; } });
  const again = () => openInvoice(id);
  try {
    if (result === "refresh") { loadInvoices(); return again(); }
    if (result === "print") { printInvoice(inv.id); return again(); }
    if (result === "edit") { if (await editInvoice(inv)) loadInvoices(); return again(); }
    if (result === "pay") { if (await recordPayment(inv)) loadInvoices(); return again(); }
    if (result === "issue") {
      if (!(await confirmDialog(`Issue this invoice to ${inv.companyName} for ${fmtMoney(inv.total)}? It gets the next number, and its lines can't change after.`, { title: "Issue invoice", confirmLabel: "Issue" }))) return again();
      const { invoice } = await api(`/api/invoices/${inv.id}/issue`, { method: "POST" });
      toast(`Issued ${invoice.number}.`);
      loadInvoices();
      return again();
    }
    if (result === "void") {
      if (!(await confirmDialog(`Void ${inv.number}? It stays on record as void, and its charges and rent can be invoiced again.`, { danger: true, confirmLabel: "Void" }))) return again();
      await api(`/api/invoices/${inv.id}/void`, { method: "POST" });
      toast(`${inv.number} is void.`);
      loadInvoices();
      return again();
    }
    if (result === "qbo") {
      const { invoice } = await api(`/api/invoices/${inv.id}/quickbooks`, { method: "POST" });
      toast(`${invoice.number} is in QuickBooks.`);
      loadInvoices();
      return again();
    }
    if (result === "delete") {
      if (!(await confirmDialog(`Delete this draft for ${inv.companyName}? Its charges go back to not invoiced.`, { danger: true, confirmLabel: "Delete" }))) return again();
      await api(`/api/invoices/${inv.id}`, { method: "DELETE" });
      toast("Draft deleted.");
      loadInvoices();
    }
  } catch (error) {
    toast(error.message, "error");
    return again();
  }
  if (location.hash.startsWith("#invoice/")) history.back();
  return null;
}

/** Adds a line to a draft: something typed in (a credit as a negative amount), a charge not invoiced yet, or a lease's rent for a month. */
async function addInvoiceLine(inv) {
  const [{ charges }, { leases }] = await Promise.all([
    api(`/api/charges?${new URLSearchParams({ status: "unbilled", companyId: String(inv.companyId) })}`).catch(() => ({ charges: [] })),
    api(`/api/leases?${new URLSearchParams({ companyId: String(inv.companyId) })}`).catch(() => ({ leases: [] }))
  ]);
  const showFor = (inputs, kind) => {
    const shown = { adjustment: ["description", "quantity", "rate"], charge: ["chargeId"], rent: ["leaseId", "period"] }[kind];
    for (const k of ["description", "quantity", "rate", "chargeId", "leaseId", "period"]) inputs[k].closest("label").hidden = !shown.includes(k);
  };
  return formDialog({
    title: `Add a line for ${inv.companyName}`,
    fields: [
      { name: "kind", label: "Line", type: "select", value: "adjustment", options: [
        { value: "adjustment", label: "Something else, or a credit" },
        { value: "charge", label: `A charge not invoiced yet (${charges.length})` },
        { value: "rent", label: "A month's rent" }
      ], onChange: (input, inputs) => showFor(inputs, input.value) },
      { name: "description", label: "Description", placeholder: "Late fee, credit for…" },
      { name: "quantity", label: "Quantity", type: "number", value: 1, half: true, step: "any", min: 0.01 },
      { name: "rate", label: "Amount each ($)", type: "number", half: true, step: "0.01", hint: "Negative for a credit." },
      { name: "chargeId", label: "Charge", type: "select", options: charges.length ? charges.map((c) => ({ value: String(c.id), label: `${dateText(c.date)}: ${c.description}, ${fmtMoney(c.amount)}` })) : [{ value: "", label: "None waiting" }] },
      { name: "leaseId", label: "Lease", type: "select", half: true, options: leases.length ? leases.map((l) => ({ value: String(l.id), label: `${l.reference || l.offices.map((o) => o.name).join(", ") || `Lease #${l.id}`} (${dateText(l.startDate)}–${l.endDate ? dateText(l.endDate) : "on"})` })) : [{ value: "", label: "No leases" }] },
      { name: "period", label: "Month", type: "month", value: inv.period || thisMonth(), half: true }
    ],
    submitLabel: "Add line",
    onSubmit: async (v) => {
      const body = v.kind === "charge" ? { chargeId: Number(v.chargeId) } : v.kind === "rent" ? { leaseId: Number(v.leaseId), period: v.period } : { description: v.description, quantity: v.quantity, rate: v.rate };
      return (await api(`/api/invoices/${inv.id}/lines`, { method: "POST", body })).invoice;
    }
  });
}

async function editInvoice(inv) {
  const draft = inv.status === "draft";
  return formDialog({
    title: `${invoiceName(inv)}: ${draft ? "dates and notes" : "notes"}`,
    fields: [
      ...(draft ? [
        { name: "issueDate", label: "Invoice date", type: "date", required: true, value: inv.issueDate, half: true },
        { name: "dueDate", label: "Due", type: "date", required: true, value: inv.dueDate, half: true }
      ] : []),
      { name: "notes", label: "Notes", type: "textarea", rows: 3, value: inv.notes || "", hint: "Printed on the invoice." }
    ],
    onSubmit: async (v) => (await api(`/api/invoices/${inv.id}`, { method: "PUT", body: v })).invoice
  });
}

async function recordPayment(inv) {
  const result = await formDialog({
    title: `Payment on ${inv.number}`,
    intro: h("p", { class: "muted", text: `${inv.companyName} owes ${fmtMoney(inv.balance)} of ${fmtMoney(inv.total)}.` }),
    fields: [
      { name: "amount", label: "Amount ($)", type: "number", required: true, value: inv.balance, half: true, step: "0.01", min: 0.01 },
      { name: "date", label: "Received", type: "date", required: true, value: localToday(), half: true },
      { name: "method", label: "Method", type: "select", value: "Check", half: true, options: PAYMENT_METHODS.map((m) => ({ value: m, label: m })) },
      { name: "reference", label: "Reference (optional)", half: true, placeholder: "Check number, wire reference…" },
      { name: "notes", label: "Notes (optional)" }
    ],
    submitLabel: "Record payment",
    onSubmit: (v) => api(`/api/invoices/${inv.id}/payments`, { method: "POST", body: v })
  });
  if (result) toast(result.invoice.balance > 0 ? `Recorded; ${fmtMoney(result.invoice.balance)} still owed.` : `${inv.number} is paid.`);
  return result;
}

/** Downloads invoices or payments for QuickBooks: CSV for QuickBooks Online, IIF for QuickBooks Desktop. */
async function exportDialog() {
  await formDialog({
    title: "Export for QuickBooks",
    intro: h("p", { class: "muted", text: "Issued invoices (by invoice date) or payments (by date received). CSV is QuickBooks Online's import layout; IIF is for QuickBooks Desktop (File > Utilities > Import > IIF Files). The account and item names come from Billing settings." }),
    fields: [
      { name: "what", label: "Export", type: "select", value: "invoices", half: true, options: [{ value: "invoices", label: "Invoices" }, { value: "payments", label: "Payments" }] },
      { name: "format", label: "For", type: "select", value: "csv", half: true, options: [{ value: "csv", label: "QuickBooks Online (CSV)" }, { value: "iif", label: "QuickBooks Desktop (IIF)" }] },
      { name: "from", label: "From", type: "date", half: true, value: `${thisMonth()}-01` },
      { name: "to", label: "To", type: "date", half: true, value: localToday() }
    ],
    submitLabel: "Download",
    onSubmit: (v) => {
      const a = h("a", { href: `/api/finance/export/${v.what}?${new URLSearchParams({ format: v.format, ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) })}`, download: "" });
      document.body.append(a);
      a.click();
      a.remove();
      return true;
    }
  });
}

// --- balances ----------------------------------------------------------------------------------------------

async function showBalances() {
  const body = $("balances-body");
  let data;
  try {
    data = await api("/api/finance/aging");
  } catch (error) {
    body.replaceChildren(h("p", { class: "message error", text: error.message }));
    return;
  }
  const cols = [["current", "Not due yet"], ["d30", "1–30 days"], ["d60", "31–60"], ["d90", "61–90"], ["over90", "Over 90"], ["total", "Owed"]];
  const cell = (n, k) => h("td", { class: `nowrap${k === "total" ? "" : " small-text"}${n && ["d60", "d90", "over90"].includes(k) ? " bad-text" : ""}`, text: n ? fmtMoney(n) : "" });
  body.replaceChildren(
    h("p", { class: "muted", text: `What each company owes on issued invoices, by how far past due, as of ${dateText(data.asOf)}.` }),
    data.companies.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["Company", "Invoices", ...cols.map(([, t]) => t)].map((t) => h("th", { text: t })))),
      h("tbody", {},
        data.companies.map((c) => {
          const row = h("tr", { class: "clickable" }, h("td", {}, h("strong", { text: c.companyName })), h("td", { class: "small-text", text: String(c.invoices) }), cols.map(([k]) => cell(c[k], k)));
          row.addEventListener("click", () => {
            $("invoices-search").value = c.companyName;
            $("invoices-state").value = "unpaid";
            $("invoices-period").value = "";
            location.hash = "#invoices";
          });
          return row;
        }),
        h("tr", { class: "total-row" }, h("td", {}, h("strong", { text: "Total" })), h("td", {}), cols.map(([k]) => cell(data.totals[k], k)))))) : h("div", { class: "placeholder", text: "Nobody owes anything." }));
}

// --- payments ----------------------------------------------------------------------------------------------

$("payments-from").addEventListener("change", () => loadPayments());
$("payments-to").addEventListener("change", () => loadPayments());

function showPayments() {
  if (!$("payments-from").value) $("payments-from").value = `${localToday().slice(0, 4)}-01-01`;
  loadPayments();
}

async function loadPayments() {
  const table = $("payments-table");
  const head = ["Received", "Company", "Invoice", "Amount", "Method", "Reference", ""];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  let payments;
  try {
    ({ payments } = await api(`/api/payments?${new URLSearchParams({ ...($("payments-from").value ? { from: $("payments-from").value } : {}), ...($("payments-to").value ? { to: $("payments-to").value } : {}) })}`));
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  $("payments-total").textContent = payments.length ? `${payments.length} payment${payments.length === 1 ? "" : "s"}, ${fmtMoney(payments.reduce((n, p) => n + p.amount, 0))}.` : "";
  if (!payments.length) {
    clear(table.tBodies[0]).append(emptyRow(head.length, "No payments between those dates."));
    return;
  }
  clear(table.tBodies[0]).append(...payments.map((p) => {
    const row = h("tr", { class: "clickable" },
      h("td", { class: "nowrap small-text", text: dateText(p.date) }),
      h("td", { text: p.companyName }),
      h("td", { class: "mono small-text", text: p.invoiceNumber }),
      h("td", { class: "nowrap", text: fmtMoney(p.amount) }),
      h("td", { class: "small-text", text: p.method }),
      h("td", { class: "small-text", text: p.reference || "" }),
      h("td", { class: "muted small-text", text: p.source === "quickbooks" ? "From QuickBooks" : "" }));
    row.addEventListener("click", () => { location.hash = `#invoice/${p.invoiceId}`; });
    return row;
  }));
}

// --- billing settings and QuickBooks ---------------------------------------------------------------------------

async function showFinanceSettings() {
  const body = $("finance-settings-body");
  // Back from connecting QuickBooks: say how it went, and tidy the address.
  const back = new URLSearchParams(location.hash.split("?")[1] || "");
  if (back.get("qbo") === "connected") toast("QuickBooks is connected.");
  if (back.get("qbo_error")) toast(back.get("qbo_error"), "error");
  if (back.toString()) history.replaceState(null, "", "#finance-settings");
  let s;
  let qbo;
  try {
    [{ settings: s }, qbo] = await Promise.all([api("/api/finance/settings"), api("/api/quickbooks")]);
  } catch (error) {
    body.replaceChildren(h("p", { class: "message error", text: error.message }));
    return;
  }
  const q = qbo.quickbooks;
  const saveSettings = async (patch) => {
    try {
      await api("/api/finance/settings", { method: "PUT", body: patch });
      toast("Saved.");
      showFinanceSettings();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  const field = (label, input, hint = null, half = false) => h("label", { class: half ? "half" : null }, h("span", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
  const text = (value, attrs = {}) => {
    const el = h("input", { type: "text", ...attrs });
    el.value = value ?? "";
    return el;
  };
  const area = (value) => {
    const el = h("textarea", { rows: 3 });
    el.value = value ?? "";
    return el;
  };

  // What invoices say.
  const issuerName = text(s.issuerName, { placeholder: state.config.branding?.name || "" });
  const issuerAddress = area(s.issuerAddress);
  const remitTo = area(s.remitTo);
  const footer = area(s.footer);
  const termsDays = text(s.termsDays, { type: "number", min: 0, max: 365 });
  const prefix = text(s.invoicePrefix);
  const nextNumber = text(s.nextNumber, { type: "number", min: 1 });
  const invoicePanel = h("div", { class: "panel" },
    h("h3", { text: "Invoices" }),
    h("div", { class: "form-grid stack" },
      field("Billed by", issuerName, "Your company's name at the top of each invoice; empty for the app's name."),
      field("Payment terms (days)", termsDays, "Invoices are due this many days after their date.", true),
      field("Your address", issuerAddress),
      field("Remit payment to", remitTo, "Where tenants send payment: an address, or bank details."),
      field("Invoice numbers start with", prefix, null, true),
      field("Next invoice number", nextNumber, "Issued invoices are numbered in order from here.", true),
      field("Footer", footer, "Printed at the bottom of every invoice.")),
    h("div", { class: "btn-row" }, h("button", { type: "button", class: "primary", text: "Save", onclick: () => saveSettings({
      issuerName: issuerName.value, issuerAddress: issuerAddress.value, remitTo: remitTo.value, footer: footer.value, termsDays: termsDays.value, invoicePrefix: prefix.value, nextNumber: nextNumber.value
    }) })));

  // QuickBooks names: accounts and items, for exports and the connection.
  const QB_FIELDS = [
    ["arAccount", "Accounts receivable account"], ["rentAccount", "Rent income account"], ["rentItem", "Rent item"],
    ["chargeAccount", "Charges income account"], ["otherItem", "Item for one-off lines"], ["depositAccount", "Payments go into"]
  ];
  const qbInputs = Object.fromEntries(QB_FIELDS.map(([k]) => [k, text(s.qb[k])]));
  const namesPanel = h("div", { class: "panel" },
    h("h3", { text: "QuickBooks names" }),
    h("p", { class: "muted", text: "The accounts and items invoices and payments use in QuickBooks, in exports and when connected. Price-list items keep their own names as items; they and one-off lines go to the charges income account." }),
    h("div", { class: "form-grid stack" }, QB_FIELDS.map(([k, label]) => h("label", { class: "half" }, h("span", { text: label }), qbInputs[k]))),
    h("div", { class: "btn-row" }, h("button", { type: "button", class: "primary", text: "Save", onclick: () => saveSettings({ qb: Object.fromEntries(QB_FIELDS.map(([k]) => [k, qbInputs[k].value])) }) })));

  // The QuickBooks Online connection.
  const env = h("select", {}, h("option", { value: "production", text: "Production (your real company)" }), h("option", { value: "sandbox", text: "Sandbox (Intuit's test company)" }));
  env.value = q.environment;
  const clientId = text(q.clientId, { autocomplete: "off" });
  const clientSecret = text("", { type: "password", autocomplete: "new-password", placeholder: q.hasSecret ? "Saved; type to replace" : "" });
  const run = (label, fn, kind = "secondary") => {
    const b = h("button", { type: "button", class: kind, text: label });
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };
  const last = q.lastSyncResult;
  const qboPanel = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "QuickBooks Online" }), h("span", { class: `badge ${q.connected ? "ok" : "muted"}`, text: q.connected ? `Connected${q.companyName ? ` to ${q.companyName}` : ""}` : "Not connected" })),
    h("p", { class: "muted", text: "Optional. Sends issued invoices (with their customers and items) and payments recorded here to QuickBooks Online, and brings back payments made there. Make an app at developer.intuit.com (Accounting scope), add the redirect URI below to it, and enter its keys here." }),
    h("div", { class: "form-grid stack" },
      field("Environment", env),
      field("Client ID", clientId),
      field("Client secret", clientSecret, "Kept on the server, never shown again."),
      h("div", { class: "readonly-field full-row" }, h("span", { class: "label", text: "Redirect URI (add it to the app)" }), h("div", { class: "mono small-text", text: qbo.redirectUri }),
        h("span", { class: "hint", text: `${qbo.appUrlSet ? "" : "Taken from this address; set APP_URL if people reach the app by another. "}Intuit requires https:// for a production company.` }))),
    h("div", { class: "btn-row" },
      run("Save", async () => {
        await api("/api/quickbooks", { method: "PUT", body: { environment: env.value, clientId: clientId.value, ...(clientSecret.value ? { clientSecret: clientSecret.value } : {}) } });
        toast("Saved.");
        showFinanceSettings();
      }, "secondary"),
      q.configured && !q.connected ? run("Connect to QuickBooks", async () => {
        const { url } = await api("/api/quickbooks/connect", { method: "POST" });
        location.href = url;
      }, "primary") : null,
      q.connected ? run("Sync now", async () => {
        const { result } = await api("/api/quickbooks/sync", { method: "POST" });
        toast(`Sent ${result.invoicesSent} invoice${result.invoicesSent === 1 ? "" : "s"} and ${result.paymentsSent} payment${result.paymentsSent === 1 ? "" : "s"}; ${result.paymentsReceived} payment${result.paymentsReceived === 1 ? "" : "s"} came back.${result.problems.length ? ` ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}: see below.` : ""}`, result.problems.length ? "error" : undefined);
        showFinanceSettings();
      }, "primary") : null,
      q.connected ? run("Disconnect", async () => {
        if (!(await confirmDialog("Disconnect QuickBooks? Nothing more is sent or brought back until it is connected again; what is there stays.", { confirmLabel: "Disconnect", danger: true }))) return;
        await api("/api/quickbooks/disconnect", { method: "POST" });
        toast("Disconnected.");
        showFinanceSettings();
      }, "danger") : null),
    q.connected ? h("p", { class: "muted small-text", text: `Connected ${fmtDateTime(q.connectedAt)}${q.connectedBy ? ` by ${q.connectedBy}` : ""}.${q.refreshExpiresAt ? ` Reconnect by ${fmtDate(q.refreshExpiresAt)} if it isn't used before then.` : ""}${q.lastSync ? ` Last synced ${fmtDateTime(q.lastSync)}.` : ""}` }) : "",
    last?.problems?.length ? h("div", { class: "message warn" }, h("strong", { text: "Last sync's problems:" }), h("ul", {}, last.problems.map((p) => h("li", { text: p })))) : "");

  const exportsPanel = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Exports" }), h("button", { type: "button", class: "secondary small", text: "Export for QuickBooks", onclick: () => exportDialog() })),
    h("p", { class: "muted", text: "Without the connection, export invoices and payments and import them: CSV into QuickBooks Online, IIF into QuickBooks Desktop." }));

  body.replaceChildren(invoicePanel, namesPanel, exportsPanel, qboPanel);
}
