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

/** The CSV import dialog for "people" or "companies". Resolves true when something was imported. */
async function importDialog(kind) {
  const custom = state.schema[kind === "people" ? "person" : "company"].filter((f) => !f.builtIn && !f.recordOnly && f.access === "edit").map((f) => f.key);
  const columns = kind === "people"
    ? "first_name, last_name, company (required); preferred_name, job_title, email, work_phone, mobile, site, can_host, notes, active"
    : "name (required); sites, phone, email, website, address, notes, active";
  const intro = h("div", { class: "stack" },
    h("p", { text: `A CSV file with a header row. Columns: ${columns}${custom.length ? `, and your custom fields: ${custom.join(", ")}` : ""}.` }),
    kind === "people"
      ? h("p", { class: "muted", text: "Someone already in the company with the same email (or, without one, the same name) is updated rather than added twice. Columns for fields you can't change are skipped." })
      : h("p", { class: "muted", text: "A company with the same name is updated. Sites look like \"Harbour Point: Suite 100; Riverside\"." }),
    h("p", { class: "muted", text: "If any line has a problem, nothing is imported and the problems are listed." }));
  let text = null;
  const picked = h("span", { class: "muted", text: "No file chosen." });
  const choose = h("button", { type: "button", class: "secondary", text: "Choose file", onclick: async () => {
    text = await pickFileText();
    picked.textContent = text === null ? "No file chosen." : `${text.split(/\r?\n/).filter(Boolean).length - 1} rows read.`;
  } });
  const result = await formDialog({
    title: kind === "people" ? "Import people" : "Import companies",
    intro,
    wide: true,
    fields: [
      { node: h("div", { class: "full-row btn-row" }, choose, picked) },
      ...(kind === "people" ? [{ name: "createCompanies", label: "Add companies that don't exist yet", type: "checkbox", value: false }] : [])
    ],
    submitLabel: "Import",
    onSubmit: async (v) => {
      if (text === null) throw new Error("Choose a CSV file first.");
      return api(`/api/${kind}/import`, { method: "POST", body: { csv: text, createCompanies: Boolean(v.createCompanies) } });
    }
  });
  if (!result) return false;
  toast(`${result.added} added, ${result.updated} updated.${result.ignored.length ? ` Skipped columns: ${result.ignored.join(", ")}.` : ""}`);
  return true;
}

function showPeople() {
  loadPeople();
}
