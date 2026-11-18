/**
 * Themes: named looks, one of which each person picks on their Account page. Light or dark
 * stays its own choice beside it (the "appearance"), and every theme has both.
 *
 * A theme is one CSS file: those that ship with the app in public/themes, and an
 * installation's own in <data folder>/themes (one there replaces a shipped one of the same
 * name). The file's name is the theme's id (evergreen.css is "evergreen"), and its first
 * comment says what the Account page calls it:
 *
 *     Theme: Evergreen
 *     About: Green accents on warm paper.
 *
 * A theme styles :root and what is under it, nothing else:
 *
 *     :root { ... }                             in both light and dark
 *     :root[data-appearance="light"] { ... }    in light
 *     :root[data-appearance="dark"] { ... }     in dark
 *     :root .app-header { ... }                 anything on the page
 *
 * Mostly it sets the design tokens at the top of public/styles.css (--primary, --surface,
 * --radius...). Each :root is rewritten here to :root[data-theme="<id>"], so a theme applies
 * only to those who chose it, wins over the standard look without !important, and can't leak
 * into another theme. A file that styles anything outside :root, or loads anything (@import,
 * @font-face), is left out, and the server's log says why. Files whose names start with an
 * underscore (_template.css) are never loaded.
 *
 * The standard look is the theme "standard": no file at all. Every theme goes out as one
 * stylesheet, /themes.css, so switching is instant and nothing is loaded on demand.
 */
const fs = require("fs");
const path = require("path");

const STANDARD = { id: "standard", name: "Standard", about: "The look the app comes with." };
// Names the choices already use: the standard look, and what "appearance" is set to.
const RESERVED = new Set(["standard", "auto", "light", "dark"]);
const THEME_FILE = /^([a-z0-9][a-z0-9-]{0,39})\.css$/;
const MAX_THEME_BYTES = 200 * 1024;

/** The top-level blocks of some CSS (comments already out), as [{ prelude, body }]. */
function blocks(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      if (depth === 0) open = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("it has a } with no { before it");
      if (depth === 0) {
        out.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) });
        start = i + 1;
      }
    }
  }
  if (depth !== 0 || quote) throw new Error("it has a { or a quote that is never closed");
  const rest = css.slice(start).trim();
  if (rest) throw new Error(`"${rest.slice(0, 40)}" is outside any block`);
  return out;
}

/** A selector list split at its commas, leaving those inside brackets alone: ":root a, :root :is(b, c)". */
function selectors(prelude) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(prelude.slice(start).trim());
  return out;
}

/** A theme's CSS with every :root made :root[data-theme="<id>"]; throws for anything that isn't under :root. */
function scopeCss(css, id) {
  return blocks(css).map(({ prelude, body }) => {
    if (!prelude) throw new Error("it has a block with no selector");
    if (prelude.includes(";")) throw new Error(`"${prelude.split(";")[0].trim().slice(0, 40)}" is outside any block`);
    if (prelude.startsWith("@")) {
      const rule = prelude.split(/[\s(]/)[0];
      if (rule !== "@media" && rule !== "@supports") throw new Error(`${rule} isn't something a theme may use`);
      return `${prelude} {\n${scopeCss(body, id)}\n}`;
    }
    const scoped = selectors(prelude).map((selector) => {
      if (!/^:root(?![\w-])/.test(selector)) throw new Error(`"${selector.slice(0, 60)}" doesn't start with :root`);
      return `:root[data-theme="${id}"]${selector.slice(":root".length)}`;
    });
    return `${scoped.join(", ")} {${body.trimEnd()}\n}`;
  }).join("\n");
}

/** { id, name, about, css } from a theme file's text; throws (with the reason) for one that can't be used. */
function parseTheme(id, text) {
  if (!THEME_FILE.test(`${id}.css`)) throw new Error("its name must be lower-case letters, digits and hyphens, 40 at most");
  if (RESERVED.has(id)) throw new Error(`"${id}" is a name the app uses itself`);
  if (Buffer.byteLength(text) > MAX_THEME_BYTES) throw new Error("it is larger than 200 KB");
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(text);
  const said = (label) => {
    const m = head && new RegExp(`^[\\s*]*${label}:[ \\t]*(.+)$`, "im").exec(head[1]);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  };
  const name = said("Theme").slice(0, 40) || id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const css = scopeCss(text.replace(/\/\*[\s\S]*?\*\//g, ""), id);
  if (!css) throw new Error("it styles nothing");
  return { id, name, about: said("About").slice(0, 160), css };
}

/**
 * The themes in these folders (a later folder's file replaces an earlier one's of the same
 * name): { list() for the Account page, has(id), css (all of them, as /themes.css sends it),
 * problems ([{ file, reason }], the files left out) }.
 */
function loadThemes(dirs = []) {
  const found = new Map();
  const problems = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;   // No such folder: no themes from it.
    }
    for (const file of names) {
      if (!file.endsWith(".css") || file.startsWith("_")) continue;
      const full = path.join(dir, file);
      try {
        found.set(file.slice(0, -4), parseTheme(file.slice(0, -4), fs.readFileSync(full, "utf8")));
      } catch (error) {
        problems.push({ file: full, reason: error.message });
      }
    }
  }
  const themes = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  const css = themes.map((t) => `/* ${t.name.replace(/\*\//g, "")} */\n${t.css}\n`).join("\n");
  return {
    list: () => [STANDARD, ...themes.map(({ id, name, about }) => ({ id, name, about }))],
    has: (id) => id === STANDARD.id || found.has(id),
    css,
    problems
  };
}

module.exports = { loadThemes, parseTheme, scopeCss, STANDARD_THEME: STANDARD.id };
