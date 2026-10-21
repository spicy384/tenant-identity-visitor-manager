// Runs every test file in sequence and reports a combined result.
const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  "db.test.js",
  "access.test.js",
  "visitors.test.js",
  "entra.test.js",
  "server.test.js",
  "kiosk.test.js",
  "api.test.js",
  "badges.test.js",
  "events.test.js",
  "clearance.test.js",
  "templates.test.js",
  "import.test.js",
  "bulk.test.js",
  "facilities.test.js"
];

let failed = 0;

for (const suite of SUITES) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: "inherit",
    cwd: path.join(__dirname, "..")
  });

  if (result.status !== 0) {
    failed += 1;
  }
}

console.log("\n" + "-".repeat(48));
if (failed === 0) {
  console.log(`All ${SUITES.length} suites passed.`);
  process.exit(0);
}

console.log(`${failed} of ${SUITES.length} suites FAILED.`);
process.exit(1);
