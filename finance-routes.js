/**
 * Routes for leases, charges, invoices, payments, the billing settings and QuickBooks.
 *
 * Leases: seen with facilities or finance access (read), changed with facilities edit
 * (Managers). The price list and charges: seen likewise, kept by those who change facilities or
 * keep the books (Managers and Finance). Invoices, payments and balances: seen with finance
 * read (Managers), made and changed with finance edit (Finance, administrators), as are the
 * billing settings and the QuickBooks connection. Everything follows the caller's sites: the
 * companies they see, and leases on offices at their sites.
 */
const express = require("express");
const { PAYMENT_METHODS } = require("./billing");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function str(value, max = 200) {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === null || v === "" ? undefined : String(v).slice(0, max);
}

function positiveInt(value, fallback = null) {
  const n = Number(str(value));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dollars = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "");

function createFinanceRoutes({ access, leases, billing, quickbooks, directory, auditFrom, appUrl = "", branding = () => ({}) }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const need = (test, message) => (req, res, next) => (test(req.ctx) ? next() : res.status(403).json({ error: message }));
  const seesLeases = need((ctx) => access.canReadFacilities(ctx) || access.canReadFinance(ctx), "This account can't see leases.");
  const editLeases = need(access.canEditFacilities, "Only those who change facilities change leases.");
  const seesCharges = need((ctx) => access.canReadFacilities(ctx) || access.canReadFinance(ctx), "This account can't see charges.");
  const editCharges = need(access.canEditCharges, "This account can't log charges.");
  const readFinance = need(access.canReadFinance, "This account can't see invoices and payments.");
  const editFinance = need(access.canEditFinance, "Only Finance makes invoices and records payments.");
  const scope = (req) => req.ctx.sites;
  const idOf = (req, key = "id") => {
    const id = positiveInt(req.params[key]);
    if (!id) throw fail(404, "Not found.");
    return id;
  };

  /** The companies the caller sees (a Set of ids), or null when it sees every one. */
  function companies(req) {
    if (!req.ctx.sites) return null;
    return new Set(directory.listCompanies({ sites: req.ctx.sites, limit: 1000000, includeInactive: true }).records.map((c) => c.id));
  }

  function companyParam(req, value) {
    const id = positiveInt(value);
    if (!id) return null;
    if (!directory.getCompany(id, { sites: req.ctx.sites })) throw fail(404, "No such company, or not at your sites.");
    return id;
  }

  // --- leases -----------------------------------------------------------------------------------------

  router.get("/api/leases", seesLeases, (req, res) => {
    res.json({ leases: leases.list({ scope: scope(req), companyId: companyParam(req, req.query.companyId), status: str(req.query.status, 20) || null, q: str(req.query.q) || "" }) });
  });

  router.get("/api/leases/ending", seesLeases, (req, res) => {
    res.json({ leases: leases.endingSoon({ scope: scope(req) }) });
  });

  router.get("/api/leases/:id", seesLeases, (req, res) => {
    const lease = leases.get(idOf(req), { scope: scope(req) });
    if (!lease) throw fail(404, "No such lease, or not at your sites.");
    res.json({ lease });
  });

  /** A lease's rent for a month (YYYY-MM): what an invoice would charge. */
  router.get("/api/leases/:id/rent", seesLeases, (req, res) => {
    const lease = leases.get(idOf(req), { scope: scope(req) });
    if (!lease) throw fail(404, "No such lease, or not at your sites.");
    res.json({ rent: leases.rentFor(lease.id, str(req.query.period, 7) || leases.today().slice(0, 7)) });
  });

  const leaseWords = (l) => `${l.companyName}: ${l.offices.map((o) => o.name).join(", ") || "no offices"}, ${l.startDate} to ${l.endDate || "no end date"}${l.rentMode === "fixed" ? `, $${l.monthlyRent}/month` : ", rent from the rates"}`;

  router.post("/api/leases", editLeases, (req, res) => {
    const lease = leases.create(req.body || {}, { scope: scope(req), by: staffName(req) });
    auditFrom(req, "lease.add", lease.reference || `#${lease.id}`, leaseWords(lease));
    res.json({ ok: true, lease });
  });

  router.put("/api/leases/:id", editLeases, (req, res) => {
    const lease = leases.update(idOf(req), req.body || {}, { scope: scope(req), by: staffName(req) });
    auditFrom(req, "lease.update", lease.reference || `#${lease.id}`, leaseWords(lease));
    res.json({ ok: true, lease });
  });

  router.delete("/api/leases/:id", editLeases, (req, res) => {
    const lease = leases.remove(idOf(req), { scope: scope(req) });
    auditFrom(req, "lease.remove", lease.reference || `#${lease.id}`, leaseWords(lease));
    res.json({ ok: true });
  });

  // --- the price list and charges ---------------------------------------------------------------------

  router.get("/api/charge-items", seesCharges, (req, res) => {
    res.json({ items: billing.items({ includeInactive: str(req.query.all) === "1" }) });
  });

  router.post("/api/charge-items", editCharges, (req, res) => {
    const item = billing.createItem(req.body || {});
    auditFrom(req, "charge_item.add", item.name, `$${item.rate} per ${item.unit}`);
    res.json({ ok: true, item });
  });

  router.put("/api/charge-items/:id", editCharges, (req, res) => {
    const item = billing.updateItem(idOf(req), req.body || {});
    auditFrom(req, "charge_item.update", item.name, `$${item.rate} per ${item.unit}${item.active ? "" : ", turned off"}`);
    res.json({ ok: true, item });
  });

  router.delete("/api/charge-items/:id", editCharges, (req, res) => {
    const item = billing.removeItem(idOf(req));
    auditFrom(req, "charge_item.remove", item.name);
    res.json({ ok: true });
  });

  router.get("/api/charges", seesCharges, (req, res) => {
    res.json(billing.listCharges({
      companies: companies(req),
      companyId: companyParam(req, req.query.companyId),
      status: ["unbilled", "billed"].includes(str(req.query.status)) ? str(req.query.status) : null,
      from: str(req.query.from, 10) || null,
      to: str(req.query.to, 10) || null,
      q: str(req.query.q) || "",
      limit: positiveInt(req.query.limit, 500)
    }));
  });

  function visibleCharge(req, id) {
    const charge = billing.getCharge(id);
    const seen = companies(req);
    if (!charge || (seen && !seen.has(charge.companyId))) throw fail(404, "No such charge.");
    return charge;
  }

  router.post("/api/charges", editCharges, (req, res) => {
    companyParam(req, req.body?.companyId);
    const charge = billing.createCharge(req.body || {}, { by: staffName(req) });
    auditFrom(req, "charge.add", charge.companyName, `${charge.date}: ${charge.description}, ${charge.quantity} × $${charge.rate} = $${charge.amount}`);
    res.json({ ok: true, charge });
  });

  router.put("/api/charges/:id", editCharges, (req, res) => {
    visibleCharge(req, idOf(req));
    if (req.body?.companyId !== undefined) companyParam(req, req.body.companyId);
    const charge = billing.updateCharge(idOf(req), req.body || {});
    auditFrom(req, "charge.update", charge.companyName, `${charge.date}: ${charge.description}, ${charge.quantity} × $${charge.rate} = $${charge.amount}`);
    res.json({ ok: true, charge });
  });

  router.delete("/api/charges/:id", editCharges, (req, res) => {
    visibleCharge(req, idOf(req));
    const charge = billing.removeCharge(idOf(req));
    auditFrom(req, "charge.remove", charge.companyName, `${charge.date}: ${charge.description}, $${charge.amount}`);
    res.json({ ok: true });
  });

  // --- invoices ---------------------------------------------------------------------------------------

  router.get("/api/invoices", readFinance, (req, res) => {
    res.json({ invoices: billing.listInvoices({
      companies: companies(req),
      state: str(req.query.state, 20) || null,
      companyId: companyParam(req, req.query.companyId),
      period: str(req.query.period, 7) || null,
      from: str(req.query.from, 10) || null,
      to: str(req.query.to, 10) || null,
      q: str(req.query.q) || "",
      limit: positiveInt(req.query.limit, 500)
    }) });
  });

  router.get("/api/invoices/:id", readFinance, (req, res) => {
    const invoice = billing.getInvoice(idOf(req), { companies: companies(req) });
    if (!invoice) throw fail(404, "No such invoice.");
    res.json({ invoice });
  });

  /** Drafts a month's invoices: { period: YYYY-MM, companyIds (optional), issueDate (optional) }. */
  router.post("/api/invoices/generate", editFinance, (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.companyIds) && body.companyIds.length ? body.companyIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
    const result = billing.generate(String(body.period || ""), { companies: companies(req), companyIds: ids, issueDate: body.issueDate || null, by: staffName(req), scope: scope(req) });
    auditFrom(req, "invoice.generate", result.period, `${result.invoices.length} draft${result.invoices.length === 1 ? "" : "s"}${result.skipped.length ? `; ${result.skipped.length} left out` : ""}`);
    res.json({ ok: true, ...result });
  });

  router.post("/api/invoices", editFinance, (req, res) => {
    const invoice = billing.createInvoice(req.body || {}, { companies: companies(req), by: staffName(req) });
    auditFrom(req, "invoice.add", invoice.companyName, "blank draft");
    res.json({ ok: true, invoice });
  });

  router.put("/api/invoices/:id", editFinance, (req, res) => {
    const invoice = billing.updateInvoice(idOf(req), req.body || {}, { companies: companies(req) });
    auditFrom(req, "invoice.update", invoice.number || `draft #${invoice.id}`, Object.keys(req.body || {}).join(", "));
    res.json({ ok: true, invoice });
  });

  router.post("/api/invoices/:id/lines", editFinance, (req, res) => {
    const invoice = billing.addLine(idOf(req), req.body || {}, { companies: companies(req) });
    const line = invoice.lines[invoice.lines.length - 1];
    auditFrom(req, "invoice.line_add", `draft #${invoice.id}`, `${invoice.companyName}: ${line.description}, $${line.amount}`);
    res.json({ ok: true, invoice });
  });

  router.delete("/api/invoices/:id/lines/:lineId", editFinance, (req, res) => {
    const invoice = billing.removeLine(idOf(req), idOf(req, "lineId"), { companies: companies(req) });
    auditFrom(req, "invoice.line_remove", `draft #${invoice.id}`, invoice.companyName);
    res.json({ ok: true, invoice });
  });

  router.post("/api/invoices/:id/issue", editFinance, (req, res) => {
    const invoice = billing.issue(idOf(req), { companies: companies(req), by: staffName(req) });
    auditFrom(req, "invoice.issue", invoice.number, `${invoice.companyName}: ${dollars(invoice.total)}, due ${invoice.dueDate}`);
    res.json({ ok: true, invoice });
  });

  router.post("/api/invoices/:id/void", editFinance, (req, res) => {
    const invoice = billing.voidInvoice(idOf(req), { companies: companies(req), by: staffName(req) });
    auditFrom(req, "invoice.void", invoice.number, `${invoice.companyName}: ${dollars(invoice.total)}`);
    res.json({ ok: true, invoice });
  });

  router.delete("/api/invoices/:id", editFinance, (req, res) => {
    const invoice = billing.removeDraft(idOf(req), { companies: companies(req) });
    auditFrom(req, "invoice.remove", `draft #${invoice.id}`, `${invoice.companyName}: ${dollars(invoice.total)}`);
    res.json({ ok: true });
  });

  /** The invoice as a page to print or save as PDF. */
  router.get("/api/invoices/:id/print", readFinance, (req, res) => {
    const inv = billing.getInvoice(idOf(req), { companies: companies(req) });
    if (!inv) throw fail(404, "No such invoice.");
    const s = billing.settings();
    const company = inv.companyId ? directory.getCompany(inv.companyId) : null;
    const issuer = s.issuerName || branding().name || "";
    const lines = (t) => esc(t).replace(/\n/g, "<br>");
    const title = inv.number ? `Invoice ${inv.number}` : `Draft invoice for ${inv.companyName}`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; background: #f4f4f5; }
  .sheet { max-width: 800px; margin: 24px auto; background: #fff; padding: 48px 56px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .bar { max-width: 800px; margin: 16px auto 0; display: flex; gap: 8px; justify-content: flex-end; }
  .bar button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  .bar button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  header { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
  h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: .02em; }
  .muted { color: #555; }
  .draft { color: #b45309; font-weight: 700; }
  .void { color: #b91c1c; font-weight: 700; }
  .meta { text-align: right; line-height: 1.6; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 28px; line-height: 1.5; }
  .label { text-transform: uppercase; font-size: 11px; letter-spacing: .08em; color: #666; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #555; border-bottom: 2px solid #111; padding: 8px 6px; }
  td { padding: 10px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 18px; margin-left: auto; width: 300px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 6px; }
  .totals .due { font-size: 18px; font-weight: 700; border-top: 2px solid #111; padding-top: 8px; margin-top: 4px; }
  .notes { margin-top: 32px; line-height: 1.5; }
  @media print { body { background: #fff; } .bar { display: none; } .sheet { box-shadow: none; margin: 0; max-width: none; padding: 0; } @page { margin: 18mm; } }
</style></head><body>
<div class="bar"><button type="button" id="print" class="primary">Print or save as PDF</button></div>
<div class="sheet">
  <header>
    <div><h1>INVOICE</h1>${inv.status === "draft" ? '<div class="draft">DRAFT: not issued</div>' : ""}${inv.status === "void" ? '<div class="void">VOID</div>' : ""}
      <div style="margin-top:12px"><strong>${esc(issuer)}</strong>${s.issuerAddress ? `<div class="muted">${lines(s.issuerAddress)}</div>` : ""}</div></div>
    <div class="meta">
      ${inv.number ? `<div><span class="muted">Invoice</span> <strong>${esc(inv.number)}</strong></div>` : ""}
      <div><span class="muted">Date</span> ${esc(longDate(inv.issueDate))}</div>
      <div><span class="muted">Due</span> ${esc(longDate(inv.dueDate))}</div>
      ${inv.period ? `<div><span class="muted">For</span> ${esc(new Date(`${inv.period}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }))}</div>` : ""}
    </div>
  </header>
  <div class="parties">
    <div><div class="label">Bill to</div><strong>${esc(inv.companyName)}</strong>${company?.address ? `<div>${lines(company.address)}</div>` : ""}${company?.email ? `<div class="muted">${esc(company.email)}</div>` : ""}</div>
    ${s.remitTo ? `<div style="text-align:right"><div class="label">Remit payment to</div><div>${lines(s.remitTo)}</div></div>` : ""}
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(String(l.quantity))}${l.unit ? ` ${esc(l.unit)}` : ""}</td><td class="num">${dollars(l.rate)}</td><td class="num">${dollars(l.amount)}</td></tr>`).join("")}</tbody>
  </table>
  <div class="totals">
    <div><span>Total</span><span>${dollars(inv.total)}</span></div>
    ${inv.paid ? `<div><span>Paid</span><span>${dollars(-inv.paid)}</span></div>` : ""}
    <div class="due"><span>Balance due</span><span>${dollars(inv.status === "issued" ? inv.balance : inv.total)}</span></div>
  </div>
  ${inv.notes || s.footer ? `<div class="notes">${inv.notes ? `<div>${lines(inv.notes)}</div>` : ""}${s.footer ? `<div class="muted" style="margin-top:12px">${lines(s.footer)}</div>` : ""}</div>` : ""}
</div>
<script src="/print-invoice.js"></script>
</body></html>`);
  });

  // --- payments and balances ----------------------------------------------------------------------------

  router.get("/api/payments", readFinance, (req, res) => {
    res.json({ payments: billing.listPayments({ companies: companies(req), companyId: companyParam(req, req.query.companyId), from: str(req.query.from, 10) || null, to: str(req.query.to, 10) || null }), methods: PAYMENT_METHODS });
  });

  router.post("/api/invoices/:id/payments", editFinance, (req, res) => {
    const { payment, invoice } = billing.recordPayment(idOf(req), req.body || {}, { companies: companies(req), by: staffName(req) });
    auditFrom(req, "payment.add", invoice.number, `${invoice.companyName}: ${dollars(payment.amount)} by ${payment.method}${payment.reference ? ` (${payment.reference})` : ""} on ${payment.date}`);
    res.json({ ok: true, payment, invoice });
  });

  router.delete("/api/payments/:id", editFinance, (req, res) => {
    const { payment, invoice } = billing.removePayment(idOf(req), { companies: companies(req) });
    auditFrom(req, "payment.remove", invoice.number, `${invoice.companyName}: ${dollars(payment.amount)} on ${payment.date}`);
    res.json({ ok: true, invoice });
  });

  router.get("/api/finance/aging", readFinance, (req, res) => {
    res.json(billing.aging({ companies: companies(req) }));
  });

  // --- settings and exports -------------------------------------------------------------------------------

  router.get("/api/finance/settings", readFinance, (req, res) => {
    res.json({ settings: billing.settings(), methods: PAYMENT_METHODS });
  });

  router.put("/api/finance/settings", editFinance, (req, res) => {
    const settings = billing.saveSettings(req.body || {});
    auditFrom(req, "finance.settings", null, Object.keys(req.body || {}).join(", "));
    res.json({ ok: true, settings });
  });

  /** Issued invoices (by invoice date) or payments (by date) as QuickBooks Online CSV or Desktop IIF. */
  router.get("/api/finance/export/:what", readFinance, (req, res) => {
    const what = req.params.what;
    const format = str(req.query.format) === "iif" ? "iif" : "csv";
    const from = str(req.query.from, 10) || null;
    const to = str(req.query.to, 10) || null;
    let body;
    if (what === "invoices") {
      const list = billing.listInvoices({ companies: companies(req), from, to, limit: 5000 });
      body = format === "iif" ? billing.invoicesIif(list) : billing.invoicesCsv(list);
    } else if (what === "payments") {
      const list = billing.listPayments({ companies: companies(req), from, to, limit: 10000 });
      body = format === "iif" ? billing.paymentsIif(list) : billing.paymentsCsv(list);
    } else {
      throw fail(404, "Export invoices or payments.");
    }
    auditFrom(req, "finance.export", what, `${format.toUpperCase()}${from || to ? `, ${from || "start"} to ${to || "now"}` : ""}`);
    const name = `${what}${from ? `-from-${from}` : ""}${to ? `-to-${to}` : ""}.${format}`;
    res.setHeader("Content-Type", format === "iif" ? "application/octet-stream" : "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(format === "csv" ? `﻿${body}` : body);
  });

  // --- QuickBooks Online -----------------------------------------------------------------------------

  function redirectUri(req) {
    let base = appUrl;
    if (!base) {
      const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
      base = `${proto}://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
    }
    return `${String(base).replace(/\/+$/, "")}/api/quickbooks/callback`;
  }

  router.get("/api/quickbooks", editFinance, (req, res) => {
    res.json({ quickbooks: quickbooks.status(), redirectUri: redirectUri(req), appUrlSet: Boolean(appUrl) });
  });

  router.put("/api/quickbooks", editFinance, (req, res) => {
    const status = quickbooks.saveConfig(req.body || {});
    auditFrom(req, "quickbooks.settings", null, `${status.environment}${req.body?.clientSecret ? "; new client secret" : ""}`);
    res.json({ ok: true, quickbooks: status });
  });

  /** Where to send the browser to connect: QuickBooks' sign-in, which comes back to the callback. */
  router.post("/api/quickbooks/connect", editFinance, (req, res) => {
    res.json({ url: quickbooks.startConnect(redirectUri(req), staffName(req)) });
  });

  router.get("/api/quickbooks/callback", editFinance, async (req, res) => {
    let to = "/#finance-settings";
    try {
      if (req.query.error) throw fail(400, `QuickBooks said: ${str(req.query.error_description) || str(req.query.error)}.`);
      const status = await quickbooks.finishConnect({ code: str(req.query.code, 2000), state: str(req.query.state), realmId: str(req.query.realmId, 40) });
      auditFrom(req, "quickbooks.connect", status.companyName || status.realmId, status.environment);
      to += "?qbo=connected";
    } catch (error) {
      to += `?qbo_error=${encodeURIComponent(error.message)}`;
    }
    res.redirect(to);
  });

  router.post("/api/quickbooks/disconnect", editFinance, async (req, res) => {
    const before = quickbooks.status();
    const status = await quickbooks.disconnect();
    auditFrom(req, "quickbooks.disconnect", before.companyName || before.realmId);
    res.json({ ok: true, quickbooks: status });
  });

  router.post("/api/quickbooks/sync", editFinance, async (req, res) => {
    const result = await quickbooks.sync({ by: staffName(req) });
    auditFrom(req, "quickbooks.sync", null, `${result.invoicesSent} invoices and ${result.paymentsSent} payments sent, ${result.paymentsReceived} payments received${result.problems.length ? `; ${result.problems.length} problems` : ""}`);
    res.json({ ok: true, result });
  });

  router.post("/api/invoices/:id/quickbooks", editFinance, async (req, res) => {
    const invoice = billing.getInvoice(idOf(req), { companies: companies(req) });
    if (!invoice) throw fail(404, "No such invoice.");
    const qboId = await quickbooks.sendInvoice(invoice);
    auditFrom(req, "quickbooks.invoice", invoice.number, `QuickBooks id ${qboId}`);
    res.json({ ok: true, invoice: billing.getInvoice(invoice.id) });
  });

  return router;
}

module.exports = { createFinanceRoutes };
