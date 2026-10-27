// 16-expected.js: the Expected page (a day's visitor events and whether each guest has
// arrived), and adding events and their guests.

const GUEST_STATUS = {
  expected: (g) => h("span", { class: "badge muted", text: "Expected" }),
  here: (g) => (g.checkinStage
    ? h("span", { class: "badge warn", text: g.checkinStage === "id" ? "Arrived: check their ID" : "Arrived: needs a badge" })
    : h("span", { class: "badge ok", text: `Here since ${new Date(g.arrivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` })),
  left: (g) => h("span", { class: "badge", text: `Left ${new Date(g.leftAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` })
};

const eventDay = (iso) => fmtDate(Date.parse(`${iso}T12:00:00`));

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
        h("p", { class: "muted small-text", text: [when, multiSite() ? e.siteName : null, e.companyName ? `${e.companyName}${e.hostName ? `, host ${e.hostName}` : ""}` : null].filter(Boolean).join(" · ") }),
        e.repeatText ? h("p", { class: "muted small-text", text: `Repeats ${repeatPhrase(e)}` }) : null),
      canEditVisitors() ? h("div", { class: "btn-row" },
        h("button", { type: "button", class: "secondary small", text: "Add guest", onclick: async () => {
          const scope = await seriesScope(e, { title: "Add guests", one: "To this date only", following: "To this and later dates" });
          if (scope && (await addGuestDialog(e, scope))) loadExpected();
        } }),
        h("button", { type: "button", class: "secondary small", text: "Edit", onclick: async () => {
          const scope = await seriesScope(e, { title: `Edit ${e.title}`, one: "This date only", following: "This and later dates" });
          if (scope && (await editEvent(e, scope))) loadExpected();
        } }),
        h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: async () => {
          const scope = e.seriesId
            ? await seriesScope(e, { title: `Cancel ${e.title}`, one: "Cancel this date only", following: "Cancel this and later dates", danger: true })
            : (await confirmDialog(`Delete ${e.title}? Its guests stay on record as visitors.`, { danger: true, confirmLabel: "Delete" })) && "one";
          if (!scope) return;
          const { count } = await api(`/api/events/${e.id}?scope=${scope}`, { method: "DELETE" });
          if (count > 1) toast(`Canceled ${count} dates.`);
          loadExpected();
          refreshCounts();
        } })) : null),
    eventNotes(e),
    h("p", { class: "small-text muted", text: `${e.guests.length} expected: ${counts.here} here, ${counts.left} left, ${counts.expected} not arrived yet.` }),
    e.guests.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Guest", "Company", "Status", ...(canReadBadges() ? ["Badge"] : []), ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, e.guests.map((g) => h("tr", {},
          h("td", {}, h("a", { href: `#visitor/${g.visitorId}`, text: `${g.firstName} ${g.lastName}` }), g.blocked ? h("span", { class: "badge bad", text: "Blocked" }) : null),
          h("td", { text: g.organization || "" }),
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
              const scope = await seriesScope(e, { title: `Remove ${g.firstName} ${g.lastName}`, one: "From this date only", following: "From this and later dates", danger: true });
              if (!scope) return;
              await api(`/api/events/${e.id}/guests/${g.visitorId}?scope=${scope}`, { method: "DELETE" });
              loadExpected();
              refreshCounts();
            } }) : null) : null))))))
      : h("p", { class: "muted", text: "No guests yet." }));
}

/** The visitor badge picked ahead for an expected guest, and (for those who give badges) picking it. */
function guestBadgeCell(e, g) {
  const may = canGiveBadges() && canEditVisitors() && g.status === "expected";
  const pickBadge = async () => {
    const free = { type: "visitor", state: "available", site: String(e.siteId) };
    const { total } = await api(`/api/badges?${new URLSearchParams({ ...free, limit: "1" })}`).catch(() => ({ total: 0 }));
    const search = h("input", { type: "search", placeholder: "Type the badge number", autocomplete: "off", inputmode: "numeric", "aria-label": "Badge number" });
    const results = h("div", { class: "choices-list short" });
    let dialog = null;
    const choose = async (b) => {
      try {
        await api(`/api/events/${e.id}/guests/${g.visitorId}/badge`, { method: "PUT", body: { badgeId: b.id } });
        dialog?.finish(true);
      } catch (error) {
        dialog?.showError(error.message);
      }
    };
    const run = debounce(async () => {
      const q = search.value.trim();
      if (!q) return results.replaceChildren();
      const { badges } = await api(`/api/badges?${new URLSearchParams({ ...free, q, limit: "10" })}`).catch(() => ({ badges: [] }));
      if (search.value.trim() !== q) return null; // typed on meanwhile: a newer search is coming
      // An exact number first, then the rest as the server sorts them.
      const exact = (b) => b.label === q || b.number === q;
      badges.sort((a, b) => exact(b) - exact(a));
      results.replaceChildren(...(badges.length
        ? badges.map((b) => h("button", { type: "button", class: "pick-row", onclick: () => choose(b) },
          h("strong", { class: "mono", text: b.label }), " ", h("span", { class: "muted small-text", text: badgeClassText(b) })))
        : [h("p", { class: "muted small-text", text: "No free visitor badge here with that number." })]));
      return null;
    }, 200);
    search.addEventListener("input", run);
    // Enter takes the first match.
    search.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      results.querySelector(".pick-row")?.click();
    });
    const chosen = await openDialog({
      title: `Badge for ${g.firstName} ${g.lastName}`,
      body: h("div", { class: "stack" },
        h("p", { class: "muted", text: "Check-in tells the front desk to hand them this badge when they arrive." }),
        h("label", {}, h("span", { text: "Visitor badge" }), search,
          h("span", { class: "hint", text: total ? `${total} free${multiSite() ? ` at ${e.siteName}` : ""}${g.badge ? `; now ${g.badge.label}` : ""}.` : `No visitor badge is free${multiSite() ? ` at ${e.siteName}` : ""}.` })),
        results),
      actions: [{ label: "Cancel", value: null }],
      onOpen: (dlg) => { dialog = dlg; setTimeout(() => search.focus(), 50); }
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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL_WORDS = ["first", "second", "third", "fourth", "last"];

/** How a repeating event repeats, for reading: "every week on Tuesday, until Dec 31, 2026". */
const repeatPhrase = (e) => e.repeatText.replace(/^Every/, "every").replace(/until (\d{4}-\d{2}-\d{2})$/, (m, d) => `until ${eventDay(d)}`);

/**
 * For a date of a repeating event: whether a change is for that date alone ("one") or for it
 * and its later dates ("following"); null if backed out. "one" at once for an event that
 * doesn't repeat.
 */
/** An event's notes, with a way to add or change them without the rest of the event form. */
function eventNotes(e) {
  const may = canEditVisitors();
  if (!e.notes && !may) return "";
  const edit = async () => {
    const scope = await seriesScope(e, { title: `Notes on ${e.title}`, one: "This date only", following: "This and later dates" });
    if (!scope) return;
    const saved = await formDialog({
      title: `Notes on ${e.title}`,
      fields: [{ name: "notes", label: "Notes", type: "textarea", rows: 6, value: e.notes || "", autofocus: true }],
      submitLabel: "Save",
      onSubmit: (v) => api(`/api/events/${e.id}`, { method: "PUT", body: { notes: v.notes, scope } })
    });
    if (saved) loadExpected();
  };
  return h("div", { class: "event-notes" },
    e.notes ? h("p", { class: "pre small-text", text: e.notes }) : null,
    may ? h("button", { type: "button", class: "link-btn small-text", text: e.notes ? "Edit notes" : "Add notes", onclick: edit }) : null);
}

function seriesScope(e, { title, one, following, danger = false }) {
  if (!e.seriesId) return Promise.resolve("one");
  return openDialog({
    title,
    body: h("p", { text: `${e.title} repeats ${repeatPhrase(e)}. This is its date on ${eventDay(e.date)}.` }),
    actions: [{ label: "Back", value: null }, { label: one, value: "one" }, { label: following, kind: danger ? "danger" : "primary", value: "following" }]
  });
}

/**
 * Who an event is for: type a name, pick the person, and their company comes with them (or
 * pick a company, with no one in particular). onPick({ companyId, companyName, hostId,
 * hostName, siteId }) runs after each pick, with null when cleared. siteId: only people there.
 */
function eventContactPicker(initial, { siteId = null, onPick }) {
  let chosen = initial;
  const search = h("input", { type: "search", placeholder: "Start typing a name", autocomplete: "off" });
  const results = h("div", { class: "choices-list short", hidden: true });
  const shown = h("p", { class: "small-text" });
  const show = () => {
    if (!chosen) return shown.replaceChildren(h("span", { class: "muted", text: "No particular company." }));
    shown.replaceChildren("Visiting ", h("strong", { text: chosen.companyName }), chosen.hostName ? `, host ${chosen.hostName}. ` : ", no one in particular. ",
      h("button", { type: "button", class: "link-btn", text: "Clear", onclick: () => pick(null) }));
  };
  const pick = (value) => {
    chosen = value;
    search.value = "";
    clear(results).hidden = true;
    show();
    onPick(value);
  };
  const row = (onclick, name, detail) => h("button", { type: "button", class: "pick-row", onclick }, h("strong", { text: name }), " ", h("span", { class: "muted small-text", text: detail }));
  const run = debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) return (clear(results).hidden = true);
    const where = { q, ...(siteId ? { site: String(siteId) } : {}) };
    const [people, companies] = await Promise.all([
      api(`/api/people?${new URLSearchParams({ ...where, limit: "8" })}`).then((r) => r.people).catch(() => []),
      api(`/api/companies?${new URLSearchParams({ ...where, limit: "4" })}`).then((r) => r.companies).catch(() => [])
    ]);
    if (search.value.trim() !== q) return; // typed on meanwhile: a newer search is coming
    clear(results).hidden = false;
    for (const p of people.filter((x) => x.canHost !== false)) {
      results.append(row(() => pick({ companyId: p.companyId, companyName: p.companyName, hostId: p.id, hostName: personName(p), siteId: p.siteId }), personName(p), [p.companyName, p.jobTitle].filter(Boolean).join(" · ")));
    }
    for (const c of companies) results.append(row(() => pick({ companyId: c.id, companyName: c.name, hostId: null, hostName: null, siteId: null }), c.name, "The company, no one in particular"));
    if (!results.children.length) results.append(h("p", { class: "muted", text: "No one by that name, nor a company." }));
  }, 200);
  search.addEventListener("input", run);
  // Enter picks the first match rather than saving the form.
  search.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    results.querySelector(".pick-row")?.click();
  });
  show();
  const node = h("div", { class: "full-row stack" },
    h("label", {}, h("span", { text: "Point of contact" }), search, h("span", { class: "hint", text: "The person they're visiting; their company comes with them. Or type a company's name." })),
    results, shown);
  return { node, value: () => chosen };
}

/** The repeat choices for a first date: on its day of the month, or its weekday of the month. */
function monthlyOptions(iso) {
  const d = new Date(`${iso || localToday()}T12:00:00`);
  return [{ value: "date", label: `On day ${d.getDate()}` }, { value: "weekday", label: `On the ${ORDINAL_WORDS[Math.ceil(d.getDate() / 7) - 1]} ${WEEKDAY_NAMES[d.getDay()]}` }];
}

/** A date a number of months after another (YYYY-MM-DD). */
function monthsAfter(iso, months) {
  const d = new Date(`${iso}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The event form: site, name, date and times, point of contact (and so the company), notes,
 * and for a new event how it repeats. scope "following" changes a repeating event's later
 * dates too (they keep their own dates).
 */
async function editEvent(event, scope = "one") {
  const usable = state.config.sites.filter((s) => s.active || s.id === event?.siteId);
  const single = usable.length <= 1;
  let picked = event?.companyId ? { companyId: event.companyId, companyName: event.companyName, hostId: event.hostId, hostName: event.hostName } : null;
  let siteInput = null;
  // The sites to offer: the company's (of those in use), or every one when there's no company.
  const fitSites = async (preferred) => {
    if (!siteInput) return;
    let list = usable;
    if (picked) {
      const { company } = await api(`/api/companies/${picked.companyId}`).catch(() => ({ company: null }));
      const at = new Set((company?.sites || []).map((s) => s.siteId));
      if (usable.some((s) => at.has(s.id))) list = usable.filter((s) => at.has(s.id));
    }
    const keep = [preferred, siteInput.value, state.site].filter(Boolean).map(String).find((v) => list.some((s) => String(s.id) === v));
    siteInput.replaceChildren(...list.map((s) => h("option", { value: String(s.id), text: s.name })));
    siteInput.value = keep || String(list[0].id);
  };
  const contact = eventContactPicker(picked, { siteId: single ? usable[0]?.id : null, onPick: (value) => { picked = value; fitSites(value?.siteId); } });

  // Repeating (a new event only): which weekdays, for weekly.
  const dayBoxes = WEEKDAY_NAMES.map((name, i) => h("input", { type: "checkbox", value: String(i), "aria-label": name }));
  const daysNode = h("div", { class: "full-row stack", hidden: true }, h("span", { class: "label", text: "On" }),
    h("div", { class: "btn-row" }, dayBoxes.map((box, i) => h("label", { class: "check-row" }, box, h("span", { text: WEEKDAY_NAMES[i].slice(0, 3) })))));
  const showRepeat = (inputs) => {
    if (!inputs.repeat) return;
    const how = inputs.repeat.value;
    const date = inputs.date.value || localToday();
    inputs.until.closest("label").hidden = !how;
    inputs.until.required = Boolean(how);
    inputs.until.min = date;
    inputs.until.max = monthsAfter(date, 12);
    if (how && !inputs.until.value) inputs.until.value = monthsAfter(date, 3);
    inputs.interval.closest("label").hidden = how !== "weekly";
    daysNode.hidden = how !== "weekly";
    if (!dayBoxes.some((b) => b.checked)) dayBoxes[new Date(`${date}T12:00:00`).getDay()].checked = true;
    inputs.by.closest("label").hidden = how !== "monthly";
    const by = inputs.by.value;
    inputs.by.replaceChildren(...monthlyOptions(date).map((o) => h("option", { value: o.value, text: o.label })));
    inputs.by.value = by || "date";
  };

  const fields = [
    ...(single ? [] : [{ name: "siteId", label: "Site", type: "select", value: String(event?.siteId || state.site || usable[0]?.id || ""), half: true, options: usable.map((s) => ({ value: String(s.id), label: s.name })),
      hint: "Follows the point of contact's company.",
      onChange: (input, inputs, dlg) => { if (dlg) { siteInput = input; fitSites(event?.siteId); } } }]),
    { name: "title", label: "Event", required: true, value: event?.title, placeholder: "Quarterly review, interviews, delivery…", half: !single },
    scope === "following"
      ? { name: "date", label: "Date", type: "readonly", value: `${eventDay(event.date)} (later dates keep their own)`, half: true }
      : { name: "date", label: event ? "Date" : "Date (the first, if it repeats)", type: "date", required: true, value: event?.date || expectedDay(), half: true, onChange: (input, inputs) => showRepeat(inputs) },
    { name: "startTime", label: "From", type: "time", value: event?.startTime || "", half: true },
    { name: "endTime", label: "Until", type: "time", value: event?.endTime || "", half: true },
    { node: contact.node },
    ...(event ? [] : [
      { name: "repeat", label: "Repeats", type: "select", value: "", half: true, onChange: (input, inputs) => showRepeat(inputs),
        options: [{ value: "", label: "Doesn't repeat" }, { value: "daily", label: "Every day" }, { value: "weekdays", label: "Every weekday (Monday to Friday)" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }] },
      { name: "until", label: "Until (its last date)", type: "date", half: true, hint: "At most a year after the first date. Each date is an event of its own." },
      { name: "interval", label: "Every", type: "select", value: "1", half: true, options: [{ value: "1", label: "Week" }, { value: "2", label: "Other week" }] },
      { node: daysNode },
      { name: "by", label: "Each month", type: "select", half: true, options: monthlyOptions(event?.date || expectedDay()), hint: "On day 29 to 31, a month without that day is skipped." }
    ]),
    { name: "notes", label: "Notes", type: "textarea", rows: 2, value: event?.notes }
  ];
  const saved = await formDialog({
    title: event ? `Edit ${event.title}${scope === "following" ? `, ${eventDay(event.date)} and later dates` : event.seriesId ? `, ${eventDay(event.date)} only` : ""}` : "New visitor event",
    wide: true,
    fields,
    submitLabel: event ? "Save" : "Add event",
    onSubmit: async (v) => {
      const who = contact.value();
      const body = { title: v.title, startTime: v.startTime, endTime: v.endTime, companyId: who?.companyId ?? null, hostId: who?.hostId ?? null, notes: v.notes, siteId: Number(v.siteId || usable[0]?.id) };
      if (scope !== "following") body.date = v.date;
      if (!event && v.repeat) {
        body.repeat = { freq: v.repeat, until: v.until, interval: Number(v.interval), by: v.by, days: dayBoxes.filter((b) => b.checked).map((b) => Number(b.value)) };
        if (v.repeat === "weekly" && !body.repeat.days.length) throw new Error("Choose the days of the week it's on.");
      }
      return (event ? await api(`/api/events/${event.id}`, { method: "PUT", body: { ...body, scope } }) : await api("/api/events", { method: "POST", body })).event;
    }
  });
  if (saved && !event) {
    toast(saved.count > 1 ? `Added ${saved.title} on ${saved.count} dates. Now add its guests: they're expected on each date.` : `Added ${saved.title}. Now add its guests.`);
    await addGuestDialog(saved, "following");
    refreshCounts();
  } else if (saved && saved.count > 1) {
    toast(`Saved ${saved.count} dates.`);
  }
  return saved;
}

/**
 * Adds guests to an event: someone on record (search), or someone new; with scope
 * "following", to its later dates too. Resolves true if any were added.
 */
async function addGuestDialog(event, scope = "one") {
  let added = 0;
  const results = h("div", { class: "choices-list" });
  const message = h("p", { class: "message", hidden: true });
  const search = h("input", { type: "search", placeholder: "Search visitors on record", autocomplete: "off" });
  const say = (text, kind = "success") => { message.className = `message ${kind}`; message.textContent = text; message.hidden = false; };
  const add = async (body, name) => {
    try {
      await api(`/api/events/${event.id}/guests`, { method: "POST", body: { ...body, scope } });
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
        h("strong", { text: visitorName(v) }), " ", h("span", { class: "muted small-text", text: [v.organization, (v.companies || []).map((c) => c.companyName).join(", ")].filter(Boolean).join(" · ") })));
    }
    if (!visitors.length) results.append(h("p", { class: "muted", text: "Nobody by that name on record; add them as new below." }));
  }, 250);
  search.addEventListener("input", run);
  const first = h("input", { placeholder: "First name", "aria-label": "First name" });
  const last = h("input", { placeholder: "Last name", "aria-label": "Last name" });
  const org = h("input", { placeholder: "Their company (optional)", "aria-label": "Their company" });
  const email = h("input", { type: "email", placeholder: "Email (optional)", "aria-label": "Email" });
  const addNew = h("button", { type: "button", class: "secondary", text: "Add as a new visitor", onclick: async () => {
    if (!first.value.trim() || !last.value.trim()) return say("Enter their first and last name.", "error");
    await add({ visitor: { firstName: first.value, lastName: last.value, organization: org.value, email: email.value } }, `${first.value.trim()} ${last.value.trim()}`);
    if (message.className.includes("success")) for (const i of [first, last, org, email]) i.value = "";
  } });
  await openDialog({
    title: `Guests for ${event.title}${event.seriesId ? scope === "following" ? `, ${eventDay(event.date)} and later dates` :`, ${eventDay(event.date)} only` : ""}`,
    wide: true,
    body: h("div", { class: "stack" },
      message,
      h("h4", { text: "On record" }), search, results,
      h("h4", { text: "Someone new" }),
      h("div", { class: "form-grid" }, first, last, org, email),
      addNew,
      h("p", { class: "muted small-text", text: "New guests are added as visitors, linked to the event's company and host, so the kiosk recognizes them on the day." })),
    actions: [{ label: "Done", kind: "primary", value: true }],
    onOpen: () => setTimeout(() => search.focus(), 50)
  });
  if (added) refreshCounts();
  return added > 0;
}

function showExpected() {
  loadExpected();
}
