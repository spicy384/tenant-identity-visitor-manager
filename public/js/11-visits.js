// 11-visits.js: the visit log, with filters and CSV export, and the visits table the
// visitor dialog shares. Each entry opens in its own window. Staff who check visitors in
// (and Security) can correct it there: the site, who was visited, what for, the ID shown, the
// badge number, and when they arrived or left. Every change needs its reason. Every change is kept with the visit, what it was before and
// after, who made it and when, and listed at the foot of the window; it is in the audit log
// too. They can also note comments against a visit, each kept with who wrote it and when.

const VISITS_PAGE = 100;
const visitsView = { offset: 0 };

const CHECKOUT_LABELS = { kiosk: "at the kiosk", staff: "by staff", auto: "at end of day" };

/** How they arrived: at a kiosk (and who at the desk checked their ID), or who checked them in at the desk. */
function arrivedHow(v) {
  if (v.kioskId) return [`at ${v.kioskName || "the kiosk"}`, v.idVerifiedBy ? `ID checked by ${v.idVerifiedBy}` : null].filter(Boolean).join(", ");
  return v.checkedInBy ? `by ${v.checkedInBy}` : "";
}

/** How they left: who checked them out (staff), at the kiosk, or at the end of the day. */
function leftHow(v) {
  if (v.checkoutMethod === "staff" && v.checkedOutBy) return `by ${v.checkedOutBy}`;
  return CHECKOUT_LABELS[v.checkoutMethod] || "";
}

/**
 * A table of visits. showVisitor: include the visitor's name (the log does, the visitor dialog
 * doesn't). onChange: called after a visit's times are corrected.
 */
function visitsTable(visits, { showVisitor = true, onChange = () => {} } = {}) {
  const allSites = multiSite();
  const correcting = canCorrectVisits();
  // The badge each visitor had, for those who see badges; entered later by those who give them out.
  const seesBadges = canReadBadges();
  const entersBadges = correcting && canEditBadges();
  const head = ["Arrived", "Left", ...(showVisitor ? ["Visitor"] : []), "Visiting", "Host", ...(seesBadges ? ["Badge"] : []), ...(allSites ? ["Site"] : []), "Comments", ""];
  const open = async (v) => { if (await openVisitEntry(v)) onChange(); };
  // A click anywhere on a row that isn't on something of its own (a link, a button) opens the entry.
  const rowClick = (v) => (e) => { if (!e.target.closest("a, button, input, select, textarea, label")) open(v); };
  // When they left the day they came, the time is enough.
  const leftAt = (v) => (new Date(v.checkedOutAt).toDateString() === new Date(v.checkedInAt).toDateString() ? fmtTime(v.checkedOutAt) : fmtDateTime(v.checkedOutAt));
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact phone-cards" },
    h("thead", {}, h("tr", {}, head.map((t) => h("th", { text: t })))),
    h("tbody", {}, visits.length ? visits.map((v) => h("tr", { class: `clickable${v.timesCorrected ? " time-changed" : ""}`, onclick: rowClick(v) },
      h("td", { class: "small-text" }, h("span", { class: "nowrap" }, fmtDateTime(v.checkedInAt), v.timeChanged?.in ? changedMark(v, open) : null),
        arrivedHow(v) ? h("div", { class: "muted", text: arrivedHow(v) }) : null),
      h("td", { class: "small-text" }, v.checkedOutAt
        ? [h("span", { class: "nowrap" }, leftAt(v), v.timeChanged?.out ? changedMark(v, open) : null), h("div", { class: "muted", text: leftHow(v) })]
        : h("span", { class: "badge ok", text: "In the building" })),
      showVisitor ? h("td", {}, h("a", { href: `#visitor/${v.visitorId}`, text: visitorName(v.visitor) }), v.visitor.organization ? h("div", { class: "muted small-text", text: v.visitor.organization }) : null) : null,
      h("td", {}, v.companyName || "", v.detailsChanged ? [" ", detailsChangedMark(v, open)] : null, v.purpose ? h("div", { class: "muted small-text", text: v.purpose }) : null),
      h("td", { text: v.hostName || "" }),
      seesBadges ? h("td", { class: "small-text" }, (v.badges || []).length
        ? [h("span", { class: "mono", text: v.badges.join(", ") }), v.badgeRecordedLater ? h("div", { class: "muted", text: "entered later" }) : null]
        : [v.badgeWaivedAt ? h("div", { class: "muted", text: "Not needed", title: `No badge necessary${v.badgeWaivedBy ? `, said ${v.badgeWaivedBy}` : ""}` }) : null,
          entersBadges ? h("button", { type: "button", class: "link-btn small-text nowrap", text: "Add badge", onclick: async () => { if (await recordVisitBadge(v)) onChange(); } }) : v.badgeWaivedAt ? null : h("span", { class: "muted", text: "None" })]) : null,
      allSites ? h("td", { class: "small-text", text: v.siteName }) : null,
      h("td", { class: "small-text" }, [visitCommentsCell(v, onChange)].filter(Boolean)),
      h("td", {}, h("button", { type: "button", class: "link-btn small-text nowrap row-action", text: correcting ? "Edit" : "View", "aria-label": `${correcting ? "Edit" : "View"} ${visitorName(v.visitor)}'s visit of ${fmtDateTime(v.checkedInAt)}`, onclick: () => open(v) })))) : emptyRow(head.length, "No visits."))));
}

/**
 * A visit's comments in its row: the latest, with who wrote it and how many came before, which
 * opens them all; with none, Add comment for those who may.
 */
function visitCommentsCell(v, onChange) {
  const list = v.comments || [];
  const open = async () => { if (await visitComments(v)) onChange(); };
  if (!list.length) return canCorrectVisits() ? h("button", { type: "button", class: "link-btn small-text nowrap", text: "Add comment", onclick: open }) : null;
  const last = list[list.length - 1];
  return h("button", { type: "button", class: "visit-comment", title: canCorrectVisits() ? "See the comments, or add one" : "See the comments", onclick: open },
    h("span", { class: "visit-comment-text", text: last.body }),
    h("span", { class: "muted", text: `${last.by || "staff"}, ${fmtDateTime(last.at)}${list.length > 1 ? ` · ${list.length - 1} earlier` : ""}` }));
}

/**
 * A visit's comments, oldest first, and a box to add one (those who check visitors in or
 * correct visits). An administrator can remove one; what it said stays in the audit log.
 * Resolves true when a comment was added or removed.
 */
async function visitComments(v, changed = false) {
  const name = visitorName(v.visitor);
  const list = v.comments || [];
  const remove = async (c, e) => {
    const dlg = e.target.closest("dialog");
    if (!(await confirmDialog(`Remove this comment by ${c.by || "staff"}? What it said stays in the audit log.`, { confirmLabel: "Remove", danger: true }))) return;
    try {
      dlg.finish({ visit: (await api(`/api/visits/${v.id}/comments/${c.id}`, { method: "DELETE" })).visit });
    } catch (error) {
      dlg.showError(error.message);
    }
  };
  const about = h("p", { class: "muted", text: `${v.siteName}${v.companyName ? `, visiting ${v.companyName}` : ""}: arrived ${fmtDateTime(v.checkedInAt)}, ${v.checkedOutAt ? `left ${fmtDateTime(v.checkedOutAt)}` : "still in the building"}.` });
  const past = list.length
    ? h("ul", { class: "plain-list comment-list" }, list.map((c) => h("li", {},
      h("p", { class: "pre", text: c.body }),
      h("div", { class: "row-between muted small-text" }, h("span", { text: `${c.by || "staff"}, ${fmtDateTime(c.at)}` }),
        isAdmin() ? h("button", { type: "button", class: "link-btn danger-text small-text", text: "Remove", onclick: (e) => remove(c, e) }) : null))))
    : h("p", { class: "muted", text: "No comments yet." });
  const title = `Comments on ${name}'s visit`;
  const result = canCorrectVisits()
    ? await formDialog({
      title,
      intro: h("div", { class: "stack full-row" }, about, past),
      fields: [{ name: "body", label: list.length ? "Add another" : "Comment", type: "textarea", rows: 3, required: true, autofocus: true, placeholder: "Left a laptop bag at the desk; collected at 3 PM.", hint: "Kept with the visit, with your name and the time." }],
      submitLabel: "Add comment",
      onSubmit: async (values) => { await api(`/api/visits/${v.id}/comments`, { method: "POST", body: { body: values.body } }); return "added"; }
    })
    : await openDialog({ title, body: h("div", { class: "stack" }, about, past) });
  if (result === "added") {
    toast("Comment added.");
    return true;
  }
  // One was removed: shown again without it.
  if (result?.visit) return visitComments(result.visit, true);
  return changed;
}

/**
 * The mark beside a time that was corrected: "Changed", with who changed it last and why on
 * hover; it opens the entry, whose changes are listed at its foot.
 */
function changedMark(v, open) {
  const last = v.lastCorrection;
  const title = `${v.timesCorrected === 1 ? "Changed" : `Changed ${v.timesCorrected} times; last`} by ${last?.by || "staff"}, ${fmtDateTime(last?.at)}: ${last?.reason || ""}`;
  return h("button", { type: "button", class: "badge warn time-changed-mark", title, "aria-label": title, text: "Changed", onclick: () => open(v) });
}

/** The same mark beside who they visited, when that or the purpose was changed since. */
function detailsChangedMark(v, open) {
  const title = `This entry (its site, who they visited, what for, the ID shown or the badge) was corrected ${v.detailsChanged === 1 ? "once" : `${v.detailsChanged} times`} since it was recorded. Open it to see what it was.`;
  return h("button", { type: "button", class: "badge warn time-changed-mark", title, "aria-label": title, text: "Changed", onclick: () => open(v) });
}

/**
 * Enters the badge a visitor had on a visit, when none was recorded at the time: for a visit
 * that has ended, recorded for its time (and refused if it was with someone else then); for one
 * still open, given to them now. Resolves true when it was entered.
 */
async function recordVisitBadge(v) {
  const name = visitorName(v.visitor);
  const ended = Boolean(v.checkedOutAt);
  const saved = await formDialog({
    title: `Badge for ${name}'s visit`,
    intro: h("p", { class: "muted full-row", text: ended
      ? `${v.siteName}, ${fmtDateTime(v.checkedInAt)} to ${fmtDateTime(v.checkedOutAt)}. The badge is recorded as theirs for that time, and back when they left. The badge's history shows it, noted as entered later.`
      : `${name} is still here: the badge is given to them now, as at check-in.` }),
    fields: [
      { name: "number", label: "Badge number", required: true, half: true, autofocus: true, placeholder: "e.g. V-012 or 101-40001" },
      { name: "facilityCode", label: "Facility code (optional)", half: true, placeholder: "2-3 digits", hint: "Only if the same number is under more than one code." },
      { name: "reason", label: "Reason", type: "textarea", rows: 2, required: true, placeholder: "Not entered at check-in; taken from the desk's paper log.", hint: "Kept with the visit's entry and in the audit log." }
    ],
    submitLabel: ended ? "Record the badge" : "Give the badge",
    onSubmit: async (values) => {
      const r = await api(`/api/visits/${v.id}/badge-record`, { method: "POST", body: { number: values.number, facilityCode: values.facilityCode || null, reason: values.reason } });
      toast(r.recorded ? `Badge ${r.badge.label} recorded for the visit.` : `Badge ${r.badge.label} given to ${name}.`);
      return true;
    }
  });
  if (saved) refreshCounts();
  return Boolean(saved);
}

/** A timestamp as a datetime-local input's value, in this device's time. */
function localInputValue(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const VISIT_CHANGE_FIELDS = { in: "Arrived", out: "Left", site: "Site", company: "Visiting", contact: "Point of contact", purpose: "Purpose", id: "ID shown", comment: "Comment removed", badge: "Badge" };

/**
 * Every change made to a visit's entry since it was recorded, newest first: what was changed
 * (and why, when they said), what it was before and after, who changed it and when.
 */
function visitHistoryTable(history) {
  if (!history.length) return h("p", { class: "muted", text: "No changes: this entry is as it was recorded." });
  const timed = (c) => c.field === "in" || c.field === "out";
  const said = (c, value) => (value === null || value === undefined || value === "" ? (c.field === "out" ? "Not checked out" : "Nothing") : timed(c) ? fmtDateTime(value) : String(value));
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact visit-history" },
    h("thead", {}, h("tr", {}, ["Changed", "Before", "After", "By", "When"].map((t) => h("th", { text: t })))),
    h("tbody", {}, history.map((c) => h("tr", {},
      h("td", {}, h("strong", { text: VISIT_CHANGE_FIELDS[c.field] || c.field }), c.reason ? h("div", { class: "muted small-text", text: c.reason }) : null),
      h("td", { class: "small-text", text: said(c, c.from) }),
      h("td", { class: "small-text", text: said(c, c.to) }),
      h("td", { class: "small-text", text: c.by || "staff" }),
      h("td", { class: "small-text nowrap", text: fmtDateTime(c.at) }))))));
}

/**
 * A visit's entry in its own window: what is on record, and at its foot every change made to
 * it since (before and after, who and when). Those who correct visits change it here, each
 * thing in its own box: the site (with more than one to choose from), who was visited (the
 * points of contact, whose company comes with them), when they arrived and left (which needs
 * the reason), the ID they showed, the badge number (for those who give badges out) and what
 * the visit was for. Resolves true when the entry was changed.
 */
async function openVisitEntry(row) {
  let v;
  let history;
  try {
    ({ visit: v, history = [] } = await api(`/api/visits/${row.id}`));
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
  const name = visitorName(v.visitor);
  const correcting = canCorrectVisits();
  // Choosing a point of contact searches the directory: for those who see it.
  const picker = correcting && canReadDirectory()
    ? contactPicker({ siteId: String(v.siteId), hostIds: v.hostIds, initial: { companyId: v.companyId, companyName: v.companyName, hostName: v.hostName } })
    : null;
  // The sites it could have been at: the open ones they see, and the one on record even if it has closed.
  const siteChoices = [...activeSites().map((s) => ({ value: String(s.id), label: s.name })), ...(activeSites().some((s) => s.id === v.siteId) ? [] : [{ value: String(v.siteId), label: v.siteName }])];
  const pickSite = correcting && siteChoices.length > 1;
  // The ID they showed: corrected once it has been checked (before that, checking it is the desk's next step).
  const idKinds = state.config.checkin?.idTypes || [];
  const otherId = state.config.checkin?.otherId;
  const pickId = correcting && idKinds.length > 0 && v.checkinStage !== "id";
  // The badge: a number to enter or correct, for those who give badges out, when the visit has at most one.
  const badges = v.badges || [];
  const onRecord = badges[0] || "";
  const pickBadge = correcting && canGiveBadges() && badges.length < 2;
  const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", {}, value)] : null);
  const idShown = v.idType ? `${v.idType}${v.idOther ? ` (${v.idOther})` : ""}${v.idVerifiedBy ? `, checked by ${v.idVerifiedBy}` : ""}` : null;
  const badgeText = badges.length ? `${badges.join(", ")}${v.badgeRecordedLater ? " (entered later)" : ""}`
    : v.badgeWaivedAt ? `Not needed${v.badgeWaivedBy ? ` (said ${v.badgeWaivedBy})` : ""}` : canReadBadges() ? "None" : null;
  // What has a box of its own below isn't repeated here.
  const facts = h("dl", { class: "facts" },
    fact("Visitor", `${name}${v.visitor.organization ? ` (${v.visitor.organization})` : ""}`),
    multiSite() && !pickSite ? fact("Site", v.siteName) : null,
    correcting ? null : fact("Arrived", [fmtDateTime(v.checkedInAt), arrivedHow(v)].filter(Boolean).join(", ")),
    correcting ? null : fact("Left", v.checkedOutAt ? [fmtDateTime(v.checkedOutAt), leftHow(v)].filter(Boolean).join(", ") : "Still in the building"),
    pickId ? null : fact("ID shown", idShown),
    picker ? null : fact("Visiting", v.companyName),
    picker ? null : fact(v.hostIds.length > 1 ? "Points of contact" : "Point of contact", v.hostName),
    correcting ? null : fact("Purpose", v.purpose),
    pickBadge ? null : fact("Badge", badgeText));
  const comments = (v.comments || []).length ? h("div", { class: "stack" },
    h("h4", { text: `Comments (${v.comments.length})` }),
    h("ul", { class: "plain-list comment-list" }, v.comments.map((c) => h("li", {}, h("p", { class: "pre", text: c.body }), h("div", { class: "muted small-text", text: `${c.by || "staff"}, ${fmtDateTime(c.at)}` }))))) : "";
  const changes = h("div", { class: "stack full-row" }, h("h4", { text: `Changes to this entry${history.length ? ` (${history.length})` : ""}` }), visitHistoryTable(history));
  const title = `${name}'s visit, ${fmtDate(v.checkedInAt)}`;
  if (!correcting) {
    await openDialog({ title, wide: true, body: h("div", { class: "stack" }, facts, comments, changes) });
    return false;
  }
  // Saved in part (the entry, but not its badge) and then closed: the log is still drawn again.
  let savedSome = false;
  const saved = await formDialog({
    title,
    wide: true,
    intro: h("div", { class: "stack full-row" }, facts, comments),
    fields: [
      ...(pickSite ? [
        { type: "heading", label: "Where" },
        { name: "siteId", label: "Site", type: "select", value: String(v.siteId), options: siteChoices, hint: "The site they came to.", onChange: (input) => picker?.setSite(input.value) }
      ] : []),
      ...(picker ? [
        { type: "heading", label: "Who they visited" },
        { node: h("p", { class: "muted small-text full-row", text: `On record: ${v.companyName || "no company"}${v.hostName ? `, ${v.hostName}` : ", nobody in particular"}. To change it, choose the people they visited; their company comes with them. With nobody chosen it stays as it is.` }) },
        { node: picker.node }
      ] : []),
      { type: "heading", label: "When" },
      { name: "checkedInAt", label: "Arrived", type: "datetime-local", required: true, half: true, value: localInputValue(v.checkedInAt), hint: arrivedHow(v) ? `Checked in ${arrivedHow(v)}.` : "" },
      { name: "checkedOutAt", label: "Left", type: "datetime-local", half: true, value: localInputValue(v.checkedOutAt),
        hint: v.checkedOutAt ? (leftHow(v) ? `Checked out ${leftHow(v)}.` : "") : "Empty while they're still here. A time checks them out then." },
      ...(pickId || pickBadge ? [{ type: "heading", label: pickId && pickBadge ? "ID and badge" : pickId ? "ID" : "Badge" }] : []),
      ...(pickId ? [
        { name: "idType", label: "ID shown", type: "select", half: true, value: v.idType || "",
          options: [...(v.idType ? [] : [{ value: "", label: "Not recorded" }]), ...[...new Set([...idKinds, ...(v.idType ? [v.idType] : [])])].map((t) => ({ value: t, label: t }))],
          hint: v.idVerifiedBy ? `Checked by ${v.idVerifiedBy}.` : "",
          // What the other ID was is asked only for an Other government ID.
          onChange: (input, inputs) => { inputs.idOther.closest("label").hidden = input.value !== otherId; } },
        { name: "idOther", label: "What ID was it?", half: true, value: v.idOther || "", placeholder: "A military ID, a tribal ID…" }
      ] : []),
      ...(pickBadge ? [
        { name: "badge", label: "Badge number", half: true, value: onRecord, placeholder: "e.g. V-012 or 101-40001",
          hint: onRecord ? "Change it when the wrong number was recorded: the visit then had this badge all along."
            : `${v.badgeWaivedAt ? `No badge was needed${v.badgeWaivedBy ? ` (said ${v.badgeWaivedBy})` : ""}. ` : "None on record. "}${v.checkedOutAt ? "A number records the badge they had, for the time of the visit." : "A number gives them that badge now."}` }
      ] : []),
      { type: "heading", label: "What for" },
      { name: "purpose", label: "Purpose", value: v.purpose || "" },
      { name: "reason", label: "Reason for the change", type: "textarea", rows: 2, placeholder: "Didn't check out at the kiosk; left at 4:30 PM per the host.", hint: "Needed for any change. Kept with the entry and in the audit log. Times are in this device's time." },
      { node: changes }
    ],
    submitLabel: "Save changes",
    onSubmit: async (values) => {
      const at = (s, label) => {
        const t = new Date(s).getTime();
        if (!s || Number.isNaN(t)) throw new Error(`${label} must be a date and time.`);
        return t;
      };
      // Unchanged to the minute: the time on record is kept, seconds and all.
      const same = (s, ms) => ms && s === localInputValue(ms);
      const body = {};
      if (pickSite && values.siteId !== String(v.siteId)) body.siteId = Number(values.siteId);
      const chosen = picker ? picker.value() : null;
      if (chosen && chosen.hostIds.length && String(chosen.hostIds) !== String(v.hostIds)) Object.assign(body, { hostIds: chosen.hostIds, companyId: chosen.companyId });
      if (values.purpose.trim().replace(/\s+/g, " ") !== (v.purpose || "")) body.purpose = values.purpose;
      if (pickId && values.idType) {
        const other = values.idType === otherId ? values.idOther.trim().replace(/\s+/g, " ") : "";
        if (values.idType === otherId && !other) throw new Error("Say what the other government ID was.");
        if (values.idType !== v.idType || other !== (v.idOther || "")) Object.assign(body, { idType: values.idType, idOther: other || null });
      }
      if (!same(values.checkedInAt, v.checkedInAt)) body.checkedInAt = at(values.checkedInAt, "Arrived");
      if (values.checkedOutAt && !same(values.checkedOutAt, v.checkedOutAt)) body.checkedOutAt = at(values.checkedOutAt, "Left");
      if (!values.checkedOutAt && v.checkedOutAt) body.checkedOutAt = null;
      const typed = pickBadge ? values.badge.trim().replace(/\s+/g, " ") : "";
      const badgeChanged = pickBadge && typed.toLowerCase() !== onRecord.toLowerCase();
      if (badgeChanged && !typed) throw new Error("Enter the badge number, or leave it as it was. A badge is taken back at check-out, or from the Badges page.");
      if (!Object.keys(body).length && !badgeChanged) throw new Error("Nothing was changed.");
      // Whatever is changed, the entry says why: asked for before anything is saved.
      if (values.reason.trim().length < 5) throw new Error("Give the reason for the change.");
      let result = { badgesOut: [] };
      if (Object.keys(body).length) {
        result = await api(`/api/visits/${v.id}`, { method: "PUT", body: { ...body, reason: values.reason } });
        // Saved: what is on record now, should the badge below be refused and Save pressed again.
        v = result.visit;
        savedSome = true;
      }
      if (badgeChanged) {
        try {
          await api(`/api/visits/${v.id}/badge-record`, { method: "POST", body: { number: typed, replace: Boolean(onRecord), reason: values.reason } });
        } catch (error) {
          throw new Error(savedSome ? `The other changes were saved, but not the badge: ${error.message}` : error.message);
        }
      }
      return result;
    }
  });
  if (!saved) return savedSome;
  toast("Entry saved.");
  refreshCounts();
  // A corrected time checked them out with a badge still theirs: was it returned?
  if (saved.badgesOut?.length) {
    try {
      await settleBadgesAfterVisit(v, saved.badgesOut);
    } catch (error) {
      toast(error.message, "error");
    }
  }
  return true;
}

function visitsQuery() {
  const q = $("visits-search").value.trim();
  return {
    status: $("visits-status").value,
    ...($("visits-from").value ? { from: $("visits-from").value } : {}),
    ...($("visits-to").value ? { to: $("visits-to").value } : {}),
    ...(q ? { q } : {}),
    ...($("visits-corrected").checked ? { corrected: "1" } : {}),
    ...siteQuery()
  };
}

async function loadVisits() {
  const table = $("visits-table");
  showFilterCounts();
  let data;
  try {
    data = await api(`/api/visits?${new URLSearchParams({ ...visitsQuery(), limit: String(VISITS_PAGE), offset: String(visitsView.offset) })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(1, error.message));
    return;
  }
  const fresh = visitsTable(data.visits, { onChange: loadVisits }).querySelector("table");
  table.replaceChildren(...fresh.children);
  const from = data.total ? visitsView.offset + 1 : 0;
  $("visits-page").textContent = `${from}-${visitsView.offset + data.visits.length} of ${data.total}`;
  $("visits-prev").disabled = visitsView.offset === 0;
  $("visits-next").disabled = visitsView.offset + VISITS_PAGE >= data.total;
}

const reloadVisits = debounce(() => { visitsView.offset = 0; loadVisits(); }, 250);
for (const id of ["visits-status", "visits-from", "visits-to", "visits-corrected"]) $(id).addEventListener("change", reloadVisits);
$("visits-search").addEventListener("input", reloadVisits);
$("visits-prev").addEventListener("click", () => { visitsView.offset = Math.max(0, visitsView.offset - VISITS_PAGE); loadVisits(); });
$("visits-next").addEventListener("click", () => { visitsView.offset += VISITS_PAGE; loadVisits(); });
$("visits-export").addEventListener("click", () => {
  download(`/api/visits.csv?${new URLSearchParams(visitsQuery())}`).catch((error) => toast(error.message, "error"));
});

function showVisits() {
  loadVisits();
}
