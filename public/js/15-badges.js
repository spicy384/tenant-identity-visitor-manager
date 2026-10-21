// 15-badges.js: the Badges page, a badge's dialog (details, holder, history), giving out
// and taking back badges, the badge section on person and visitor dialogs, and
// Settings > Badges and clearances.

const BADGES_PAGE = 200;
// picked: badges chosen to change several at once (Security; 21-bulk.js), id -> the badge as listed.
const badgesView = { offset: 0, picked: new Map() };
const BADGE_TYPE_LABELS = { personnel: "Personnel", tenant: "Tenant", visitor: "Visitor" };
const BADGE_STATUS_LABELS = { active: "Active", lost: "Lost", retired: "Retired" };
let clearanceCache = null;

async function clearanceInfo(fresh = false) {
  if (!clearanceCache || fresh) clearanceCache = await api("/api/clearance");
  return clearanceCache;
}

function badgeClassText(b) {
  return [b.classificationName, b.clearanceLevelName].filter(Boolean).join(" · ");
}

/** A badge template image from its ref (the server never says which level it is): small, or large. */
function templateImg(ref, { large = false, alt = "Badge image" } = {}) {
  return ref ? h("img", { class: large ? "badge-template-large" : "badge-thumb", src: `/api/badge-templates/${encodeURIComponent(ref)}/image`, alt, loading: "lazy" }) : null;
}

/** The template kind for a badge type: visitor badges have their own image, the rest the tenant one. */
const templateKind = (type) => (type === "visitor" ? "visitor" : "tenant");

/**
 * Badges on offer as a list to pick from, each with its image, the one matching
 * `suggested` first. With `allowNone`, "No badge" is the first choice. Returns
 * { node, value() (badge id or ""), chosen() (the badge or null) }.
 */
function badgePicker(list, { suggested = null, allowNone = false, label = "Badge to give" } = {}) {
  const name = `badge-pick-${Math.random().toString(36).slice(2, 8)}`;
  const ordered = [...list].sort((a, b) => Number(b.template === suggested && Boolean(suggested)) - Number(a.template === suggested && Boolean(suggested)));
  const row = (value, children, checked) => {
    const input = h("input", { type: "radio", name, value });
    input.checked = checked;
    return h("label", { class: "badge-pick-row" }, input, children);
  };
  const node = h("div", { class: "badge-pick-list", role: "radiogroup", "aria-label": label },
    allowNone ? row("", h("span", { text: "No badge" }), true) : null,
    ordered.map((b, i) => row(String(b.id), [
      templateImg(b.template) || h("span", { class: "badge-thumb empty", title: "No image for this badge yet" }),
      h("span", { class: "mono", text: b.number }),
      h("span", { class: "muted small-text", text: [badgeClassText(b), multiSite() ? badgeSitesText(b) : null].filter(Boolean).join(" · ") })
    ], !allowNone && i === 0)));
  const value = () => node.querySelector("input:checked")?.value || "";
  return { node, value, chosen: () => list.find((b) => String(b.id) === value()) || null };
}

/** The large image of the badge to hand over, when the server has one for them. */
function suggestedBadge(ref) {
  return ref ? h("figure", { class: "badge-suggest" }, templateImg(ref, { large: true, alt: "The badge to give them" }), h("figcaption", { class: "small-text", text: "Give them this badge" })) : null;
}

/**
 * For staff who don't see clearance level names: a cleared badge's level, chosen by the
 * badge's image. Returns { node, setKind(kind), value() (template ref or null), changed() }.
 */
function templatePicker(templates, { kind = "tenant", current = null } = {}) {
  const name = `template-pick-${Math.random().toString(36).slice(2, 8)}`;
  const grid = h("div", { class: "template-picker" });
  const note = h("span", { class: "hint" });
  const node = h("div", { class: "full-row template-field" }, h("span", { class: "label", text: "Clearance level, by the badge's image" }), grid, note);
  let chosen = current;
  function render() {
    const list = templates.filter((t) => t.cleared && t.kind === kind);
    if (!list.some((t) => t.ref === chosen)) chosen = null;
    grid.replaceChildren(...list.map((t, i) => {
      const input = h("input", { type: "radio", name, value: t.ref });
      input.checked = t.ref === chosen;
      input.addEventListener("change", () => { chosen = t.ref; });
      return h("label", { class: "template-choice" }, input, templateImg(t.ref, { alt: `Cleared badge, choice ${i + 1}` }));
    }));
    note.textContent = list.length
      ? "Pick the image the badge matches. Only someone whose clearance covers it can be given it."
      : "There are no images of cleared badges yet; an administrator adds them under Settings > Badges and clearances.";
  }
  render();
  return { node, setKind: (k) => { kind = k; render(); }, value: () => chosen, changed: () => chosen !== current };
}

/** Where a badge is valid: its sites, or every site. */
function badgeSitesText(b) {
  return b.sites && b.sites.length ? b.sites.map((s) => s.name).join(", ") : "Every site";
}

function badgeStateBadge(b) {
  if (b.status !== "active") return h("span", { class: `badge ${b.status === "lost" ? "bad" : "muted"}`, text: BADGE_STATUS_LABELS[b.status] });
  if (b.holder?.overdue) return h("span", { class: "badge bad", text: "Overdue" });
  return b.holder ? h("span", { class: "badge warn", text: b.holder.temporary ? "Lent for the day" : "Assigned" }) : h("span", { class: "badge ok", text: "Available" });
}

/** "Temporary, in place of P-001, due back today 11:59 PM" for a temporary loan. */
function temporaryText(a) {
  if (!a?.temporary) return "";
  return `Temporary${a.replacesNumber ? `, in place of ${a.replacesNumber}` : ""}, due back ${fmtDateTime(a.dueAt - 60000)}`;
}

async function loadBadges() {
  const table = $("badges-table");
  const head = ["Badge", "Type", "Classification", ...(multiSite() ? ["Valid at"] : []), "Status", "Held by", "Since"];
  const picking = canManageBadges();
  const all = h("input", { type: "checkbox", "aria-label": "Choose every badge on this page" });
  table.tHead.replaceChildren(h("tr", {}, picking ? h("th", { class: "pick-cell" }, all) : null, head.map((t) => h("th", { text: t }))));
  if (picking) head.push("");
  const q = $("badges-search").value.trim();
  let data;
  try {
    data = await api(`/api/badges?${new URLSearchParams({ limit: String(BADGES_PAGE), offset: String(badgesView.offset), ...(q ? { q } : {}), ...($("badges-type").value ? { type: $("badges-type").value } : {}), ...($("badges-state").value ? { state: $("badges-state").value } : {}), ...siteQuery() })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  const boxes = [];
  const rows = data.badges.map((b) => {
    const box = picking ? h("input", { type: "checkbox", "aria-label": `Choose badge ${b.number}` }) : null;
    const row = h("tr", { class: `clickable${b.status !== "active" ? " inactive" : ""}${badgesView.picked.has(b.id) ? " is-picked" : ""}` },
      picking ? h("td", { class: "pick-cell", onclick: (e) => e.stopPropagation() }, box) : null,
      h("td", {}, h("strong", { class: "mono", text: b.number }), b.temporary ? h("span", { class: "badge muted", text: "Temporary" }) : null),
      h("td", { text: BADGE_TYPE_LABELS[b.type] }),
      h("td", { class: "small-text" }, h("span", { class: "with-thumb" }, templateImg(b.template), h("span", { text: badgeClassText(b) }))),
      multiSite() ? h("td", { class: "small-text", text: badgeSitesText(b) }) : null,
      h("td", {}, badgeStateBadge(b)),
      h("td", {}, b.holder ? [h("span", { text: b.holder.name }), b.holder.company ? h("div", { class: "muted small-text", text: b.holder.company }) : null, b.holder.temporary ? h("div", { class: `small-text ${b.holder.overdue ? "bad-text" : "muted"}`, text: temporaryText(b.holder) }) : null] : ""),
      h("td", { class: "small-text nowrap", text: b.holder ? fmtDateTime(b.holder.assignedAt) : "" }));
    row.addEventListener("click", () => { location.hash = `#badge/${b.id}`; });
    if (box) {
      box.checked = badgesView.picked.has(b.id);
      box.addEventListener("change", () => {
        if (box.checked) badgesView.picked.set(b.id, b);
        else badgesView.picked.delete(b.id);
        row.classList.toggle("is-picked", box.checked);
        all.checked = boxes.every((x) => x.box.checked);
        renderBadgeActions();
      });
      boxes.push({ box, b });
    }
    return row;
  });
  all.checked = boxes.length > 0 && boxes.every((x) => x.box.checked);
  all.addEventListener("change", () => {
    for (const x of boxes) if (x.box.checked !== all.checked) { x.box.checked = all.checked; x.box.dispatchEvent(new Event("change")); }
  });
  renderBadgeActions();
  clear(table.tBodies[0]).append(...(rows.length ? rows : [emptyRow(head.length, q || $("badges-state").value || $("badges-type").value ? "No badges match." : "No badges yet. Add one, or a range of them.")]));
  const from = data.total ? badgesView.offset + 1 : 0;
  $("badges-page").textContent = `${from}-${badgesView.offset + data.badges.length} of ${data.total}`;
  $("badges-prev").disabled = badgesView.offset === 0;
  $("badges-next").disabled = badgesView.offset + BADGES_PAGE >= data.total;
}

const reloadBadges = debounce(() => { badgesView.offset = 0; loadBadges(); }, 250);
$("badges-search").addEventListener("input", reloadBadges);
$("badges-type").addEventListener("change", reloadBadges);
$("badges-state").addEventListener("change", reloadBadges);
$("badges-prev").addEventListener("click", () => { badgesView.offset = Math.max(0, badgesView.offset - BADGES_PAGE); loadBadges(); });
$("badges-next").addEventListener("click", () => { badgesView.offset += BADGES_PAGE; loadBadges(); });

// --- adding and editing ---------------------------------------------------------------------

/**
 * The type, classification, level and site fields (the level shown only when the
 * classification needs one). Staff who see clearance levels choose a level by name; the rest
 * by the badge's image. Returns { fields, body(values) }: body() gives the request's type,
 * classification, level, sites and temporary flag.
 */
async function badgeKindFields(badge = null) {
  const info = await clearanceInfo(true);
  const needs = (id) => Boolean(info.classifications.find((c) => String(c.id) === String(id))?.requiresClearance);
  const byImage = canSeeClearances() ? null : templatePicker((await api("/api/badge-templates")).templates, { kind: templateKind(badge?.type || "tenant"), current: badge?.template || null });
  const levelBox = (inputs) => (byImage ? byImage.node : inputs.clearanceLevelId.closest("label"));
  const mine = state.config.sites.map((s) => s.id);
  // A limited account starts with its own sites ticked: it can't make a badge valid everywhere.
  const current = badge ? (badge.sites.length ? badge.sites.map((s) => s.id).filter((id) => mine.includes(id)) : null) : (state.config.access.sitesLimited ? mine : null);
  const sitesPicker = multiSite() || state.config.access.sitesLimited ? siteLimitPicker(current) : null;
  if (sitesPicker) sitesPicker.node.querySelector(".label").textContent = "Valid at";
  const fields = [
    { name: "type", label: "Type", type: "select", half: true, value: badge?.type || "tenant", options: info.badgeTypes, hint: "Personnel badges go to building staff, tenant badges to tenants' people, visitor badges to visitors.",
      onChange: (input) => { if (byImage) byImage.setKind(templateKind(input.value)); } },
    { name: "classificationId", label: "Classification", type: "select", half: true, value: String(badge?.classificationId || info.classifications.find((c) => !c.requiresClearance)?.id || ""),
      options: info.classifications.map((c) => ({ value: String(c.id), label: c.name })),
      onChange: (input, inputs) => { levelBox(inputs).hidden = !needs(input.value); } },
    byImage
      ? { node: byImage.node }
      : { name: "clearanceLevelId", label: "Clearance level", type: "select", half: true, value: String(badge?.clearanceLevelId || ""), options: [{ value: "", label: "Choose a level" }, ...info.levels.map((l) => ({ value: String(l.id), label: l.name }))], hint: "Only someone whose clearance covers it can be given this badge." },
    ...(sitesPicker ? [{ node: sitesPicker.node }] : []),
    { name: "temporary", label: "Temporary badge: lent for the day to someone who forgot theirs", type: "checkbox", value: Boolean(badge?.temporary), hint: "Goes only to a person who holds a badge of their own, and is due back by midnight." }
  ];
  // A level picked by image goes as its template ref, and only when it is new or changed.
  const level = (v) => {
    if (!byImage) return { clearanceLevelId: v.clearanceLevelId ? Number(v.clearanceLevelId) : null };
    if (!needs(v.classificationId)) return {};
    return !badge || byImage.changed() || v.type !== badge.type ? { templateRef: byImage.value() || "" } : {};
  };
  const body = (v) => ({ type: v.type, classificationId: Number(v.classificationId), ...level(v), temporary: Boolean(v.temporary), ...(sitesPicker ? { siteIds: sitesPicker.value() || [] } : {}) });
  return { fields, body };
}

$("badges-add").addEventListener("click", async () => {
  const kind = await badgeKindFields();
  const badge = await formDialog({
    title: "Add badge",
    wide: true,
    fields: [{ name: "number", label: "Badge number", required: true, half: true, autofocus: true }, ...kind.fields, { name: "notes", label: "Notes", type: "textarea", rows: 2 }],
    submitLabel: "Add badge",
    onSubmit: async (v) => (await api("/api/badges", { method: "POST", body: { number: v.number, notes: v.notes, ...kind.body(v) } })).badge
  });
  if (badge) {
    toast(`Added badge ${badge.number}.`);
    loadBadges();
  }
});

$("badges-range").addEventListener("click", async () => {
  const kind = await badgeKindFields();
  const result = await formDialog({
    title: "Add a range of badges",
    wide: true,
    intro: h("p", { class: "muted", text: "For a box of badges numbered in sequence, such as B-0001 to B-0050. All get the same type and classification." }),
    fields: [
      { name: "prefix", label: "Prefix", half: true, placeholder: "B-" },
      { name: "width", label: "Digits (pad with zeros to)", type: "number", half: true, value: 4, min: 0, max: 12 },
      { name: "from", label: "From", type: "number", half: true, required: true, value: 1, min: 0 },
      { name: "to", label: "To", type: "number", half: true, required: true, value: 50, min: 0 },
      ...kind.fields
    ],
    submitLabel: "Add badges",
    onSubmit: async (v) => api("/api/badges/range", { method: "POST", body: { prefix: v.prefix, width: Number(v.width), from: Number(v.from), to: Number(v.to), ...kind.body(v) } })
  });
  if (result) {
    toast(`Added ${result.count} badges, ${result.first.number} to ${result.last.number}.`);
    loadBadges();
  }
});

async function editBadge(badge) {
  const kind = await badgeKindFields(badge);
  const elsewhere = badge.sites.filter((s) => !state.config.sites.some((x) => x.id === s.id));
  return formDialog({
    title: `Edit badge ${badge.number}`,
    wide: true,
    fields: [
      { name: "number", label: "Badge number", required: true, half: true, value: badge.number },
      { name: "status", label: "Status", type: "select", half: true, value: badge.status, options: Object.entries(BADGE_STATUS_LABELS).map(([value, label]) => ({ value, label })), hint: badge.holder ? "Take it back before marking it lost or retired." : "Retired badges stay on record with their history." },
      ...kind.fields,
      ...(elsewhere.length ? [{ type: "readonly", name: "elsewhere", label: "Also valid at (sites you don't see; kept as they are)", value: elsewhere.map((s) => s.name).join(", ") }] : []),
      { name: "notes", label: "Notes", type: "textarea", rows: 2, value: badge.notes }
    ],
    onSubmit: async (v) => (await api(`/api/badges/${badge.id}`, { method: "PUT", body: { number: v.number, status: v.status, notes: v.notes, ...kind.body(v) } })).badge
  });
}

// --- giving out and taking back ------------------------------------------------------------------

/** Finds a person (personnel and tenant badges) or visitor (visitor badges) and gives them the badge. */
async function assignBadgeDialog(badge) {
  const kind = badge.type === "visitor" ? "visitor" : "person";
  const results = h("div", { class: "choices-list" });
  const message = h("p", { class: "message error", hidden: true });
  const search = h("input", { type: "search", placeholder: kind === "visitor" ? "Type the visitor's name" : "Type the person's name or company", autocomplete: "off" });
  let dlg = null;
  const run = debounce(async () => {
    const q = search.value.trim();
    clear(results);
    message.hidden = true;
    if (q.length < 2) return;
    const list = kind === "visitor"
      ? (await api(`/api/visitors?${new URLSearchParams({ q, limit: "15" })}`)).visitors
      : (await api(`/api/people?${new URLSearchParams({ q, limit: "15" })}`)).people;
    for (const x of list) {
      results.append(h("button", { type: "button", class: "pick-row", onclick: async () => {
        message.hidden = true;
        try {
          await api(`/api/badges/${badge.id}/assign`, { method: "POST", body: { kind, holderId: x.id } });
          dlg.finish(x);
        } catch (error) {
          message.textContent = error.message;
          message.hidden = false;
        }
      } }, h("strong", { text: kind === "visitor" ? visitorName(x) : personName(x) }), " ",
      h("span", { class: "muted small-text", text: kind === "visitor" ? [x.organisation, x.clearanceLevelName].filter(Boolean).join(" · ") : [x.companyName, x.jobTitle, x.clearanceLevelName].filter(Boolean).join(" · ") })));
    }
    if (!list.length) results.append(h("p", { class: "muted", text: "Nobody matches." }));
  }, 250);
  search.addEventListener("input", run);
  const given = await openDialog({
    title: `Give badge ${badge.number}`,
    wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "with-thumb" }, templateImg(badge.template), h("p", { class: "muted", text: `${BADGE_TYPE_LABELS[badge.type]} badge, ${badgeClassText(badge)}.${badge.cleared ? " Only someone whose clearance covers it can hold it." : ""}` })),
      message, search, results),
    actions: [{ label: "Cancel", value: null }],
    onOpen: (d) => { dlg = d; setTimeout(() => search.focus(), 50); }
  });
  if (given) toast(`Badge ${badge.number} given to ${kind === "visitor" ? visitorName(given) : personName(given)}.`);
  return given;
}

async function takeBackBadge(badgeId, number, holderName, outcome = "returned") {
  const note = await formDialog({
    title: outcome === "lost" ? `Badge ${number} lost` : `Take back badge ${number}`,
    intro: h("p", { text: outcome === "lost" ? `${holderName} no longer has badge ${number}. It is marked lost and can't be given out until it turns up (edit it back to active).` : `${holderName} hands back badge ${number}.` }),
    fields: [{ name: "note", label: "Note (optional)", type: "textarea", rows: 2 }],
    submitLabel: outcome === "lost" ? "Mark lost" : "Taken back",
    onSubmit: async (v) => { await api(`/api/badges/${badgeId}/return`, { method: "POST", body: { outcome, note: v.note } }); return true; }
  });
  if (note) {
    toast(outcome === "lost" ? `Badge ${number} marked lost.` : `Badge ${number} taken back.`);
    refreshCounts();
  }
  return Boolean(note);
}

// --- a badge's dialog ---------------------------------------------------------------------------

async function openBadge(id, onChange = () => {}) {
  let data;
  try {
    data = await api(`/api/badges/${id}`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  const { badge, history: held } = data;
  const body = h("div", { class: "detail" },
    h("p", {}, badgeStateBadge(badge)),
    h("dl", { class: "facts inline-facts" },
      h("dt", { text: "Type" }), h("dd", { text: BADGE_TYPE_LABELS[badge.type] }),
      h("dt", { text: "Classification" }), h("dd", { text: badgeClassText(badge) }),
      badge.template ? [h("dt", { text: "Looks like" }), h("dd", {}, templateImg(badge.template, { large: true, alt: `Badge ${badge.number}` }))] : null,
      badge.temporary ? [h("dt", { text: "Temporary" }), h("dd", { text: "Lent for the day to people who forgot their own badge" })] : null,
      multiSite() ? [h("dt", { text: "Valid at" }), h("dd", { text: badgeSitesText(badge) })] : null,
      badge.holder ? [h("dt", { text: "Held by" }), h("dd", {}, h("a", { href: badge.holder.kind === "visitor" ? `#visitor/${badge.holder.id}` : `#person/${badge.holder.id}`, text: badge.holder.name }), badge.holder.company ? ` (${badge.holder.company})` : "", h("span", { class: "muted", text: ` since ${fmtDateTime(badge.holder.assignedAt)}${badge.holder.assignedBy ? `, given by ${badge.holder.assignedBy}` : ""}` }),
        badge.holder.temporary ? h("div", { class: badge.holder.overdue ? "bad-text" : "muted", text: `${temporaryText(badge.holder)}${badge.holder.overdue ? " (overdue)" : ""}` }) : null)] : null,
      badge.notes ? [h("dt", { text: "Notes" }), h("dd", { class: "pre", text: badge.notes })] : null),
    h("h4", { text: "Who has held it" }),
    held.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Holder", "Given", "Back", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, held.map((a) => h("tr", {},
          h("td", {}, h("span", { text: a.holderName }), a.holderCompany ? h("div", { class: "muted small-text", text: a.holderCompany }) : null),
          h("td", { class: "small-text" }, fmtDateTime(a.assignedAt), a.assignedBy ? h("div", { class: "muted", text: a.assignedBy }) : null),
          h("td", { class: "small-text" }, a.returnedAt ? [fmtDateTime(a.returnedAt), a.returnedBy ? h("div", { class: "muted", text: a.returnedBy }) : null] : h("span", { class: "badge warn", text: "Still out" })),
          h("td", { class: "small-text" }, a.outcome === "lost" ? h("span", { class: "badge bad", text: "Lost" }) : "", a.temporary ? h("div", { class: "muted", text: `in place of ${a.replacesNumber || "their badge"}` }) : null, a.note ? h("div", { class: "muted", text: a.note }) : null))))))
      : h("p", { class: "muted", text: "Never given out." }));
  const actions = [];
  if (canManageBadges() && !held.length) actions.push({ label: "Delete", kind: "danger", value: "delete" });
  if (canManageBadges()) actions.push({ label: "Edit", value: "edit" });
  if (canEditBadges()) {
    if (badge.holder) {
      actions.push({ label: "Lost", value: "lost" });
      actions.push({ label: "Take back", value: "back" });
    } else if (badge.status === "active") {
      actions.push({ label: "Give out", value: "assign" });
    }
  }
  actions.push({ label: "Close", kind: "primary", value: null });
  const result = await openDialog({ title: `Badge ${badge.number}`, body, wide: true, actions });
  const again = () => openBadge(id, onChange);
  try {
    if (result === "edit") { if (await editBadge(badge)) { toast("Saved."); onChange(); } return again(); }
    if (result === "assign") { if (await assignBadgeDialog(badge)) onChange(); return again(); }
    if (result === "back" || result === "lost") { if (await takeBackBadge(badge.id, badge.number, badge.holder.name, result === "lost" ? "lost" : "returned")) onChange(); return again(); }
    if (result === "delete") {
      if (!(await confirmDialog(`Delete badge ${badge.number}?`, { danger: true, confirmLabel: "Delete" }))) return again();
      await api(`/api/badges/${badge.id}`, { method: "DELETE" });
      toast(`Deleted badge ${badge.number}.`);
      onChange();
    }
  } catch (error) {
    toast(error.message, "error");
    return again();
  }
  if (location.hash.startsWith("#badge/")) history.back();
}

// --- the badge section on a person's or visitor's dialog -----------------------------------------------

/** Their badges now, a way to give them one they may hold, and the ones they had before. */
function badgeSection(kind, holderId) {
  if (!canReadBadges()) return null;
  const box = h("div", { class: "stack badge-section" }, h("h4", { text: "Badges" }), h("p", { class: "muted", text: "Loading…" }));
  async function render() {
    let data;
    try {
      data = await api(`/api/badge-holders/${kind}/${holderId}`);
    } catch (error) {
      box.replaceChildren(h("h4", { text: "Badges" }), h("p", { class: "message error", text: error.message }));
      return;
    }
    const parts = [h("h4", { text: "Badges" })];
    if (data.current.length) {
      parts.push(h("ul", { class: "plain-list" }, data.current.map((a) => h("li", { class: "row-between" },
        h("span", {}, h("a", { href: `#badge/${a.badgeId}`, class: "mono", text: a.badgeNumber }), h("span", { class: "muted small-text", text: ` ${BADGE_TYPE_LABELS[a.badgeType]} · since ${fmtDateTime(a.assignedAt)}` }),
          a.temporary ? h("div", { class: `small-text ${a.overdue ? "bad-text" : "muted"}`, text: `${temporaryText(a)}${a.overdue ? " (overdue)" : ""}` }) : null),
        canEditBadges() ? h("span", { class: "btn-row" },
          h("button", { type: "button", class: "link-btn", text: "Take back", onclick: async () => { if (await takeBackBadge(a.badgeId, a.badgeNumber, a.holderName)) render(); } }),
          h("button", { type: "button", class: "link-btn danger-text", text: "Lost", onclick: async () => { if (await takeBackBadge(a.badgeId, a.badgeNumber, a.holderName, "lost")) render(); } })) : null))));
    } else {
      parts.push(h("p", { class: "muted", text: "No badge at the moment." }));
    }
    if (canEditBadges()) {
      if (data.available.length) {
        const pick = badgePicker(data.available, { suggested: data.suggested });
        parts.push(h("div", { class: "badge-give" },
          suggestedBadge(data.suggested),
          h("div", { class: "stack" }, pick.node, h("div", { class: "btn-row" }, h("button", { type: "button", class: "secondary small", text: "Give badge", onclick: async () => {
            const chosen = pick.chosen();
            if (!chosen) return;
            try {
              await api(`/api/badges/${chosen.id}/assign`, { method: "POST", body: { kind, holderId } });
              toast(`Badge ${chosen.number} given.`);
              render();
            } catch (error) {
              toast(error.message, "error");
            }
          } })))));
      } else {
        parts.push(h("p", { class: "muted small-text", text: `No ${kind === "visitor" ? "visitor " : ""}badge is free that they may hold${kind === "person" ? " (personnel badges are for building staff, tenant badges for everyone else, and a cleared badge needs a clearance that covers it)" : " (a cleared badge needs a clearance that covers it)"}.` }));
      }
    }
    // Forgot their badge today: a temporary one, standing in for the badge they hold.
    const own = data.current.filter((a) => !a.temporary);
    if (canEditBadges() && kind === "person" && own.length && !data.current.some((a) => a.temporary)) {
      if (data.temporary.length) {
        const tmp = h("select", { "aria-label": "Temporary badge" }, data.temporary.map((b) => h("option", { value: String(b.id), text: `${b.number} · ${badgeClassText(b)}` })));
        const forWhich = own.length > 1 ? h("select", { "aria-label": "In place of" }, own.map((a) => h("option", { value: String(a.badgeId), text: `in place of ${a.badgeNumber}` }))) : null;
        parts.push(h("div", { class: "temp-row" },
          h("span", { class: "small-text", text: "Forgot their badge today?" }),
          h("div", { class: "btn-row" }, tmp, forWhich, h("button", { type: "button", class: "secondary small", text: "Lend for today", onclick: async () => {
            try {
              const r = await api(`/api/badges/${tmp.value}/assign`, { method: "POST", body: { kind, holderId, replacesBadgeId: forWhich ? Number(forWhich.value) : own[0].badgeId } });
              toast(`Badge ${r.badge.number} lent until midnight.`);
              render();
            } catch (error) {
              toast(error.message, "error");
            }
          } }))));
      } else {
        parts.push(h("p", { class: "muted small-text", text: "Forgot their badge today? No temporary badge is free that they may hold. Security marks badges as temporary under Badges." }));
      }
    }
    if (data.past.length) {
      parts.push(h("details", {}, h("summary", { class: "small-text", text: `Earlier badges (${data.past.length})` }),
        h("ul", { class: "plain-list small-text" }, data.past.map((a) => h("li", {}, h("span", { class: "mono", text: a.badgeNumber }), ` ${fmtDate(a.assignedAt)} to ${fmtDate(a.returnedAt)}${a.outcome === "lost" ? ", lost" : ""}`)))));
    }
    box.replaceChildren(...parts);
  }
  render();
  return box;
}

// --- Settings > Badges and clearances --------------------------------------------------------------------

async function settingsBadges(body) {
  const info = await clearanceInfo(true);
  const changed = async () => { await reloadConfig(); renderSettings(); };
  body.append(
    recheckPanel(),
    await badgeImagesPanel(info.levels),
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: "Clearance levels" }), h("button", { type: "button", class: "primary small", text: "Add level", onclick: () => editLevel(null).then((x) => x && changed()) })),
      h("p", { class: "muted", text: "Higher in the order covers everything below it: someone at TS//SCI FSP may hold a TS//SCI CI badge, not the other way round. People and visitors carry a level, with when it was granted and when it expires, set only by the Security role when it validates one; an expired or unvalidated clearance counts as none." }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Level", "Order", "Used by", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, info.levels.map((l) => h("tr", {},
          h("td", {}, h("strong", { text: l.name })),
          h("td", { text: String(l.rank) }),
          h("td", { class: "small-text", text: l.inUse ? `${l.inUse}` : "—" }),
          h("td", {}, h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editLevel(l).then((x) => x && changed()) }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: async () => {
              if (!(await confirmDialog(`Delete the clearance level ${l.name}?`, { danger: true, confirmLabel: "Delete" }))) return;
              try { await api(`/api/clearance/levels/${l.id}`, { method: "DELETE" }); changed(); } catch (error) { toast(error.message, "error"); }
            } }))))))))),
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: "Badge classifications" }), h("button", { type: "button", class: "primary small", text: "Add classification", onclick: () => editClassification(null).then((x) => x && changed()) })),
      h("p", { class: "muted", text: "A classification that needs a clearance level (such as Cleared) makes each of its badges carry one; the others (such as Uncleared) carry none and can go to anyone of the right type." }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Classification", "Clearance level", "Badges", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, info.classifications.map((c) => h("tr", {},
          h("td", {}, h("strong", { text: c.name })),
          h("td", { class: "small-text", text: c.requiresClearance ? "Needs one" : "None" }),
          h("td", { text: String(c.inUse || 0) }),
          h("td", {}, h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editClassification(c).then((x) => x && changed()) }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Delete", onclick: async () => {
              if (!(await confirmDialog(`Delete the classification ${c.name}?`, { danger: true, confirmLabel: "Delete" }))) return;
              try { await api(`/api/clearance/classifications/${c.id}`, { method: "DELETE" }); changed(); } catch (error) { toast(error.message, "error"); }
            } }))))))))));
}

/**
 * Settings > Badges and clearances: what each level's badges look like, for staff who don't
 * see clearance level names. A tenant image (personnel badges use it too) and a visitor
 * image per level, and a pair for uncleared badges.
 */
async function badgeImagesPanel(levels) {
  const panel = h("div", { class: "panel" });
  async function render() {
    const { templates } = await api("/api/badge-templates");
    const find = (levelId, kind) => templates.find((t) => t.levelId === levelId && t.kind === kind);
    const cell = (levelId, kind, label) => {
      const t = find(levelId, kind);
      const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true });
      file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          await api(`/api/badge-templates/${levelId}/${kind}`, { method: "PUT", body: { dataUrl: await imageToPng(f, 800) } });
          toast(`Saved the ${label} image.`);
          render();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      return h("td", {}, h("div", { class: "template-cell" },
        t ? templateImg(t.ref, { alt: label }) : h("span", { class: "muted small-text", text: "No image" }),
        h("div", { class: "btn-row" },
          h("button", { type: "button", class: "link-btn", text: t ? "Replace" : "Upload", onclick: () => file.click() }),
          t ? h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
            if (!(await confirmDialog(`Remove the ${label} image?`, { danger: true, confirmLabel: "Remove" }))) return;
            try { await api(`/api/badge-templates/${levelId}/${kind}`, { method: "DELETE" }); render(); } catch (error) { toast(error.message, "error"); }
          } }) : null),
        file));
    };
    const row = (levelId, name) => h("tr", {}, h("td", {}, h("strong", { text: name })),
      cell(levelId, "tenant", `${name} tenant badge`), cell(levelId, "visitor", `${name} visitor badge`));
    panel.replaceChildren(
      h("div", { class: "panel-head" }, h("h3", { text: "Badge images" })),
      h("p", { class: "muted", text: "What each level's badges look like. Staff whose role doesn't see clearance levels (Settings > Roles) see these instead of level names: beside each badge, large when they give one out, and to choose a cleared badge's level. Personnel badges use the tenant image. PNG or JPEG, up to 1 MB; other images are converted." }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Level", "Tenant and personnel badge", "Visitor badge"].map((x) => h("th", { text: x })))),
        h("tbody", {}, row(0, "Uncleared"), levels.map((l) => row(l.id, l.name))))));
  }
  await render();
  return panel;
}

function editLevel(level) {
  return formDialog({
    title: level ? `Edit ${level.name}` : "Add clearance level",
    fields: [
      { name: "name", label: "Name", required: true, value: level?.name, half: true },
      { name: "rank", label: "Order (higher covers lower)", type: "number", half: true, value: level?.rank ?? "", placeholder: "After the highest" }
    ],
    onSubmit: async (v) => (level
      ? await api(`/api/clearance/levels/${level.id}`, { method: "PUT", body: { name: v.name, rank: v.rank === "" ? undefined : Number(v.rank) } })
      : await api("/api/clearance/levels", { method: "POST", body: { name: v.name, ...(v.rank === "" ? {} : { rank: Number(v.rank) }) } })).level
  });
}

function editClassification(c) {
  return formDialog({
    title: c ? `Edit ${c.name}` : "Add classification",
    fields: [
      { name: "name", label: "Name", required: true, value: c?.name },
      { name: "requiresClearance", label: "Its badges carry a clearance level", type: "checkbox", value: c ? c.requiresClearance : false, hint: c?.inUse ? "Can't change while badges use it." : null }
    ],
    onSubmit: async (v) => (c
      ? await api(`/api/clearance/classifications/${c.id}`, { method: "PUT", body: v })
      : await api("/api/clearance/classifications", { method: "POST", body: v })).classification
  });
}

/** The Badges page: under Tenants it shows people's badges, under Visitors visitors', under Security all. */
function showBadges(scope) {
  const type = { tenants: "people", visitors: "visitor" }[scope] ?? "";
  if ((scope || "all") !== (state.badgesScope || "all")) {
    $("badges-type").value = type;
    badgesView.offset = 0;
  }
  state.badgesScope = scope || "all";
  renderSubnav();
  loadBadges();
}
