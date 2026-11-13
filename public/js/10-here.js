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

/**
 * Asks of each badge a visitor has whether it was returned. One badge: two buttons. Several: a
 * choice for each, all to be made. Resolves [{ id, returned }], or null when closed unanswered.
 * leaving: they are being checked out now (Cancel keeps them in); else they have left already.
 */
function badgeReturnDialog(name, badges, { leaving = true } = {}) {
  const title = leaving ? `Check out ${name}` : `${name}'s badge${badges.length === 1 ? "" : "s"}`;
  const cancel = leaving ? [{ label: "Cancel", value: null }] : [];
  if (badges.length === 1) {
    const [b] = badges;
    return openDialog({
      title,
      body: h("div", { class: "stack" },
        h("p", { class: "badge-return-ask" }, `${name} has badge `, h("strong", { class: "mono", text: b.label }), ". Was it returned?"),
        h("p", { class: "muted small-text", text: "Not returned: it stays out with them, among the badges out past their time, until it is taken back." })),
      actions: [...cancel, { label: "Not returned", value: [{ id: b.id, returned: false }] }, { label: "Returned", kind: "primary", value: [{ id: b.id, returned: true }] }]
    });
  }
  const answers = new Map();
  const rows = badges.map((b) => {
    const pick = (returned, on, off) => { answers.set(b.id, returned); on.classList.add("is-active"); on.setAttribute("aria-pressed", "true"); off.classList.remove("is-active"); off.setAttribute("aria-pressed", "false"); };
    const yes = h("button", { type: "button", "aria-pressed": "false", text: "Returned" });
    const no = h("button", { type: "button", "aria-pressed": "false", text: "Not returned" });
    yes.addEventListener("click", () => pick(true, yes, no));
    no.addEventListener("click", () => pick(false, no, yes));
    return h("li", { class: "row-between" }, h("strong", { class: "mono", text: b.label }), h("div", { class: "segmented", role: "group", "aria-label": `Badge ${b.label}` }, yes, no));
  });
  return openDialog({
    title,
    body: h("div", { class: "stack" },
      h("p", { class: "badge-return-ask", text: `${name} has ${badges.length} badges. Was each returned?` }),
      h("ul", { class: "plain-list" }, rows),
      h("p", { class: "muted small-text", text: "Not returned: it stays out with them, among the badges out past their time, until it is taken back." })),
    actions: [...cancel, { label: leaving ? "Check out" : "Save", kind: "primary", onClick: () => {
      if (badges.some((b) => !answers.has(b.id))) throw new Error("Say of each badge whether it was returned.");
      return badges.map((b) => ({ id: b.id, returned: answers.get(b.id) }));
    } }]
  });
}

/** "Badge V-1 taken back." / "Badge V-1 is still out with them.", for the toast after a check-out. */
function badgeReturnText(badges) {
  const labels = (list) => `Badge${list.length === 1 ? "" : "s"} ${list.map((b) => b.label).join(", ")}`;
  const back = badges.filter((b) => b.returned);
  const kept = badges.filter((b) => !b.returned);
  return [back.length ? `${labels(back)} taken back.` : null, kept.length ? `${labels(kept)} ${kept.length === 1 ? "is" : "are"} still out with them.` : null].filter(Boolean).join(" ");
}

/**
 * Checks a visitor out of a visit, from any Check out button. While they have a badge the
 * server asks first whether it was returned, and so does this. Resolves true once they are
 * checked out, false when the question was closed without an answer (they stay in).
 */
async function checkOutVisit(v, name = visitorName(v.visitor)) {
  let body = {};
  // Asked again if they were given another badge meanwhile.
  for (let asked = 0; ; asked += 1) {
    try {
      const done = await api(`/api/visits/${v.id}/checkout`, { method: "POST", body });
      toast([`${name} checked out.`, badgeReturnText(done.badges || [])].filter(Boolean).join(" "));
      refreshCounts();
      return true;
    } catch (error) {
      if (error.data?.code !== "badges_out" || asked > 2) throw error;
      const answers = await badgeReturnDialog(name, error.data.badges);
      if (!answers) return false;
      body = { badges: answers };
    }
  }
}

/**
 * After a corrected time checked a visitor out: asks of the badges they still have whether
 * each was returned, and takes back those that were.
 */
async function settleBadgesAfterVisit(v, badges) {
  const name = visitorName(v.visitor);
  const answers = (await badgeReturnDialog(name, badges, { leaving: false })) || [];
  const back = answers.filter((a) => a.returned);
  for (const a of back) await api(`/api/badges/${a.id}/return`, { method: "POST", body: { outcome: "returned" } });
  const said = badges.map((b) => ({ ...b, returned: back.some((a) => a.id === b.id) }));
  toast(badgeReturnText(said));
  refreshCounts();
}

async function loadHere() {
  const table = $("here-table");
  const allSites = multiSite() && !state.site;
  const showOrg = Boolean(visitorField("organization"));
  const head = ["Visitor", ...(showOrg ? ["Company"] : []), "Visiting", "Host", ...(allSites ? ["Site"] : []), "Arrived", ""];
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
    showOrg ? h("td", { text: v.visitor.organization || "" }) : null,
    h("td", { text: v.companyName || "" }),
    h("td", { text: v.hostName || "" }),
    allSites ? h("td", { text: v.siteName }) : null,
    h("td", { class: "nowrap" }, new Date(v.checkedInAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), h("span", { class: "muted small-text no-print", text: ` · ${sinceText(v.checkedInAt)}` })),
    h("td", { class: "no-print" }, h("div", { class: "btn-row" }, canCorrectVisits() ? h("button", { type: "button", class: "link-btn small-text nowrap", text: "Correct time", onclick: async () => { if (await correctVisitTimes(v)) loadHere(); } }) : null, canEditVisitors() ? h("button", { type: "button", class: "secondary small", text: "Check out", onclick: async (e) => {
      e.target.disabled = true;
      try {
        if (await checkOutVisit(v)) loadHere();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        e.target.disabled = false;
      }
    } }) : null))));
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
  if (await checkInWizard()) loadHere();
});

function showHere() {
  loadHere();
  clearInterval(hereTimer);
  hereTimer = setInterval(() => {
    if (state.view === "here" && !document.hidden && !document.querySelector("dialog[open]")) loadHere();
    else if (state.view !== "here") clearInterval(hereTimer);
  }, 30 * 1000);
}
