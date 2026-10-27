/**
 * Importing people, companies, visitors or badges from an Access database (.accdb or .mdb) or a CSV file,
 * with the file's columns matched to the app's fields. Three steps:
 *
 *   POST /api/import/read            the file itself (raw body): its tables, columns and
 *                                    row counts, and a token for the next steps
 *   GET  /api/import/:token/table    one table's columns and its first rows, to match and preview
 *   POST /api/import/:token/run      { table, target, mapping, createCompanies }: imports it
 *
 * The file is read on the server and held in memory only, for IMPORT_TTL_MS, by the account
 * that sent it; it is never written to disk. Running the import goes through the same
 * checks as a CSV import (server.js importPeople and importCompanies): field access, sites,
 * matching existing records, and all or nothing.
 *
 * A mapping says, for each of the app's columns (first_name, company, a custom field's
 * key, ...), where its value comes from: { column: "Surname" } or { value: "Acme Corp" }
 * (the same for every row). Columns that aren't mapped aren't imported.
 */
const crypto = require("crypto");
const express = require("express");
const { parseCsv } = require("./csv");

const IMPORT_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_HELD = 4;
const MAX_ROWS = 20000;
const SAMPLE_ROWS = 10;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** A cell from Access or CSV as the import's text: dates as YYYY-MM-DD, yes/no as yes or no. */
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "";
  return String(value).trim();
}

/**
 * The delimiter of a CSV file, from its header line: a comma, or a semicolon or tab when the
 * header has more of those (spreadsheets set to some regions save "CSV" with semicolons).
 */
function csvDelimiter(text) {
  const header = text.slice(0, text.search(/\r|\n|$/)).replace(/"[^"]*"/g, "");
  const count = (c) => header.split(c).length - 1;
  return [";", "\t"].find((c) => count(c) > count(",")) || ",";
}

/**
 * A CSV file as one table, keeping its header's own names. lines: the line of the file each
 * row starts on (a quoted cell may run over several), for naming a row with a problem.
 */
function csvTable(buffer) {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const [header, ...rows] = parseCsv(text, { delimiter: csvDelimiter(text) });
  if (!header || !header.length) throw fail(400, "The CSV file is empty.");
  const names = header.map((h, i) => String(h).trim() || `Column ${i + 1}`);
  const columns = names.map((name) => ({ name, type: "text" }));
  const kept = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  const data = kept.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
  return { name: "CSV", columns, rowCount: data.length, rows: () => data, lines: kept.map((r) => r.line) };
}

/** An Access database's tables (system tables left out), each read only when asked for. */
async function accessTables(buffer, password) {
  const { default: MDBReader } = await import("mdb-reader");
  let reader;
  try {
    reader = new MDBReader(buffer, password ? { password } : undefined);
  } catch (error) {
    throw fail(400, /password|encrypt/i.test(error.message)
      ? "This Access database is password-protected: give its password, or export the table to CSV from Access."
      : "That file couldn't be read as an Access database (.accdb or .mdb).");
  }
  let names;
  try {
    names = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
  } catch {
    throw fail(400, "That file couldn't be read as an Access database (.accdb or .mdb). If it has a password, give it.");
  }
  return names.map((name) => {
    const table = reader.getTable(name);
    return {
      name,
      columns: table.getColumns().map((c) => ({ name: c.name, type: c.type })),
      rowCount: table.rowCount,
      rows: () => table.getData()
    };
  });
}

/** What can be imported, and who may import it. */
const TARGETS = {
  people: { may: (access, ctx) => access.canEditDirectory(ctx), refusal: "This account can't change the directory." },
  companies: { may: (access, ctx) => access.canEditDirectory(ctx), refusal: "This account can't change the directory." },
  visitors: { may: (access, ctx) => access.canEditVisitors(ctx), refusal: "This account can't change visitors." },
  badges: { may: (access, ctx) => access.canManageBadges(ctx), refusal: "Only Security adds and changes badges." }
};

function createImportRoutes({ access, importCompanies, importPeople, importVisitors, importBadges, now = Date.now }) {
  // Reading a file needs the right to import something; running it, the right to import that.
  const mayImport = (req, res, next) => (Object.values(TARGETS).some((t) => t.may(access, req.ctx)) ? next() : res.status(403).json({ error: "This account can't import anything." }));

  const router = express.Router();
  // token -> { owner, at, format, fileName, tables }
  const held = new Map();

  function sweep() {
    for (const [token, h] of held) if (h.at + IMPORT_TTL_MS < now()) held.delete(token);
  }
  const timer = setInterval(sweep, 60 * 1000);
  timer.unref();

  const ownerOf = (req) => req.user?.id || req.user?.username;

  function heldFor(req) {
    sweep();
    const h = held.get(String(req.params.token || ""));
    if (!h || h.owner !== ownerOf(req)) throw fail(404, "That file is no longer held: choose it again.");
    h.at = now();
    return h;
  }

  function tableOf(h, name) {
    const table = h.tables.find((t) => t.name === name) || (h.tables.length === 1 && !name ? h.tables[0] : null);
    if (!table) throw fail(404, "There is no table with that name in the file.");
    return table;
  }

  router.post("/api/import/read", mayImport, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) throw fail(400, "Choose a file to import.");
    const fileName = String(req.query.name || "").slice(0, 200);
    const format = req.query.format === "access" || /\.(accdb|mdb)$/i.test(fileName) ? "access" : "csv";
    const password = String(req.get("x-import-password") || "");
    const tables = format === "access" ? await accessTables(buffer, password) : [csvTable(buffer)];
    if (!tables.length) throw fail(400, "That database has no tables.");
    // One file held per person, and only a few at once: each may be large.
    for (const [token, h] of held) if (h.owner === ownerOf(req)) held.delete(token);
    sweep();
    if (held.size >= MAX_HELD) throw fail(503, "Other imports are being prepared; try again in a few minutes.");
    const token = crypto.randomBytes(18).toString("base64url");
    held.set(token, { owner: ownerOf(req), at: now(), format, fileName, tables });
    res.json({ token, format, fileName, tables: tables.map((t) => ({ name: t.name, columns: t.columns, rowCount: t.rowCount })) });
  });

  router.get("/api/import/:token/table", mayImport, (req, res) => {
    const table = tableOf(heldFor(req), String(req.query.name || ""));
    const sample = table.rows().slice(0, SAMPLE_ROWS).map((r) => Object.fromEntries(table.columns.map((c) => [c.name, cellText(r[c.name])])));
    res.json({ name: table.name, columns: table.columns, rowCount: table.rowCount, sample });
  });

  router.post("/api/import/:token/run", mayImport, (req, res) => {
    const h = heldFor(req);
    const body = req.body || {};
    const table = tableOf(h, String(body.table || ""));
    const target = Object.prototype.hasOwnProperty.call(TARGETS, body.target) ? body.target : null;
    if (!target) throw fail(400, "Import into people, companies, visitors or badges.");
    if (!TARGETS[target].may(access, req.ctx)) throw fail(403, TARGETS[target].refusal);
    const mapping = body.mapping && typeof body.mapping === "object" ? body.mapping : {};
    const known = new Set(table.columns.map((c) => c.name));
    const sources = [];
    for (const [key, from] of Object.entries(mapping)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw fail(400, `"${key}" isn't one of the app's columns.`);
      if (from && typeof from.column === "string") {
        if (!known.has(from.column)) throw fail(400, `The table has no column "${from.column}".`);
        sources.push([key, (r) => cellText(r[from.column])]);
      } else if (from && from.value !== undefined && from.value !== null && String(from.value).trim() !== "") {
        const fixed = String(from.value).trim().slice(0, 500);
        sources.push([key, () => fixed]);
      }
    }
    const all = table.rows();
    if (all.length > MAX_ROWS) throw fail(400, `The table has ${all.length.toLocaleString("en-US")} rows; import at most ${MAX_ROWS.toLocaleString("en-US")} at a time (split it with a query in Access).`);
    const rows = all.map((r) => Object.fromEntries(sources.map(([key, get]) => [key, get(r)])));
    const from = h.format === "access" ? `Access table "${table.name}"${h.fileName ? ` in ${h.fileName}` : ""}` : `CSV${h.fileName ? ` ${h.fileName}` : ""}`;
    const where = h.format === "access" ? (i) => `Row ${i + 1}` : (i) => `Line ${table.lines?.[i] ?? i + 2}`;
    // skipProblems: import the rows that can be, and list the ones left out, rather than none.
    const skipProblems = body.skipProblems === true;
    const result = target === "companies" ? importCompanies(req, rows, { where, from, skipProblems })
      : target === "visitors" ? importVisitors(req, rows, { where, from, skipProblems })
        : target === "badges" ? importBadges(req, rows, { where, from, skipProblems })
          : importPeople(req, rows, { createCompanies: Boolean(body.createCompanies), where, from, skipProblems });
    held.delete(req.params.token);
    res.json({ ok: true, ...result });
  });

  router.delete("/api/import/:token", mayImport, (req, res) => {
    if (held.get(req.params.token)?.owner === ownerOf(req)) held.delete(req.params.token);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createImportRoutes, cellText, csvTable, csvDelimiter };
