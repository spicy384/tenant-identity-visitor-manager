// 03-records.js: showing and editing records from the fields the server says the
// signed-in person can see. Nothing here decides access: the server leaves hidden
// fields out of everything it sends and refuses changes to fields that aren't
// editable; these helpers only build the matching forms and fact lists.

async function loadSchema() {
  state.schema = await api("/api/schema");
}

const canReadDirectory = () => ["read", "edit"].includes(state.config?.access?.directory);

/** A field's current value on a record, in the field's own terms. */
function fieldValue(record, f) {
  if (!record) return null;
  if (f.builtIn) {
    if (f.key === "company") return record.companyId ?? null;
    if (f.key === "site") return record.siteId ?? null;
    return record[f.key] ?? null;
  }
  return record.custom?.[f.key] ?? null;
}

function sitesText(list) {
  return (list || []).map((s) => (s.suite ? `${s.siteName}: ${s.suite}` : s.siteName)).join("; ");
}

/** A value as text or a link, for fact lists and tables. */
function displayValue(f, value, record = null) {
  if (value === null || value === undefined || value === "") return null;
  if (f.key === "company" && f.builtIn) return record?.companyName || null;
  if (f.key === "site" && f.builtIn) return record?.siteName || "Any site";
  if (f.type === "sites") return sitesText(value) || null;
  if (f.type === "links") return (value || []).map((l) => (l.hostName ? `${l.companyName} (host: ${l.hostName})` : l.companyName)).join("; ") || null;
  if (f.type === "datetime") return fmtDateTime(value) || null;
  if (f.type === "clearance") return clearanceText(record);
  if (f.type === "clearanceStatus") return CLEARANCE_STATUS[value]?.label || null;
  if (f.type === "boolean") return value ? "Yes" : "No";
  if (f.type === "date") return fmtDate(Date.parse(`${value}T12:00:00`));
  if ((f.type === "url") && /^https?:\/\//i.test(value)) return h("a", { href: value, target: "_blank", rel: "noopener noreferrer", text: value.replace(/^https?:\/\//i, "") });
  if (f.type === "email") return h("a", { href: `mailto:${value}`, text: value });
  if (f.type === "phone") return h("a", { href: `tel:${String(value).replace(/[^\d+]/g, "")}`, text: value });
  return String(value);
}

/** A definition list of the record's visible fields that have a value, `skip` left out. */
function recordFacts(fields, record, skip = []) {
  const dl = h("dl", { class: "facts inline-facts" });
  for (const f of fields) {
    if (skip.includes(f.key)) continue;
    if (f.type === "site" && !multiSite()) continue; // one site: nothing to say
    const shown = displayValue(f, fieldValue(record, f), record);
    if (shown === null) continue;
    dl.append(h("dt", {}, f.label, f.recordOnly ? h("span", { class: "muted small-text", text: " (this record only)" }) : null),
      h("dd", { class: f.type === "longtext" ? "pre" : null }, shown));
  }
  return dl.children.length ? dl : h("p", { class: "muted", text: "No other details." });
}

/** "TS//SCI", with "(expired)" when its expiry date has passed. */
function clearanceText(record) {
  if (!record?.clearanceLevelName) return "None";
  const expired = record.clearanceExpires && record.clearanceExpires < localToday();
  return `${record.clearanceLevelName}${expired ? ` (expired ${fmtDate(Date.parse(`${record.clearanceExpires}T12:00:00`))})` : ""}`;
}

/** Today as YYYY-MM-DD on this device. */
function localToday(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const INPUT_TYPES = { text: "text", phone: "tel", email: "email", url: "url", number: "number", date: "date" };
const formName = (f) => (f.builtIn ? f.key : `custom:${f.key}`);

/**
 * The site and suite editor for a company: one row per site the caller can use, a tick
 * to place the company there and its suite or floor. With a single site, just the suite.
 * Returns { node, value() }.
 */
function sitesEditor(current = []) {
  const usable = state.config.sites.filter((s) => s.active || current.some((c) => c.siteId === s.id));
  const rows = usable.map((site) => {
    const now = current.find((c) => c.siteId === site.id);
    const tick = h("input", { type: "checkbox", "aria-label": `At ${site.name}` });
    tick.checked = Boolean(now) || (usable.length === 1);
    const suite = h("input", { type: "text", placeholder: "Suite or floor", value: now?.suite || "", "aria-label": `Suite at ${site.name}` });
    suite.value = now?.suite || "";
    const sync = () => { suite.disabled = !tick.checked; };
    tick.addEventListener("change", sync);
    sync();
    return { site, tick, suite };
  });
  const single = rows.length === 1;
  const node = h("div", { class: "full-row sites-editor" },
    h("span", { class: "label", text: single ? "Suite or floor" : "Sites, and the suite or floor at each" }),
    rows.map((r) => (single
      ? r.suite
      : h("div", { class: "site-row" }, h("label", { class: "check-row" }, r.tick, h("span", { text: r.site.name })), r.suite))));
  return {
    node,
    value: () => rows.filter((r) => r.tick.checked).map((r) => ({ siteId: r.site.id, suite: r.suite.value.trim() || null }))
  };
}

/** Options for a person's site: "Any site" plus the sites their company is at. */
function siteOptionsFor(company) {
  return [{ value: "", label: "Any site" }, ...(company?.sites || []).map((s) => ({ value: String(s.siteId), label: s.siteName }))];
}

/**
 * formDialog fields for a record: inputs for editable fields, read-only rows for the
 * rest (on an existing record). `companies` is the company list for a person's company
 * picker. Returns { fields, collect(values, inputs) } where collect builds the request
 * body holding only what changed.
 */
function recordForm(fields, record = null, { companies = [], fixedCompanyId = null } = {}) {
  const specs = [];
  let sites = null;
  const editable = [];
  for (const f of fields) {
    // With one site (or an account that sees one), a person's site is not a choice:
    // the server places them there.
    if (f.type === "site" && !multiSite()) continue;
    // A visitor's companies have their own controls in the visitor dialog.
    if (f.type === "links") continue;
    const value = fieldValue(record, f);
    if (f.access !== "edit") {
      if (record) {
        const shown = displayValue(f, value, record);
        if (shown !== null) specs.push({ type: "readonly", name: formName(f), label: f.label, value: typeof shown === "string" ? shown : shown.textContent, pre: f.type === "longtext" });
      }
      continue;
    }
    editable.push(f);
    const base = { name: formName(f), label: f.recordOnly ? `${f.label} (this record only)` : f.label, required: f.required };
    if (f.type === "sites") {
      sites = sitesEditor(value || []);
      specs.push({ node: sites.node });
    } else if (f.type === "company") {
      specs.push({ ...base, type: "select", value: String(value ?? fixedCompanyId ?? ""), options: [{ value: "", label: "Choose a company" }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))],
        onChange: (input, inputs) => {
          const site = inputs.site;
          if (!site) return;
          const company = companies.find((c) => String(c.id) === input.value);
          const before = site.value;
          clear(site).append(...siteOptionsFor(company).map((o) => h("option", { value: o.value, text: o.label })));
          site.value = [...site.options].some((o) => o.value === before) ? before : "";
          site.closest("label").hidden = !multiSite() && !(company?.sites || []).length;
        } });
    } else if (f.type === "site") {
      const company = companies.find((c) => c.id === (record?.companyId ?? fixedCompanyId));
      specs.push({ ...base, type: "select", value: value ? String(value) : "", options: siteOptionsFor(company), half: true, hint: "Where they work, when their company is at more than one site." });
    } else if (f.type === "boolean") {
      // Built-in yes/no fields (active, can host, checked) start ticked on a new record; blocked doesn't.
      if (f.builtIn) specs.push({ ...base, type: "checkbox", value: record ? value : f.key !== "blocked" });
      else specs.push({ ...base, type: "select", value: value === true ? "yes" : value === false ? "no" : "", options: [{ value: "", label: "—" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }], half: true });
    } else if (f.type === "clearance") {
      specs.push({ ...base, type: "select", value: value ? String(value) : "", half: true, options: [{ value: "", label: "None" }, ...(state.config.clearanceLevels || []).map((l) => ({ value: String(l.id), label: l.name }))] });
    } else if (f.type === "choice") {
      specs.push({ ...base, type: "select", value: value ?? "", options: [{ value: "", label: "—" }, ...f.choices.map((c) => ({ value: c, label: c }))], half: true });
    } else if (f.type === "longtext") {
      specs.push({ ...base, type: "textarea", value: value ?? "", rows: 2 });
    } else {
      const half = !["name"].includes(f.key);
      specs.push({ ...base, type: INPUT_TYPES[f.type] || "text", value: value ?? "", half, step: f.type === "number" ? "any" : undefined, autofocus: ["name", "firstName"].includes(f.key) });
    }
  }

  function collect(values) {
    const body = {};
    const custom = {};
    for (const f of editable) {
      const before = fieldValue(record, f);
      if (f.type === "sites") {
        const after = sites.value();
        if (!record || JSON.stringify(after) !== JSON.stringify((before || []).map((s) => ({ siteId: s.siteId, suite: s.suite || null })))) body.sites = after;
        continue;
      }
      let after = values[formName(f)];
      if (f.type === "company") after = after ? Number(after) : null;
      else if (f.type === "site") after = after ? Number(after) : null;
      else if (f.type === "clearance") after = after ? Number(after) : null;
      else if (f.type === "boolean" && !f.builtIn) after = after === "yes" ? true : after === "no" ? false : null;
      else if (f.type === "number") after = after === "" ? null : Number(after);
      else if (typeof after === "string") after = after.trim() === "" ? null : after.trim();
      const same = (before ?? null) === (after ?? null);
      if (record && same) continue;
      if (!record && (after === null || after === "") && f.type !== "boolean") continue;
      if (f.builtIn) body[f.key === "company" ? "companyId" : f.key === "site" ? "siteId" : f.key] = after;
      else custom[f.key] = after === null ? "" : after;
    }
    if (Object.keys(custom).length) body.custom = custom;
    return body;
  }

  return { fields: specs, collect, editableCount: editable.length };
}

/** Adds a custom field to one record (administrators), then calls `done`. */
async function addRecordField(entity, recordId, recordName, done) {
  const { types } = await api("/api/fields");
  const created = await formDialog({
    title: `Add a field to ${recordName} only`,
    intro: h("p", { class: "muted", text: "It shows on this record alone. Under Settings > Fields it can later be made a field every record has." }),
    fields: [
      { name: "label", label: "Field name", required: true, placeholder: "Loading dock" },
      { name: "type", label: "Type", type: "select", value: "text", options: types, half: true, onChange: (input, inputs) => { inputs.choices.closest("label").hidden = input.value !== "choice"; } },
      { name: "visibility", label: "Who sees it", type: "select", value: "all", half: true, options: VISIBILITY_OPTIONS },
      { name: "choices", label: "Choices, one per line", type: "textarea", rows: 3 }
    ],
    submitLabel: "Add field",
    onSubmit: async (v) => (await api("/api/fields", { method: "POST", body: { ...v, entity, recordId } })).field
  });
  if (created) {
    toast(`Added "${created.label}".`);
    await done();
  }
}

const VISIBILITY_OPTIONS = [
  { value: "all", label: "Everyone who can see the record" },
  { value: "editors", label: "Only those who can change the directory" },
  { value: "admins", label: "Only administrators (set the rest under Field access)" }
];
