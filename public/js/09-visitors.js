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

/** A badge's image for the top of a record (null when its kind has no image yet). */
const calloutImage = (ref, label) => (ref ? h("img", { class: "reserved-badge-img", src: `/api/badge-templates/${encodeURIComponent(ref)}/image`, alt: `What badge ${label} looks like`, loading: "lazy" }) : null);

/**
 * Reserving and releasing the visitor badges kept for a visitor, for those who give badges out.
 * A visitor may have several, and a badge may be kept for several visitors. Returns
 * { may, reserve(), release(badge) }; each draws the record again when done.
 */
function reservedBadgeActions(visitor, refresh) {
  const reserve = async () => {
    const done = await formDialog({
      title: `Reserve a badge for ${visitorName(visitor)}`,
      intro: h("p", { class: "muted full-row", text: "Check-in tells the front desk to hand them this badge. It goes back into stock when they leave, and stays theirs. They can have several kept for them, and one badge can be kept for several visitors (a badge that opens more doors, say): whoever arrives is handed it when it is free." }),
      fields: [
        { ...facilityCodeField(), hint: "Needed when another badge has the same number." },
        { name: "number", label: "Visitor badge number", required: true, half: true, autofocus: true }
      ],
      submitLabel: "Reserve",
      onSubmit: (v) => api(`/api/visitors/${visitor.id}/reserved-badges`, { method: "POST", body: { number: v.number.trim(), facilityCode: v.facilityCode.trim() || undefined } })
    });
    if (done) {
      toast(`Badge ${done.badge.label} reserved for ${visitorName(visitor)}.`);
      refresh();
    }
  };
  const release = async (b) => {
    const others = b.sharedWith?.length ? ` It stays reserved for ${b.sharedWith.join(", ")}.` : "";
    if (!(await confirmDialog(`Stop keeping badge ${b.label} for ${visitorName(visitor)}?${others}`, { confirmLabel: "Release" }))) return;
    try {
      await api(`/api/visitors/${visitor.id}/reserved-badges/${b.id}`, { method: "DELETE" });
      refresh();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  return { may: canGiveBadges() && canEditVisitors(), reserve, release };
}

/**
 * The top of a visitor's record: the badge (or badges) they have now, then those kept for them
 * that they don't have, each large with its image, so none is missed. holders: what
 * /api/badge-holders says of them ({ current, reserved }). Null with neither.
 */
function visitorBadgeCallouts(visitor, holders, refresh) {
  const { may, release } = reservedBadgeActions(visitor, refresh);
  const kept = new Set(holders.reserved.map((b) => b.id));
  const several = holders.reserved.length > 1;
  const box = (assigned, label, image, number, notes, buttons) => h("div", { class: `reserved-badge${assigned ? " assigned-badge" : ""}`, role: "group", "aria-label": label },
    image, h("div", { class: "reserved-badge-main" }, h("h4", { class: "reserved-badge-label", text: label }), number, notes), buttons);
  const number = (id, label) => h("a", { href: `#badge/${id}`, class: "reserved-badge-number mono", text: label });
  const note = (text, cls = "") => h("p", { class: `reserved-badge-note${cls ? ` ${cls}` : ""}`, text });
  const has = holders.current.map((a) => box(true, "Badge assigned now", calloutImage(a.template, a.badgeLabel), number(a.badgeId, a.badgeLabel),
    [note(`${visitor.firstName} has it, since ${fmtDateTime(a.assignedAt)}${a.assignedBy ? ` (given by ${a.assignedBy})` : ""}.${kept.has(a.badgeId) ? " It is a badge reserved for them." : ""}`)],
    canEditBadges() ? h("div", { class: "btn-row" },
      h("button", { type: "button", class: "secondary small", text: "Take back", onclick: async () => { if (await takeBackBadge(a.badgeId, a.badgeLabel, a.holderName)) refresh(); } }),
      h("button", { type: "button", class: "link-btn danger-text", text: "Lost", onclick: async () => { if (await takeBackBadge(a.badgeId, a.badgeLabel, a.holderName, "lost")) refresh(); } })) : null));
  const waiting = holders.reserved.filter((b) => !b.holder?.theirs).map((b) => box(false, "Reserved badge", calloutImage(b.template, b.label), number(b.id, b.label), [
    note(several ? `Kept for ${visitor.firstName}. Check-in hands them the first of their reserved badges that is free.` : `Kept for ${visitor.firstName}. Hand them this badge at each check-in.`),
    b.sharedWith.length ? note(`Also kept for ${b.sharedWith.join(", ")}.`) : null,
    // Given to someone else while they were away: said here, as check-in will ask for another.
    b.holder ? note(`It is with ${b.holder.name} now.${several ? "" : ` If ${visitor.firstName} arrives before it is back, check-in asks for another badge.`}`, "reserved-badge-out") : null
  ].filter(Boolean), may ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "link-btn danger-text", text: "Release", onclick: () => release(b) })) : null));
  const all = [...has, ...waiting];
  return all.length ? h("div", { class: "badge-callouts" }, all) : null;
}

/**
 * The visitor badges kept for a visitor, as a list: where each is now, with Release, and the
 * button to reserve one (or another). Those who give badges out reserve and release them.
 */
function reservedBadgeSection(visitor, holders, refresh) {
  if (!canReadBadges() || !holders) return null;
  const { may, reserve, release } = reservedBadgeActions(visitor, refresh);
  const list = holders.reserved;
  const where = (b) => [b.holder?.theirs ? "they have it now" : b.holder ? `with ${b.holder.name} now` : "in stock", b.sharedWith.length ? `also kept for ${b.sharedWith.join(", ")}` : null].filter(Boolean).join(" · ");
  return h("div", { class: "stack" },
    h("div", { class: "row-between" }, h("h4", { text: list.length > 1 ? `Reserved badges (${list.length})` : "Reserved badge" }),
      may ? h("button", { type: "button", class: "secondary small", text: list.length ? "Reserve another badge" : "Reserve a badge", onclick: reserve }) : null),
    list.length
      ? h("ul", { class: "plain-list" }, list.map((b) => h("li", { class: "row-between" },
        h("span", {}, h("a", { href: `#badge/${b.id}`, class: "mono", text: b.label }), h("span", { class: "muted", text: ` · ${where(b)}` })),
        may ? h("button", { type: "button", class: "link-btn danger-text", text: "Release", onclick: () => release(b) }) : null)))
      : h("p", { class: "muted", text: "None. A regular visitor can have visitor badges kept for them." }));
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
  // The badges they have now and those kept for them, for those who see badges: shown large at the top.
  let holders = null;
  if (canReadBadges()) {
    try {
      holders = await api(`/api/badge-holders/visitor/${visitor.id}`);
    } catch {
      // The Badges section below says what went wrong.
    }
  }
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
    visitsTable(visits, { showVisitor: false, onChange: () => dlgRef?.finish("refresh") }));
  let dlgRef = null;
  // The badge they have now goes first, large, then those reserved for them that they don't
  // have. Further down, the list of what is kept for them, where one is reserved or released.
  const redraw = () => dlgRef?.finish("refresh");
  const body = h("div", { class: "detail" },
    h("p", {}, visitorBadges({ ...visitor, clearanceStatus: undefined }), visitor.source === "kiosk" && visitor.verified === false ? h("span", { class: "muted small-text", text: " Registered themselves at a kiosk. Check the details, merge them with an existing visitor, or mark them checked." }) : null),
    holders ? visitorBadgeCallouts(visitor, holders, redraw) : null,
    recordFacts(fields, visitor, ["firstName", "lastName", "companies", "verified", "blocked", "notes", ...CLEARANCE_KEYS]),
    visitorNotesSection(visitor, () => dlgRef?.finish("refresh")),
    clearanceSection("visitor", visitor, () => dlgRef?.finish("refresh")),
    linksBlock,
    reservedBadgeSection(visitor, holders, redraw),
    badgeSection("visitor", visitor.id, { onChange: redraw, showCurrent: !holders?.current.length }),
    visitsBlock);
  // Their visits not yet ended (one, unless they're at two sites at once).
  const here = visits.filter((v) => !v.checkedOutAt);
  // Checking them in (or out) is the main button; Merge, Block and Delete wait under More.
  const actions = [];
  if (editable) {
    actions.push({ label: "Merge…", value: "merge", more: true });
    actions.push({ label: visitor.blocked ? "Unblock" : "Block", value: "block", more: true });
  }
  if (isAdmin()) actions.push({ label: "Delete", kind: "danger", value: "delete", more: true });
  actions.push({ label: "Close", kind: editable ? "secondary" : "primary", value: null });
  if (editable) {
    if (visitor.verified === false) actions.push({ label: "Mark checked", value: "verify" });
    actions.push({ label: "Edit", value: "edit" });
    // Here now: Check out instead of Check in.
    actions.push(here.length ? { label: "Check out", kind: "primary", value: "checkout" } : { label: "Check in", kind: "primary", value: "checkin" });
  }
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
    if (result === "checkout") {
      for (const v of here) if (!(await checkOutVisit(v, visitorName(visitor)))) break;
      onChange();
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
