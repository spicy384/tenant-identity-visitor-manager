/**
 * The database key: 32 random bytes, written as 64 hex characters. It is never kept in
 * the data directory, so a copy of the data volume (or a backup of it) is useless on
 * its own. In Docker it arrives as a secret file; for a quick local run it can be an
 * environment variable.
 *
 *   DB_KEY_FILE    a file holding the key (default /run/secrets/db_key when that exists)
 *   DB_KEY         the key itself (DB_KEY_FILE wins when both are set)
 *   DB_KEY_CREATE  "true": when DB_KEY_FILE doesn't exist yet and there is no database
 *                  either (a fresh install), make a key and write it there. The compose
 *                  file uses this with a volume of its own, so `docker compose up` is all
 *                  a first start needs. A missing key for an existing database is still
 *                  an error: a new key could never open it.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DOCKER_SECRET = "/run/secrets/db_key";
const KEY_RE = /^[0-9a-f]{64}$/i;

function fail(message) {
  const error = new Error(message);
  error.code = "DB_KEY";
  return error;
}

function generateKey() {
  return crypto.randomBytes(32).toString("hex");
}

/** Checks a key's shape and returns it lower-cased; throws with what is wrong. */
function normalizeKey(value, source) {
  const key = String(value || "").trim();
  if (!KEY_RE.test(key)) {
    throw fail(`${source} does not hold a database key: expected 64 hex characters, found ${key.length ? `${key.length} characters` : "nothing"}. Make one with "npm run new-key".`);
  }
  return key.toLowerCase();
}

/**
 * The key and where it came from, or a thrown error saying how to provide one. A key
 * file inside the data directory is refused: keeping the key beside the data defeats it.
 */
function loadKey({ env = process.env, dataDir = null, dbFile = "identity.db" } = {}) {
  let file = String(env.DB_KEY_FILE || "").trim();
  if (!file && !env.DB_KEY && fs.existsSync(DOCKER_SECRET)) file = DOCKER_SECRET;
  if (file) {
    const resolved = path.resolve(file);
    if (dataDir) {
      const rel = path.relative(path.resolve(dataDir), resolved);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        throw fail(`DB_KEY_FILE (${resolved}) is inside the data directory. Keep the key somewhere else, such as a Docker secret, so a copy of the data cannot be opened with it.`);
      }
    }
    if (String(env.DB_KEY_CREATE || "").toLowerCase() === "true" && !fs.existsSync(resolved)) {
      if (dataDir && fs.existsSync(path.join(dataDir, dbFile))) {
        throw fail(`The database key is missing from ${resolved}, and there is already a database in ${dataDir}. A new key can't open it: put the key it was made with back in ${resolved} (from your password manager).`);
      }
      const key = generateKey();
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${key}\n`, { mode: 0o600, flag: "wx" });
      return { key, source: resolved, created: true };
    }
    let text;
    try {
      text = fs.readFileSync(resolved, "utf8");
    } catch (error) {
      throw fail(`Could not read the database key from ${resolved}: ${error.message}`);
    }
    return { key: normalizeKey(text, resolved), source: resolved };
  }
  if (env.DB_KEY) return { key: normalizeKey(env.DB_KEY, "DB_KEY"), source: "DB_KEY" };
  throw fail("No database key. Set DB_KEY_FILE to a file holding the key (in Docker, a secret named db_key), or DB_KEY to the key itself. Make one with \"npm run new-key\" and keep a copy in your password manager: without it the data cannot be read.");
}

module.exports = { generateKey, loadKey, normalizeKey, KEY_RE };
