// 09-app.js: page routing (the part of the address after #), the site picker and
// start-up.
//
//   #companies  #company/3  #people  #person/7  #here  #visitors  #visitor/5  #visits
//   #settings  #settings/fields  #account

const VIEWS = {
  companies: showCompanies,
  people: showPeople,
  here: showHere,
  visitors: showVisitors,
  visits: showVisits,
  expected: showExpected,
  badges: showBadges,
  clearance: showClearance,
  settings: showSettings,
  account: showAccount
};

const SITE_KEY = "ivm-site";

function applyConfig() {
  const c = state.config;
  $("version").textContent = `Identity and Visitor Manager ${c.version}`;
  $("current-user").textContent = state.me.displayName || state.me.username;
  for (const el of document.querySelectorAll("[data-admin]")) el.hidden = !isAdmin();
  for (const el of document.querySelectorAll("[data-editor]")) el.hidden = !canEditDirectory();
  for (const a of $("nav").querySelectorAll("[data-view=companies],[data-view=people]")) a.hidden = !canReadDirectory();
  for (const el of document.querySelectorAll("[data-visitors]")) el.hidden = !canReadVisitors();
  for (const el of document.querySelectorAll("[data-visitor-editor]")) el.hidden = !canEditVisitors();
  for (const el of document.querySelectorAll("[data-badges]")) el.hidden = !canReadBadges();
  for (const el of document.querySelectorAll("[data-badge-editor]")) el.hidden = !canEditBadges();
  for (const el of document.querySelectorAll("[data-security]")) el.hidden = !isSecurity();
  showCounts();

  // The site picker: only when there is more than one site to choose from.
  const picker = $("site-select");
  const sites = c.sites.filter((s) => s.active);
  $("site-picker").hidden = sites.length < 2;
  clear(picker).append(h("option", { value: "", text: c.access.sitesLimited ? "All my sites" : "All sites" }), ...sites.map((s) => h("option", { value: String(s.id), text: s.name })));
  let saved = "";
  try { saved = localStorage.getItem(SITE_KEY) || ""; } catch { /* storage blocked */ }
  state.site = sites.some((s) => String(s.id) === saved) ? saved : "";
  picker.value = state.site;
  const current = sites.find((s) => String(s.id) === state.site);
  $("brand-sub").textContent = current ? current.name : sites.length === 1 ? sites[0].name : "Tenant directory";
}

$("site-select").addEventListener("change", () => {
  state.site = $("site-select").value;
  try { localStorage.setItem(SITE_KEY, state.site); } catch { /* storage blocked */ }
  applyConfig();
  refreshCurrentView();
});

function showView(name) {
  state.view = name;
  for (const section of document.querySelectorAll("main > .view")) section.hidden = section.id !== `view-${name}`;
  for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("is-active", a.dataset.view === name);
}

/** Reads the address and shows what it names. Detail pages open over their list. */
function route() {
  if (!state.me) return;
  refreshCounts();
  const [name, sub] = location.hash.replace(/^#/, "").split("/");
  const start = canReadVisitors() ? "here" : canReadDirectory() ? "companies" : "account";
  if (name === "visitor" && sub && canReadVisitors()) {
    if (!state.view || !["visitors", "here", "visits"].includes(state.view)) { showView("visitors"); showVisitors(); }
    openVisitor(Number(sub), refreshCurrentView);
    return;
  }
  if (name === "company" && sub && canReadDirectory()) {
    showView("companies");
    showCompanies(Number(sub));
    return;
  }
  if (name === "person" && sub && canReadDirectory()) {
    if (!state.view || state.view === "account" || state.view === "settings") { showView("people"); showPeople(); }
    openPerson(Number(sub), refreshCurrentView);
    return;
  }
  let view = VIEWS[name] ? name : start;
  if (view === "settings" && !isAdmin()) view = start;
  if ((view === "companies" || view === "people") && !canReadDirectory()) view = start;
  if (["here", "visitors", "visits", "expected"].includes(view) && !canReadVisitors()) view = start;
  if (view === "badges" && !canReadBadges()) view = start;
  if (view === "clearance" && !isSecurity()) view = start;
  if (name === "badge" && sub && canReadBadges()) {
    if (state.view !== "badges") { showView("badges"); showBadges(); }
    openBadge(Number(sub), refreshCurrentView);
    return;
  }
  showView(view);
  VIEWS[view](sub);
}

/** Re-renders whatever is on screen after a change made in a dialog. */
function refreshCurrentView() {
  if (state.view === "companies") showCompanies();
  else if (state.view === "people") loadPeople();
  else if (state.view === "visitors") loadVisitors();
  else if (state.view === "here") loadHere();
  else if (state.view === "visits") loadVisits();
  else if (state.view === "expected") loadExpected();
  else if (state.view === "badges") loadBadges();
  else if (state.view === "clearance") showClearance();
  else if (VIEWS[state.view]) VIEWS[state.view]();
}

window.addEventListener("hashchange", route);

/** The counts in the navigation: who is in the building (at the chosen site) and visitors to check. */
function showCounts() {
  const v = state.config?.visits;
  const here = v ? Object.entries(v.here).filter(([site]) => !state.site || site === String(state.site)).reduce((n, [, c]) => n + c, 0) : 0;
  $("nav-here").textContent = String(here);
  $("nav-here").hidden = !here;
  $("nav-review").textContent = String(v?.review || 0);
  $("nav-review").hidden = !v?.review;
  $("nav-expected").textContent = String(v?.expected || 0);
  $("nav-expected").hidden = !v?.expected;
  const late = (v?.badgesLeft || 0) + (v?.tempOverdue || 0);
  $("nav-badges").textContent = String(late);
  $("nav-badges").hidden = !late;
  const queue = state.config?.clearance?.queue || 0;
  $("nav-clearance").textContent = String(queue);
  $("nav-clearance").hidden = !queue;
}

async function refreshCounts() {
  if (!state.me) return;
  try {
    if (canReadVisitors()) state.config.visits = await api("/api/visits/summary");
    if (isSecurity()) state.config.clearance.queue = (await api("/api/clearance/queue-count")).count;
    showCounts();
  } catch {
    // The counts are a convenience; the pages show the real lists.
  }
}

setInterval(() => { if (!document.hidden) refreshCounts(); }, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCounts(); });

async function startApp() {
  try {
    state.config = await api("/api/config");
    await loadSchema();
  } catch (error) {
    showAuth(error.message);
    return;
  }
  applyConfig();
  $("main").hidden = false;
  $("nav").hidden = false;
  $("header-actions").hidden = false;
  $("footer").hidden = false;
  state.view = null;
  route();
}

checkSession();
