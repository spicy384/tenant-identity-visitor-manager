// 09-visitors.js: the Visitors page, the visitor dialog (details, notes, the companies they
// visit, their visits), adding, checking, merging and blocking visitors.

const VISITORS_PAGE = 100;
const visitorsView = { offset: 0 };

const visitorName = (v) => `${v.firstName || ""} ${v.lastName || ""}`.trim();
const visitorField = (key) => (state.schema.visitor || []).find((f) => f.key === key);
const canEditVisitorLinks = () => visitorField("companies")?.access === "edit";

function visitorBadges(v) {
  return [
    v.verified === false ? h("span", { class: "badge warn", text: "To check" }) : null,
    v.blocked ? h("span", { class: "badge bad", text: "Blocked" }) : null,
    // In the list, only a validation under way or done; the dialog always shows it.
    v.clearanceStatus && v.clearanceStatus !== "unvalidated" ? clearanceTag(v) : null
  ];
}

async function loadVisitors() {
  const q = $("visitors-search").value.trim();
  const filter = $("visitors-filter").value;
  const table = $("visitors-table");
  const showOrg = Boolean(visitorField("organization"));
  const head = ["Name", ...(showOrg ? ["Company"] : []), "Visits", "Last visit"];
  let data;
  try {
    data = await api(`/api/visitors?${new URLSearchParams({ limit: String(VISITORS_PAGE), offset: String(visitorsView.offset), ...(q ? { q } : {}), ...(filter ? { filter } : {}) })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  visitorsView.visitors = data.visitors;
  visitorsView.empty = q || filter ? "Nobody matches." : "No visitors yet. They appear here when they check in at a kiosk, or add one.";
  drawVisitors();
  const from = data.total ? visitorsView.offset + 1 : 0;
  $("visitors-page").textContent = `${from}-${visitorsView.offset + data.visitors.length} of ${data.total}`;
  $("visitors-prev").disabled = visitorsView.offset === 0;
  $("visitors-next").disabled = visitorsView.offset + VISITORS_PAGE >= data.total;
}

/**
 * Draws the page of visitors already loaded. For the Security role each row has a tick box,
 * to validate several clearances at once (21-bulk.js).
 */
function drawVisitors() {
  const table = $("visitors-table");
  const list = visitorsView.visitors || [];
  const showOrg = Boolean(visitorField("organization"));
  const selection = isSecurity() ? visitorsSelection : null;
  const tick = (checked, label, onToggle) => {
    const box = h("input", { type: "checkbox", "aria-label": label });
    box.checked = checked;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => onToggle(box.checked));
    return box;
  };
  const head = ["Name", ...(showOrg ? ["Company"] : []), "Visits", "Last visit"];
  const all = selection && list.length > 0 && list.every((v) => selection.has(v.id));
  table.tHead.replaceChildren(h("tr", {},
    selection ? h("th", { class: "pick-cell" }, tick(all, "Choose everyone on this page", (on) => selection.set(list.map((v) => v.id), on))) : null,
    head.map((t) => h("th", { text: t }))));
  const rows = list.map((v) => {
    const row = h("tr", { class: `clickable${selection?.has(v.id) ? " is-picked" : ""}` },
      selection ? h("td", { class: "pick-cell", onclick: (e) => e.stopPropagation() }, tick(selection.has(v.id), `Choose ${visitorName(v)}`, (on) => selection.set([v.id], on))) : null,
      h("td", {}, h("strong", { text: visitorName(v) }), visitorBadges(v)),
      showOrg ? h("td", { text: v.organization || "" }) : null,
      h("td", { class: "small-text", text: (v.companies || []).map((c) => c.companyName).join(", ") }),
      h("td", { class: "small-text nowrap", text: v.lastVisitAt ? fmtDateTime(v.lastVisitAt) : "Never" }));
    row.addEventListener("click", () => { location.hash = `#visitor/${v.id}`; });
    return row;
  });
  clear(table.tBodies[0]).append(...(rows.length ? rows : [emptyRow(head.length + (selection ? 1 : 0), visitorsView.empty || "")]));
  renderVisitorActions();
}

const reloadVisitors = debounce(() => { visitorsView.offset = 0; loadVisitors(); }, 250);
$("visitors-search").addEventListener("input", reloadVisitors);
$("visitors-filter").addEventListener("change", reloadVisitors);
$("visitors-prev").addEventListener("click", () => { visitorsView.offset = Math.max(0, visitorsView.offset - VISITORS_PAGE); loadVisitors(); });
$("visitors-next").addEventListener("click", () => { visitorsView.offset += VISITORS_PAGE; loadVisitors(); });

$("visitors-add").addEventListener("click", async () => {
  const visitor = await newVisitorDialog();
  if (visitor) location.hash = `#visitor/${visitor.id}`;
});

// --- picking a company and host (shared with checking in from the desk) ------------------

/** Companies at `siteId` (or every site) the caller can see. */
async function companiesAt(siteId = "") {
  return (await api(`/api/companies?${new URLSearchParams({ limit: "2000", ...(siteId ? { site: String(siteId) } : {}) })}`)).companies;
}

/** People in a company who can host, for a host picker. */
async function hostsOf(companyId, siteId = "") {
  if (!companyId) return [];
  const { people } = await api(`/api/people?${new URLSearchParams({ companyId: String(companyId), limit: "1000", ...(siteId ? { site: String(siteId) } : {}) })}`);
  return people.filter((p) => p.canHost !== false);
}

/** formDialog fields for a company and a host whose list follows the company. */
function companyHostFields(companies, { companyId = "", hostId = "", siteId = "" } = {}) {
  return [
    { name: "companyId", label: "Visiting", type: "select", required: true, value: String(companyId || ""), half: true,
      options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))],
      onChange: async (input, inputs) => {
        const host = inputs.hostId;
        const before = host.value;
        const hosts = await hostsOf(input.value, siteId).catch(() => []);
        clear(host).append(h("option", { value: "", text: input.value ? "Not given" : "Choose a company first" }), ...hosts.map((p) => h("option", { value: String(p.id), text: personName(p) })));
        host.value = hosts.some((p) => String(p.id) === String(before)) ? String(before) : "";
      } },
    { name: "hostId", label: "Host", type: "select", value: String(hostId || ""), half: true, options: [{ value: String(hostId || ""), label: "…" }] }
  ];
}

// --- adding and editing ----------------------------------------------------------------------

/** Adds a visitor from the desk; resolves to the new visitor or null. */
async function newVisitorDialog({ firstName = "", lastName = "" } = {}) {
  const form = recordForm(state.schema.visitor, null);
  const linkFields = canEditVisitorLinks() ? companyHostFields(await companiesAt()) : [];
  if (linkFields.length) linkFields[0].required = Boolean(state.config.access.sitesLimited);
  const fieldsWithNames = form.fields.map((f) => (f.name === "firstName" ? { ...f, value: firstName } : f.name === "lastName" ? { ...f, value: lastName } : f));
  const visitor = await formDialog({
    title: "Add visitor",
    wide: true,
    fields: [...fieldsWithNames, ...(linkFields.length ? [{ type: "heading", label: "Who they visit" }, ...linkFields] : [])],
    submitLabel: "Add visitor",
    onSubmit: async (v) => {
      const body = form.collect(v);
      if (v.companyId) body.links = [{ companyId: Number(v.companyId), hostId: v.hostId ? Number(v.hostId) : null }];
      return (await api("/api/visitors", { method: "POST", body })).visitor;
    }
  });
  if (visitor) {
    toast(`Added ${visitorName(visitor)}.`);
    refreshCounts();
  }
  return visitor;
}

async function editVisitor(visitor, fields) {
  const form = recordForm(fields, visitor);
  const saved = await formDialog({
    title: `Edit ${visitorName(visitor)}`,
    wide: true,
    fields: form.fields,
    onSubmit: async (v) => {
      const body = form.collect(v);
      if (!Object.keys(body).length) return visitor;
      return (await api(`/api/visitors/${visitor.id}`, { method: "PUT", body })).visitor;
    }
  });
  if (saved) toast("Saved.");
  return saved;
}

async function addVisitorLink(visitor) {
  const done = await formDialog({
    title: `A company ${visitor.firstName} visits`,
    fields: companyHostFields(await companiesAt()),
    submitLabel: "Save",
    onSubmit: async (v) => api(`/api/visitors/${visitor.id}/links`, { method: "POST", body: { companyId: Number(v.companyId), hostId: v.hostId ? Number(v.hostId) : null } })
  });
  return Boolean(done);
}

async function mergeVisitor(visitor) {
  const results = h("div", { class: "choices-list" });
  let target = null;
  const search = h("input", { type: "search", placeholder: "Search for the visitor to keep" });
  const run = debounce(async () => {
    const q = search.value.trim();
    clear(results);
    if (q.length < 2) return;
    const { visitors } = await api(`/api/visitors?${new URLSearchParams({ q, limit: "20" })}`);
    for (const v of visitors.filter((x) => x.id !== visitor.id)) {
      const b = h("button", { type: "button", class: "pick-row" }, h("strong", { text: visitorName(v) }), " ", h("span", { class: "muted small-text", text: [v.organization, (v.companies || []).map((c) => c.companyName).join(", "), v.lastVisitAt ? `last visit ${fmtDate(v.lastVisitAt)}` : null].filter(Boolean).join(" · ") }));
      b.addEventListener("click", () => {
        target = v;
        for (const x of results.children) x.classList.toggle("is-active", x === b);
      });
      results.append(b);
    }
    if (!results.children.length) results.append(h("p", { class: "muted", text: "Nobody else matches." }));
  }, 250);
  search.addEventListener("input", run);
  search.value = visitor.lastName;
  run();
  const merged = await openDialog({
    title: `Merge ${visitorName(visitor)} into another visitor`,
    wide: true,
    body: h("div", { class: "stack" },
      h("p", { class: "muted", text: "Use this when the same person was registered twice. Their visits and companies move to the visitor you choose, and this record is removed." }),
      search, results),
    actions: [{ label: "Cancel", value: null }, { label: "Merge", kind: "primary", onClick: async () => {
      if (!target) throw new Error("Choose the visitor to keep.");
      await api(`/api/visitors/${visitor.id}/merge`, { method: "POST", body: { intoId: target.id } });
      return target.id;
    } }]
  });
  if (merged) toast(`Merged into ${visitorName(target)}.`);
  return merged;
}

// --- the visitor dialog ---------------------------------------------------------------------------

/**
 * The visitor badge kept for a regular visitor: handed to them at each check-in, back in stock
 * when they leave, still theirs. Those who give badges out reserve and release it.
 */
function reservedBadgeSection(visitor, refresh) {
  if (!canReadBadges() || visitor.reservedBadge === undefined) return null;
  const may = canGiveBadges() && canEditVisitors();
  const reserve = async () => {
    const badge = await formDialog({
      title: `Reserve a badge for ${visitorName(visitor)}`,
      intro: h("p", { class: "muted", text: "Check-in tells the front desk to hand them this badge each time. It goes back into stock when they leave, and stays theirs." }),
      fields: [
        { ...facilityCodeField(visitor.reservedBadge?.facilityCode), hint: "Needed when another visitor badge has the same number." },
        { name: "number", label: "Visitor badge number", required: true, half: true, autofocus: true, value: visitor.reservedBadge?.number || "" }
      ],
      submitLabel: "Reserve",
      onSubmit: async (v) => {
        const typed = v.number.trim().toLowerCase();
        const code = v.facilityCode.trim();
        const { badges } = await api(`/api/badges?${new URLSearchParams({ q: v.number.trim(), type: "visitor", limit: "200" })}`);
        const found = badges.filter((b) => b.number.toLowerCase() === typed && (!code || b.facilityCode === code));
        if (!found.length) throw new Error(`There's no visitor badge ${code ? `${code}-` : ""}${v.number.trim()}.`);
        if (found.length > 1) throw new Error(`More than one visitor badge is numbered ${v.number.trim()}: ${found.map((b) => b.label).join(", ")}. Enter its facility code too.`);
        return (await api(`/api/visitors/${visitor.id}/reserved-badge`, { method: "PUT", body: { badgeId: found[0].id } })).reservedBadge;
      }
    });
    if (badge) {
      toast(`Badge ${badge.label} reserved for ${visitorName(visitor)}.`);
      refresh();
    }
  };
  const release = async () => {
    if (!(await confirmDialog(`Stop keeping badge ${visitor.reservedBadge.label} for ${visitorName(visitor)}?`, { confirmLabel: "Release" }))) return;
    try {
      await api(`/api/visitors/${visitor.id}/reserved-badge`, { method: "PUT", body: { badgeId: null } });
      refresh();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  return h("div", { class: "stack" },
    h("h4", { text: "Reserved badge" }),
    visitor.reservedBadge
      ? h("p", { class: "row-between" }, h("span", {}, h("a", { href: `#badge/${visitor.reservedBadge.id}`, class: "mono", text: visitor.reservedBadge.label }), h("span", { class: "muted small-text", text: " · handed to them at each check-in" })),
        may ? h("span", { class: "btn-row" }, h("button", { type: "button", class: "link-btn", text: "Change", onclick: reserve }), h("button", { type: "button", class: "link-btn danger-text", text: "Release", onclick: release })) : null)
      : h("p", { class: "row-between" }, h("span", { class: "muted", text: "None. A regular visitor can have a visitor badge kept for them." }),
        may ? h("button", { type: "button", class: "secondary small", text: "Reserve a badge", onclick: reserve }) : null));
}

/** The visitor's notes, shown even when there are none, and changed in place by those who may. */
function visitorNotesSection(visitor, refresh) {
  const field = visitorField("notes");
  if (!field) return null;
  const may = field.access === "edit" && canEditVisitors();
  const edit = async () => {
    const saved = await formDialog({
      title: `Notes on ${visitorName(visitor)}`,
      fields: [{ name: "notes", label: "Notes", type: "textarea", rows: 6, value: visitor.notes || "", autofocus: true }],
      submitLabel: "Save",
      onSubmit: async (v) => (await api(`/api/visitors/${visitor.id}`, { method: "PUT", body: { notes: v.notes } })).visitor
    });
    if (saved) refresh();
  };
  return h("div", { class: "stack" },
    h("div", { class: "row-between" }, h("h4", { text: "Notes" }),
      may ? h("button", { type: "button", class: "link-btn", text: visitor.notes ? "Edit notes" : "Add notes", onclick: edit }) : null),
    visitor.notes ? h("p", { class: "pre", text: visitor.notes }) : h("p", { class: "muted", text: "None." }));
}

async function openVisitor(id, onChange = () => {}) {
  let data;
  try {
    data = await api(`/api/visitors/${id}`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  const { visitor, fields, visits, visitCount } = data;
  const editable = canEditVisitors();
  const linksBlock = h("div", { class: "stack" },
    h("h4", { text: "Companies they visit" }),
    (visitor.companies || []).length
      ? h("ul", { class: "plain-list" }, visitor.companies.map((c) => h("li", { class: "row-between" },
        h("span", {}, h("strong", { text: c.companyName }), h("span", { class: "muted", text: c.hostName ? ` · usual host ${c.hostName}` : " · no usual host" })),
        editable && canEditVisitorLinks() ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
          await api(`/api/visitors/${visitor.id}/links/${c.companyId}`, { method: "DELETE" });
          dlgRef?.finish("refresh");
        } }) : null)))
      : h("p", { class: "muted", text: "None yet." }),
    editable && canEditVisitorLinks() ? h("button", { type: "button", class: "secondary small", text: "Add a company", onclick: async () => { if (await addVisitorLink(visitor)) dlgRef?.finish("refresh"); } }) : null);
  const visitsBlock = h("div", { class: "stack" },
    h("h4", { text: `Visits${visitCount > visits.length ? ` (latest ${visits.length} of ${visitCount})` : ` (${visitCount})`}` }),
    visitsTable(visits, { showVisitor: false }));
  let dlgRef = null;
  const body = h("div", { class: "detail" },
    h("p", {}, visitorBadges({ ...visitor, clearanceStatus: undefined }), visitor.source === "kiosk" && visitor.verified === false ? h("span", { class: "muted small-text", text: " Registered themselves at a kiosk. Check the details, merge them with an existing visitor, or mark them checked." }) : null),
    recordFacts(fields, visitor, ["firstName", "lastName", "companies", "verified", "blocked", "notes", ...CLEARANCE_KEYS]),
    visitorNotesSection(visitor, () => dlgRef?.finish("refresh")),
    clearanceSection("visitor", visitor, () => dlgRef?.finish("refresh")),
    linksBlock,
    reservedBadgeSection(visitor, () => dlgRef?.finish("refresh")),
    badgeSection("visitor", visitor.id),
    visitsBlock);
  const actions = [];
  if (isAdmin()) actions.push({ label: "Delete", kind: "danger", value: "delete" });
  if (editable) {
    actions.push({ label: "Merge…", value: "merge" });
    actions.push({ label: visitor.blocked ? "Unblock" : "Block", value: "block" });
    if (visitor.verified === false) actions.push({ label: "Mark checked", value: "verify" });
    actions.push({ label: "Edit", value: "edit" });
    actions.push({ label: "Check in", value: "checkin" });
  }
  actions.push({ label: "Close", kind: "primary", value: null });
  const result = await openDialog({ title: visitorName(visitor), body, wide: true, actions, onOpen: (d) => { dlgRef = d; } });
  const again = () => openVisitor(id, onChange);
  try {
    if (result === "refresh") { onChange(); return again(); }
    if (result === "edit") {
      if (await editVisitor(visitor, fields)) onChange();
      return again();
    }
    if (result === "verify" || result === "block") {
      if (result === "block" && !visitor.blocked && !(await confirmDialog(`Block ${visitorName(visitor)}? The kiosk will send them to reception instead of checking them in.`, { confirmLabel: "Block", danger: true }))) return again();
      await api(`/api/visitors/${visitor.id}`, { method: "PUT", body: result === "verify" ? { verified: true } : { blocked: !visitor.blocked } });
      toast(result === "verify" ? "Marked as checked." : visitor.blocked ? "Unblocked." : "Blocked.");
      onChange();
      refreshCounts();
      return again();
    }
    if (result === "merge") {
      const into = await mergeVisitor(visitor);
      if (!into) return again();
      onChange();
      refreshCounts();
      location.hash = `#visitor/${into}`;
      return;
    }
    if (result === "checkin") {
      if (await checkInWizard({ visitor })) onChange();
      return again();
    }
    if (result === "delete") {
      if (!(await confirmDialog(`Delete ${visitorName(visitor)} and all ${visitCount} of their visits? This can't be undone.`, { danger: true, confirmLabel: "Delete" }))) return again();
      await api(`/api/visitors/${visitor.id}`, { method: "DELETE" });
      toast(`Deleted ${visitorName(visitor)}.`);
      onChange();
      refreshCounts();
    }
  } catch (error) {
    toast(error.message, "error");
    return again();
  }
  if (location.hash.startsWith("#visitor/")) history.back();
}

function showVisitors() {
  loadVisitors();
}
