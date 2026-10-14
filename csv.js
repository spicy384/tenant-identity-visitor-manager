/**
 * Just enough CSV for importing items and exporting history: RFC 4180 quoting,
 * CRLF or LF line ends, a header row, and a guard against spreadsheet formulas in
 * exported cells.
 */

/** Rows of fields from CSV text. Quoted fields may contain commas, quotes ("") and newlines. */
function parseCsv(input) {
  const textIn = String(input || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < textIn.length; i += 1) {
    const c = textIn[i];
    if (quoted) {
      if (c === "\"" && textIn[i + 1] === "\"") { field += "\""; i += 1; }
      else if (c === "\"") quoted = false;
      else field += c;
    } else if (c === "\"" && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && textIn[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
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
