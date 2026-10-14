// The visitor kiosk. One screen at a time; every path ends back at the welcome screen,
// on its own after a short idle time. It talks only to /kiosk/api, as a paired device.

const $ = (id) => document.getElementById(id);
const DONE_SECONDS = 8;

const k = {
  config: null,
  configAt: 0,
  companies: null,     // this site's tenants, fetched when needed
  companiesAt: 0,
  match: null,         // the visitor found by name: { ref, firstName, companies }
  flow: null,          // "new" or "change" on the details screen
  company: null,       // { id, name } chosen on the details screen
  hostId: null,        // chosen host, or null for "not sure"
  outMatch: null,      // the visit found for check-out
  idleTimer: null,
  doneTimer: null
};

// --- plumbing -------------------------------------------------------------------------

class KioskError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/kiosk/api${path}`, body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-kiosk-request": "1" }, body: JSON.stringify(body) });
  } catch {
    $("offline").hidden = false;
    throw new KioskError("We couldn't reach the server. Please try again in a moment.", 0);
  }
  $("offline").hidden = true;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.paired === false) {
    showPair();
    throw new KioskError("", 401);
  }
  if (!res.ok) throw new KioskError(data.error || "Something went wrong. Please try again.", res.status);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  clearTimeout(k.doneTimer);
  armIdle();
  const first = document.querySelector(`#${id} input:not([hidden])`);
  // Focus the first box so the iPad's keyboard is ready, except on the done screens.
  if (first && !["done", "reception"].includes(id)) setTimeout(() => first.focus(), 60);
}

function setError(id, message) {
  $(id).textContent = message || "";
}

/** Busy state for a button while a request runs; returns a function to restore it. */
function busy(button) {
  button.disabled = true;
  return () => { button.disabled = false; };
}

// --- idle reset ----------------------------------------------------------------------------

function armIdle() {
  clearTimeout(k.idleTimer);
  const seconds = k.config?.idleSeconds || 45;
  k.idleTimer = setTimeout(() => {
    const onWelcome = !$("welcome").hidden;
    if (!$("pair").hidden) return;
    if (onWelcome && !$("name-input").value) return armIdle();
    home();
  }, seconds * 1000);
}

for (const evt of ["pointerdown", "keydown", "input"]) document.addEventListener(evt, armIdle, { passive: true });

// --- pairing ---------------------------------------------------------------------------------

function showPair() {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== "pair";
  setTimeout(() => $("pair-code").focus(), 60);
}

$("pair-code").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});

$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("pair-error", "");
  const done = busy(e.submitter || $("pair-form").querySelector("button"));
  try {
    await api("/pair", { code: $("pair-code").value });
    $("pair-code").value = "";
    await loadConfig(true);
    home();
  } catch (error) {
    setError("pair-error", error.message);
  } finally {
    done();
  }
});

// --- welcome ---------------------------------------------------------------------------------

async function loadConfig(force = false) {
  if (!force && k.config && Date.now() - k.configAt < 60 * 1000) return;
  k.config = await api("/config");
  k.configAt = Date.now();
  const site = k.config.site;
  $("site-name").textContent = site.name;
  $("site-welcome").textContent = site.welcome || "Welcome. Please check in.";
  const logo = $("logo");
  if (site.hasLogo) {
    const src = `/kiosk/api/logo?v=${site.logoVersion || 0}`;
    if (logo.getAttribute("src") !== src) logo.src = src;
    logo.alt = site.name;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }
  document.title = `${site.name}: visitor check-in`;
}

/** Back to the start, with everything typed forgotten. */
function home() {
  k.match = null;
  k.flow = null;
  k.company = null;
  k.hostId = null;
  k.outMatch = null;
  for (const input of document.querySelectorAll("input")) if (input.id !== "pair-code") input.value = "";
  for (const id of ["name-error", "details-error"]) setError(id, "");
  show("welcome");
  loadConfig().catch(() => {});
}

for (const b of document.querySelectorAll("[data-action=home]")) b.addEventListener("click", home);

function typedName() {
  return $("name-input").value.trim().replace(/\s+/g, " ");
}

function needsFullName() {
  const words = typedName().split(" ").filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "").length >= 2);
  if (words.length < 2) {
    setError("name-error", "Please enter your first and last name.");
    $("name-input").focus();
    return true;
  }
  return false;
}

$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("name-error", "");
  if (needsFullName()) return;
  const done = busy($("checkin-btn"));
  try {
    const { matches } = await api("/lookup", { name: typedName() });
    if (!matches.length) return openDetails("new");
    if (matches.length === 1) return chooseVisitor(matches[0]);
    showWhich(matches);
  } catch (error) {
    if (error.status !== 401) setError("name-error", error.message);
  } finally {
    done();
  }
});

$("checkout-btn").addEventListener("click", async () => {
  setError("name-error", "");
  if (needsFullName()) return;
  const done = busy($("checkout-btn"));
  try {
    const { matches } = await api("/checkout/lookup", { name: typedName() });
    if (!matches.length) {
      showReception("We couldn't find a visit under that name", "Please see reception and they'll check you out.");
      return;
    }
    if (matches.length === 1) return confirmCheckout(matches[0]);
    const list = $("out-list");
    list.replaceChildren(...matches.map((m) => el("button", { type: "button", class: "choice", onclick: () => confirmCheckout(m) },
      el("strong", { text: m.firstName }), el("span", { text: `Visiting ${m.companyName}` }))));
    show("out-which");
  } catch (error) {
    if (error.status !== 401) setError("name-error", error.message);
  } finally {
    done();
  }
});

// --- returning visitors ---------------------------------------------------------------------

function showWhich(matches) {
  const list = $("which-list");
  list.replaceChildren(...matches.map((m) => el("button", { type: "button", class: "choice", onclick: () => chooseVisitor(m) },
    el("strong", { text: m.firstName }),
    el("span", { text: m.companies.length ? `Visits ${m.companies.map((c) => c.companyName).join(", ")}` : "Hasn't visited this building before" }))));
  show("which");
}

$("which").querySelector("[data-action=new]").addEventListener("click", () => openDetails("new"));

function chooseVisitor(match) {
  k.match = match;
  // Expected today: their event's company and host, to confirm.
  if (match.companies.length === 1 || match.companies[0]?.expected) return showConfirm(match.companies[0]);
  if (!match.companies.length) return openDetails("change");
  $("pick-company-title").textContent = `Welcome back, ${match.firstName}`;
  const list = $("pick-company-list");
  list.replaceChildren(
    ...match.companies.map((c) => el("button", { type: "button", class: "choice", onclick: () => checkIn({ ref: match.ref, companyId: c.companyId, hostId: c.hostId }, c) },
      el("strong", { text: c.companyName }), c.hostName ? el("span", { text: `Host: ${c.hostName}` }) : null)),
    el("button", { type: "button", class: "choice", onclick: () => openDetails("change") }, el("strong", { text: "Someone else" }), el("span", { text: "A different company or host" })));
  show("pick-company");
}

function showConfirm(link) {
  $("confirm-title").textContent = `Welcome back, ${k.match.firstName}`;
  $("confirm-company").textContent = link.companyName;
  $("confirm-host").textContent = link.hostName || "Not given";
  $("confirm-yes").onclick = () => checkIn({ ref: k.match.ref, companyId: link.companyId, hostId: link.hostId }, link);
  show("confirm");
}

$("confirm-change").addEventListener("click", () => openDetails("change"));

// --- the details screen: new visitors, and returning ones going somewhere else ----------------

async function loadCompanies() {
  if (k.companies && Date.now() - k.companiesAt < 5 * 60 * 1000) return k.companies;
  k.companies = (await api("/companies")).companies;
  k.companiesAt = Date.now();
  return k.companies;
}

const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function renderCompanies() {
  const q = fold($("company-search").value.trim());
  const all = k.companies || [];
  let shown = q ? all.filter((c) => fold(c.name).split(/\s+/).some((w) => w.startsWith(q)) || fold(c.name).includes(q)) : all;
  const list = $("company-list");
  if (!q && all.length > 12) {
    list.replaceChildren(el("p", { class: "empty", text: "Type a few letters of the company's name." }));
    return;
  }
  shown = shown.slice(0, 24);
  list.replaceChildren(...(shown.length
    ? shown.map((c) => el("button", { type: "button", class: "choice", onclick: () => chooseCompany(c) }, el("strong", { text: c.name })))
    : [el("p", { class: "empty", text: "No company here by that name. Please check the spelling, or see reception." })]));
}

$("company-search").addEventListener("input", renderCompanies);

async function chooseCompany(company) {
  k.company = company;
  k.hostId = null;
  $("company-chosen-name").textContent = company.name;
  $("company-chosen").hidden = false;
  $("company-search").hidden = true;
  $("company-list").hidden = true;
  setError("details-error", "");
  const list = $("host-list");
  list.replaceChildren();
  $("host-picker").hidden = false;
  try {
    const { hosts } = await api(`/companies/${company.id}/hosts`);
    const buttons = [];
    const pick = (id, button) => {
      k.hostId = id;
      for (const b of buttons) b.classList.toggle("selected", b === button);
    };
    for (const h of hosts) {
      const b = el("button", { type: "button", class: "choice" }, el("strong", { text: h.name }));
      b.addEventListener("click", () => pick(h.id, b));
      buttons.push(b);
    }
    const unsure = el("button", { type: "button", class: "choice selected" }, el("strong", { text: "I'm not sure" }));
    unsure.addEventListener("click", () => pick(null, unsure));
    buttons.push(unsure);
    list.replaceChildren(...buttons);
  } catch (error) {
    if (error.status !== 401) setError("details-error", error.message);
  }
}

$("company-clear").addEventListener("click", () => {
  k.company = null;
  k.hostId = null;
  $("company-chosen").hidden = true;
  $("company-search").hidden = false;
  $("company-list").hidden = false;
  $("host-picker").hidden = true;
  $("company-search").value = "";
  renderCompanies();
  $("company-search").focus();
});

async function openDetails(flow) {
  k.flow = flow;
  k.company = null;
  k.hostId = null;
  const isNew = flow === "new";
  $("about-you").hidden = !isNew;
  $("details-title").textContent = isNew ? "Nice to meet you" : `Where are you headed, ${k.match.firstName}?`;
  if (isNew) {
    const words = typedName().split(" ");
    $("first-name").value = words[0] || "";
    $("last-name").value = words.slice(1).join(" ");
    $("organisation").value = "";
    $("contact").value = "";
  }
  $("company-chosen").hidden = true;
  $("company-search").hidden = false;
  $("company-list").hidden = false;
  $("company-search").value = "";
  $("host-picker").hidden = true;
  setError("details-error", "");
  show("details");
  if (!isNew) setTimeout(() => $("company-search").focus(), 60);
  try {
    await loadCompanies();
    renderCompanies();
  } catch (error) {
    if (error.status !== 401) setError("details-error", error.message);
  }
}

$("details-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("details-error", "");
  if (k.flow === "new" && (!$("first-name").value.trim() || !$("last-name").value.trim())) {
    setError("details-error", "Please enter your first and last name.");
    return;
  }
  if (!k.company) {
    setError("details-error", "Please choose the company you're visiting.");
    $("company-search").focus();
    return;
  }
  const body = { companyId: k.company.id, hostId: k.hostId };
  if (k.flow === "new") {
    body.visitor = { firstName: $("first-name").value.trim(), lastName: $("last-name").value.trim(), organisation: $("organisation").value.trim(), contact: $("contact").value.trim() };
  } else {
    body.ref = k.match.ref;
  }
  await checkIn(body, null, $("details-submit"));
});

// --- checking in and out ---------------------------------------------------------------------

async function checkIn(body, link, button = null) {
  const done = button ? busy(button) : () => {};
  try {
    const result = await api("/checkin", body);
    if (!result.ok && result.seeReception) {
      showReception("Please see reception", "They'll finish checking you in.");
      return;
    }
    const host = result.hostName;
    showDone(
      result.already ? `You're already checked in, ${result.firstName}` : `You're checked in, ${result.firstName}`,
      host ? `Take a seat and the front desk will let ${host} know you're here.` : "Take a seat; the front desk will be with you shortly."
    );
  } catch (error) {
    if (error.status === 401) return;
    if (error.status === 409) {
      showReception("Let's try that again", error.message);
      return;
    }
    if (!$("details").hidden) setError("details-error", error.message);
    else showReception("Something went wrong", error.message);
  } finally {
    done();
  }
}

function confirmCheckout(match) {
  k.outMatch = match;
  $("out-title").textContent = `Checking out, ${match.firstName}?`;
  $("out-text").textContent = `Visiting ${match.companyName}`;
  show("out-confirm");
}

$("out-yes").addEventListener("click", async () => {
  const done = busy($("out-yes"));
  try {
    const result = await api("/checkout", { ref: k.outMatch.ref });
    showDone(`Goodbye, ${result.firstName}`, "You're checked out. Thanks for visiting.");
  } catch (error) {
    if (error.status !== 401) showReception("Something went wrong", error.message);
  } finally {
    done();
  }
});

function showDone(title, text) {
  $("done-title").textContent = title;
  $("done-text").textContent = text;
  show("done");
  let left = DONE_SECONDS;
  const tickDown = () => {
    $("done-countdown").textContent = `Back to the start in ${left} second${left === 1 ? "" : "s"}`;
    if (left <= 0) return home();
    left -= 1;
    k.doneTimer = setTimeout(tickDown, 1000);
  };
  tickDown();
}

function showReception(title, text) {
  $("reception-title").textContent = title;
  $("reception-text").textContent = text;
  show("reception");
  k.doneTimer = setTimeout(home, DONE_SECONDS * 2 * 1000);
}

// --- start ---------------------------------------------------------------------------------------

(async () => {
  try {
    await loadConfig(true);
    home();
  } catch (error) {
    if (error.status === 401) return;
    showReception("This kiosk is resting", error.message || "Please see reception.");
    setTimeout(() => location.reload(), 30 * 1000);
  }
})();
