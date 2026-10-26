// 16-expected.js: the Expected page (a day's visitor events and whether each guest has
// arrived), and adding events and their guests.

const GUEST_STATUS = {
  expected: (g) => h("span", { class: "badge muted", text: "Expected" }),
  here: (g) => (g.checkinStage
    ? h("span", { class: "badge warn", text: g.checkinStage === "id" ? "Arrived: check their ID" : "Arrived: needs a badge" })
    : h("span", { class: "badge ok", text: `Here since ${new Date(g.arrivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` })),
  left: (g) => h("span", { class: "badge", text: `Left ${new Date(g.leftAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` })
};

function expectedDay() {
  if (!$("expected-date").value) $("expected-date").value = localToday();
  return $("expected-date").value;
}

function shiftDay(days) {
  const d = new Date(`${expectedDay()}T12:00:00`);
  d.setDate(d.getDate() + days);
  $("expected-date").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  loadExpected();
}

$("expected-date").addEventListener("change", () => loadExpected());
$("expected-prev").addEventListener("click", () => shiftDay(-1));
$("expected-next").addEventListener("click", () => shiftDay(1));
$("expected-today").addEventListener("click", () => { $("expected-date").value = localToday(); loadExpected(); });
$("expected-add").addEventListener("click", async () => {
  const event = await editEvent(null);
  if (event) {
    $("expected-date").value = event.date;
    loadExpected();
  }
});

async function loadExpected() {
  const list = clear($("expected-list"));
  const date = expectedDay();
  let data;
  try {
    data = await api(`/api/events?${new URLSearchParams({ date, ...siteQuery() })}`);
  } catch (error) {
    list.append(h("p", { class: "message error", text: error.message }));
    return;
  }
  if (!data.events.length) {
    list.append(h("div", { class: "placeholder", text: `No visitor events on ${fmtDate(Date.parse(`${date}T12:00:00`))}${canEditVisitors() ? ". Add one with New event." : "."}` }));
    return;
  }
  for (const e of data.events) list.append(eventPanel(e));
}

function eventPanel(e) {
  const when = [e.startTime, e.endTime].filter(Boolean).join("–");
  const counts = { expected: 0, here: 0, left: 0 };
  for (const g of e.guests) counts[g.status] += 1;
  const isToday = e.date === localToday();
  return h("div", { class: "panel" },
    h("div", { class: "panel-head" },
      h("div", {},
        h("h3", { text: e.title }),
        h("p", { class: "muted small-text", text: [when, multiSite() ? e.siteName : null, e.companyName ? `${e.companyName}${e.hostName ? `, host ${e.hostName}` : ""}` : null].filter(Boolean).join(" · ") })),
      canEditVisitors() ? h("div", { class: "btn-row" },
        h("button", { type: "button", class: "secondary small", text: "Add guest", onclick: async () => { if (await addGuestDialog(e)) loadExpected(); } }),
        h("button", { type: "button", class: "secondary small", text: "Edit", onclick: async () => { if (await editEvent(e)) loadExpected(); } }),
        h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: async () => {
          if (!(await confirmDialog(`Delete ${e.title}? Its guests stay on record as visitors.`, { danger: true, confirmLabel: "Delete" }))) return;
          await api(`/api/events/${e.id}`, { method: "DELETE" });
          loadExpected();
          refreshCounts();
        } })) : null),
    e.notes ? h("p", { class: "pre small-text", text: e.notes }) : null,
    h("p", { class: "small-text muted", text: `${e.guests.length} expected: ${counts.here} here, ${counts.left} left, ${counts.expected} not arrived yet.` }),
    e.guests.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Guest", "Company", "Status", ...(canReadBadges() ? ["Badge"] : []), ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, e.guests.map((g) => h("tr", {},
          h("td", {}, h("a", { href: `#visitor/${g.visitorId}`, text: `${g.firstName} ${g.lastName}` }), g.blocked ? h("span", { class: "badge bad", text: "Blocked" }) : null),
          h("td", { text: g.organisation || "" }),
          h("td", {}, GUEST_STATUS[g.status](g)),
          canReadBadges() ? h("td", {}, guestBadgeCell(e, g)) : null,
          h("td", {}, canEditVisitors() ? h("div", { class: "btn-row" },
            g.status === "expected" && isToday ? h("button", { type: "button", class: "primary small", text: "Check in", onclick: async () => {
              try {
                const visitor = (await api(`/api/visitors/${g.visitorId}`)).visitor;
                if (await checkInWizard({ visitor, event: e })) loadExpected();
              } catch (error) {
                toast(error.message, "error");
              }
            } }) : null,
            g.checkinStage ? h("button", { type: "button", class: "primary small", text: "Finish check-in", onclick: async () => { if (await continueCheckIn(g.visitId)) loadExpected(); } }) : null,
            g.status === "expected" ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
              await api(`/api/events/${e.id}/guests/${g.visitorId}`, { method: "DELETE" });
              loadExpected();
              refreshCounts();
            } }) : null) : null))))))
      : h("p", { class: "muted", text: "No guests yet." }));
}

/** The visitor badge picked ahead for an expected guest, and (for those who give badges) picking it. */
function guestBadgeCell(e, g) {
  const may = canGiveBadges() && canEditVisitors() && g.status === "expected";
  const pickBadge = async () => {
    const { badges } = await api(`/api/badges?${new URLSearchParams({ type: "visitor", state: "available", site: String(e.siteId), limit: "500" })}`).catch(() => ({ badges: [] }));
    const chosen = await formDialog({
      title: `Badge for ${g.firstName} ${g.lastName}`,
      intro: h("p", { class: "muted", text: "Check-in tells the front desk to hand them this badge when they arrive." }),
      fields: [{ name: "badgeId", label: "Visitor badge", type: "select", required: true, value: g.badge ? String(g.badge.id) : "",
        options: [{ value: "", label: badges.length ? "Choose a badge" : "No visitor badge is free here" }, ...badges.map((b) => ({ value: String(b.id), label: [b.label, badgeClassText(b)].filter(Boolean).join(" · ") }))] }],
      submitLabel: "Pick badge",
      onSubmit: (v) => api(`/api/events/${e.id}/guests/${g.visitorId}/badge`, { method: "PUT", body: { badgeId: Number(v.badgeId) } })
    });
    if (chosen) loadExpected();
  };
  const clearBadge = async () => {
    try {
      await api(`/api/events/${e.id}/guests/${g.visitorId}/badge`, { method: "PUT", body: { badgeId: null } });
      loadExpected();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  if (g.badge) {
    return h("span", { class: "btn-row" }, h("span", { class: "mono", text: g.badge.label }),
      may ? h("button", { type: "button", class: "link-btn", text: "Change", onclick: pickBadge }) : null,
      may ? h("button", { type: "button", class: "link-btn danger-text", text: "Clear", onclick: clearBadge }) : null);
  }
  return may ? h("button", { type: "button", class: "link-btn", text: "Pick badge", onclick: pickBadge }) : h("span", { class: "muted small-text", text: "—" });
}

/** The event form: site, name, date and times, company and host, notes. */
async function editEvent(event) {
  const usable = state.config.sites.filter((s) => s.active || s.id === event?.siteId);
  const siteId = String(event?.siteId || state.site || usable[0]?.id || "");
  const companies = await companiesAt(siteId);
  const fields = [
    ...(usable.length > 1 ? [{ name: "siteId", label: "Site", type: "select", value: siteId, options: usable.map((s) => ({ value: String(s.id), label: s.name })), hint: event ? null : "The company list follows the site after saving; pick the site first." }] : []),
    { name: "title", label: "Event", required: true, value: event?.title, placeholder: "Quarterly review, interviews, delivery…" },
    { name: "date", label: "Date", type: "date", required: true, value: event?.date || expectedDay(), half: true },
    { name: "startTime", label: "From", type: "time", value: event?.startTime || "", half: true },
    { name: "endTime", label: "Until", type: "time", value: event?.endTime || "", half: true },
    ...companyHostFields(companies, { companyId: event?.companyId || "", hostId: event?.hostId || "", siteId }).map((f) => ({ ...f, required: false, ...(f.name === "companyId" ? { options: [{ value: "", label: "No particular company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))] } : {}) })),
    { name: "notes", label: "Notes", type: "textarea", rows: 2, value: event?.notes }
  ];
  const saved = await formDialog({
    title: event ? `Edit ${event.title}` : "New visitor event",
    wide: true,
    fields,
    submitLabel: event ? "Save" : "Add event",
    onSubmit: async (v) => {
      const body = { title: v.title, date: v.date, startTime: v.startTime, endTime: v.endTime, companyId: v.companyId ? Number(v.companyId) : null, hostId: v.hostId ? Number(v.hostId) : null, notes: v.notes, siteId: Number(v.siteId || siteId) };
      return (event ? await api(`/api/events/${event.id}`, { method: "PUT", body }) : await api("/api/events", { method: "POST", body })).event;
    }
  });
  if (saved && !event) {
    toast(`Added ${saved.title}. Now add its guests.`);
    await addGuestDialog(saved);
    refreshCounts();
  }
  return saved;
}

/** Adds guests to an event: someone on record (search), or someone new. Resolves true if any were added. */
async function addGuestDialog(event) {
  let added = 0;
  const results = h("div", { class: "choices-list" });
  const message = h("p", { class: "message", hidden: true });
  const search = h("input", { type: "search", placeholder: "Search visitors on record", autocomplete: "off" });
  const say = (text, kind = "success") => { message.className = `message ${kind}`; message.textContent = text; message.hidden = false; };
  const add = async (body, name) => {
    try {
      await api(`/api/events/${event.id}/guests`, { method: "POST", body });
      added += 1;
      say(`${name} added. Add another, or close.`);
    } catch (error) {
      // A likely duplicate: say who is on record, and offer to add a new one anyway.
      if (error.status === 409 && body.visitor && !body.addAnyway && (await confirmDialog(`${error.message}`, { title: "Already on record?", confirmLabel: "Add a new visitor anyway" }))) {
        return add({ ...body, addAnyway: true }, name);
      }
      say(error.status === 409 && body.visitor ? "Not added. Search for them above to add the one on record." : error.message, "error");
    }
  };
  const run = debounce(async () => {
    const q = search.value.trim();
    clear(results);
    if (q.length < 2) return;
    const { visitors } = await api(`/api/visitors?${new URLSearchParams({ q, limit: "10" })}`);
    for (const v of visitors) {
      results.append(h("button", { type: "button", class: "pick-row", onclick: () => add({ visitorId: v.id }, visitorName(v)) },
        h("strong", { text: visitorName(v) }), " ", h("span", { class: "muted small-text", text: [v.organisation, (v.companies || []).map((c) => c.companyName).join(", ")].filter(Boolean).join(" · ") })));
    }
    if (!visitors.length) results.append(h("p", { class: "muted", text: "Nobody by that name on record; add them as new below." }));
  }, 250);
  search.addEventListener("input", run);
  const first = h("input", { placeholder: "First name", "aria-label": "First name" });
  const last = h("input", { placeholder: "Last name", "aria-label": "Last name" });
  const org = h("input", { placeholder: "Their organisation (optional)", "aria-label": "Their organisation" });
  const email = h("input", { type: "email", placeholder: "Email (optional)", "aria-label": "Email" });
  const addNew = h("button", { type: "button", class: "secondary", text: "Add as a new visitor", onclick: async () => {
    if (!first.value.trim() || !last.value.trim()) return say("Enter their first and last name.", "error");
    await add({ visitor: { firstName: first.value, lastName: last.value, organisation: org.value, email: email.value } }, `${first.value.trim()} ${last.value.trim()}`);
    if (message.className.includes("success")) for (const i of [first, last, org, email]) i.value = "";
  } });
  await openDialog({
    title: `Guests for ${event.title}`,
    wide: true,
    body: h("div", { class: "stack" },
      message,
      h("h4", { text: "On record" }), search, results,
      h("h4", { text: "Someone new" }),
      h("div", { class: "form-grid" }, first, last, org, email),
      addNew,
      h("p", { class: "muted small-text", text: "New guests are added as visitors, linked to the event's company and host, so the kiosk recognises them on the day." })),
    actions: [{ label: "Done", kind: "primary", value: true }],
    onOpen: () => setTimeout(() => search.focus(), 50)
  });
  if (added) refreshCounts();
  return added > 0;
}

function showExpected() {
  loadExpected();
}
