// 11-visits.js: the visit log, with filters and CSV export, and the visits table the
// visitor dialog shares.

const VISITS_PAGE = 100;
const visitsView = { offset: 0 };

const CHECKOUT_LABELS = { kiosk: "at the kiosk", staff: "by staff", auto: "at end of day" };

/** A table of visits. showVisitor: include the visitor's name (the log does, the visitor dialog doesn't). */
function visitsTable(visits, { showVisitor = true } = {}) {
  const allSites = multiSite();
  const head = ["Arrived", "Left", ...(showVisitor ? ["Visitor"] : []), "Visiting", "Host", ...(allSites ? ["Site"] : [])];
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, head.map((t) => h("th", { text: t })))),
    h("tbody", {}, visits.length ? visits.map((v) => h("tr", {},
      h("td", { class: "nowrap small-text", text: fmtDateTime(v.checkedInAt) }),
      h("td", { class: "small-text" }, v.checkedOutAt
        ? [fmtDateTime(v.checkedOutAt), h("div", { class: "muted", text: CHECKOUT_LABELS[v.checkoutMethod] || "" })]
        : h("span", { class: "badge ok", text: "In the building" })),
      showVisitor ? h("td", {}, h("a", { href: `#visitor/${v.visitorId}`, text: visitorName(v.visitor) }), v.visitor.organisation ? h("div", { class: "muted small-text", text: v.visitor.organisation }) : null) : null,
      h("td", { text: v.companyName || "" }, v.purpose ? h("div", { class: "muted small-text", text: v.purpose }) : null),
      h("td", { text: v.hostName || "" }),
      allSites ? h("td", { class: "small-text", text: v.siteName }) : null)) : emptyRow(head.length, "No visits."))));
}

function visitsQuery() {
  const q = $("visits-search").value.trim();
  return {
    status: $("visits-status").value,
    ...($("visits-from").value ? { from: $("visits-from").value } : {}),
    ...($("visits-to").value ? { to: $("visits-to").value } : {}),
    ...(q ? { q } : {}),
    ...siteQuery()
  };
}

async function loadVisits() {
  const table = $("visits-table");
  let data;
  try {
    data = await api(`/api/visits?${new URLSearchParams({ ...visitsQuery(), limit: String(VISITS_PAGE), offset: String(visitsView.offset) })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(1, error.message));
    return;
  }
  const fresh = visitsTable(data.visits).querySelector("table");
  table.replaceChildren(...fresh.children);
  const from = data.total ? visitsView.offset + 1 : 0;
  $("visits-page").textContent = `${from}-${visitsView.offset + data.visits.length} of ${data.total}`;
  $("visits-prev").disabled = visitsView.offset === 0;
  $("visits-next").disabled = visitsView.offset + VISITS_PAGE >= data.total;
}

const reloadVisits = debounce(() => { visitsView.offset = 0; loadVisits(); }, 250);
for (const id of ["visits-status", "visits-from", "visits-to"]) $(id).addEventListener("change", reloadVisits);
$("visits-search").addEventListener("input", reloadVisits);
$("visits-prev").addEventListener("click", () => { visitsView.offset = Math.max(0, visitsView.offset - VISITS_PAGE); loadVisits(); });
$("visits-next").addEventListener("click", () => { visitsView.offset += VISITS_PAGE; loadVisits(); });
$("visits-export").addEventListener("click", () => {
  download(`/api/visits.csv?${new URLSearchParams(visitsQuery())}`).catch((error) => toast(error.message, "error"));
});

function showVisits() {
  loadVisits();
}
