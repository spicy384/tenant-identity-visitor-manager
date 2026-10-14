/**
 * The encrypted database: nothing readable on disk (main file, WAL, backups), the wrong
 * key refused, key loading rules, the documents store, and changing the key.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { openDatabase, openEncrypted, rekeyDatabase, DB_FILE } = require("../db");
const { loadKey, generateKey } = require("../db-key");
const { createFields } = require("../fields");
const { createSites } = require("../sites");
const { createDirectory } = require("../directory");

const { check, report } = createChecker("Database: encryption, keys, documents, rekey");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-db-"));
const dataDir = path.join(tmp, "data");
const key = generateKey();
const MARKER = "Zebulon Quartermaine";

const db = openDatabase({ dataDir, key });
const fields = createFields({ db });
const sites = createSites({ db });
const directory = createDirectory({ db, fields });
const site = sites.ensureDefault("Harbour Point");
const company = directory.createCompany({ name: "Quartz Holdings", sites: [{ siteId: site.id, suite: "Suite 9" }] });
directory.createPerson({ firstName: "Zebulon", lastName: "Quartermaine", companyId: company.id, email: "zeb@quartz.example" });
db.writeDoc("users", [{ username: "secret-admin", passwordHash: "scrypt$x" }]);
sites.setLogo(site.id, `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("LOGO-MARKER-BYTES")]).toString("base64")}`);

const file = path.join(dataDir, DB_FILE);
const wal = `${file}-wal`;
const hasPlain = (f, s) => fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(s));

// While open, recent writes sit in the WAL file: that must be encrypted too.
check("the WAL file exists while the database is open (so the checks below mean something)", fs.existsSync(wal) && fs.statSync(wal).size > 0);
check("the WAL file holds no plaintext name", !hasPlain(wal, MARKER) && !hasPlain(wal, "Quartermaine"));
check("the WAL file holds no account names", !hasPlain(wal, "secret-admin"));
check("the WAL file holds no logo bytes", !hasPlain(wal, "LOGO-MARKER-BYTES"));
check("the WAL file holds no email address", !hasPlain(wal, "zeb@quartz.example"));

check("documents read back", db.readDoc("users", [])[0].username === "secret-admin");
check("a missing document gives the fallback", JSON.stringify(db.readDoc("nothing", { a: 1 })) === "{\"a\":1}");
db.raw.prepare("INSERT INTO documents (name, value, updated_at) VALUES ('broken', '{not json', 0)").run();
let docError = null;
try { db.readDoc("broken", []); } catch (error) { docError = error; }
check("an unreadable document is an error, not empty", docError && docError.status === 503);

const backup = path.join(tmp, "backup.db");
db.backupTo(backup);
db.close();

check("the database file holds no plaintext name", !hasPlain(file, "Quartermaine"));
check("the database file holds no company name", !hasPlain(file, "Quartz Holdings"));
check("the database file holds no logo bytes", !hasPlain(file, "LOGO-MARKER-BYTES"));
check("the database file does not start with the SQLite header", !fs.readFileSync(file).subarray(0, 15).equals(Buffer.from("SQLite format 3")));
check("a backup holds no plaintext", !hasPlain(backup, "Quartermaine") && !hasPlain(backup, "secret-admin"));
const fromBackup = openEncrypted(backup, key);
check("a backup opens with the same key", fromBackup.prepare("SELECT first_name FROM people").get().first_name === "Zebulon");
fromBackup.close();

let wrong = null;
try { openDatabase({ dataDir, key: generateKey() }); } catch (error) { wrong = error; }
check("the wrong key is refused with a clear message", wrong && /does not open/.test(wrong.message), wrong?.message);
let none = null;
try { openDatabase({ dataDir, key: "" }); } catch (error) { none = error; }
check("no key is refused", Boolean(none));

// --- loading the key ---------------------------------------------------------------------

const keyFile = path.join(tmp, "db_key");
fs.writeFileSync(keyFile, `${key}\n`);
check("a key file is read and trimmed", loadKey({ env: { DB_KEY_FILE: keyFile } }).key === key);
check("DB_KEY works on its own", loadKey({ env: { DB_KEY: key.toUpperCase() } }).key === key);
const insideFile = path.join(dataDir, "db_key");
fs.writeFileSync(insideFile, key);
let inside = null;
try { loadKey({ env: { DB_KEY_FILE: insideFile }, dataDir }); } catch (error) { inside = error; }
check("a key file inside the data directory is refused", inside && /inside the data directory/.test(inside.message));
fs.rmSync(insideFile);
let short = null;
try { loadKey({ env: { DB_KEY: "abc" } }); } catch (error) { short = error; }
check("a malformed key is refused", short && /64 hex/.test(short.message));
let missing = null;
try { loadKey({ env: {} }); } catch (error) { missing = error; }
check("no key at all explains how to make one", missing && /new-key/.test(missing.message));

// A fresh install makes its own key (DB_KEY_CREATE, as the compose file sets).
const freshData = path.join(tmp, "fresh-data");
const autoFile = path.join(tmp, "keys", "db_key");
const autoEnv = { DB_KEY_FILE: autoFile, DB_KEY_CREATE: "true" };
const made = loadKey({ env: autoEnv, dataDir: freshData });
check("create: a fresh install makes a key in DB_KEY_FILE", made.created === true && fs.readFileSync(autoFile, "utf8").trim() === made.key && /^[0-9a-f]{64}$/.test(made.key));
check("create: and only readable by its owner", process.platform === "win32" || (fs.statSync(autoFile).mode & 0o077) === 0);
const again = loadKey({ env: autoEnv, dataDir: freshData });
check("create: the next start reads the same key, making none", again.key === made.key && !again.created);
fs.rmSync(autoFile);
let lostKey = null;
try { loadKey({ env: autoEnv, dataDir }); } catch (error) { lostKey = error; }
check("create: never for a database that already exists", lostKey && /already a database/.test(lostKey.message) && !fs.existsSync(autoFile));
let notAsked = null;
try { loadKey({ env: { DB_KEY_FILE: autoFile }, dataDir: freshData }); } catch (error) { notAsked = error; }
check("create: not unless DB_KEY_CREATE is true", notAsked && /Could not read/.test(notAsked.message) && !fs.existsSync(autoFile));

// --- changing the key ----------------------------------------------------------------------

const newKey = generateKey();
rekeyDatabase(file, key, newKey);
let oldRefused = null;
try { openDatabase({ dataDir, key }); } catch (error) { oldRefused = error; }
check("after rekey the old key no longer opens it", Boolean(oldRefused));
const reopened = openDatabase({ dataDir, key: newKey });
check("after rekey the new key opens it with the data intact", reopened.raw.prepare("SELECT count(*) AS n FROM people").get().n === 1);
reopened.close();

// The npm script, end to end.
const newKeyFile = path.join(tmp, "new_key");
fs.writeFileSync(newKeyFile, generateKey());
const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "rekey.js"), newKeyFile], { env: { ...process.env, DATA_DIR: dataDir, DB_KEY: newKey, DB_KEY_FILE: "" }, encoding: "utf8" });
check("npm run rekey succeeds", run.status === 0, run.stderr);
const afterScript = openDatabase({ dataDir, key: fs.readFileSync(newKeyFile, "utf8").trim() });
check("the script's new key opens the database", afterScript.raw.prepare("SELECT count(*) AS n FROM companies").get().n === 1);
afterScript.close();

const gen = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "new-key.js"), newKeyFile], { encoding: "utf8" });
check("npm run new-key refuses to overwrite an existing key file", gen.status !== 0);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(report() ? 0 : 1);
