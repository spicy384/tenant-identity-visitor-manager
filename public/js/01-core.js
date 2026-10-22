// 01-core.js: element helpers, the api() wrapper, formatting, toasts and dialogs.
// One of the classic scripts index.html loads in order; they share one global scope,
// so a function or const defined here is visible to the files that follow.

const state = {
  me: null,          // the signed-in user
  csrfToken: null,
  config: null,      // { version, access, sites, siteCount }
  schema: null,      // { company: [fields], person: [fields] } the caller can see
  site: "",          // the site picker: "" for every site, else a site id
  view: null
};

const $ = (id) => document.getElementById(id);

/**
 * Builds an element. attrs: class, text, html is never accepted (text only, so nothing
 * from the server is ever parsed as markup), on<event> handlers, dataset, and any
 * other attribute or property. Children may be nodes, strings, arrays or null.
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const isAdmin = () => Boolean(state.config?.access?.isAdmin);
const canEditDirectory = () => state.config?.access?.directory === "edit";
const canReadVisitors = () => ["read", "edit"].includes(state.config?.access?.visitors);
const canEditVisitors = () => state.config?.access?.visitors === "edit";
const canReadBadges = () => ["read", "edit", "manage"].includes(state.config?.access?.badges);
/** Gives badges out and takes them back. */
const canEditBadges = () => ["edit", "manage"].includes(state.config?.access?.badges);
/** Keeps the badge stock: adds, changes and removes badges (Security). */
const canManageBadges = () => state.config?.access?.badges === "manage";
/** Sees clearance level names (Settings > Roles); everyone else sees badge template images instead. */
const canSeeClearances = () => Boolean(state.config?.access?.clearances);
/** Sees floors, offices, who has them and what they cost (Settings > Roles). */
const canReadFacilities = () => ["read", "edit"].includes(state.config?.access?.facilities);
/** Draws floors and offices, assigns them and sets rates. */
const canEditFacilities = () => state.config?.access?.facilities === "edit";
/** Adds and changes custom fields: for one kind of record, or (no argument) for any. */
const canManageFields = (entity = null) => {
  const mine = state.config?.access?.fieldEntities || [];
  return entity ? mine.includes(entity) : mine.length > 0;
};

/** The app's name (header, sign-in page, browser tab) as set under Settings > General. */
function applyBranding(branding) {
  if (!branding) return;
  state.branding = branding;
  document.title = branding.name;
  if ($("brand-name")) $("brand-name").textContent = branding.name;
  if ($("auth-sub")) $("auth-sub").textContent = branding.name;
}
const multiSite = () => (state.config?.sites || []).length > 1;

// --- API -----------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** JSON request to the app's API; throws ApiError with the server's message. */
async function api(url, { method = "GET", body = undefined, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)), credentials: "same-origin" });
  } catch {
    throw new ApiError("Could not reach the server. Check the network connection.", 0, null);
  }
  if (raw) {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error || `Request failed (HTTP ${res.status}).`, res.status, data);
    }
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    // Signed out elsewhere or the session expired: back to the sign-in card.
    showAuth("Your session has ended. Sign in again.");
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (HTTP ${res.status}).`, res.status, data);
  return data;
}

/** Saves a file the server sends (CSV exports, backups) under the name it suggests. */
async function download(url) {
  const res = await api(url, { raw: true });
  const blob = await res.blob();
  const name = (/filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "") || [])[1] || "download";
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** The text of a file the user picks, or null if they cancel. */
function pickFileText(accept = ".csv,text/csv") {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
    });
    input.click();
  });
}

// --- formatting ------------------------------------------------------------------

const DAY_MS = 86400000;

function fmtDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const yesterday = new Date(today.getTime() - DAY_MS);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString([], opts)} ${time}`;
}

function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** "Jane Doe", or "Jane (Janie) Doe" when they go by another name. */
function personName(p) {
  if (!p) return "";
  const preferred = p.preferredName && p.preferredName !== p.firstName ? ` (${p.preferredName})` : "";
  return `${p.firstName || ""}${preferred} ${p.lastName || ""}`.trim();
}

const AREA_LABELS = { none: "No access", read: "Read only", edit: "Read and change" };
const BADGE_LABELS = { none: "No access", read: "Read only", edit: "Issue and return", manage: "Issue, return and manage" };
const ACCESS_LABELS = { hidden: "Hidden", view: "Read only", edit: "Can change" };

// --- feedback --------------------------------------------------------------------

// The toast is a popover so it shows above an open dialog (both live in the top layer,
// and the later one wins); without popover support it moves into the topmost dialog.
let toastTimer = null;
function toast(message, kind = "ok") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  const popover = typeof el.showPopover === "function";
  if (popover) {
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      el.showPopover();
    } catch {
      // Already shown or detached; the text still updated.
    }
  } else {
    const top = [...document.querySelectorAll("dialog[open]")].pop();
    (top || document.body).append(el);
    el.hidden = false;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (popover) {
      try { el.hidePopover(); } catch { /* already hidden */ }
    } else {
      el.hidden = true;
    }
  }, kind === "error" ? 6000 : 3000);
}

// --- dialogs ---------------------------------------------------------------------

/**
 * Opens a modal. `body` is a node; `actions` are { label, kind, value, close=true,
 * onClick } and the promise resolves with the value of the action that closed it
 * (null for Escape or Cancel). An onClick that throws keeps the dialog open and shows
 * the error in it.
 */
function openDialog({ title, body, actions = [{ label: "Close", value: null }], wide = false, full = false, onOpen = null }) {
  return new Promise((resolve) => {
    const error = h("p", { class: "message error pre", hidden: true });
    const footer = h("div", { class: "dialog-actions" });
    const dlg = h("dialog", { class: `dialog${wide ? " wide" : ""}${full ? " full" : ""}` },
      h("div", { class: "dialog-head" }, h("h3", { text: title }), h("button", { type: "button", class: "icon-close", "aria-label": "Close", onclick: () => finish(null) }, "×")),
      h("div", { class: "dialog-body" }, error, body),
      footer);
    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    }
    for (const action of actions) {
      const btn = h("button", { type: "button", class: action.kind || "secondary", text: action.label });
      btn.addEventListener("click", async () => {
        if (!action.onClick) return finish(action.value ?? null);
        error.hidden = true;
        btn.disabled = true;
        try {
          const result = await action.onClick();
          if (action.close !== false) finish(result === undefined ? action.value ?? true : result);
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
          dlg.querySelector(".dialog-body").scrollTop = 0;
        } finally {
          btn.disabled = false;
        }
      });
      footer.append(btn);
    }
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.showError = (message) => { error.textContent = message; error.hidden = !message; };
    dlg.finish = finish;
    document.body.append(dlg);
    dlg.showModal();
    if (onOpen) onOpen(dlg);
  });
}

function confirmDialog(message, { title = "Are you sure?", confirmLabel = "Confirm", danger = false } = {}) {
  return openDialog({
    title,
    body: h("p", { text: message }),
    actions: [{ label: "Cancel", value: false }, { label: confirmLabel, kind: danger ? "danger" : "primary", value: true }]
  });
}

/**
 * A form in a dialog. fields: { name, label, type (text, email, tel, url, textarea,
 * select, checkbox, number, date, password, readonly), value, options [{value,label}],
 * required, placeholder, hint, autofocus, half }. { type: "heading" } adds a heading and
 * { node } any element. onSubmit(values) may throw to keep the dialog open with the
 * message; its return value resolves the promise.
 */
function formDialog({ title, fields, submitLabel = "Save", onSubmit, extraActions = [], wide = false, intro = null }) {
  const form = h("form", { class: "stack form-grid", autocomplete: "off" });
  if (intro) form.append(intro);
  const inputs = {};
  for (const f of fields) {
    if (f.type === "heading") {
      form.append(h("h4", { class: "form-heading", text: f.label }));
      continue;
    }
    if (f.node) {
      form.append(f.node);
      continue;
    }
    const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    if (f.type === "readonly") {
      form.append(h("div", { class: `readonly-field${f.half ? " half" : ""}` }, h("span", { class: "label", text: f.label }), h("div", { class: f.pre ? "pre" : null, text: f.value === null || f.value === undefined || f.value === "" ? "—" : String(f.value) })));
      continue;
    }
    let input;
    if (f.type === "textarea") {
      input = h("textarea", { id, name: f.name, rows: f.rows || 3, placeholder: f.placeholder || "" });
      input.value = f.value ?? "";
    } else if (f.type === "select") {
      input = h("select", { id, name: f.name }, (f.options || []).map((o) => h("option", { value: o.value, text: o.label })));
      input.value = f.value ?? (f.options?.[0]?.value ?? "");
    } else if (f.type === "checkbox") {
      input = h("input", { id, name: f.name, type: "checkbox" });
      input.checked = Boolean(f.value);
    } else {
      input = h("input", { id, name: f.name, type: f.type || "text", placeholder: f.placeholder || "", autocomplete: f.autocomplete || "off" });
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
      input.value = f.value ?? "";
    }
    if (f.required) input.required = true;
    if (f.disabled) input.disabled = true;
    if (f.onChange) input.addEventListener("change", () => f.onChange(input, inputs));
    inputs[f.name] = input;
    const hint = f.hint ? h("span", { class: "hint", text: f.hint }) : null;
    if (f.type === "checkbox") {
      form.append(h("label", { class: "check-row", for: id }, input, h("span", { text: f.label }), hint));
    } else {
      form.append(h("label", { for: id, class: f.half ? "half" : null }, h("span", { text: f.label }), input, hint));
    }
  }
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === "checkbox" ? el.checked : el.value]));
  // Enter in a text field submits, as a form would.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    form.closest("dialog")?.querySelector(".dialog-actions .primary")?.click();
  });
  return openDialog({
    title,
    body: form,
    wide,
    actions: [
      ...extraActions.map((a) => ({ ...a, onClick: a.onClick ? () => a.onClick(values()) : undefined })),
      { label: "Cancel", value: null },
      {
        label: submitLabel,
        kind: "primary",
        onClick: async () => {
          for (const el of Object.values(inputs)) {
            if (!el.checkValidity()) {
              el.reportValidity();
              throw new Error("Fill in the required fields.");
            }
          }
          return onSubmit(values(), inputs);
        }
      }
    ],
    onOpen: (dlg) => {
      const first = fields.find((f) => f.autofocus) || fields.find((f) => f.name && inputs[f.name] && !f.disabled);
      if (first && inputs[first.name] && !matchMedia("(pointer: coarse)").matches) inputs[first.name].focus();
      for (const f of fields) if (f.onChange && inputs[f.name]) f.onChange(inputs[f.name], inputs, dlg);
    }
  });
}

// --- small shared renderers --------------------------------------------------------

function emptyRow(colspan, message) {
  return h("tr", {}, h("td", { colspan, class: "empty", text: message }));
}

/** The site query string for lists, from the header's site picker. */
function siteQuery() {
  return state.site ? { site: state.site } : {};
}
