// 19-dashboard.js: Home, each person's dashboard. They choose which modules it shows, and in
// what order (Customize); the server keeps the list with their account and offers only the
// modules their role may see. Every module follows the site chosen in the header, which the
// buttons at the top switch quickly. The page refreshes itself every minute.

const DASHBOARD_REFRESH_MS = 60 * 1000;
const DASHBOARD_LIST_MAX = 8;
const dashboard = { editing: false, draft: null, timer: null, tenantsQuery: "" };

const siteParams = (extra = {}) => new URLSearchParams({ ...siteQuery(), ...extra });

/** A clickable row: a main line, a muted second line, and something on the right. */
function dashRow({ href = null, onclick = null, main, sub = null, right = null }) {
  const content = [h("span", { class: "dash-row-main" }, h("span", { class: "dash-row-title" }, main), sub ? h("span", { class: "muted small-text", text: sub }) : null), right ? h("span", { class: "dash-row-right" }, right) : null];
  return href ? h("a", { class: "dash-row", href }, content) : h("div", { class: onclick ? "dash-row is-clickable" : "dash-row", onclick }, content);
}

function dashList(items, empty, { more = null } = {}) {
  if (!items.length) return h("p", { class: "muted small-text dash-empty", text: empty });
  return h("div", { class: "dash-list" }, items.slice(0, DASHBOARD_LIST_MAX),
    items.length > DASHBOARD_LIST_MAX && more ? h("a", { class: "small-text dash-more", href: more, text: `${items.length - DASHBOARD_LIST_MAX} more` }) : null);
}

/**
 * The modules. load() returns { count, body }: count goes beside the title (null for none).
 * The server decides which a role may have (prefs.js); these say what each shows.
 */
const DASHBOARD_MODULES = {
  badgeNeeded: {
    title: "Complete check-in",
    description: "Visitors who checked in at a kiosk and wait for the desk to check their ID and give them a badge.",
    href: "#here",
    async load() {
      const { visits } = await api(`/api/visits/badge-needed?${siteParams()}`);
      return { count: visits.length, attention: visits.length > 0, body: dashList(visits.map((a) => h("div", { class: `checkin-row stage-${a.stage}` }, dashRow({
        onclick: () => continueCheckIn(a.visitId),
        main: a.name,
        sub: [a.stage === "id" ? "Check their ID" : "Needs a badge", a.companyName, multiSite() && !state.site ? a.siteName : null, agoText(a.checkedInAt)].filter(Boolean).join(" · "),
        right: h("button", { type: "button", class: "primary small", text: checkinNext(a), onclick: (e) => { e.stopPropagation(); continueCheckIn(a.visitId); } })
      }))), "Nobody is waiting at the desk.") };
    }
  },
  here: {
    title: "In the building",
    description: "Visitors checked in now, at the chosen site.",
    href: "#here",
    async load() {
      const { visits, total } = await api(`/api/visits?${siteParams({ status: "open", limit: "50" })}`);
      // A row with a button can't be a link: the name is, and the rest of the row opens it too.
      const open = (v) => { location.hash = `#visitor/${v.visitorId}`; };
      const checkOut = async (e, v) => {
        e.stopPropagation();
        e.target.disabled = true;
        try {
          await api(`/api/visits/${v.id}/checkout`, { method: "POST", body: {} });
          toast(`${visitorName(v.visitor)} checked out.`);
          loadDashboard();
          refreshCounts();
        } catch (error) {
          toast(error.message, "error");
          e.target.disabled = false;
        }
      };
      return { count: total, body: dashList(visits.map((v) => dashRow({
        onclick: () => open(v),
        main: h("a", { href: `#visitor/${v.visitorId}`, text: visitorName(v.visitor), onclick: (e) => e.stopPropagation() }),
        sub: [v.companyName, v.hostName ? `host ${v.hostName}` : null, multiSite() && !state.site ? v.siteName : null].filter(Boolean).join(" · "),
        right: h("span", { class: "btn-row" }, h("span", { class: "muted small-text", text: fmtDateTime(v.checkedInAt) }),
          canEditVisitors() ? h("button", { type: "button", class: "secondary small", text: "Check out", onclick: (e) => checkOut(e, v) }) : null)
      })), "Nobody is checked in right now.", { more: "#here" }) };
    }
  },
  expected: {
    title: "Expected today",
    description: "Today's visitor events and their guests, with who has arrived.",
    href: "#expected",
    async load() {
      const { events } = await api(`/api/events?${siteParams({ date: localToday() })}`);
      const guests = events.flatMap((e) => e.guests.map((g) => ({ ...g, event: e })));
      const order = { expected: 0, here: 1, left: 2 };
      guests.sort((a, b) => order[a.status] - order[b.status] || String(a.event.startTime || "").localeCompare(String(b.event.startTime || "")));
      const waiting = guests.filter((g) => g.status === "expected").length;
      return { count: waiting, body: dashList(guests.map((g) => dashRow({
        href: `#visitor/${g.visitorId}`,
        main: `${g.firstName} ${g.lastName}`,
        sub: [g.event.startTime, g.event.title, g.event.companyName].filter(Boolean).join(" · "),
        right: h("span", { class: `badge ${g.status === "here" ? "ok" : g.status === "left" ? "muted" : "warn"}`, text: g.status === "here" ? "Here" : g.status === "left" ? "Left" : "Expected" })
      })), events.length ? "Every guest has arrived." : "Nobody is expected today.", { more: "#expected" }) };
    }
  },
  review: {
    title: "Visitors to check",
    description: "People who registered themselves at a kiosk and haven't been checked by staff.",
    href: "#visitors",
    async load() {
      const { visitors, total } = await api("/api/visitors?filter=review&limit=20");
      return { count: total, attention: total > 0, body: dashList(visitors.map((v) => dashRow({
        href: `#visitor/${v.id}`,
        main: visitorName(v),
        sub: [v.organization, (v.companies || []).map((c) => c.companyName).join(", ")].filter(Boolean).join(" · ") || null,
        right: h("span", { class: "muted small-text", text: fmtDate(v.createdAt) })
      })), "Nobody to check.", { more: "#visitors" }) };
    }
  },
  badgesOut: {
    title: "Badges out past their time",
    description: "Visitor badges with visitors who have left, and temporary badges not back by the end of their day.",
    href: "#badges/visitors",
    async load() {
      const [left, overdue] = await Promise.all([
        api(`/api/badges?${siteParams({ state: "left", limit: "50" })}`),
        api(`/api/badges?${siteParams({ state: "overdue", limit: "50" })}`)
      ]);
      const list = [...overdue.badges.map((b) => ({ b, why: "Temporary, overdue" })), ...left.badges.map((b) => ({ b, why: "Visitor has left" }))];
      return { count: list.length, attention: list.length > 0, body: dashList(list.map(({ b, why }) => dashRow({
        href: `#badge/${b.id}`,
        main: h("span", { class: "with-thumb" }, templateImg(b.template), h("span", { class: "mono", text: b.label })),
        sub: `${b.holder?.name || ""} · ${why}`,
        right: h("span", { class: "muted small-text", text: b.holder ? fmtDateTime(b.holder.assignedAt) : "" })
      })), "Every badge is where it should be.", { more: "#badges/visitors" }) };
    }
  },
  tenants: {
    title: "Tenants",
    description: "The companies at the chosen site, to find one quickly.",
    href: "#companies",
    async load() {
      const search = h("input", { type: "search", placeholder: "Find a company", value: dashboard.tenantsQuery, "aria-label": "Find a company", class: "dash-search" });
      const list = h("div", {});
      const fill = async () => {
        const q = search.value.trim();
        dashboard.tenantsQuery = q;
        const { companies, total } = await api(`/api/companies?${siteParams({ limit: String(DASHBOARD_LIST_MAX), ...(q ? { q } : {}) })}`);
        list.replaceChildren(dashList(companies.map((c) => dashRow({
          href: `#company/${c.id}`,
          main: c.name,
          sub: (c.sites || []).filter((s) => !state.site || String(s.siteId) === String(state.site)).map((s) => (s.suite ? (multiSite() ? `${s.siteName}: ${s.suite}` : s.suite) : s.siteName)).join("; ") || null,
          right: h("span", { class: "muted small-text", text: `${c.peopleCount ?? 0} ${c.peopleCount === 1 ? "person" : "people"}` })
        })), q ? "No company matches." : "No companies yet."), total > companies.length ? h("a", { class: "small-text dash-more", href: "#companies", text: `All ${total}` }) : "");
      };
      search.addEventListener("input", debounce(fill, 250));
      await fill();
      return { count: null, body: h("div", { class: "stack" }, search, list) };
    }
  },
  clearanceQueue: {
    title: "Clearances to validate",
    description: "Requests waiting for the Security role (the digits stay in the queue).",
    href: "#clearance",
    async load() {
      const { requests } = await api("/api/clearance/requests");
      return { count: requests.length, attention: requests.length > 0, body: dashList(requests.map((q) => dashRow({
        href: "#clearance",
        main: q.name,
        sub: [q.kind === "visitor" ? "Visitor" : q.organization, q.requestedBy ? `asked by ${q.requestedBy}` : null].filter(Boolean).join(" · "),
        right: h("span", { class: "muted small-text", text: agoText(q.requestedAt) })
      })), "Nothing waiting.", { more: "#clearance" }) };
    }
  },
  rechecks: {
    title: "Visitor re-checks",
    description: "Visitors whose validated clearance runs out within 30 days, or already has.",
    href: "#clearances",
    async load() {
      const { rechecks } = await clearanceOverview();
      return { count: rechecks.length, attention: rechecks.some((x) => x.overdue), body: dashList(rechecks.map((x) => dashRow({
        href: holderHref(x),
        main: x.name,
        sub: [x.levelName, x.organization].filter(Boolean).join(" · "),
        right: x.overdue ? h("span", { class: "badge bad", text: "Overdue" }) : h("span", { class: "muted small-text", text: `due ${fmtDate(x.dueAt)}` })
      })), "No re-checks coming up.", { more: "#clearances" }) };
    }
  },
  expiring: {
    title: "Clearances expiring",
    description: "Clearances that expire within 60 days, or expired in the last 30.",
    href: "#clearances",
    async load() {
      const { expiring } = await clearanceOverview();
      return { count: expiring.length, attention: expiring.some((x) => x.expired), body: dashList(expiring.map((x) => dashRow({
        href: holderHref(x),
        main: x.name,
        sub: [x.levelName, x.kind === "visitor" ? "Visitor" : x.organization].filter(Boolean).join(" · "),
        right: x.expired ? h("span", { class: "badge bad", text: "Expired" }) : h("span", { class: "muted small-text", text: dateText(x.expires) })
      })), "Nothing expiring soon.", { more: "#clearances" }) };
    }
  },
  occupancy: {
    title: "Offices",
    description: "Offices available, occupied and upcoming at the chosen site, the space let and the monthly rent.",
    href: "#floors",
    async load() {
      const { summary: s } = await api(`/api/facilities/summary?${siteParams()}`);
      if (!s.offices) return { count: null, body: h("p", { class: "muted small-text dash-empty", text: "No offices yet." }) };
      const let_ = s.sqft.total ? Math.round((s.sqft.occupied / s.sqft.total) * 100) : 0;
      const stat = (status, n) => h("a", { class: "dash-stat", href: `#offices`, onclick: () => { $("offices-status").value = status; } },
        h("span", { class: `plan-swatch status-${status}`, "aria-hidden": "true" }), h("strong", { text: String(n) }), h("span", { class: "muted small-text", text: OFFICE_STATUS[status].label }));
      return { count: s.available, body: h("div", { class: "stack" },
        h("div", { class: "dash-stats" }, Object.keys(OFFICE_STATUS).map((st) => stat(st, s[st]))),
        h("div", { class: "occupancy-bar", role: "img", "aria-label": `${let_}% of the space let` }, h("span", { style: `width: ${let_}%` })),
        h("p", { class: "small-text" }, h("strong", { text: `${let_}% let` }), h("span", { class: "muted", text: ` · ${fmtSqft(s.sqft.occupied)} of ${fmtSqft(s.sqft.total)} · ${fmtMoney(s.monthly)} a month` }))) };
    }
  },
  leasesEnding: {
    title: "Leases ending soon",
    description: "Leases that end within 90 days, or ended in the last 30.",
    href: "#leases",
    async load() {
      const { leases } = await api("/api/leases/ending");
      const today = localToday();
      return { count: leases.length, attention: leases.some((l) => l.endDate < today), body: dashList(leases.map((l) => dashRow({
        href: `#lease/${l.id}`,
        main: l.companyName,
        sub: [l.reference, l.offices.map((o) => o.name).join(", ") || null].filter(Boolean).join(" · ") || null,
        right: h("span", { class: `badge ${l.endDate < today ? "bad" : "warn"}`, text: l.endDate < today ? `Ended ${dateText(l.endDate)}` : `Ends ${dateText(l.endDate)}` })
      })), "No lease ends in the next 90 days.", { more: "#leases" }) };
    }
  },
  overdueInvoices: {
    title: "Overdue invoices",
    description: "Issued invoices past their due date with a balance, oldest first.",
    href: "#invoices",
    async load() {
      const { invoices } = await api("/api/invoices?state=overdue");
      invoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const owed = invoices.reduce((n, i) => n + i.balance, 0);
      return { count: invoices.length, attention: invoices.length > 0, body: h("div", { class: "stack" },
        invoices.length ? h("p", { class: "small-text" }, h("strong", { text: fmtMoney(owed) }), h("span", { class: "muted", text: " overdue" })) : "",
        dashList(invoices.map((i) => dashRow({
          href: `#invoice/${i.id}`,
          main: `${i.number} · ${i.companyName}`,
          sub: `Due ${dateText(i.dueDate)}, ${i.daysOverdue} day${i.daysOverdue === 1 ? "" : "s"} ago`,
          right: h("span", { class: "badge bad", text: fmtMoney(i.balance) })
        })), "Nothing is overdue.", { more: "#invoices" })) };
    }
  },
  validations: {
    title: "Recently validated",
    description: "Clearances validated in the last 30 days, and by whom.",
    href: "#clearances",
    async load() {
      const { recent } = await clearanceOverview();
      return { count: null, body: dashList(recent.map((x) => dashRow({
        href: holderHref(x),
        main: x.name,
        sub: [x.levelName || "No clearance", x.validatedBy ? `by ${x.validatedBy}` : null].filter(Boolean).join(" · "),
        right: h("span", { class: "muted small-text", text: fmtDate(x.validatedAt) })
      })), "Nothing validated lately.", { more: "#clearances" }) };
    }
  }
};

function greeting() {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = String(state.me.displayName || state.me.username).split(" ")[0];
  return `${part}, ${name}`;
}

/** Quick site switching on Home: a button per site they can see. */
function renderSiteChips() {
  const sites = activeSites();
  const box = $("home-sites");
  box.hidden = sites.length < 2;
  const chip = (id, label) => h("button", { type: "button", class: `site-chip${String(id) === String(state.site) ? " is-current" : ""}`, "aria-pressed": String(String(id) === String(state.site)), onclick: () => { if (String(id) !== String(state.site)) setSite(id); } }, label);
  box.replaceChildren(...sites.map((s) => chip(s.id, s.name)), chip("", allSitesLabel()));
}

/** One module's card; in edit mode with its controls instead of its contents. */
function moduleCard(id, index, list) {
  const def = DASHBOARD_MODULES[id];
  const count = h("span", { class: "pill", hidden: true });
  const body = h("div", { class: "dash-body" }, h("p", { class: "muted small-text", text: "Loading…" }));
  const card = h("section", { class: "dash-card", dataset: { module: id } },
    h("div", { class: "dash-card-head" },
      h("h3", {}, h("a", { href: def.href, text: def.title }), " ", count),
      dashboard.editing ? h("div", { class: "btn-row" },
        h("button", { type: "button", class: "link-btn", text: "Up", "aria-label": `Move ${def.title} up`, disabled: index === 0, onclick: () => moveModule(index, -1) }),
        h("button", { type: "button", class: "link-btn", text: "Down", "aria-label": `Move ${def.title} down`, disabled: index === list.length - 1, onclick: () => moveModule(index, 1) }),
        h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => { dashboard.draft.splice(index, 1); renderDashboard(); } })) : null),
    body);
  if (dashboard.editing) {
    body.replaceChildren(h("p", { class: "muted small-text", text: def.description }));
  } else {
    def.load().then((r) => {
      body.replaceChildren(r.body);
      if (r.count !== null && r.count !== undefined) {
        count.textContent = String(r.count);
        count.hidden = !r.count;
        count.classList.toggle("attention", Boolean(r.attention));
      }
      card.classList.toggle("needs-attention", Boolean(r.attention));
    }).catch((error) => body.replaceChildren(h("p", { class: "message error", text: error.message })));
  }
  return card;
}

function moveModule(index, by) {
  const list = dashboard.draft;
  const [m] = list.splice(index, 1);
  list.splice(index + by, 0, m);
  renderDashboard();
}

/** The "add a module" card in edit mode: the modules they may have and haven't added. */
function addModuleCard() {
  const left = state.prefs.available.filter((id) => !dashboard.draft.includes(id) && DASHBOARD_MODULES[id]);
  if (!left.length) return h("section", { class: "dash-card dash-add" }, h("p", { class: "muted small-text", text: "Every module you can have is on your dashboard." }));
  return h("section", { class: "dash-card dash-add" },
    h("h3", { text: "Add a module" }),
    h("div", { class: "dash-list" }, left.map((id) => h("button", { type: "button", class: "dash-row dash-add-row", onclick: () => { dashboard.draft.push(id); renderDashboard(); } },
      h("span", { class: "dash-row-main" }, h("span", { class: "dash-row-title", text: DASHBOARD_MODULES[id].title }), h("span", { class: "muted small-text", text: DASHBOARD_MODULES[id].description })),
      h("span", { class: "dash-row-right primary-text", text: "Add" })))));
}

function renderDashboard() {
  $("home-greeting").textContent = greeting();
  renderSiteChips();
  $("home-customize").hidden = dashboard.editing;
  $("home-edit-bar").hidden = !dashboard.editing;
  const list = (dashboard.editing ? dashboard.draft : state.prefs.dashboard).filter((id) => DASHBOARD_MODULES[id]);
  const cards = list.map((id, i) => moduleCard(id, i, list));
  if (dashboard.editing) cards.push(addModuleCard());
  else if (!list.length) cards.push(h("section", { class: "dash-card" }, h("p", { class: "muted", text: "Your dashboard is empty. Customize it to add modules." })));
  $("home-modules").replaceChildren(...cards);
}

/** Reloads every module (after a change, a site switch, or on the timer). */
function loadDashboard() {
  if (state.view !== "home" || dashboard.editing) return;
  renderDashboard();
}

function showHome() {
  dashboard.editing = false;
  renderDashboard();
  clearInterval(dashboard.timer);
  dashboard.timer = setInterval(() => {
    if (state.view !== "home") return clearInterval(dashboard.timer);
    if (!document.hidden && !document.querySelector("dialog[open]")) loadDashboard();
    return null;
  }, DASHBOARD_REFRESH_MS);
}

async function saveDashboard(list) {
  try {
    state.prefs = await api("/api/me/prefs", { method: "PUT", body: { dashboard: list } });
    dashboard.editing = false;
    renderDashboard();
  } catch (error) {
    toast(error.message, "error");
  }
}

$("home-checkin").addEventListener("click", async () => {
  if (await checkInWizard()) loadDashboard();
});

$("home-customize").addEventListener("click", () => {
  dashboard.editing = true;
  dashboard.draft = [...state.prefs.dashboard];
  renderDashboard();
});
$("home-cancel").addEventListener("click", () => { dashboard.editing = false; renderDashboard(); });
$("home-save").addEventListener("click", () => saveDashboard(dashboard.draft));
$("home-reset").addEventListener("click", () => { dashboard.draft = [...state.prefs.defaults]; renderDashboard(); });
