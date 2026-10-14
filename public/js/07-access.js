// 07-access.js: the field access grid (Settings > Field access). One row per field, one
// column per role, each cell hidden, read only or can change. Administrators have no
// column: they always see and change everything.

async function settingsAccess(body) {
  const grid = await api("/api/field-access");
  const changes = new Map(); // "role|entity|field" -> { roleId, entity, field, access }
  const save = h("button", { type: "button", class: "primary", text: "Save changes", disabled: true });
  const status = h("span", { class: "muted" });

  const refresh = () => {
    save.disabled = !changes.size;
    status.textContent = changes.size ? `${changes.size} unsaved change${changes.size === 1 ? "" : "s"}` : "";
  };

  /** The levels a cell may take: no "can change" for a role that can't change the directory. */
  function levelsFor(role, field) {
    const levels = [];
    if (!field.locked) levels.push("hidden");
    levels.push("view");
    if (role.kind === "user" && role[grid.areas[field.entity]] === "edit" && !field.system && !field.security) levels.push("edit");
    // Clearance details only for roles that see clearance levels (Settings > Roles).
    if (field.sensitive && !role.clearances) return ["hidden"];
    return levels;
  }

  function cell(role, entity, field) {
    const current = field.access[role.id];
    if (role[grid.areas[entity]] === "none") return h("td", { class: "muted small-text", text: "No access" });
    const select = h("select", { class: `access-select level-${current}`, "aria-label": `${field.label} for ${role.name}` },
      levelsFor(role, { ...field, entity }).map((l) => h("option", { value: l, text: ACCESS_LABELS[l] })));
    select.value = current;
    select.addEventListener("change", () => {
      const key = `${role.id}|${entity}|${field.key}`;
      if (select.value === current) changes.delete(key);
      else changes.set(key, { roleId: role.id, entity, field: field.key, access: select.value });
      select.className = `access-select level-${select.value}${select.value !== current ? " changed" : ""}`;
      refresh();
    });
    return h("td", {}, select);
  }

  const intro = h("div", { class: "panel" },
    h("h3", { text: "Field access" }),
    h("p", { text: "Choose what each role sees of every field. Hidden fields are left out of everything that role gets: pages, searches, exports and (later) Equipment Checkout. A search never matches on a field the searcher can't see. The kiosk isn't here: it only ever shows a visitor their own first name and the names of the company and host they came to see." }),
    h("p", { class: "muted", text: "Names, a person's company, a company's sites and a visitor's companies and status can't be hidden from anyone who can see the record. Read-only roles can't be given \"Can change\". Companies and people follow a role's directory access; visitors its visitor access. Administrators always see and change everything." }),
    h("div", { class: "btn-row" }, save, status));

  body.append(intro);
  for (const entity of ["company", "person", "visitor"]) {
    const fields = grid.entities[entity];
    body.append(h("div", { class: "panel" },
      h("h3", { text: { company: "Companies", person: "People", visitor: "Visitors" }[entity] }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact access-grid" },
        h("thead", {}, h("tr", {}, h("th", { text: "Field" }), grid.roles.map((r) => h("th", {}, r.name, r.kind !== "user" ? h("div", { class: "muted small-text", text: r.builtIn ? "template for new API clients" : "API client" }) : null)))),
        h("tbody", {}, fields.map((f) => h("tr", {},
          h("th", { scope: "row" }, f.label, f.builtIn ? null : h("span", { class: "muted small-text", text: f.recordId === null ? " (custom)" : " (one record)" })),
          grid.roles.map((r) => cell(r, entity, f)))))))));
  }

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/api/field-access", { method: "PUT", body: { changes: [...changes.values()] } });
      toast(`Saved ${changes.size} change${changes.size === 1 ? "" : "s"}.`);
      await loadSchema();
      renderSettings();
    } catch (error) {
      toast(error.message, "error");
      refresh();
    }
  });
}
