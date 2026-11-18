/**
 * Themes: a theme file is made to apply only to those who chose it (every :root becomes the
 * theme's own), one that styles anything else is left out, an installation's own folder
 * replaces a shipped theme of the same name, the template is a theme that works, and each
 * person's choice is kept beside light or dark (which, before themes, was kept as "theme").
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { loadThemes, parseTheme, scopeCss } = require("../themes");
const { openDatabase } = require("../db");
const { generateKey } = require("../db-key");
const { createFields } = require("../fields");
const { createAccess } = require("../access");
const { createPrefs } = require("../prefs");

const { check, report } = createChecker("Themes");
const throws = (fn) => {
  try {
    fn();
    return "";
  } catch (error) {
    return error.message;
  }
};

// --- a theme's CSS, made its own -----------------------------------------------------------------
const scoped = scopeCss(`
:root { --primary: red; }
:root[data-appearance="dark"] { --primary: blue; }
:root .app-header, :root :is(a, b) { color: red; }
:root .tick::after { content: "}"; }
@media (max-width: 600px) { :root .nav { gap: 0; } }`, "harbor");
check("scope: :root becomes the theme's own", scoped.includes(':root[data-theme="harbor"] { --primary: red;'), scoped);
check("scope: in light or dark too", scoped.includes(':root[data-theme="harbor"][data-appearance="dark"] { --primary: blue;'));
check("scope: each selector of a list, commas in brackets left alone", scoped.includes(':root[data-theme="harbor"] .app-header, :root[data-theme="harbor"] :is(a, b) {'));
check("scope: a brace in a string is text", scoped.includes('content: "}";'));
check("scope: inside @media as well", /@media \(max-width: 600px\) \{\s*:root\[data-theme="harbor"\] \.nav \{/.test(scoped));
check("scope: nothing is left unscoped", !/(^|[\s,}])(:root)(?!\[data-theme="harbor"\])/.test(scoped));
check("refused: a rule outside :root", /doesn't start with :root/.test(throws(() => scopeCss("body { color: red; }", "x"))));
check("refused: one hidden in a list", /doesn't start with :root/.test(throws(() => scopeCss(":root, .panel { color: red; }", "x"))));
check("refused: a name that only starts like it", /doesn't start with :root/.test(throws(() => scopeCss(":rooty { color: red; }", "x"))) && /doesn't start with :root/.test(throws(() => scopeCss(":root-x { color: red; }", "x"))));
check("refused: one inside @media", /doesn't start with :root/.test(throws(() => scopeCss("@media print { .panel { color: red; } }", "x"))));
check("refused: @import", /outside any block/.test(throws(() => scopeCss('@import url("x.css"); :root { --a: 1; }', "x"))));
check("refused: @font-face", /@font-face isn't something a theme may use/.test(throws(() => scopeCss('@font-face { font-family: x; }', "x"))));
check("refused: braces that don't pair", /never closed/.test(throws(() => scopeCss(":root { --a: 1;", "x"))) && /no \{ before/.test(throws(() => scopeCss(":root { --a: 1; } }", "x"))));
check("refused: something after the last block", /outside any block/.test(throws(() => scopeCss(":root { --a: 1; } color: red;", "x"))));

// --- a theme file --------------------------------------------------------------------------------
const harbor = parseTheme("harbor", "/*\n * Theme: Harbor   Blue\n * About: Sea colors.\n */\n:root { --primary: navy; }\n/* a note */\n:root[data-appearance=\"dark\"] { --primary: skyblue; }\n");
check("file: named by its first comment", harbor.id === "harbor" && harbor.name === "Harbor Blue" && harbor.about === "Sea colors.");
check("file: its comments don't go out", !harbor.css.includes("a note") && !harbor.css.includes("Sea colors"));
check("file: named after itself when it doesn't say", parseTheme("night-sky", ":root { --a: 1; }").name === "Night sky" && parseTheme("night-sky", ":root { --a: 1; }").about === "");
check("file: not a name the app uses", ["standard", "auto", "light", "dark"].every((id) => /a name the app uses itself/.test(throws(() => parseTheme(id, ":root { --a: 1; }")))));
check("file: nor one that isn't an id", /lower-case letters/.test(throws(() => parseTheme("My Theme", ":root { --a: 1; }"))) && /lower-case letters/.test(throws(() => parseTheme('x"]', ":root { --a: 1; }"))));
check("file: nor one that styles nothing", /styles nothing/.test(throws(() => parseTheme("empty", "/* Theme: Empty */\n"))));

// --- the folders ---------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-themes-"));
const shipped = path.join(tmp, "shipped");
const own = path.join(tmp, "own");
fs.mkdirSync(shipped);
fs.mkdirSync(own);
fs.writeFileSync(path.join(shipped, "harbor.css"), "/* Theme: Harbor */\n:root { --primary: navy; }\n");
fs.writeFileSync(path.join(shipped, "amber.css"), "/* Theme: Amber\n   About: Warm. */\n:root { --primary: orange; }\n");
fs.writeFileSync(path.join(shipped, "_draft.css"), ":root { --primary: pink; }\n");
fs.writeFileSync(path.join(shipped, "leaky.css"), ":root { --primary: red; }\n.panel { display: none; }\n");
fs.writeFileSync(path.join(shipped, "dark.css"), ":root { --primary: black; }\n");
fs.writeFileSync(path.join(shipped, "notes.txt"), "not a theme");
fs.writeFileSync(path.join(own, "harbor.css"), "/* Theme: Our Harbor */\n:root { --primary: teal; }\n");
const themes = loadThemes([shipped, own, path.join(tmp, "no-such-folder")]);
check("folders: the standard look first, then the rest by name", themes.list().map((t) => t.id).join() === "standard,amber,harbor" && themes.list()[1].about === "Warm.", JSON.stringify(themes.list()));
check("folders: an installation's own replaces a shipped one of the same name", themes.list()[2].name === "Our Harbor" && themes.css.includes("teal") && !themes.css.includes("navy"));
check("folders: a template (underscore) and other files are passed over", !themes.css.includes("pink") && !themes.has("_draft") && !themes.has("notes"));
check("folders: a file that can't be used is left out, with why", !themes.has("leaky") && !themes.css.includes("red") && !themes.has("dark")
  && themes.problems.length === 2 && themes.problems.some((p) => p.file.endsWith("leaky.css") && /doesn't start with :root/.test(p.reason)) && themes.problems.some((p) => p.file.endsWith("dark.css")), JSON.stringify(themes.problems));
check("folders: what there is, and what there isn't", themes.has("standard") && themes.has("harbor") && themes.has("amber") && !themes.has("purple") && !themes.has(undefined));
check("folders: one stylesheet, each theme its own", themes.css.includes(':root[data-theme="amber"] {') && themes.css.includes(':root[data-theme="harbor"] {'));
check("folders: none at all is only the standard look", loadThemes([]).list().length === 1 && loadThemes([]).css === "" && loadThemes([path.join(tmp, "no-such-folder")]).problems.length === 0);

// --- what ships ----------------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, "..", "public");
const real = loadThemes([path.join(PUBLIC, "themes")]);
check("shipped: every theme can be used", real.problems.length === 0, JSON.stringify(real.problems));
check("shipped: Evergreen beside the standard look, in light and in dark", real.list().map((t) => t.id).join() === "standard,evergreen" && real.list()[1].name === "Evergreen" && real.list()[1].about === "Green accents on warm paper."
  && real.css.includes(':root[data-theme="evergreen"][data-appearance="light"]') && real.css.includes(':root[data-theme="evergreen"][data-appearance="dark"]'), JSON.stringify(real.list()));
const templateText = fs.readFileSync(path.join(PUBLIC, "themes", "_template.css"), "utf8");
const template = parseTheme("template", templateText);
check("template: a theme that works, once given a name", template.name === "Your theme's name" && template.css.includes(':root[data-theme="template"][data-appearance="light"]') && template.css.includes(':root[data-theme="template"][data-appearance="dark"]'));
const tokensIn = (css) => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const known = tokensIn(fs.readFileSync(path.join(PUBLIC, "styles.css"), "utf8"));
const unknown = [...tokensIn(templateText)].filter((t) => !known.has(t));
check("template: sets only tokens the styles have", unknown.length === 0 && tokensIn(templateText).size > 10, unknown.join(", "));
const evergreenText = fs.readFileSync(path.join(PUBLIC, "themes", "evergreen.css"), "utf8");
check("shipped: Evergreen sets only tokens the styles have", [...tokensIn(evergreenText)].every((t) => known.has(t)) && tokensIn(evergreenText).size > 10);
const styles = fs.readFileSync(path.join(PUBLIC, "styles.css"), "utf8");
check("styles: dark is keyed on the appearance, not the theme", styles.includes(':root[data-appearance="dark"]') && !styles.includes("data-theme"));

// --- each person's choice ------------------------------------------------------------------------
const db = openDatabase({ dataDir: tmp, key: generateKey() });
const access = createAccess({ db, fields: createFields({ db }) });
const ctx = access.contextFor({ role: "admin", sites: null });
const user = { id: "u1" };
const prefs = createPrefs({ db, access, themes });
check("choice: the device's setting and the standard look to start with", prefs.get(user, ctx).appearance === "auto" && prefs.get(user, ctx).theme === "standard");
db.writeDoc("prefs.u1", { theme: "dark", startSite: "last" });
check("choice: light or dark kept before there were themes is their appearance", prefs.get(user, ctx).appearance === "dark" && prefs.get(user, ctx).theme === "standard" && prefs.get(user, ctx).startSite === "last");
let saved = prefs.save(user, ctx, { theme: "harbor" });
check("choice: a theme is kept, and what was kept before stays", saved.theme === "harbor" && saved.appearance === "dark" && saved.startSite === "last"
  && db.readDoc("prefs.u1", {}).appearance === "dark" && db.readDoc("prefs.u1", {}).theme === "harbor");
saved = prefs.save(user, ctx, { appearance: "light" });
check("choice: light or dark is its own choice", saved.appearance === "light" && saved.theme === "harbor");
check("choice: back to the standard look", prefs.save(user, ctx, { theme: "standard" }).theme === "standard" && prefs.save(user, ctx, { theme: "amber" }).theme === "amber");
const status = (fn) => {
  try {
    fn();
    return 200;
  } catch (error) {
    return error.status;
  }
};
check("choice: only a theme there is", status(() => prefs.save(user, ctx, { theme: "purple" })) === 400 && status(() => prefs.save(user, ctx, { theme: "leaky" })) === 400
  && status(() => prefs.save(user, ctx, { theme: "dark" })) === 400 && status(() => prefs.save(user, ctx, { theme: null })) === 400 && prefs.get(user, ctx).theme === "amber");
check("choice: only auto, light or dark", status(() => prefs.save(user, ctx, { appearance: "purple" })) === 400 && prefs.get(user, ctx).appearance === "light");
check("choice: a theme taken away since is the standard look", createPrefs({ db, access, themes: loadThemes([]) }).get(user, ctx).theme === "standard" && prefs.get(user, ctx).theme === "amber");
check("choice: without themes at all, the standard look", createPrefs({ db, access }).get({ id: "u2" }, ctx).theme === "standard" && status(() => createPrefs({ db, access }).save({ id: "u2" }, ctx, { theme: "amber" })) === 400);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
