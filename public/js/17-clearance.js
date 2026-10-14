// 17-clearance.js: clearance validation. The validation tag on people and visitors,
// asking for validation (optionally with the last four of the SSN), and for the Security
// role the queue (#clearance) and validating, which is the only way a clearance is set.
// The digits are typed into a masked box and sent once; Security sees them only on asking,
// in the validation dialog, for a short while. Nothing here keeps them.

const CLEARANCE_STATUS = {
  unvalidated: { label: "Not validated", cls: "muted" },
  requested: { label: "Validation requested", cls: "warn" },
  validated: { label: "Validated", cls: "ok" },
  recheck: { label: "Re-check due", cls: "bad" }
};
const DIGITS_SHOWN_MS = 30 * 1000;
const clearanceView = { loaded: [] };

const isSecurity = () => Boolean(state.config?.clearance?.security);
const canAskValidation = (kind) => isSecurity() || (kind === "person" ? canEditDirectory() : canEditVisitors());
const CLEARANCE_KEYS = ["clearanceStatus", "clearanceLevel", "clearanceGranted", "clearanceExpires", "clearanceValidatedAt", "clearanceValidatedBy"];

/** The validation tag, or null when the caller doesn't see it. */
function clearanceTag(record) {
  const s = CLEARANCE_STATUS[record?.clearanceStatus];
  return s ? h("span", { class: `badge ${s.cls}`, text: s.label, title: "Clearance validation" }) : null;
}

/** When a visitor's validation runs out, as a date, or null. */
function recheckDue(record) {
  if (!record?.clearanceValidatedAt) return null;
  return record.clearanceValidatedAt + (state.config.clearance?.visitorRecheckDays || 90) * DAY_MS;
}

/**
 * The clearance block on a person's or visitor's dialog: the tag, what is on record (as far
 * as the caller sees it), and the buttons to ask for validation or (Security) validate.
 * `done` runs after a change so the dialog can refresh.
 */
function clearanceSection(kind, record, done) {
  if (record.clearanceStatus === undefined) return null;
  const dl = h("dl", { class: "facts inline-facts" });
  const fact = (label, value) => dl.append(h("dt", { text: label }), h("dd", { text: value }));
  if (record.clearanceLevel !== undefined) fact("Level", clearanceText(record));
  if (record.clearanceGranted) fact("Granted", fmtDate(Date.parse(`${record.clearanceGranted}T12:00:00`)));
  if (record.clearanceExpires) fact("Expires", fmtDate(Date.parse(`${record.clearanceExpires}T12:00:00`)));
  if (record.clearanceValidatedAt) fact("Validated", `${fmtDateTime(record.clearanceValidatedAt)}${record.clearanceValidatedBy ? ` by ${record.clearanceValidatedBy}` : ""}`);
  if (kind === "visitor" && record.clearanceValidatedAt) fact(record.clearanceStatus === "recheck" ? "Re-check was due" : "Re-check due", fmtDate(recheckDue(record)));
  const buttons = [];
  if (canAskValidation(kind) && record.clearanceStatus !== "requested") {
    buttons.push(h("button", { type: "button", class: "secondary small", text: record.clearanceStatus === "unvalidated" ? "Request validation" : "Request re-validation",
      onclick: async () => { if (await requestValidation(kind, record)) done(); } }));
  }
  if (isSecurity()) {
    buttons.push(h("button", { type: "button", class: "primary small", text: "Validate clearance", onclick: async () => {
      const request = record.clearanceStatus === "requested" ? (await api("/api/clearance/requests")).requests.find((q) => q.kind === kind && q.holderId === record.id) : null;
      if (await validateClearance(kind, record, request)) done();
    } }));
  }
  return h("div", { class: "stack clearance-section" },
    h("h4", {}, "Clearance ", clearanceTag(record)),
    dl.children.length ? dl : null,
    record.clearanceStatus === "requested" ? h("p", { class: "muted small-text", text: "Waiting for the Security role to validate it." }) : null,
    buttons.length ? h("div", { class: "btn-row" }, buttons) : null);
}

/** A masked box for the last four of the SSN: not a password field, so nothing offers to save it. */
function digitsInput() {
  return h("input", { type: "text", class: "masked-digits", inputmode: "numeric", maxlength: "4", pattern: "[0-9]{4}", autocomplete: "off", spellcheck: "false",
    "data-lpignore": "true", "data-1p-ignore": "true", "data-bwignore": "true", "data-form-type": "other", "aria-label": "Last four of the SSN" });
}

/** Asks the Security role to validate someone's clearance. Returns true when asked. */
async function requestValidation(kind, record) {
  const name = kind === "visitor" ? visitorName(record) : personName(record);
  const digits = digitsInput();
  const hours = state.config.clearance?.digitsHeldHours || 36;
  try {
    const done = await formDialog({
      title: `Request validation for ${name}`,
      intro: h("p", { class: "muted", text: "The Security role checks the clearance and validates it. Until then it doesn't count for badges." }),
      fields: [
        { node: h("label", { class: "full-row" }, h("span", { text: "Last four of their SSN (optional)" }), digits,
          h("span", { class: "hint", text: `Only the Security role sees it, for this validation. It is never stored: it is wiped when Security validates or cancels, or after ${hours} hours.` })) },
        { name: "note", label: "Note for Security (optional)", type: "textarea", rows: 2, hint: "Kept with the request. Leave the SSN digits out of it." }
      ],
      submitLabel: "Request validation",
      onSubmit: async (v) => {
        const last4 = digits.value.trim();
        if (last4 && !/^\d{4}$/.test(last4)) throw new Error("The last four of the SSN are four digits.");
        return api("/api/clearance/requests", { method: "POST", body: { kind, id: record.id, last4: last4 || null, note: v.note || null } });
      }
    });
    if (done) {
      toast(`Asked Security to validate ${name}'s clearance.`);
      refreshCounts();
    }
    return Boolean(done);
  } finally {
    digits.value = "";
  }
}

/**
 * The Security role validates a clearance: the level (or none), when it was granted and
 * when it expires. With a waiting request that came with digits, they can be shown here.
 */
async function validateClearance(kind, record, request = null) {
  const name = kind === "visitor" ? visitorName(record) : personName(record);
  let hideDigits = () => {};
  const extra = [];
  if (request) {
    extra.push(h("div", { class: "readonly-field full-row" }, h("span", { class: "label", text: "Requested" }),
      h("div", { text: `${fmtDateTime(request.requestedAt)}${request.requestedBy ? ` by ${request.requestedBy}` : ""}${request.note ? `: ${request.note}` : ""}` })));
  }
  if (request?.hadDigits) {
    const out = h("span", { class: "mono digits-out", text: request.digitsHeld ? "••••" : "Wiped (kept only for a limited time)" });
    let timer = null;
    const show = h("button", { type: "button", class: "link-btn", text: "Show", hidden: !request.digitsHeld });
    hideDigits = () => {
      clearTimeout(timer);
      timer = null;
      if (request.digitsHeld) out.textContent = "••••";
      show.textContent = "Show";
    };
    show.addEventListener("click", async () => {
      if (timer) return hideDigits();
      try {
        const r = await api(`/api/clearance/requests/${request.id}/digits`, { method: "POST" });
        out.textContent = r.last4;
        show.textContent = "Hide";
        timer = setTimeout(hideDigits, DIGITS_SHOWN_MS);
      } catch (error) {
        toast(error.message, "error");
        if (error.status === 410 || error.status === 404) {
          request.digitsHeld = false;
          out.textContent = "Wiped";
          show.hidden = true;
        }
      }
      return null;
    });
    extra.push(h("div", { class: "readonly-field full-row" }, h("span", { class: "label", text: "Last four of their SSN" }),
      h("div", {}, out, " ", show), h("span", { class: "hint", text: "Shown for 30 seconds. Wiped from the system when you validate or cancel." })));
  }
  const levels = state.config.clearanceLevels || [];
  try {
    const done = await formDialog({
      title: `Validate ${name}'s clearance`,
      intro: h("p", { class: "muted", text: kind === "visitor"
        ? `Choose the clearance you confirmed. A visitor's validation lasts ${state.config.clearance?.visitorRecheckDays || 90} days, then needs re-checking.`
        : "Choose the clearance you confirmed. It counts for badges from now on." }),
      fields: [
        ...extra.map((node) => ({ node })),
        { name: "levelId", label: "Clearance level", type: "select", value: record.clearanceLevel ? String(record.clearanceLevel) : "", options: [{ value: "", label: "No clearance" }, ...levels.map((l) => ({ value: String(l.id), label: l.name }))] },
        { name: "granted", label: "Granted", type: "date", half: true, value: record.clearanceGranted || "" },
        { name: "expires", label: "Expires", type: "date", half: true, value: record.clearanceExpires || "" }
      ],
      submitLabel: "Validate",
      onSubmit: (v) => api("/api/clearance/validate", { method: "POST", body: { kind, id: record.id, levelId: v.levelId ? Number(v.levelId) : null, granted: v.granted || null, expires: v.expires || null } })
    });
    if (done) {
      toast(`Validated: ${done.level ? done.level.name : "no clearance"}.${done.closed ? " The request is closed and its digits wiped." : ""}`);
      refreshCounts();
    }
    return Boolean(done);
  } finally {
    hideDigits();
  }
}

// --- the Security role's queue -------------------------------------------------------------------

async function showClearance() {
  const list = $("clearance-list");
  let data;
  try {
    data = await api("/api/clearance/requests");
  } catch (error) {
    clear(list).append(h("p", { class: "muted", text: error.message }));
    return;
  }
  clearanceView.loaded = data.requests;
  const digitsText = (q) => (q.digitsHeld ? "Held" : q.hadDigits ? "Wiped" : "Not given");
  clear(list).append(data.requests.length
    ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Name", "Clearance on record", "Requested", "Note", "SSN last four", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, data.requests.map((q) => h("tr", {},
        h("td", {}, h("a", { href: q.kind === "visitor" ? `#visitor/${q.holderId}` : `#person/${q.holderId}`, text: q.name }),
          h("div", { class: "muted small-text", text: [q.kind === "visitor" ? "Visitor" : "Person", q.organisation].filter(Boolean).join(" · ") })),
        h("td", { class: "small-text" }, q.currentLevel || "None", q.lastValidatedAt ? h("div", { class: "muted", text: `last validated ${fmtDate(q.lastValidatedAt)}` }) : null),
        h("td", { class: "small-text nowrap" }, fmtDateTime(q.requestedAt), q.requestedBy ? h("div", { class: "muted", text: `by ${q.requestedBy}` }) : null),
        h("td", { class: "small-text", text: q.note || "" }),
        h("td", { class: `small-text${q.hadDigits && !q.digitsHeld ? " muted" : ""}`, text: digitsText(q) }),
        h("td", {}, h("div", { class: "btn-row" },
          h("button", { type: "button", class: "primary small", text: "Validate", onclick: () => validateFromQueue(q) }),
          h("button", { type: "button", class: "link-btn danger-text", text: "Cancel", onclick: async () => {
            if (!(await confirmDialog(`Cancel the request for ${q.name}?${q.digitsHeld ? " The SSN digits given with it are wiped." : ""}`, { confirmLabel: "Cancel request", danger: true }))) return;
            try {
              await api(`/api/clearance/requests/${q.id}/cancel`, { method: "POST" });
              toast("Request cancelled.");
              refreshCounts();
              showClearance();
            } catch (error) {
              toast(error.message, "error");
            }
          } }))))))))
    : h("p", { class: "muted", text: "Nothing waiting. Requests appear here when someone asks for a clearance to be validated." }));
  $("clearance-hint").textContent = `SSN digits given with a request are kept in memory only, never stored or logged, and wiped when you validate or cancel, or after ${data.digitsHeldHours} hours.`;
}

async function validateFromQueue(q) {
  let record;
  try {
    record = q.kind === "visitor" ? (await api(`/api/visitors/${q.holderId}`)).visitor : (await api(`/api/people/${q.holderId}`)).person;
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  if (await validateClearance(q.kind, record, q)) showClearance();
}

$("clearance-refresh").addEventListener("click", () => showClearance());

// --- Settings > Badges and clearances: the visitor re-check period ---------------------------------

function recheckPanel() {
  const days = h("input", { type: "number", min: "1", max: "3650", step: "1", value: String(state.config.clearance?.visitorRecheckDays || 90), "aria-label": "Days between re-checks", class: "narrow" });
  return h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Visitor clearance re-check" })),
    h("p", { class: "muted", text: "A visitor's validated clearance counts for this many days; after that it shows Re-check due and counts as none until Security validates it again. People's validations don't lapse (their clearance's own expiry date still applies)." }),
    h("div", { class: "btn-row" }, h("span", { text: "Re-check every" }), days, h("span", { text: "days" }),
      h("button", { type: "button", class: "primary small", text: "Save", onclick: async () => {
        try {
          await api("/api/clearance/settings", { method: "PUT", body: { visitorRecheckDays: Number(days.value) } });
          await reloadConfig();
          toast("Saved.");
        } catch (error) {
          toast(error.message, "error");
        }
      } })));
}
