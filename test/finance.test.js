/**
 * Leases, charges, invoices, payments and QuickBooks over HTTP: who may do what, rent from the
 * rates and fixed (part months, yearly increases), the price list and charges, a month's
 * invoices, adjusting and issuing them, payments, overdue and aging, voiding, the printable
 * invoice, CSV and IIF exports, and the QuickBooks Online connection against a fake QuickBooks.
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
    raw: (u, opts = {}) => call("GET", u, undefined, { raw: true, ...opts })
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
  check("rooms: back to by the square foot", r.data.office.monthlyRent === null && r.data.office.monthly === 1600 && r.data.office.rateSource === "site");
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
