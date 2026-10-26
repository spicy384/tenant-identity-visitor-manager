/**
 * Checks on the browser code that need no browser. The DOM's own append, prepend and
 * replaceChildren write a null or undefined out as the text "null" or "undefined" (unlike the
 * app's h(), which skips them), so a "cond ? node : null" handed straight to one shows up on
 * the page. Every such call in public/ is read, and a null or undefined passed to it directly
 * fails: use "" there instead.
 */
const fs = require("fs");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Browser code");
const PUBLIC = path.join(__dirname, "..", "public");
const METHODS = /\.(append|prepend|replaceChildren|before|after|replaceWith)\(/g;

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? scripts(p) : e.name.endsWith(".js") ? [p] : [];
  });
}

/** The source with comments and string contents blanked out (line breaks kept), so neither is mistaken for code. */
function codeOnly(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") { out += " "; i++; }
      out += s[i] ?? "";
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      // Template literals keep their ${...} parts as code; plain text inside quotes is blanked.
      out += c;
      i++;
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === "\\") { out += "  "; i++; continue; }
        if (c === "`" && s[i] === "$" && s[i + 1] === "{") { depth++; out += "${"; i++; continue; }
        if (depth && s[i] === "}") { depth--; out += "}"; continue; }
        if (!depth && s[i] === c) { out += c; break; }
        out += depth ? s[i] : s[i] === "\n" ? "\n" : " ";
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Every null or undefined passed directly to a DOM insertion call: [{ line, call }]. */
function directNulls(source) {
  const s = codeOnly(source);
  const found = [];
  let m;
  METHODS.lastIndex = 0;
  while ((m = METHODS.exec(s))) {
    let depth = 1;
    for (let i = m.index + m[0].length; i < s.length && depth > 0; i++) {
      const c = s[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 1) {
        const word = /^(null|undefined)\b/.exec(s.slice(i, i + 9));
        if (word && !/[\w$.]/.test(s[i - 1])) {
          found.push({ line: s.slice(0, i).split("\n").length, call: m[1] });
          i += word[1].length - 1;
        }
      }
    }
  }
  return found;
}

// The check catches what it is meant to, and leaves alone what is fine.
check("scan: a null straight into append is caught", directNulls('pane.append(a, ok ? b : null);').length === 1);
check("scan: into replaceChildren across lines too", directNulls("box.replaceChildren(\n  x,\n  y ? z : undefined\n);").length === 1);
check("scan: a null inside h() is fine", directNulls('pane.append(h("div", {}, ok ? b : null));').length === 0);
check("scan: \"\" is fine, and so are comments and strings", directNulls('pane.append(a, ok ? b : ""); // or null\nbox.append("null", `x ${"null"}`);').length === 0);

const problems = [];
for (const file of scripts(PUBLIC)) {
  for (const f of directNulls(fs.readFileSync(file, "utf8"))) problems.push(`${path.relative(PUBLIC, file)}:${f.line} (${f.call})`);
}
check("no null or undefined is handed straight to append or replaceChildren", problems.length === 0, problems.join(", "));

process.exit(report() ? 0 : 1);
