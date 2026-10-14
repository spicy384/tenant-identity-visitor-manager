// 10-here.js: who is in the building now, checking people out, checking them in from the
// desk, and the printable evacuation list.

let hereTimer = null;

function sinceText(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ${mins % 60} min` : `${Math.floor(hours / 24)} days`;
}

function hereSiteName() {
  const site = state.config.sites.find((s) => String(s.id) === String(state.site));
  return site ? site.name : multiSite() ? "All sites" : state.config.sites[0]?.name || "";
}

async function loadHere() {
  const table = $("here-table");
  const allSites = multiSite() && !state.site;
  const showOrg = Boolean(visitorField("organisation"));
  const head = ["Visitor", ...(showOrg ? ["Organisation"] : []), "Visiting", "Host", ...(allSites ? ["Site"] : []), "Arrived", ""];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  $("here-title").textContent = `In the building${multiSite() ? `: ${hereSiteName()}` : ""}`;
  let data;
  try {
    data = await api(`/api/visits?${new URLSearchParams({ status: "open", limit: "1000", ...siteQuery() })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  const rows = data.visits.map((v) => h("tr", {},
    h("td", {}, h("a", { href: `#visitor/${v.visitorId}`, text: visitorName(v.visitor) }), v.visitor.blocked ? h("span", { class: "badge bad", text: "Blocked" }) : null, v.visitor.verified === false ? h("span", { class: "badge warn no-print", text: "New" }) : null),
    showOrg ? h("td", { text: v.visitor.organisation || "" }) : null,
    h("td", { text: v.companyName || "" }),
    h("td", { text: v.hostName || "" }),
    allSites ? h("td", { text: v.siteName }) : null,
    h("td", { class: "nowrap" }, new Date(v.checkedInAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), h("span", { class: "muted small-text no-print", text: ` · ${sinceText(v.checkedInAt)}` })),
    h("td", { class: "no-print" }, canEditVisitors() ? h("button", { type: "button", class: "secondary small", text: "Check out", onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api(`/api/visits/${v.id}/checkout`, { method: "POST", body: {} });
        toast(`${visitorName(v.visitor)} checked out.`);
        loadHere();
        refreshCounts();
      } catch (error) {
        toast(error.message, "error");
        e.target.disabled = false;
      }
    } }) : null)));
  clear(table.tBodies[0]).append(...(rows.length ? rows : [emptyRow(head.length, "Nobody is checked in right now.")]));
  $("here-print-title").textContent = `In the building: ${hereSiteName()} (${data.visits.length} ${data.visits.length === 1 ? "visitor" : "visitors"})`;
  $("here-print-time").textContent = `As of ${new Date().toLocaleString()}`;
  const left = state.config.visits?.badgesLeft || 0;
  $("here-note").replaceChildren(...["This list refreshes every 30 seconds.", left && canReadBadges() ? h("span", {}, " ", h("a", { href: "#badges", onclick: () => { $("badges-state").value = "left"; }, text: `${left} visitor badge${left === 1 ? " is" : "s are"} still out with visitors who have left.` })) : null].filter(Boolean));
}

$("here-print").addEventListener("click", async () => {
  await loadHere();
  window.print();
});

$("here-checkin").addEventListener("click", async () => {
  const visitor = await findVisitorDialog();
  if (visitor && (await staffCheckIn(visitor))) loadHere();
});

/** Finds a visitor by name, or adds a new one. Resolves to the visitor, or null. */
async function findVisitorDialog() {
  const results = h("div", { class: "choices-list" });
  const search = h("input", { type: "search", placeholder: "Type the visitor's name", autocomplete: "off" });
  let dlg = null;
  const run = debounce(async () => {
    const q = search.value.trim();
    clear(results);
    if (q.length < 2) return;
    const { visitors } = await api(`/api/visitors?${new URLSearchParams({ q, limit: "15" })}`);
    for (const v of visitors) {
      results.append(h("button", { type: "button", class: "pick-row", onclick: () => dlg.finish(v) },
        h("strong", { text: visitorName(v) }), " ", visitorBadges(v),
        h("span", { class: "muted small-text", text: ` ${[v.organisation, (v.companies || []).map((c) => c.companyName).join(", ")].filter(Boolean).join(" · ")}` })));
    }
    if (!visitors.length) results.append(h("p", { class: "muted", text: "Nobody by that name yet." }));
  }, 250);
  search.addEventListener("input", run);
  const chosen = await openDialog({
    title: "Check someone in",
    wide: true,
    body: h("div", { class: "stack" }, search, results),
    actions: [{ label: "Cancel", value: null }, { label: "Add a new visitor", value: "new" }],
    onOpen: (d) => { dlg = d; setTimeout(() => search.focus(), 50); }
  });
  if (chosen === "new") {
    const words = search.value.trim().split(/\s+/);
    return newVisitorDialog({ firstName: words[0] || "", lastName: words.slice(1).join(" ") });
  }
  return chosen;
}

/** Checks a visitor in from the desk: site, company, host and purpose. Resolves true when done. */
async function staffCheckIn(visitor) {
  const usable = state.config.sites.filter((s) => s.active);
  const siteId = state.site || (usable.length === 1 ? String(usable[0].id) : "");
  if (!siteId && usable.length > 1) {
    // Ask for the site first: the companies to choose from depend on it.
    const site = await formDialog({
      title: `Check ${visitor.firstName} in at`,
      fields: [{ name: "siteId", label: "Site", type: "select", options: usable.map((s) => ({ value: String(s.id), label: s.name })) }],
      submitLabel: "Next",
      onSubmit: (v) => v.siteId
    });
    if (!site) return false;
    return staffCheckInAt(visitor, site);
  }
  return staffCheckInAt(visitor, siteId);
}

async function staffCheckInAt(visitor, siteId) {
  const companies = await companiesAt(siteId);
  const usual = (visitor.companies || []).find((c) => companies.some((x) => x.id === c.companyId));
  const blocked = visitor.blocked;
  // Visitor badges they may hold, to hand over with the check-in.
  let badgeChoices = [];
  if (canEditBadges()) badgeChoices = (await api(`/api/badge-holders/visitor/${visitor.id}`).catch(() => ({ available: [] }))).available.filter((b) => !b.sites.length || b.sites.some((s) => String(s.id) === String(siteId)));
  const result = await formDialog({
    title: `Check in ${visitorName(visitor)}`,
    intro: blocked ? h("p", { class: "message error", text: `${visitorName(visitor)} is blocked. Only let them in if a manager has agreed.` }) : null,
    fields: [
      ...companyHostFields(companies, { companyId: usual?.companyId || "", hostId: usual?.hostId || "", siteId }),
      { name: "purpose", label: "Purpose (optional)", placeholder: "Meeting, interview, delivery…" },
      ...(badgeChoices.length ? [{ name: "badgeId", label: "Visitor badge", type: "select", value: "", options: [{ value: "", label: "No badge" }, ...badgeChoices.map((b) => ({ value: String(b.id), label: `${b.number} · ${[b.classificationName, b.clearanceLevelName].filter(Boolean).join(" ")}` }))], hint: "It stays with them until someone takes it back." }] : []),
      ...(blocked ? [{ name: "overrideBlock", label: "A manager has agreed to let them in", type: "checkbox", value: false }] : [])
    ],
    submitLabel: "Check in",
    onSubmit: async (v) => {
      const r = await api("/api/visits", { method: "POST", body: { visitorId: visitor.id, siteId: Number(siteId), companyId: Number(v.companyId), hostId: v.hostId ? Number(v.hostId) : null, purpose: v.purpose, overrideBlock: Boolean(v.overrideBlock) } });
      if (v.badgeId) {
        try {
          await api(`/api/badges/${v.badgeId}/assign`, { method: "POST", body: { kind: "visitor", holderId: visitor.id, visitId: r.visit.id } });
          r.badge = badgeChoices.find((b) => String(b.id) === v.badgeId)?.number;
        } catch (error) {
          toast(`Checked in, but the badge wasn't given: ${error.message}`, "error");
        }
      }
      return r;
    }
  });
  if (!result) return false;
  toast(result.already ? `${visitorName(visitor)} is already checked in.` : `${visitorName(visitor)} checked in${result.badge ? ` with badge ${result.badge}` : ""}.`);
  refreshCounts();
  return true;
}

function showHere() {
  loadHere();
  clearInterval(hereTimer);
  hereTimer = setInterval(() => {
    if (state.view === "here" && !document.hidden && !document.querySelector("dialog[open]")) loadHere();
    else if (state.view !== "here") clearInterval(hereTimer);
  }, 30 * 1000);
}
