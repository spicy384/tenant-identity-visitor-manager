// 20-import.js: importing people, companies, visitors, badges or validated clearances from an Access database (.accdb, .mdb) or a CSV
// file. Choose the file (and, for Access, the table), match its columns to the app's fields
// (suggested from their names), check a preview, then import. The server reads the file and
// holds it for a few minutes only; the import itself has the same checks as before, and is
// all or nothing.

const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

// The Import buttons on the Visitors and Badges pages (People has its own, in 05-people.js).
$("visitors-import").addEventListener("click", () => importDialog("visitors").then((done) => { if (done) loadVisitors(); }));
$("badges-import").addEventListener("click", () => importDialog("badges").then((done) => { if (done) loadBadges(); }));

/** The import's column for each built-in field, and the names a source column might go by. */
const IMPORT_FIELDS = {
  people: [
    { key: "first_name", field: "firstName", label: "First name", required: true, names: ["firstname", "first", "givenname", "forename", "fname"] },
    { key: "last_name", field: "lastName", label: "Last name", required: true, names: ["lastname", "surname", "familyname", "last", "lname"] },
    { key: "company", field: "company", label: "Company", required: true, names: ["company", "companyname", "firm", "firmname", "organization", "organization", "employer", "tenant", "business"] },
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
    { key: "name", field: "name", label: "Name", required: true, names: ["name", "company", "companyname", "firm", "firmname", "organization", "organization", "tenant"] },
    { key: "site", field: "sites", label: "Site", hint: "A site's name, as under Settings > Sites.", names: ["site", "building", "location"] },
    { key: "suite", field: "sites", label: "Suite or floor", names: ["suite", "unit", "floor", "suiteorfloor"] },
    { key: "phone", field: "phone", label: "Phone", names: ["phone", "mainphone", "telephone", "tel", "switchboard"] },
    { key: "email", field: "email", label: "Email", names: ["email", "emailaddress", "mail"] },
    { key: "website", field: "website", label: "Website", names: ["website", "web", "url", "homepage"] },
    { key: "address", field: "address", label: "Address", names: ["address", "postaladdress", "street"] },
    { key: "notes", field: "notes", label: "Notes", names: ["notes", "note", "comments", "remarks"] },
    { key: "active", field: "active", label: "Active", hint: "yes or no", names: ["active", "current", "iscurrent", "enabled"] }
  ],
  visitors: [
    { key: "first_name", field: "firstName", label: "First name", required: true, names: ["firstname", "first", "givenname", "forename", "fname"] },
    { key: "last_name", field: "lastName", label: "Last name", required: true, names: ["lastname", "surname", "familyname", "last", "lname"] },
    { key: "organization", field: "organization", label: "Their company", names: ["organization", "organisation", "org", "employer", "theircompany", "from"] },
    { key: "visitor_type", field: "visitorType", label: "Visitor type", hint: "Guest or Service Technician", names: ["visitortype", "type", "kind"] },
    { key: "citizenship", field: "citizenship", label: "Citizenship", hint: "The country, by name or code (US for a U.S. citizen)", names: ["citizenship", "nationality", "country", "citizen"] },
    { key: "email", field: "email", label: "Email", names: ["email", "emailaddress", "mail"] },
    { key: "phone", field: "phone", label: "Phone", names: ["phone", "telephone", "tel", "mobile", "cell"] },
    { key: "company", field: "companies", label: "Company they visit", hint: "A tenant company's name.", names: ["company", "visiting", "visitingfirm", "visitingcompany", "tenant", "firm"] },
    { key: "host", field: "companies", label: "Their host", hint: "Someone in that company, by name.", names: ["host", "hostname", "visiting_person", "contact"] },
    { key: "notes", field: "notes", label: "Notes", names: ["notes", "note", "comments", "remarks"] },
    { key: "blocked", field: "blocked", label: "Blocked", hint: "yes or no", names: ["blocked", "banned", "barred", "denied"] },
    // Security only: each visitor validated on the date given.
    { key: "level", label: "Clearance level", security: true, hint: "A level's name, or Uncleared. Each visitor with one is validated by you, on the date validated.", names: ["level", "clearance", "clearancelevel", "lvl", "classification"] },
    { key: "validated", label: "Date validated", security: true, hint: "YYYY-MM-DD or M/D/YYYY. Empty for today.", names: ["validated", "datevalidated", "validatedon", "validateddate", "validationdate", "verified", "dateverified", "verifiedon"] },
    { key: "granted", label: "Clearance granted", security: true, names: ["granted", "dategranted", "grantdate", "granteddate", "grantedon"] },
    { key: "expires", label: "Clearance expires", security: true, names: ["expires", "expiry", "expiration", "expirationdate", "expirydate", "expireson", "clearanceexpires"] }
  ],
  badges: [
    { key: "facility_code", label: "Facility code", hint: "2 or 3 digits, if the badge has one", names: ["facilitycode", "facility", "fc", "sitecode", "facilitycodenumber"] },
    { key: "number", label: "Badge number", required: true, names: ["number", "badgenumber", "badgeno", "badge", "no", "cardnumber"] },
    { key: "type", label: "Type", required: true, hint: "personnel (or staff), tenant or visitor", names: ["type", "kind", "badgetype"] },
    { key: "level", label: "Clearance level", clearance: true, hint: "A level's name, or Uncleared. Empty is Uncleared for a new badge, and leaves an existing one's as it is.", names: ["level", "lvl", "clearance", "clearancelevel", "classification", "class"] },
    { key: "sites", label: "Valid at", hint: "Site names separated by ;. Empty for every site.", names: ["sites", "site", "validat", "building", "location"] },
    { key: "temporary", label: "Temporary", hint: "yes or no", names: ["temporary", "temp", "spare", "loaner"] },
    { key: "expires", label: "Expires", hint: "The date it expires (YYYY-MM-DD or M/D/YYYY); empty for none, or to leave an existing badge's as it is.", names: ["expires", "expiry", "expiration", "expirationdate", "expirydate", "expireson", "expdate", "validuntil", "validto", "enddate"] },
    { key: "status", label: "Status", hint: "active, lost or retired", names: ["status", "state"] },
    { key: "notes", label: "Notes", names: ["notes", "note", "comments", "remarks"] }
  ],
  // Clearances validated elsewhere, onto people and visitors already on record (Security).
  clearances: [
    { key: "name", label: "Name", hint: "\"First Last\", \"Last, First\" or \"Last First\". Or match First name and Last name instead.", names: ["name", "fullname", "personname", "employeename", "employee", "person", "lastfirst", "firstlast"] },
    { key: "first_name", label: "First name", names: ["firstname", "first", "givenname", "forename", "fname"] },
    { key: "last_name", label: "Last name", names: ["lastname", "surname", "familyname", "last", "lname"] },
    { key: "kind", label: "Person or visitor", hint: "person or visitor. Empty looks at both. Choose \"The same for every row\" for a file of one or the other.", names: ["kind", "personorvisitor", "persontype", "recordtype", "visitororperson"] },
    { key: "company", label: "Company", hint: "Only needed to tell apart two with the same name: a person's company, or a visitor's own company or the tenant they visit.", names: ["company", "companyname", "firm", "organization", "employer", "tenant"] },
    { key: "email", label: "Email", hint: "Found by email first, when there is one.", names: ["email", "emailaddress", "mail", "workemail"] },
    { key: "level", label: "Clearance level", required: true, hint: "A level's name, or Uncleared.", names: ["level", "clearance", "clearancelevel", "lvl", "classification"] },
    { key: "validated", label: "Date validated", hint: "YYYY-MM-DD or M/D/YYYY. Empty for today.", names: ["validated", "datevalidated", "validatedon", "validateddate", "validationdate", "dateofvalidation", "verified", "dateverified", "verifiedon", "date"] },
    { key: "granted", label: "Granted", hint: "When the clearance was granted, if known.", names: ["granted", "dategranted", "grantdate", "granteddate", "grantedon"] },
    { key: "expires", label: "Expires", hint: "When the clearance expires, if it does.", names: ["expires", "expiry", "expiration", "expirationdate", "expirydate", "expireson", "expdate"] },
    // For visitors added from the file (with "Add visitors who aren't on record yet").
    { key: "visiting", label: "Company they visit", hint: "For visitors added: the tenant they visit. Needed if your account is limited to some sites.", names: ["visiting", "visitingcompany", "visitingfirm", "companyvisited", "hostcompany"] },
    { key: "phone", label: "Phone", hint: "For visitors added.", names: ["phone", "telephone", "tel", "mobile", "cell"] },
    { key: "citizenship", label: "Citizenship", hint: "For visitors added: the country, by name or code.", names: ["citizenship", "nationality", "country", "citizen"] },
    { key: "visitor_type", label: "Visitor type", hint: "For visitors added: Guest or Service Technician.", names: ["visitortype"] },
    { key: "notes", label: "Notes", hint: "For visitors added.", names: ["notes", "note", "comments", "remarks"] }
  ]
};

/** What this account may import, and the words for it. */
const IMPORT_KINDS = {
  people: { label: "People", one: "person", many: "people", may: () => canEditDirectory(), entity: "person", matched: "same company and email, or without one the same name" },
  companies: { label: "Companies", one: "company", many: "companies", may: () => canEditDirectory(), entity: "company", matched: "same name" },
  visitors: { label: "Visitors", one: "visitor", many: "visitors", may: () => canEditVisitors(), entity: "visitor", matched: "same email, or without one the same name" },
  badges: { label: "Badges", one: "badge", many: "badges", may: () => canManageBadges(), entity: null, matched: "same facility code and number" },
  clearances: { label: "Clearances (people and visitors)", one: "clearance", many: "clearances", may: () => isSecurity(), entity: null, added: (n) => `${n === 1 ? "visitor" : "visitors"} added, with their clearance`, updated: "validated", unchanged: "validated more recently here, left as they were" }
};

const normalizeName = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The fields this account may import into: built-in ones it can change, and its custom fields. */
function importTargets(kind) {
  if (kind === "clearances") return IMPORT_FIELDS.clearances;
  // Badges have no field grid: every column, the level only for those who see clearance levels.
  if (kind === "badges") {
    const custom = (state.schema.badge || []).filter((f) => !f.builtIn && !f.recordOnly && f.access === "edit")
      .map((f) => ({ key: f.key, label: f.label, custom: true, names: [normalizeName(f.key), normalizeName(f.label)] }));
    return [...IMPORT_FIELDS.badges.filter((t) => !t.clearance || canSeeClearances()), ...custom];
  }
  const schema = state.schema[IMPORT_KINDS[kind].entity] || [];
  const editable = new Set(schema.filter((f) => f.access === "edit" && f.builtIn).map((f) => f.key));
  const builtIn = IMPORT_FIELDS[kind].filter((t) => (t.security ? isSecurity() && canSeeClearances() : editable.has(t.field) || t.required));
  const custom = schema.filter((f) => !f.builtIn && !f.recordOnly && f.access === "edit")
    .map((f) => ({ key: f.key, label: f.label, custom: true, names: [normalizeName(f.key), normalizeName(f.label)] }));
  return [...builtIn, ...custom];
}

/** First guess at the matching: each field takes the first unused column whose name fits. */
function suggestMapping(targets, columns) {
  const used = new Set();
  const mapping = {};
  for (const t of targets) {
    const hit = columns.find((c) => !used.has(c.name) && (normalizeName(c.name) === normalizeName(t.key) || t.names.includes(normalizeName(c.name))));
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
  const showError = (error, extra = null) => { message.replaceChildren(error.message || String(error), extra ? h("div", { class: "btn-row import-retry" }, extra) : ""); message.hidden = false; };
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
    const into = h("select", { "aria-label": "Import into" }, Object.entries(IMPORT_KINDS).filter(([, k]) => k.may()).map(([value, k]) => h("option", { value, text: k.label })));
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
    const score = (t) => wanted.filter((w) => t.columns.some((c) => w.names.includes(normalizeName(c.name)))).length;
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
    const addVisitors = h("input", { type: "checkbox" });
    const skipProblems = h("input", { type: "checkbox" });
    const tablePick = read.tables.length > 1
      ? h("label", {}, h("span", { text: "Table" }), (() => {
        const s = h("select", { "aria-label": "Table" }, read.tables.map((t) => h("option", { value: t.name, text: `${t.name} (${t.rowCount} row${t.rowCount === 1 ? "" : "s"})` })));
        s.value = table.name;
        s.addEventListener("change", () => chooseTable(s.value).catch(showError));
        return s;
      })())
      : null;
    const label = `Import ${table.rowCount} ${table.rowCount === 1 ? IMPORT_KINDS[target].one : IMPORT_KINDS[target].many}`;
    // skip: import what can be, leaving out (and listing) the rows with problems.
    const run = async (skip) => {
      clearError();
      const missing = fieldsHere.filter((f) => f.required && !(mapping[f.key]?.column || String(mapping[f.key]?.value || "").trim()));
      if (missing.length) return showError(new Error(`Match ${missing.map((f) => f.label).join(", ")} first.`));
      if (target === "clearances" && !mapping.name && !(mapping.first_name && mapping.last_name)) return showError(new Error("Match Name, or First name and Last name, first."));
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
      try {
        const result = await api(`/api/import/${read.token}/run`, { method: "POST", body: { table: table.name, target, mapping, createCompanies: createCompanies.checked, addVisitors: addVisitors.checked, skipProblems: skip } });
        dlg.finish(result);
      } catch (error) {
        // Nothing was imported because of some rows: offer to import the rest without them.
        const byRows = error.status === 400 && /^Nothing was imported\./.test(error.message);
        showError(error, byRows ? h("button", { type: "button", class: "secondary small", text: "Import the rest, skipping these rows", onclick: () => { skipProblems.checked = true; run(true); } }) : null);
        importBtn.disabled = false;
        importBtn.textContent = label;
      }
      return null;
    };
    const importBtn = h("button", { type: "button", class: "primary", text: label, onclick: () => run(skipProblems.checked) });
    body.replaceChildren(
      h("p", { class: "muted", text: `${read.format === "access" ? "Access database" : "CSV file"} ${read.fileName}${read.tables.length > 1 ? `, ${read.tables.length} tables` : ""}. Match each field to a column, or give one value for every row. Matches were suggested from the column names.` }),
      tablePick || "",
      h("div", { class: "import-match" }, rows),
      leftOver,
      h("h4", { text: `Preview: the first ${Math.min(5, table.sample.length)} of ${table.rowCount}` }),
      preview,
      // replaceChildren would write out null as text, so "" where there is nothing.
      target === "people" ? h("label", { class: "check-row" }, createCompanies, h("span", { text: "Add companies that don't exist yet" })) : "",
      target === "clearances" ? h("label", { class: "check-row" }, addVisitors, h("span", { text: "Add visitors who aren't on record yet: anyone the file names who isn't found is added as a visitor, with their clearance" })) : "",
      h("label", { class: "check-row" }, skipProblems, h("span", { text: "Skip rows with problems (such as a required field left empty): import the rest, and list the ones skipped" })),
      h("p", { class: "muted small-text", text: `${{
        people: "Someone already in the company with the same email (or, without one, the same name) is updated rather than added twice.",
        companies: "A company with the same name is updated.",
        visitors: `A visitor with the same email (or, without one, the same name) is updated rather than added twice. Imported visitors count as checked by staff. ${isSecurity() ? "Visitors with a clearance level are validated by you, on the date validated (unless validated more recently here)." : "Clearances aren't imported: Security validates them."}`,
        badges: "A badge with the same facility code and number is updated; a file that gives the same badge twice is refused. One that is out can't change its type, clearance level or whether it is temporary.",
        clearances: "Each row validates the clearance of a person or visitor already on record; nobody is added unless you tick Add visitors below. They're found by email, else by name in any order (only among people or visitors, or at a company, when those columns are given), and validated on the date given, by you. Anyone validated more recently here is left as they are. A name that matches nobody, or more than one, is a problem to fix."
      }[target]} Rows with nothing in them are passed over. Otherwise, if any row has a problem, nothing is imported and the problems are listed, unless you skip rows with problems.` }),
      message,
      h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary", text: "Back", onclick: () => { clearError(); stepFile(); } }), importBtn));
    renderPreview();
  }

  stepFile();
  const result = await openDialog({
    title: `Import ${IMPORT_KINDS[kind].many}`,
    body,
    wide: true,
    actions: [{ label: "Cancel", value: null }],
    onOpen: (d) => { dlg = d; }
  });
  // Whatever happened, the server needn't hold the file any longer.
  if (read && !result) api(`/api/import/${read.token}`, { method: "DELETE" }).catch(() => {});
  if (!result) return false;
  if (result.skippedCount) await showSkippedRows(kind, result);
  else if (result.updated || result.blank || result.unchanged) await showImportCounts(kind, result);
  else toast(`${result.added} added.${result.ignored.length ? ` Columns left out: ${result.ignored.join(", ")}.` : ""}`);
  return true;
}

/**
 * After an import that updated records already here or passed over empty rows: every row of
 * the file accounted for, so a file that added fewer than it had rows says why.
 */
async function showImportCounts(kind, result) {
  const many = IMPORT_KINDS[kind].many;
  const total = result.added + result.updated + (result.unchanged || 0) + result.blank;
  const line = (n, text) => (n ? h("li", { text: `${n.toLocaleString()} ${text}` }) : null);
  await openDialog({
    title: `Imported ${many}`,
    body: h("div", { class: "stack" },
      h("p", { text: `The file had ${total.toLocaleString()} ${total === 1 ? "row" : "rows"}:` }),
      h("ul", {},
        line(result.added, IMPORT_KINDS[kind].added?.(result.added) || "added"),
        line(result.updated, IMPORT_KINDS[kind].updated || `already here, and updated (${IMPORT_KINDS[kind].matched || "matched"})`),
        line(result.unchanged, IMPORT_KINDS[kind].unchanged || "already here, left as they were"),
        line(result.blank, `empty in every column imported, passed over`)),
      result.ignored.length ? h("p", { class: "muted small-text", text: `Columns left out: ${result.ignored.join(", ")}.` }) : null),
    actions: [{ label: "OK", value: true, kind: "primary" }]
  });
}

/**
 * After an import that skipped rows: what was imported, each skipped row with where it was and
 * why, and the skipped rows as a CSV (with a "problem" column) to fix and import again.
 */
async function showSkippedRows(kind, result) {
  const rows = result.skipped;
  const columns = [...new Set(rows.flatMap((x) => Object.keys(x.row)))];
  const download = () => {
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [[...columns, "problem"].map(cell).join(","), ...rows.map((x) => [...columns.map((c) => x.row[c]), `${x.where}: ${x.reason}`].map(cell).join(","))];
    const a = h("a", { href: URL.createObjectURL(new Blob([`\ufeff${lines.join("\r\n")}\r\n`], { type: "text/csv" })), download: `skipped-${IMPORT_KINDS[kind].many.replace(/\s+/g, "-")}.csv` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  // Clearances add nobody: they validate people and visitors already here.
  const done = kind === "clearances" ? `${result.added ? `${result.added} ${IMPORT_KINDS.clearances.added(result.added).replace(", with their clearance", "")}, ` : ""}${result.updated} validated${result.unchanged ? `, ${result.unchanged} left as they were` : ""}` : `${result.added} added, ${result.updated} updated`;
  const summary = `${done}, ${result.skippedCount} ${result.skippedCount === 1 ? "row" : "rows"} skipped${result.blank ? `, ${result.blank} empty ${result.blank === 1 ? "row" : "rows"} passed over` : ""}.`;
  await openDialog({
    title: `Imported ${IMPORT_KINDS[kind].many}, with rows skipped`,
    wide: true,
    body: h("div", { class: "stack" },
      h("p", {}, h("strong", { text: summary }), result.ignored.length ? h("span", { class: "muted", text: ` Columns left out: ${result.ignored.join(", ")}.` }) : null),
      h("p", { class: "muted small-text", text: "These rows weren't imported. Download them to fix them and import that file; the problem column says what to change." }),
      h("div", { class: "table-wrap skipped-rows" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Row", "Problem", ...columns.slice(0, 4)].map((t) => h("th", { text: t })))),
        h("tbody", {}, rows.map((x) => h("tr", {},
          h("td", { class: "nowrap small-text", text: x.where }),
          h("td", { class: "small-text", text: x.reason }),
          columns.slice(0, 4).map((c) => h("td", { class: "small-text", text: x.row[c] ?? "" }))))))),
      rows.length < result.skippedCount ? h("p", { class: "muted small-text", text: `The first ${rows.length} of ${result.skippedCount} are shown and downloaded.` }) : null),
    actions: [
      { label: "Download skipped rows (CSV)", kind: "secondary", close: false, onClick: () => { download(); } },
      { label: "Close", kind: "primary", value: true }
    ]
  });
}
