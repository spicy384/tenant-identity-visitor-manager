#!/usr/bin/env node
/**
 * Fills an empty data directory with demo data: two sites, a dozen companies, people,
 * a few custom fields and four accounts. For trying the app out; never run it against
 * real data (it refuses when accounts already exist).
 *
 *   DB_KEY_FILE=/path/key DATA_DIR=./data node scripts/seed-demo.js
 *
 * The demo passwords are written to DATA_DIR/demo-login.txt.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadKey } = require("../db-key");
const { openDatabase } = require("../db");
const { createFields } = require("../fields");
const { createAccess } = require("../access");
const { createSites } = require("../sites");
const { createDirectory } = require("../directory");
const { createClearance } = require("../clearance");
const { createBadges } = require("../badges");
const auth = require("../auth");

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const db = openDatabase({ dataDir, key: loadKey({ dataDir }).key });
if (db.readDoc("users", []).length) {
  console.error("This data directory already has accounts; the demo seed only fills an empty one.");
  process.exit(1);
}
const fields = createFields({ db });
const access = createAccess({ db, fields });
const sites = createSites({ db });
const directory = createDirectory({ db, fields });

const clearance = createClearance({ db });
const badges = createBadges({ db, clearance });
const [first] = sites.list();
const harbor = first ? sites.update(first.id, { name: "Harbor Point", kioskName: "Welcome to Harbor Point", welcome: "Please sign in at reception", endOfDay: "18:00", timeZone: "America/New_York" }) : sites.create({ name: "Harbor Point", timeZone: "America/New_York", endOfDay: "18:00" });
const riverside = sites.create({ name: "Riverside Center", timeZone: "America/New_York", endOfDay: "19:00", welcome: "Visitors check in here" });

function field(entity, label, type, visibility, extra = {}) {
  const def = fields.create({ entity, label, type, ...extra });
  access.initCustomField(def, visibility);
  return def;
}
field("person", "Parking space", "text", "all");
field("person", "Emergency contact", "longtext", "admins");
field("company", "Lease ends", "date", "editors");
field("company", "Tenant tier", "choice", "all", { choices: ["Standard", "Premier", "Anchor"] });

const companies = [
  ["Northwind Traders", [[harbor.id, "Suite 1200"]], "Premier"],
  ["Contoso Legal", [[harbor.id, "Suite 900"]], "Standard"],
  ["Fabrikam Design", [[harbor.id, "Floor 4"], [riverside.id, "Unit 12"]], "Anchor"],
  ["Tailspin Toys", [[riverside.id, "Unit 3"]], "Standard"],
  ["Woodgrove Bank", [[harbor.id, "Floors 10-11"]], "Anchor"],
  ["Adatum Health", [[riverside.id, "Unit 7"]], "Premier"],
  ["Litware Labs", [[riverside.id, "Unit 21"]], "Standard"],
  ["Proseware Consulting", [[harbor.id, "Suite 610"]], "Standard"]
];
const firstNames = ["Avery", "Jordan", "Priya", "Mateo", "Hannah", "Kwame", "Sofia", "Liam", "Mei", "Noah", "Amara", "Diego", "Elena", "Omar", "Grace", "Tariq"];
const lastNames = ["Patel", "Okafor", "Nguyen", "Garcia", "Kowalski", "Haddad", "Reyes", "Lindqvist", "Tanaka", "Murphy", "Adeyemi", "Schmidt"];
const titles = ["Office Manager", "Director", "Analyst", "Engineer", "Receptionist", "Partner", "Account Executive", "Designer", "Facilities Lead"];
let n = 0;
for (const [name, siteList, tier] of companies) {
  const slug = name.toLowerCase().split(" ")[0];
  const company = directory.createCompany({ name, phone: `555-01${String(n).padStart(2, "0")}`, email: `frontdesk@${slug}.example`, website: `${slug}.example`, sites: siteList.map(([siteId, suite]) => ({ siteId, suite })) });
  fields.writeValues(company.id, new Map([[fields.list("company").find((d) => d.key === "tenant_tier").id, tier]]));
  const count = 3 + (n % 4);
  for (let i = 0; i < count; i += 1) {
    const fn = firstNames[(n * 3 + i) % firstNames.length];
    const ln = lastNames[(n * 5 + i * 7) % lastNames.length];
    const siteId = siteList.length > 1 ? siteList[i % siteList.length][0] : null;
    const person = directory.createPerson({ firstName: fn, lastName: ln, companyId: company.id, siteId, jobTitle: titles[(n + i) % titles.length], email: `${fn}.${ln}@${slug}.example`.toLowerCase(), workPhone: `555-1${String(n).padStart(2, "0")}${i}`, canHost: i !== count - 1 });
    // Some validated clearances (only the Security role sets them, by validating).
    if (i === 0 && n % 3 === 0) clearance.validate({ kind: "person", id: person.id, levelId: clearance.levels()[2].id, granted: "2024-06-01", expires: "2029-06-01", by: "seed-demo" });
  }
  n += 1;
}

const pw = () => crypto.randomBytes(12).toString("base64url");
const accounts = [
  { username: "admin", role: "admin", sites: null, password: pw() },
  { username: "manager", role: "manager", sites: null, password: pw() },
  { username: "riverside-desk", role: "frontdesk", sites: [riverside.id], password: pw() },
  { username: "security", role: "security", sites: null, password: pw() }
];
db.writeDoc("users", accounts.map((a) => ({
  id: auth.randomToken(8), username: a.username, passwordHash: auth.hashPassword(a.password), role: a.role, sites: a.sites,
  totpSecret: null, mfaEnrolled: false, lastTotpCounter: 0, recoveryCodes: [], createdAt: Date.now(), lastLoginAt: null, failedAttempts: 0, lockedUntil: null
})));
// Building security, and a stock of badges.
directory.createCompany({ name: "Harbor Point Security", buildingStaff: true, phone: "555-0911", sites: [{ siteId: harbor.id, suite: "Lobby desk" }, { siteId: riverside.id, suite: "Security office" }] });
const cls = Object.fromEntries(clearance.classifications().map((c) => [c.name, c.id]));
const lvl = Object.fromEntries(clearance.levels().map((l) => [l.name, l.id]));
badges.createRange({ prefix: "P-", from: 1, to: 6, width: 3, type: "personnel", classificationId: cls.Cleared, clearanceLevelId: lvl.TS });
badges.createRange({ prefix: "T-", from: 1, to: 30, width: 4, type: "tenant", classificationId: cls.Uncleared });
badges.createRange({ prefix: "S-", from: 1, to: 6, width: 3, type: "tenant", classificationId: cls.Cleared, clearanceLevelId: lvl["TS//SCI"] });
badges.createRange({ prefix: "V-", from: 1, to: 20, width: 3, type: "visitor", classificationId: cls.Uncleared });
// Lent for the day to people who forgot theirs.
badges.createRange({ prefix: "TMP-", from: 1, to: 5, width: 2, type: "tenant", classificationId: cls.Uncleared, temporary: true });

db.audit({ username: "seed-demo", action: "demo.seed", detail: `${companies.length} companies, ${accounts.length} accounts` });
clearance.stop();
db.close();

const loginFile = path.join(dataDir, "demo-login.txt");
fs.writeFileSync(loginFile, `${accounts.map((a) => `${a.username} / ${a.password}  (${a.role}${a.sites ? ", Riverside only" : ""})`).join("\n")}\n`, { mode: 0o600 });
console.log(`Demo data written. Sign-ins are in ${loginFile}.`);
