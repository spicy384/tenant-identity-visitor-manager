// 00-theme.js: light or dark. Loaded in <head>, before the page draws, so it never shows the
// wrong one first. "light" or "dark" sets data-theme on <html>; nothing set follows the
// device. The choice is kept in this browser and, once signed in, with the account
// (/api/me/prefs), so it follows the person to another device.

const THEME_KEY = "ivm-theme";

/** "light", "dark", or "auto" (or anything else) to follow the device. */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme === "light" || theme === "dark") localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Storage blocked: it still applies to this page.
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", currentTheme() === "dark" ? "#1c1b19" : "#2563eb");
}

/** What is showing now: "light" or "dark". */
function currentTheme() {
  return document.documentElement.dataset.theme || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

/** What was chosen: "light", "dark" or "auto". */
function chosenTheme() {
  return document.documentElement.dataset.theme || "auto";
}

try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  // Storage blocked: follow the device.
}
