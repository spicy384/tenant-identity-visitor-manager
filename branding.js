/**
 * How this installation presents itself (Settings > General): the name in the header, on the
 * sign-in page and in the browser's tab; the line under it (shown when no one site is chosen);
 * and a logo of its own in place of the standard mark.
 *
 * There are two places for a logo: "light", the logo, shown wherever there is no other; and
 * "dark", an optional version for dark pages (a logo drawn in dark ink disappears on one).
 * Like a site's logo, each is a PNG or JPEG kept in the (encrypted) database; the browser
 * turns anything else, SVG included, into PNG before uploading, so the server never serves a
 * file that could carry script. A logo is public, as the name is: the sign-in page shows it.
 */
const { decodeLogo } = require("./sites");

const DEFAULT_APP_NAME = "Identity and Visitor Manager";
const LOGO_SLOTS = ["light", "dark"];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createBranding({ db }) {
  const raw = db.raw;
  const versions = raw.prepare("SELECT slot, updated_at FROM app_logos");

  /** { name, subtitle, showName, logo: { light, dark } }: each logo as when it was last changed, or null for none. */
  function get() {
    const logo = { light: null, dark: null };
    for (const r of versions.all()) if (LOGO_SLOTS.includes(r.slot)) logo[r.slot] = r.updated_at;
    return {
      name: db.getSetting("branding.name") || DEFAULT_APP_NAME,
      subtitle: db.getSetting("branding.subtitle") || "",
      // Whether the header shows the name beside a logo (a logo that spells the name out needs no second copy).
      showName: db.getSetting("branding.hide_name") !== "1",
      logo
    };
  }

  /** Saves what is given of name, subtitle and showName; an empty name goes back to the default. */
  function save(input = {}) {
    const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    if (input.name !== undefined) {
      const name = text(input.name);
      if (name.length > 60) throw fail(400, "Keep the name to 60 characters.");
      db.setSetting("branding.name", name && name !== DEFAULT_APP_NAME ? name : null);
    }
    if (input.subtitle !== undefined) {
      const subtitle = text(input.subtitle);
      if (subtitle.length > 80) throw fail(400, "Keep the line under it to 80 characters.");
      db.setSetting("branding.subtitle", subtitle || null);
    }
    if (input.showName !== undefined) db.setSetting("branding.hide_name", input.showName ? null : "1");
    return get();
  }

  function slotOf(slot) {
    if (!LOGO_SLOTS.includes(slot)) throw fail(404, "No such logo.");
    return slot;
  }

  function setLogo(slot, dataUrl) {
    const place = slotOf(slot);
    const { type, data } = decodeLogo(dataUrl);
    raw.prepare("INSERT INTO app_logos (slot, type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at")
      .run(place, type, data, Date.now());
    return get();
  }

  /** Takes a logo away; false when there was none. */
  function clearLogo(slot) {
    return raw.prepare("DELETE FROM app_logos WHERE slot = ?").run(slotOf(slot)).changes > 0;
  }

  /** { type, data, updatedAt }, or null when there is none. */
  function getLogo(slot) {
    if (!LOGO_SLOTS.includes(slot)) return null;
    const r = raw.prepare("SELECT type, data, updated_at FROM app_logos WHERE slot = ?").get(slot);
    return r ? { type: r.type, data: r.data, updatedAt: r.updated_at } : null;
  }

  return { get, save, setLogo, clearLogo, getLogo };
}

module.exports = { createBranding, DEFAULT_APP_NAME, LOGO_SLOTS };
