// 00-theme.js: how the page looks, decided before it draws (this loads in <head>), so it
// never shows the wrong look first. There are two choices, each kept in this browser and,
// once signed in, with the account (/api/me/prefs), so they follow the person to another
// device:
//
//   appearance   "light", "dark" or "auto" (as the device is set). What is showing is always
//                on <html> as data-appearance="light" or "dark"; styles.css keys its dark
//                palette on it.
//   theme        a named look from /themes.css (themes.js on the server), on <html> as
//                data-theme="<id>". The standard look is "standard": no attribute at all.
//
// Whenever what is showing changes, window gets a "lookchange" event (the header's button
// and the logo listen).

const APPEARANCE_KEY = "ivm-appearance";
const THEME_KEY = "ivm-theme";
const STANDARD_THEME = "standard";
let appearanceChoice = "auto";

function deviceAppearance() {
  return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Keeps a choice in this browser (nothing kept for the default). */
function rememberLook(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: it still applies to this page.
  }
}

/** Puts what was chosen on the page, and tells the browser's own bar and whoever listens. */
function showLook() {
  const root = document.documentElement;
  root.dataset.appearance = appearanceChoice === "auto" ? deviceAppearance() : appearanceChoice;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // The theme's own colors, once the stylesheets are in; until then, the standard look's.
    const dark = root.dataset.appearance === "dark";
    const color = getComputedStyle(root).getPropertyValue(dark ? "--surface" : "--primary").trim();
    meta.setAttribute("content", color || (dark ? "#1c1b19" : "#2563eb"));
  }
  window.dispatchEvent(new Event("lookchange"));
}

/** "light", "dark", or "auto" (or anything else) to follow the device. */
function applyAppearance(choice) {
  appearanceChoice = choice === "light" || choice === "dark" ? choice : "auto";
  rememberLook(APPEARANCE_KEY, appearanceChoice === "auto" ? null : appearanceChoice);
  showLook();
}

/** What is showing now: "light" or "dark". */
function currentAppearance() {
  return document.documentElement.dataset.appearance || deviceAppearance();
}

/** What was chosen: "light", "dark" or "auto". */
function chosenAppearance() {
  return appearanceChoice;
}

/** A theme's id; "standard" (or anything that isn't an id) for the standard look. */
function applyTheme(id) {
  const named = typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && id !== STANDARD_THEME;
  if (named) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
  rememberLook(THEME_KEY, named ? id : null);
  showLook();
}

/** The theme chosen: its id, or "standard". */
function chosenTheme() {
  return document.documentElement.dataset.theme || STANDARD_THEME;
}

// Following the device: the page turns when the device does.
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (appearanceChoice === "auto") showLook(); });
// Once the stylesheets are in, the browser's bar can take the theme's colors.
document.addEventListener("DOMContentLoaded", showLook);

{
  let appearance = null;
  let theme = null;
  try {
    appearance = localStorage.getItem(APPEARANCE_KEY);
    theme = localStorage.getItem(THEME_KEY);
    // Before there were themes, this key held light or dark.
    if (theme === "light" || theme === "dark") {
      appearance = appearance || theme;
      theme = null;
    }
  } catch {
    // Storage blocked: follow the device, with the standard look.
  }
  applyAppearance(appearance);
  applyTheme(theme);
}
