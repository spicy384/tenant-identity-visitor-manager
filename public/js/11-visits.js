// 11-visits.js: the visit log, with filters and CSV export, and the visits table the
// visitor dialog shares. Staff who check visitors in can correct when one arrived or left,
// giving the reason; each correction is kept with the visit and in the audit log.

const VISITS_PAGE = 100;
const visitsView = { offset: 0 };

const CHECKOUT_LABELS = { kiosk: "at the kiosk", staff: "by staff", auto: "at end of day" };

/**
 * A table of visits. showVisitor: include the visitor's name (the log does, the visitor dialog
 * doesn't). onChange: called after a visit's times are corrected.
 */
function visitsTable(visits, { showVisitor = true, onChange = () => {} } = {}) {
  const allSites = multiSite();
  const correcting = canEditVisitors();
  // The badge each visitor had, for those who see badges; entered later by those who give them out.
  const seesBadges = canReadBadges();
  const entersBadges = correcting && canEditBadges();
  const head = ["Arrived", "Left", ...(showVisitor ? ["Visitor"] : []), "Visiting", "Host", ...(seesBadges ? ["Badge"] : []), ...(allSites ? ["Site"] : []), ...(correcting ? [""] : [])];
  return h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, head.map((t) => h("th", { text: t })))),
    h("tbody", {}, visits.length ? visits.map((v) => h("tr", { class: v.timesCorrected ? "time-changed" : null },
      h("td", { class: "nowrap small-text" }, fmtDateTime(v.checkedInAt), v.timeChanged?.in ? changedMark(v, onChange) : null),
      h("td", { class: "small-text" }, v.checkedOutAt
        ? [fmtDateTime(v.checkedOutAt), v.timeChanged?.out ? changedMark(v, onChange) : null, h("div", { class: "muted", text: CHECKOUT_LABELS[v.checkoutMethod] || "" })]
        : h("span", { class: "badge ok", text: "In the building" })),
      showVisitor ? h("td", {}, h("a", { href: `#visitor/${v.visitorId}`, text: visitorName(v.visitor) }), v.visitor.organization ? h("div", { class: "muted small-text", text: v.visitor.organization }) : null) : null,
      h("td", { text: v.companyName || "" }, v.purpose ? h("div", { class: "muted small-text", text: v.purpose }) : null),
      h("td", { text: v.hostName || "" }),
      seesBadges ? h("td", { class: "small-text" }, (v.badges || []).length
        ? [h("span", { class: "mono", text: v.badges.join(", ") }), v.badgeRecordedLater ? h("div", { class: "muted", text: "entered later" }) : null]
        : entersBadges ? h("button", { type: "button", class: "link-btn small-text nowrap", text: "Add badge", onclick: async () => { if (await recordVisitBadge(v)) onChange(); } }) : h("span", { class: "muted", text: "None" })) : null,
      allSites ? h("td", { class: "small-text", text: v.siteName }) : null,
      correcting ? h("td", {}, h("button", { type: "button", class: "link-btn small-text nowrap", text: "Correct times", onclick: async () => { if (await correctVisitTimes(v)) onChange(); } })) : null)) : emptyRow(head.length, "No visits."))));
}

/**
 * The mark beside a time that was corrected: "Changed", with who changed it last and why on
 * hover; it opens every correction to the visit.
 */
function changedMark(v, onChange) {
  const last = v.lastCorrection;
  const title = `${v.timesCorrected === 1 ? "Changed" : `Changed ${v.timesCorrected} times; last`} by ${last?.by || "staff"}, ${fmtDateTime(last?.at)}: ${last?.reason || ""}`;
  return h("button", { type: "button", class: "badge warn time-changed-mark", title, "aria-label": title, text: "Changed", onclick: async () => { if (await correctVisitTimes(v, { look: true })) onChange(); } });
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
      { name: "facilityCode", label: "Facility code (optional)", half: true, placeholder: "2-3 digits", hint: "Only if the same number is under more than one code." }
    ],
    submitLabel: ended ? "Record the badge" : "Give the badge",
    onSubmit: async (values) => {
      const r = await api(`/api/visits/${v.id}/badge-record`, { method: "POST", body: { number: values.number, facilityCode: values.facilityCode || null } });
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

/**
 * Corrects when a visitor arrived or left, with the reason (required). The visit's earlier
 * corrections are listed with theirs. With `look`, opens on the corrections. Resolves true
 * when the times were changed.
 */
async function correctVisitTimes(v, { look = false } = {}) {
  let history = [];
  try {
    history = (await api(`/api/visits/${v.id}`)).timeChanges || [];
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
  const field = { in: "Arrived", out: "Left" };
  const past = history.length ? h("div", { class: "stack" },
    h("h4", { text: `Times changed (${history.length})` }),
    h("ul", { class: "plain-list small-text" }, history.map((c) => h("li", {},
      h("strong", { text: `${field[c.field]}: ` }), `${c.from ? fmtDateTime(c.from) : "not checked out"} to ${fmtDateTime(c.to)}`,
      h("div", { class: "muted", text: `${c.reason} (${c.by || "staff"}, ${fmtDateTime(c.at)})` }))))) : null;
  if (look && !canEditVisitors()) {
    await openDialog({ title: `Corrections to ${visitorName(v.visitor)}'s visit`, body: past || h("p", { class: "muted", text: "None." }) });
    return false;
  }
  const saved = await formDialog({
    title: `Correct ${visitorName(v.visitor)}'s visit`,
    intro: h("div", { class: "stack full-row" },
      h("p", { class: "muted", text: `${v.siteName}${v.companyName ? `, visiting ${v.companyName}` : ""}. On record: arrived ${fmtDateTime(v.checkedInAt)}, ${v.checkedOutAt ? `left ${fmtDateTime(v.checkedOutAt)}` : "still in the building"}. Times are in this device's time.` }),
      past || ""),
    fields: [
      { name: "checkedInAt", label: "Arrived", type: "datetime-local", required: true, half: true, value: localInputValue(v.checkedInAt) },
      { name: "checkedOutAt", label: "Left", type: "datetime-local", half: true, value: localInputValue(v.checkedOutAt),
        hint: v.checkedOutAt ? "" : "Empty while they're still here. A time checks them out then." },
      { name: "reason", label: "Reason for the change", type: "textarea", rows: 2, required: true, placeholder: "Didn't check out at the kiosk; left at 4:30 PM per the host.", hint: "Kept with the visit and in the audit log." }
    ],
    submitLabel: "Save the corrected times",
    onSubmit: async (values) => {
      const at = (s, label) => {
        const t = new Date(s).getTime();
        if (!s || Number.isNaN(t)) throw new Error(`${label} must be a date and time.`);
        return t;
      };
      // Unchanged to the minute: the time on record is kept, seconds and all.
      const same = (s, ms) => ms && s === localInputValue(ms);
      const body = { reason: values.reason };
      if (!same(values.checkedInAt, v.checkedInAt)) body.checkedInAt = at(values.checkedInAt, "Arrived");
      if (values.checkedOutAt && !same(values.checkedOutAt, v.checkedOutAt)) body.checkedOutAt = at(values.checkedOutAt, "Left");
      if (!values.checkedOutAt && v.checkedOutAt) body.checkedOutAt = null;
      await api(`/api/visits/${v.id}/times`, { method: "PUT", body });
      return true;
    }
  });
  if (saved) {
    toast("Times corrected.");
    refreshCounts();
  }
  return Boolean(saved);
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
