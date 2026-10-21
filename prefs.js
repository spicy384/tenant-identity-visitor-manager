/**
 * Each person's own preferences, kept on the server so they follow them to any device: the
 * site they last chose in the header, the modules on their dashboard (Home), in order, and
 * light or dark (or as the device is set).
 *
 * A module is offered only to roles that may see what it shows; one a person can no longer
 * see (their role changed) is left out of what they get back, and refused when saved.
 */

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const THEMES = ["auto", "light", "dark"];

function createPrefs({ db, access }) {
  const securityOrAdmin = (ctx) => (access.isSecurity(ctx) || ctx.isAdmin) && access.canSeeClearances(ctx);
  const MODULES = {
    badgeNeeded: (ctx) => access.canReadVisitors(ctx) && access.canEditBadges(ctx),
    here: (ctx) => access.canReadVisitors(ctx),
    expected: (ctx) => access.canReadVisitors(ctx),
    review: (ctx) => access.canReadVisitors(ctx),
    badgesOut: (ctx) => access.canReadBadges(ctx),
    tenants: (ctx) => access.canReadDirectory(ctx),
    clearanceQueue: (ctx) => access.isSecurity(ctx),
    rechecks: securityOrAdmin,
    expiring: securityOrAdmin,
    validations: securityOrAdmin,
    occupancy: (ctx) => access.canReadFacilities(ctx)
  };
  // What each role starts with, in order (only the modules it may see are kept).
  const DEFAULTS = {
    security: ["clearanceQueue", "rechecks", "expiring", "badgesOut", "here"],
    admin: ["here", "expected", "badgeNeeded", "rechecks", "badgesOut", "tenants", "occupancy"],
    other: ["badgeNeeded", "expected", "here", "review", "badgesOut", "tenants", "occupancy"]
  };

  const available = (ctx) => Object.keys(MODULES).filter((id) => MODULES[id](ctx));
  const defaults = (ctx) => (DEFAULTS[ctx.role?.id] || DEFAULTS.other).filter((id) => MODULES[id](ctx));
  const key = (user) => `prefs.${user.id}`;

  /** { site, dashboard (the modules they see, in order), available, defaults }. */
  function get(user, ctx) {
    const stored = db.readDoc(key(user), {}) || {};
    const allowed = new Set(available(ctx));
    const site = stored.site && (!ctx.sites || ctx.sites.has(Number(stored.site))) ? Number(stored.site) : null;
    const dashboard = Array.isArray(stored.dashboard) ? stored.dashboard.filter((id) => allowed.has(id)) : defaults(ctx);
    const theme = THEMES.includes(stored.theme) ? stored.theme : "auto";
    return { site, dashboard, theme, available: [...allowed], defaults: defaults(ctx) };
  }

  /** Saves what is given: site (a site id, or null for all their sites) and dashboard (module ids, or null for the defaults). */
  function save(user, ctx, patch = {}, { siteExists = () => true } = {}) {
    const stored = db.readDoc(key(user), {}) || {};
    const next = { ...stored };
    if (patch.site !== undefined) {
      if (patch.site === null || patch.site === "") next.site = null;
      else {
        const id = Number(patch.site);
        if (!Number.isInteger(id) || !siteExists(id)) throw fail(400, "No such site.");
        if (ctx.sites && !ctx.sites.has(id)) throw fail(403, "This account can't see that site.");
        next.site = id;
      }
    }
    if (patch.theme !== undefined) {
      if (!THEMES.includes(patch.theme)) throw fail(400, "The theme is auto, light or dark.");
      next.theme = patch.theme;
    }
    if (patch.dashboard !== undefined) {
      if (patch.dashboard === null) delete next.dashboard;
      else {
        if (!Array.isArray(patch.dashboard) || patch.dashboard.length > 20) throw fail(400, "A dashboard is a list of modules.");
        const allowed = new Set(available(ctx));
        const list = [...new Set(patch.dashboard.map(String))];
        const refused = list.filter((id) => !allowed.has(id));
        if (refused.length) throw fail(403, `Not available to this account: ${refused.join(", ")}.`);
        next.dashboard = list;
      }
    }
    db.writeDoc(key(user), next);
    return get(user, ctx);
  }

  return { get, save, modules: Object.keys(MODULES) };
}

module.exports = { createPrefs };
