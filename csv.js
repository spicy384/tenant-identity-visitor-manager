/**
 * Just enough CSV for importing items and exporting history: RFC 4180 quoting,
 * CRLF or LF line ends, a header row, and a guard against spreadsheet formulas in
 * exported cells.
 */

/**
 * Rows of fields from CSV text. Quoted fields may contain the delimiter, quotes ("") and
 * newlines. Each row has a `line` property: the line of the file it starts on. A quote that
 * is never closed is an error (status 400) naming its line, rather than the rest of the file
 * read silently as one cell.
 */
function parseCsv(input, { delimiter = "," } = {}) {
  const textIn = String(input || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 0;
  const end = () => {
    row.push(field); field = "";
    if (row.some((f) => f !== "")) { row.line = rowLine; rows.push(row); }
    row = [];
  };
  for (let i = 0; i < textIn.length; i += 1) {
    const c = textIn[i];
    if (c === "\n" || (c === "\r" && textIn[i + 1] !== "\n")) line += 1;
    if (quoted) {
      if (c === "\"" && textIn[i + 1] === "\"") { field += "\""; i += 1; }
      else if (c === "\"") quoted = false;
      else field += c;
    } else if (c === "\"" && field === "") {
      quoted = true;
      quoteLine = line;
    } else if (c === delimiter) {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && textIn[i + 1] === "\n") { i += 1; line += 1; }
      end();
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (quoted) {
    const error = new Error(`The quote that opens a cell on line ${quoteLine} is never closed, so everything after it would be read as one cell. Look on that line for a stray " (such as 12" for inches): double it ("") or take it out.`);
    error.status = 400;
    throw error;
  }
  end();
  return rows;
}

/** Objects keyed by the lower-cased, trimmed header of the first row. */
function parseCsvObjects(input) {
  const [header, ...rows] = parseCsv(input);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** One CSV cell. A leading = + - @ is prefixed with ' so a spreadsheet does not run it. */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}

function toCsv(header, rows) {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

module.exports = { parseCsv, parseCsvObjects, csvCell, toCsv };
