// 13-app.js: page routing (the part of the address after #), the sections and their pages,
// the site switcher and start-up.
//
//   #home  #companies  #company/3  #people  #person/7  #here  #visitors  #visitor/5  #visits
//   #expected  #badges(/tenants|/visitors)  #badge/4  #clearance  #clearances
//   #settings  #settings/fields  #account

const VIEWS = {
  home: showHome,
  companies: showCompanies,
  people: showPeople,
  here: showHere,
  visitors: showVisitors,
  visits: showVisits,
  expected: showExpected,
  badges: showBadges,
  clearance: showClearance,
  clearances: showClearances,
  settings: showSettings,
  account: showAccount
};

const SITE_KEY = "ivm-site";
const seesSecurity = () => isSecurity() || (isAdmin() && canSeeClearances());

/**
 * The sections in the header and the pages in each (the bar below it). A page is listed
 * only where the account may open it; a section with no pages it may open isn't shown.
 * Badges appear in three sections, each showing its own kind of badge.
 */
const SECTIONS = [
  { id: "home", label: "Home", href: "#home", pages: [] },
  { id: "tenants", label: "Tenants", pages: [
    { view: "companies", href: "#companies", label: "Companies", show: canReadDirectory },
    { view: "people", href: "#people", label: "People", show: canReadDirectory },
    { view: "badges", sub: "tenants", href: "#badges/tenants", label: "Badges", show: canReadBadges }
  ] },
  { id: "visitors", label: "Visitors", pill: "nav-visitors", pages: [
    { view: "here", href: "#here", label: "In the building", pill: "nav-here", show: canReadVisitors },
    { view: "expected", href: "#expected", label: "Expected", pill: "nav-expected", title: "Expected today, not yet arrived", show: canReadVisitors },
    { view: "visitors", href: "#visitors", label: "Visitors", pill: "nav-review", title: "Registered at a kiosk, not yet checked", show: canReadVisitors },
    { view: "visits", href: "#visits", label: "Visit log", show: canReadVisitors },
    { view: "badges", sub: "visitors", href: "#badges/visitors", label: "Badges", pill: "nav-badges", title: "Badges out past their time: visitor badges with visitors who have left, and temporary badges not back by the end of their day", show: canReadBadges }
  ] },
  { id: "security", label: "Security", pill: "nav-security", show: seesSecurity, pages: [
    { view: "clearance", href: "#clearance", label: "Clearance queue", pill: "nav-clearance", title: "Clearances waiting to be validated", show: isSecurity },
    { view: "clearances", href: "#clearances", label: "Re-checks and expiry", show: seesSecurity },
    { view: "badges", sub: "all", href: "#badges", label: "All badges", show: canReadBadges }
  ] },
  { id: "settings", label: "Settings", href: "#settings", show: isAdmin, pages: [] }
];

const pagesOf = (section) => section.pages.filter((p) => p.show());
const sectionShown = (section) => (section.show ? section.show() : true) && (section.href || pagesOf(section).length > 0);

/** Which section a page belongs to (badges: by the part of the address after it). */
function sectionOf(view, sub) {
  if (view === "badges") return sub === "tenants" ? "tenants" : sub === "visitors" ? "visitors" : seesSecurity() ? "security" : "visitors";
  for (const s of SECTIONS) if (s.pages.some((p) => p.view === view) || s.id === view) return s.id;
  return null;
}

function renderNav() {
  $("nav").replaceChildren(...SECTIONS.filter(sectionShown).map((s) => {
    const first = pagesOf(s)[0];
    return h("a", { href: s.href || first.href, dataset: { section: s.id } }, s.label, s.pill ? h("span", { id: s.pill, class: "pill attention", hidden: true }) : null);
  }));
}

function renderSubnav() {
  const section = SECTIONS.find((s) => s.id === state.section);
  const pages = section ? pagesOf(section) : [];
  $("subnav").hidden = pages.length < 2;
  $("subnav").replaceChildren(...pages.map((p) => h("a", {
    href: p.href,
    class: p.view === state.view && (!p.sub || p.sub === (state.badgesScope || "all")) ? "is-active" : null
  }, p.label, p.pill ? h("span", { id: p.pill, class: "pill", hidden: true, title: p.title || null }) : null)));
  for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("is-active", a.dataset.section === state.section);
  showCounts();
}

// --- sites ---------------------------------------------------------------------------------------

const activeSites = () => state.config.sites.filter((s) => s.active);
const siteName = (id) => activeSites().find((s) => String(s.id) === String(id))?.name || null;
const allSitesLabel = () => (state.config.access.sitesLimited ? "All my sites" : "All sites");

function applyConfig() {
  const c = state.config;
  $("version").textContent = `Identity and Visitor Manager ${c.version}`;
  $("current-user").textContent = state.me.displayName || state.me.username;
  for (const el of document.querySelectorAll("[data-admin]")) el.hidden = !isAdmin();
  for (const el of document.querySelectorAll("[data-editor]")) el.hidden = !canEditDirectory();
  for (const el of document.querySelectorAll("[data-visitors]")) el.hidden = !canReadVisitors();
  for (const el of document.querySelectorAll("[data-visitor-editor]")) el.hidden = !canEditVisitors();
  for (const el of document.querySelectorAll("[data-badges]")) el.hidden = !canReadBadges();
  for (const el of document.querySelectorAll("[data-badge-manager]")) el.hidden = !canManageBadges();
  renderNav();

  // The site switcher: only when there is more than one site to choose from.
  const sites = activeSites();
  $("site-picker").hidden = sites.length < 2;
  if (!sites.some((s) => String(s.id) === String(state.site))) state.site = "";
  $("site-current").textContent = siteName(state.site) || allSitesLabel();
  $("brand-sub").textContent = siteName(state.site) || (sites.length === 1 ? sites[0].name : "Tenant directory");
  renderSubnav();
}

/** Switches site everywhere: the pages, the counts, the banner, and their saved choice. */
function setSite(id) {
  state.site = id ? String(id) : "";
  try { localStorage.setItem(SITE_KEY, state.site); } catch { /* storage blocked */ }
  api("/api/me/prefs", { method: "PUT", body: { site: state.site ? Number(state.site) : null } }).catch(() => {});
  applyConfig();
  refreshCurrentView();
  refreshCounts();
  toast(state.site ? `Now at ${siteName(state.site)}.` : `Showing ${allSitesLabel().toLowerCase()}.`);
}

function closeSiteMenu() {
  $("site-menu").hidden = true;
  $("site-button").setAttribute("aria-expanded", "false");
}

$("site-button").addEventListener("click", () => {
  const menu = $("site-menu");
  if (!menu.hidden) return closeSiteMenu();
  const choice = (id, label) => h("button", { type: "button", class: `site-option${String(id) === String(state.site) ? " is-current" : ""}`, onclick: () => { closeSiteMenu(); setSite(id); } }, label);
  menu.replaceChildren(choice("", allSitesLabel()), ...activeSites().map((s) => choice(s.id, s.name)));
  menu.hidden = false;
  $("site-button").setAttribute("aria-expanded", "true");
  menu.querySelector(".is-current")?.focus();
  return null;
});
document.addEventListener("click", (e) => { if (!e.target.closest("#site-picker")) closeSiteMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("site-menu").hidden) { closeSiteMenu(); $("site-button").focus(); } });

// --- light or dark -------------------------------------------------------------------------------

/** The header button shows what a click switches to. */
function showThemeButton() {
  const dark = currentTheme() === "dark";
  const label = dark ? "Switch to light" : "Switch to dark";
  $("theme-button").title = label;
  $("theme-button").setAttribute("aria-label", label);
  $("theme-button").classList.toggle("is-dark", dark);
}

/** "light", "dark" or "auto": shown at once, kept in this browser and with the account. */
function setTheme(theme) {
  applyTheme(theme);
  showThemeButton();
  if (state.me) api("/api/me/prefs", { method: "PUT", body: { theme } }).catch(() => {});
}

$("theme-button").addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", showThemeButton);
showThemeButton();

// --- routing ---------------------------------------------------------------------------------------

function showView(name, sub = null) {
  state.view = name;
  state.section = sectionOf(name, sub) || state.section;
  for (const section of document.querySelectorAll("main > .view")) section.hidden = section.id !== `view-${name}`;
  renderSubnav();
}

/** Reads the address and shows what it names. Detail pages open over their list. */
function route() {
  if (!state.me) return;
  refreshCounts();
  const [name, sub] = location.hash.replace(/^#/, "").split("/");
  if (name === "visitor" && sub && canReadVisitors()) {
    if (!state.view || !["visitors", "here", "visits", "home"].includes(state.view)) { showView("visitors"); showVisitors(); }
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
  if (name === "badge" && sub && canReadBadges()) {
    if (state.view !== "badges" && state.view !== "home") { showView("badges"); showBadges(); }
    openBadge(Number(sub), refreshCurrentView);
    return;
  }
  let view = VIEWS[name] ? name : "home";
  if (view === "settings" && !isAdmin()) view = "home";
  if ((view === "companies" || view === "people") && !canReadDirectory()) view = "home";
  if (["here", "visitors", "visits", "expected"].includes(view) && !canReadVisitors()) view = "home";
  if (view === "badges" && !canReadBadges()) view = "home";
  if (view === "clearance" && !isSecurity()) view = "home";
  if (view === "clearances" && !seesSecurity()) view = "home";
  showView(view, sub);
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
  else if (state.view === "home") loadDashboard();
  else if (VIEWS[state.view]) VIEWS[state.view]();
}

window.addEventListener("hashchange", route);

// --- counts in the navigation ----------------------------------------------------------------

function setPill(id, n) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(n);
  el.hidden = !n;
}

/** The counts beside the sections and pages: who is in the building (at the chosen site), and what needs attention. */
function showCounts() {
  const v = state.config?.visits;
  const here = v ? Object.entries(v.here).filter(([site]) => !state.site || site === String(state.site)).reduce((n, [, c]) => n + c, 0) : 0;
  const late = (v?.badgesLeft || 0) + (v?.tempOverdue || 0);
  const queue = state.config?.clearance?.queue || 0;
  setPill("nav-here", here);
  setPill("nav-review", v?.review || 0);
  setPill("nav-expected", v?.expected || 0);
  setPill("nav-badges", late);
  setPill("nav-clearance", queue);
  // On the sections, only what needs someone to act.
  setPill("nav-visitors", (v?.review || 0) + late);
  setPill("nav-security", queue);
}

async function refreshCounts() {
  if (!state.me) return;
  try {
    if (canReadVisitors()) state.config.visits = await api("/api/visits/summary");
    if (isSecurity()) state.config.clearance.queue = (await api("/api/clearance/queue-count")).count;
    showCounts();
    loadBadgeAlerts();
  } catch {
    // The counts are a convenience; the pages show the real lists.
  }
}

setInterval(() => { if (!document.hidden) refreshCounts(); }, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCounts(); });

async function startApp() {
  try {
    state.config = await api("/api/config");
    state.prefs = await api("/api/me/prefs");
    await loadSchema();
  } catch (error) {
    showAuth(error.message);
    return;
  }
  // The site they chose last, wherever they chose it; this browser's choice if they never have.
  let saved = "";
  try { saved = localStorage.getItem(SITE_KEY) || ""; } catch { /* storage blocked */ }
  state.site = state.prefs.site ? String(state.prefs.site) : saved;
  // Light or dark as chosen on their account, wherever they chose it.
  applyTheme(state.prefs.theme);
  showThemeButton();
  applyConfig();
  $("main").hidden = false;
  $("nav").hidden = false;
  $("header-actions").hidden = false;
  $("footer").hidden = false;
  state.view = null;
  route();
}

checkSession();
