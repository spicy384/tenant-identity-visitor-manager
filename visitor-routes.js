/**
 * The staff side of visitors: visitor records and their companies, visits (who is in the
 * building, the visit log, checking in and out from the desk), the visits settings and
 * the kiosks. Mounted after the sign-in check, so req.user and req.ctx are set.
 *
 * Reading needs the role's "visitors" area at read or above, changing at edit; settings
 * and kiosks are for administrators. Visitor fields go through the field access grid
 * like companies and people.
 */
const express = require("express");
const { toCsv } = require("./csv");
const { ID_TYPES, cleanIdOther, idText } = require("./visitors");

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

/** A date (YYYY-MM-DD, server-local midnight) or a millisecond timestamp. */
function parseTime(value, name) {
  const v = str(value, 40);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00`).getTime();
  if (/^\d{10,15}$/.test(v)) return Number(v);
  throw fail(400, `"${name}" must be a date (YYYY-MM-DD).`);
}

function createVisitorRoutes({ access, visitors, kiosks, clock, admin, auditFrom, publicFields, kioskAddress = () => null, kioskPort = null, badges = null, events = null, clearance = null }) {
  const router = express.Router();

  const readVisitors = (req, res, next) => (access.canReadVisitors(req.ctx) ? next() : res.status(403).json({ error: "This account can't see visitors." }));
  const editVisitors = (req, res, next) => (access.canEditVisitors(req.ctx) ? next() : res.status(403).json({ error: "This account can't change visitors." }));
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const fullName = (v) => `${v.firstName} ${v.lastName}`;

  function visitorOut(ctx, record, list) {
    // The badge kept for them, to those who see badges.
    const reserved = access.canReadBadges(ctx) ? { reservedBadge: record.reservedBadge } : {};
    return { ...access.project(ctx, "visitor", record, list), source: record.source, createdAt: record.createdAt, ...reserved };
  }

  /** A visit as the caller may see it: the visitor's company and citizenship only when those fields are visible. */
  function visitsOut(ctx, list) {
    const visible = new Set(access.fieldsFor(ctx, "visitor").map((f) => f.key));
    return list.map((v) => ({ ...v, visitor: { ...v.visitor, organization: visible.has("organization") ? v.visitor.organization : undefined, citizenship: visible.has("citizenship") ? v.visitor.citizenship : undefined } }));
  }

  function siteParam(req, value) {
    const siteId = positiveInt(value);
    if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
    return siteId;
  }

  /** The caller may change a visitor's companies (the "Companies they visit" field). */
  function canEditLinks(ctx) {
    return access.fieldsFor(ctx, "visitor").some((f) => f.key === "companies" && f.access === "edit");
  }

  function writePlan(ctx, body, recordId = null) {
    const list = access.fieldsFor(ctx, "visitor", { recordId });
    const custom = access.checkWrite(ctx, "visitor", body || {}, list);
    return { custom, editable: list.filter((f) => f.access === "edit"), sites: ctx.sites };
  }

  // --- visitors ------------------------------------------------------------------------

  router.get("/api/visitors", readVisitors, (req, res) => {
    const filter = ["review", "blocked"].includes(str(req.query.filter)) ? str(req.query.filter) : null;
    const { records, total } = visitors.list({
      q: str(req.query.q),
      search: access.searchable(req.ctx, "visitor"),
      sites: req.ctx.sites,
      filter,
      limit: Math.min(positiveInt(req.query.limit, 100), 1000),
      offset: Math.max(0, Number(str(req.query.offset)) || 0)
    });
    const list = access.fieldsFor(req.ctx, "visitor");
    res.json({ visitors: records.map((r) => visitorOut(req.ctx, r, list)), total });
  });

  router.get("/api/visitors/:id", readVisitors, (req, res) => {
    const record = visitors.get(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!record) throw fail(404, "No such visitor.");
    const list = access.fieldsFor(req.ctx, "visitor", { recordId: record.id });
    const history = visitors.listVisits({ visitorId: record.id, sites: req.ctx.sites, limit: 50 });
    res.json({ visitor: visitorOut(req.ctx, record, list), fields: publicFields(list), visits: visitsOut(req.ctx, history.visits), visitCount: history.total });
  });

  router.post("/api/visitors", editVisitors, (req, res) => {
    const body = req.body || {};
    if (Array.isArray(body.links) && body.links.length && !canEditLinks(req.ctx)) throw fail(403, "This account can't change which companies a visitor visits.");
    const record = visitors.create(body, writePlan(req.ctx, body));
    auditFrom(req, "visitor.add", fullName(record), record.companies.map((c) => c.companyName).join(", ") || null);
    const list = access.fieldsFor(req.ctx, "visitor", { recordId: record.id });
    res.json({ ok: true, visitor: visitorOut(req.ctx, visitors.get(record.id, { sites: req.ctx.sites }) || record, list) });
  });

  router.put("/api/visitors/:id", editVisitors, (req, res) => {
    const id = positiveInt(req.params.id);
    if (!visitors.get(id, { sites: req.ctx.sites })) throw fail(404, "No such visitor.");
    const body = req.body || {};
    delete body.links; // links have their own routes
    const record = visitors.update(id, body, writePlan(req.ctx, body, id));
    const keys = [...Object.keys(body).filter((k) => k !== "custom"), ...Object.keys(body.custom || {}).map((k) => `custom.${k}`)];
    auditFrom(req, "visitor.update", fullName(record), keys.join(", ") || null);
    res.json({ ok: true, visitor: visitorOut(req.ctx, record, access.fieldsFor(req.ctx, "visitor", { recordId: id })) });
  });

  router.post("/api/visitors/:id/links", editVisitors, (req, res) => {
    if (!canEditLinks(req.ctx)) throw fail(403, "This account can't change which companies a visitor visits.");
    const id = positiveInt(req.params.id);
    const record = visitors.get(id, { sites: req.ctx.sites });
    if (!record) throw fail(404, "No such visitor.");
    visitors.setLink(id, req.body || {}, { sites: req.ctx.sites });
    const after = visitors.get(id, { sites: req.ctx.sites });
    const link = after.companies.find((c) => c.companyId === Number(req.body?.companyId));
    auditFrom(req, "visitor.link", fullName(after), `${link?.companyName}${link?.hostName ? `, usual host ${link.hostName}` : ""}`);
    res.json({ ok: true, companies: after.companies });
  });

  router.delete("/api/visitors/:id/links/:companyId", editVisitors, (req, res) => {
    if (!canEditLinks(req.ctx)) throw fail(403, "This account can't change which companies a visitor visits.");
    const id = positiveInt(req.params.id);
    const record = visitors.get(id, { sites: req.ctx.sites });
    if (!record) throw fail(404, "No such visitor.");
    const link = record.companies.find((c) => c.companyId === positiveInt(req.params.companyId));
    visitors.removeLink(id, positiveInt(req.params.companyId), { sites: req.ctx.sites });
    auditFrom(req, "visitor.unlink", fullName(record), link?.companyName || null);
    res.json({ ok: true, companies: visitors.get(id, { sites: req.ctx.sites }).companies });
  });

  router.post("/api/visitors/:id/merge", editVisitors, (req, res) => {
    const result = visitors.merge(positiveInt(req.params.id), positiveInt(req.body?.intoId), { sites: req.ctx.sites });
    auditFrom(req, "visitor.merge", fullName(result.from), `into ${fullName(result.into)} (#${result.into.id}); ${result.visitsMoved} visits moved`);
    res.json({ ok: true, intoId: result.into.id });
  });

  router.delete("/api/visitors/:id", admin, (req, res) => {
    const out = badges ? badges.openForHolder("visitor", positiveInt(req.params.id)) : [];
    if (out.length) throw fail(409, `They still hold badge${out.length === 1 ? "" : "s"} ${out.join(", ")}. Take ${out.length === 1 ? "it" : "them"} back first.`);
    const record = visitors.remove(positiveInt(req.params.id));
    if (clearance) clearance.sweepDigits();
    auditFrom(req, "visitor.remove", fullName(record), "and their visits");
    res.json({ ok: true });
  });

  // --- visits ---------------------------------------------------------------------------

  function visitFilter(req) {
    const status = ["open", "closed", "all"].includes(str(req.query.status)) ? str(req.query.status) : "all";
    const to = parseTime(req.query.to, "to");
    return {
      sites: req.ctx.sites,
      siteId: siteParam(req, req.query.site),
      status,
      from: parseTime(req.query.from, "from"),
      // "to" is a whole day: everything up to the following midnight.
      to: to && /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.to)) ? to + 86400000 : to,
      companyId: positiveInt(req.query.companyId),
      hostId: positiveInt(req.query.hostId),
      visitorId: positiveInt(req.query.visitorId),
      corrected: str(req.query.corrected) === "1",
      q: str(req.query.q)
    };
  }

  router.get("/api/visits", readVisitors, (req, res) => {
    const result = visitors.listVisits({ ...visitFilter(req), limit: Math.min(positiveInt(req.query.limit, 100), 1000), offset: Math.max(0, Number(str(req.query.offset)) || 0) });
    res.json({ visits: visitsOut(req.ctx, result.visits), total: result.total });
  });

  router.get("/api/visits/summary", readVisitors, (req, res) => {
    res.json({
      here: visitors.hereNow(req.ctx.sites),
      review: visitors.reviewCount(req.ctx.sites),
      expected: events ? events.expectedCount(req.ctx.sites) : 0,
      badgesLeft: badges && access.canReadBadges(req.ctx) ? badges.leftCount(req.ctx.sites) : 0,
      tempOverdue: badges && access.canReadBadges(req.ctx) ? badges.overdueCount(req.ctx.sites) : 0
    });
  });

  // --- kiosk visitors waiting for a badge (the banner on staff pages) ----------------------------

  /** Who can be told: those who see visitors and may give badges out. */
  const giveBadges = (req, res, next) => (badges && access.canReadVisitors(req.ctx) && access.canEditBadges(req.ctx) ? next() : res.status(403).json({ error: "This account can't give badges out." }));

  router.get("/api/visits/badge-needed", giveBadges, (req, res) => {
    const siteId = positiveInt(req.query.site);
    if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
    res.json({ visits: badges.waitingForBadge({ sites: req.ctx.sites, siteId }) });
  });

  router.get("/api/visits/:id", readVisitors, (req, res) => {
    const visit = visitors.getVisit(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!visit) throw fail(404, "No such visit.");
    res.json({ visit: visitsOut(req.ctx, [visit])[0], timeChanges: visitors.timeChanges(visit.id) });
  });

  /**
   * Corrects when a visitor arrived or left: { checkedInAt, checkedOutAt (timestamps), reason }.
   * Each correction is kept with the visit, with its reason, and in the audit log.
   */
  router.put("/api/visits/:id/times", editVisitors, (req, res) => {
    const body = req.body || {};
    const { visit, changes, reason, timeZone } = visitors.correctTimes(positiveInt(req.params.id), { checkedInAt: body.checkedInAt, checkedOutAt: body.checkedOutAt, reason: body.reason, by: staffName(req), sites: req.ctx.sites });
    // In the site's own time, as the desk there sees it.
    const fmt = (ms) => (ms ? new Intl.DateTimeFormat("en-US", { timeZone: timeZone || undefined, dateStyle: "medium", timeStyle: "short" }).format(ms) : "not checked out");
    const what = changes.map((c) => `${c.field === "in" ? "arrived" : "left"} ${fmt(c.from)} -> ${fmt(c.to)}`).join("; ");
    auditFrom(req, "visit.times_corrected", `${visit.visitor.firstName} ${visit.visitor.lastName}`, `${visit.siteName}, visit ${visit.id}: ${what}. Reason: ${reason}`);
    res.json({ ok: true, visit: visitsOut(req.ctx, [visit])[0], timeChanges: visitors.timeChanges(visit.id) });
  });

  router.post("/api/visits/:id/badge-not-needed", giveBadges, (req, res) => {
    const waived = badges.waiveVisitBadge(positiveInt(req.params.id), { by: req.user?.displayName || req.user?.username || null, sites: req.ctx.sites });
    auditFrom(req, "visit.badge_not_needed", waived.name, `visit ${waived.visitId}`);
    res.json({ ok: true });
  });

  router.get("/api/visits.csv", admin, (req, res) => {
    const { visits } = visitors.listVisits({ ...visitFilter(req), limit: 1000000 });
    const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
    const csv = toCsv(
      ["checked_in", "checked_out", "site", "first_name", "last_name", "organization", "company", "host", "purpose", "checked_in_by", "checkout", "checked_out_by", "times_corrected"],
      visits.map((v) => [iso(v.checkedInAt), iso(v.checkedOutAt), v.siteName, v.visitor.firstName, v.visitor.lastName, v.visitor.organization, v.companyName, v.hostName, v.purpose, v.checkedInBy, v.checkoutMethod, v.checkedOutBy, v.timesCorrected])
    );
    auditFrom(req, "export.visits", `${visits.length} visits`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="visits-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  /** Checks a visitor in from the desk. */
  router.post("/api/visits", editVisitors, (req, res) => {
    const body = req.body || {};
    const siteId = siteParam(req, body.siteId);
    if (!siteId) throw fail(400, "Choose the site.");
    const visitor = visitors.get(positiveInt(body.visitorId), { sites: req.ctx.sites });
    if (!visitor) throw fail(404, "No such visitor.");
    if (visitor.blocked && !body.overrideBlock) throw fail(409, `${fullName(visitor)} is blocked. Check with a manager before letting them in.`);
    const { visit, already } = visitors.checkIn({ visitorId: visitor.id, siteId, companyId: positiveInt(body.companyId), hostId: body.hostId || null, purpose: body.purpose, by: staffName(req) });
    if (!already) auditFrom(req, "visit.checkin", fullName(visitor), `${visit.siteName}: ${visit.companyName}${visit.hostName ? `, host ${visit.hostName}` : ""}${visitor.blocked ? "; blocked, let in anyway" : ""}`);
    res.json({ ok: true, already, visit: visitsOut(req.ctx, [visit])[0] });
  });

  // --- checking in at the desk, step by step ------------------------------------------------
  //
  // The desk confirms who they are and who they visit, checks their ID, then gives a badge
  // (badge-routes.js). Visitors who checked themselves in at a kiosk wait at the ID step.

  /** What check-in needs of the visitor's record that isn't filled in, as a message; else null. */
  function missingForCheckin(visitor) {
    const missing = [!visitor.organization ? "company" : null, !visitor.citizenship ? "citizenship" : null].filter(Boolean);
    return missing.length ? `Fill in ${fullName(visitor)}'s ${missing.join(" and ")} first.` : null;
  }

  /** The point of contact (anyone in the directory) and their company, from the body or the visit. */
  function contactFrom(body, visit = null) {
    const hostId = positiveInt(body.hostId) ?? visit?.hostId ?? null;
    if (!hostId) throw fail(400, "Choose the point of contact.");
    const companyId = positiveInt(body.companyId) ?? visitors.companyOfPerson(hostId);
    if (!companyId) throw fail(400, "That point of contact isn't in the directory.");
    return { hostId, companyId };
  }

  /**
   * The desk checks in someone standing there, their ID already checked: { visitorId, siteId,
   * hostId, companyId (else the contact's company), purpose, idType, idOther (what an Other
   * government ID was) }. The visit then waits
   * for its badge.
   */
  router.post("/api/checkins", editVisitors, (req, res) => {
    const body = req.body || {};
    const siteId = siteParam(req, body.siteId);
    if (!siteId) throw fail(400, "Choose the site.");
    const visitor = visitors.get(positiveInt(body.visitorId), { sites: req.ctx.sites });
    if (!visitor) throw fail(404, "No such visitor.");
    if (visitor.blocked && !body.overrideBlock) throw fail(409, `${fullName(visitor)} is blocked. Check with a manager before letting them in.`);
    const missing = missingForCheckin(visitor);
    if (missing) throw fail(400, missing);
    if (!String(body.purpose || "").trim()) throw fail(400, "Say what the visit is for.");
    if (!ID_TYPES.includes(body.idType)) throw fail(400, "Check their ID, and say which it was.");
    const idOther = cleanIdOther(body.idType, body.idOther);
    const { hostId, companyId } = contactFrom(body);
    const { visit, already } = visitors.checkIn({ visitorId: visitor.id, siteId, companyId, hostId, purpose: body.purpose, idType: body.idType, idOther, by: staffName(req) });
    if (!already) auditFrom(req, "visit.checkin", fullName(visitor), `${visit.siteName}: ${visit.companyName}, contact ${visit.hostName}; ID checked (${idText(body.idType, idOther)})${visitor.blocked ? "; blocked, let in anyway" : ""}`);
    res.json({ ok: true, already, visit: visitsOut(req.ctx, [visit])[0] });
  });

  /**
   * The desk has checked the ID of someone who checked in at a kiosk: { idType, idOther, and hostId,
   * companyId, purpose to fill in or change }. The visit goes on to its badge. Until the badge
   * is given the desk can come back and check it again, or change the contact or purpose.
   */
  router.post("/api/visits/:id/verify-id", editVisitors, (req, res) => {
    const body = req.body || {};
    const before = visitors.getVisit(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!before || before.checkedOutAt) throw fail(404, "No such visit in the building.");
    const visitor = visitors.get(before.visitor.id);
    if (!["id", "badge"].includes(before.checkinStage)) throw fail(409, `${fullName(visitor)}'s check-in is finished.`);
    const missing = missingForCheckin(visitor);
    if (missing) throw fail(400, missing);
    if (!ID_TYPES.includes(body.idType)) throw fail(400, "Check their ID, and say which it was.");
    const idOther = cleanIdOther(body.idType, body.idOther);
    const contact = contactFrom(body, before);
    const purpose = body.purpose !== undefined ? body.purpose : before.purpose;
    if (!String(purpose || "").trim()) throw fail(400, "Say what the visit is for.");
    if (contact.hostId !== before.hostId || contact.companyId !== before.companyId || purpose !== before.purpose) visitors.updateVisit(before.id, { ...contact, purpose });
    const visit = visitors.verifyId(before.id, { idType: body.idType, idOther, by: staffName(req) });
    auditFrom(req, "visit.id_checked", fullName(visitor), `${visit.siteName}: ${idText(body.idType, idOther)}${before.checkinStage === "badge" ? `; checked again (was ${idText(before.idType, before.idOther)})` : ""}`);
    res.json({ ok: true, visit: visitsOut(req.ctx, [visit])[0] });
  });

  router.post("/api/visits/:id/checkout", editVisitors, (req, res) => {
    const { visit, already } = visitors.checkOut(positiveInt(req.params.id), { method: "staff", by: staffName(req), sites: req.ctx.sites });
    if (!already) auditFrom(req, "visit.checkout", `${visit.visitor.firstName} ${visit.visitor.lastName}`, `${visit.siteName}: ${visit.companyName}`);
    res.json({ ok: true, already, visit: visitsOut(req.ctx, [visit])[0] });
  });

  // --- visits settings (administrators) ----------------------------------------------------

  function settingsOut() {
    const s = clock.settings();
    const cutoff = clock.retentionCutoff();
    return { retentionMonths: s.retentionMonths, kioskIdleSeconds: s.kioskIdleSeconds, lastRetentionRun: s.lastRetentionRun || null, wouldDelete: cutoff ? visitors.retentionPreview(cutoff) : null };
  }

  router.get("/api/settings/visits", admin, (req, res) => {
    res.json(settingsOut());
  });

  /** What a retention of `months` would delete today, before it is saved. */
  router.get("/api/settings/visits/preview", admin, (req, res) => {
    const months = Number(str(req.query.months));
    if (!Number.isInteger(months) || months < 0 || months > 240) throw fail(400, "Months must be 0 to 240.");
    const cutoff = clock.retentionCutoff(months);
    res.json({ months, cutoff, wouldDelete: cutoff ? visitors.retentionPreview(cutoff) : { visits: 0, visitors: 0 } });
  });

  router.put("/api/settings/visits", admin, (req, res) => {
    const saved = clock.saveSettings({ retentionMonths: req.body?.retentionMonths, kioskIdleSeconds: req.body?.kioskIdleSeconds });
    auditFrom(req, "settings.visits", null, `keep visits ${saved.retentionMonths ? `${saved.retentionMonths} months` : "forever"}; kiosk resets after ${saved.kioskIdleSeconds} s`);
    res.json({ ok: true, ...settingsOut() });
  });

  /** Applies retention now instead of waiting for the daily run. */
  router.post("/api/settings/visits/apply", admin, (req, res) => {
    const removed = clock.runRetention();
    auditFrom(req, "visit.retention", null, removed ? `${removed.visits} visits and ${removed.visitors} unchecked visitors deleted` : "retention is off");
    res.json({ ok: true, removed, ...settingsOut() });
  });

  // --- kiosks (administrators) -----------------------------------------------------------------

  router.get("/api/kiosks", admin, (req, res) => {
    res.json({ kiosks: kiosks.list(), kioskUrl: kioskAddress(req), separatePort: Boolean(kioskPort) });
  });

  router.post("/api/kiosks", admin, (req, res) => {
    const { kiosk, code } = kiosks.create(req.body || {});
    auditFrom(req, "kiosk.add", kiosk.name, kiosk.siteName);
    res.json({ ok: true, kiosk, code, kioskUrl: kioskAddress(req) });
  });

  router.put("/api/kiosks/:id", admin, (req, res) => {
    const kiosk = kiosks.update(positiveInt(req.params.id), req.body || {});
    auditFrom(req, "kiosk.update", kiosk.name, kiosk.siteName);
    res.json({ ok: true, kiosk });
  });

  /** A new pairing code; the device paired before is signed out. */
  router.post("/api/kiosks/:id/code", admin, (req, res) => {
    const { kiosk, code } = kiosks.newCode(positiveInt(req.params.id));
    auditFrom(req, "kiosk.code", kiosk.name, "new pairing code; any paired device signed out");
    res.json({ ok: true, kiosk, code, kioskUrl: kioskAddress(req) });
  });

  router.delete("/api/kiosks/:id", admin, (req, res) => {
    const kiosk = kiosks.remove(positiveInt(req.params.id));
    auditFrom(req, "kiosk.remove", kiosk.name, kiosk.siteName);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createVisitorRoutes, parseTime };
