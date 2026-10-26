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
