// 26-security-mail.js: Security's mail. The monitoring center's alarm notices and the guard
// company's daily activity reports, brought in from the shared mailbox (or dropped in as a
// file) and shown as easy-to-read reports. Each is unread, in bold, until someone opens it.
// Settings > Security mail sets the mailbox up (administrators).

const SECMAIL_PAGE = 50;
const secMailView = { alarms: { offset: 0 }, guard: { offset: 0 } };

// --- bringing mail in ------------------------------------------------------------------------

/** Sends one file (an .msg, an .eml or a guard report PDF) to be read: { kind, id, duplicate }. */
async function uploadSecurityMail(file) {
  const headers = { "content-type": "application/octet-stream" };
  if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  const res = await fetch(`/api/security/mail/upload?${new URLSearchParams({ name: file.name })}`, { method: "POST", headers, body: file, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The file couldn't be read (HTTP ${res.status}).`);
  return data;
}

/** Lets Security pick emails (or PDFs) and adds each that is an alarm notice or a guard report. */
function addSecurityMailFiles() {
  const input = h("input", { type: "file", multiple: true, accept: ".msg,.eml,.pdf,application/pdf,message/rfc822,application/vnd.ms-outlook" });
  input.addEventListener("change", async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    const done = { alarm: 0, guard: 0, duplicate: 0 };
    const problems = [];
    for (const f of files) {
      try {
        const r = await uploadSecurityMail(f);
        if (r.duplicate) done.duplicate += 1;
        else done[r.kind] += 1;
      } catch (error) {
        problems.push(`${f.name}: ${error.message}`);
      }
    }
    const parts = [done.alarm ? `${done.alarm} ${done.alarm === 1 ? "alarm" : "alarms"}` : null, done.guard ? `${done.guard} guard ${done.guard === 1 ? "report" : "reports"}` : null].filter(Boolean);
    if (parts.length || done.duplicate) toast(`${parts.length ? `Added ${parts.join(" and ")}.` : ""}${done.duplicate ? ` ${done.duplicate} already here.` : ""}`.trim());
    if (problems.length) toast(problems.join(" "), "error");
    refreshCounts();
    refreshCurrentView();
  });
  input.click();
}

/** Asks for the mailbox to be checked now, and says what came. */
async function checkSecurityMailbox(button) {
  if (button) button.disabled = true;
  try {
    const r = await api("/api/security/mail/check", { method: "POST" });
    const parts = [r.alarms ? `${r.alarms} new ${r.alarms === 1 ? "alarm" : "alarms"}` : null, r.reports ? `${r.reports} new guard ${r.reports === 1 ? "report" : "reports"}` : null].filter(Boolean);
    toast(parts.length ? `Checked: ${parts.join(", ")}.` : "Checked: nothing new.");
    refreshCounts();
    refreshCurrentView();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/** Marks one opened (for everyone: like mail, read once someone has opened it). */
async function markSecurityMailRead(list, id, read = true) {
  try {
    await api(`/api/security/${list}/${id}/read`, { method: "POST", body: { read } });
    refreshCounts();
  } catch {
    // Being marked read is a convenience; the report shows anyway.
  }
}

const mailRowClass = (x) => `clickable mail-row${x.read ? "" : " is-unread"}`;
const unreadDot = (x) => h("td", { class: "mail-dot-cell" }, x.read ? null : h("span", { class: "mail-dot", title: "Not opened yet", "aria-label": "Not opened yet" }));

/** "1-50 of 120", and the pager's buttons. */
function secMailPager(prefix, view, shown, total) {
  const from = total ? view.offset + 1 : 0;
  $(`${prefix}-page`).textContent = `${from}-${view.offset + shown} of ${total}`;
  $(`${prefix}-prev`).disabled = view.offset === 0;
  $(`${prefix}-next`).disabled = view.offset + shown >= total;
}

// --- alarms ----------------------------------------------------------------------------------------

/** What an alarm came to, in a line: who disarmed it, who verified, dispatch. */
function alarmOutcomeText(a) {
  const o = a.outcome || {};
  return [o.disarmedBy ? `Disarmed by ${o.disarmedBy}` : null, o.verifiedBy ? `verified by ${o.verifiedBy}` : null, o.dispatch || null].filter(Boolean).join(" · ") || (o.cleared ? "Cleared" : "");
}

function showAlarms() {
  $("alarms-check").hidden = !state.config.securityMail?.mailbox;
  loadAlarms();
}

async function loadAlarms() {
  const table = $("alarms-table");
  const head = ["", "Received", "Alarm", "Where", "What it came to", ...(multiSite() ? ["Site"] : [])];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  const view = secMailView.alarms;
  let data;
  try {
    data = await api(`/api/security/alarms?${new URLSearchParams({ limit: String(SECMAIL_PAGE), offset: String(view.offset), q: $("alarms-search").value.trim(), ...($("alarms-unread").checked ? { unread: "1" } : {}), ...siteQuery() })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  $("alarms-hint").textContent = state.config.securityMail?.mailbox
    ? "Alarm notices from the monitoring center come in from the shared mailbox every few minutes. Bold ones haven't been opened yet."
    : "No mailbox is set up yet (an administrator does that under Settings > Security mail), so add alarm emails here from a file: drag them out of Outlook and save them.";
  const rows = data.alarms.map((a) => h("tr", { class: mailRowClass(a), onclick: () => { location.hash = `#alarm/${a.id}`; } },
    unreadDot(a),
    h("td", { class: "nowrap", text: fmtDateTime(a.receivedAt) }),
    h("td", {}, h("strong", { text: a.event || "Alarm" }), a.zone ? h("div", { class: "muted small-text", text: `Zone ${a.zone}${a.zoneName ? ` · ${a.zoneName}` : ""}${a.area ? ` · Area ${a.area}` : ""}` }) : null),
    h("td", {}, h("span", { text: a.accountName || "" }), h("div", { class: "muted small-text mono", text: a.account || "" })),
    h("td", { class: "small-text", text: alarmOutcomeText(a) }),
    multiSite() ? h("td", { class: a.siteName ? "small-text" : "small-text muted", text: a.siteName || "Not placed" }) : null));
  clear(table.tBodies[0]).append(...(rows.length ? rows : [emptyRow(head.length, $("alarms-unread").checked ? "Every alarm has been opened." : "No alarms yet.")]));
  secMailPager("alarms", view, data.alarms.length, data.total);
}

/**
 * The steps that matter in an alarm's log, oldest first: what the panel signaled, each call
 * with how it went, the dispatch decision, and when it was cleared. tone: bad, ok or muted.
 */
function alarmSteps(alarm) {
  const s = alarm.summary || {};
  const steps = [];
  for (const e of alarm.log || []) {
    const action = e.action || "";
    const panel = /^DMP\w* - (.*)$/i.exec(action);
    if (panel) {
      const what = panel[1];
      steps.push({ time: e.time, tone: /ALARM/i.test(what) ? "bad" : /OPENING|CANCEL|DISAR/i.test(what) ? "ok" : "muted",
        text: `Panel: ${what}${e.who ? `, ${e.who}` : ""}`, note: /OPENING|CANCEL|DISAR/i.test(what) && s.disarmUser ? `User ${s.disarmUser}` : null });
    } else if (/^Call\b/i.test(action)) {
      const call = (s.calls || []).find((c) => c.time === e.time && c.phone === e.phone) || {};
      const result = call.verified === true ? "verified" : call.verified === false ? "not verified" : null;
      steps.push({ time: e.time, tone: call.verified === true ? "ok" : call.verified === false ? "bad" : "muted",
        text: `Called ${call.who || e.who || "someone"}${e.phone ? ` (${e.phone})` : ""}${call.outcome ? `: ${call.outcome}` : ""}${result ? `; ${result}` : ""}`, note: call.note || null });
    } else if (/Action Plan Decision/i.test(action) && e.comment) {
      steps.push({ time: e.time, tone: /no dispatch/i.test(e.comment) ? "muted" : "bad", text: e.comment.replace("/", ": ") });
    } else if (/dispatch/i.test(action) && !/window|decision/i.test(action)) {
      steps.push({ time: e.time, tone: "bad", text: action, note: e.comment });
    } else if (/Full Clear/i.test(action)) {
      steps.push({ time: e.time, tone: "ok", text: "Cleared by the monitoring center" });
    } else if (/EmailSent/i.test(action)) {
      steps.push({ time: e.time, tone: "muted", text: "This email sent", note: e.comment ? e.comment.replace(/\[[^\]]*\]/, "").trim() : null });
    }
  }
  return steps;
}

async function openAlarm(id) {
  let alarm;
  try {
    ({ alarm } = await api(`/api/security/alarms/${id}`));
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  if (!alarm.read) markSecurityMailRead("alarms", id).then(() => { if (state.view === "alarms") loadAlarms(); });
  const a = alarm.alarm;
  const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : null);
  const steps = alarmSteps(a);
  const body = h("div", { class: "stack" },
    h("div", { class: "mail-banner" },
      h("div", { class: "mail-banner-title", text: a.event || "Alarm" }),
      h("div", { class: "muted", text: [a.zone ? `Zone ${a.zone}${a.zoneName ? `, ${a.zoneName}` : ""}` : null, a.area ? `Area ${a.area}` : null, a.when].filter(Boolean).join(" · ") })),
    h("dl", { class: "facts inline-facts" },
      fact("Account", [a.accountName, a.account].filter(Boolean).join(" · ")),
      fact("Address", a.address?.join(", ")),
      multiSite() ? fact("Site", alarm.siteName || "Not placed at a site yet") : null,
      fact("Reference", a.reference ? `#${a.reference}${a.eventNumber ? ` (event #${a.eventNumber})` : ""}` : null),
      fact("Monitoring", [a.center, a.centerPhone].filter(Boolean).join(" · ")),
      fact("Received", fmtDateTime(alarm.receivedAt)),
      fact("First opened", alarm.readAt ? `${fmtDateTime(alarm.readAt)}${alarm.readBy ? ` by ${alarm.readBy}` : ""}` : "Now")),
    h("div", { class: "panel" },
      h("h3", { text: "What happened" }),
      steps.length
        ? h("ol", { class: "mail-steps" }, steps.map((st) => h("li", { class: `tone-${st.tone}` },
          h("span", { class: "mail-step-time mono", text: st.time }),
          h("div", {}, h("div", { text: st.text }), st.note ? h("div", { class: "muted small-text", text: st.note }) : null))))
        : h("p", { class: "muted", text: "The log has nothing to sum up; every step is below." })),
    h("details", { class: "mail-more" },
      h("summary", { text: `Every step the monitoring center logged (${(a.log || []).length})` }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Time", "Event or action", "Phone", "Point or person", "Notes"].map((t) => h("th", { text: t })))),
        h("tbody", {}, (a.log || []).map((e) => h("tr", {},
          h("td", { class: "mono nowrap", text: e.time }),
          h("td", { text: e.action }),
          h("td", { class: "mono", text: e.phone || "" }),
          h("td", { text: e.who || "" }),
          h("td", { class: "small-text", text: [e.disposition, e.comment].filter(Boolean).join(" · ") }))))))),
    a.link ? h("p", { class: "muted small-text" }, "More detail is in the monitoring center's own site: ", h("a", { href: a.link, target: "_blank", rel: "noopener noreferrer", text: a.link })) : null);
  await openDialog({
    title: [a.event || "Alarm", a.accountName].filter(Boolean).join(": "),
    body,
    wide: true,
    actions: [
      { label: "Mark unread", kind: "secondary", onClick: async () => { await markSecurityMailRead("alarms", id, false); if (state.view === "alarms") loadAlarms(); return true; } },
      { label: "Close", value: null, kind: "primary" }
    ]
  });
  if (location.hash === `#alarm/${id}`) history.replaceState(null, "", "#alarms");
}

$("alarms-search").addEventListener("input", debounce(() => { secMailView.alarms.offset = 0; loadAlarms(); }, 250));
$("alarms-unread").addEventListener("change", () => { secMailView.alarms.offset = 0; loadAlarms(); });
$("alarms-prev").addEventListener("click", () => { secMailView.alarms.offset = Math.max(0, secMailView.alarms.offset - SECMAIL_PAGE); loadAlarms(); });
$("alarms-next").addEventListener("click", () => { secMailView.alarms.offset += SECMAIL_PAGE; loadAlarms(); });
$("alarms-add").addEventListener("click", addSecurityMailFiles);
$("alarms-check").addEventListener("click", (e) => checkSecurityMailbox(e.currentTarget));

// --- guard reports -----------------------------------------------------------------------------------

/** "Tue, Oct 27, 2026" from a YYYY-MM-DD. */
function guardDateText(date) {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function showGuardReports() {
  $("guard-check").hidden = !state.config.securityMail?.mailbox;
  loadGuardReports();
}

async function loadGuardReports() {
  const table = $("guard-table");
  const head = ["", "Report", "Site", "Officers", "Activity", "Needs a look", ...(multiSite() ? ["Placed at"] : [])];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  const view = secMailView.guard;
  let data;
  try {
    data = await api(`/api/security/guard-reports?${new URLSearchParams({ limit: String(SECMAIL_PAGE), offset: String(view.offset), q: $("guard-search").value.trim(), ...($("guard-unread").checked ? { unread: "1" } : {}), ...siteQuery() })}`);
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  const rows = data.reports.map((r) => h("tr", { class: mailRowClass(r), onclick: () => { location.hash = `#guard-report/${r.id}`; } },
    unreadDot(r),
    h("td", {}, h("strong", { text: guardDateText(r.date) || fmtDate(r.receivedAt) }), r.range ? h("div", { class: "muted small-text", text: r.range }) : null),
    h("td", {}, h("span", { text: r.site || "" }), r.company ? h("div", { class: "muted small-text", text: r.company }) : null),
    h("td", { class: "small-text", text: r.officers.join(", ") }),
    h("td", { class: "small-text", text: `${r.reports} ${r.reports === 1 ? "report" : "reports"} · ${r.tours} ${r.tours === 1 ? "tour" : "tours"}` }),
    h("td", {},
      r.incidents ? h("span", { class: "badge bad", text: `${r.incidents} ${r.incidents === 1 ? "incident" : "incidents"}` }) : null,
      r.missed ? h("span", { class: "badge warn", text: `${r.missed} missed` }) : null,
      r.answeredNo ? h("span", { class: "badge muted", text: `${r.answeredNo} answered No` }) : null),
    multiSite() ? h("td", { class: r.siteName ? "small-text" : "small-text muted", text: r.siteName || "Not placed" }) : null));
  clear(table.tBodies[0]).append(...(rows.length ? rows : [emptyRow(head.length, $("guard-unread").checked ? "Every report has been opened." : "No guard reports yet.")]));
  secMailPager("guard", view, data.reports.length, data.total);
}

/** One entry of a guard report as a line of the timeline: what it was, and its details. */
function guardEntryText(e) {
  if (e.checkpoint) return `${e.checkpoint.completed ? "Scanned" : "Missed"} ${e.checkpoint.name}`;
  return [e.headline, e.body].filter(Boolean).join(": ");
}

async function openGuardReport(id) {
  let report;
  try {
    ({ report } = await api(`/api/security/guard-reports/${id}`));
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  if (!report.read) markSecurityMailRead("guard-reports", id).then(() => { if (state.view === "guard-reports") loadGuardReports(); });
  const r = report.report;
  const s = r.summary || {};
  const entries = r.entries || [];
  const section = (title, ...content) => h("div", { class: "panel" }, h("h3", { text: title }), ...content);
  const reportCard = (e) => h("article", { class: `guard-card${e.flagged ? " is-flagged" : ""}` },
    h("div", { class: "guard-card-head" }, h("strong", { text: e.headline || e.type }), h("span", { class: "muted small-text", text: `${e.time}${e.officer ? ` · ${e.officer}` : ""}` })),
    e.body ? h("p", { text: e.body }) : null,
    Object.keys(e.fields || {}).length ? h("p", { class: "muted small-text", text: Object.entries(e.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ") }) : null);
  const stat = (label, n) => h("div", { class: "dash-stat" }, h("strong", { text: String(n) }), h("span", { class: "muted small-text", text: label }));
  const body = h("div", { class: "stack" },
    h("div", { class: "row-between" },
      h("div", {}, h("div", { class: "mail-banner-title", text: `${r.site || "Guard report"}${r.date ? `, ${guardDateText(r.date)}` : ""}` }),
        h("div", { class: "muted", text: [r.company, r.range].filter(Boolean).join(" · ") })),
      report.hasPdf ? h("a", { class: "secondary button-link", href: `/api/security/guard-reports/${id}/pdf`, target: "_blank", rel: "noopener", text: "Open the original PDF" }) : null),
    Object.keys(r.counts || {}).length ? h("div", { class: "dash-stats" }, Object.entries(r.counts).map(([k, n]) => stat(k, n))) : null,
    s.shifts?.length ? section("Who was on duty", h("ul", { class: "plain-list" }, s.shifts.map((x) => h("li", {}, h("strong", { text: x.officer || "Officer" }), h("span", { class: "muted", text: ` ${x.in || "?"} to ${x.out || "still on duty at the end of the report"}` }))))) : null,
    s.incidents?.length ? section("Incidents", h("div", { class: "stack" }, s.incidents.map((i) => reportCard(entries[i])))) : null,
    s.missed?.length ? section("Missed checkpoints", h("ul", { class: "plain-list" }, s.missed.map((i) => h("li", { text: `${entries[i].time} · ${entries[i].checkpoint?.name || guardEntryText(entries[i])}${entries[i].officer ? ` · ${entries[i].officer}` : ""}` })))) : null,
    s.reports?.length ? section("What the officers wrote", h("div", { class: "stack" }, s.reports.map((i) => reportCard(entries[i])))) : null,
    s.tours?.length ? section("Patrols",
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Started", "Ended", "Officer", "Checkpoints", "Summary"].map((t) => h("th", { text: t })))),
        h("tbody", {}, s.tours.map((t) => h("tr", {},
          h("td", { class: "nowrap", text: t.start || "" }),
          h("td", { class: "nowrap", text: t.end || "Not ended" }),
          h("td", { text: t.officer || "" }),
          h("td", {}, h("span", { text: `${t.scanned} scanned` }), t.missed ? h("span", { class: "badge warn", text: `${t.missed} missed` }) : null),
          h("td", { class: "small-text", text: t.summary || "" }))))))) : null,
    s.answeredNo?.length ? section("Checkpoint questions answered No",
      h("p", { class: "muted small-text", text: "Worth a look where No isn't the expected answer (a SCIF not armed after hours, say)." }),
      h("ul", { class: "plain-list" }, s.answeredNo.map((x) => {
        const e = entries[x.entry];
        return h("li", {}, h("span", { class: "mono", text: e.time }), ` · ${e.checkpoint?.name || ""}: ${x.question}`, h("span", { class: "muted", text: e.officer ? ` · ${e.officer}` : "" }));
      }))) : null,
    h("details", { class: "mail-more" },
      h("summary", { text: `Everything in the report (${entries.length} entries)` }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Time", "Entry", "Officer", "Details"].map((t) => h("th", { text: t })))),
        h("tbody", {}, entries.map((e) => h("tr", { class: e.flagged ? "is-flagged" : null },
          h("td", { class: "nowrap small-text", text: e.time }),
          h("td", { class: "small-text", text: [e.type, e.status].filter(Boolean).join(" · ") }),
          h("td", { class: "small-text", text: e.officer || "" }),
          h("td", { class: "small-text" }, h("div", { text: guardEntryText(e) }),
            e.answers?.length ? h("div", { class: "muted", text: e.answers.map((x) => `${x.question}: ${x.answer}`).join(" · ") }) : null,
            e.fields?.Location ? h("div", { class: "muted", text: `Location: ${e.fields.Location}` }) : null,
            e.fields?.Summary ? h("div", { class: "muted", text: `Summary: ${e.fields.Summary}` }) : null))))))));
  await openDialog({
    title: `Guard report${r.site ? `: ${r.site}` : ""}`,
    body,
    full: true,
    actions: [
      { label: "Mark unread", kind: "secondary", onClick: async () => { await markSecurityMailRead("guard-reports", id, false); if (state.view === "guard-reports") loadGuardReports(); return true; } },
      { label: "Close", value: null, kind: "primary" }
    ]
  });
  if (location.hash === `#guard-report/${id}`) history.replaceState(null, "", "#guard-reports");
}

$("guard-search").addEventListener("input", debounce(() => { secMailView.guard.offset = 0; loadGuardReports(); }, 250));
$("guard-unread").addEventListener("change", () => { secMailView.guard.offset = 0; loadGuardReports(); });
$("guard-prev").addEventListener("click", () => { secMailView.guard.offset = Math.max(0, secMailView.guard.offset - SECMAIL_PAGE); loadGuardReports(); });
$("guard-next").addEventListener("click", () => { secMailView.guard.offset += SECMAIL_PAGE; loadGuardReports(); });
$("guard-add").addEventListener("click", addSecurityMailFiles);
$("guard-check").addEventListener("click", (e) => checkSecurityMailbox(e.currentTarget));

// --- Settings > Security mail (administrators) --------------------------------------------------------

async function settingsSecurityMail(body) {
  const { settings: m, sources, app } = await api("/api/settings/security-mail");
  const { form } = settingsForm({
    title: "Security's mailbox",
    intro: "The monitoring center's alarm emails and the guard company's daily activity reports go to a shared mailbox. The app reads them from it through Microsoft Graph and shows them to the Security role as easy-to-read reports (Security > Alarms and Guard reports). It only reads: nothing in the mailbox is moved or deleted. Other mail there is passed over. Security can also add one from a file.",
    fields: [
      { name: "enabled", label: "Check the mailbox", type: "checkbox", value: m.enabled },
      { name: "mailbox", label: "Mailbox", value: m.mailbox, half: true, placeholder: "alarmreports@example.com" },
      { name: "pollMinutes", label: "Check every (minutes)", type: "number", value: m.pollMinutes, half: true },
      { name: "keepDays", label: "Keep alarms and reports for (days)", type: "number", value: m.keepDays, half: true, hint: "Then they are deleted, whether they came from the mailbox or a file." },
      { name: "firstDays", label: "The first time, look back (days)", type: "number", value: m.firstDays, half: true, hint: "How far back to bring mail in when a mailbox is first checked." }
    ],
    onSave: async (v) => {
      await api("/api/settings/security-mail", { method: "PUT", body: { enabled: v.enabled, mailbox: v.mailbox, pollMinutes: Number(v.pollMinutes), keepDays: Number(v.keepDays), firstDays: Number(v.firstDays) } });
      await reloadConfig();
      return v.enabled ? "Saved. Check it now to see that Microsoft lets the app in." : "Saved.";
    },
    extra: () => h("button", { type: "button", class: "secondary", text: "Check now", onclick: async (e) => { await checkSecurityMailbox(e.currentTarget); renderSettings(); } })
  });

  const last = m.log[0];
  const status = h("div", { class: "panel" },
    h("h3", { text: "How the checks went" }),
    m.lastError ? h("p", { class: "message error", text: m.lastError }) : last ? h("p", { class: "message success", text: `Last checked ${fmtDateTime(last.at)}.` }) : h("p", { class: "muted", text: "Not checked yet." }),
    m.log.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["When", "By", "What came"].map((t) => h("th", { text: t })))),
      h("tbody", {}, m.log.map((x) => h("tr", {},
        h("td", { class: "nowrap", text: fmtDateTime(x.at) }),
        h("td", { text: x.by === "schedule" ? "On schedule" : x.by }),
        h("td", { class: x.ok ? "small-text" : "small-text bad-text", text: x.ok ? `${x.fetched} emails: ${x.alarms} alarms, ${x.reports} guard reports${x.duplicates ? `, ${x.duplicates} already here` : ""}${x.ignored ? `, ${x.ignored} other mail passed over` : ""}${x.deleted ? `; ${x.deleted} past keeping deleted` : ""}` : x.error })))))) : null);

  const where = h("div", { class: "stack" }, securityAccountsPanel(sources.filter((x) => x.kind === "alarm")), guardSitesPanel(sources.filter((x) => x.kind === "guard")));

  const id = app?.clientId || "<application (client) ID>";
  const steps = h("div", { class: "panel" },
    h("h3", { text: "Letting the app read the mailbox" }),
    h("p", { class: "muted", text: "The app reads the mailbox as itself, with the app registration under Settings > Microsoft Entra ID (the same one people sign in with)." }),
    app?.ready ? null : h("p", { class: "message error", text: "Set up the app registration under Microsoft Entra ID first: the tenant ID, the client ID, and a certificate or client secret." }),
    h("ol", { class: "plain-list numbered" },
      h("li", {}, "In the Entra admin center: App registrations > this app > API permissions > Add a permission > Microsoft Graph > Application permissions > Mail.Read. Then Grant admin consent."),
      h("li", {}, "Mail.Read on its own lets the app read every mailbox, so limit it to this one. In Exchange Online PowerShell, as an Exchange administrator:",
        h("pre", { class: "code", text: `New-ApplicationAccessPolicy -AppId ${id} -PolicyScopeGroupId ${m.mailbox || "alarmreports@example.com"} -AccessRight RestrictAccess -Description "Identity and Visitor Manager reads Security's mail only"` }),
        h("span", { class: "muted", text: "Test it with Test-ApplicationAccessPolicy -Identity <another mailbox> -AppId ... (it should say Denied). The policy can take up to an hour to apply." })),
      h("li", {}, "Turn on Check the mailbox above, give its address, save, and press Check now.")));

  body.append(form, status, where, steps);
}

/** A site picker for an alarm account or guard site, saving as it changes. */
function securitySourceSite(src) {
  const select = h("select", { "aria-label": `Site for ${src.label || src.key}` },
    h("option", { value: "", text: "Not placed" }), state.config.sites.map((s) => h("option", { value: String(s.id), text: s.name })));
  select.value = src.siteId ? String(src.siteId) : "";
  select.addEventListener("change", async () => {
    try {
      await api("/api/settings/security-mail/sources", { method: "PUT", body: { kind: src.kind, key: src.key, siteId: select.value ? Number(select.value) : null } });
      toast("Saved.");
      renderSettings();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  return select;
}

/**
 * Settings > Security mail: the monitoring center's accounts, each at a site (a site may have
 * several), added ahead of their first alarm or listed as their first alarm comes in.
 */
function securityAccountsPanel(accounts) {
  const siteName = (id) => state.config.sites.find((s) => s.id === id)?.name || "";
  // A site's accounts together, the ones not placed first (they need doing).
  const sorted = [...accounts].sort((a, b) => (a.siteId ? 1 : 0) - (b.siteId ? 1 : 0) || siteName(a.siteId).localeCompare(siteName(b.siteId)) || (a.label || a.key).localeCompare(b.label || b.key));
  const editAccount = (src = null) => formDialog({
    title: src ? `Account ${src.key}` : "Add an alarm account",
    intro: src ? null : h("p", { class: "muted", text: "The account number as the monitoring center writes it at the top of its alarm emails (Account: K1234567). Its alarms are then at the site chosen here from the first one." }),
    fields: [
      src ? null : { name: "key", label: "Account number", required: true, half: true, autofocus: true, placeholder: "K1234567" },
      { name: "label", label: "Name", half: Boolean(!src), value: src?.label || "", placeholder: "Wing, floor or suite it covers", hint: src ? "Shown beside the account here. A name given here stays when its alarms come in." : null },
      src ? null : { name: "siteId", label: "Site", type: "select", value: state.config.sites.length === 1 ? String(state.config.sites[0].id) : "", options: [{ value: "", label: "Not placed" }, ...state.config.sites.map((s) => ({ value: String(s.id), label: s.name }))] }
    ].filter(Boolean),
    submitLabel: src ? "Save" : "Add account",
    onSubmit: async (v) => (src
      ? api("/api/settings/security-mail/sources", { method: "PUT", body: { kind: "alarm", key: src.key, label: v.label } })
      : api("/api/settings/security-mail/sources", { method: "POST", body: { kind: "alarm", key: v.key, label: v.label, siteId: v.siteId ? Number(v.siteId) : null } }))
  }).then((r) => { if (r) renderSettings(); });
  return h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Alarm accounts" }), h("button", { type: "button", class: "primary small", text: "Add account", onclick: () => editAccount() })),
    h("p", { class: "muted", text: "Each of the monitoring center's accounts, at the site it covers; a site may have several. Add them ahead of their first alarm, or place them as they come in. Security limited to some sites sees the alarms of theirs; one not placed, only Security who sees every site." }),
    sorted.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Account", "Name", "Alarms", "Site", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, sorted.map((src) => h("tr", {},
        h("td", { class: "mono", text: src.key }),
        h("td", { text: src.label || "" }),
        h("td", { text: String(src.count) }),
        h("td", {}, securitySourceSite(src)),
        h("td", {}, h("div", { class: "btn-row" },
          h("button", { type: "button", class: "link-btn", text: "Rename", onclick: () => editAccount(src) }),
          h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
            const note = src.count ? ` Its ${src.count} ${src.count === 1 ? "alarm stays" : "alarms stay"}, but no longer at a site.` : "";
            if (!(await confirmDialog(`Take account ${src.key} off the list?${note}`, { danger: true, confirmLabel: "Remove" }))) return;
            try {
              await api(`/api/settings/security-mail/sources/alarm/${encodeURIComponent(src.key)}`, { method: "DELETE" });
              renderSettings();
            } catch (error) {
              toast(error.message, "error");
            }
          } }))))))))
      : h("p", { class: "muted small-text", text: "None yet. Add them here, or they are listed as their first alarm comes in." }));
}

/** Settings > Security mail: each site named on a guard report, at one of the app's sites. */
function guardSitesPanel(list) {
  return h("div", { class: "panel" },
    h("h3", { text: "Guard report sites" }),
    h("p", { class: "muted", text: "Each site named on a guard report, as its first report comes in, to place at one of the app's sites." }),
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Name on the report", "Reports", "Site"].map((t) => h("th", { text: t })))),
      h("tbody", {}, list.map((src) => h("tr", {}, h("td", { text: src.key }), h("td", { text: String(src.count) }), h("td", {}, securitySourceSite(src)))))))
      : h("p", { class: "muted small-text", text: "None yet: listed as the first report comes in." }));
}
