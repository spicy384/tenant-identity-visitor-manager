/**
 * Leases, charges, invoices, payments and QuickBooks over HTTP: who may do what, rent from the
 * rates and fixed (part months, yearly increases), the price list and charges, a month's
 * invoices, adjusting and issuing them, payments, overdue and aging, voiding, the printable
 * invoice, CSV and IIF exports, and the QuickBooks Online connection against a fake QuickBooks.
 * Also a lease's commencement date, tenant badge allotments from desks (extra badges charged),
 * and certificates of insurance with their copies.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");

const { check, report } = createChecker("Leases, charges, invoices and QuickBooks");
const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_FINANCE_PORT) || 3990;
const QBO_PORT = Number(process.env.TEST_FINANCE_QBO_PORT) || 3978;
const BASE = `http://127.0.0.1:${PORT}`;
const QBO = `http://127.0.0.1:${QBO_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-finance-"));
const password = () => crypto.randomBytes(12).toString("base64url");

function client() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body, { raw = false, redirect = "follow" } = {}) {
    const h = {};
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data };
  }
  return {
    get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b), put: (u, b = {}) => call("PUT", u, b), del: (u) => call("DELETE", u),
    raw: (u, opts = {}) => call("GET", u, undefined, { raw: true, ...opts }),
    upload: async (u, bytes) => {
      const res = await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/octet-stream", ...(csrf ? { "x-csrf-token": csrf } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") }, body: bytes });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }
  };
}

async function waitFor(fn) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await fn()) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// --- a fake QuickBooks Online: OAuth tokens, the query endpoint, and making records ------------------------
const qb = { customers: [], items: [], accounts: [{ Id: "10", Name: "Rental Income" }, { Id: "11", Name: "Other Income" }], invoices: [], payments: [], revoked: [], tokenCalls: [], nextId: 100 };
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const u = new URL(req.url, QBO);
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/oauth/token") {
      const form = new URLSearchParams(raw);
      qb.tokenCalls.push({ grant: form.get("grant_type"), auth: req.headers.authorization, redirect: form.get("redirect_uri") });
      if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good-code") return send(400, { error: "invalid_grant" });
      const n = qb.tokenCalls.length;
      return send(200, { access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer" });
    }
    if (u.pathname === "/oauth/revoke") { qb.revoked.push(JSON.parse(raw || "{}").token); return send(200, {}); }
    const m = /^\/v3\/company\/(\w+)\/(.+)$/.exec(u.pathname);
    if (!m || m[1] !== "123") return send(404, { Fault: { Error: [{ Message: "No such company" }] } });
    if (!/^Bearer at\d+$/.test(req.headers.authorization || "")) return send(401, { Fault: { Error: [{ Message: "Unauthorized" }] } });
    const what = m[2];
    if (what === "companyinfo/123") return send(200, { CompanyInfo: { CompanyName: "Harbor Books" } });
    if (what === "query") {
      const sql = u.searchParams.get("query");
      const qm = /from (\w+) where ([\w.]+) (=|>) '((?:\\'|[^'])*)'/i.exec(sql);
      const value = qm[4].replace(/\\'/g, "'");
      const table = { Customer: qb.customers, Item: qb.items, Account: qb.accounts, Payment: qb.payments }[qm[1]];
      const field = qm[2];
      const rows = table.filter((r) => (qm[3] === "=" ? (r[field] === value) : (r.MetaData?.LastUpdatedTime > value)));
      return send(200, { QueryResponse: rows.length ? { [qm[1]]: rows } : {} });
    }
    if (req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      const record = { Id: String(qb.nextId++), ...body, MetaData: { LastUpdatedTime: new Date().toISOString() } };
      const key = { customer: "Customer", item: "Item", invoice: "Invoice", payment: "Payment" }[what];
      if (!key) return send(400, { Fault: { Error: [{ Message: `Can't make ${what}` }] } });
      ({ customer: qb.customers, item: qb.items, invoice: qb.invoices, payment: qb.payments })[what].push(record);
      return send(200, { [key]: record });
    }
    return send(404, {});
  });
});

let server;
async function main() {
  await new Promise((resolve) => fake.listen(QBO_PORT, "127.0.0.1", resolve));
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: {
      ...process.env, PORT: String(PORT), KIOSK_PORT: "", DATA_DIR, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", TZ: "UTC",
      QBO_AUTH_URL: `${QBO}/oauth/authorize`, QBO_TOKEN_URL: `${QBO}/oauth/token`, QBO_REVOKE_URL: `${QBO}/oauth/revoke`, QBO_API_BASE: QBO
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitFor(async () => (await fetch(`${BASE}/api/auth/me`)).ok))) {
    console.error(log);
    throw new Error("server did not start");
  }

  const admin = client();
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Harbor Point" });
  const harbor = (await admin.get("/api/config")).data.sites[0];
  await admin.put(`/api/sites/${harbor.id}`, { timeZone: "UTC" });
  const mk = async (name) => (await admin.post("/api/companies", { name, sites: [{ siteId: harbor.id }], address: "1 Main St\nHarbor City" })).data.company;
  const acme = await mk("Acme");
  const globex = await mk("Globex");
  const pw = { manny: password(), fiona: password(), desk: password(), vic: password() };
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "fiona", password: pw.fiona, role: "finance" });
  await admin.post("/api/users", { username: "desk", password: pw.desk, role: "frontdesk" });
  await admin.post("/api/users", { username: "vic", password: pw.vic, role: "viewer" });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const manager = await as("manny");
  const finance = await as("fiona");
  const desk = await as("desk");
  const viewer = await as("vic");

  // --- who reaches what ----------------------------------------------------------------------------------
  let r = await admin.get("/api/roles");
  const financeRole = r.data.roles.find((x) => x.id === "finance");
  check("roles: a built-in Finance role, finance edit and facilities read", financeRole && financeRole.finance === "edit" && financeRole.facilities === "read" && financeRole.builtIn);
  check("roles: managers read finance, administrators change it", r.data.roles.find((x) => x.id === "manager").finance === "read" && r.data.roles.find((x) => x.id === "admin").finance === "edit");
  check("access: front desk and viewers see none of it", (await desk.get("/api/leases")).status === 403 && (await desk.get("/api/invoices")).status === 403 && (await viewer.get("/api/charges")).status === 403);
  check("access: config says so", (await finance.get("/api/config")).data.access.finance === "edit" && (await manager.get("/api/config")).data.access.finance === "read");

  // --- offices and rates -------------------------------------------------------------------------------------
  const floor = (await manager.post("/api/floors", { siteId: harbor.id, name: "Level 2" })).data.floor;
  const office = async (name, sqft) => (await manager.post("/api/offices", { floorId: floor.id, name, sqft, x: 0.1, y: 0.1, w: 0.1, h: 0.1 })).data.office;
  const o201 = await office("201", 1000);
  const o202 = await office("202", 500);
  const o203 = await office("203", 400);
  await manager.put(`/api/facilities/site-rates/${harbor.id}`, { rate: 2 });

  // --- leases ------------------------------------------------------------------------------------------------
  const acmeLease = { companyId: acme.id, officeIds: [o201.id, o202.id], startDate: "2026-01-15", reference: "L-100", deposit: 6000, notes: "Five year term" };
  check("leases: Finance sees them but doesn't make them", (await finance.get("/api/leases")).status === 200 && (await finance.post("/api/leases", acmeLease)).status === 403);
  r = await manager.post("/api/leases", acmeLease);
  const lease = r.data.lease;
  check("leases: a manager makes one over two offices, rent from the rates", r.status === 200 && lease.offices.length === 2 && lease.rentMode === "rates" && lease.currentMonthly === 3000 && lease.sqft === 1500 && lease.deposit === 6000, JSON.stringify(r.data));
  check("leases: its offices are assigned to the company", (await manager.get(`/api/offices/${o201.id}`)).data.office.assignments[0].companyName === "Acme");
  check("leases: an office can't be in two at once", (await manager.post("/api/leases", { companyId: globex.id, officeIds: [o202.id], startDate: "2026-03-01" })).status === 409);
  check("leases: a fixed rent needs its amount", (await manager.post("/api/leases", { companyId: globex.id, rentMode: "fixed", startDate: "2026-03-01" })).status === 400);
  r = await manager.get(`/api/leases/${lease.id}/rent?period=2026-01`);
  check("rent: a part month is charged for its days", r.data.rent.amount === 1645.16 && r.data.rent.days === 17 && /17 of 31 days/.test(r.data.rent.description), JSON.stringify(r.data));
  check("rent: a whole month in full", (await manager.get(`/api/leases/${lease.id}/rent?period=2026-02`)).data.rent.amount === 3000);
  check("rent: nothing before it starts", (await manager.get(`/api/leases/${lease.id}/rent?period=2025-12`)).data.rent === null);
  r = await manager.post("/api/leases", { companyId: globex.id, rentMode: "fixed", monthlyRent: 1000, escalationPct: 3, startDate: "2025-03-01", endDate: "2026-06-30", reference: "G-7" });
  const globexLease = r.data.lease;
  check("leases: a fixed rent without offices", r.status === 200 && globexLease.offices.length === 0 && globexLease.status === "ended");
  check("rent: the yearly increase after each anniversary", (await manager.get(`/api/leases/${globexLease.id}/rent?period=2026-02`)).data.rent.amount === 1000
    && (await manager.get(`/api/leases/${globexLease.id}/rent?period=2026-04`)).data.rent.amount === 1030);
  r = await manager.post(`/api/offices/${o203.id}/assignments`, { companyId: globex.id, startDate: "2026-02-01", endDate: "2026-12-31" });
  check("leases: an office assigned from Rooms gets a lease of its own", r.status === 200 && (await manager.get(`/api/leases?companyId=${globex.id}`)).data.leases.length === 2);
  const roomLease = (await manager.get(`/api/leases?companyId=${globex.id}`)).data.leases.find((l) => l.rentMode === "rates");
  r = await manager.put(`/api/leases/${lease.id}`, { endDate: "2030-01-14" });
  check("leases: new dates go to its offices", r.data.lease.endDate === "2030-01-14" && (await manager.get(`/api/offices/${o202.id}`)).data.office.assignments[0].endDate === "2030-01-14");
  check("leases: searched by office", (await manager.get("/api/leases?q=202")).data.leases.map((l) => l.id).join() === String(lease.id));

  // --- the price list and charges -------------------------------------------------------------------------------
  r = await manager.post("/api/charge-items", { name: "After-hours HVAC", unit: "hour", rate: 75 });
  const hvac = r.data.item;
  check("price list: a manager adds an item", r.status === 200 && hvac.rate === 75 && hvac.unit === "hour");
  check("price list: names are unique", (await manager.post("/api/charge-items", { name: "after-hours hvac", rate: 1 })).status === 409);
  r = await manager.post("/api/charges", { companyId: acme.id, date: "2026-02-10", itemId: hvac.id, quantity: 2.5, notes: "Saturday" });
  const hvacCharge = r.data.charge;
  check("charges: from the price list, its rate and unit filled in", r.status === 200 && hvacCharge.amount === 187.5 && hvacCharge.unit === "hour" && hvacCharge.description === "After-hours HVAC");
  check("charges: one-off, by Finance too", (await finance.post("/api/charges", { companyId: globex.id, date: "2026-02-20", description: "Moving help", quantity: 3, rate: 40 })).data.charge?.amount === 120);
  await manager.post("/api/charges", { companyId: acme.id, date: "2026-03-05", description: "Key replacement", rate: 25 });
  check("charges: front desk can't log them", (await desk.post("/api/charges", { companyId: acme.id, date: "2026-02-10", description: "x", rate: 1 })).status === 403);
  check("charges: a used item is turned off rather than removed", (await manager.del(`/api/charge-items/${hvac.id}`)).status === 409);
  check("charges: listed unbilled, with their total", (await manager.get("/api/charges?status=unbilled")).data.amount === 332.5);

  // --- a month's invoices -------------------------------------------------------------------------------------------
  check("invoices: managers see them but don't make them", (await manager.get("/api/invoices")).status === 200 && (await manager.post("/api/invoices/generate", { period: "2026-02" })).status === 403);
  r = await finance.post("/api/invoices/generate", { period: "2026-02", issueDate: "2026-02-01" });
  const byName = (list, name) => list.find((i) => i.companyName === name);
  const acmeDraft = byName(r.data.invoices, "Acme");
  const globexDraft = byName(r.data.invoices, "Globex");
  check("generate: a draft for each company with rent or charges", r.status === 200 && r.data.invoices.length === 2 && acmeDraft.status === "draft" && !acmeDraft.number, JSON.stringify(r.data));
  check("generate: Acme's rent and its February charge (not March's)", acmeDraft.total === 3187.5 && acmeDraft.rentLines === 1 && acmeDraft.chargeLines === 1);
  check("generate: Globex's fixed rent, its office's part of the month, and its charge", globexDraft.total === 1000 + 800 + 120 && globexDraft.rentLines === 2, JSON.stringify(globexDraft));
  check("generate: due after the payment terms", acmeDraft.issueDate === "2026-02-01" && acmeDraft.dueDate === "2026-03-03");
  r = await finance.post("/api/invoices/generate", { period: "2026-02" });
  check("generate: again, nothing twice", r.data.invoices.length === 0);
  check("charges: billed ones can't be changed", (await manager.put(`/api/charges/${hvacCharge.id}`, { quantity: 3 })).status === 409);
  check("leases: one that has been invoiced can't be deleted", (await manager.del(`/api/leases/${lease.id}`)).status === 409);

  r = await finance.post(`/api/invoices/${acmeDraft.id}/lines`, { description: "Goodwill credit", rate: -87.5 });
  check("draft: a credit line", r.status === 200 && r.data.invoice.total === 3100);
  const hvacLine = r.data.invoice.lines.find((l) => l.chargeId === hvacCharge.id);
  r = await finance.del(`/api/invoices/${acmeDraft.id}/lines/${hvacLine.id}`);
  check("draft: a charge taken off goes back to unbilled", r.data.invoice.total === 2912.5 && (await manager.get(`/api/charges?status=unbilled`)).data.charges.some((c) => c.id === hvacCharge.id));
  r = await finance.post(`/api/invoices/${acmeDraft.id}/lines`, { chargeId: hvacCharge.id });
  check("draft: and put back", r.data.invoice.total === 3100);
  r = await finance.post(`/api/invoices/${acmeDraft.id}/issue`);
  const acmeInv = r.data.invoice;
  check("issue: the next number", r.status === 200 && acmeInv.number === "INV-1001" && acmeInv.status === "issued" && acmeInv.state === "overdue");
  check("issue: its lines are fixed now", (await finance.post(`/api/invoices/${acmeInv.id}/lines`, { description: "x", rate: 1 })).status === 409);
  const globexInv = (await finance.post(`/api/invoices/${globexDraft.id}/issue`)).data.invoice;
  check("issue: numbers in order", globexInv.number === "INV-1002");

  // --- payments ---------------------------------------------------------------------------------------------------------
  check("payments: only Finance records them", (await manager.post(`/api/invoices/${acmeInv.id}/payments`, { amount: 100, method: "Check" })).status === 403);
  r = await finance.post(`/api/invoices/${acmeInv.id}/payments`, { amount: 1000, method: "check", reference: "1042", date: "2026-02-15" });
  check("payments: part paid", r.status === 200 && r.data.invoice.balance === 2100 && r.data.invoice.paid === 1000 && r.data.payment.method === "Check");
  check("payments: not more than is owed", (await finance.post(`/api/invoices/${acmeInv.id}/payments`, { amount: 3000, method: "ACH" })).status === 400);
  r = await finance.post(`/api/invoices/${acmeInv.id}/payments`, { amount: 2100, method: "ACH", date: "2026-03-01" });
  check("payments: paid in full", r.data.invoice.state === "paid" && r.data.invoice.balance === 0);
  check("payments: none on a draft", (await finance.post(`/api/invoices/${(await finance.post("/api/invoices", { companyId: acme.id })).data.invoice.id}/payments`, { amount: 1, method: "Cash" })).status === 409);
  r = await manager.get("/api/finance/aging");
  check("aging: what Globex owes, past due", r.status === 200 && r.data.companies.length === 1 && r.data.companies[0].companyName === "Globex" && r.data.totals.total === 1920 && r.data.totals.current === 0, JSON.stringify(r.data));
  check("invoices: listed by state", (await manager.get("/api/invoices?state=overdue")).data.invoices.map((i) => i.number).join() === "INV-1002"
    && (await manager.get("/api/invoices?state=paid")).data.invoices.map((i) => i.number).join() === "INV-1001");

  // --- voiding ---------------------------------------------------------------------------------------------------------------
  check("void: not with payments on it", (await finance.post(`/api/invoices/${acmeInv.id}/void`)).status === 409);
  r = await finance.post(`/api/invoices/${globexInv.id}/void`);
  check("void: keeps its number", r.status === 200 && r.data.invoice.status === "void" && r.data.invoice.number === "INV-1002");
  r = await finance.post("/api/invoices/generate", { period: "2026-02", companyIds: [globex.id], issueDate: "2026-02-01" });
  check("void: its rent and charges can be invoiced again", r.data.invoices.length === 1 && r.data.invoices[0].total === 1920);
  const globexAgain = (await finance.post(`/api/invoices/${r.data.invoices[0].id}/issue`)).data.invoice;
  check("void: the new one gets the next number", globexAgain.number === "INV-1003");

  // --- the printable invoice and exports --------------------------------------------------------------------------------------
  await finance.put("/api/finance/settings", { issuerName: "Harbor Point Management", remitTo: "PO Box 9\nHarbor City", footer: "Thank you." });
  r = await manager.raw(`/api/invoices/${acmeInv.id}/print`);
  check("print: a page with the invoice, its lines and who to pay", r.status === 200 && /INV-1001/.test(r.text) && /Acme/.test(r.text) && /Goodwill credit/.test(r.text) && /PO Box 9/.test(r.text) && /Harbor Point Management/.test(r.text) && /1 Main St/.test(r.text));
  check("print: not for those who can't see invoices", (await desk.raw(`/api/invoices/${acmeInv.id}/print`)).status === 403);
  r = await manager.raw("/api/finance/export/invoices?format=csv");
  const csvLines = r.text.replace(/^﻿/, "").trim().split(/\r\n/);
  check("export: QuickBooks Online CSV, a row per line of each issued invoice", r.status === 200 && csvLines[0].startsWith("InvoiceNo,Customer,InvoiceDate,DueDate") && csvLines.length === 1 + 3 + 3 && csvLines.every((l, i) => i === 0 || /^INV-100[13],/.test(l)), r.text);
  r = await manager.raw("/api/finance/export/invoices?format=iif");
  check("export: QuickBooks Desktop IIF, customers, items and transactions", /^!CUST\tNAME/.test(r.text) && /\nTRNS\t\tINVOICE\t02\/01\/2026\tAccounts Receivable\tAcme\t3100.00\tINV-1001/.test(r.text) && (r.text.match(/\nENDTRNS/g) || []).length === 2, r.text);
  r = await manager.raw("/api/finance/export/payments?format=iif");
  check("export: payments as IIF", (r.text.match(/\nTRNS\t\tPAYMENT/g) || []).length === 2 && /Undeposited Funds/.test(r.text));
  check("export: in the audit log", (await admin.get("/api/audit?action=finance.export")).data.entries.length === 3);

  // --- QuickBooks Online ------------------------------------------------------------------------------------------------------
  check("quickbooks: for Finance and administrators only", (await manager.get("/api/quickbooks")).status === 403);
  r = await finance.put("/api/quickbooks", { environment: "sandbox", clientId: "client-1", clientSecret: "secret-1" });
  check("quickbooks: the app's id and secret, the secret never shown", r.status === 200 && r.data.quickbooks.configured && r.data.quickbooks.hasSecret && !JSON.stringify(r.data).includes("secret-1"));
  r = await finance.post("/api/quickbooks/connect");
  const authUrl = new URL(r.data.url);
  check("quickbooks: connecting goes to its sign-in, coming back here", authUrl.origin === QBO && authUrl.searchParams.get("client_id") === "client-1" && authUrl.searchParams.get("redirect_uri") === `${BASE}/api/quickbooks/callback` && authUrl.searchParams.get("state"));
  r = await finance.raw(`/api/quickbooks/callback?code=good-code&state=made-up&realmId=123`, { redirect: "manual" });
  check("quickbooks: a sign-in that didn't start here is refused", r.status === 302 && /qbo_error=/.test(r.headers.get("location")));
  r = await finance.raw(`/api/quickbooks/callback?code=good-code&state=${authUrl.searchParams.get("state")}&realmId=123`, { redirect: "manual" });
  check("quickbooks: back from signing in, connected", r.status === 302 && /qbo=connected/.test(r.headers.get("location")), r.headers.get("location"));
  r = await finance.get("/api/quickbooks");
  check("quickbooks: with its company's name", r.data.quickbooks.connected && r.data.quickbooks.companyName === "Harbor Books" && qb.tokenCalls[0].auth === `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`);
  r = await finance.post("/api/quickbooks/sync");
  check("sync: issued invoices and payments go, void ones don't", r.status === 200 && r.data.result.invoicesSent === 2 && r.data.result.paymentsSent === 2 && r.data.result.problems.length === 0, JSON.stringify(r.data));
  const sent = qb.invoices.find((i) => i.DocNumber === "INV-1001");
  check("sync: the invoice with its number, dates, customer and lines", sent && sent.TxnDate === "2026-02-01" && sent.Line.length === 3 && qb.customers.some((c) => c.DisplayName === "Acme" && c.Id === sent.CustomerRef.value));
  check("sync: items made against the income accounts", qb.items.find((i) => i.Name === "Rent")?.IncomeAccountRef.value === "10" && qb.items.find((i) => i.Name === "After-hours HVAC")?.IncomeAccountRef.value === "11");
  check("sync: payments linked to their invoice", qb.payments.length === 2 && qb.payments.every((p) => p.Line[0].LinkedTxn[0].TxnId === sent.Id));
  // A payment made in QuickBooks against Globex's invoice comes back.
  const globexQbo = qb.invoices.find((i) => i.DocNumber === "INV-1003");
  qb.payments.push({ Id: "900", TxnDate: "2026-03-10", TotalAmt: 500, PaymentRefNum: "W-55", PaymentMethodRef: { name: "Wire" }, Line: [{ Amount: 500, LinkedTxn: [{ TxnId: globexQbo.Id, TxnType: "Invoice" }] }], MetaData: { LastUpdatedTime: new Date(Date.now() + 1000).toISOString() } });
  r = await finance.post("/api/quickbooks/sync");
  const globexNow = (await finance.get(`/api/invoices/${globexAgain.id}`)).data.invoice;
  check("sync: a payment made in QuickBooks comes back", r.data.result.paymentsReceived === 1 && globexNow.paid === 500 && globexNow.payments[0].source === "quickbooks" && globexNow.payments[0].method === "Wire", JSON.stringify(r.data));
  r = await finance.post("/api/quickbooks/sync");
  check("sync: and only once", r.data.result.paymentsReceived === 0 && r.data.result.invoicesSent === 0 && r.data.result.paymentsSent === 0, JSON.stringify(r.data));
  check("sync: the access token is reused while it lasts", qb.tokenCalls.length === 1);
  r = await finance.post("/api/quickbooks/disconnect");
  check("quickbooks: disconnecting revokes and forgets the tokens", r.data.quickbooks.connected === false && qb.revoked.includes("rt1"));
  check("quickbooks: in the audit log", (await admin.get("/api/audit?action=quickbooks.connect")).data.entries.length === 1 && (await admin.get("/api/audit?action=quickbooks.sync")).data.entries.length === 3);

  // --- merging companies takes their leases and invoices along ----------------------------------------------------
  await admin.post("/api/companies/merge", { intoId: acme.id, fromIds: [globex.id] });
  check("merge: leases follow the company", (await manager.get(`/api/leases?companyId=${acme.id}`)).data.leases.length === 3 && roomLease.id);
  check("merge: issued invoices keep the name they were billed to", (await manager.get(`/api/invoices/${globexAgain.id}`)).data.invoice.companyName === "Globex");

  // --- a room let for a fixed amount, and a yearly increase on rent from the rates -----------------------------------
  const initech = await mk("Initech");
  const o204 = await office("204", 800);
  r = await manager.put(`/api/offices/${o204.id}`, { monthlyRent: 1500 });
  check("rooms: a fixed monthly rent wins over the rates", r.data.office.monthlyRent === 1500 && r.data.office.monthly === 1500 && r.data.office.rateSource === "monthly" && r.data.office.askingMonthly === 1500);
  const o205 = await office("205", 100);
  r = await manager.post("/api/leases", { companyId: initech.id, officeIds: [o204.id, o205.id], startDate: "2024-01-01", escalationPct: 5 });
  const initechLease = r.data.lease;
  check("leases: an office's fixed rent counts toward rent from the rates", r.status === 200 && initechLease.offices.find((o) => o.officeId === o204.id).monthly === 1500, JSON.stringify(r.data));
  check("rent: from the rates, as it was in the first year", (await manager.get(`/api/leases/${initechLease.id}/rent?period=2024-06`)).data.rent.amount === 1700);
  check("rent: and up by the yearly increase after each anniversary", (await manager.get(`/api/leases/${initechLease.id}/rent?period=2025-06`)).data.rent.amount === 1785
    && (await manager.get(`/api/leases/${initechLease.id}/rent?period=2026-01`)).data.rent.amount === 1874.25);
  r = await manager.put(`/api/offices/${o204.id}`, { monthlyRent: null });
  check("rooms: back to by the square foot", r.data.office.monthlyRent === null && r.data.office.baseMonthly === 1600 && r.data.office.rateSource === "site");

  // --- a commencement date apart from the start ----------------------------------------------------------------------
  const umbrella = await mk("Umbrella");
  const rentOf = async (id, period) => (await manager.get(`/api/leases/${id}/rent?period=${period}`)).data.rent.amount;
  r = await manager.post("/api/leases", { companyId: umbrella.id, rentMode: "fixed", monthlyRent: 2000, escalationPct: 10, startDate: "2024-01-01", commencementDate: "2024-04-01" });
  const umbrellaLease = r.data.lease;
  check("commencement: kept when it isn't the start", r.status === 200 && umbrellaLease.commencementDate === "2024-04-01" && umbrellaLease.startDate === "2024-01-01", JSON.stringify(r.data));
  check("commencement: rent is billed from the start all the same", await rentOf(umbrellaLease.id, "2024-01") === 2000);
  check("commencement: the yearly increase counts from it", await rentOf(umbrellaLease.id, "2025-02") === 2000 && await rentOf(umbrellaLease.id, "2025-04") === 2200);
  r = await manager.put(`/api/leases/${umbrellaLease.id}`, { commencementDate: "2024-01-01" });
  const moved = (await manager.put(`/api/leases/${umbrellaLease.id}`, { startDate: "2024-02-01" })).data.lease;
  check("commencement: the same as the start, it follows the start", r.data.lease.commencementDate === "2024-01-01" && moved.commencementDate === "2024-02-01");
  check("commencement: not after the end", (await manager.put(`/api/leases/${umbrellaLease.id}`, { endDate: "2024-12-31", commencementDate: "2025-01-15" })).status === 400);
  check("leases: one without a commencement date commences on its start", (await manager.get(`/api/leases/${initechLease.id}`)).data.lease.commencementDate === "2024-01-01");

  // --- a base rate on the lease, for one that began years ago ---------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const nowDate = new Date();
  const todayText = `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
  const passedSince = (start) => Number(todayText.slice(0, 4)) - Number(start.slice(0, 4)) - (todayText.slice(5) < start.slice(5) ? 1 : 0);
  const cents = (n) => Math.round(n * 100) / 100;
  const tenths = (n) => Math.round(n * 10000) / 10000;
  const stark = await mk("Stark");
  await manager.put(`/api/facilities/company-rates/${stark.id}`, { rate: 9 });
  const o401 = await office("401", 1000);
  const o402 = await office("402", 500);
  r = await manager.post("/api/leases", { companyId: stark.id, officeIds: [o401.id, o402.id], startDate: "2020-12-01", classRates: { 0: 3 }, escalationPct: 2.75 });
  const stark1 = r.data.lease;
  const years = passedSince("2020-12-01");
  const k = 1.0275 ** years;
  // As finance's tracker works it: ROUND(rent * (1 + %), 2), year after year, in whole cents.
  const chain = (amount, pct, n) => { let c = Math.round(amount * 100); for (let i = 0; i < n; i += 1) c = Math.floor((c * (10000 + Math.round(pct * 100)) + 5000) / 10000); return c / 100; };
  const starkRent = (n) => cents(chain(3000, 2.75, n) + chain(1500, 2.75, n));
  check("lease rate: kept on the lease", r.status === 200 && stark1.classRates.length === 1 && stark1.classRates[0].rate === 3 && stark1.classRates[0].name === "Unclassified", JSON.stringify(r.data));
  check("lease rate: wins over the company's rate", stark1.offices.every((o) => o.rate === 3 && o.rateSource === "lease"));
  check("lease rate: first year as entered", await rentOf(stark1.id, "2020-12") === 4500 && await rentOf(stark1.id, "2021-11") === 4500);
  check("lease rate: up on each anniversary", await rentOf(stark1.id, "2021-12") === 4623.75 && await rentOf(stark1.id, "2026-11") === starkRent(5) && await rentOf(stark1.id, "2026-12") === starkRent(6));
  check("lease rate: the lease shows today's rent and rate", stark1.increases === years && stark1.currentMonthly === starkRent(years) && stark1.currentYearly === cents(starkRent(years) * 12) && stark1.currentRate === tenths(3 * k), JSON.stringify([stark1.increases, stark1.currentMonthly, stark1.currentRate]));
  check("lease rate: each office has its rent now", stark1.offices.find((o) => o.officeId === o401.id).currentMonthly === chain(3000, 2.75, years) && stark1.offices.find((o) => o.officeId === o401.id).currentYearly === cents(chain(3000, 2.75, years) * 12) && stark1.offices.find((o) => o.officeId === o401.id).monthly === 3000);
  const yearNow = stark1.schedule.find((y) => y.when === "now");
  const yearNext = stark1.schedule.find((y) => y.when === "next");
  check("schedule: from its first year", stark1.schedule[0].from === "2020-12-01" && stark1.schedule[0].monthly === 4500 && stark1.schedule[0].yearly === 54000 && stark1.schedule[0].rate === 3 && stark1.schedule[1].monthly === 4623.75 && stark1.schedule[1].yearly === 55485);
  check("schedule: this year matches today's rent", yearNow.monthly === stark1.currentMonthly && yearNow.rate === stark1.currentRate && yearNow.increases === years);
  check("schedule: and ends with the next one", stark1.schedule.at(-1) === yearNext && yearNext.increases === years + 1 && yearNext.from === `${2020 + years + 1}-12-01`);
  let seen = (await manager.get(`/api/offices/${o401.id}`)).data.office;
  check("rooms: an office shows what its lease charges now", seen.monthly === chain(3000, 2.75, years) && seen.effectiveRate === tenths(3 * k) && seen.baseRate === 3 && seen.baseMonthly === 3000 && seen.rateSource === "lease", JSON.stringify(seen));
  check("rooms: in the list too", (await manager.get(`/api/offices?companyId=${stark.id}`)).data.offices.find((o) => o.id === o401.id).monthly === chain(3000, 2.75, years));
  const starkPage = (await manager.get(`/api/companies/${stark.id}/facilities`)).data;
  check("company page: its offices and total at today's rent", starkPage.offices.find((o) => o.officeId === o401.id).monthly === chain(3000, 2.75, years) && starkPage.offices.find((o) => o.officeId === o401.id).baseRate === 3 && starkPage.totals.monthly === starkRent(years), JSON.stringify(starkPage.totals));
  check("lease rate: a bad one is refused", (await manager.put(`/api/leases/${stark1.id}`, { classRates: { 0: -1 } })).status === 400);
  check("lease rate: four decimal places, as a yearly rate over twelve needs", (await manager.put(`/api/leases/${stark1.id}`, { classRates: { 0: 3.20833 } })).data.lease.classRates[0].rate === 3.2083);
  const assignmentOf = async (officeId) => (await manager.get(`/api/offices/${officeId}`)).data.office.assignments[0].id;
  r = await manager.put(`/api/office-assignments/${await assignmentOf(o402.id)}`, { startDate: "2021-02-01" });
  check("leaving a lease: the office keeps its base rate and increase", r.status === 200, JSON.stringify(r.data));
  const split = (await manager.get(`/api/leases?companyId=${stark.id}`)).data.leases.find((l) => l.id !== stark1.id);
  check("leaving a lease: counted from the same day", split.classRates[0].rate === 3.2083 && split.escalationPct === 2.75 && split.commencementDate === "2020-12-01" && split.startDate === "2021-02-01" && split.increases === years, JSON.stringify(split));
  await manager.put(`/api/leases/${stark1.id}`, { classRates: {} });
  check("lease rate: empty goes back to the rates", (await manager.get(`/api/leases/${stark1.id}`)).data.lease.offices[0].rate === 9 && (await manager.get(`/api/leases/${stark1.id}`)).data.lease.offices[0].rateSource === "company");
  const o403 = await office("403", 100);
  await manager.put(`/api/offices/${o403.id}`, { monthlyRent: 700 });
  r = await manager.post("/api/leases", { companyId: stark.id, officeIds: [o403.id], startDate: "2024-01-01", classRates: { 0: 3 }, escalationPct: 10 });
  const fixedYears = passedSince("2024-01-01");
  check("lease rate: an office let for a fixed amount keeps it, with the increases", r.data.lease.offices[0].monthly === 700 && r.data.lease.currentMonthly === chain(700, 10, fixedYears) && (await manager.get(`/api/offices/${o403.id}`)).data.office.monthly === chain(700, 10, fixedYears));
  const wayne = await mk("Wayne");
  const o404 = await office("404", 300);
  const o405 = await office("405", 100);
  r = await manager.post("/api/leases", { companyId: wayne.id, rentMode: "fixed", monthlyRent: 10000, classRates: { 0: 5 }, escalationPct: 2.75, officeIds: [o404.id, o405.id], startDate: "2020-12-01" });
  check("fixed rent: has no base rate, and is the sum of the example", r.data.lease.classRates.length === 0 && r.data.lease.currentMonthly === chain(10000, 2.75, years), JSON.stringify(r.data.lease));
  check("fixed rent: no one rate", r.data.lease.currentRate === null && r.data.lease.schedule[0].rate === null);
  seen = (await manager.get(`/api/offices/${o404.id}`)).data.office;
  check("fixed rent: an office shows its share, by size", seen.rateSource === "fixedLease" && seen.effectiveRate === null && seen.monthly === cents(chain(10000, 2.75, years) * 0.75), JSON.stringify(seen));
  r = await manager.post("/api/leases", { companyId: wayne.id, rentMode: "fixed", monthlyRent: 1000, escalationPct: 10, startDate: "2020-01-01", endDate: "2022-06-30" });
  check("ended: its rent stays as it last was, and the schedule stops there", r.data.lease.currentMonthly === 1210 && r.data.lease.increases === 2 && r.data.lease.schedule.length === 3 && r.data.lease.schedule.at(-1).when === "now", JSON.stringify(r.data.lease));
  r = await manager.post("/api/leases", { companyId: wayne.id, rentMode: "fixed", monthlyRent: 1000, startDate: "2020-01-01" });
  check("no yearly increase: no schedule", r.data.lease.schedule.length === 0 && r.data.lease.currentMonthly === 1000);

  // --- agreeing with finance's tracker to the cent ------------------------------------------------------------------
  const tracker = await mk("Tracker Co");
  r = await manager.post("/api/leases", { companyId: tracker.id, rentMode: "fixed", monthlyRent: 4500, escalationPct: 2.75, startDate: "2020-12-01" });
  const trackerLease = r.data.lease;
  check("tracker: rounds every year, not once", await rentOf(trackerLease.id, "2024-12") === 5015.79 && await rentOf(trackerLease.id, "2025-12") === 5153.72 && await rentOf(trackerLease.id, "2026-12") === 5295.45);
  check("tracker: the year is twelve times the month", trackerLease.schedule[5].monthly === 5153.72 && trackerLease.schedule[5].yearly === 61844.64, JSON.stringify(trackerLease.schedule[5]));
  r = await manager.post("/api/leases", { companyId: tracker.id, rentMode: "fixed", monthlyRent: 34, escalationPct: 3.25, startDate: "2021-01-01" });
  check("tracker: half a cent rounds up", await rentOf(r.data.lease.id, "2022-02") === 35.11, JSON.stringify(r.data.lease.schedule));
  const o406 = await office("406", 100);
  const o407 = await office("407", 100);
  for (const room of [o406, o407]) await manager.put(`/api/offices/${room.id}`, { monthlyRent: 100.2 });
  r = await manager.post("/api/leases", { companyId: tracker.id, officeIds: [o406.id, o407.id], escalationPct: 2.75, startDate: "2021-01-01" });
  const twoRooms = r.data.lease;
  check("tracker: each room is rounded, then added", await rentOf(twoRooms.id, "2022-02") === 205.92 && twoRooms.schedule[1].monthly === 205.92 && twoRooms.schedule[1].yearly === 2471.04, JSON.stringify(twoRooms.schedule[1]));
  check("tracker: the rooms' rents add up to the lease's", cents(twoRooms.offices.reduce((n, o) => n + o.currentMonthly, 0)) === twoRooms.currentMonthly);

  // --- each room's rent at the start of the lease --------------------------------------------------------------------
  const rooms = await mk("Room Rates Co");
  const o408 = await office("408", 1000);
  const o409 = await office("409", 500);
  const o410 = await office("410", 100);
  const o411 = await office("411", 100);
  await manager.put(`/api/offices/${o411.id}`, { monthlyRent: 900 });
  r = await manager.post("/api/leases", { companyId: rooms.id, officeIds: [o408.id, o409.id, o410.id, o411.id], officeRents: [{ officeId: o408.id, rate: 3 }, { officeId: o409.id, monthly: 1717.91 }, { officeId: o411.id, rate: 4 }], classRates: { 0: 2 }, escalationPct: 2.75, startDate: "2020-12-01" });
  const perRoomLease = r.data.lease;
  const onLease = (lease, room) => lease.offices.find((o) => o.officeId === room.id);
  check("room rents: a rate per square foot", r.status === 200 && onLease(perRoomLease, o408).rate === 3 && onLease(perRoomLease, o408).monthly === 3000 && onLease(perRoomLease, o408).rateSource === "leaseRoom" && onLease(perRoomLease, o408).ownRate === 3, JSON.stringify(r.data));
  check("room rents: or a monthly amount, the rate worked out from it", onLease(perRoomLease, o409).monthly === 1717.91 && onLease(perRoomLease, o409).rate === tenths(1717.91 / 500) && onLease(perRoomLease, o409).ownMonthly === 1717.91 && onLease(perRoomLease, o409).ownRate === null);
  check("room rents: an office without one takes the lease's base rate", onLease(perRoomLease, o410).rate === 2 && onLease(perRoomLease, o410).monthly === 200 && onLease(perRoomLease, o410).rateSource === "lease");
  check("room rents: win over an office's fixed amount", onLease(perRoomLease, o411).monthly === 400);
  const roomRent = (n) => cents(chain(3000, 2.75, n) + chain(1717.91, 2.75, n) + chain(200, 2.75, n) + chain(400, 2.75, n));
  check("room rents: entered as at the start, the first invoice is as entered", await rentOf(perRoomLease.id, "2020-12") === 5317.91);
  check("room rents: the increases go on top, room by room", await rentOf(perRoomLease.id, "2021-12") === roomRent(1) && await rentOf(perRoomLease.id, "2026-12") === roomRent(6) && perRoomLease.currentMonthly === roomRent(years));
  seen = (await manager.get(`/api/offices/${o408.id}`)).data.office;
  check("room rents: Rooms shows them with the increases", seen.monthly === chain(3000, 2.75, years) && seen.baseRate === 3 && seen.effectiveRate === tenths(3 * k) && seen.rateSource === "leaseRoom", JSON.stringify(seen));
  check("room rents: the company page's total agrees", (await manager.get(`/api/companies/${rooms.id}/facilities`)).data.totals.monthly === roomRent(years));
  check("room rents: a bad one is refused", (await manager.put(`/api/leases/${perRoomLease.id}`, { officeRents: [{ officeId: o408.id, rate: -1 }] })).status === 400);
  check("room rents: a list that isn't one is refused", (await manager.put(`/api/leases/${perRoomLease.id}`, { officeRents: "3" })).status === 400);
  r = await manager.put(`/api/leases/${perRoomLease.id}`, { notes: "Nothing about rents" });
  check("room rents: stay when a change leaves them out", onLease(r.data.lease, o408).ownRate === 3);
  r = await manager.put(`/api/office-assignments/${await assignmentOf(o408.id)}`, { startDate: "2021-03-01" });
  const leftRoom = (await manager.get(`/api/leases?companyId=${rooms.id}`)).data.leases.find((l) => l.id !== perRoomLease.id);
  check("room rents: an office leaving the lease keeps its own", r.status === 200 && onLease(leftRoom, o408).ownRate === 3 && leftRoom.commencementDate === "2020-12-01", JSON.stringify(leftRoom));
  r = await manager.put(`/api/leases/${perRoomLease.id}`, { officeRents: [{ officeId: o409.id, rate: 5 }] });
  check("room rents: a new list replaces the old", onLease(r.data.lease, o409).ownRate === 5 && onLease(r.data.lease, o409).ownMonthly === null && onLease(r.data.lease, o411).ownRate === null);
  r = await manager.put(`/api/leases/${perRoomLease.id}`, { rentMode: "fixed", monthlyRent: 1000 });
  check("room rents: none on a fixed rent", r.data.lease.offices.every((o) => o.ownRate === null && o.ownMonthly === null) && r.data.lease.currentMonthly === chain(1000, 2.75, years));

  // --- a lease's rates by classification, and a custom rate on a room ----------------------------------------------------
  const kinds = (await manager.get("/api/facilities/room-kinds")).data;
  const classIdOf = (name) => kinds.classes.find((c) => c.name === name).id;
  const scifKey = classIdOf("SCIF");
  const scarKey = classIdOf("SCAR");
  const classCo = await mk("Classified Co");
  await manager.put(`/api/facilities/company-rates/${classCo.id}`, { rates: { [scarKey]: 11 } });
  const classedOffice = async (name, sqft, classId) => (await manager.put(`/api/offices/${(await office(name, sqft)).id}`, { classId })).data.office;
  const plainRoom = await office("414", 1000);
  const scifRoom = await classedOffice("415", 500, scifKey);
  const scarRoom = await classedOffice("416", 100, scarKey);
  const customRoom = await classedOffice("417", 200, scifKey);
  r = await manager.post("/api/leases", { companyId: classCo.id, officeIds: [plainRoom.id, scifRoom.id, scarRoom.id, customRoom.id], classRates: { 0: 3, [scifKey]: 7 }, officeRents: [{ officeId: customRoom.id, rate: 9 }], escalationPct: 2.75, startDate: "2020-12-01" });
  const classLease = r.data.lease;
  const roomOn = (lease, room) => lease.offices.find((o) => o.officeId === room.id);
  check("class rates: kept on the lease, by name", r.status === 200 && classLease.classRates.map((c) => `${c.name} ${c.rate}`).join() === `Unclassified 3,${kinds.classes.find((c) => c.id === scifKey).name} 7`, JSON.stringify(r.data));
  check("class rates: each room goes by its classification", roomOn(classLease, plainRoom).rate === 3 && roomOn(classLease, plainRoom).rateSource === "lease" && roomOn(classLease, scifRoom).rate === 7 && roomOn(classLease, scifRoom).monthly === 3500 && roomOn(classLease, scifRoom).className === "SCIF");
  check("class rates: a classification without one goes by the usual rates", roomOn(classLease, scarRoom).rate === 11 && roomOn(classLease, scarRoom).rateSource === "company");
  check("class rates: a custom rate wins, in that room alone", roomOn(classLease, customRoom).rate === 9 && roomOn(classLease, customRoom).rateSource === "leaseRoom" && roomOn(classLease, customRoom).ownRate === 9);
  const classRent = (n) => cents(chain(3000, 2.75, n) + chain(3500, 2.75, n) + chain(1100, 2.75, n) + chain(1800, 2.75, n));
  check("class rates: the first invoice as entered, then each room rounded and raised", await rentOf(classLease.id, "2020-12") === 9400 && await rentOf(classLease.id, "2021-12") === classRent(1) && await rentOf(classLease.id, "2026-12") === classRent(6));
  check("class rates: no one rate for the lease with several", classLease.currentRate === null);
  seen = (await manager.get(`/api/offices/${scifRoom.id}`)).data.office;
  check("class rates: Rooms shows the room's with the increases", seen.baseRate === 7 && seen.rateSource === "lease" && seen.monthly === chain(3500, 2.75, years));
  check("class rates: not a classification that doesn't exist", (await manager.put(`/api/leases/${classLease.id}`, { classRates: { 987654: 3 } })).status === 400);
  check("class rates: must be by classification", (await manager.put(`/api/leases/${classLease.id}`, { classRates: 3 })).status === 400 && (await manager.put(`/api/leases/${classLease.id}`, { classRates: [3] })).status === 400);
  r = await manager.put(`/api/leases/${classLease.id}`, { notes: "Nothing about rates" });
  check("class rates: stay when a change leaves them out", r.data.lease.classRates.length === 2);
  r = await manager.put(`/api/leases/${classLease.id}`, { classRates: { [scifKey]: 8, 0: "" } });
  check("class rates: a new set replaces the old, empty clearing one", r.data.lease.classRates.length === 1 && r.data.lease.classRates[0].rate === 8 && roomOn(r.data.lease, scifRoom).rate === 8);
  r = await manager.put(`/api/leases/${classLease.id}`, { officeRents: [] });
  check("class rates: a room no longer custom goes back to its classification's", roomOn(r.data.lease, customRoom).rate === 8 && roomOn(r.data.lease, customRoom).rateSource === "lease" && roomOn(r.data.lease, customRoom).ownRate === null);
  r = await manager.put(`/api/leases/${classLease.id}`, { rentMode: "fixed", monthlyRent: 5000 });
  check("class rates: none on a fixed rent", r.data.lease.classRates.length === 0);

  // --- a lease's documents ---------------------------------------------------------------------------------------------
  const pdfBytes = Buffer.from("%PDF-1.4 a made-up lease");
  const docsLease = (await manager.post("/api/leases", { companyId: tracker.id, rentMode: "fixed", monthlyRent: 100, startDate: "2022-01-01" })).data.lease;
  const docUrl = (name, kind = "agreement", extra = "") => `/api/leases/${docsLease.id}/documents?name=${encodeURIComponent(name)}&kind=${kind}${extra}`;
  r = await manager.upload(docUrl("Lease agreement.pdf", "agreement", "&description=Signed"), pdfBytes);
  const agreementDoc = r.data.document;
  check("documents: a manager adds the agreement", r.status === 200 && agreementDoc.name === "Lease agreement.pdf" && agreementDoc.kind === "agreement" && agreementDoc.description === "Signed" && agreementDoc.size === pdfBytes.length && !agreementDoc.data, JSON.stringify(r.data));
  check("documents: on the lease, without its contents", (await manager.get(`/api/leases/${docsLease.id}`)).data.lease.documents.length === 1 && !("data" in (await manager.get(`/api/leases/${docsLease.id}`)).data.lease.documents[0]));
  r = await finance.raw(`/api/lease-documents/${agreementDoc.ref}`);
  check("documents: whoever sees the lease opens it, in the browser", r.status === 200 && r.text === pdfBytes.toString() && r.headers.get("content-type") === "application/pdf" && /^inline/.test(r.headers.get("content-disposition")) && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("cache-control") === "private, no-store");
  check("documents: not those who can't see leases", (await desk.raw(`/api/lease-documents/${agreementDoc.ref}`)).status === 403);
  check("documents: only those who change leases add them", (await finance.upload(docUrl("x.pdf"), pdfBytes)).status === 403 && (await desk.upload(docUrl("x.pdf"), pdfBytes)).status === 403);
  check("documents: only they remove them", (await finance.del(`/api/lease-documents/${agreementDoc.id}`)).status === 403);
  check("documents: an unknown address finds nothing", (await manager.raw("/api/lease-documents/nothing-here")).status === 404);
  check("documents: an unknown lease", (await manager.upload("/api/leases/999999/documents?name=x.pdf&kind=agreement", pdfBytes)).status === 404);
  r = await manager.upload(docUrl("notes.txt"), Buffer.from("just some words"));
  check("documents: other kinds of file are refused", r.status === 400 && /PDF/.test(r.data.error), JSON.stringify(r.data));
  check("documents: judged by contents, not the name", (await manager.upload(docUrl("looks-right.pdf"), Buffer.from("<script>alert(1)</script>"))).status === 400);
  check("documents: nor a zip called a Word file", (await manager.upload(docUrl("fake.docx"), Buffer.from("PK\u0003\u0004 nothing of Word's in here"))).status === 400);
  check("documents: an empty one is refused", (await manager.upload(docUrl("empty.pdf"), Buffer.alloc(0))).status === 400);
  check("documents: it must say what it is", (await manager.upload(docUrl("x.pdf", "lunch"), pdfBytes)).status === 400);
  const wordBytes = Buffer.from("PK\u0003\u0004 ... word/document.xml ...");
  r = await manager.upload(docUrl("Amendment 1.docx", "amendment"), wordBytes);
  const amendmentDoc = r.data.document;
  check("documents: a Word file is taken", r.status === 200 && amendmentDoc.kind === "amendment", JSON.stringify(r.data));
  r = await finance.raw(`/api/lease-documents/${amendmentDoc.ref}`);
  check("documents: and saved rather than shown", r.status === 200 && /^attachment/.test(r.headers.get("content-disposition")));
  const bigBytes = Buffer.alloc(25 * 1024 * 1024 + 1);
  bigBytes.write("%PDF-1.4");
  check("documents: past 25 MB is refused", (await manager.upload(docUrl("big.pdf"), bigBytes)).status === 413);
  r = await manager.upload(docUrl("../..\\Scan<1>.pdf", "supporting"), pdfBytes);
  check("documents: a name loses any folders and odd characters", r.data.document.name === "Scan1.pdf", JSON.stringify(r.data));
  const scanDoc = r.data.document;
  check("documents: the agreement first, then amendments, then the rest", (await manager.get(`/api/leases/${docsLease.id}`)).data.lease.documents.map((d) => d.kind).join() === "agreement,amendment,supporting");
  r = await manager.del(`/api/lease-documents/${scanDoc.id}`);
  check("documents: removed, its file goes too", r.status === 200 && (await manager.raw(`/api/lease-documents/${scanDoc.ref}`)).status === 404 && (await manager.get(`/api/leases/${docsLease.id}`)).data.lease.documents.length === 2);
  r = await manager.del(`/api/leases/${docsLease.id}`);
  check("documents: go with the lease when it is deleted", r.status === 200 && (await manager.raw(`/api/lease-documents/${agreementDoc.ref}`)).status === 404 && (await manager.raw(`/api/lease-documents/${amendmentDoc.ref}`)).status === 404, JSON.stringify(r.data));
  const o412 = await office("412", 100);
  const keptLease = (await manager.post("/api/leases", { companyId: tracker.id, officeIds: [o412.id], startDate: "2022-01-01" })).data.lease;
  const keptDoc = (await manager.upload(`/api/leases/${keptLease.id}/documents?name=kept.pdf&kind=agreement`, pdfBytes)).data.document;
  await manager.del(`/api/office-assignments/${await assignmentOf(o412.id)}`);
  check("documents: a lease losing its last office stays, with them", (await manager.get(`/api/leases/${keptLease.id}`)).status === 200 && (await manager.raw(`/api/lease-documents/${keptDoc.ref}`)).status === 200);
  const docAudit = (await admin.get("/api/audit?action=lease.document&limit=100")).data.entries;
  check("documents: each add and removal is in the audit log, by name", docAudit.some((e) => e.action === "lease.document_add" && /Lease agreement.pdf/.test(e.detail)) && docAudit.some((e) => e.action === "lease.document_remove" && /Scan1.pdf/.test(e.detail)), JSON.stringify(docAudit.slice(0, 3)));

  // --- tenant badge allotments ---------------------------------------------------------------------------------------
  const hooli = await mk("Hooli");
  const o301 = await office("301", 300);
  const o302 = await office("302", 200);
  const o303 = await office("303", 200);
  r = await manager.put(`/api/offices/${o301.id}`, { desks: 4 });
  check("desks: set on an office", r.data.office.desks === 4);
  check("desks: whole numbers only", (await manager.put(`/api/offices/${o302.id}`, { desks: 2.5 })).status === 400);
  await manager.put(`/api/offices/${o302.id}`, { desks: 3 });
  await manager.put(`/api/offices/${o303.id}`, { desks: 4 });
  const allotment = async () => (await desk.get(`/api/companies/${hooli.id}/badge-allotment`)).data.allotment;
  let a = await allotment();
  check("allotment: not counted while the company has no desks", a.counted === false && a.allowed === 0);
  const hooliLease = (await manager.post("/api/leases", { companyId: hooli.id, officeIds: [o301.id, o302.id], startDate: "2026-01-01" })).data.lease;
  a = await allotment();
  check("allotment: a badge for each desk in its offices", a.counted && a.allowed === 7 && a.desks === 7 && a.held === 0, JSON.stringify(a));
  check("allotment: the company's offices total their desks", (await manager.get(`/api/companies/${hooli.id}/facilities`)).data.totals.desks === 7);
  const staff = [];
  const stock = [];
  for (let i = 0; i < 9; i += 1) {
    staff.push((await admin.post("/api/people", { firstName: `Pat${i}`, lastName: "Hooli", companyId: hooli.id })).data.person);
    stock.push((await admin.post("/api/badges", { number: `T-${100 + i}`, type: "tenant" })).data.badge);
  }
  const give = (i, holder, extra = {}) => desk.post(`/api/badges/${stock[i].id}/assign`, { kind: "person", holderId: staff[holder].id, ...extra });
  let given = 0;
  for (let i = 0; i < 7; i += 1) if ((await give(i, i)).status === 200) given += 1;
  check("allotment: its seven badges given without a word", given === 7);
  r = await give(7, 7);
  check("allotment: the eighth is refused until the charge is agreed", r.status === 409 && r.data.code === "badge_allotment" && r.data.allotment.price === 20 && r.data.allotment.allowed === 7, JSON.stringify(r.data));
  r = await give(7, 7, { chargeExtra: true });
  const hooliCharges = async () => (await manager.get(`/api/charges?companyId=${hooli.id}`)).data.charges;
  const charges = await hooliCharges();
  check("allotment: agreed, the badge is given and charged $20", r.status === 200 && charges.length === 1 && charges[0].amount === 20 && /T-107/.test(charges[0].description), JSON.stringify(charges));
  a = await allotment();
  check("allotment: the paid badge is theirs to keep", a.allowed === 8 && a.paid === 1 && a.held === 8);
  await desk.post(`/api/badges/${stock[0].id}/return`, { outcome: "returned" });
  r = await give(0, 8);
  check("allotment: a badge handed back goes to someone else at no charge", r.status === 200 && (await hooliCharges()).length === 1);
  await manager.put(`/api/leases/${hooliLease.id}`, { officeIds: [o301.id] });
  check("allotment: giving up an office keeps its badges", (await allotment()).allowed === 8);
  await manager.post("/api/leases", { companyId: hooli.id, officeIds: [o302.id], startDate: "2026-02-01" });
  check("allotment: the same office again adds nothing", (await allotment()).allowed === 8);
  await manager.post("/api/leases", { companyId: hooli.id, officeIds: [o303.id], startDate: "2026-03-01" });
  check("allotment: a different office adds its desks", (await allotment()).allowed === 12);
  await manager.put(`/api/offices/${o303.id}`, { desks: 5 });
  check("allotment: an office that gains a desk adds it", (await allotment()).allowed === 13);
  await desk.post(`/api/badges/${stock[1].id}/return`, { outcome: "lost" });
  a = await allotment();
  check("allotment: a lost badge still counts", a.allowed === 12 && a.held === 7 && a.lost === 1, JSON.stringify(a));
  check("allotment: front desk can't adjust it", (await desk.post(`/api/companies/${hooli.id}/badge-allotment`, { quantity: 2, note: "x" })).status === 403);
  check("allotment: an adjustment says why", (await manager.post(`/api/companies/${hooli.id}/badge-allotment`, { quantity: 2 })).status === 400);
  r = await manager.post(`/api/companies/${hooli.id}/badge-allotment`, { quantity: 2, note: "Paid for before allotments were counted" });
  check("allotment: a manager adjusts it, and its ledger says so", r.status === 200 && r.data.allotment.allowed === 14 && r.data.allotment.entries[0].kind === "adjust" && r.data.allotment.entries[0].note.startsWith("Paid for"));
  r = await finance.put("/api/finance/settings", { badgePrice: 25 });
  check("allotment: Finance sets the price of an extra badge", r.status === 200 && (await finance.get("/api/finance/settings")).data.settings.badgePrice === 25, JSON.stringify(r.data).slice(0, 200));

  // --- the badge each person holds, in the people tables --------------------------------------------------------------
  const heldOf = (list, person) => list.find((p) => p.id === person.id).heldBadges;
  let peopleNow = (await desk.get(`/api/companies/${hooli.id}`)).data.people;
  check("people: a company's list has the badge each holds", heldOf(peopleNow, staff[8]).map((x) => x.label).join() === "T-100" && heldOf(peopleNow, staff[0]).length === 0, JSON.stringify(peopleNow[0]).slice(0, 300));
  check("people: and the people page", heldOf((await desk.get(`/api/people?companyId=${hooli.id}`)).data.people, staff[8])[0].id === stock[0].id);
  check("people: not for those who don't see badges", (await finance.get(`/api/companies/${hooli.id}`)).data.people.every((p) => p.heldBadges === undefined) && (await finance.get(`/api/people?companyId=${hooli.id}`)).data.people.every((p) => p.heldBadges === undefined));
  check("people: a viewer who sees badges sees them", heldOf((await viewer.get(`/api/companies/${hooli.id}`)).data.people, staff[8]).length === 1);
  const lentOne = (await admin.post("/api/badges", { number: "TMP-9", type: "tenant", temporary: true })).data.badge;
  await desk.post(`/api/badges/${lentOne.id}/assign`, { kind: "person", holderId: staff[8].id, replacesBadgeId: stock[0].id });
  peopleNow = (await desk.get(`/api/companies/${hooli.id}`)).data.people;
  check("people: theirs first, one lent for the day marked", heldOf(peopleNow, staff[8]).map((x) => `${x.label}:${x.temporary}`).join() === "T-100:false,TMP-9:true", JSON.stringify(heldOf(peopleNow, staff[8])));
  await desk.post(`/api/badges/${lentOne.id}/return`, { outcome: "returned" });

  // --- buying tenant badges with a charge ------------------------------------------------------------------------------
  const badgeItem = (await manager.get("/api/charge-items")).data.items.find((i) => i.builtIn);
  check("buying: built into the price list, at the badge price", badgeItem?.kind === "tenant_badge" && badgeItem.name === "Additional tenant badge" && badgeItem.rate === 25 && badgeItem.unit === "each", JSON.stringify(badgeItem));
  check("buying: it can't be removed or turned off", (await manager.del(`/api/charge-items/${badgeItem.id}`)).status === 409 && (await manager.put(`/api/charge-items/${badgeItem.id}`, { active: false })).status === 409);
  check("buying: its rate is the badge price, either way", (await finance.put(`/api/charge-items/${badgeItem.id}`, { rate: 30 })).data.item?.rate === 30 && (await finance.get("/api/finance/settings")).data.settings.badgePrice === 30);
  await finance.put("/api/finance/settings", { badgePrice: 20 });
  check("buying: and the other way", (await manager.get("/api/charge-items")).data.items.find((i) => i.builtIn).rate === 20);
  const heldBefore = (await allotment()).allowed;
  r = await manager.post("/api/charges", { companyId: hooli.id, date: "2026-10-05", itemId: badgeItem.id, quantity: 3 });
  const bought = r.data.charge;
  a = await allotment();
  check("buying: the charge adds that many, at the rate", r.status === 200 && bought.amount === 60 && bought.description === "Additional tenant badge" && a.allowed === heldBefore + 3 && r.data.allotment.allowed === a.allowed, JSON.stringify(r.data).slice(0, 300));
  const boughtEntry = (await desk.get(`/api/companies/${hooli.id}/badge-allotment`)).data.allotment.entries.find((e) => e.chargeId === bought.id);
  check("buying: its ledger says so", boughtEntry?.kind === "paid" && boughtEntry.quantity === 3 && boughtEntry.createdBy === "manny", JSON.stringify(boughtEntry));
  check("buying: and the audit log", (await admin.get("/api/audit?action=badge.allotment")).data.entries.some((e) => e.target === "Hooli" && /0 to 3 badges/.test(e.detail)));
  check("buying: whole badges only", (await manager.post("/api/charges", { companyId: hooli.id, date: "2026-10-05", itemId: badgeItem.id, quantity: 1.5 })).status === 400);
  const staffCo = (await admin.post("/api/companies", { name: "Building Crew", buildingStaff: true, sites: [{ siteId: harbor.id }] })).data.company;
  check("buying: not for building staff", (await manager.post("/api/charges", { companyId: staffCo.id, date: "2026-10-05", itemId: badgeItem.id, quantity: 1 })).status === 400);
  r = await manager.put(`/api/charges/${bought.id}`, { quantity: 2 });
  check("buying: a changed quantity changes the number", r.data.charge.amount === 40 && (await allotment()).allowed === heldBefore + 2);
  const newCo = await mk("Newco");
  r = await manager.put(`/api/charges/${bought.id}`, { companyId: newCo.id });
  const newCoAllotment = (await desk.get(`/api/companies/${newCo.id}/badge-allotment`)).data.allotment;
  check("buying: moved to another company, they go with it, and it's counted from then on", (await allotment()).allowed === heldBefore && newCoAllotment.allowed === 2 && newCoAllotment.counted === true, JSON.stringify(newCoAllotment).slice(0, 200));
  r = await manager.put(`/api/charges/${bought.id}`, { companyId: hooli.id, itemId: null, description: "Something else" });
  check("buying: no longer for badges, they're taken away", r.status === 200 && (await allotment()).allowed === heldBefore && !(await desk.get(`/api/companies/${hooli.id}/badge-allotment`)).data.allotment.entries.some((e) => e.chargeId === bought.id));
  r = await manager.put(`/api/charges/${bought.id}`, { itemId: badgeItem.id, quantity: 4 });
  check("buying: for badges again, they're back", r.status === 200 && (await allotment()).allowed === heldBefore + 4);
  check("buying: deleted, they're gone", (await manager.del(`/api/charges/${bought.id}`)).status === 200 && (await allotment()).allowed === heldBefore);
  const extraCharge = (await hooliCharges()).find((c) => /T-107/.test(c.description));
  check("buying: an extra badge given at the desk is a charge for the same item, its badge named in the ledger", extraCharge.itemId === badgeItem.id
    && (await desk.get(`/api/companies/${hooli.id}/badge-allotment`)).data.allotment.entries.some((e) => e.chargeId === extraCharge.id && e.quantity === 1 && e.badgeLabel === "T-107"));
  check("buying: other price list charges add none", (await manager.post("/api/charges", { companyId: hooli.id, date: "2026-10-05", itemId: hvac.id, quantity: 2 })).data.allotment === null && (await allotment()).allowed === heldBefore);

  // --- certificates of insurance -------------------------------------------------------------------------------------
  const pdfUrl = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64")}`;
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  check("insurance: front desk doesn't see certificates", (await desk.get("/api/insurance")).status === 403 && (await desk.get(`/api/companies/${hooli.id}/insurance`)).status === 403);
  check("insurance: a viewer can't add one", (await viewer.post(`/api/companies/${hooli.id}/insurance`, { expiresOn: inDays(100) })).status === 403);
  r = await manager.post(`/api/companies/${hooli.id}/insurance`, { insurer: "Harbor Mutual", effectiveDate: inDays(-200), expiresOn: inDays(200), coverage: "General liability $1M / $2M", file: { name: "C:\\scans\\coi.pdf", dataUrl: pdfUrl } });
  const cert = r.data.certificate;
  check("insurance: a manager adds a certificate with its copy", r.status === 200 && cert.status === "current" && cert.file?.name === "coi.pdf" && cert.file.type === "application/pdf", JSON.stringify(r.data));
  r = await finance.raw(`/api/insurance/files/${cert.file.ref}`);
  check("insurance: the copy comes back as it went in, and as nothing else", r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.text.startsWith("%PDF-") && r.headers.get("x-content-type-options") === "nosniff");
  check("insurance: a file that isn't what it says is refused", (await manager.post(`/api/companies/${hooli.id}/insurance`, { expiresOn: inDays(100), file: { name: "x.pdf", dataUrl: `data:application/pdf;base64,${Buffer.from("<html>hi</html>").toString("base64")}` } })).status === 400);
  check("insurance: nor any type but PDF, PNG and JPEG", (await manager.post(`/api/companies/${hooli.id}/insurance`, { expiresOn: inDays(100), file: { name: "x.html", dataUrl: "data:text/html;base64,PGI+aGk8L2I+" } })).status === 400);
  check("insurance: a certificate needs its expiration date", (await manager.post(`/api/companies/${hooli.id}/insurance`, { insurer: "Nobody" })).status === 400);
  r = await finance.post(`/api/companies/${initech.id}/insurance`, { insurer: "Old Policy Co", expiresOn: inDays(-5) });
  check("insurance: Finance adds them too; one past its date has expired", r.status === 200 && r.data.certificate.status === "expired");
  r = await finance.post(`/api/companies/${initech.id}/insurance`, { insurer: "Renewal Co", expiresOn: inDays(10) });
  check("insurance: one running out within 30 days is expiring", r.data.certificate.status === "expiring" && r.data.certificate.daysLeft === 10);
  const attention = (await manager.get("/api/insurance/attention")).data.companies;
  const coverOf = (name) => attention.find((c) => c.companyName === name)?.status;
  check("insurance: Home lists tenants with an office whose cover needs seeing to", coverOf("Initech") === "expiring" && coverOf("Acme") === "none" && !coverOf("Hooli") && !coverOf("Umbrella"), JSON.stringify(attention.map((c) => [c.companyName, c.status])));
  check("insurance: a company's cover is the certificate that runs latest", (await manager.get("/api/insurance?status=expiring")).data.companies.some((c) => c.companyName === "Initech" && c.certificates === 2));
  const elsewhere = (await admin.post("/api/sites", { name: "Elsewhere" })).data.site;
  const expiringAt = async (c, site) => { const x = await c.get(`/api/insurance?status=soon&site=${site.id}`); return x.status === 200 ? x.data.companies.map((co) => co.companyName).join() : x.status; };
  check("insurance: the expiring card lists those at the chosen site, not those with cover for longer", (await expiringAt(manager, harbor)) === "Initech" && (await expiringAt(manager, elsewhere)) === "");
  check("insurance: the card for Home's other list follows the site too", (await manager.get(`/api/insurance/attention?site=${elsewhere.id}`)).data.companies.length === 0);
  for (const [name, days] of [["Lapsed Lately", -10], ["Lapsed At The Limit", -30], ["Lapsed Long Ago", -31]]) await manager.post(`/api/companies/${(await mk(name)).id}/insurance`, { insurer: "Old Cover", expiresOn: inDays(days) });
  const soonList = (await expiringAt(manager, harbor)).split(",");
  check("insurance: the card adds those expired in the last 30 days, and no older", ["Initech", "Lapsed Lately", "Lapsed At The Limit"].every((n) => soonList.includes(n)) && soonList.length === 3, soonList.join());
  check("insurance: a renewed company's old certificate doesn't count", !soonList.includes("Hooli"));
  check("insurance: status expiring still means just that", (await manager.get("/api/insurance?status=expiring")).data.companies.map((c) => c.companyName).join() === "Initech");
  check("insurance: a Manager's Home starts with the expiring card", (await manager.get("/api/me/prefs")).data.dashboard.includes("insuranceExpiring"));
  check("insurance: Finance can add it; front desk isn't offered it", (await finance.get("/api/me/prefs")).data.available.includes("insuranceExpiring") && !(await finance.get("/api/me/prefs")).data.dashboard.includes("insuranceExpiring") && !(await desk.get("/api/me/prefs")).data.available.includes("insuranceExpiring"));
  r = await manager.put(`/api/insurance/${cert.id}`, { removeFile: true, notes: "Waiting on the original" });
  check("insurance: its copy taken away, the file is gone", r.data.certificate.file === null && r.data.certificate.notes === "Waiting on the original" && (await finance.raw(`/api/insurance/files/${cert.file.ref}`)).status === 404);
  check("insurance: deleted", (await manager.del(`/api/insurance/${cert.id}`)).status === 200 && (await manager.get(`/api/companies/${hooli.id}/insurance`)).data.certificates.length === 0);

  // --- a lease's documents follow the caller's sites ---------------------------------------------------------------
  pw.lena = password();
  await admin.post("/api/users", { username: "lena", password: pw.lena, role: "manager", sites: [elsewhere.id] });
  const elsewhereManager = await as("lena");
  const o413 = await office("413", 100);
  const harborLease = (await manager.post("/api/leases", { companyId: hooli.id, officeIds: [o413.id], startDate: "2022-01-01" })).data.lease;
  const harborDoc = (await manager.upload(`/api/leases/${harborLease.id}/documents?name=harbor.pdf&kind=agreement`, Buffer.from("%PDF-1.4 harbor"))).data.document;
  check("company leases: found for the company, with their documents", (await manager.get(`/api/leases?companyId=${hooli.id}`)).data.leases.find((l) => l.id === harborLease.id)?.documents.length === 1);
  check("company leases: not for a company at another site", (await elsewhereManager.get(`/api/leases?companyId=${hooli.id}`)).status === 404);
  check("company leases: not for a role that can't see leases", (await desk.get(`/api/leases?companyId=${hooli.id}`)).status === 403);
  check("documents: not opened from another site", (await elsewhereManager.raw(`/api/lease-documents/${harborDoc.ref}`)).status === 404);
  check("documents: nor added there", (await elsewhereManager.upload(`/api/leases/${harborLease.id}/documents?name=x.pdf&kind=agreement`, Buffer.from("%PDF-1.4 x"))).status === 404);
  // --- a room shared between companies -----------------------------------------------------------------
  {
  const { escalate } = require("../rent-terms");
  const money2 = (n) => Math.round(n * 100) / 100;
  const rentLine = async (id, period) => (await manager.get("/api/leases/" + id + "/rent?period=" + period)).data.rent;
  const pied = await mk("Pied Piper");
  const aviato = await mk("Aviato");
  const raviga = await mk("Raviga");
  const sharedRoom = await office("510", 1000);
  await manager.put(`/api/offices/${sharedRoom.id}`, { desks: 3 });
  const half = (companyId, extra = {}) => manager.post("/api/leases", { companyId, officeIds: [sharedRoom.id], officeShares: [{ officeId: sharedRoom.id, sharePct: 50 }], startDate: "2020-12-01", escalationPct: 2.75, classRates: { 0: 3 }, ...extra });
  r = await half(pied.id);
  const piedLease = r.data.lease;
  check("shared room: a lease has its share of the room", r.status === 200 && piedLease.offices[0].sharePct === 50 && piedLease.sqft === 500, JSON.stringify(r.data));
  check("shared room: the rate is the whole room's, the rent its share", piedLease.offices[0].rate === 3 && piedLease.offices[0].monthly === 1500 && piedLease.baseMonthly === 1500);
  check("shared room: yearly increases on its share", piedLease.currentMonthly === escalate(1500, { escalation_pct: 2.75 }, piedLease.increases));
  let free = (await manager.get("/api/offices?freeFrom=2021-01-01")).data.offices.find((o) => o.id === sharedRoom.id);
  check("shared room: the rest of it is still free", free?.freeShare === 50 && free.heldDuring[0].companyName === "Pied Piper", JSON.stringify(free));
  check("shared room: only what's free can be taken", (r = await half(aviato.id, { officeShares: [{ officeId: sharedRoom.id, sharePct: 60 }] })).status === 409 && /Only 50% of the room is free/.test(r.data.error), JSON.stringify(r.data));
  check("shared room: a share is a percentage", (await half(aviato.id, { officeShares: [{ officeId: sharedRoom.id, sharePct: 0 }] })).status === 400 && (await half(aviato.id, { officeShares: [{ officeId: sharedRoom.id, sharePct: 101 }] })).status === 400);
  r = await half(aviato.id);
  const aviatoLease = r.data.lease;
  check("shared room: the second company's lease", r.status === 200 && aviatoLease.offices[0].sharedWith[0].companyName === "Pied Piper" && aviatoLease.currentMonthly === piedLease.currentMonthly, JSON.stringify(r.data));
  check("shared room: a third can't join a full room", (r = await half(raviga.id)).status === 409 && /fully let/.test(r.data.error));
  check("shared room: and it's no longer offered", !(await manager.get("/api/offices?freeFrom=2021-01-01")).data.offices.some((o) => o.id === sharedRoom.id));
  const roomNow = (await manager.get(`/api/offices/${sharedRoom.id}`)).data.office;
  check("shared room: both hold it, and it counts once", roomNow.status === "occupied" && roomNow.holders.map((a) => a.companyName).join() === "Aviato,Pied Piper" && roomNow.freePct === 0 && roomNow.letSqft === 1000 && roomNow.sqft === 1000, JSON.stringify(roomNow.holders));
  check("shared room: its rent is what they pay together", roomNow.monthly === money2(piedLease.currentMonthly + aviatoLease.currentMonthly) && roomNow.holders[0].monthly === aviatoLease.currentMonthly);
  const piedOffices = (await manager.get(`/api/companies/${pied.id}/facilities`)).data;
  check("shared room: a company's page counts its part", piedOffices.totals.sqft === 500 && piedOffices.totals.monthly === piedLease.currentMonthly && piedOffices.offices[0].sharePct === 50);
  check("shared room: desks are split, rounded down", piedOffices.totals.desks === 1);
  check("shared room: the badges credited follow them", (await manager.get(`/api/companies/${pied.id}/badge-allotment`)).data.allotment.allowed === 1);
  check("shared room: each is invoiced its own part", await rentOf(piedLease.id, "2021-01") === 1500 && await rentOf(aviatoLease.id, "2021-01") === 1500);
  check("shared room: the invoice line says so", /510 \(50% share\)/.test((await rentLine(piedLease.id, "2021-01")).description));
  check("shared room: a share can't grow over the other's", (r = await manager.put(`/api/leases/${piedLease.id}`, { officeShares: [{ officeId: sharedRoom.id, sharePct: 60 }] })).status === 409 && /Only 50%/.test(r.data.error), JSON.stringify(r.data));
  check("shared room: lowering one leaves room for the other", (await manager.put(`/api/leases/${aviatoLease.id}`, { officeShares: [{ officeId: sharedRoom.id, sharePct: 40 }] })).data.lease.offices[0].sharePct === 40);
  r = await manager.put(`/api/leases/${piedLease.id}`, { officeShares: [{ officeId: sharedRoom.id, sharePct: 60 }] });
  check("shared room: shares can change, one at a time", r.status === 200 && r.data.lease.offices[0].monthly === 1800 && r.data.lease.sqft === 600);
  const editedDates = (await manager.put(`/api/leases/${aviatoLease.id}`, { endDate: "2021-12-31" })).data.lease;
  check("shared room: a lease edited without shares keeps its own", editedDates.offices[0].sharePct === 40);
  const later = (await manager.get("/api/offices?freeFrom=2022-01-01")).data.offices.find((o) => o.id === sharedRoom.id);
  check("shared room: free when one has left", later?.freeShare === 40 && (await manager.get(`/api/offices/${sharedRoom.id}`)).data.office.freePct === 40, JSON.stringify(later));
  const halfLet = (await manager.get(`/api/offices/${sharedRoom.id}`)).data.office;
  check("shared room: the part left is counted as free", halfLet.letSqft === 600 && halfLet.openSqft === 400 && halfLet.holders.length === 1);
  const fixedHalf = await office("511", 1000);
  r = await manager.post("/api/leases", { companyId: raviga.id, officeIds: [fixedHalf.id], officeShares: [{ officeId: fixedHalf.id, sharePct: 50 }], startDate: "2024-01-01", rentMode: "fixed", monthlyRent: 2000 });
  check("shared room: a fixed rent is the company's own, not divided", r.status === 200 && r.data.lease.currentMonthly === 2000 && r.data.lease.offices[0].sharePct === 50);
  const whole = await office("512", 100);
  r = await manager.post(`/api/offices/${whole.id}/assignments`, { companyId: raviga.id, startDate: "2024-01-01", sharePct: 25 });
  check("shared room: from Rooms too", r.status === 200 && r.data.assignment.sharePct === 25 && r.data.office.freePct === 75);
  const wholeHeld = r.data.assignment;
  r = await manager.put(`/api/office-assignments/${wholeHeld.id}`, { startDate: wholeHeld.startDate, endDate: null, sharePct: 75 });
  check("shared room: changed from Rooms", r.status === 200 && r.data.assignment.sharePct === 75);
  r = await manager.post(`/api/companies/${pied.id}/offices`, { officeIds: [whole.id], startDate: "2024-01-01", shares: { [whole.id]: 25 } });
  check("shared room: from a company's page, for the part that's free", r.status === 200 && (await manager.get(`/api/offices/${whole.id}`)).data.office.freePct === 0, JSON.stringify(r.data));
  r = await finance.post("/api/invoices/generate", { period: "2021-06", issueDate: "2021-06-01" });
  const sharedDraft = (company) => r.data.invoices.find((d) => d.companyId === company.id);
  check("shared room: each company gets its own invoice for its part", sharedDraft(pied)?.total === 1800 && sharedDraft(aviato)?.total === 1200, JSON.stringify(r.data.invoices));
  }
  check("documents: nor removed", (await elsewhereManager.del(`/api/lease-documents/${harborDoc.id}`)).status === 404 && (await manager.raw(`/api/lease-documents/${harborDoc.ref}`)).status === 200);
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
    fake.close();
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
    process.exit(ok ? 0 : 1);
  });
