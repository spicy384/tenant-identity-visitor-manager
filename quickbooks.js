/**
 * The QuickBooks Online connection, optional: Finance (or an administrator) registers an app
 * with Intuit (developer.intuit.com), enters its client id and secret under Settings, and
 * connects once, signing in to QuickBooks. Then issued invoices go to QuickBooks with their
 * customers (made when missing) and items (made when missing, against the income accounts named
 * in the billing settings), payments recorded here go with them, and payments recorded in
 * QuickBooks against those invoices come back here.
 *
 * OAuth 2.0 authorization code flow; the access token lasts an hour and is refreshed with the
 * refresh token, which Intuit replaces from time to time (both kept in the encrypted database,
 * never sent to the browser). QBO_AUTH_URL, QBO_TOKEN_URL, QBO_REVOKE_URL and QBO_API_BASE
 * override Intuit's addresses (for tests).
 */
const crypto = require("crypto");
const { fail } = require("./leases");

const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";
const STATE_TTL_MS = 10 * 60 * 1000;
const PAYMENT_METHODS = ["Check", "ACH", "Wire", "Card", "Cash", "Other"];

function urls(environment) {
  return {
    auth: process.env.QBO_AUTH_URL || "https://appcenter.intuit.com/connect/oauth2",
    token: process.env.QBO_TOKEN_URL || "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revoke: process.env.QBO_REVOKE_URL || "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    api: process.env.QBO_API_BASE || (environment === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com")
  };
}

/** A value inside single quotes in a QuickBooks query. */
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function createQuickBooks({ db, billing, now = Date.now }) {
  const states = new Map();

  function config() {
    return db.readDoc("quickbooks", {});
  }

  function save(patch) {
    db.writeDoc("quickbooks", { ...config(), ...patch });
  }

  /** What Settings shows: never the secret or the tokens. */
  function status() {
    const c = config();
    return {
      environment: c.environment || "production",
      clientId: c.clientId || "",
      hasSecret: Boolean(c.clientSecret),
      configured: Boolean(c.clientId && c.clientSecret),
      connected: Boolean(c.realmId && c.refreshToken),
      realmId: c.realmId || null,
      companyName: c.companyName || null,
      connectedAt: c.connectedAt || null,
      connectedBy: c.connectedBy || null,
      refreshExpiresAt: c.refreshExpiresAt || null,
      lastSync: c.lastSync || null,
      lastSyncResult: c.lastSyncResult || null
    };
  }

  function saveConfig(input = {}) {
    const patch = {};
    if (input.environment !== undefined) {
      if (!["production", "sandbox"].includes(input.environment)) throw fail(400, "The environment is production or sandbox.");
      patch.environment = input.environment;
    }
    if (input.clientId !== undefined) patch.clientId = String(input.clientId || "").trim().slice(0, 200);
    // The secret is only ever written; left blank, the saved one stays.
    if (input.clientSecret) patch.clientSecret = String(input.clientSecret).trim().slice(0, 200);
    const c = config();
    // Another app or environment: the old connection no longer applies.
    if ((patch.clientId !== undefined && patch.clientId !== c.clientId) || (patch.environment !== undefined && patch.environment !== (c.environment || "production"))) {
      Object.assign(patch, { realmId: null, refreshToken: null, accessToken: null, accessExpiresAt: null, refreshExpiresAt: null, companyName: null, connectedAt: null, connectedBy: null });
    }
    save(patch);
    return status();
  }

  // --- connecting ----------------------------------------------------------------------------------

  /** The address to send the browser to, to sign in to QuickBooks and allow the app. */
  function startConnect(redirectUri, by) {
    const c = config();
    if (!c.clientId || !c.clientSecret) throw fail(400, "Enter the app's client id and secret first.");
    for (const [k, v] of states) if (v.at < now() - STATE_TTL_MS) states.delete(k);
    const state = crypto.randomBytes(18).toString("base64url");
    states.set(state, { by, redirectUri, at: now() });
    const u = new URL(urls(c.environment).auth);
    u.searchParams.set("client_id", c.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPE);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  async function tokenRequest(form) {
    const c = config();
    const res = await fetch(urls(c.environment).token, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw fail(502, `QuickBooks refused: ${data.error_description || data.error || `HTTP ${res.status}`}.`);
    return data;
  }

  function keepTokens(data) {
    const t = now();
    save({
      accessToken: data.access_token,
      accessExpiresAt: t + (Number(data.expires_in) || 3600) * 1000,
      refreshToken: data.refresh_token || config().refreshToken,
      refreshExpiresAt: data.x_refresh_token_expires_in ? t + Number(data.x_refresh_token_expires_in) * 1000 : config().refreshExpiresAt || null
    });
  }

  /** Back from QuickBooks with a code: exchanged for tokens, and the company's name read. */
  async function finishConnect({ code, state, realmId }) {
    const pending = states.get(String(state || ""));
    states.delete(String(state || ""));
    if (!pending || pending.at < now() - STATE_TTL_MS) throw fail(400, "That sign-in to QuickBooks took too long or didn't start here. Connect again.");
    if (!code || !realmId) throw fail(400, "QuickBooks didn't say which company was connected.");
    const data = await tokenRequest({ grant_type: "authorization_code", code: String(code), redirect_uri: pending.redirectUri });
    save({ realmId: String(realmId), connectedAt: now(), connectedBy: pending.by || null });
    keepTokens(data);
    let companyName = null;
    try {
      companyName = (await api("GET", `companyinfo/${encodeURIComponent(String(realmId))}`)).CompanyInfo?.CompanyName || null;
    } catch {
      // The name is only for showing.
    }
    save({ companyName });
    return status();
  }

  /** Disconnects: the refresh token is revoked at Intuit (if it can be) and forgotten here. */
  async function disconnect() {
    const c = config();
    if (c.refreshToken) {
      try {
        await fetch(urls(c.environment).revoke, {
          method: "POST",
          headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token: c.refreshToken }),
          signal: AbortSignal.timeout(10000)
        });
      } catch {
        // Forgotten here either way.
      }
    }
    save({ realmId: null, refreshToken: null, accessToken: null, accessExpiresAt: null, refreshExpiresAt: null, companyName: null, connectedAt: null, connectedBy: null });
    return status();
  }

  // --- calling QuickBooks ----------------------------------------------------------------------------

  async function accessToken() {
    const c = config();
    if (!c.realmId || !c.refreshToken) throw fail(409, "QuickBooks isn't connected.");
    if (c.accessToken && c.accessExpiresAt > now() + 60000) return c.accessToken;
    keepTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken }));
    return config().accessToken;
  }

  async function api(method, path, body = null) {
    const c = config();
    const token = await accessToken();
    const u = new URL(`${urls(c.environment).api}/v3/company/${encodeURIComponent(c.realmId)}/${path}`);
    u.searchParams.set("minorversion", MINOR_VERSION);
    const res = await fetch(u, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.Fault?.Error?.map((e) => e.Detail || e.Message).join("; ") || `HTTP ${res.status}`;
      throw fail(502, `QuickBooks: ${detail}`);
    }
    return data;
  }

  async function query(sql) {
    const c = config();
    const token = await accessToken();
    const u = new URL(`${urls(c.environment).api}/v3/company/${encodeURIComponent(c.realmId)}/query`);
    u.searchParams.set("query", sql);
    u.searchParams.set("minorversion", MINOR_VERSION);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(502, `QuickBooks: ${data.Fault?.Error?.map((e) => e.Detail || e.Message).join("; ") || `HTTP ${res.status}`}`);
    return data.QueryResponse || {};
  }

  // --- what invoices need there ------------------------------------------------------------------------

  async function customerId(name, cache) {
    if (cache.customers.has(name)) return cache.customers.get(name);
    const found = (await query(`select Id from Customer where DisplayName = '${q(name)}'`)).Customer?.[0];
    const id = found ? found.Id : (await api("POST", "customer", { DisplayName: name })).Customer.Id;
    cache.customers.set(name, id);
    return id;
  }

  async function accountId(name, cache) {
    if (cache.accounts.has(name)) return cache.accounts.get(name);
    const found = (await query(`select Id from Account where Name = '${q(name)}'`)).Account?.[0];
    if (!found) throw fail(409, `QuickBooks has no account called "${name}". Make it there, or change the name under Settings > Billing.`);
    cache.accounts.set(name, found.Id);
    return found.Id;
  }

  async function itemId(name, accountName, cache) {
    if (cache.items.has(name)) return cache.items.get(name);
    const found = (await query(`select Id from Item where Name = '${q(name)}'`)).Item?.[0];
    const id = found ? found.Id : (await api("POST", "item", { Name: name, Type: "Service", IncomeAccountRef: { value: await accountId(accountName, cache) } })).Item.Id;
    cache.items.set(name, id);
    return id;
  }

  const newCache = () => ({ customers: new Map(), accounts: new Map(), items: new Map() });

  /** Sends one issued invoice (with its customer and items) to QuickBooks; its id there is kept. */
  async function sendInvoice(invoice, cache = newCache()) {
    if (invoice.qboId) return invoice.qboId;
    if (invoice.status !== "issued") throw fail(409, "Only issued invoices go to QuickBooks.");
    const s = billing.settings();
    const Line = [];
    for (const l of invoice.lines) {
      const name = l.itemName || (l.kind === "rent" ? s.qb.rentItem : s.qb.otherItem);
      Line.push({
        Amount: l.amount,
        Description: l.description,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: await itemId(name, l.kind === "rent" ? s.qb.rentAccount : s.qb.chargeAccount, cache) }, Qty: l.quantity, UnitPrice: l.rate }
      });
    }
    const created = await api("POST", "invoice", {
      CustomerRef: { value: await customerId(invoice.companyName, cache) },
      DocNumber: invoice.number,
      TxnDate: invoice.issueDate,
      DueDate: invoice.dueDate,
      PrivateNote: invoice.notes || undefined,
      Line
    });
    billing.markSynced(invoice.id, created.Invoice.Id);
    return created.Invoice.Id;
  }

  /** Sends a payment recorded here against an invoice already in QuickBooks. */
  async function sendPayment(payment, invoice, cache = newCache()) {
    const created = await api("POST", "payment", {
      CustomerRef: { value: await customerId(invoice.companyName, cache) },
      TotalAmt: payment.amount,
      TxnDate: payment.date,
      PaymentRefNum: payment.reference || undefined,
      PrivateNote: `${payment.method}${payment.notes ? `: ${payment.notes}` : ""}`.slice(0, 4000),
      Line: [{ Amount: payment.amount, LinkedTxn: [{ TxnId: invoice.qboId, TxnType: "Invoice" }] }]
    });
    billing.markPaymentSynced(payment.id, created.Payment.Id);
    return created.Payment.Id;
  }

  /**
   * Brings QuickBooks up to date: issued invoices not sent yet go, payments recorded here go
   * (once their invoice is there), and payments made in QuickBooks against invoices from here
   * since the last time come back. Each problem is listed rather than stopping the rest.
   */
  async function sync({ by = null } = {}) {
    const c = config();
    if (!c.realmId) throw fail(409, "QuickBooks isn't connected.");
    const cache = newCache();
    const out = { invoicesSent: 0, paymentsSent: 0, paymentsReceived: 0, problems: [] };
    for (const listed of billing.listInvoices({ limit: 5000 }).filter((i) => i.status === "issued" && !i.qboId).reverse()) {
      try {
        await sendInvoice(billing.getInvoice(listed.id), cache);
        out.invoicesSent += 1;
      } catch (error) {
        out.problems.push(`Invoice ${listed.number}: ${error.message}`);
      }
    }
    for (const p of billing.listPayments({ limit: 10000 }).filter((x) => !x.qboId && x.source === "app").reverse()) {
      const inv = billing.getInvoice(p.invoiceId);
      if (!inv?.qboId) continue;
      try {
        await sendPayment(p, inv, cache);
        out.paymentsSent += 1;
      } catch (error) {
        out.problems.push(`Payment of $${p.amount.toFixed(2)} on ${p.invoiceNumber}: ${error.message}`);
      }
    }
    // Payments changed in QuickBooks since the last sync (the first time: the last 90 days).
    const since = new Date(c.lastPaymentSync || now() - 90 * 86400000).toISOString();
    const started = now();
    const found = (await query(`select * from Payment where MetaData.LastUpdatedTime > '${since}' maxresults 1000`)).Payment || [];
    for (const pay of found) {
      for (const line of pay.Line || []) {
        const linked = (line.LinkedTxn || []).find((t) => t.TxnType === "Invoice");
        const invoiceId = linked && billing.invoiceByQbo(linked.TxnId);
        if (!invoiceId) continue;
        // One QuickBooks payment can pay several invoices: kept as one payment here per invoice.
        const key = pay.Line.length > 1 ? `${pay.Id}:${linked.TxnId}` : pay.Id;
        if (billing.paymentByQbo(key)) continue;
        const method = PAYMENT_METHODS.find((m) => m.toLowerCase() === String(pay.PaymentMethodRef?.name || "").toLowerCase()) || "Other";
        try {
          billing.recordPayment(invoiceId, { amount: line.Amount, date: pay.TxnDate, method, reference: pay.PaymentRefNum || null, notes: "From QuickBooks" }, { by, source: "quickbooks", qboId: key });
          out.paymentsReceived += 1;
        } catch (error) {
          out.problems.push(`QuickBooks payment ${pay.Id}: ${error.message}`);
        }
      }
    }
    save({ lastPaymentSync: started, lastSync: now(), lastSyncResult: out });
    return out;
  }

  return { status, saveConfig, startConnect, finishConnect, disconnect, sendInvoice, sync };
}

module.exports = { createQuickBooks };
