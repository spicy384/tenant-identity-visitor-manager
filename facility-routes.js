/**
 * Facilities routes: floors and their plans, offices, who has each office and when, and
 * rates. Seeing any of it takes a role's facilities access (read); drawing floors and
 * offices, assigning them and setting rates takes edit. Administrator and Manager have edit
 * by default, and Settings > Roles gives it (or read) to any other staff role.
 * Everything follows the caller's sites.
 *
 * Every office assignment belongs to a lease (leases.js): one made here gets a lease of its
 * own; new dates for a lease's only office change the lease too, and for one office of
 * several move it to a lease of its own; one removed here leaves its lease.
 */
const express = require("express");
const { STATUSES } = require("./facilities");

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

function createFacilityRoutes({ access, facilities, leases, directory, sites, auditFrom }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const need = (test, message) => (req, res, next) => (test(req.ctx) ? next() : res.status(403).json({ error: message }));
  const readFacilities = need(access.canReadFacilities, "This account can't see facilities.");
  const editFacilities = need(access.canEditFacilities, "This account can't change facilities.");
  const scoped = (req) => ({ scope: req.ctx.sites });
  const money = (n) => (n === null || n === undefined ? "none" : `$${n}`);

  function siteParam(req, value) {
    const siteId = positiveInt(value);
    if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
    return siteId;
  }

  const idOf = (req) => {
    const id = positiveInt(req.params.id);
    if (!id) throw fail(404, "Not found.");
    return id;
  };

  // --- overview -------------------------------------------------------------------------------

  /** Offices by status, square feet and monthly rent, at the caller's sites (or one). */
  router.get("/api/facilities/summary", readFacilities, (req, res) => {
    res.json({ summary: facilities.summary({ ...scoped(req), siteId: siteParam(req, req.query.site || req.query.siteId) }) });
  });

  /** Companies an office can be assigned to: the active ones the caller can see. */
  router.get("/api/facilities/companies", readFacilities, (req, res) => {
    const { records } = directory.listCompanies({ sites: req.ctx.sites, limit: 100000 });
    res.json({ companies: records.map((c) => ({ id: c.id, name: c.name })) });
  });

  // --- floors ---------------------------------------------------------------------------------

  router.get("/api/floors", readFacilities, (req, res) => {
    res.json({ floors: facilities.listFloors({ ...scoped(req), siteId: siteParam(req, req.query.site || req.query.siteId) }) });
  });

  /** A floor with its offices, as the plan shows them. */
  router.get("/api/floors/:id", readFacilities, (req, res) => {
    const floor = facilities.getFloor(idOf(req), scoped(req));
    if (!floor) throw fail(404, "No such floor, or not at your sites.");
    res.json({ floor, offices: facilities.listOffices({ ...scoped(req), floorId: floor.id }) });
  });

  router.post("/api/floors", editFacilities, (req, res) => {
    const floor = facilities.createFloor(req.body || {}, scoped(req));
    auditFrom(req, "floor.add", `${floor.siteName}: ${floor.name}`);
    res.json({ ok: true, floor });
  });

  router.put("/api/floors/:id", editFacilities, (req, res) => {
    const floor = facilities.updateFloor(idOf(req), req.body || {}, scoped(req));
    auditFrom(req, "floor.update", `${floor.siteName}: ${floor.name}`);
    res.json({ ok: true, floor });
  });

  router.delete("/api/floors/:id", editFacilities, (req, res) => {
    const floor = facilities.removeFloor(idOf(req), scoped(req));
    auditFrom(req, "floor.remove", `${floor.siteName}: ${floor.name}`, `${floor.offices} offices removed with it`);
    res.json({ ok: true });
  });

  router.put("/api/floors/:id/plan", editFacilities, (req, res) => {
    const floor = facilities.setPlan(idOf(req), req.body?.dataUrl, scoped(req));
    auditFrom(req, "floor.plan", `${floor.siteName}: ${floor.name}`);
    res.json({ ok: true, floor });
  });

  router.delete("/api/floors/:id/plan", editFacilities, (req, res) => {
    const floor = facilities.clearPlan(idOf(req), scoped(req));
    auditFrom(req, "floor.plan_remove", `${floor.siteName}: ${floor.name}`);
    res.json({ ok: true, floor });
  });

  /** The floor's scale, from a line drawn on its plan: { from: [x, y], to: [x, y], feet }; feet null clears it. */
  router.put("/api/floors/:id/scale", editFacilities, (req, res) => {
    const floor = facilities.setScale(idOf(req), req.body || {}, scoped(req));
    auditFrom(req, "floor.scale", `${floor.siteName}: ${floor.name}`, floor.scale ? `${floor.scale.line.feet} ft line; the plan is ${Math.round(floor.scale.feet)} ft across` : "cleared");
    res.json({ ok: true, floor });
  });

  router.get("/api/floor-plans/:ref", readFacilities, (req, res) => {
    const image = facilities.planImage(req.params.ref, scoped(req));
    if (!image) throw fail(404, "No such floor plan.");
    res.setHeader("Content-Type", image.type);
    // The ref changes with every upload, so a plan can be kept for as long as it lasts.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(image.data);
  });

  // --- offices --------------------------------------------------------------------------------

  router.get("/api/offices", readFacilities, (req, res) => {
    const status = str(req.query.status, 20);
    if (status && !STATUSES.includes(status)) throw fail(400, `Status is one of: ${STATUSES.join(", ")}.`);
    res.json({ offices: facilities.listOffices({ ...scoped(req), siteId: siteParam(req, req.query.site || req.query.siteId), floorId: positiveInt(req.query.floorId), status, roomTypeId: positiveInt(req.query.roomTypeId),
      freeFrom: str(req.query.freeFrom, 10) || null, freeTo: str(req.query.freeTo, 10) || null }) });
  });

  router.get("/api/offices/:id", readFacilities, (req, res) => {
    const office = facilities.getOffice(idOf(req), scoped(req));
    if (!office) throw fail(404, "No such office, or not at your sites.");
    res.json({ office });
  });

  router.post("/api/offices", editFacilities, (req, res) => {
    const office = facilities.createOffice(req.body || {}, scoped(req));
    auditFrom(req, "office.add", `${office.floorName}: ${office.name}`, `${office.sqft ?? "?"} sq ft`);
    res.json({ ok: true, office });
  });

  router.put("/api/offices/:id", editFacilities, (req, res) => {
    const office = facilities.updateOffice(idOf(req), req.body || {}, scoped(req));
    // Moving or reshaping it on the plan isn't worth an audit entry; anything else is.
    const changed = Object.keys(req.body || {}).filter((k) => !["x", "y", "w", "h", "points"].includes(k));
    if (changed.length) auditFrom(req, "office.update", `${office.floorName}: ${office.name}`, changed.map((k) => (k === "rate" ? `rate ${money(office.rate)}` : k)).join(", "));
    res.json({ ok: true, office });
  });

  /** Changes several rooms at once: { ids, patch: { roomTypeId, classId, rate, unavailable, notes } }, all or none. */
  router.post("/api/offices/bulk", editFacilities, (req, res) => {
    const rooms = facilities.updateMany(req.body?.ids, req.body?.patch || {}, scoped(req));
    const changed = Object.keys(req.body?.patch || {}).map((k) => (k === "rate" ? `rate ${money(rooms[0].rate)}` : k));
    auditFrom(req, "office.bulk_update", `${rooms.length} rooms`, `${rooms.map((o) => o.name).join(", ").slice(0, 600)}: ${changed.join(", ")}`);
    res.json({ ok: true, updated: rooms.length });
  });

  router.post("/api/offices/bulk-delete", editFacilities, (req, res) => {
    const rooms = facilities.removeMany(req.body?.ids, scoped(req));
    auditFrom(req, "office.remove", `${rooms.length} rooms`, rooms.map((o) => `${o.floorName}: ${o.name}`).join(", ").slice(0, 600));
    res.json({ ok: true, deleted: rooms.length });
  });

  router.delete("/api/offices/:id", editFacilities, (req, res) => {
    const office = facilities.removeOffice(idOf(req), scoped(req));
    auditFrom(req, "office.remove", `${office.floorName}: ${office.name}`);
    res.json({ ok: true });
  });

  // --- assignments ----------------------------------------------------------------------------

  router.post("/api/offices/:id/assignments", editFacilities, (req, res) => {
    const { office, assignment } = facilities.assign(idOf(req), req.body || {}, { ...scoped(req), by: staffName(req) });
    leases.adoptAssignments({ by: staffName(req) });
    auditFrom(req, "office.assign", `${office.floorName}: ${office.name}`, `${assignment.companyName} from ${assignment.startDate}${assignment.endDate ? ` to ${assignment.endDate}` : ""}`);
    res.json({ ok: true, office, assignment });
  });

  router.put("/api/office-assignments/:id", editFacilities, (req, res) => {
    const held = leases.leaseOfAssignment(idOf(req));
    // New dates for one office of a lease of several: it leaves that lease for one of its own.
    const changesDates = req.body?.startDate !== undefined || req.body?.endDate !== undefined;
    const splitting = held?.leaseId && held.offices > 1 && changesDates;
    if (splitting) leases.mayLeave(held.leaseId);
    const { office, assignment } = facilities.updateAssignment(idOf(req), req.body || {}, { ...scoped(req), by: staffName(req) });
    if (splitting) leases.leave(assignment.id, { by: staffName(req) });
    else if (held?.leaseId) leases.syncAfterAssignment(assignment.id, held.leaseId);
    auditFrom(req, "office.assignment_update", `${office.floorName}: ${office.name}`, `${assignment.companyName}: ${assignment.startDate} to ${assignment.endDate || "no end date"}`);
    res.json({ ok: true, office, assignment });
  });

  router.delete("/api/office-assignments/:id", editFacilities, (req, res) => {
    const held = leases.leaseOfAssignment(idOf(req));
    const { office, assignment } = facilities.removeAssignment(idOf(req), scoped(req));
    if (held?.leaseId) leases.syncAfterAssignment(assignment.id, held.leaseId);
    auditFrom(req, "office.assignment_remove", `${office.floorName}: ${office.name}`, `${assignment.companyName}: ${assignment.startDate} to ${assignment.endDate || "no end date"}`);
    res.json({ ok: true, office });
  });

  // --- room types and classifications ---------------------------------------------------------

  router.get("/api/facilities/room-kinds", readFacilities, (req, res) => {
    res.json(facilities.roomKinds());
  });

  router.post("/api/facilities/room-types", editFacilities, (req, res) => {
    const type = facilities.createRoomType(req.body || {});
    auditFrom(req, "room_type.add", type.name, `${type.color}${type.assignable ? ", assigned to companies" : ", shared"}`);
    res.json({ ok: true, type });
  });

  router.put("/api/facilities/room-types/:id", editFacilities, (req, res) => {
    const type = facilities.updateRoomType(idOf(req), req.body || {});
    auditFrom(req, "room_type.update", type.name, `${type.color}${type.assignable ? ", assigned to companies" : ", shared"}`);
    res.json({ ok: true, type });
  });

  router.delete("/api/facilities/room-types/:id", editFacilities, (req, res) => {
    const type = facilities.removeRoomType(idOf(req));
    auditFrom(req, "room_type.remove", type.name);
    res.json({ ok: true });
  });

  router.post("/api/facilities/room-classes", editFacilities, (req, res) => {
    const kind = facilities.createRoomClass(req.body || {});
    auditFrom(req, "room_class.add", kind.name, kind.color);
    res.json({ ok: true, classification: kind });
  });

  router.put("/api/facilities/room-classes/:id", editFacilities, (req, res) => {
    const kind = facilities.updateRoomClass(idOf(req), req.body || {});
    auditFrom(req, "room_class.update", kind.name, kind.color);
    res.json({ ok: true, classification: kind });
  });

  router.delete("/api/facilities/room-classes/:id", editFacilities, (req, res) => {
    const kind = facilities.removeRoomClass(idOf(req));
    auditFrom(req, "room_class.remove", kind.name);
    res.json({ ok: true });
  });

  router.put("/api/facilities/unclassified-color", editFacilities, (req, res) => {
    const color = facilities.setUnclassifiedColor(req.body?.color);
    auditFrom(req, "room_class.update", "Unclassified", color);
    res.json({ ok: true, color });
  });

  // --- rates and companies --------------------------------------------------------------------

  router.get("/api/facilities/rates", readFacilities, (req, res) => {
    res.json(facilities.rates(scoped(req)));
  });

  router.put("/api/facilities/site-rates/:id", editFacilities, (req, res) => {
    const siteId = siteParam(req, req.params.id);
    if (!siteId) throw fail(404, "No such site.");
    const rate = facilities.setSiteRate(siteId, req.body?.rate);
    auditFrom(req, "facilities.site_rate", sites.get(siteId)?.name || String(siteId), money(rate));
    res.json({ ok: true, rate });
  });

  router.put("/api/facilities/company-rates/:id", editFacilities, (req, res) => {
    const company = directory.getCompany(idOf(req), { sites: req.ctx.sites });
    if (!company) throw fail(404, "No such company, or not at your sites.");
    const rate = facilities.setCompanyRate(company.id, req.body?.rate);
    auditFrom(req, "facilities.company_rate", company.name, money(rate));
    res.json({ ok: true, rate });
  });

  /** Assigns several offices to a company for the same dates (all or none): { officeIds, startDate, endDate, notes }. */
  router.post("/api/companies/:id/offices", editFacilities, (req, res) => {
    const company = directory.getCompany(idOf(req), { sites: req.ctx.sites });
    if (!company) throw fail(404, "No such company, or not at your sites.");
    const done = facilities.assignMany(company.id, req.body?.officeIds, req.body || {}, { ...scoped(req), by: staffName(req) });
    leases.adoptAssignments({ by: staffName(req) });
    const first = done[0].assignment;
    auditFrom(req, "office.assign", company.name, `${done.map((d) => `${d.office.floorName}: ${d.office.name}`).join(", ")} from ${first.startDate}${first.endDate ? ` to ${first.endDate}` : ""}`);
    res.json({ ok: true, assigned: done.length });
  });

  /** A company's offices (now, later and before), its own rate, and what it pays a month now. */
  router.get("/api/companies/:id/facilities", readFacilities, (req, res) => {
    const company = directory.getCompany(idOf(req), { sites: req.ctx.sites });
    if (!company) throw fail(404, "No such company, or not at your sites.");
    res.json(facilities.forCompany(company.id, scoped(req)));
  });

  return router;
}

module.exports = { createFacilityRoutes };
