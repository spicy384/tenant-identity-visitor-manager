#!/usr/bin/env node
/**
 * Prints a new database key, or writes it to a file:
 *
 *   npm run new-key                     prints it
 *   npm run new-key -- /path/db_key     writes it (mode 600), refusing to overwrite
 *
 * Keep a copy in your password manager. Without it the database cannot be opened.
 */
const fs = require("fs");
const path = require("path");
const { generateKey } = require("../db-key");

const key = generateKey();
const target = process.argv[2];

if (!target) {
  console.log(key);
  process.exit(0);
}

const file = path.resolve(target);
if (fs.existsSync(file)) {
  console.error(`${file} already exists; not overwriting it. Losing a key in use loses the data.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
console.log(`Wrote a new database key to ${file}.`);
console.log("Store a copy in your password manager now: without it the data cannot be read.");
