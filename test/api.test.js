/**
 * The API for other systems (/api/v1) over HTTP: keys, sites, the fields each client
 * receives, incremental sync, and adding people and companies.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("API for other systems (/api/v1)");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_API_PORT) || 3986;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-api-"));

function staff() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body) {
    const h = {};
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      jar[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data };
  }
  return { get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b), put: (u, b = {}) => call("PUT", u, b), del: (u) => call("DELETE", u), jar };
}

/** An API caller with a key. */
function apiAs(key) {
  async function call(method, url, body) {
    const h = { authorization: `Bearer ${key}` };
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  return { get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b) };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/auth/me`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let server;
async function main() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitForServer())) {
    console.error(log);
    throw new Error("server did not start");
  }

  const admin = staff();
  await admin.post("/api/auth/setup", { username: "admin", password: crypto.randomBytes(12).toString("base64url"), siteName: "Harbour Point" });
  const harbour = (await admin.get("/api/config")).data.sites[0];
  const river = (await admin.post("/api/sites", { name: "Riverside" })).data.site;
  const acme = (await admin.post("/api/companies", { name: "Acme Corp", phone: "555-0100", notes: "Rent overdue", sites: [{ siteId: harbour.id, suite: "Suite 100" }] })).data.company;
  const both = (await admin.post("/api/companies", { name: "Both Partners", sites: [{ siteId: harbour.id, suite: "Floor 2" }, { siteId: river.id, suite: "Unit 9" }] })).data.company;
  const riverCo = (await admin.post("/api/companies", { name: "River Co", sites: [{ siteId: river.id }] })).data.company;
  await admin.post("/api/fields", { entity: "person", label: "Badge number", type: "text", visibility: "all" });
  await admin.post("/api/fields", { entity: "person", label: "Salary", type: "number", visibility: "admins" });
  const jane = (await admin.post("/api/people", { firstName: "Jane", lastName: "Doe", companyId: acme.id, email: "jane@acme.example", workPhone: "555-0101", mobile: "555-0199", notes: "VIP", custom: { badge_number: "B-1", salary: "90000" } })).data.person;
  const rae = (await admin.post("/api/people", { firstName: "Rae", lastName: "River", companyId: both.id, siteId: river.id })).data.person;
  const hal = (await admin.post("/api/people", { firstName: "Hal", lastName: "Harbour", companyId: both.id, siteId: harbour.id })).data.person;
  await admin.post("/api/people", { firstName: "Ron", lastName: "Rivers", companyId: riverCo.id });

  // --- keys --------------------------------------------------------------------------------------
  check("keys: no key, no answer", (await fetch(`${BASE}/api/v1/whoami`)).status === 401);
  check("keys: a made-up key is refused", (await apiAs("ivm_1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").get("/api/v1/whoami")).status === 401);
  check("keys: a staff session isn't an API key", (await fetch(`${BASE}/api/v1/whoami`, { headers: { cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join("; ") } })).status === 401);
  check("keys: only administrators manage API clients", (await staff().get("/api/api-clients")).status === 401);
  let r = await admin.post("/api/api-clients", { name: "Checkout Harbour", sites: [harbour.id], canWrite: false });
  check("keys: a client is added and its key shown once", r.status === 200 && /^ivm_\d+_[A-Za-z0-9_-]{40,}$/.test(r.data.key) && !JSON.stringify((await admin.get("/api/api-clients")).data).includes(r.data.key.replace(/^ivm_\d+_/, "")));
  const harbourClient = r.data.client;
  const reader = apiAs(r.data.key);
  check("keys: the client starts with the template's fields", JSON.stringify(harbourClient.fields.person) === JSON.stringify(["firstName", "lastName", "preferredName", "company", "jobTitle", "email", "workPhone", "active"]), JSON.stringify(harbourClient.fields));

  r = await reader.get("/api/v1/whoami");
  check("whoami: names the client, its sites and fields", r.status === 200 && r.data.client.name === "Checkout Harbour" && r.data.client.canWrite === false && r.data.sites.map((s) => s.name).join() === "Harbour Point" && r.data.fields.person.some((f) => f.key === "email"));

  // --- what a client sees --------------------------------------------------------------------------
  r = await reader.get("/api/v1/sync");
  const first = r.data;
  check("sync: only companies at its site", first.companies.map((c) => c.name).sort().join() === "Acme Corp,Both Partners");
  check("sync: a company's other sites are left out", first.companies.find((c) => c.name === "Both Partners").sites.map((s) => s.siteName).join() === "Harbour Point");
  check("sync: people at its site, or at any site, of those companies", first.people.map((p) => p.firstName).sort().join() === "Hal,Jane");
  const j = first.people.find((p) => p.firstName === "Jane");
  check("sync: the template's fields are there", j.email === "jane@acme.example" && j.workPhone === "555-0101" && j.companyName === "Acme Corp" && j.companyActive === true);
  check("sync: other fields aren't (mobile, notes, custom)", !("mobile" in j) && !("notes" in j) && Object.keys(j.custom).length === 0);
  check("sync: company notes aren't either", !("notes" in first.companies[0]));
  check("sync: the ids of everyone visible", JSON.stringify(first.personIds) === JSON.stringify([jane.id, hal.id].sort((a, b) => a - b)) && first.companyIds.length === 2);
  check("sync: never a visitor", !JSON.stringify(first).toLowerCase().includes("visitor"));
  check("people: one at another site can't be fetched", (await reader.get(`/api/v1/people/${rae.id}`)).status === 404);
  check("people: search works on what the client sees", (await reader.get("/api/v1/people?q=jane@acme")).data.people.length === 1 && (await reader.get("/api/v1/people?q=555-0199")).data.people.length === 0);

  // --- incremental sync ---------------------------------------------------------------------------------
  await new Promise((res) => setTimeout(res, 20));
  await admin.put(`/api/people/${jane.id}`, { jobTitle: "Director" });
  r = await reader.get(`/api/v1/sync?since=${first.serverTime}`);
  check("since: only what changed comes back, with the full list of ids", r.data.people.length === 1 && r.data.people[0].jobTitle === "Director" && r.data.companies.length === 0 && r.data.personIds.length === 2);
  const second = r.data;
  await new Promise((res) => setTimeout(res, 20));
  await admin.put(`/api/companies/${acme.id}`, { active: false });
  r = await reader.get(`/api/v1/sync?since=${second.serverTime}`);
  check("since: a company made inactive comes back, and so do its people (companyActive false)", r.data.companies.length === 1 && r.data.companies[0].active === false && r.data.people.length === 1 && r.data.people[0].companyActive === false);
  await admin.put(`/api/companies/${acme.id}`, { active: true });
  await admin.put(`/api/people/${hal.id}`, { siteId: river.id });
  r = await reader.get(`/api/v1/sync?since=${second.serverTime}`);
  check("since: someone moved to another site drops out of the ids", !r.data.personIds.includes(hal.id) && r.data.personIds.includes(jane.id));

  // --- fields per client --------------------------------------------------------------------------------
  r = await admin.put(`/api/api-clients/${harbourClient.id}`, { fields: { person: ["firstName", "lastName", "email", "mobile", "badge_number"], company: ["name", "phone"] } });
  check("fields: the checklist is saved, names kept whatever", r.status === 200 && r.data.client.fields.person.includes("mobile") && r.data.client.fields.person.includes("company") && !r.data.client.fields.person.includes("workPhone"));
  r = await reader.get(`/api/v1/sync?since=${second.serverTime}`);
  check("fields: a change of fields changes the version, so the client fetches everything again", r.data.fieldsVersion !== first.fieldsVersion);
  r = await reader.get("/api/v1/sync");
  const j2 = r.data.people.find((p) => p.firstName === "Jane");
  check("fields: the client now gets mobile and the badge number, not the work phone", j2.mobile === "555-0199" && j2.custom.badge_number === "B-1" && !("workPhone" in j2));
  check("fields: an administrators-only field can't be given... unless ticked on purpose", !("salary" in j2.custom));
  r = await admin.get("/api/field-access");
  check("fields: the client has its own column in the grid", r.data.roles.some((x) => x.name === "API: Checkout Harbour") && r.data.entities.person.find((f) => f.key === "mobile").access[harbourClient.roleId] === "view");

  // --- writing -------------------------------------------------------------------------------------------
  check("write: a read-only key can't add people", (await reader.post("/api/v1/people", { firstName: "X", lastName: "Y", companyId: acme.id })).status === 403);
  r = await admin.post("/api/api-clients", { name: "Checkout All", canWrite: true });
  const writer = apiAs(r.data.key);
  const writerClient = r.data.client;
  r = await writer.post("/api/v1/people", { firstName: "New", lastName: "Starter", companyId: acme.id, email: "new@acme.example", workPhone: "555-0150" });
  check("write: a writing key adds a person", r.status === 200 && r.data.matched === false && r.data.person.email === "new@acme.example");
  const newbie = r.data.person;
  r = await writer.post("/api/v1/people", { firstName: "new", lastName: "starter", companyId: acme.id, email: "NEW@acme.example", match: true });
  check("write: match finds the person already there instead of adding twice", r.data.matched === true && r.data.person.id === newbie.id);
  check("write: a field the client doesn't get can't be written", (await writer.post("/api/v1/people", { firstName: "A", lastName: "B", companyId: acme.id, notes: "x" })).status === 403);
  check("write: a custom field the client doesn't get isn't there", (await writer.post("/api/v1/people", { firstName: "A", lastName: "B", companyId: acme.id, custom: { salary: "1" } })).status === 400);
  r = await writer.post("/api/v1/companies", { name: "Gamma Ltd" });
  check("write: with more than one site, a company needs its site", r.status === 400);
  r = await writer.post("/api/v1/companies", { name: "Gamma Ltd", sites: [{ siteId: river.id, suite: "Unit 1" }] });
  check("write: a company is added at the given site", r.status === 200 && r.data.company.sites[0].siteName === "Riverside");
  r = await writer.post("/api/v1/companies", { name: "gamma ltd", match: true });
  check("write: and matched by name the next time", r.data.matched === true);
  r = await admin.get("/api/audit?action=person.add");
  check("write: changes are audited under the client's name", r.data.entries.some((e) => e.username === "api:Checkout All"));
  const harbourWriter = (await admin.post("/api/api-clients", { name: "Harbour Writer", sites: [harbour.id], canWrite: true })).data;
  r = await apiAs(harbourWriter.key).post("/api/v1/companies", { name: "Harbour Only Co" });
  check("write: a client with one site doesn't have to name it", r.status === 200 && r.data.company.sites[0].siteName === "Harbour Point");
  check("write: nor can it put a company elsewhere", (await apiAs(harbourWriter.key).post("/api/v1/companies", { name: "Elsewhere", sites: [{ siteId: river.id }] })).status === 403);
  r = await admin.put(`/api/api-clients/${writerClient.id}`, { canWrite: false });
  check("write: taking write away turns its editable fields read-only", r.data.client.canWrite === false && (await writer.post("/api/v1/people", { firstName: "C", lastName: "D", companyId: acme.id })).status === 403 && (await admin.get("/api/field-access")).data.entities.person.find((f) => f.key === "email").access[writerClient.roleId] === "view");

  // --- revoking -------------------------------------------------------------------------------------------
  r = await admin.post(`/api/api-clients/${harbourClient.id}/key`);
  check("revoke: a new key stops the old one at once", (await reader.get("/api/v1/whoami")).status === 401 && (await apiAs(r.data.key).get("/api/v1/whoami")).status === 200);
  check("revoke: an API client's role can't be removed from Roles", (await admin.del(`/api/roles/${harbourClient.roleId}`)).status === 400);
  check("revoke: removing the client removes its key and its column", (await admin.del(`/api/api-clients/${harbourClient.id}`)).status === 200 && (await apiAs(r.data.key).get("/api/v1/whoami")).status === 401 && !(await admin.get("/api/field-access")).data.roles.some((x) => x.id === harbourClient.roleId));
}

main()
  .then(() => report())
  .catch((error) => {
    console.error(error);
    return false;
  })
  .then(async (ok) => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await exited;
    }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
    process.exit(ok ? 0 : 1);
  });
