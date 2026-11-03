/**
 * Files people upload (a company's certificates of insurance), kept in the encrypted database
 * (stored_files). Only PDFs and PNG or JPEG images are taken, checked by their contents, not
 * their names. Each has a random ref, its address, which changes with every upload.
 */
const crypto = require("crypto");

// A data: URL sent as JSON (4 MB at most) holds a file of about 3 MB.
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const TYPES = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
};

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** A file's name as given, without any folders or characters that don't belong in a name. */
function cleanName(name, type) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, 120);
  return base || `file.${type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg"}`;
}

/** { type, data, name } from a data: URL of a PDF, PNG or JPEG; throws for anything else. */
function decodeFile(dataUrl, name, what = "The file") {
  const m = /^data:([a-z]+\/[a-z.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m || !TYPES[m[1]]) throw fail(400, `${what} must be a PDF, or a PNG or JPEG image.`);
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw fail(400, `${what} is empty.`);
  if (data.length > MAX_FILE_BYTES) throw fail(413, `${what} is larger than 3 MB; save it smaller (a scan in black and white, or at a lower resolution).`);
  if (!TYPES[m[1]](data)) throw fail(400, `${what}'s contents are not the ${m[1] === "application/pdf" ? "PDF" : "image"} it claims to be.`);
  return { type: m[1], data, name: cleanName(name, m[1]) };
}

function createStoredFiles({ db, now = Date.now }) {
  const raw = db.raw;

  /** Keeps a decoded file; returns its id and ref. */
  function save({ name, type, data }, { by = null } = {}) {
    const ref = crypto.randomBytes(16).toString("base64url");
    const id = Number(raw.prepare("INSERT INTO stored_files (ref, name, type, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ref, name, type, data.length, data, by, now()).lastInsertRowid);
    return { id, ref };
  }

  /** A file's name, type, size and ref (not its contents). */
  const info = (id) => (id ? raw.prepare("SELECT id, ref, name, type, size, created_by AS createdBy, created_at AS createdAt FROM stored_files WHERE id = ?").get(Number(id)) || null : null);

  /** A file with its contents, by ref. */
  const byRef = (ref) => (typeof ref === "string" && ref.length <= 64 ? raw.prepare("SELECT * FROM stored_files WHERE ref = ?").get(ref) || null : null);

  const remove = (id) => { if (id) raw.prepare("DELETE FROM stored_files WHERE id = ?").run(Number(id)); };

  return { save, info, byRef, remove };
}

module.exports = { createStoredFiles, decodeFile, MAX_FILE_BYTES };
