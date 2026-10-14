#!/usr/bin/env node
/**
 * Changes the database key. Stop the app first.
 *
 *   DB_KEY_FILE=/old/key DATA_DIR=/data npm run rekey -- /new/key
 *
 * The current key comes from DB_KEY_FILE or DB_KEY as usual; the new one from the file
 * named on the command line (make it with "npm run new-key -- /new/key"). The script
 * checks the new key opens the database before it finishes. Then point DB_KEY_FILE at
 * the new key and start the app.
 */
const fs = require("fs");
const path = require("path");
const { loadKey, normaliseKey } = require("../db-key");
const { rekeyDatabase, DB_FILE } = require("../db");

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const file = path.join(dataDir, DB_FILE);
const newKeyFile = process.argv[2];

try {
  if (!newKeyFile) throw new Error("Name the file holding the new key: npm run rekey -- /path/to/new-key");
  if (!fs.existsSync(file)) throw new Error(`There is no database at ${file}. Set DATA_DIR.`);
  const { key: oldKey, source } = loadKey({ dataDir });
  const newKey = normaliseKey(fs.readFileSync(path.resolve(newKeyFile), "utf8"), path.resolve(newKeyFile));
  if (newKey === oldKey) throw new Error("The new key is the same as the current one.");
  rekeyDatabase(file, oldKey, newKey);
  console.log(`The database at ${file} now opens with the key in ${path.resolve(newKeyFile)} (it used the one from ${source}).`);
  console.log("Point DB_KEY_FILE at the new key before starting the app. Backups made before now still need the old key.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
