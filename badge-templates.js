/**
 * Badge template images: what a badge of each clearance level looks like, so staff who may
 * not see clearance level names (Settings > Roles) can still tell which badge to hand over.
 *
 * Each clearance level has two: one for tenant badges (personnel badges use it too) and one
 * for visitor badges. Uncleared badges have a pair of their own (level 0 here). Images are
 * PNG or JPEG, checked by their first bytes, at most 1 MB. Each has a random `ref` that
 * changes with every upload: it is all a browser is given, so an image's address says
 * nothing about its level, and it can be cached for as long as it lasts.
 */
const crypto = require("crypto");

const KINDS = ["tenant", "visitor"];
const KIND_LABELS = { tenant: "Tenant badge", visitor: "Visitor badge" };
const MAX_IMAGE_BYTES = 1024 * 1024;
const REF_RE = /^[A-Za-z0-9_-]{16}$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** The template kind for a badge type: visitor badges have their own, the rest the tenant one. */
const kindFor = (badgeType) => (badgeType === "visitor" ? "visitor" : "tenant");

/** { type, data } from a data: URL holding a PNG or JPEG; throws for anything else. */
function decodeImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) throw fail(400, "The badge image must be a PNG or JPEG.");
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw fail(400, "The badge image is empty.");
  if (data.length > MAX_IMAGE_BYTES) throw fail(413, "The badge image is larger than 1 MB; use a smaller one.");
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (m[1] === "image/png" ? !png : !jpeg) throw fail(400, "The badge image's contents are not the PNG or JPEG it claims to be.");
  return { type: m[1], data };
}

function createBadgeTemplates({ db, clearance, now = Date.now }) {
  const raw = db.raw;

  function levelKeyOf(levelId) {
    if (levelId === null || levelId === undefined || levelId === "" || Number(levelId) === 0) return 0;
    const level = clearance.level(levelId);
    if (!level) throw fail(404, "No such clearance level.");
    return level.id;
  }

  function checkKind(kind) {
    if (!KINDS.includes(kind)) throw fail(400, `A badge template is for ${KINDS.join(" or ")} badges.`);
    return kind;
  }

  /** Every template, ordered as the levels are (uncleared first): { levelId (0 = uncleared), kind, ref, updatedAt }. */
  function list() {
    return raw.prepare(`SELECT t.level_key, t.kind, t.ref, t.updated_at, coalesce(l.rank, -1) AS rank FROM badge_templates t
      LEFT JOIN clearance_levels l ON l.id = t.level_key ORDER BY rank, t.level_key, t.kind`).all()
      .map((r) => ({ levelId: r.level_key, kind: r.kind, ref: r.ref, updatedAt: r.updated_at }));
  }

  function set(levelId, kind, dataUrl) {
    const key = levelKeyOf(levelId);
    checkKind(kind);
    const image = decodeImage(dataUrl);
    const ref = crypto.randomBytes(12).toString("base64url");
    raw.prepare(`INSERT INTO badge_templates (level_key, kind, ref, image, image_type, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(level_key, kind) DO UPDATE SET ref = excluded.ref, image = excluded.image, image_type = excluded.image_type, updated_at = excluded.updated_at`)
      .run(key, kind, ref, image.data, image.type, now());
    return { levelId: key, kind, ref };
  }

  function remove(levelId, kind) {
    const key = levelKeyOf(levelId);
    checkKind(kind);
    if (!raw.prepare("DELETE FROM badge_templates WHERE level_key = ? AND kind = ?").run(key, kind).changes) throw fail(404, "There is no image there.");
  }

  /** The image behind a ref, or null. */
  function image(ref) {
    if (!REF_RE.test(String(ref || ""))) return null;
    const r = raw.prepare("SELECT image, image_type FROM badge_templates WHERE ref = ?").get(String(ref));
    return r ? { type: r.image_type, data: r.image } : null;
  }

  /** What a ref stands for ({ levelId, kind }), or null. */
  function byRef(ref) {
    if (!REF_RE.test(String(ref || ""))) return null;
    const r = raw.prepare("SELECT level_key, kind FROM badge_templates WHERE ref = ?").get(String(ref));
    return r ? { levelId: r.level_key, kind: r.kind } : null;
  }

  /** The ref of the image for a badge of this type and level (null for uncleared), or null when there is none. */
  function refFor(badgeType, levelId) {
    const r = raw.prepare("SELECT ref FROM badge_templates WHERE level_key = ? AND kind = ?").get(Number(levelId) || 0, kindFor(badgeType));
    return r ? r.ref : null;
  }

  return { list, set, remove, image, byRef, refFor };
}

module.exports = { createBadgeTemplates, decodeImage, kindFor, KINDS, KIND_LABELS, MAX_IMAGE_BYTES };
