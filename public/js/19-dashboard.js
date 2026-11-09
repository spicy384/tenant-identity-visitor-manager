// 19-dashboard.js: Home, each person's dashboard. They choose which modules it shows, and in
// what order (Customize, where the cards can be dragged into place); the server keeps the list with their account and offers only the
// modules their role may see. Every module follows the site chosen in the header, which the
// buttons at the top switch quickly. The page refreshes itself every minute.

const DASHBOARD_REFRESH_MS = 60 * 1000;
const DASHBOARD_LIST_MAX = 8;
// loaded: each module's last contents, shown while it reloads instead of a blank.
const dashboard = { editing: false, draft: null, timer: null, tenantsQuery: "", cards: [], columns: 0, loaded: new Map() };
// The narrowest a column of cards gets, and the space between columns (as in styles.css).
const DASHBOARD_COLUMN_MIN = 320;
const DASHBOARD_GAP = 16;

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

/** A company's insurance cover as a row: who, who insures them and until when, and its status. */
function coverRow(c) {
  return dashRow({
    href: `#company/${c.companyId}`,
    main: c.companyName,
    sub: c.certificate ? [c.certificate.insurer, `${c.status === "expired" ? "expired" : "expires"} ${dateText(c.certificate.expiresOn)}`].filter(Boolean).join(" · ") : null,
    right: coverBadge(c.status, c.certificate)
  });
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
      const status = (g) => h("span", { class: `badge ${g.status === "here" ? "ok" : g.status === "left" ? "muted" : "warn"}`, text: g.status === "here" ? "Here" : g.status === "left" ? "Left" : "Expected" });
      // Checked in from here as on the Expected page: the event gives the company, host and purpose.
      const checkIn = async (e, g) => {
        e.stopPropagation();
        e.currentTarget.disabled = true;
        try {
          const { visitor } = await api(`/api/visitors/${g.visitorId}`);
          if (await checkInWizard({ visitor, event: g.event })) loadDashboard();
        } catch (error) {
          toast(error.message, "error");
        } finally {
          e.target.disabled = false;
        }
      };
      return { count: waiting, body: dashList(guests.map((g) => {
        const sub = [g.event.startTime, g.event.title, g.event.companyName].filter(Boolean).join(" · ");
        // A row with a button can't be a link: the rest of the row opens the visitor.
        if (g.status === "expected" && canEditVisitors()) {
          return dashRow({ onclick: () => { location.hash = `#visitor/${g.visitorId}`; }, main: `${g.firstName} ${g.lastName}`, sub,
            right: h("button", { type: "button", class: "primary small", text: "Check in", onclick: (e) => checkIn(e, g) }) });
        }
        return dashRow({ href: `#visitor/${g.visitorId}`, main: `${g.firstName} ${g.lastName}`, sub, right: status(g) });
      }), events.length ? "Every guest has arrived." : "Nobody is expected today.", { more: "#expected" }) };
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
  alarms: {
    title: "Alarms not opened",
    description: "Alarm notices from the monitoring center that no one has opened yet.",
    href: "#alarms",
    async load() {
      const { alarms, total } = await api(`/api/security/alarms?${siteParams({ unread: "1", limit: "50" })}`);
      return { count: total, attention: total > 0, body: dashList(alarms.map((a) => dashRow({
        href: `#alarm/${a.id}`,
        main: a.event || "Alarm",
        sub: [a.accountName || a.account, a.zone ? `Zone ${a.zone}${a.zoneName ? ` · ${a.zoneName}` : ""}` : null, multiSite() && !state.site ? a.siteName : null].filter(Boolean).join(" · "),
        right: h("span", { class: "muted small-text", text: agoText(a.receivedAt) })
      })), "Every alarm has been opened.", { more: "#alarms" }) };
    }
  },
  guardReports: {
    title: "Guard reports not opened",
    description: "Guard daily reports that no one has opened yet, with anything that needs a look.",
    href: "#guard-reports",
    async load() {
      const { reports, total } = await api(`/api/security/guard-reports?${siteParams({ unread: "1", limit: "50" })}`);
      return { count: total, attention: reports.some((r) => r.incidents || r.missed), body: dashList(reports.map((r) => dashRow({
        href: `#guard-report/${r.id}`,
        main: guardDateText(r.date) || fmtDate(r.receivedAt),
        sub: [r.site, multiSite() && !state.site ? r.siteName : null].filter(Boolean).join(" · ") || null,
        right: r.incidents ? h("span", { class: "badge bad", text: `${r.incidents} ${r.incidents === 1 ? "incident" : "incidents"}` })
          : r.missed ? h("span", { class: "badge warn", text: `${r.missed} missed` }) : null
      })), "Every guard report has been opened.", { more: "#guard-reports" }) };
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
  insurance: {
    title: "Insurance to renew",
    description: "Tenants with an office whose certificate of insurance has expired, expires within 30 days, or isn't on file.",
    href: "#insurance",
    async load() {
      const { companies } = await api(`/api/insurance/attention?${siteParams()}`);
      return { count: companies.length, attention: companies.some((c) => c.status !== "expiring"), body: dashList(companies.map(coverRow), "Every tenant's insurance is current.", { more: "#insurance" }) };
    }
  },
  insuranceExpiring: {
    title: "COIs expiring or expired",
    description: "Certificates of insurance that run out within 30 days or ran out in the last 30, earliest date first.",
    href: "#insurance",
    async load() {
      const { companies } = await api(`/api/insurance?${siteParams({ status: "soon" })}`);
      companies.sort((a, b) => a.certificate.expiresOn.localeCompare(b.certificate.expiresOn) || a.companyName.localeCompare(b.companyName));
      return { count: companies.length, attention: companies.some((c) => c.status === "expired"), body: dashList(companies.map(coverRow), "No certificate has just run out or runs out in the next 30 days.", { more: "#insurance" }) };
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
        sub: [x.levelName || "Uncleared", x.validatedBy ? `by ${x.validatedBy}` : null].filter(Boolean).join(" · "),
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

/** One module's card; in edit mode with its controls instead of its contents. */
function moduleCard(id) {
  const def = DASHBOARD_MODULES[id];
  const count = h("span", { class: "pill", hidden: true });
  // What it showed last while it reloads (the refresh every minute, a site switch); its shape the first time.
  const kept = dashboard.editing ? null : dashboard.loaded.get(id);
  const body = h("div", { class: "dash-body" }, kept ? kept.body : skeletonLines());
  if (kept) {
    count.textContent = String(kept.count ?? "");
    count.hidden = !kept.count;
    count.classList.toggle("attention", Boolean(kept.attention));
  }
  const card = h("section", { class: "dash-card", dataset: { module: id } },
    h("div", { class: "dash-card-head" },
      // Customizing, the title isn't a link (a click would leave the page) and a grip shows the card can be dragged.
      dashboard.editing ? h("h3", {}, h("span", { class: "dash-grip", "aria-hidden": "true" }), h("span", { text: def.title }))
        : h("h3", {}, h("a", { href: def.href, text: def.title }), " ", count),
      dashboard.editing ? h("div", { class: "btn-row" },
        h("button", { type: "button", class: "link-btn", text: "Up", "aria-label": `Move ${def.title} up`, dataset: { move: "up" }, onclick: () => moveModule(id, -1) }),
        h("button", { type: "button", class: "link-btn", text: "Down", "aria-label": `Move ${def.title} down`, dataset: { move: "down" }, onclick: () => moveModule(id, 1) }),
        h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => { dashboard.draft.splice(dashboard.draft.indexOf(id), 1); renderDashboard(); } })) : null),
    body);
  if (dashboard.editing) {
    body.replaceChildren(h("p", { class: "muted small-text", text: def.description }));
  } else {
    if (kept) card.classList.toggle("needs-attention", Boolean(kept.attention));
    def.load().then((r) => {
      dashboard.loaded.set(id, r);
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

function moveModule(id, by) {
  const list = dashboard.draft;
  const index = list.indexOf(id);
  list.splice(index, 1);
  list.splice(index + by, 0, id);
  // The cards slide to their new places rather than jumping there.
  const glide = glideFrom($("home-modules").querySelectorAll("[data-module]"), (el) => el.dataset.module);
  renderDashboard();
  glide($("home-modules").querySelectorAll("[data-module]"));
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
  endCardDrag();
  $("home-greeting").textContent = greeting();
  $("home-modules").classList.toggle("is-editing", dashboard.editing);
  $("home-customize").hidden = dashboard.editing;
  $("home-search").hidden = dashboard.editing || !canReadDirectory();
  $("home-edit-bar").hidden = !dashboard.editing;
  const list = (dashboard.editing ? dashboard.draft : state.prefs.dashboard).filter((id) => DASHBOARD_MODULES[id]);
  const cards = list.map((id) => moduleCard(id));
  if (dashboard.editing) cards.push(addModuleCard());
  else if (!list.length) cards.push(h("section", { class: "dash-card" }, h("p", { class: "muted", text: "Your dashboard is empty. Customize it to add modules." })));
  dashboard.cards = cards;
  placeCards();
}

/** How many columns of cards fit the dashboard's width (one on a phone). */
function dashboardColumns() {
  const width = $("home-modules").clientWidth;
  return Math.max(1, Math.floor((width + DASHBOARD_GAP) / (DASHBOARD_COLUMN_MIN + DASHBOARD_GAP)));
}

/**
 * Puts the cards in columns, each stacking its own, so a long card only moves the ones below
 * it in its column. Card n goes in column n modulo the count, so they read across as before.
 */
function placeCards() {
  const box = $("home-modules");
  const n = dashboardColumns();
  const columns = Array.from({ length: n }, () => h("div", { class: "dash-column" }));
  dashboard.cards.forEach((card, i) => columns[i % n].append(card));
  box.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  box.replaceChildren(...columns);
  dashboard.columns = n;
  markCardEnds();
}

/** Customizing, the first card can't go up nor the last down. */
function markCardEnds() {
  const mods = dashboard.cards.filter((el) => el.dataset.module);
  mods.forEach((el, i) => {
    const up = el.querySelector("[data-move=up]");
    const down = el.querySelector("[data-move=down]");
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === mods.length - 1;
  });
}

// A wider or narrower window (or Home first shown) may fit a different number of columns: the
// same cards move, already loaded.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if ($("home-modules").clientWidth && dashboardColumns() !== dashboard.columns) placeCards();
  }).observe($("home-modules"));
}

// --- dragging a card into place (Customize) ----------------------------------------------------------

// How far a press moves before it's a drag (so a click stays a click), how far the pointer goes
// after the cards rearrange before they may again, and the band at the top and bottom of the
// window that scrolls the page while a card is held there.
const CARD_DRAG_START = 6;
const CARD_DRAG_STEP = 12;
const CARD_DRAG_EDGE = 64;
let cardDrag = null;

/**
 * Where the held card would go for a pointer at (x, y), as its place among the others: the
 * column under the pointer, below the cards in it whose middle the pointer is past.
 */
function cardSlot(x, y) {
  const columns = [...$("home-modules").children];
  let c = columns.findIndex((col) => x < col.getBoundingClientRect().right + DASHBOARD_GAP / 2);
  if (c < 0) c = columns.length - 1;
  const col = columns[c];
  const top = col.getBoundingClientRect().top;
  // Where the cards are laid out, not where a glide has them for the moment.
  const above = [...col.children].filter((el) => el !== cardDrag.holder && el.dataset.module && top + el.offsetTop + el.offsetHeight / 2 < y).length;
  return above * columns.length + c;
}

/** Puts the cards in this order (the gap left by the held card among them), gliding there. */
function arrangeCards(mods) {
  const box = $("home-modules");
  const glide = glideFrom(box.querySelectorAll("[data-module]"), (el) => el.dataset.module);
  dashboard.cards = [...mods, ...dashboard.cards.filter((el) => !el.dataset.module)];
  dashboard.draft = mods.map((el) => el.dataset.module);
  placeCards();
  glide(box.querySelectorAll("[data-module]"));
}

/** The gap moves to where the pointer is, and the other cards make room. */
function reorderTo(x, y) {
  const d = cardDrag;
  // Measured on the page, so scrolling counts as moving.
  const at = { x, y: y + window.scrollY };
  if (d.last && Math.hypot(at.x - d.last.x, at.y - d.last.y) < CARD_DRAG_STEP) return;
  const mods = dashboard.cards.filter((el) => el.dataset.module);
  const from = mods.indexOf(d.holder);
  const to = Math.min(Math.max(cardSlot(x, y), 0), mods.length - 1);
  if (to === from) return;
  d.last = at;
  mods.splice(from, 1);
  mods.splice(to, 0, d.holder);
  arrangeCards(mods);
}

const showCard = (d) => { d.card.style.transform = `translate(${d.x}px, ${d.y}px)`; };

/** Takes the card out of the dashboard to follow the pointer, leaving a gap the same size. */
function liftCard(d) {
  const { card } = d;
  card.getAnimations().forEach((a) => a.cancel());
  const r = card.getBoundingClientRect();
  d.holder = h("div", { class: "dash-card dash-placeholder", dataset: { module: card.dataset.module }, "aria-hidden": "true" });
  d.holder.style.height = `${r.height}px`;
  dashboard.cards[dashboard.cards.indexOf(card)] = d.holder;
  card.replaceWith(d.holder);
  d.origin = { x: r.left, y: r.top };
  Object.assign(card.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: "0" });
  card.classList.add("is-lifted");
  $("view-home").append(card);
  showCard(d);
  if (!reducedMotion() && typeof card.animate === "function") card.animate([{ scale: "1" }, { scale: "1.02" }], { duration: 200, easing: "ease-out" });
  d.lifted = true;
  d.chrome = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-h")) || 0;
  document.documentElement.classList.add("is-dragging-card");
  d.frame = requestAnimationFrame(() => edgeScroll(d));
}

/** Held near the top or bottom of the window, the page scrolls, faster the closer to the edge. */
function edgeScroll(d) {
  if (cardDrag !== d || d.settling) return;
  const top = d.chrome + CARD_DRAG_EDGE;
  const bottom = window.innerHeight - CARD_DRAG_EDGE;
  const pull = d.py < top ? -Math.min(1, (top - d.py) / CARD_DRAG_EDGE) : d.py > bottom ? Math.min(1, (d.py - bottom) / CARD_DRAG_EDGE) : 0;
  if (pull) {
    const was = window.scrollY;
    window.scrollBy({ top: pull * 16, behavior: "instant" });
    if (window.scrollY !== was) reorderTo(d.px, d.py);
  }
  d.frame = requestAnimationFrame(() => edgeScroll(d));
}

/** Let go: the card carries on at the pointer's speed into the gap, and takes its place there. */
function settleCard(d, velocity = { x: 0, y: 0 }) {
  cancelAnimationFrame(d.frame);
  d.settling = true;
  document.documentElement.classList.remove("is-dragging-card");
  d.card.classList.add("is-settling");
  const col = d.holder.parentElement.getBoundingClientRect();
  const to = { x: col.left + d.holder.offsetLeft - d.origin.x, y: col.top + d.holder.offsetTop - d.origin.y };
  let moving = 2;
  const done = () => { moving -= 1; if (!moving) placeCard(d); };
  d.motions = [
    springTo({ from: d.x, to: to.x, velocity: velocity.x, onUpdate: (v) => { d.x = v; showCard(d); }, onDone: done }),
    springTo({ from: d.y, to: to.y, velocity: velocity.y, onUpdate: (v) => { d.y = v; showCard(d); }, onDone: done })
  ];
}

/** The card back in the dashboard, in the gap. */
function placeCard(d) {
  if (cardDrag !== d) return;
  d.motions?.forEach((m) => m.stop());
  d.card.classList.remove("is-lifted", "is-settling");
  d.card.removeAttribute("style");
  dashboard.cards[dashboard.cards.indexOf(d.holder)] = d.card;
  d.holder.replaceWith(d.card);
  cardDrag = null;
  markCardEnds();
}

function onCardDragMove(e) {
  const d = cardDrag;
  if (!d || e.pointerId !== d.id) return;
  d.px = e.clientX;
  d.py = e.clientY;
  if (!d.lifted) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CARD_DRAG_START) return;
    liftCard(d);
  }
  // Under the pointer at the point it was grabbed.
  d.track.add(e.clientX, e.clientY);
  d.x = e.clientX - d.grabX;
  d.y = e.clientY - d.grabY;
  showCard(d);
  reorderTo(e.clientX, e.clientY);
}

function onCardDragEnd(e) {
  const d = cardDrag;
  if (!d || e.pointerId !== d.id) return;
  stopCardDragListening();
  if (d.lifted) settleCard(d, d.track.velocity());
  else cardDrag = null;
}

/** Escape puts the card back where it was before this drag. */
function onCardDragKey(e) {
  const d = cardDrag;
  if (e.key !== "Escape" || !d || d.settling) return;
  e.preventDefault();
  stopCardDragListening();
  if (!d.lifted) {
    cardDrag = null;
    return;
  }
  const byId = new Map(dashboard.cards.filter((el) => el.dataset.module).map((el) => [el.dataset.module, el]));
  arrangeCards(d.startOrder.map((id) => byId.get(id)).filter(Boolean));
  settleCard(d);
}

function stopCardDragListening() {
  window.removeEventListener("pointermove", onCardDragMove);
  window.removeEventListener("pointerup", onCardDragEnd);
  window.removeEventListener("pointercancel", onCardDragEnd);
  window.removeEventListener("keydown", onCardDragKey);
}

/** Any drag in progress is dropped (the dashboard is about to be drawn again). */
function endCardDrag() {
  const d = cardDrag;
  if (!d) return;
  stopCardDragListening();
  cancelAnimationFrame(d.frame);
  d.motions?.forEach((m) => m.stop());
  document.documentElement.classList.remove("is-dragging-card");
  if (d.lifted) d.card.remove();
  cardDrag = null;
}

// The card itself is the handle with a mouse; on a touch screen the grip is, so a finger
// elsewhere still scrolls the page. A card still gliding into place can be caught again.
$("view-home").addEventListener("pointerdown", (e) => {
  if (!dashboard.editing || e.button !== 0) return;
  const card = e.target.closest(".dash-card[data-module]");
  if (!card || card.classList.contains("dash-placeholder") || e.target.closest("button, a, input, select, textarea")) return;
  if (e.pointerType === "touch" && !e.target.closest(".dash-grip")) return;
  e.preventDefault();
  const d = cardDrag;
  if (d && d.settling && d.card === card) {
    d.motions.forEach((m) => m.stop());
    d.settling = false;
    d.last = null;
    card.classList.remove("is-settling");
    document.documentElement.classList.add("is-dragging-card");
    Object.assign(d, { id: e.pointerId, grabX: e.clientX - d.x, grabY: e.clientY - d.y, px: e.clientX, py: e.clientY, track: trackVelocity() });
    d.frame = requestAnimationFrame(() => edgeScroll(d));
  } else {
    if (d) placeCard(d);
    cardDrag = { card, id: e.pointerId, startX: e.clientX, startY: e.clientY, grabX: e.clientX, grabY: e.clientY, x: 0, y: 0, px: e.clientX, py: e.clientY,
      track: trackVelocity(), lifted: false, startOrder: dashboard.cards.filter((el) => el.dataset.module).map((el) => el.dataset.module) };
  }
  window.addEventListener("pointermove", onCardDragMove);
  window.addEventListener("pointerup", onCardDragEnd);
  window.addEventListener("pointercancel", onCardDragEnd);
  window.addEventListener("keydown", onCardDragKey);
});

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

$("home-lend").addEventListener("click", async () => {
  if (await lendBadgeDialog()) loadDashboard();
});

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

// --- finding a person or company ---------------------------------------------------------------------

// How many matches of each to fetch and to show: the best are chosen from those fetched.
const HOME_SEARCH_FETCH = 25;
const HOME_SEARCH_SHOWN = 6;
const homeSearch = { asked: 0, active: -1 };

/** Whose name begins with what was typed first, then a word of it, then anywhere; a match on another field last. */
function nameRank(name, q) {
  const n = String(name || "").toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.split(/\s+/).some((word) => word.startsWith(q))) return 1;
  return n.includes(q) ? 2 : 3;
}
const bestMatches = (list, nameOf, q) => list.map((row, i) => ({ row, i, rank: nameRank(nameOf(row), q) })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.row).slice(0, HOME_SEARCH_SHOWN);

function closeHomeSearch() {
  $("home-search-results").hidden = true;
  $("home-search-input").setAttribute("aria-expanded", "false");
  $("home-search-input").removeAttribute("aria-activedescendant");
  homeSearch.active = -1;
}

function homeSearchOptions() {
  return [...$("home-search-results").querySelectorAll("[role=option]")];
}

function markHomeSearchOption(index) {
  const options = homeSearchOptions();
  homeSearch.active = index;
  options.forEach((o, i) => { o.classList.toggle("is-active", i === index); o.setAttribute("aria-selected", String(i === index)); });
  if (options[index]) {
    $("home-search-input").setAttribute("aria-activedescendant", options[index].id);
    options[index].scrollIntoView({ block: "nearest" });
  } else $("home-search-input").removeAttribute("aria-activedescendant");
}

/** A match leaves the search empty behind it. */
function homeSearchChosen() {
  $("home-search-input").value = "";
  closeHomeSearch();
}

/** One kind of match under its heading, and a link to the whole list when there are more than fit. */
function homeSearchGroup(title, rows, total, rowFor, seeAll) {
  if (!rows.length) return [];
  return [
    h("div", { class: "label home-search-group", role: "presentation", text: title }),
    ...rows.map(rowFor),
    total > rows.length ? h("a", { class: "small-text dash-more", href: seeAll.href, onclick: () => { $(seeAll.input).value = $("home-search-input").value.trim(); homeSearchChosen(); }, text: `All ${total} in ${title}` }) : null
  ].filter(Boolean);
}

async function runHomeSearch() {
  const typed = $("home-search-input").value.trim();
  homeSearch.asked += 1;
  const asked = homeSearch.asked;
  if (!typed) return closeHomeSearch();
  const box = $("home-search-results");
  let content;
  try {
    const query = siteParams({ q: typed, limit: String(HOME_SEARCH_FETCH) });
    const [{ people, total: peopleTotal }, { companies, total: companiesTotal }] = await Promise.all([api(`/api/people?${query}`), api(`/api/companies?${query}`)]);
    // Typed on since, or signed out: this answer is no longer wanted.
    if (asked !== homeSearch.asked || !state.me) return null;
    const q = typed.toLowerCase();
    const option = (prefix, row, attrs) => h("div", { role: "option", id: `home-search-${prefix}-${row.id}`, "aria-selected": "false" }, dashRow(attrs));
    const peopleFound = bestMatches(people, personName, q);
    const companiesFound = bestMatches(companies, (c) => c.name, q);
    const peopleGroup = homeSearchGroup("People", peopleFound, peopleTotal, (p) => option("person", p, { href: `#person/${p.id}`, main: personName(p), sub: [p.jobTitle, p.companyName].filter(Boolean).join(" · ") || null }), { href: "#people", input: "people-search" });
    const companiesGroup = homeSearchGroup("Companies", companiesFound, companiesTotal, (c) => option("company", c, { href: `#company/${c.id}`, main: c.name, right: h("span", { class: "muted small-text", text: `${c.peopleCount ?? 0} ${c.peopleCount === 1 ? "person" : "people"}` }) }), { href: "#companies", input: "companies-search" });
    // Whichever matches by its name goes first: typing a company's name shouldn't bury it under its staff.
    const companyFirst = companiesFound.length && (!peopleFound.length || nameRank(companiesFound[0].name, q) < nameRank(personName(peopleFound[0]), q));
    content = companyFirst ? [...companiesGroup, ...peopleGroup] : [...peopleGroup, ...companiesGroup];
    if (!content.length) content = [h("p", { class: "muted small-text dash-empty", text: state.site ? `No one matches at ${siteName(state.site)}. The site button at the top switches to ${allSitesLabel().toLowerCase()}.` : "No one matches." })];
  } catch (error) {
    if (asked !== homeSearch.asked) return null;
    content = [h("p", { class: "message error small-text", text: error.message })];
  }
  box.replaceChildren(...content);
  box.hidden = false;
  $("home-search-input").setAttribute("aria-expanded", "true");
  homeSearch.active = -1;
  return null;
}

$("home-search-input").addEventListener("input", debounce(runHomeSearch, 150));
$("home-search-input").addEventListener("focus", () => { if ($("home-search-input").value.trim()) runHomeSearch(); });
$("home-search-input").addEventListener("keydown", (e) => {
  const options = homeSearchOptions();
  if (e.key === "Escape") {
    if ($("home-search-results").hidden) $("home-search-input").value = "";
    closeHomeSearch();
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options.length && !$("home-search-results").hidden) {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    markHomeSearchOption(homeSearch.active < 0 && step < 0 ? options.length - 1 : (homeSearch.active + step + options.length) % options.length);
  } else if (e.key === "Enter" && options.length && !$("home-search-results").hidden) {
    // The one marked, or the best match.
    e.preventDefault();
    location.hash = (options[homeSearch.active] || options[0]).querySelector("a").getAttribute("href");
    homeSearchChosen();
  }
});
$("home-search-results").addEventListener("click", (e) => { if (e.target.closest("[role=option]")) homeSearchChosen(); });
document.addEventListener("click", (e) => { if (!e.target.closest("#home-search")) closeHomeSearch(); });
$("home-reset").addEventListener("click", () => { dashboard.draft = [...state.prefs.defaults]; renderDashboard(); });
