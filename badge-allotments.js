/**
 * Tenant badge allotments: how many tenant badges a company may hold without paying for more.
 *
 * Each desk in an office a company leases gives it a badge; past those, each badge it is given
 * is an extra one, billed at the billing settings' badge price (a charge on its next invoice).
 * What it has received or paid for it keeps: giving up an office takes nothing away, and a
 * badge handed back can go to anyone else at the company at no charge. Badges can also be bought
 * ahead: a charge for the built-in price list item adds as many as it is for (billing.js keeps
 * those in step with the charge, and takes them away if it's deleted). Each office counts once
 * for a company, so renewing a lease adds nothing, but a different office adds its desks. A
 * lost badge still counts, so the badge that replaces it is paid for.
 *
 * Kept as a ledger (badge_allotments): desks, paid, lost and adjust (by hand, with a note).
 * Its sum is the badges the company may hold; the tenant badges its people hold now (not those
 * lent for the day) are the ones in use. A company with nothing in its ledger isn't counted yet
 * (no desks set on its offices, none bought): its badges are given out as before.
 */
const KINDS = ["desks", "paid", "lost", "adjust"];
const MAX_ADJUST = 1000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createAllotments({ db, billing, today, now = Date.now }) {
  const raw = db.raw;

  /**
   * Credits each company the desks of the offices it has now or later (not ones it had before
   * desks were counted): an office's desks once, topped up if it gains more. A company with part
   * of a room has that part of its desks in whole desks, rounded down; anything more is added by hand.
   */
  function syncDesks() {
    const day = today();
    const owed = raw.prepare(`SELECT a.company_id, o.id AS office_id, o.name AS office_name, o.desks, max(coalesce(a.share_pct, 100)) AS share_pct,
        coalesce((SELECT sum(b.quantity) FROM badge_allotments b WHERE b.kind = 'desks' AND b.company_id = a.company_id AND b.office_id = o.id), 0) AS credited
      FROM office_assignments a JOIN offices o ON o.id = a.office_id JOIN companies c ON c.id = a.company_id
      WHERE o.desks > 0 AND c.building_staff = 0 AND (a.end_date IS NULL OR a.end_date >= ?)
      GROUP BY a.company_id, o.id`).all(day).map((r) => ({ ...r, desks: Math.floor((r.desks * r.share_pct) / 100 + 1e-9) })).filter((r) => r.desks > r.credited);
    if (!owed.length) return 0;
    const add = raw.prepare("INSERT INTO badge_allotments (company_id, kind, quantity, office_id, office_name, note, created_at) VALUES (?, 'desks', ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (const r of owed) add.run(r.company_id, r.desks - r.credited, r.office_id, r.office_name, r.credited ? `${r.office_name} now has ${r.desks} desks` : null, now());
    });
    return owed.length;
  }

  /** The tenant badges a company's people hold now, not counting ones lent for the day. */
  const heldBy = (companyId) => raw.prepare(`SELECT count(*) AS n FROM badge_assignments a JOIN badges b ON b.id = a.badge_id JOIN people p ON p.id = a.holder_id
    WHERE a.holder_kind = 'person' AND a.returned_at IS NULL AND a.temporary = 0 AND b.type = 'tenant' AND p.company_id = ?`).get(companyId).n;

  const price = () => Number(billing.settings().badgePrice) || 0;

  const entryOut = (r) => ({
    id: r.id, kind: r.kind, quantity: r.quantity, officeId: r.office_id || null, officeName: r.office_name || null, badgeLabel: r.badge_label || null,
    holderName: r.holder_name || null, chargeId: r.charge_id || null, note: r.note || null, createdBy: r.created_by || null, createdAt: r.created_at
  });

  /** A company's allotment: what it may hold and why, what it holds, and its ledger (newest first) when asked. */
  function summary(companyId, { entries = false } = {}) {
    const company = raw.prepare("SELECT id, name, building_staff FROM companies WHERE id = ?").get(Number(companyId));
    if (!company) throw fail(404, "No such company.");
    syncDesks();
    const sums = Object.fromEntries(KINDS.map((k) => [k, 0]));
    let rows = 0;
    for (const r of raw.prepare("SELECT kind, sum(quantity) AS n, count(*) AS c FROM badge_allotments WHERE company_id = ? GROUP BY kind").all(company.id)) {
      sums[r.kind] = r.n;
      rows += r.c;
    }
    const allowed = sums.desks + sums.paid + sums.lost + sums.adjust;
    const held = heldBy(company.id);
    return {
      companyId: company.id,
      companyName: company.name,
      // Building staff wear personnel badges, which aren't counted.
      buildingStaff: Boolean(company.building_staff),
      counted: rows > 0 && !company.building_staff,
      desks: sums.desks,
      paid: sums.paid,
      lost: -sums.lost,
      adjusted: sums.adjust,
      allowed,
      held,
      free: Math.max(0, allowed - held),
      over: Math.max(0, held - allowed),
      price: price(),
      ...(entries ? { entries: raw.prepare("SELECT * FROM badge_allotments WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 500").all(company.id).map(entryOut) } : {})
    };
  }

  /** The company a badge given to this holder counts against, or null: only tenant badges kept by a person count (not loans). */
  function countsFor(badge, kind, holderId) {
    if (kind !== "person" || badge.type !== "tenant" || badge.temporary) return null;
    return raw.prepare("SELECT company_id FROM people WHERE id = ?").get(Number(holderId))?.company_id ?? null;
  }

  /** Whether giving this badge needs an extra one paid for: null when not, else the company's allotment. */
  function extraNeeded(badge, kind, holderId) {
    const companyId = countsFor(badge, kind, holderId);
    if (!companyId) return null;
    const s = summary(companyId);
    return s.counted && s.held >= s.allowed ? s : null;
  }

  /** An extra badge for a company: one more it may hold, charged at the badge price (none at no price). */
  function recordPaid(companyId, { badgeLabel = null, holderName = null } = {}, { by = null } = {}) {
    const cost = price();
    let charge = null;
    db.transaction(() => {
      if (cost > 0) {
        // The charge adds the badge; this says which it was.
        const item = billing.badgeItem();
        charge = billing.createCharge({
          companyId, date: today(), itemId: item.id, description: `${item.name}${badgeLabel ? ` ${badgeLabel}` : ""}${holderName ? ` (${holderName})` : ""}`,
          quantity: 1, rate: cost, notes: "Beyond the badges its desks and earlier badges allow."
        }, { by });
        raw.prepare("UPDATE badge_allotments SET badge_label = ?, holder_name = ? WHERE kind = 'paid' AND charge_id = ?").run(badgeLabel, holderName, charge.id);
      } else {
        raw.prepare("INSERT INTO badge_allotments (company_id, kind, quantity, badge_label, holder_name, created_by, created_at) VALUES (?, 'paid', 1, ?, ?, ?, ?)")
          .run(companyId, badgeLabel, holderName, by, now());
      }
    });
    return { charge, allotment: summary(companyId) };
  }

  /** A lost tenant badge: it still counts, so it takes one from what the company may hold. Only for companies being counted. */
  function recordLost(badge, holder, { by = null } = {}) {
    if (holder.temporary) return null;
    const companyId = countsFor(badge, holder.kind, holder.id);
    if (!companyId || !summary(companyId).counted) return null;
    raw.prepare("INSERT INTO badge_allotments (company_id, kind, quantity, badge_label, holder_name, created_by, created_at) VALUES (?, 'lost', -1, ?, ?, ?, ?)")
      .run(companyId, badge.label, holder.name, by, now());
    return summary(companyId);
  }

  /** Adds badges to (or takes them from) what a company may hold, by hand, saying why. */
  function adjust(companyId, { quantity, note } = {}, { by = null } = {}) {
    const s = summary(companyId);
    if (s.buildingStaff) throw fail(400, `${s.companyName} is building staff; its personnel badges aren't counted.`);
    const n = Number(quantity);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_ADJUST) throw fail(400, `Give a whole number of badges to add (or take away, below zero), up to ${MAX_ADJUST}.`);
    const why = String(note ?? "").trim().slice(0, 500);
    if (!why) throw fail(400, "Say why, for the record.");
    if (s.allowed + n < 0) throw fail(400, `${s.companyName} may hold ${s.allowed}; it can't go below none.`);
    raw.prepare("INSERT INTO badge_allotments (company_id, kind, quantity, note, created_by, created_at) VALUES (?, 'adjust', ?, ?, ?, ?)").run(s.companyId, n, why, by, now());
    return summary(companyId, { entries: true });
  }

  syncDesks();
  return { syncDesks, summary, extraNeeded, recordPaid, recordLost, adjust };
}

module.exports = { createAllotments, KINDS };
