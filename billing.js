/**
 * Billing: the price list of things charged to tenants, the charges themselves, invoices and
 * the payments against them, and exports for QuickBooks.
 *
 * Charges are logged against a company (from the price list, or one-off) and stay unbilled
 * until an invoice holds them. A month's invoices are generated per company: its leases' rent
 * for that month (leases.js; a lease's month is invoiced once) and its unbilled charges up to
 * the month's end. An invoice is a draft until issued: lines can be added (adjustments, credits
 * as negative amounts) and taken off; issuing gives it the next number, so numbers have no
 * gaps. A voided invoice keeps its number, and its charges and rent months are free to invoice
 * again. Payments are recorded against issued invoices, in part or in full; an invoice is paid,
 * partly paid, open, or overdue past its due date. No tax.
 *
 * Exports: invoices and payments as CSV in QuickBooks Online's import layout, and as IIF for
 * QuickBooks Desktop, with the account and item names from the billing settings.
 */
const { money, periodInput, monthBounds, periodName, dateInput, text, fail } = require("./leases");

const PAYMENT_METHODS = ["Check", "ACH", "Wire", "Card", "Cash", "Other"];
const LINE_KINDS = ["rent", "charge", "adjustment"];
const MAX_AMOUNT = 100000000;
const DEFAULT_SETTINGS = {
  issuerName: "",
  issuerAddress: "",
  remitTo: "",
  termsDays: 30,
  invoicePrefix: "INV-",
  nextNumber: 1001,
  footer: "",
  qb: { arAccount: "Accounts Receivable", rentItem: "Rent", rentAccount: "Rental Income", chargeAccount: "Other Income", otherItem: "Other charges", depositAccount: "Undeposited Funds" }
};

function numberInput(value, label, { min = 0, max = MAX_AMOUNT, optional = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(400, `Give the ${label}.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw fail(400, `The ${label} must be a number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`);
  return Math.round(n * 10000) / 10000;
}

const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function createBilling({ db, leases, directory, now = Date.now }) {
  const raw = db.raw;
  const today = () => leases.today();

  // --- settings --------------------------------------------------------------------------------------

  function settings() {
    const s = db.readDoc("billing", {});
    return { ...DEFAULT_SETTINGS, ...s, qb: { ...DEFAULT_SETTINGS.qb, ...(s.qb || {}) } };
  }

  function saveSettings(input = {}) {
    const s = settings();
    const out = { ...s, qb: { ...s.qb } };
    for (const k of ["issuerName", "invoicePrefix"]) if (input[k] !== undefined) out[k] = String(input[k] ?? "").trim().slice(0, 120);
    for (const k of ["issuerAddress", "remitTo", "footer"]) if (input[k] !== undefined) out[k] = String(input[k] ?? "").trim().slice(0, 1000);
    if (input.termsDays !== undefined) out.termsDays = numberInput(input.termsDays, "payment terms (days)", { max: 365 });
    if (input.nextNumber !== undefined) {
      const n = numberInput(input.nextNumber, "next invoice number", { min: 1, max: 999999999 });
      if (!Number.isInteger(n)) throw fail(400, "The next invoice number is a whole number.");
      // Never back to a number already used.
      if (raw.prepare("SELECT 1 FROM invoices WHERE number = ?").get(`${out.invoicePrefix}${n}`)) throw fail(409, `Invoice ${out.invoicePrefix}${n} already exists.`);
      out.nextNumber = n;
    }
    if (input.qb && typeof input.qb === "object") {
      for (const k of Object.keys(DEFAULT_SETTINGS.qb)) {
        if (input.qb[k] !== undefined) {
          const v = String(input.qb[k] ?? "").trim().slice(0, 100);
          if (!v) throw fail(400, "Each QuickBooks account and item needs a name.");
          out.qb[k] = v;
        }
      }
    }
    db.writeDoc("billing", out);
    return settings();
  }

  // --- the price list ----------------------------------------------------------------------------------

  const itemRow = (r) => r && { id: r.id, name: r.name, unit: r.unit, rate: r.rate, active: Boolean(r.active), position: r.position, used: r.used ?? undefined };
  const ITEM_SELECT = "SELECT i.*, (SELECT count(*) FROM charges c WHERE c.item_id = i.id) AS used FROM charge_items i";

  function items({ includeInactive = true } = {}) {
    return raw.prepare(`${ITEM_SELECT}${includeInactive ? "" : " WHERE i.active = 1"} ORDER BY i.position, i.name COLLATE NOCASE`).all().map(itemRow);
  }

  function itemInput(input, existing = null) {
    const out = {};
    if (input.name !== undefined || !existing) {
      out.name = text(input.name, 80);
      if (!out.name) throw fail(400, "Give the item a name.");
      const clash = raw.prepare("SELECT id FROM charge_items WHERE name = ?").get(out.name);
      if (clash && clash.id !== existing?.id) throw fail(409, `${out.name} is on the price list already.`);
    }
    if (input.unit !== undefined || !existing) out.unit = text(input.unit, 20) || "each";
    if (input.rate !== undefined || !existing) out.rate = numberInput(input.rate, "rate");
    if (input.active !== undefined) out.active = Boolean(input.active);
    return out;
  }

  function createItem(input = {}) {
    const v = itemInput(input);
    const position = (raw.prepare("SELECT max(position) AS p FROM charge_items").get().p ?? -1) + 1;
    const id = raw.prepare("INSERT INTO charge_items (name, unit, rate, active, position, created_at) VALUES (?, ?, ?, 1, ?, ?)").run(v.name, v.unit, v.rate, position, now()).lastInsertRowid;
    return itemRow(raw.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id));
  }

  function updateItem(id, input = {}) {
    const existing = itemRow(raw.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(Number(id)));
    if (!existing) throw fail(404, "No such item.");
    const next = { ...existing, ...itemInput(input, existing) };
    raw.prepare("UPDATE charge_items SET name = ?, unit = ?, rate = ?, active = ? WHERE id = ?").run(next.name, next.unit, next.rate, next.active ? 1 : 0, existing.id);
    return itemRow(raw.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(existing.id));
  }

  /** Removes an item never charged; one that has been is turned off instead, so its charges keep it. */
  function removeItem(id) {
    const existing = itemRow(raw.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(Number(id)));
    if (!existing) throw fail(404, "No such item.");
    if (existing.used) throw fail(409, `${existing.name} has been charged ${existing.used} time${existing.used === 1 ? "" : "s"}; turn it off instead.`);
    raw.prepare("DELETE FROM charge_items WHERE id = ?").run(existing.id);
    return existing;
  }

  // --- charges ----------------------------------------------------------------------------------------

  const CHARGE_SELECT = `SELECT c.*, co.name AS live_name, i.name AS item_name, v.number AS invoice_number, v.status AS invoice_status FROM charges c
    LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN charge_items i ON i.id = c.item_id LEFT JOIN invoices v ON v.id = c.invoice_id`;

  function chargeRow(r) {
    return r && {
      id: r.id,
      companyId: r.company_id,
      companyName: r.live_name || r.company_name,
      date: r.date,
      itemId: r.item_id,
      itemName: r.item_name || null,
      description: r.description,
      quantity: r.quantity,
      unit: r.unit || null,
      rate: r.rate,
      amount: r.amount,
      notes: r.notes || null,
      invoiceId: r.invoice_id || null,
      invoiceNumber: r.invoice_number || null,
      invoiceStatus: r.invoice_status || null,
      billed: Boolean(r.invoice_id),
      createdBy: r.created_by || null,
      createdAt: r.created_at
    };
  }

  /** Limits rows (company column `col`) to the companies a caller sees: a Set of ids, or null for every one. */
  function companyScope(companies, col, where, params) {
    if (!companies) return;
    const ids = [...companies];
    where.push(ids.length ? `${col} IN (${ids.map(() => "?").join(", ")})` : "0");
    params.push(...ids);
  }

  function listCharges({ companies = null, companyId = null, status = null, from = null, to = null, q = "", limit = 500 } = {}) {
    const where = [];
    const params = [];
    companyScope(companies, "c.company_id", where, params);
    if (companyId) { where.push("c.company_id = ?"); params.push(Number(companyId)); }
    if (status === "unbilled") where.push("c.invoice_id IS NULL");
    if (status === "billed") where.push("c.invoice_id IS NOT NULL");
    if (from) { where.push("c.date >= ?"); params.push(dateInput(from, "from date")); }
    if (to) { where.push("c.date <= ?"); params.push(dateInput(to, "to date")); }
    for (const w of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const p = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(c.description LIKE ? ESCAPE '\\' OR coalesce(co.name, c.company_name) LIKE ? ESCAPE '\\' OR coalesce(c.notes, '') LIKE ? ESCAPE '\\')");
      params.push(p, p, p);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = raw.prepare(`${CHARGE_SELECT} ${clause} ORDER BY c.date DESC, c.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 500, 5000));
    const total = raw.prepare(`SELECT count(*) AS n, coalesce(sum(c.amount), 0) AS amount FROM charges c LEFT JOIN companies co ON co.id = c.company_id ${clause}`).get(...params);
    return { charges: rows.map(chargeRow), total: total.n, amount: money(total.amount) };
  }

  const getCharge = (id) => chargeRow(raw.prepare(`${CHARGE_SELECT} WHERE c.id = ?`).get(Number(id)));

  function chargeInput(input, existing = null) {
    const out = {};
    if (input.companyId !== undefined || !existing) {
      const company = directory.getCompany(Number(input.companyId));
      if (!company) throw fail(400, "Choose the company.");
      out.company = company;
    }
    if (input.date !== undefined || !existing) out.date = dateInput(input.date, "date");
    let item = null;
    if (input.itemId !== undefined && input.itemId !== null && input.itemId !== "") {
      item = itemRow(raw.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(Number(input.itemId)));
      if (!item) throw fail(400, "That isn't on the price list.");
      if (!item.active && item.id !== existing?.itemId) throw fail(400, `${item.name} is turned off on the price list.`);
      out.itemId = item.id;
    } else if (input.itemId !== undefined) {
      out.itemId = null;
    }
    // From the price list: its name, unit and rate unless given.
    if (input.description !== undefined || (!existing && !item)) out.description = text(input.description, 200);
    else if (item && (!existing || input.itemId !== undefined)) out.description = item.name;
    if (out.description === null || (out.description === undefined && !existing)) throw fail(400, "Say what the charge is for.");
    if (input.unit !== undefined) out.unit = text(input.unit, 20);
    else if (item && (!existing || input.itemId !== undefined)) out.unit = item.unit;
    if (input.rate !== undefined && input.rate !== "") out.rate = numberInput(input.rate, "rate");
    else if (item && (!existing || input.itemId !== undefined)) out.rate = item.rate;
    else if (!existing) throw fail(400, "Give the rate.");
    if (input.quantity !== undefined || !existing) out.quantity = numberInput(input.quantity ?? 1, "quantity", { min: 0.01, max: 100000 });
    if (input.notes !== undefined) out.notes = text(input.notes, 1000);
    return out;
  }

  function createCharge(input = {}, { by = null } = {}) {
    const v = chargeInput(input);
    const amount = money(v.quantity * v.rate);
    const t = now();
    const id = raw.prepare(`INSERT INTO charges (company_id, company_name, date, item_id, description, quantity, unit, rate, amount, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.company.id, v.company.name, v.date, v.itemId ?? null, v.description, v.quantity, v.unit ?? null, v.rate, amount, v.notes ?? null, by, t, t).lastInsertRowid;
    return getCharge(id);
  }

  function updateCharge(id, input = {}) {
    const existing = getCharge(id);
    if (!existing) throw fail(404, "No such charge.");
    if (existing.billed) throw fail(409, `This charge is on invoice ${existing.invoiceNumber || "(a draft)"}; take it off the invoice first.`);
    const v = chargeInput(input, existing);
    const next = { ...existing, ...v, companyId: v.company ? v.company.id : existing.companyId, companyName: v.company ? v.company.name : existing.companyName };
    raw.prepare("UPDATE charges SET company_id = ?, company_name = ?, date = ?, item_id = ?, description = ?, quantity = ?, unit = ?, rate = ?, amount = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(next.companyId, next.companyName, next.date, next.itemId ?? null, next.description, next.quantity, next.unit ?? null, next.rate, money(next.quantity * next.rate), next.notes ?? null, now(), existing.id);
    return getCharge(existing.id);
  }

  function removeCharge(id) {
    const existing = getCharge(id);
    if (!existing) throw fail(404, "No such charge.");
    if (existing.billed) throw fail(409, `This charge is on invoice ${existing.invoiceNumber || "(a draft)"}; take it off the invoice first.`);
    raw.prepare("DELETE FROM charges WHERE id = ?").run(existing.id);
    return existing;
  }

  // --- invoices ---------------------------------------------------------------------------------------

  const INVOICE_SELECT = `SELECT v.*, co.name AS live_name, (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.invoice_id = v.id) AS paid FROM invoices v LEFT JOIN companies co ON co.id = v.company_id`;

  const lineRow = (r) => ({ id: r.id, kind: r.kind, description: r.description, quantity: r.quantity, unit: r.unit || null, rate: r.rate, amount: r.amount, leaseId: r.lease_id || null, period: r.period || null, chargeId: r.charge_id || null, itemName: r.item_name || null });
  const paymentRow = (r) => r && { id: r.id, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number ?? undefined, companyName: r.company_name ?? undefined, date: r.date, amount: r.amount, method: r.method, reference: r.reference || null, notes: r.notes || null, source: r.source, qboId: r.qbo_id || null, createdBy: r.created_by || null, createdAt: r.created_at };

  /** What an invoice is now: draft, void, paid, partly paid, overdue (past due with a balance) or open. */
  function stateOf(r, balance, day) {
    if (r.status === "draft" || r.status === "void") return r.status;
    if (balance <= 0.004) return "paid";
    if (r.due_date < day) return "overdue";
    return r.paid > 0 ? "partial" : "open";
  }

  function invoiceRow(r, { full = false, day = today() } = {}) {
    if (!r) return null;
    const paid = money(r.paid || 0);
    const balance = r.status === "void" || r.status === "draft" ? 0 : money(r.total - paid);
    const out = {
      id: r.id,
      number: r.number || null,
      companyId: r.company_id,
      // A draft follows the company's name; an issued invoice keeps the name it was billed to.
      companyName: r.status === "draft" ? r.live_name || r.company_name : r.company_name,
      period: r.period || null,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      status: r.status,
      state: stateOf({ ...r, paid }, balance, day),
      daysOverdue: r.status === "issued" && balance > 0.004 && r.due_date < day ? daysBetween(r.due_date, day) : 0,
      total: r.total,
      paid,
      balance,
      notes: r.notes || null,
      qboId: r.qbo_id || null,
      qboSyncedAt: r.qbo_synced_at || null,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
      issuedBy: r.issued_by || null,
      issuedAt: r.issued_at || null,
      voidedBy: r.voided_by || null,
      voidedAt: r.voided_at || null
    };
    if (full) {
      out.lines = raw.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id").all(r.id).map(lineRow);
      out.payments = raw.prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id").all(r.id).map(paymentRow);
    }
    return out;
  }

  function getInvoice(id, { companies = null } = {}) {
    const inv = invoiceRow(raw.prepare(`${INVOICE_SELECT} WHERE v.id = ?`).get(Number(id)), { full: true });
    if (!inv || (companies && !companies.has(inv.companyId))) return null;
    return inv;
  }

  function mustInvoice(id, companies) {
    const inv = getInvoice(id, { companies });
    if (!inv) throw fail(404, "No such invoice.");
    return inv;
  }

  /**
   * Invoices the caller sees: of a state (draft, open, partial, overdue, paid, void; unpaid:
   * open, partial and overdue), for a company or month, issued between two dates, or matching
   * words (number, company).
   */
  function listInvoices({ companies = null, state = null, companyId = null, period = null, from = null, to = null, q = "", limit = 500 } = {}) {
    const where = [];
    const params = [];
    companyScope(companies, "v.company_id", where, params);
    if (companyId) { where.push("v.company_id = ?"); params.push(Number(companyId)); }
    if (period) { where.push("v.period = ?"); params.push(periodInput(period)); }
    if (from) { where.push("v.issue_date >= ?"); params.push(dateInput(from, "from date")); }
    if (to) { where.push("v.issue_date <= ?"); params.push(dateInput(to, "to date")); }
    for (const w of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const p = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(coalesce(v.number, '') LIKE ? ESCAPE '\\' OR coalesce(co.name, v.company_name) LIKE ? ESCAPE '\\')");
      params.push(p, p);
    }
    const day = today();
    const rows = raw.prepare(`${INVOICE_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY v.issue_date DESC, v.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 500, 5000))
      .map((r) => invoiceRow(r, { day }));
    const wanted = state === "unpaid" ? ["open", "partial", "overdue"] : state ? [state] : null;
    return wanted ? rows.filter((i) => wanted.includes(i.state)) : rows;
  }

  function recalc(id) {
    const total = raw.prepare("SELECT coalesce(sum(amount), 0) AS t FROM invoice_lines WHERE invoice_id = ?").get(id).t;
    raw.prepare("UPDATE invoices SET total = ?, updated_at = ? WHERE id = ?").run(money(total), now(), id);
  }

  function nextPosition(invoiceId) {
    return (raw.prepare("SELECT max(position) AS p FROM invoice_lines WHERE invoice_id = ?").get(invoiceId).p ?? -1) + 1;
  }

  /** Whether a lease's month is on an invoice that isn't void. */
  const rentInvoiced = (leaseId, period) => Boolean(raw.prepare("SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.lease_id = ? AND l.period = ? AND i.status <> 'void'").get(leaseId, period));

  function putRentLine(invoiceId, rent) {
    const s = settings();
    raw.prepare("INSERT INTO invoice_lines (invoice_id, kind, description, quantity, rate, amount, lease_id, period, item_name, position) VALUES (?, 'rent', ?, 1, ?, ?, ?, ?, ?, ?)")
      .run(invoiceId, rent.description, rent.amount, rent.amount, rent.leaseId, rent.period, s.qb.rentItem, nextPosition(invoiceId));
  }

  function putChargeLine(invoiceId, charge) {
    const s = settings();
    raw.prepare("INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit, rate, amount, charge_id, item_name, position) VALUES (?, 'charge', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(invoiceId, `${charge.description} (${charge.date})${charge.notes ? `: ${charge.notes}` : ""}`.slice(0, 300), charge.quantity, charge.unit, charge.rate, charge.amount, charge.id, charge.itemName || s.qb.otherItem, nextPosition(invoiceId));
    raw.prepare("UPDATE charges SET invoice_id = ? WHERE id = ?").run(invoiceId, charge.id);
  }

  function newDraft(company, { period = null, issueDate = null, notes = null, by = null }) {
    const s = settings();
    const issue = issueDate ? dateInput(issueDate, "invoice date") : today();
    const t = now();
    return Number(raw.prepare(`INSERT INTO invoices (company_id, company_name, period, issue_date, due_date, status, total, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?)`).run(company.id, company.name, period, issue, addDays(issue, Number(s.termsDays) || 0), notes, by, t, t).lastInsertRowid);
  }

  /**
   * Drafts a month's invoices: for each company (among `companies`, or `companyIds`) its leases'
   * rent for the month not invoiced yet, and its unbilled charges up to the month's end. A
   * company with a draft for that month already has the new lines added to it. Returns the
   * drafts made or added to, and what was left out and why.
   */
  function generate(period, { companies = null, companyIds = null, issueDate = null, by = null, scope = null } = {}) {
    periodInput(period);
    const { last } = monthBounds(period);
    const wanted = (id) => (!companies || companies.has(id)) && (!companyIds || companyIds.includes(id));
    const work = new Map(); // companyId -> { company, rents: [], charges: [] }
    const skipped = [];
    const entry = (id, name) => {
      if (!work.has(id)) work.set(id, { company: { id, name }, rents: [], charges: [] });
      return work.get(id);
    };
    for (const lease of leases.coveringMonth(period, { scope })) {
      if (!lease.companyId || !wanted(lease.companyId)) continue;
      if (rentInvoiced(lease.id, period)) continue;
      const rent = leases.rentFor(lease.id, period);
      if (!rent) continue;
      if (rent.amount === null) {
        skipped.push({ companyName: lease.companyName, leaseId: lease.id, reason: `Rent for lease ${lease.reference || `#${lease.id}`} can't be worked out: ${rent.problem}.` });
        continue;
      }
      entry(lease.companyId, lease.companyName).rents.push(rent);
    }
    for (const c of raw.prepare(`${CHARGE_SELECT} WHERE c.invoice_id IS NULL AND c.date <= ? AND c.company_id IS NOT NULL ORDER BY c.date, c.id`).all(last).map(chargeRow)) {
      if (!wanted(c.companyId)) continue;
      entry(c.companyId, c.companyName).charges.push(c);
    }
    const made = [];
    db.transaction(() => {
      for (const { company, rents, charges } of work.values()) {
        if (!rents.length && !charges.length) continue;
        const existing = raw.prepare("SELECT id FROM invoices WHERE company_id = ? AND period = ? AND status = 'draft' ORDER BY id LIMIT 1").get(company.id, period);
        const id = existing ? existing.id : newDraft(company, { period, issueDate, by });
        for (const r of rents) putRentLine(id, r);
        for (const c of charges) putChargeLine(id, c);
        recalc(id);
        made.push({ id, added: !existing, rents: rents.length, charges: charges.length });
      }
    });
    return { period, invoices: made.map((m) => ({ ...invoiceRow(raw.prepare(`${INVOICE_SELECT} WHERE v.id = ?`).get(m.id)), newDraft: m.added, rentLines: m.rents, chargeLines: m.charges })), skipped };
  }

  /** A blank draft for a company, to fill by hand. */
  function createInvoice(input = {}, { companies = null, by = null } = {}) {
    const company = directory.getCompany(Number(input.companyId));
    if (!company || (companies && !companies.has(company.id))) throw fail(400, "Choose the company.");
    const period = input.period ? periodInput(input.period) : null;
    const id = newDraft(company, { period, issueDate: input.issueDate || null, notes: text(input.notes, 2000), by });
    return getInvoice(id);
  }

  function mustDraft(id, companies) {
    const inv = mustInvoice(id, companies);
    if (inv.status !== "draft") throw fail(409, `Invoice ${inv.number} has been issued; void it and make another to change its lines.`);
    return inv;
  }

  /**
   * Adds a line to a draft: { chargeId } (an unbilled charge of the same company), { leaseId,
   * period } (that month's rent), or an adjustment { description, quantity, rate } (a negative
   * rate for a credit).
   */
  function addLine(invoiceId, input = {}, { companies = null } = {}) {
    const inv = mustDraft(invoiceId, companies);
    db.transaction(() => {
      if (input.chargeId) {
        const charge = getCharge(input.chargeId);
        if (!charge || charge.companyId !== inv.companyId) throw fail(400, "That charge isn't this company's.");
        if (charge.billed) throw fail(409, `That charge is on invoice ${charge.invoiceNumber || "(a draft)"} already.`);
        putChargeLine(inv.id, charge);
      } else if (input.leaseId) {
        const period = periodInput(input.period);
        const lease = leases.get(input.leaseId);
        if (!lease || lease.companyId !== inv.companyId) throw fail(400, "That lease isn't this company's.");
        if (rentInvoiced(lease.id, period)) throw fail(409, `${periodName(period)}'s rent for this lease is invoiced already.`);
        const rent = leases.rentFor(lease.id, period);
        if (!rent) throw fail(400, `The lease doesn't cover ${periodName(period)}.`);
        if (rent.amount === null) throw fail(400, `Its rent can't be worked out: ${rent.problem}.`);
        putRentLine(inv.id, rent);
      } else {
        const description = text(input.description, 300);
        if (!description) throw fail(400, "Say what the line is for.");
        const quantity = numberInput(input.quantity ?? 1, "quantity", { min: 0.01, max: 100000 });
        const rate = numberInput(input.rate, "amount", { min: -MAX_AMOUNT });
        raw.prepare("INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit, rate, amount, item_name, position) VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?, ?)")
          .run(inv.id, description, quantity, text(input.unit, 20), rate, money(quantity * rate), settings().qb.otherItem, nextPosition(inv.id));
      }
      recalc(inv.id);
    });
    return getInvoice(inv.id);
  }

  /** Takes a line off a draft; a charge on it goes back to unbilled. */
  function removeLine(invoiceId, lineId, { companies = null } = {}) {
    const inv = mustDraft(invoiceId, companies);
    const line = inv.lines.find((l) => l.id === Number(lineId));
    if (!line) throw fail(404, "No such line on this invoice.");
    db.transaction(() => {
      if (line.chargeId) raw.prepare("UPDATE charges SET invoice_id = NULL WHERE id = ? AND invoice_id = ?").run(line.chargeId, inv.id);
      raw.prepare("DELETE FROM invoice_lines WHERE id = ?").run(line.id);
      recalc(inv.id);
    });
    return getInvoice(inv.id);
  }

  /** Changes a draft's dates, or any invoice's notes. */
  function updateInvoice(id, input = {}, { companies = null } = {}) {
    const inv = mustInvoice(id, companies);
    if (inv.status === "void") throw fail(409, "A void invoice can't be changed.");
    const issue = input.issueDate !== undefined ? dateInput(input.issueDate, "invoice date") : inv.issueDate;
    const due = input.dueDate !== undefined ? dateInput(input.dueDate, "due date") : input.issueDate !== undefined ? addDays(issue, Number(settings().termsDays) || 0) : inv.dueDate;
    if ((issue !== inv.issueDate || due !== inv.dueDate) && inv.status !== "draft") throw fail(409, "An issued invoice keeps its dates; void it and make another.");
    if (due < issue) throw fail(400, "The due date is before the invoice date.");
    const notes = input.notes !== undefined ? text(input.notes, 2000) : inv.notes;
    raw.prepare("UPDATE invoices SET issue_date = ?, due_date = ?, notes = ?, updated_at = ? WHERE id = ?").run(issue, due, notes, now(), inv.id);
    return getInvoice(inv.id);
  }

  /** Issues a draft: it gets the next number and can then be paid, printed and sent to QuickBooks. */
  function issue(id, { companies = null, by = null } = {}) {
    const inv = mustDraft(id, companies);
    if (!inv.lines.length) throw fail(400, "Add at least one line first.");
    if (inv.total < 0) throw fail(400, "An invoice can't total less than nothing.");
    db.transaction(() => {
      const s = settings();
      let n = Number(s.nextNumber) || 1;
      while (raw.prepare("SELECT 1 FROM invoices WHERE number = ?").get(`${s.invoicePrefix}${n}`)) n += 1;
      raw.prepare("UPDATE invoices SET number = ?, status = 'issued', issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ?").run(`${s.invoicePrefix}${n}`, by, now(), now(), inv.id);
      db.writeDoc("billing", { ...db.readDoc("billing", {}), nextNumber: n + 1 });
    });
    return getInvoice(inv.id);
  }

  /** Voids an issued invoice (with no payments); its number stays, and its charges and rent months can be invoiced again. */
  function voidInvoice(id, { companies = null, by = null } = {}) {
    const inv = mustInvoice(id, companies);
    if (inv.status === "draft") throw fail(409, "Delete a draft instead.");
    if (inv.status === "void") throw fail(409, "This invoice is void already.");
    if (inv.payments.length) throw fail(409, "This invoice has payments; remove them first.");
    db.transaction(() => {
      raw.prepare("UPDATE charges SET invoice_id = NULL WHERE invoice_id = ?").run(inv.id);
      raw.prepare("UPDATE invoices SET status = 'void', voided_by = ?, voided_at = ?, updated_at = ? WHERE id = ?").run(by, now(), now(), inv.id);
    });
    return getInvoice(inv.id);
  }

  /** Deletes a draft; its charges go back to unbilled. */
  function removeDraft(id, { companies = null } = {}) {
    const inv = mustDraft(id, companies);
    db.transaction(() => {
      raw.prepare("UPDATE charges SET invoice_id = NULL WHERE invoice_id = ?").run(inv.id);
      raw.prepare("DELETE FROM invoices WHERE id = ?").run(inv.id);
    });
    return inv;
  }

  /** Marks an invoice as sent to QuickBooks (its id there). */
  function markSynced(id, qboId) {
    raw.prepare("UPDATE invoices SET qbo_id = ?, qbo_synced_at = ? WHERE id = ?").run(String(qboId), now(), Number(id));
  }

  // --- payments ---------------------------------------------------------------------------------------

  const PAYMENT_SELECT = "SELECT p.*, v.number AS invoice_number, coalesce(co.name, v.company_name) AS company_name FROM payments p JOIN invoices v ON v.id = p.invoice_id LEFT JOIN companies co ON co.id = v.company_id";

  /** Records a payment against an issued invoice: no more than it still owes. */
  function recordPayment(invoiceId, input = {}, { companies = null, by = null, source = "app", qboId = null } = {}) {
    const inv = mustInvoice(invoiceId, companies);
    if (inv.status !== "issued") throw fail(409, inv.status === "draft" ? "Issue the invoice before recording a payment." : "This invoice is void.");
    const amount = money(numberInput(input.amount, "amount", { min: 0.01 }));
    if (amount > inv.balance + 0.004) throw fail(400, `That's more than the $${inv.balance.toFixed(2)} still owed on ${inv.number}.`);
    const method = PAYMENT_METHODS.find((m) => m.toLowerCase() === String(input.method || "").trim().toLowerCase());
    if (!method) throw fail(400, `The method is one of: ${PAYMENT_METHODS.join(", ")}.`);
    const date = dateInput(input.date || today(), "payment date");
    const id = raw.prepare("INSERT INTO payments (invoice_id, date, amount, method, reference, notes, source, qbo_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(inv.id, date, amount, method, text(input.reference, 80), text(input.notes, 1000), source, qboId, by, now()).lastInsertRowid;
    return { payment: paymentRow(raw.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(id)), invoice: getInvoice(inv.id) };
  }

  function getPayment(id) {
    return paymentRow(raw.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(Number(id)));
  }

  function removePayment(id, { companies = null } = {}) {
    const p = getPayment(id);
    if (!p) throw fail(404, "No such payment.");
    mustInvoice(p.invoiceId, companies);
    raw.prepare("DELETE FROM payments WHERE id = ?").run(p.id);
    return { payment: p, invoice: getInvoice(p.invoiceId) };
  }

  function markPaymentSynced(id, qboId) {
    raw.prepare("UPDATE payments SET qbo_id = ? WHERE id = ?").run(String(qboId), Number(id));
  }

  const paymentByQbo = (qboId) => paymentRow(raw.prepare(`${PAYMENT_SELECT} WHERE p.qbo_id = ?`).get(String(qboId)));
  const invoiceByQbo = (qboId) => raw.prepare("SELECT id FROM invoices WHERE qbo_id = ?").get(String(qboId))?.id ?? null;

  function listPayments({ companies = null, companyId = null, from = null, to = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    companyScope(companies, "v.company_id", where, params);
    if (companyId) { where.push("v.company_id = ?"); params.push(Number(companyId)); }
    if (from) { where.push("p.date >= ?"); params.push(dateInput(from, "from date")); }
    if (to) { where.push("p.date <= ?"); params.push(dateInput(to, "to date")); }
    return raw.prepare(`${PAYMENT_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY p.date DESC, p.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 1000, 10000)).map(paymentRow);
  }

  // --- balances ----------------------------------------------------------------------------------------

  /**
   * What each company owes on issued invoices, by how long past due: not yet due, 1-30, 31-60,
   * 61-90 and over 90 days. Companies that owe nothing are left out.
   */
  function aging({ companies = null } = {}) {
    const day = today();
    const by = new Map();
    for (const inv of listInvoices({ companies, state: "unpaid", limit: 5000 })) {
      if (!by.has(inv.companyId)) by.set(inv.companyId, { companyId: inv.companyId, companyName: inv.companyName, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0, invoices: 0, oldestDue: inv.dueDate });
      const row = by.get(inv.companyId);
      const late = inv.dueDate < day ? daysBetween(inv.dueDate, day) : 0;
      const bucket = late === 0 ? "current" : late <= 30 ? "d30" : late <= 60 ? "d60" : late <= 90 ? "d90" : "over90";
      row[bucket] = money(row[bucket] + inv.balance);
      row.total = money(row.total + inv.balance);
      row.invoices += 1;
      if (inv.dueDate < row.oldestDue) row.oldestDue = inv.dueDate;
    }
    const rows = [...by.values()].sort((a, b) => b.total - a.total);
    const totals = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
    for (const r of rows) for (const k of Object.keys(totals)) totals[k] = money(totals[k] + r[k]);
    return { asOf: day, companies: rows, totals };
  }

  // --- exports for QuickBooks ----------------------------------------------------------------------------

  const csvCell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
  const usDate = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
  const amt = (n) => Number(n).toFixed(2);
  const fullInvoices = (list) => list.filter((i) => i.status === "issued").map((i) => getInvoice(i.id));

  /** Issued invoices as CSV in QuickBooks Online's invoice import layout: a row per line. */
  function invoicesCsv(list) {
    const s = settings();
    const rows = [["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount"]];
    for (const inv of fullInvoices(list)) {
      for (const l of inv.lines) {
        rows.push([inv.number, inv.companyName, usDate(inv.issueDate), usDate(inv.dueDate), `Net ${s.termsDays}`, inv.notes || "", l.itemName || (l.kind === "rent" ? s.qb.rentItem : s.qb.otherItem), l.description, l.quantity, amt(l.rate), amt(l.amount)]);
      }
    }
    return csv(rows);
  }

  /** Payments as CSV: date, customer, invoice, amount, method, reference. */
  function paymentsCsv(list) {
    const rows = [["Date", "Customer", "InvoiceNo", "Amount", "PaymentMethod", "ReferenceNo", "Memo"]];
    for (const p of list) rows.push([usDate(p.date), p.companyName, p.invoiceNumber, amt(p.amount), p.method, p.reference || "", p.notes || ""]);
    return csv(rows);
  }

  const iifCell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").replace(/"/g, "'");
  const iif = (rows) => `${rows.map((r) => r.map(iifCell).join("\t")).join("\r\n")}\r\n`;

  /**
   * Issued invoices as IIF for QuickBooks Desktop: the customers and items they use (QuickBooks
   * skips those it has), then each invoice as a transaction against accounts receivable, a split
   * per line against the rent or charges income account.
   */
  function invoicesIif(list) {
    const s = settings();
    const invs = fullInvoices(list);
    const rows = [["!CUST", "NAME"]];
    for (const name of [...new Set(invs.map((i) => i.companyName))]) rows.push(["CUST", name]);
    rows.push(["!INVITEM", "NAME", "INVITEMTYPE", "ACCNT"]);
    const itemsUsed = new Map();
    for (const inv of invs) for (const l of inv.lines) {
      const name = l.itemName || (l.kind === "rent" ? s.qb.rentItem : s.qb.otherItem);
      if (!itemsUsed.has(name)) itemsUsed.set(name, l.kind === "rent" ? s.qb.rentAccount : s.qb.chargeAccount);
    }
    for (const [name, account] of itemsUsed) rows.push(["INVITEM", name, "SERV", account]);
    rows.push(["!TRNS", "TRNSID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO", "DUEDATE", "TERMS"]);
    rows.push(["!SPL", "SPLID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO", "QNTY", "PRICE", "INVITEM"]);
    rows.push(["!ENDTRNS"]);
    for (const inv of invs) {
      rows.push(["TRNS", "", "INVOICE", usDate(inv.issueDate), s.qb.arAccount, inv.companyName, amt(inv.total), inv.number, inv.notes || "", usDate(inv.dueDate), `Net ${s.termsDays}`]);
      for (const l of inv.lines) {
        const name = l.itemName || (l.kind === "rent" ? s.qb.rentItem : s.qb.otherItem);
        rows.push(["SPL", "", "INVOICE", usDate(inv.issueDate), l.kind === "rent" ? s.qb.rentAccount : s.qb.chargeAccount, inv.companyName, amt(-l.amount), inv.number, l.description, -l.quantity, amt(l.rate), name]);
      }
      rows.push(["ENDTRNS"]);
    }
    return iif(rows);
  }

  /** Payments as IIF for QuickBooks Desktop: into undeposited funds, out of accounts receivable. */
  function paymentsIif(list) {
    const s = settings();
    const rows = [
      ["!TRNS", "TRNSID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO", "PAYMETH"],
      ["!SPL", "SPLID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO"],
      ["!ENDTRNS"]
    ];
    for (const p of list) {
      rows.push(["TRNS", "", "PAYMENT", usDate(p.date), s.qb.depositAccount, p.companyName, amt(p.amount), p.reference || "", `Payment on ${p.invoiceNumber}`, p.method]);
      rows.push(["SPL", "", "PAYMENT", usDate(p.date), s.qb.arAccount, p.companyName, amt(-p.amount), p.invoiceNumber, `Payment on ${p.invoiceNumber}`]);
      rows.push(["ENDTRNS"]);
    }
    return iif(rows);
  }

  return {
    settings, saveSettings,
    items, createItem, updateItem, removeItem,
    listCharges, getCharge, createCharge, updateCharge, removeCharge,
    listInvoices, getInvoice, generate, createInvoice, addLine, removeLine, updateInvoice, issue, voidInvoice, removeDraft, markSynced, invoiceByQbo,
    recordPayment, getPayment, removePayment, listPayments, markPaymentSynced, paymentByQbo,
    aging,
    invoicesCsv, paymentsCsv, invoicesIif, paymentsIif,
    today
  };
}

module.exports = { createBilling, PAYMENT_METHODS, LINE_KINDS };
