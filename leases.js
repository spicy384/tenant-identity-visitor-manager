/**
 * Leases: a company's agreement for offices, from a start date to an end date (its last day;
 * none: it runs on, month to month). A lease's offices are its office assignments
 * (facilities.js), which carry the lease's company and dates, so an office still has one
 * company at a time and its history stays. An assignment made outside a lease (Rooms, a
 * company's page) gets a lease of its own: every assignment belongs to one.
 *
 * Rent comes from the rates (an office's custom rate or monthly amount on the lease, else its square
 * feet times the lease's rate for its classification, else the rate that applies, or the office's own fixed monthly
 * rent, as facilities.js works it out) or is
 * a fixed monthly amount for the lease. That is the first year's rent: it goes up by escalation_pct
 * on each anniversary of its commencement (the start, unless the lease commences on another day),
 * so a lease that began years ago is entered as it began. Each office's rent is rounded to the
 * cent every year and the lease's rent is their sum, as in finance's escalation tracker. Rent is billed from the start whatever the
 * commencement. A month the lease covers only part of is charged for the days it covers. Money
 * is in dollars, rounded to cents.
 *
 * A lease also keeps its papers: the agreement, mods and amendments, and supporting documents, as stored
 * files, which go when the lease does.
 */
const { localParts } = require("./visit-clock");
const { commencementOf, anniversary, increasesOn, factorAfter, escalate } = require("./rent-terms");

const RENT_MODES = ["rates", "fixed"];
const DOCUMENT_KINDS = ["agreement", "amendment", "supporting"];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;
const MAX_AMOUNT = 100000000;
const MAX_RATE = 100000;
// A lease whose end is this close shows as ending.
const ENDING_DAYS = 90;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const money = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const rate4 = (n) => (n === null || n === undefined ? null : Math.round(n * 10000) / 10000);
const yearlyOf = (monthly) => (monthly === null ? null : money(monthly * 12));
const text = (v, max) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

function dateInput(value, label, { optional = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(400, `Give the ${label}.`);
  }
  const m = DATE_RE.exec(String(value));
  const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!m || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw fail(400, `The ${label} must be a date (YYYY-MM-DD).`);
  return String(value);
}

function amountInput(value, label, { optional = true, max = MAX_AMOUNT, places = 2 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(400, `Give the ${label}.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw fail(400, `The ${label} must be a number from 0 to ${max.toLocaleString("en-US")}.`);
  return Math.round(n * 10 ** places) / 10 ** places;
}

/** A month as YYYY-MM, checked. */
function periodInput(value) {
  const m = PERIOD_RE.exec(String(value || ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw fail(400, "The month must be YYYY-MM.");
  return String(value);
}

/** The first and last days of a month, and how many days it has. */
function monthBounds(period) {
  const [y, m] = period.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(days).padStart(2, "0")}`, days };
}

const dayNumber = (date) => Math.round(Date.UTC(...date.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) / 86400000);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const periodName = (period) => `${MONTHS[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;

function createLeases({ db, facilities, directory, files, now = Date.now }) {
  const raw = db.raw;

  const today = () => {
    const p = localParts(now(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  };

  // --- every assignment in a lease ----------------------------------------------------------------

  /**
   * Gives each office assignment that has no lease one: those made together (same company and
   * dates, as "Assign offices" makes them) share one. Run at start-up and after assignments
   * are made outside a lease.
   */
  function adoptAssignments({ by = null } = {}) {
    const loose = raw.prepare("SELECT * FROM office_assignments WHERE lease_id IS NULL ORDER BY company_id, start_date, end_date, id").all();
    if (!loose.length) return 0;
    const groups = new Map();
    for (const a of loose) {
      const key = `${a.company_id}|${a.company_name}|${a.start_date}|${a.end_date || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    db.transaction(() => {
      for (const list of groups.values()) {
        const a = list[0];
        const t = now();
        const id = raw.prepare(`INSERT INTO leases (company_id, company_name, start_date, end_date, rent_mode, notes, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, 'rates', ?, ?, ?, ?, ?)`).run(a.company_id, a.company_name, a.start_date, a.end_date, list.length === 1 ? a.notes : null, a.created_by || by, a.created_at || t, by, t).lastInsertRowid;
        const put = raw.prepare("UPDATE office_assignments SET lease_id = ? WHERE id = ?");
        for (const x of list) put.run(id, x.id);
      }
    });
    return groups.size;
  }
  adoptAssignments();

  // --- reading ------------------------------------------------------------------------------------

  const LEASE_SELECT = "SELECT l.*, c.name AS live_name FROM leases l LEFT JOIN companies c ON c.id = l.company_id";

  /** A lease's offices (with their rents from the rates, for its share of each), and the sites they are at. */
  function officesOf(lease) {
    const until = lease.end_date || "9999-12-31";
    return raw.prepare("SELECT id, office_id, base_rate, base_monthly, share_pct FROM office_assignments WHERE lease_id = ? ORDER BY id").all(lease.id).map((a) => {
      const o = facilities.getOffice(a.office_id);
      if (!o) return null;
      const sharePct = a.share_pct ?? 100;
      const { rate, source, monthly } = facilities.rentOf(o, o.siteId, lease.company_id, lease, { baseRate: a.base_rate, baseMonthly: a.base_monthly, sharePct });
      return {
        assignmentId: a.id, officeId: o.id, name: o.name, floorId: o.floorId, floorName: o.floorName, siteId: o.siteId, siteName: o.siteName,
        sqft: o.sqft, classKey: o.classId || 0, className: o.classification?.name || "Unclassified", rate, rateSource: source, monthly,
        // The custom rate or monthly amount the lease gives this office, at its start.
        ownRate: a.base_rate ?? null, ownMonthly: a.base_monthly ?? null,
        // How much of the room this lease has, and who else has some of it during the lease.
        sharePct,
        sharedWith: o.assignments.filter((x) => x.id !== a.id && x.startDate <= until && (!x.endDate || x.endDate >= lease.start_date))
          .map((x) => ({ companyId: x.companyId, companyName: x.companyName, sharePct: x.sharePct, leaseId: x.leaseId }))
      };
    }).filter(Boolean);
  }

  function statusOf(r, day = today()) {
    if (r.start_date > day) return "upcoming";
    if (r.end_date && r.end_date < day) return "ended";
    if (r.end_date && dayNumber(r.end_date) - dayNumber(day) <= ENDING_DAYS) return "ending";
    return "active";
  }

  /**
   * The full monthly rent after `n` yearly increases: the fixed amount, or the sum of its offices'
   * rents from the rates, each rounded to the cent every year. Null when one of those is missing.
   */
  function monthlyAfter(r, offices, n) {
    if (r.rent_mode === "fixed") return r.monthly_rent === null || r.monthly_rent === undefined ? null : escalate(r.monthly_rent, r, n);
    const parts = offices.map((o) => o.monthly);
    if (!parts.length || parts.some((m) => m === null)) return null;
    return money(parts.reduce((total, monthly) => total + escalate(monthly, r, n), 0));
  }

  /**
   * The full monthly rent on `date` (before any part-month): the first year's, up by the yearly
   * increase for each anniversary of its commencement passed (none before it commences).
   */
  function monthlyOn(r, offices, date) {
    return monthlyAfter(r, offices, increasesOn(r, date));
  }

  /** The one rate per square foot all a lease's offices have in the first year, if they do. */
  function sharedRate(r, offices) {
    const rates = [...new Set(offices.map((o) => o.rate))];
    return r.rent_mode === "rates" && rates.length === 1 ? rates[0] : null;
  }

  /**
   * A lease's rent year by year as of `asOf`, when it has a yearly increase: from when it starts,
   * up to the year after `asOf` (or its last). Each is { from, increases, rate, monthly, yearly, when }, when
   * being past, now or next.
   */
  function scheduleOf(r, offices, asOf) {
    if (!r.escalation_pct) return [];
    const commences = commencementOf(r);
    const rate = sharedRate(r, offices);
    const current = increasesOn(r, asOf);
    const rows = [];
    for (let n = 0; n <= 100; n += 1) {
      const from = anniversary(commences, n);
      if (r.end_date && n > 0 && from > r.end_date) break;
      const monthly = monthlyAfter(r, offices, n);
      rows.push({
        from: n === 0 && r.start_date < from ? r.start_date : from,
        increases: n,
        rate: rate === null ? null : rate4(rate * factorAfter(r, n)),
        monthly,
        yearly: yearlyOf(monthly),
        when: n < current ? "past" : n === current ? "now" : "next"
      });
      if (n > current) break;
    }
    return rows;
  }

  function leaseOut(r, { day = today() } = {}) {
    if (!r) return null;
    const offices = officesOf(r);
    // Rent now; not started yet, when it starts; ended, when it ended.
    const asOf = r.start_date > day ? r.start_date : r.end_date && r.end_date < day ? r.end_date : day;
    const increases = increasesOn(r, asOf);
    const k = factorAfter(r, increases);
    const shared = sharedRate(r, offices);
    const currentMonthly = monthlyOn(r, offices, asOf);
    return {
      id: r.id,
      reference: r.reference || null,
      companyId: r.company_id,
      companyName: r.live_name || r.company_name,
      startDate: r.start_date,
      // Always a date: the start when it commences then.
      commencementDate: commencementOf(r),
      commencementSet: Boolean(r.commencement_date),
      endDate: r.end_date || null,
      status: statusOf(r, day),
      rentMode: r.rent_mode,
      monthlyRent: r.monthly_rent ?? null,
      classRates: facilities.leaseRates(r.id),
      escalationPct: r.escalation_pct ?? null,
      deposit: r.deposit ?? null,
      baseMonthly: monthlyAfter(r, offices, 0),
      currentMonthly,
      currentYearly: yearlyOf(currentMonthly),
      // The rate per square foot now, when its offices have just one.
      currentRate: shared === null ? null : rate4(shared * k),
      increases,
      schedule: scheduleOf(r, offices, asOf),
      offices: offices.map((o) => {
        const monthly = o.monthly === null ? null : escalate(o.monthly, r, increases);
        return { ...o, currentRate: o.rate === null ? null : rate4(o.rate * k), currentMonthly: monthly, currentYearly: yearlyOf(monthly) };
      }),
      sites: [...new Map(offices.map((o) => [o.siteId, { id: o.siteId, name: o.siteName }])).values()],
      sqft: money(offices.reduce((n, o) => n + ((o.sqft || 0) * o.sharePct) / 100, 0)),
      // Months already invoiced (rent lines on invoices that aren't void).
      invoiced: raw.prepare(`SELECT DISTINCT l.period FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.lease_id = ? AND i.status <> 'void' ORDER BY l.period`).all(r.id).map((x) => x.period),
      documents: documentsOf(r.id),
      notes: r.notes || null,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
      updatedBy: r.updated_by || null,
      updatedAt: r.updated_at
    };
  }

  /** A lease's documents, without their contents: the agreement, then amendments, then the rest, oldest first. */
  function documentsOf(leaseId) {
    return raw.prepare(`SELECT d.id, d.lease_id AS leaseId, d.kind, d.description, d.created_by AS createdBy, d.created_at AS createdAt, f.ref, f.name, f.type, f.size
      FROM lease_documents d JOIN stored_files f ON f.id = d.file_id WHERE d.lease_id = ?
      ORDER BY CASE d.kind WHEN 'agreement' THEN 0 WHEN 'amendment' THEN 1 ELSE 2 END, d.created_at, d.id`).all(leaseId);
  }

  /** Whether a caller limited to `scope` sites sees a lease: one of its offices is at their sites (or it has none). */
  function visible(lease, scope) {
    if (!scope) return true;
    if (!lease.offices.length) return true;
    return lease.offices.some((o) => scope.has(o.siteId));
  }

  function get(id, { scope = null } = {}) {
    const lease = leaseOut(raw.prepare(`${LEASE_SELECT} WHERE l.id = ?`).get(Number(id)));
    return lease && visible(lease, scope) ? lease : null;
  }

  /**
   * Leases the caller sees: for a company, of a status (upcoming, active, ending, ended, or
   * current: active and ending), or matching words (company, reference, office).
   */
  function list({ scope = null, companyId = null, status = null, q = "" } = {}) {
    const where = [];
    const params = [];
    if (companyId) { where.push("l.company_id = ?"); params.push(Number(companyId)); }
    const rows = raw.prepare(`${LEASE_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY coalesce(c.name, l.company_name) COLLATE NOCASE, l.start_date DESC`).all(...params);
    const day = today();
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    return rows.map((r) => leaseOut(r, { day })).filter((l) => visible(l, scope)
      && (!status || (status === "current" ? ["active", "ending"].includes(l.status) : l.status === status))
      && words.every((w) => [l.companyName, l.reference, ...l.offices.map((o) => `${o.name} ${o.floorName} ${o.siteName}`)].some((s) => String(s || "").toLowerCase().includes(w))));
  }

  // --- writing ------------------------------------------------------------------------------------

  function clean(input, existing = null) {
    const out = {};
    if (input.companyId !== undefined || !existing) {
      const company = directory.getCompany(Number(input.companyId));
      if (!company) throw fail(400, "Choose the company.");
      out.company = company;
    }
    if (input.startDate !== undefined || !existing) out.startDate = dateInput(input.startDate, "start date");
    if (input.endDate !== undefined) out.endDate = dateInput(input.endDate, "end date", { optional: true });
    if (input.commencementDate !== undefined) out.commencementDate = dateInput(input.commencementDate, "commencement date", { optional: true });
    const start = out.startDate ?? existing?.startDate;
    const end = out.endDate !== undefined ? out.endDate : existing?.endDate ?? null;
    if (end && end < start) throw fail(400, "The end date is before the start date.");
    // Kept only when it differs from the start, so a lease that commences on its start follows it.
    if (out.commencementDate !== undefined || out.startDate !== undefined) {
      const given = out.commencementDate !== undefined ? out.commencementDate : existing?.commencementSet ? existing.commencementDate : null;
      out.commencementDate = given && given !== start ? given : null;
    }
    const commences = out.commencementDate !== undefined ? out.commencementDate : existing?.commencementSet ? existing.commencementDate : null;
    if (commences && end && commences > end) throw fail(400, "The commencement date is after the end date.");
    if (input.rentMode !== undefined || !existing) {
      const mode = input.rentMode || "rates";
      if (!RENT_MODES.includes(mode)) throw fail(400, "Rent comes from the rates, or is a fixed monthly amount.");
      out.rentMode = mode;
    }
    if (input.monthlyRent !== undefined) out.monthlyRent = amountInput(input.monthlyRent, "monthly rent");
    if (input.deposit !== undefined) out.deposit = amountInput(input.deposit, "deposit");
    if (input.classRates !== undefined) {
      if (!input.classRates || typeof input.classRates !== "object" || Array.isArray(input.classRates)) throw fail(400, "Give the rates by classification.");
      out.classRates = input.classRates;
    }
    if (input.escalationPct !== undefined) out.escalationPct = amountInput(input.escalationPct, "yearly increase", { max: 100 });
    if (input.reference !== undefined) out.reference = text(input.reference, 80);
    if (input.notes !== undefined) out.notes = text(input.notes, 2000);
    const mode = out.rentMode ?? existing?.rentMode;
    const rent = out.monthlyRent !== undefined ? out.monthlyRent : existing?.monthlyRent ?? null;
    if (mode === "fixed" && rent === null) throw fail(400, "Give the fixed monthly rent.");
    // A fixed rent has no rate to go by.
    if (mode === "fixed") out.classRates = {};
    return out;
  }

  function officeIdsInput(value) {
    if (value === undefined) return undefined;
    const ids = [...new Set((Array.isArray(value) ? value : []).map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw fail(400, "Choose the offices.");
    if (ids.length > 200) throw fail(400, "At most 200 offices in a lease.");
    return ids;
  }

  /** Each office's own rent at the start of the lease, as a Map of office id to { rate, monthly }; a monthly amount wins over a rate. */
  function officeRentsInput(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw fail(400, "Give each office's rent as a list.");
    return new Map(value.map((r) => {
      const monthly = amountInput(r?.monthly, "office's monthly rent");
      return [Number(r?.officeId), { rate: monthly === null ? amountInput(r?.rate, "office's rate", { max: MAX_RATE, places: 4 }) : null, monthly }];
    }));
  }

  /** How much of each office a lease has, as a Map of office id to the percentage as given; checked when it is assigned. */
  function officeSharesInput(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw fail(400, "Give each office's share as a list.");
    return new Map(value.map((r) => [Number(r?.officeId), r?.sharePct]));
  }

  /** Saves what a lease gives each of its offices (those not listed have none). A fixed rent has none; with no list they stay as they are. */
  function saveOfficeRents(leaseId, rents, mode) {
    if (mode !== "fixed" && !rents) return;
    const put = raw.prepare("UPDATE office_assignments SET base_rate = ?, base_monthly = ? WHERE id = ?");
    for (const a of raw.prepare("SELECT id, office_id FROM office_assignments WHERE lease_id = ?").all(leaseId)) {
      const own = mode === "fixed" ? null : rents.get(a.office_id);
      put.run(own?.rate ?? null, own?.monthly ?? null, a.id);
    }
  }

  /** Names the office in an error from assigning it. */
  function assignNamed(officeId, input, opts) {
    try {
      return facilities.assign(officeId, input, opts);
    } catch (error) {
      const office = facilities.getOffice(officeId, { scope: opts.scope });
      if (office) error.message = `Office ${office.name} (${office.floorName}): ${error.message}`;
      throw error;
    }
  }

  /**
   * A new lease for a company: its offices (assigned to it for the lease's dates, the whole of each
   * unless officeShares says otherwise; none only for a fixed rent), dates, rent, deposit and notes.
   * All or nothing.
   */
  function create(input = {}, { scope = null, by = null } = {}) {
    const v = clean(input);
    const officeIds = officeIdsInput(input.officeIds) || [];
    const officeRents = officeRentsInput(input.officeRents);
    const officeShares = officeSharesInput(input.officeShares);
    if (!officeIds.length && v.rentMode !== "fixed") throw fail(400, "Choose the offices the lease covers (a lease without offices needs a fixed rent).");
    let id;
    db.transaction(() => {
      const t = now();
      id = raw.prepare(`INSERT INTO leases (reference, company_id, company_name, start_date, commencement_date, end_date, rent_mode, monthly_rent, deposit, escalation_pct, notes, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.reference ?? null, v.company.id, v.company.name, v.startDate, v.commencementDate ?? null, v.endDate ?? null, v.rentMode,
        v.monthlyRent ?? null, v.deposit ?? null, v.escalationPct ?? null, v.notes ?? null, by, t, by, t).lastInsertRowid;
      for (const officeId of officeIds) {
        const { assignment } = assignNamed(officeId, { companyId: v.company.id, startDate: v.startDate, endDate: v.endDate ?? null, sharePct: officeShares?.get(officeId) }, { scope, by });
        raw.prepare("UPDATE office_assignments SET lease_id = ? WHERE id = ?").run(id, assignment.id);
      }
      saveOfficeRents(id, officeRents, v.rentMode);
      if (v.classRates !== undefined) facilities.setLeaseRates(id, v.classRates);
    });
    return get(Number(id));
  }

  /**
   * Changes a lease: its company, dates and rent; and with officeIds, which offices it covers
   * (new ones are assigned for its dates, ones left out are taken off it); with officeShares, how
   * much of them it has. Its offices' assignments follow its company and dates. All or nothing.
   */
  function update(id, input = {}, { scope = null, by = null } = {}) {
    const existing = get(id, { scope });
    if (!existing) throw fail(404, "No such lease, or not at your sites.");
    const v = clean(input, existing);
    const officeIds = officeIdsInput(input.officeIds);
    const officeRents = officeRentsInput(input.officeRents);
    const officeShares = officeSharesInput(input.officeShares);
    const next = {
      companyId: v.company ? v.company.id : existing.companyId,
      companyName: v.company ? v.company.name : existing.companyName,
      startDate: v.startDate ?? existing.startDate,
      endDate: v.endDate !== undefined ? v.endDate : existing.endDate
    };
    const mode = v.rentMode ?? existing.rentMode;
    if (officeIds && !officeIds.length && mode !== "fixed") throw fail(400, "A lease without offices needs a fixed rent.");
    db.transaction(() => {
      raw.prepare(`UPDATE leases SET reference = ?, company_id = ?, company_name = ?, start_date = ?, commencement_date = ?, end_date = ?, rent_mode = ?, monthly_rent = ?, deposit = ?, escalation_pct = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(v.reference !== undefined ? v.reference : existing.reference, next.companyId, next.companyName, next.startDate,
          v.commencementDate !== undefined ? v.commencementDate : existing.commencementSet ? existing.commencementDate : null, next.endDate, mode,
          v.monthlyRent !== undefined ? v.monthlyRent : existing.monthlyRent, v.deposit !== undefined ? v.deposit : existing.deposit,
          v.escalationPct !== undefined ? v.escalationPct : existing.escalationPct, v.notes !== undefined ? v.notes : existing.notes, by, now(), id);
      // Offices it no longer covers are taken off it; the rest follow its company and dates.
      const keep = officeIds ? new Set(officeIds) : null;
      for (const o of existing.offices) {
        if (keep && !keep.has(o.officeId)) {
          raw.prepare("DELETE FROM office_assignments WHERE id = ?").run(o.assignmentId);
          continue;
        }
        try {
          facilities.updateAssignment(o.assignmentId, { startDate: next.startDate, endDate: next.endDate, ...(officeShares?.has(o.officeId) ? { sharePct: officeShares.get(o.officeId) } : {}) }, { by });
        } catch (error) {
          error.message = `Office ${o.name} (${o.floorName}): ${error.message}`;
          throw error;
        }
        raw.prepare("UPDATE office_assignments SET company_id = ?, company_name = ? WHERE id = ?").run(next.companyId, next.companyName, o.assignmentId);
      }
      if (keep) {
        const had = new Set(existing.offices.map((o) => o.officeId));
        for (const officeId of officeIds.filter((x) => !had.has(x))) {
          const { assignment } = assignNamed(officeId, { companyId: next.companyId, startDate: next.startDate, endDate: next.endDate, sharePct: officeShares?.get(officeId) }, { scope, by });
          raw.prepare("UPDATE office_assignments SET lease_id = ? WHERE id = ?").run(id, assignment.id);
        }
      }
      saveOfficeRents(id, officeRents, mode);
      if (v.classRates !== undefined) facilities.setLeaseRates(id, v.classRates);
    });
    return get(id);
  }

  /** Keeps a file (from readDocument) with a lease: kind is agreement, amendment or supporting. */
  function addDocument(leaseId, file, { kind, description } = {}, { by = null } = {}) {
    if (!DOCUMENT_KINDS.includes(kind)) throw fail(400, "Say what the document is: the agreement, a mod or amendment, or a supporting document.");
    let id;
    db.transaction(() => {
      const stored = files.save(file, { by });
      id = Number(raw.prepare("INSERT INTO lease_documents (lease_id, file_id, kind, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(leaseId, stored.id, kind, text(description, 200), by, now()).lastInsertRowid);
    });
    return documentsOf(leaseId).find((d) => d.id === id);
  }

  /** A document (no contents) by its id, for the lease it belongs to. */
  function getDocument(id) {
    const r = raw.prepare("SELECT lease_id FROM lease_documents WHERE id = ?").get(Number(id));
    return r ? documentsOf(r.lease_id).find((d) => d.id === Number(id)) : null;
  }

  const removeDocument = (id) => { raw.prepare("DELETE FROM lease_documents WHERE id = ?").run(Number(id)); };

  /** A document's file with its contents, and its lease, by the file's ref. Only a lease's documents are found this way. */
  function documentFile(ref) {
    if (typeof ref !== "string" || ref.length > 64) return null;
    return raw.prepare("SELECT d.lease_id AS leaseId, f.name, f.type, f.data FROM lease_documents d JOIN stored_files f ON f.id = d.file_id WHERE f.ref = ?").get(ref) || null;
  }

  /** Deletes a lease entered by mistake, with its office assignments; one that has been invoiced stays (end it instead). */
  function remove(id, { scope = null } = {}) {
    const existing = get(id, { scope });
    if (!existing) throw fail(404, "No such lease, or not at your sites.");
    if (existing.invoiced.length) throw fail(409, `This lease has been invoiced (${existing.invoiced.map(periodName).join(", ")}); give it an end date instead, so its history stays.`);
    db.transaction(() => {
      raw.prepare("DELETE FROM office_assignments WHERE lease_id = ?").run(id);
      raw.prepare("DELETE FROM leases WHERE id = ?").run(id);
    });
    return existing;
  }

  /**
   * After an assignment changed outside a lease (Rooms, a company's page): a lease of one office
   * follows its dates; one whose last assignment went is removed, unless it has been invoiced or
   * holds documents.
   */
  function syncAfterAssignment(assignmentId, leaseId) {
    const lease = raw.prepare("SELECT * FROM leases WHERE id = ?").get(leaseId);
    if (!lease) return;
    const left = raw.prepare("SELECT * FROM office_assignments WHERE lease_id = ?").all(leaseId);
    if (!left.length) {
      const invoiced = raw.prepare("SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.lease_id = ? AND i.status <> 'void'").get(leaseId);
      if (!invoiced && lease.rent_mode !== "fixed" && !documentsOf(leaseId).length) raw.prepare("DELETE FROM leases WHERE id = ?").run(leaseId);
      return;
    }
    if (left.length === 1) raw.prepare("UPDATE leases SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?").run(left[0].start_date, left[0].end_date, now(), leaseId);
  }

  /** Refuses an office leaving a fixed-rent lease on its own: that rent can't be split. */
  function mayLeave(leaseId) {
    const lease = raw.prepare("SELECT * FROM leases WHERE id = ?").get(leaseId);
    if (lease?.rent_mode === "fixed") throw fail(409, `This office is in ${lease.company_name}'s lease${lease.reference ? ` ${lease.reference}` : ""}, which has a fixed rent; change its offices and dates on the lease (Facilities > Leases).`);
  }

  /**
   * An office's assignment leaves its lease of several for a lease of its own (rent from the rates),
   * keeping the rates and yearly increase it had, counted from the same day.
   */
  function leave(assignmentId, { by = null } = {}) {
    const had = raw.prepare("SELECT l.* FROM office_assignments a JOIN leases l ON l.id = a.lease_id WHERE a.id = ?").get(Number(assignmentId));
    raw.prepare("UPDATE office_assignments SET lease_id = NULL WHERE id = ?").run(Number(assignmentId));
    adoptAssignments({ by });
    if (!had) return;
    const commences = commencementOf(had);
    raw.prepare(`UPDATE leases SET escalation_pct = ?, commencement_date = CASE WHEN start_date = ? THEN NULL ELSE ? END
      WHERE id = (SELECT lease_id FROM office_assignments WHERE id = ?)`).run(had.escalation_pct, commences, commences, Number(assignmentId));
    raw.prepare(`INSERT OR REPLACE INTO lease_class_rates (lease_id, class_key, rate, updated_at)
      SELECT (SELECT lease_id FROM office_assignments WHERE id = ?), class_key, rate, updated_at FROM lease_class_rates WHERE lease_id = ?`).run(Number(assignmentId), had.id);
  }

  /** The lease an assignment belongs to, and how many offices it has. */
  function leaseOfAssignment(assignmentId) {
    const r = raw.prepare("SELECT a.lease_id, (SELECT count(*) FROM office_assignments x WHERE x.lease_id = a.lease_id) AS n FROM office_assignments a WHERE a.id = ?").get(Number(assignmentId));
    return r ? { leaseId: r.lease_id, offices: r.n } : null;
  }

  // --- rent ------------------------------------------------------------------------------------------

  /**
   * A lease's rent for a month: null when it doesn't cover any of it, else the amount (for the
   * days it covers, when only part), the full monthly rent it comes from, and the words for it.
   */
  function rentFor(leaseId, period) {
    const r = raw.prepare(`${LEASE_SELECT} WHERE l.id = ?`).get(Number(leaseId));
    if (!r) return null;
    const { first, last, days } = monthBounds(periodInput(period));
    const from = r.start_date > first ? r.start_date : first;
    const to = r.end_date && r.end_date < last ? r.end_date : last;
    if (from > to) return null;
    const offices = officesOf(r);
    const full = monthlyOn(r, offices, from);
    if (full === null) return { leaseId: r.id, period, amount: null, problem: r.rent_mode === "fixed" ? "it has no monthly rent" : "an office has no size or no rate (and no fixed monthly rent)" };
    const covered = dayNumber(to) - dayNumber(from) + 1;
    const part = covered < days;
    const amount = money(part ? (full * covered) / days : full);
    const where = offices.length ? `: ${offices.map((o) => (o.sharePct < 100 ? `${o.name} (${o.sharePct}% share)` : o.name)).join(", ")}${[...new Set(offices.map((o) => o.siteName))].length === 1 ? ` (${offices[0].siteName})` : ""}` : "";
    return {
      leaseId: r.id,
      period,
      amount,
      monthly: full,
      days: covered,
      daysInMonth: days,
      description: `Rent, ${periodName(period)}${where}${r.reference ? `, lease ${r.reference}` : ""}${part ? ` (${covered} of ${days} days)` : ""}`
    };
  }

  /** The leases covering any of a month, for the caller's sites. */
  function coveringMonth(period, { scope = null } = {}) {
    const { first, last } = monthBounds(periodInput(period));
    const ids = raw.prepare("SELECT id FROM leases WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)").all(last, first).map((r) => r.id);
    return ids.map((id) => get(id, { scope })).filter(Boolean);
  }

  /** Leases ending (or that ended) within `days` of today, at the caller's sites. */
  function endingSoon({ scope = null, days = ENDING_DAYS } = {}) {
    const day = today();
    return list({ scope }).filter((l) => l.endDate && dayNumber(l.endDate) - dayNumber(day) <= days && dayNumber(l.endDate) >= dayNumber(day) - 30)
      .sort((a, b) => a.endDate.localeCompare(b.endDate));
  }

  return { adoptAssignments, list, get, create, update, remove, addDocument, getDocument, removeDocument, documentFile, syncAfterAssignment, mayLeave, leave, leaseOfAssignment, rentFor, coveringMonth, endingSoon, today };
}

module.exports = { createLeases, RENT_MODES, periodInput, monthBounds, periodName, money, dateInput, amountInput, text, fail };
