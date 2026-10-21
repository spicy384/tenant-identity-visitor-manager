// 20-import.js: importing people or companies from an Access database (.accdb, .mdb) or a CSV
// file. Choose the file (and, for Access, the table), match its columns to the app's fields
// (suggested from their names), check a preview, then import. The server reads the file and
// holds it for a few minutes only; the import itself has the same checks as before, and is
// all or nothing.

const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/** The import's column for each built-in field, and the names a source column might go by. */
const IMPORT_FIELDS = {
  people: [
    { key: "first_name", field: "firstName", label: "First name", required: true, names: ["firstname", "first", "givenname", "forename", "fname"] },
    { key: "last_name", field: "lastName", label: "Last name", required: true, names: ["lastname", "surname", "familyname", "last", "lname"] },
    { key: "company", field: "company", label: "Company", required: true, names: ["company", "companyname", "firm", "firmname", "organisation", "organization", "employer", "tenant", "business"] },
    { key: "preferred_name", field: "preferredName", label: "Preferred name", names: ["preferredname", "nickname", "knownas"] },
    { key: "job_title", field: "jobTitle", label: "Job title", names: ["jobtitle", "title", "position", "role"] },
    { key: "email", field: "email", label: "Email", names: ["email", "emailaddress", "mail", "workemail"] },
    { key: "work_phone", field: "workPhone", label: "Work phone", names: ["workphone", "phone", "deskphone", "telephone", "tel", "officephone", "businessphone", "extension"] },
    { key: "mobile", field: "mobile", label: "Mobile", names: ["mobile", "mobilephone", "cell", "cellphone"] },
    { key: "site", field: "site", label: "Site", hint: "A site's name, as under Settings > Sites.", names: ["site", "building", "location"] },
    { key: "can_host", field: "canHost", label: "Can host visitors", hint: "yes or no", names: ["canhost", "host"] },
    { key: "notes", field: "notes", label: "Notes", names: ["notes", "note", "comments", "remarks"] },
    { key: "active", field: "active", label: "Active", hint: "yes or no", names: ["active", "current", "iscurrent", "enabled"] }
  ],
  companies: [
    { key: "name", field: "name", label: "Name", required: true, names: ["name", "company", "companyname", "firm", "firmname", "organisation", "organization", "tenant"] },
    { key: "site", field: "sites", label: "Site", hint: "A site's name, as under Settings > Sites.", names: ["site", "building", "location"] },
    { key: "suite", field: "sites", label: "Suite or floor", names: ["suite", "unit", "floor", "suiteorfloor"] },
    { key: "phone", field: "phone", label: "Phone", names: ["phone", "mainphone", "telephone", "tel", "switchboard"] },
    { key: "email", field: "email", label: "Email", names: ["email", "emailaddress", "mail"] },
    { key: "website", field: "website", label: "Website", names: ["website", "web", "url", "homepage"] },
    { key: "address", field: "address", label: "Address", names: ["address", "postaladdress", "street"] },
    { key: "notes", field: "notes", label: "Notes", names: ["notes", "note", "comments", "remarks"] },
    { key: "active", field: "active", label: "Active", hint: "yes or no", names: ["active", "current", "iscurrent", "enabled"] }
  ]
};

const normaliseName = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The fields this account may import into: built-in ones it can change, and its custom fields. */
function importTargets(kind) {
  const schema = state.schema[kind === "people" ? "person" : "company"] || [];
  const editable = new Set(schema.filter((f) => f.access === "edit" && f.builtIn).map((f) => f.key));
  const builtIn = IMPORT_FIELDS[kind].filter((t) => editable.has(t.field) || t.required);
  const custom = schema.filter((f) => !f.builtIn && !f.recordOnly && f.access === "edit")
    .map((f) => ({ key: f.key, label: f.label, custom: true, names: [normaliseName(f.key), normaliseName(f.label)] }));
  return [...builtIn, ...custom];
}

/** First guess at the matching: each field takes the first unused column whose name fits. */
function suggestMapping(targets, columns) {
  const used = new Set();
  const mapping = {};
  for (const t of targets) {
    const hit = columns.find((c) => !used.has(c.name) && (normaliseName(c.name) === normaliseName(t.key) || t.names.includes(normaliseName(c.name))));
    if (hit) {
      used.add(hit.name);
      mapping[t.key] = { column: hit.name };
    }
  }
  return mapping;
}

/** Sends the file itself (not JSON) and returns its tables. */
async function readImportFile(file, password) {
  const headers = { "content-type": "application/octet-stream" };
  if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  if (password) headers["x-import-password"] = password;
  const access = /\.(accdb|mdb)$/i.test(file.name);
  const res = await fetch(`/api/import/read?${new URLSearchParams({ name: file.name, format: access ? "access" : "csv" })}`, { method: "POST", headers, body: file, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The file couldn't be read (HTTP ${res.status}).`);
  return data;
}

/** The import dialog for "people" or "companies". Resolves true when something was imported. */
async function importDialog(kind) {
  const targets = importTargets(kind);
  const body = h("div", { class: "stack import-wizard" });
  let dlg = null;
  let target = kind;
  let file = null;
  let read = null;      // what the server read: { token, format, fileName, tables }
  let table = null;     // the chosen table: { name, columns, rowCount, sample }
  let mapping = {};
  const message = h("div", { class: "message error pre", hidden: true });
  const showError = (error) => { message.textContent = error.message || String(error); message.hidden = false; };
  const clearError = () => { message.hidden = true; };

  // --- step 1: the file ----------------------------------------------------------------------
  function stepFile() {
    const picker = h("input", { type: "file", accept: ".accdb,.mdb,.csv,text/csv", hidden: true });
    const chosen = h("span", { class: "muted", text: file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : "No file chosen." });
    const password = h("input", { type: "password", autocomplete: "off", placeholder: "Only if the database has one", "aria-label": "Database password" });
    const passwordRow = h("label", { hidden: !(file && /\.(accdb|mdb)$/i.test(file.name)) }, h("span", { text: "Database password" }), password);
    picker.addEventListener("change", () => {
      file = picker.files?.[0] || null;
      chosen.textContent = file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : "No file chosen.";
      passwordRow.hidden = !(file && /\.(accdb|mdb)$/i.test(file.name));
      clearError();
    });
    const into = h("select", { "aria-label": "Import into" }, h("option", { value: "people", text: "People" }), h("option", { value: "companies", text: "Companies" }));
    into.value = target;
    const next = h("button", { type: "button", class: "primary", text: "Read the file", onclick: async () => {
      clearError();
      if (!file) return showError(new Error("Choose a file first."));
      if (file.size > IMPORT_MAX_BYTES) return showError(new Error("The file is larger than 100 MB. Export just the table you need to CSV from Access instead."));
      next.disabled = true;
      next.textContent = "Reading…";
      try {
        target = into.value;
        read = await readImportFile(file, password.value);
        password.value = "";
        await chooseTable(read.tables.length === 1 ? read.tables[0].name : bestTable(read.tables));
      } catch (error) {
        showError(error);
        next.disabled = false;
        next.textContent = "Read the file";
      }
      return null;
    } });
    body.replaceChildren(
      h("p", { text: "From an Access database (.accdb or .mdb) or a CSV file. You'll match its columns to the app's fields next; nothing is saved until you import." }),
      h("label", {}, h("span", { text: "Import into" }), into),
      h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary", text: "Choose file", onclick: () => picker.click() }), chosen, picker),
      passwordRow,
      message,
      h("div", { class: "btn-row" }, next));
  }

  /** With several tables, the one whose columns best fit what is being imported. */
  function bestTable(tables) {
    const wanted = importTargets(target);
    const score = (t) => wanted.filter((w) => t.columns.some((c) => w.names.includes(normaliseName(c.name)))).length;
    return [...tables].sort((a, b) => score(b) - score(a) || b.rowCount - a.rowCount)[0].name;
  }

  async function chooseTable(name) {
    table = await api(`/api/import/${read.token}/table?${new URLSearchParams({ name })}`);
    mapping = suggestMapping(importTargets(target), table.columns);
    stepMatch();
  }

  // --- step 2: matching columns, and a preview ------------------------------------------------------
  function stepMatch() {
    const fieldsHere = importTargets(target);
    const preview = h("div", { class: "table-wrap" });
    const leftOver = h("p", { class: "muted small-text" });
    const sampleOf = (col) => table.sample.map((r) => r[col]).find((v) => v !== "") || "";
    const valueOf = (key, row) => {
      const m = mapping[key];
      if (!m) return "";
      return m.column ? row[m.column] : m.value || "";
    };
    function renderPreview() {
      const mapped = fieldsHere.filter((f) => mapping[f.key]);
      preview.replaceChildren(mapped.length
        ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, mapped.map((f) => h("th", { text: f.label })))),
          h("tbody", {}, table.sample.slice(0, 5).map((row) => h("tr", {}, mapped.map((f) => h("td", { class: "small-text", text: valueOf(f.key, row) }))))))
        : h("p", { class: "muted", text: "Match at least the required fields." }));
      const used = new Set(Object.values(mapping).map((m) => m.column).filter(Boolean));
      const unused = table.columns.filter((c) => !used.has(c.name)).map((c) => c.name);
      leftOver.textContent = unused.length ? `Not imported: ${unused.join(", ")}.` : "Every column is used.";
    }
    const rows = fieldsHere.map((f) => {
      const select = h("select", { "aria-label": `Where ${f.label} comes from` },
        h("option", { value: "", text: f.required ? "Choose a column" : "Not imported" }),
        table.columns.map((c) => h("option", { value: `col:${c.name}`, text: sampleOf(c.name) ? `${c.name}  (e.g. ${sampleOf(c.name).slice(0, 30)})` : c.name })),
        h("option", { value: "fixed", text: "The same for every row…" }));
      const fixed = h("input", { type: "text", placeholder: `${f.label} for every row`, "aria-label": `${f.label} for every row`, hidden: true });
      const current = mapping[f.key];
      select.value = current?.column ? `col:${current.column}` : current?.value !== undefined ? "fixed" : "";
      fixed.hidden = select.value !== "fixed";
      fixed.value = current?.value || "";
      const update = () => {
        fixed.hidden = select.value !== "fixed";
        if (select.value.startsWith("col:")) mapping[f.key] = { column: select.value.slice(4) };
        else if (select.value === "fixed") mapping[f.key] = { value: fixed.value };
        else delete mapping[f.key];
        renderPreview();
      };
      select.addEventListener("change", update);
      fixed.addEventListener("input", update);
      return h("div", { class: "import-match-row" },
        h("span", { class: "import-match-label" }, h("strong", { text: f.label }), f.required ? h("span", { class: "bad-text", text: " *" }) : null, f.custom ? h("span", { class: "muted small-text", text: " (custom)" }) : null,
          f.hint ? h("div", { class: "muted small-text", text: f.hint }) : null),
        h("span", { class: "import-match-source" }, select, fixed));
    });
    const createCompanies = h("input", { type: "checkbox" });
    const tablePick = read.tables.length > 1
      ? h("label", {}, h("span", { text: "Table" }), (() => {
        const s = h("select", { "aria-label": "Table" }, read.tables.map((t) => h("option", { value: t.name, text: `${t.name} (${t.rowCount} row${t.rowCount === 1 ? "" : "s"})` })));
        s.value = table.name;
        s.addEventListener("change", () => chooseTable(s.value).catch(showError));
        return s;
      })())
      : null;
    const label = `Import ${table.rowCount} ${target === "people" ? (table.rowCount === 1 ? "person" : "people") : (table.rowCount === 1 ? "company" : "companies")}`;
    const importBtn = h("button", { type: "button", class: "primary", text: label, onclick: async () => {
      clearError();
      const missing = fieldsHere.filter((f) => f.required && !(mapping[f.key]?.column || String(mapping[f.key]?.value || "").trim()));
      if (missing.length) return showError(new Error(`Match ${missing.map((f) => f.label).join(", ")} first.`));
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
      try {
        const result = await api(`/api/import/${read.token}/run`, { method: "POST", body: { table: table.name, target, mapping, createCompanies: createCompanies.checked } });
        dlg.finish(result);
      } catch (error) {
        showError(error);
        importBtn.disabled = false;
        importBtn.textContent = label;
      }
      return null;
    } });
    body.replaceChildren(
      h("p", { class: "muted", text: `${read.format === "access" ? "Access database" : "CSV file"} ${read.fileName}${read.tables.length > 1 ? `, ${read.tables.length} tables` : ""}. Match each field to a column, or give one value for every row. Matches were suggested from the column names.` }),
      tablePick,
      h("div", { class: "import-match" }, rows),
      leftOver,
      h("h4", { text: `Preview: the first ${Math.min(5, table.sample.length)} of ${table.rowCount}` }),
      preview,
      target === "people" ? h("label", { class: "check-row" }, createCompanies, h("span", { text: "Add companies that don't exist yet" })) : null,
      h("p", { class: "muted small-text", text: target === "people"
        ? "Someone already in the company with the same email (or, without one, the same name) is updated rather than added twice. If any row has a problem, nothing is imported and the problems are listed."
        : "A company with the same name is updated. If any row has a problem, nothing is imported and the problems are listed." }),
      message,
      h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary", text: "Back", onclick: () => { clearError(); stepFile(); } }), importBtn));
    renderPreview();
  }

  stepFile();
  const result = await openDialog({
    title: kind === "people" ? "Import people" : "Import companies",
    body,
    wide: true,
    actions: [{ label: "Cancel", value: null }],
    onOpen: (d) => { dlg = d; }
  });
  // Whatever happened, the server needn't hold the file any longer.
  if (read && !result) api(`/api/import/${read.token}`, { method: "DELETE" }).catch(() => {});
  if (!result) return false;
  toast(`${result.added} added, ${result.updated} updated.${result.ignored.length ? ` Skipped: ${result.ignored.join(", ")}.` : ""}`);
  return true;
}
