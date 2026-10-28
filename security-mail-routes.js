/**
 * Staff routes for Security's mail: the monitoring center's alarm notices and the guard
 * company's daily activity reports (security-reports.js), and the shared mailbox they come
 * from (security-mailbox.js). Mounted after the sign-in check, so req.user and req.ctx are set.
 *
 * Security, and roles given "reads alarms and guard reports" (an alarm responder), read them and
 * mark them read or unread. Only Security drops a file in or asks for the mailbox to be checked
 * now. Administrators set the mailbox up and place alarm accounts
 * and guard sites at the app's sites; they see how each check went, never what came in. Staff
 * limited to some sites see what is placed at theirs. Nothing here is cached by the browser.
 */
const express = require("express");
const { readMailFile, CFB_MAGIC } = require("./mail-files");

const MAX_FILE_BYTES = 30 * 1024 * 1024;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createSecurityMailRoutes({ access, reports, mailbox, admin, auditFrom, appInfo = () => null }) {
  const router = express.Router();
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const reader = (req, res, next) => (access.canReadAlarms(req.ctx) ? next() : res.status(403).json({ error: "This account doesn't read alarms and guard reports." }));
  const security = (req, res, next) => (access.isSecurity(req.ctx) ? next() : res.status(403).json({ error: "Only Security adds alarms and guard reports." }));
  const noStore = (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };
  const positiveInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const KIND = { alarms: "alarm", "guard-reports": "guard" };

  router.use("/api/security", noStore);
  router.use("/api/settings/security-mail", noStore);

  // --- alarms and guard reports (Security and alarm responders) ---------------------------------

  router.get("/api/security/mail/unread", reader, (req, res) => {
    res.json(reports.unread({ sites: req.ctx.sites }));
  });

  for (const [list, kind] of Object.entries(KIND)) {
    router.get(`/api/security/${list}`, reader, (req, res) => {
      const found = reports.list(kind, {
        q: String(req.query.q || "").slice(0, 200),
        unread: req.query.unread === "1" || req.query.unread === "true",
        siteId: positiveInt(req.query.site),
        sites: req.ctx.sites,
        limit: positiveInt(req.query.limit) || 50,
        offset: Math.max(0, Number(req.query.offset) || 0)
      });
      res.json({ [kind === "alarm" ? "alarms" : "reports"]: found.items, total: found.total, unread: reports.unread({ sites: req.ctx.sites }) });
    });

    router.get(`/api/security/${list}/:id`, reader, (req, res) => {
      const item = reports.get(kind, positiveInt(req.params.id), { sites: req.ctx.sites });
      if (!item) throw fail(404, kind === "alarm" ? "No such alarm." : "No such report.");
      res.json({ [kind === "alarm" ? "alarm" : "report"]: item });
    });

    /** { read: true } when someone opens it (who first read it is kept), false to make it unread again. */
    router.post(`/api/security/${list}/:id/read`, reader, (req, res) => {
      const read = req.body?.read !== false;
      const item = reports.setRead(kind, positiveInt(req.params.id), read, { by: staffName(req), sites: req.ctx.sites });
      if (!read) auditFrom(req, kind === "alarm" ? "security.alarm_unread" : "security.report_unread", String(item.id));
      res.json({ ok: true, read: item.read, readAt: item.readAt, readBy: item.readBy });
    });
  }

  /** The guard report's original PDF, to open beside the readable version. */
  router.get("/api/security/guard-reports/:id/pdf", reader, (req, res) => {
    const file = reports.pdf(positiveInt(req.params.id), { sites: req.ctx.sites });
    if (!file) throw fail(404, "That report has no PDF.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(file.name).replace(/[^\w.\- ]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(file.data);
  });

  /**
   * An email dropped in by hand: an Outlook .msg, an .eml, or the guard report's PDF on its
   * own. Kept if it is an alarm notice or a daily activity report.
   */
  router.post("/api/security/mail/upload", security, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw fail(400, "Choose a file: an email (.msg or .eml) or a guard report PDF.");
    const name = String(req.query.name || "file").slice(0, 200);
    const isPdf = buf.toString("latin1", 0, 1024).includes("%PDF-") && !buf.subarray(0, 8).equals(CFB_MAGIC);
    const message = isPdf
      ? { messageId: null, subject: name, from: "", receivedAt: null, html: "", text: "", attachments: [{ name, type: "application/pdf", data: buf }] }
      : readMailFile(buf);
    const result = reports.ingest(message, { source: "upload" });
    if (!result.kind) throw fail(400, `${result.reason} Nothing was added.`);
    if (!result.duplicate) auditFrom(req, result.kind === "alarm" ? "security.alarm_add" : "security.report_add", String(result.id), `from a file (${name})`);
    res.json({ ok: true, ...result });
  });

  /** Checks the mailbox now (Security, from the alarms page; administrators, from Settings). */
  router.post("/api/security/mail/check", (req, res, next) => (access.isSecurity(req.ctx) || req.ctx.isAdmin ? next() : res.status(403).json({ error: "This account can't check Security's mailbox." })), async (req, res) => {
    if (!mailbox.settings().mailbox) throw fail(409, "No mailbox is set up: an administrator sets it under Settings > Security mail.");
    const entry = await mailbox.check({ by: staffName(req) || "staff" });
    auditFrom(req, "security.mail_check", mailbox.settings().mailbox, `${entry.fetched} fetched: ${entry.alarms} alarms, ${entry.reports} reports, ${entry.duplicates} already here, ${entry.ignored} passed over`);
    res.json({ ok: true, ...entry, unread: access.isSecurity(req.ctx) ? reports.unread({ sites: req.ctx.sites }) : undefined });
  });

  // --- setting it up (administrators) ------------------------------------------------------------

  router.get("/api/settings/security-mail", admin, (req, res) => {
    res.json({ settings: mailbox.settings(), sources: reports.sources(), app: appInfo() });
  });

  router.put("/api/settings/security-mail", admin, (req, res) => {
    const saved = mailbox.save(req.body || {});
    auditFrom(req, "security.mail_settings", saved.mailbox || "(none)", `${saved.enabled ? "on" : "off"}; every ${saved.pollMinutes} min; kept ${saved.keepDays} days`);
    res.json({ ok: true, settings: saved });
  });

  const sourceName = (s) => `${s.kind === "alarm" ? "Alarm account" : "Guard site"} ${s.key}`;

  /** An alarm account (or guard site) added ahead of its first alarm: { kind, key, label, siteId }. */
  router.post("/api/settings/security-mail/sources", admin, (req, res) => {
    const body = req.body || {};
    const added = reports.addSource({ kind: String(body.kind || "alarm"), key: body.key, label: body.label, siteId: body.siteId ?? null });
    auditFrom(req, "security.source_add", sourceName(added), [added.label, added.siteName || "no site"].filter(Boolean).join("; "));
    res.json({ ok: true, source: added });
  });

  /** Its name or site: { kind, key, label?, siteId? }. */
  router.put("/api/settings/security-mail/sources", admin, (req, res) => {
    const body = req.body || {};
    const changed = reports.updateSource(String(body.kind || ""), String(body.key || ""), { label: body.label, siteId: body.siteId });
    auditFrom(req, "security.source_site", sourceName(changed), [body.label !== undefined ? `named ${changed.label || "(none)"}` : null, body.siteId !== undefined ? changed.siteName || "no site" : null].filter(Boolean).join("; "));
    res.json({ ok: true, source: changed });
  });

  router.delete("/api/settings/security-mail/sources/:kind/:key", admin, (req, res) => {
    const removed = reports.removeSource(req.params.kind, req.params.key);
    auditFrom(req, "security.source_remove", sourceName(removed), removed.siteName || null);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createSecurityMailRoutes };
