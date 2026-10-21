/**
 * Staff routes for badges (who holds which, assigning and taking back), the clearance
 * levels and badge classifications (administrators), and visitor events (expected guests).
 * Mounted after the sign-in check, so req.user and req.ctx are set.
 *
 * Badges need the role's badge access (read to look, edit to add, assign and take back);
 * events need visitor access. Assigning checks the holder is someone the caller can see,
 * and badges.js refuses anyone the badge's type or clearance level doesn't allow.
 *
 * Clearance level names (and ids) go only to roles that see clearance levels (Settings >
 * Roles). Everyone gets each badge's template image instead (badge-templates.js), and the
 * others choose a cleared badge's level by its image.
 */
const express = require("express");
const { TYPES, TYPE_LABELS, STATUSES } = require("./badges");
const { kindFor, KINDS, KIND_LABELS } = require("./badge-templates");

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

function createBadgeRoutes({ access, badges, clearance, templates, events, visitors, directory, admin, auditFrom, transaction = (fn) => fn() }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;

  const need = (test, message) => (req, res, next) => (test(req.ctx) ? next() : res.status(403).json({ error: message }));
  const readBadges = need(access.canReadBadges, "This account can't see badges.");
  const editBadges = need(access.canEditBadges, "This account can't give badges out or take them back.");
  const manageBadges = need(access.canManageBadges, "Only Security adds, changes and removes badges.");
  const readVisitors = need(access.canReadVisitors, "This account can't see visitors.");
  const editVisitors = need(access.canEditVisitors, "This account can't change visitors.");

  function siteParam(req, value) {
    const siteId = positiveInt(value);
    if (siteId && !access.siteVisible(req.ctx, siteId)) throw fail(403, "This account can't see that site.");
    return siteId;
  }

  /** The holder, if the caller can see them (people through the directory's site limits). */
  function visibleHolder(req, kind, id) {
    if (kind === "person") return directory.getPerson(id, { sites: req.ctx.sites });
    if (kind === "visitor") return visitors.get(id, { sites: req.ctx.sites });
    throw fail(400, "A badge goes to a person or a visitor.");
  }

  // --- what the caller may know of clearance levels ------------------------------------------

  const seesLevels = (req) => access.canSeeClearances(req.ctx);

  /** A badge as the caller may see it: with its template image, and its level only for those who see levels. */
  function badgeOut(req, b) {
    if (!b) return b;
    // cleared says only what the classification already does: whether it carries a level.
    const out = { ...b, cleared: Boolean(b.clearanceLevelId), template: templates.refFor(b.type, b.clearanceLevelId) };
    if (!seesLevels(req)) {
      delete out.clearanceLevelId;
      delete out.clearanceLevelName;
    }
    return out;
  }

  /**
   * A badge's level from a request body. Those who don't see level names choose it by its
   * template image (templateRef); a level id from them is refused.
   */
  function levelInput(req, body, badgeType) {
    const out = { ...body };
    if (out.templateRef !== undefined) {
      const t = out.templateRef ? templates.byRef(out.templateRef) : null;
      if (out.templateRef && (!t || !t.levelId)) throw fail(400, "Choose one of the cleared badges' images.");
      if (t && t.kind !== kindFor(badgeType)) throw fail(400, "That image is for another kind of badge.");
      out.clearanceLevelId = t ? t.levelId : null;
      delete out.templateRef;
    } else if (out.clearanceLevelId !== undefined && !seesLevels(req)) {
      throw fail(403, "Choose a cleared badge's level by its image.");
    }
    return out;
  }

  // --- clearance levels and classifications -----------------------------------------------

  router.get("/api/clearance", (req, res) => {
    res.json({ levels: seesLevels(req) ? clearance.levels() : [], classifications: clearance.classifications(), badgeTypes: TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })), badgeStatuses: STATUSES });
  });

  router.post("/api/clearance/levels", admin, (req, res) => {
    const level = clearance.createLevel(req.body || {});
    auditFrom(req, "clearance.level_add", level.name, `order ${level.rank}`);
    res.json({ ok: true, level });
  });

  router.put("/api/clearance/levels/:id", admin, (req, res) => {
    const level = clearance.updateLevel(positiveInt(req.params.id), req.body || {});
    auditFrom(req, "clearance.level_update", level.name, `order ${level.rank}`);
    res.json({ ok: true, level });
  });

  router.delete("/api/clearance/levels/:id", admin, (req, res) => {
    const level = clearance.removeLevel(positiveInt(req.params.id));
    auditFrom(req, "clearance.level_remove", level.name);
    res.json({ ok: true });
  });

  router.post("/api/clearance/classifications", admin, (req, res) => {
    const c = clearance.createClassification(req.body || {});
    auditFrom(req, "clearance.classification_add", c.name, c.requiresClearance ? "needs a clearance level" : "no clearance level");
    res.json({ ok: true, classification: c });
  });

  router.put("/api/clearance/classifications/:id", admin, (req, res) => {
    const c = clearance.updateClassification(positiveInt(req.params.id), req.body || {});
    auditFrom(req, "clearance.classification_update", c.name, c.requiresClearance ? "needs a clearance level" : "no clearance level");
    res.json({ ok: true, classification: c });
  });

  router.delete("/api/clearance/classifications/:id", admin, (req, res) => {
    const c = clearance.removeClassification(positiveInt(req.params.id));
    auditFrom(req, "clearance.classification_remove", c.name);
    res.json({ ok: true });
  });

  // --- badges ------------------------------------------------------------------------------

  router.get("/api/badges", readBadges, (req, res) => {
    const found = badges.list({
      q: str(req.query.q),
      type: str(req.query.type),
      state: str(req.query.state),
      classificationId: positiveInt(req.query.classificationId),
      levelId: seesLevels(req) ? positiveInt(req.query.levelId) : null,
      siteId: siteParam(req, req.query.site),
      sites: req.ctx.sites,
      limit: Math.min(positiveInt(req.query.limit, 200), 5000),
      offset: Math.max(0, Number(str(req.query.offset)) || 0)
    });
    res.json({ ...found, badges: found.badges.map((b) => badgeOut(req, b)) });
  });

  router.get("/api/badges/:id", readBadges, (req, res) => {
    const badge = badges.get(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!badge) throw fail(404, "No such badge.");
    res.json({ badge: badgeOut(req, badge), history: badges.history(badge.id) });
  });

  router.post("/api/badges", manageBadges, (req, res) => {
    const body = req.body || {};
    const badge = badges.create(levelInput(req, body, body.type), { sites: req.ctx.sites });
    auditFrom(req, "badge.add", badge.number, `${badge.type}; ${badge.classificationName}${badge.clearanceLevelName ? ` ${badge.clearanceLevelName}` : ""}`);
    res.json({ ok: true, badge: badgeOut(req, badge) });
  });

  router.post("/api/badges/range", manageBadges, (req, res) => {
    const body = req.body || {};
    const made = badges.createRange(levelInput(req, body, body.type), { sites: req.ctx.sites });
    auditFrom(req, "badge.add", `${made.length} badges`, `${made[0]?.number} to ${made[made.length - 1]?.number}`);
    res.json({ ok: true, count: made.length, first: badgeOut(req, made[0]), last: badgeOut(req, made[made.length - 1]) });
  });

  router.put("/api/badges/:id", manageBadges, (req, res) => {
    const id = positiveInt(req.params.id);
    const existing = badges.get(id, { sites: req.ctx.sites });
    if (!existing) throw fail(404, "No such badge.");
    const body = req.body || {};
    const badge = badges.update(id, levelInput(req, body, body.type || existing.type), { sites: req.ctx.sites });
    auditFrom(req, "badge.update", badge.number, Object.keys(body).join(", "));
    res.json({ ok: true, badge: badgeOut(req, badge) });
  });

  router.delete("/api/badges/:id", manageBadges, (req, res) => {
    const badge = badges.remove(positiveInt(req.params.id));
    auditFrom(req, "badge.remove", badge.number);
    res.json({ ok: true });
  });

  // --- several badges at once (Security) ---------------------------------------------------------

  function badgeIds(body) {
    const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw fail(400, "Choose at least one badge.");
    if (ids.length > 1000) throw fail(400, "At most 1,000 badges at once.");
    return ids;
  }

  /** Runs `fn` for each badge in one transaction: if any fails, none changes, and each problem is named. */
  function allOrNothing(ids, fn) {
    const errors = [];
    let done = 0;
    try {
      transaction(() => {
        for (const id of ids) {
          try {
            fn(id);
            done += 1;
          } catch (error) {
            const number = badges.get(id)?.number;
            errors.push(`${number ? `Badge ${number}` : `Badge ${id}`}: ${error.message}`);
          }
        }
        if (errors.length) throw fail(400, "rollback");
      });
    } catch (error) {
      if (!errors.length) throw error;
      throw fail(409, `Nothing was changed. ${errors.length} of them ${errors.length === 1 ? "has" : "have"} a problem:\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n...and ${errors.length - 10} more.` : ""}`);
    }
    return done;
  }

  const BULK_KEYS = ["type", "classificationId", "clearanceLevelId", "templateRef", "siteIds", "temporary", "status", "notes"];

  /**
   * Changes the same things on several badges: move them to another type (visitor, tenant,
   * personnel), classification or level, the sites they are valid at, temporary, status, notes.
   * A badge that is out can't change its type, classification, level or temporary flag.
   */
  router.post("/api/badges/bulk", manageBadges, (req, res) => {
    const ids = badgeIds(req.body);
    const patch = req.body?.patch && typeof req.body.patch === "object" ? req.body.patch : {};
    const input = Object.fromEntries(BULK_KEYS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    if (!Object.keys(input).length) throw fail(400, "Choose what to change.");
    const done = allOrNothing(ids, (id) => {
      const badge = badges.get(id, { sites: req.ctx.sites });
      if (!badge) throw fail(404, "no such badge, or not at your sites.");
      badges.update(id, levelInput(req, input, input.type || badge.type), { sites: req.ctx.sites });
    });
    auditFrom(req, "badge.bulk_update", `${done} badges`, Object.keys(input).join(", "));
    res.json({ ok: true, updated: done });
  });

  router.post("/api/badges/bulk-delete", manageBadges, (req, res) => {
    const ids = badgeIds(req.body);
    const numbers = [];
    const done = allOrNothing(ids, (id) => { numbers.push(badges.remove(id, { sites: req.ctx.sites }).number); });
    auditFrom(req, "badge.remove", `${done} badges`, numbers.slice(0, 50).join(", "));
    res.json({ ok: true, deleted: done });
  });

  router.post("/api/badges/:id/assign", editBadges, (req, res) => {
    const body = req.body || {};
    const holderId = positiveInt(body.holderId);
    if (!visibleHolder(req, body.kind, holderId)) throw fail(404, "No such person or visitor.");
    const badge = badges.assign(positiveInt(req.params.id), { kind: body.kind, holderId, visitId: positiveInt(body.visitId), replacesBadgeId: positiveInt(body.replacesBadgeId) }, { by: staffName(req), sites: req.ctx.sites, levelNames: seesLevels(req) });
    auditFrom(req, "badge.assign", badge.number, `to ${badge.holder.name}${badge.holder.company ? ` (${badge.holder.company})` : ""}${badge.holder.temporary ? `; temporary, in place of ${badge.holder.replacesNumber}, due back ${new Date(badge.holder.dueAt).toISOString()}` : ""}`);
    res.json({ ok: true, badge: badgeOut(req, badge) });
  });

  router.post("/api/badges/:id/return", editBadges, (req, res) => {
    const { badge, from } = badges.takeBack(positiveInt(req.params.id), { outcome: req.body?.outcome || "returned", note: req.body?.note }, { by: staffName(req), sites: req.ctx.sites });
    auditFrom(req, req.body?.outcome === "lost" ? "badge.lost" : "badge.return", badge.number, `from ${from.name}`);
    res.json({ ok: true, badge: badgeOut(req, badge) });
  });

  /** A person's or visitor's badges, and (for those who may assign) the ones they could be given. */
  router.get("/api/badge-holders/:kind/:id", readBadges, (req, res) => {
    const kind = req.params.kind;
    const id = positiveInt(req.params.id);
    if (!visibleHolder(req, kind, id)) throw fail(404, "No such person or visitor.");
    const held = badges.forHolder(kind, id);
    const short = (b) => {
      const out = badgeOut(req, b);
      return { id: out.id, number: out.number, type: out.type, classificationName: out.classificationName, clearanceLevelName: out.clearanceLevelName, template: out.template, sites: out.sites };
    };
    const canGive = access.canEditBadges(req.ctx);
    // ?site= offers only badges valid at that site (where they are checking in).
    const atSite = siteParam(req, req.query.site);
    const validThere = (b) => !atSite || !b.sites.length || b.sites.some((s) => s.id === atSite);
    const available = canGive ? badges.availableFor(kind, id, { sites: req.ctx.sites }).filter(validThere) : [];
    // The image of the highest badge on offer that they may hold, shown large to whoever gives
    // badges out: the badge to hand over (uncleared ones rank lowest).
    const rank = new Map(clearance.levels().map((l) => [l.id, l.rank]));
    const best = available.reduce((top, b) => (!top || (rank.get(b.clearanceLevelId) ?? -1) > (rank.get(top.clearanceLevelId) ?? -1) ? b : top), null);
    res.json({
      current: held.filter((a) => !a.returnedAt),
      past: held.filter((a) => a.returnedAt),
      available: available.map(short),
      // Temporary badges they could borrow for the day: only someone holding a badge of their own.
      temporary: canGive && kind === "person" ? badges.availableFor(kind, id, { sites: req.ctx.sites, temporary: true }).map(short) : [],
      suggested: best ? templates.refFor(best.type, best.clearanceLevelId) : null
    });
  });

  // --- badge template images ------------------------------------------------------------------

  /** Every template: with level names for those who see them, else only which kind each is and whether it is a cleared one. */
  router.get("/api/badge-templates", (req, res) => {
    if (!access.canReadBadges(req.ctx) && !req.ctx.isAdmin) throw fail(403, "This account can't see badges.");
    const levels = new Map(clearance.levels().map((l) => [l.id, l]));
    const list = templates.list();
    res.json({
      kinds: KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] })),
      templates: seesLevels(req)
        ? list.map((t) => ({ ...t, levelName: t.levelId ? levels.get(t.levelId)?.name || null : null }))
        : list.map((t) => ({ kind: t.kind, ref: t.ref, cleared: t.levelId > 0 }))
    });
  });

  router.get("/api/badge-templates/:ref/image", (req, res) => {
    if (!access.canReadBadges(req.ctx) && !req.ctx.isAdmin) throw fail(403, "This account can't see badges.");
    const image = templates.image(req.params.ref);
    if (!image) throw fail(404, "No such image.");
    res.setHeader("Content-Type", image.type);
    // The ref changes with every upload, so an image can be kept for as long as it lasts.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(image.data);
  });

  /** :levelId is a clearance level's id, or 0 for uncleared badges; :kind is tenant or visitor. */
  function templateTarget(req) {
    const levelId = req.params.levelId === "0" ? 0 : positiveInt(req.params.levelId);
    if (levelId === null) throw fail(404, "No such clearance level.");
    const level = levelId ? clearance.level(levelId) : null;
    if (levelId && !level) throw fail(404, "No such clearance level.");
    return { levelId, kind: req.params.kind, name: `${level ? level.name : "Uncleared"} ${String(KIND_LABELS[req.params.kind] || "").toLowerCase()}` };
  }

  router.put("/api/badge-templates/:levelId/:kind", admin, (req, res) => {
    const target = templateTarget(req);
    const saved = templates.set(target.levelId, target.kind, req.body?.dataUrl);
    auditFrom(req, "badge_template.set", target.name);
    res.json({ ok: true, template: saved });
  });

  router.delete("/api/badge-templates/:levelId/:kind", admin, (req, res) => {
    const target = templateTarget(req);
    templates.remove(target.levelId, target.kind);
    auditFrom(req, "badge_template.remove", target.name);
    res.json({ ok: true });
  });

  // --- visitor events ----------------------------------------------------------------------------

  /** YYYY-MM-DD from the query, or today on the server. */
  function day(value) {
    const v = str(value, 10);
    if (!v) return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail(400, "Dates look like 2026-10-14.");
    return v;
  }

  router.get("/api/events", readVisitors, (req, res) => {
    const from = day(req.query.from || req.query.date);
    const to = day(req.query.to || req.query.date || from);
    res.json({ events: events.list({ from, to, siteId: siteParam(req, req.query.site), sites: req.ctx.sites }) });
  });

  router.get("/api/events/:id", readVisitors, (req, res) => {
    const event = events.get(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!event) throw fail(404, "No such event.");
    res.json({ event });
  });

  router.post("/api/events", editVisitors, (req, res) => {
    const event = events.create(req.body || {}, { by: staffName(req), sites: req.ctx.sites });
    auditFrom(req, "event.add", event.title, `${event.siteName} ${event.date}${event.companyName ? `; ${event.companyName}` : ""}`);
    res.json({ ok: true, event });
  });

  router.put("/api/events/:id", editVisitors, (req, res) => {
    const event = events.update(positiveInt(req.params.id), req.body || {}, { sites: req.ctx.sites });
    auditFrom(req, "event.update", event.title, Object.keys(req.body || {}).join(", "));
    res.json({ ok: true, event });
  });

  router.delete("/api/events/:id", editVisitors, (req, res) => {
    const event = events.remove(positiveInt(req.params.id), { sites: req.ctx.sites });
    auditFrom(req, "event.remove", event.title, `${event.siteName} ${event.date}`);
    res.json({ ok: true });
  });

  /**
   * Adds an expected guest: { visitorId } for someone on record, or { visitor: { firstName,
   * lastName, organisation, email, phone } } for someone new, who is added as a checked
   * visitor (so the kiosk finds them) and linked to the event's company and host.
   */
  router.post("/api/events/:id/guests", editVisitors, (req, res) => {
    const event = events.get(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!event) throw fail(404, "No such event.");
    let visitorId = positiveInt(req.body?.visitorId);
    if (visitorId && !visitors.get(visitorId, { sites: req.ctx.sites })) throw fail(404, "No such visitor.");
    if (!visitorId) {
      const v = req.body?.visitor || {};
      // Someone of that name may be on record already: say so, unless told to add anyway.
      if (!req.body?.addAnyway && v.firstName && v.lastName) {
        const same = visitors.findByName(`${v.firstName} ${v.lastName}`).map((id) => visitors.get(id, { sites: req.ctx.sites })).filter(Boolean).slice(0, 3);
        if (same.length) {
          const err = fail(409, `Already on record: ${same.map((x) => `${x.firstName} ${x.lastName}${x.organisation ? ` (${x.organisation})` : ""}`).join("; ")}. Pick them from the list, or add a new visitor anyway.`);
          err.duplicate = true;
          throw err;
        }
      }
      const links = event.companyId ? [{ companyId: event.companyId, hostId: event.hostId }] : [];
      const created = visitors.create({ firstName: v.firstName, lastName: v.lastName, organisation: v.organisation, email: v.email, phone: v.phone, links }, { sites: req.ctx.sites, source: "staff", verified: true });
      visitorId = created.id;
      auditFrom(req, "visitor.add", `${created.firstName} ${created.lastName}`, `expected at ${event.title}`);
    } else if (event.companyId) {
      // Someone on record: the event's company joins those they visit, if it isn't there yet.
      const known = visitors.get(visitorId);
      if (!known.companies.some((c) => c.companyId === event.companyId)) visitors.setLink(visitorId, { companyId: event.companyId, hostId: event.hostId });
    }
    const updated = events.addGuest(event.id, visitorId, { sites: req.ctx.sites });
    const guest = updated.guests.find((g) => g.visitorId === visitorId);
    auditFrom(req, "event.guest_add", event.title, `${guest.firstName} ${guest.lastName}`);
    res.json({ ok: true, event: updated });
  });

  router.delete("/api/events/:id/guests/:visitorId", editVisitors, (req, res) => {
    const before = events.get(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!before) throw fail(404, "No such event.");
    const guest = before.guests.find((g) => g.visitorId === positiveInt(req.params.visitorId));
    const event = events.removeGuest(before.id, positiveInt(req.params.visitorId), { sites: req.ctx.sites });
    if (guest) auditFrom(req, "event.guest_remove", event.title, `${guest.firstName} ${guest.lastName}`);
    res.json({ ok: true, event });
  });

  return router;
}

module.exports = { createBadgeRoutes };
