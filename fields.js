/**
 * Custom fields: their definitions and values.
 *
 * A definition belongs to a record type (company or person). With no record_id it is
 * database-wide: every record of that type has it, and it can be required, searched
 * and exported. With a record_id it belongs to that one record only, and can later be
 * promoted to database-wide, keeping its value.
 *
 * Values are stored as text, one row per field and record, and converted on the way
 * out (numbers, yes/no). Who may see or change a field is access.js's business.
 */
const { ENTITIES } = require("./catalog");

const TYPES = ["text", "longtext", "number", "date", "boolean", "choice", "email", "phone", "url"];
const TYPE_LABELS = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  date: "Date",
  boolean: "Yes / no",
  choice: "Choice list",
  email: "Email",
  phone: "Phone",
  url: "Web address"
};
const MAX_VALUE = 4000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** A field key from its label: lower-case letters, digits and underscores. */
function slug(label) {
  const s = String(label || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) ? s : `f_${s || "field"}`;
}

function cleanChoices(choices) {
  const list = (Array.isArray(choices) ? choices : String(choices || "").split(/\r?\n|,/))
    .map((c) => String(c).trim().slice(0, 100))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 100);
}

/**
 * The stored text for `input` in field `def`, or null for "no value". Throws a 400
 * naming the field when the value does not fit its type.
 */
function normaliseValue(def, input) {
  if (input === null || input === undefined) return null;
  if (def.type === "boolean") {
    if (input === "") return null;
    if (typeof input === "boolean") return input ? "1" : "0";
    const s = String(input).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return "1";
    if (["0", "false", "no", "n", "off"].includes(s)) return "0";
    throw fail(400, `${def.label} must be yes or no.`);
  }
  const s = String(input).trim();
  if (!s) return null;
  if (s.length > MAX_VALUE) throw fail(400, `${def.label} is too long (at most ${MAX_VALUE} characters).`);
  switch (def.type) {
    case "number": {
      const n = Number(s.replace(/,/g, ""));
      if (!Number.isFinite(n)) throw fail(400, `${def.label} must be a number.`);
      return String(n);
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw fail(400, `${def.label} must be a date (YYYY-MM-DD).`);
      return s;
    }
    case "choice": {
      const match = (def.choices || []).find((c) => c.toLowerCase() === s.toLowerCase());
      if (!match) throw fail(400, `${def.label} must be one of: ${(def.choices || []).join(", ")}.`);
      return match;
    }
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw fail(400, `${def.label} must be an email address.`);
      return s;
    case "url":
      if (!/^https?:\/\/\S+$/i.test(s)) throw fail(400, `${def.label} must start with http:// or https://.`);
      return s;
    case "text":
    case "phone":
      return s.replace(/[\r\n]+/g, " ");
    default:
      return s;
  }
}

/** A stored value as the API hands it out. */
function outputValue(def, stored) {
  if (stored === null || stored === undefined) return null;
  if (def.type === "boolean") return stored === "1";
  if (def.type === "number") return Number(stored);
  return stored;
}

function createFields({ db }) {
  const raw = db.raw;

  function row(r) {
    return r && {
      id: r.id,
      entity: r.entity,
      key: r.key,
      label: r.label,
      type: r.type,
      choices: r.choices ? JSON.parse(r.choices) : [],
      required: Boolean(r.required),
      recordId: r.record_id ?? null,
      position: r.position,
      createdAt: r.created_at
    };
  }

  /**
   * Definitions of `entity`: the database-wide ones, plus the one-record fields of
   * `recordId` (or of every record with `allRecords`).
   */
  function list(entity, { recordId = null, allRecords = false } = {}) {
    const rows = allRecords
      ? raw.prepare("SELECT * FROM field_definitions WHERE entity = ? ORDER BY record_id IS NOT NULL, position, id").all(entity)
      : raw.prepare("SELECT * FROM field_definitions WHERE entity = ? AND (record_id IS NULL OR record_id = ?) ORDER BY record_id IS NOT NULL, position, id").all(entity, recordId ?? -1);
    return rows.map(row);
  }

  function get(id) {
    return row(raw.prepare("SELECT * FROM field_definitions WHERE id = ?").get(id));
  }

  function uniqueKey(entity, label) {
    const base = slug(label);
    let key = base;
    for (let n = 2; raw.prepare("SELECT 1 FROM field_definitions WHERE entity = ? AND key = ?").get(entity, key); n += 1) key = `${base}_${n}`;
    return key;
  }

  function validate(input, existing = null) {
    const out = {};
    if (input.label !== undefined || !existing) {
      const label = String(input.label || "").trim().slice(0, 80);
      if (!label) throw fail(400, "Give the field a name.");
      out.label = label;
    }
    if (input.type !== undefined || !existing) {
      if (existing && input.type !== existing.type) throw fail(400, "A field's type can't be changed once it exists; add a new field instead.");
      if (!TYPES.includes(input.type)) throw fail(400, `Field type must be one of: ${TYPES.join(", ")}.`);
      out.type = input.type;
    }
    const type = out.type || existing.type;
    if (input.choices !== undefined || (!existing && type === "choice")) {
      const choices = cleanChoices(input.choices);
      if (type === "choice" && !choices.length) throw fail(400, "A choice list needs at least one choice.");
      out.choices = type === "choice" ? choices : [];
    }
    if (input.required !== undefined) out.required = Boolean(input.required);
    if (input.position !== undefined) {
      const p = Number(input.position);
      if (!Number.isInteger(p) || p < 0 || p > 10000) throw fail(400, "Position must be a whole number.");
      out.position = p;
    }
    return out;
  }

  function create({ entity, label, type, choices, required = false, recordId = null }) {
    if (!ENTITIES.includes(entity)) throw fail(400, `Fields belong to one of: ${ENTITIES.join(", ")}.`);
    const v = validate({ label, type, choices, required });
    if (recordId !== null && recordId !== undefined) {
      const table = { company: "companies", person: "people", visitor: "visitors" }[entity];
      if (!raw.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(recordId)) throw fail(404, "That record does not exist.");
    }
    const now = Date.now();
    const position = (raw.prepare("SELECT max(position) AS p FROM field_definitions WHERE entity = ?").get(entity).p ?? 0) + 10;
    const info = raw.prepare("INSERT INTO field_definitions (entity, key, label, type, choices, required, record_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entity, uniqueKey(entity, v.label), v.label, v.type, JSON.stringify(v.choices || []), recordId === null || recordId === undefined ? (v.required ? 1 : 0) : 0, recordId ?? null, position, now, now);
    return get(info.lastInsertRowid);
  }

  /** Changes a definition; `promote: true` makes a one-record field database-wide. */
  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such field.");
    const v = validate(patch, existing);
    if (v.choices && existing.type === "choice") {
      // Values no longer among the choices would fail every later save of that record.
      const used = raw.prepare("SELECT DISTINCT value FROM field_values WHERE field_id = ?").all(id).map((r) => r.value);
      const missing = used.filter((u) => !v.choices.includes(u));
      if (missing.length) throw fail(409, `Some records use ${missing.map((m) => `"${m}"`).join(", ")}; keep those choices or change those records first.`);
    }
    const next = { ...existing, ...v };
    if (patch.promote) next.recordId = null;
    if (next.recordId !== null) next.required = false;
    raw.prepare("UPDATE field_definitions SET label = ?, choices = ?, required = ?, record_id = ?, position = ?, updated_at = ? WHERE id = ?")
      .run(next.label, JSON.stringify(next.choices || []), next.required ? 1 : 0, next.recordId, next.position, Date.now(), id);
    return get(id);
  }

  function remove(id) {
    const existing = get(id);
    if (!existing) throw fail(404, "No such field.");
    raw.prepare("DELETE FROM field_definitions WHERE id = ?").run(id);
    return existing;
  }

  /** Stored values of `entity` records: Map(recordId -> Map(fieldId -> text)). */
  function valuesFor(entity, recordIds) {
    const out = new Map();
    if (!recordIds.length) return out;
    // Chunked so a long list stays under SQLite's parameter limit.
    for (let i = 0; i < recordIds.length; i += 500) {
      const chunk = recordIds.slice(i, i + 500);
      const rows = raw.prepare(`SELECT v.record_id, v.field_id, v.value FROM field_values v JOIN field_definitions d ON d.id = v.field_id WHERE d.entity = ? AND v.record_id IN (${chunk.map(() => "?").join(",")})`).all(entity, ...chunk);
      for (const r of rows) {
        if (!out.has(r.record_id)) out.set(r.record_id, new Map());
        out.get(r.record_id).set(r.field_id, r.value);
      }
    }
    return out;
  }

  /** Writes already-normalised values: Map or object of fieldId -> text or null. */
  function writeValues(recordId, values) {
    const put = raw.prepare("INSERT INTO field_values (field_id, record_id, value) VALUES (?, ?, ?) ON CONFLICT(field_id, record_id) DO UPDATE SET value = excluded.value");
    const del = raw.prepare("DELETE FROM field_values WHERE field_id = ? AND record_id = ?");
    for (const [fieldId, value] of values instanceof Map ? values : Object.entries(values)) {
      if (value === null) del.run(Number(fieldId), recordId);
      else put.run(Number(fieldId), recordId, value);
    }
  }

  /** Removes a record's values and its one-record fields (the record is being deleted). */
  function forgetRecord(entity, recordId) {
    raw.prepare("DELETE FROM field_values WHERE record_id = ? AND field_id IN (SELECT id FROM field_definitions WHERE entity = ?)").run(recordId, entity);
    const own = raw.prepare("SELECT id FROM field_definitions WHERE entity = ? AND record_id = ?").all(entity, recordId).map((r) => r.id);
    raw.prepare("DELETE FROM field_definitions WHERE entity = ? AND record_id = ?").run(entity, recordId);
    return own;
  }

  return { list, get, create, update, remove, valuesFor, writeValues, forgetRecord };
}

module.exports = { createFields, normaliseValue, outputValue, slug, TYPES, TYPE_LABELS };
