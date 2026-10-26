// 14-api-clients.js: Settings > API clients: the keys other systems (Equipment Checkout)
// use to read the directory, the sites each sees, whether it may add people, and the
// fields it receives.

async function settingsApiClients(body) {
  const { clients, fields } = await api("/api/api-clients");
  const siteNames = (ids) => (ids ? ids.map((id) => state.config.sites.find((s) => s.id === id)?.name || `site ${id}`).join(", ") : "Every site");
  body.append(
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: "API clients" }), h("button", { type: "button", class: "primary small", text: "Add API client", onclick: () => editApiClient(null, fields) })),
      h("p", { class: "muted", text: "Each Equipment Checkout installation (or any other system) gets its own key. It sees only the companies at its sites and their people, and only the fields ticked for it. Nothing about visitors is shared." }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Client", ...(multiSite() ? ["Sites"] : []), "Can", "Key", "Last used", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, clients.length ? clients.map((c) => h("tr", {},
          h("td", {}, h("strong", { text: c.name }), h("div", { class: "muted small-text", text: `${c.fields.person.length} people fields, ${c.fields.company.length} company fields` })),
          multiSite() ? h("td", { class: "small-text", text: siteNames(c.sites) }) : null,
          h("td", { class: "small-text", text: c.canWrite ? "Read, add people and companies" : "Read" }),
          h("td", { class: "mono small-text", text: c.keyHint || "" }),
          h("td", { class: "small-text" }, c.lastUsedAt ? fmtDateTime(c.lastUsedAt) : "Never", c.lastIp ? h("div", { class: "muted mono", text: c.lastIp }) : null),
          h("td", {}, h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editApiClient(c, fields) }),
            h("button", { type: "button", class: "link-btn", text: "New key", onclick: () => newApiKey(c) }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => removeApiClient(c) })))))
          : emptyRow(multiSite() ? 6 : 5, "No API clients yet."))))),
    h("div", { class: "panel" },
      h("h3", { text: "Connecting Equipment Checkout" }),
      h("ol", { class: "plain-list numbered" },
        h("li", {}, "Add an API client here for it, with the sites it serves. Tick \"Can add people\" so the desk's New person button works."),
        h("li", {}, "In Equipment Checkout: Settings > Directory, choose Identity and Visitor Manager, and enter ", h("code", { class: "copy", text: location.origin }), " and the key."),
        h("li", {}, "Checkout keeps its own copy and refreshes it every 5 minutes, so it keeps working if this system is down."))));
}

/** Ticks for the fields a client receives; locked ones are always on. Returns { node, value() }. */
function apiFieldPicker(fields, current) {
  const columns = [];
  const ticks = { company: [], person: [] };
  for (const [entity, title] of [["person", "People"], ["company", "Companies"]]) {
    const list = h("div", { class: "field-ticks" });
    for (const f of fields[entity]) {
      const box = h("input", { type: "checkbox" });
      box.checked = f.locked || (current ? current[entity].includes(f.key) : false);
      if (f.locked) box.disabled = true;
      ticks[entity].push({ key: f.key, box });
      list.append(h("label", { class: "check-row" }, box, h("span", { text: f.label }), f.builtIn ? null : h("span", { class: "muted small-text", text: " (custom)" })));
    }
    columns.push(h("div", {}, h("h4", { class: "form-heading", text: title }), list));
  }
  return {
    node: h("div", { class: "full-row field-tick-columns" }, columns),
    value: () => Object.fromEntries(Object.entries(ticks).map(([e, l]) => [e, l.filter((t) => t.box.checked).map((t) => t.key)]))
  };
}

/** The template's fields (the built-in Equipment Checkout column), for a new client. */
async function templateApiFields() {
  const grid = await api("/api/field-access");
  const keyOf = (f) => (f.builtIn ? f.key : f.apiKey);
  const pick = (entity) => grid.entities[entity].filter((f) => f.recordId === null && f.access.checkout && f.access.checkout !== "hidden").map(keyOf);
  return { company: pick("company"), person: pick("person") };
}

async function showApiKey(client, key) {
  const box = h("input", { type: "text", readonly: true, class: "mono key-box", value: key });
  box.value = key;
  await openDialog({
    title: `Key for ${client.name}`,
    wide: true,
    body: h("div", { class: "stack" },
      h("p", { text: "Copy it into the other system now. It isn't shown again; if it is lost, make a new one." }),
      box,
      h("button", { type: "button", class: "secondary small", text: "Copy", onclick: async () => {
        try {
          await navigator.clipboard.writeText(key);
          toast("Copied.");
        } catch {
          box.select();
          toast("Select the key and copy it.", "error");
        }
      } })),
    onOpen: () => box.select()
  });
}

async function editApiClient(client, fields) {
  const picker = multiSite() ? siteLimitPicker(client ? client.sites : null) : null;
  const ticks = apiFieldPicker(fields, client ? client.fields : await templateApiFields());
  const result = await formDialog({
    title: client ? `Edit ${client.name}` : "Add API client",
    wide: true,
    fields: [
      { name: "name", label: "Name", required: true, value: client?.name, placeholder: "Equipment Checkout, Harbor Point" },
      ...(picker ? [{ node: picker.node }] : []),
      { name: "canWrite", label: "Can add people and companies (Equipment Checkout's New person button needs this)", type: "checkbox", value: client ? client.canWrite : true },
      { type: "heading", label: "Fields it receives" },
      { node: ticks.node }
    ],
    submitLabel: client ? "Save" : "Add and show key",
    onSubmit: async (v) => {
      const body = { name: v.name, canWrite: v.canWrite, fields: ticks.value(), ...(picker ? { sites: picker.value() } : {}) };
      return client ? api(`/api/api-clients/${client.id}`, { method: "PUT", body }) : api("/api/api-clients", { method: "POST", body });
    }
  });
  if (!result) return;
  if (result.key) await showApiKey(result.client, result.key);
  else toast("Saved.");
  renderSettings();
}

async function newApiKey(client) {
  if (!(await confirmDialog(`Make a new key for ${client.name}? The current key stops working at once; the system using it needs the new one.`, { confirmLabel: "New key" }))) return;
  try {
    const result = await api(`/api/api-clients/${client.id}/key`, { method: "POST", body: {} });
    await showApiKey(result.client, result.key);
  } catch (error) {
    toast(error.message, "error");
  }
  renderSettings();
}

async function removeApiClient(client) {
  if (!(await confirmDialog(`Remove ${client.name}? Its key stops working at once.`, { danger: true, confirmLabel: "Remove" }))) return;
  try {
    await api(`/api/api-clients/${client.id}`, { method: "DELETE" });
    renderSettings();
  } catch (error) {
    toast(error.message, "error");
  }
}
