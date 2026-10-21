// 05-people.js: everyone in the directory across companies, with search, CSV import
// and export.

const PEOPLE_PAGE = 100;
const peopleView = { offset: 0, total: 0 };

async function loadPeople() {
  const q = $("people-search").value.trim();
  const params = new URLSearchParams({ limit: String(PEOPLE_PAGE), offset: String(peopleView.offset), ...(q ? { q } : {}), ...($("people-inactive").checked ? { all: "1" } : {}), ...siteQuery() });
  const table = $("people-table");
  let data;
  try {
    data = await api(`/api/people?${params}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(1, error.message));
    return;
  }
  peopleView.total = data.total;
  const fresh = peopleTable(data.people, { withCompany: true, onOpen: (p) => { location.hash = `#person/${p.id}`; } }).querySelector("table");
  table.replaceChildren(...fresh.children);
  if (!data.people.length) clear(table.tBodies[0]).append(emptyRow(table.tHead.rows[0].cells.length, q ? "Nobody matches." : "Nobody yet. Add a company, then its people."));
  const from = data.total ? peopleView.offset + 1 : 0;
  $("people-page").textContent = `${from}-${peopleView.offset + data.people.length} of ${data.total}`;
  $("people-prev").disabled = peopleView.offset === 0;
  $("people-next").disabled = peopleView.offset + PEOPLE_PAGE >= data.total;
}

const reloadPeople = debounce(() => { peopleView.offset = 0; loadPeople(); }, 250);
$("people-search").addEventListener("input", reloadPeople);
$("people-inactive").addEventListener("change", reloadPeople);
$("people-prev").addEventListener("click", () => { peopleView.offset = Math.max(0, peopleView.offset - PEOPLE_PAGE); loadPeople(); });
$("people-next").addEventListener("click", () => { peopleView.offset += PEOPLE_PAGE; loadPeople(); });

$("people-add").addEventListener("click", async () => {
  if (await newPersonDialog()) loadPeople();
});

$("people-export").addEventListener("click", () => {
  download(`/api/people.csv?${new URLSearchParams(siteQuery())}`).catch((error) => toast(error.message, "error"));
});

$("people-import").addEventListener("click", () => importDialog("people").then((done) => { if (done) loadPeople(); }));

// The import dialog (Access or CSV, with column matching) is in 20-import.js.

function showPeople() {
  loadPeople();
}
