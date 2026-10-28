/**
 * Brings Security's mail in from the shared mailbox (alarmreports@, say) through Microsoft
 * Graph, as the app itself: the app registration under Settings > Microsoft Entra ID, with
 * the Mail.Read application permission (admin consent), limited to that one mailbox by an
 * Exchange application access policy. It only reads: nothing in the mailbox is moved, marked
 * or deleted.
 *
 * Every few minutes (Settings > Security mail) it asks for the Inbox's messages received
 * since the last one it saw, oldest first, and hands each to security-reports.js, which keeps
 * the alarm notices and guard reports and passes over the rest. The first time, it looks back
 * `firstDays`. Attachments are fetched only for a message that isn't an alarm notice.
 *
 * Settings and where it got to are the "security-mail" document in the encrypted database.
 * The log of checks says how many came and what was kept, never subjects or senders' words:
 * administrators, who aren't Security, see it.
 */
const DOC = "security-mail";
const MINUTE = 60 * 1000;
const DAY_MS = 24 * MINUTE * 60;
const PAGE = 25;
const MAX_PER_CHECK = 500;
const MAX_ATTACHMENT = 25 * 1024 * 1024;
const LOG_SIZE = 30;
const HTTP_TIMEOUT_MS = 30 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULTS = { enabled: false, mailbox: "", pollMinutes: 5, keepDays: 365, firstDays: 7 };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createSecurityMailbox({ store, reports, token, graphBase, fetchImpl = globalThis.fetch, now = Date.now, log = console }) {
  const read = () => ({ ...DEFAULTS, ...(store.read(DOC, {}) || {}) });
  const write = (patch) => store.write(DOC, { ...read(), ...patch });
  let running = null;

  /** The settings and where the mailbox got to, as Settings shows them. */
  function settings() {
    const s = read();
    return {
      enabled: Boolean(s.enabled),
      mailbox: s.mailbox || "",
      pollMinutes: s.pollMinutes,
      keepDays: s.keepDays,
      firstDays: s.firstDays,
      since: s.since || null,
      lastCheck: s.lastCheck || null,
      lastError: s.lastError || null,
      checking: Boolean(running),
      log: Array.isArray(s.log) ? s.log : []
    };
  }

  const wholeIn = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };

  function save(patch = {}) {
    const next = {};
    if (patch.mailbox !== undefined) {
      const m = String(patch.mailbox || "").trim().toLowerCase();
      if (m && !EMAIL.test(m)) throw fail(400, "The mailbox is an email address, such as alarmreports@example.com.");
      // Another mailbox starts over from its own first look back.
      if (m !== read().mailbox) Object.assign(next, { since: null, lastError: null });
      next.mailbox = m;
    }
    if (patch.pollMinutes !== undefined) next.pollMinutes = wholeIn(patch.pollMinutes, 1, 1440, "How often to check");
    if (patch.keepDays !== undefined) next.keepDays = wholeIn(patch.keepDays, 30, 3650, "How long to keep them");
    if (patch.firstDays !== undefined) next.firstDays = wholeIn(patch.firstDays, 0, 90, "How far back to look the first time");
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if ((next.enabled ?? read().enabled) && !(next.mailbox ?? read().mailbox)) throw fail(400, "Give the mailbox's address to check it.");
    write(next);
    return settings();
  }

  async function graph(url, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}`, prefer: "outlook.body-content-type=\"html\"" }, signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const mailbox = read().mailbox;
        const why = body?.error?.message ? ` (${String(body.error.message).split(/\r?\n/)[0]})` : "";
        if (res.status === 401 || res.status === 403) {
          throw fail(502, `Microsoft wouldn't let the app read ${mailbox}${why}. Give the app registration the Mail.Read application permission with admin consent, and allow it this mailbox in the Exchange application access policy.`);
        }
        if (res.status === 404) throw fail(502, `Microsoft has no mailbox ${mailbox}${why}.`);
        if (res.status === 429) throw fail(502, "Microsoft asked the app to slow down; it tries again at the next check.");
        throw fail(502, `Microsoft Graph answered HTTP ${res.status}${why}.`);
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw fail(502, "Microsoft Graph didn't answer in time.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const attachmentsOf = async (base, id, accessToken) => {
    const out = [];
    const body = await graph(`${base}/${encodeURIComponent(id)}/attachments`, accessToken);
    for (const a of body.value || []) {
      if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || !a.contentBytes || a.size > MAX_ATTACHMENT) continue;
      out.push({ name: a.name || "attachment", type: a.contentType || "", data: Buffer.from(a.contentBytes, "base64") });
    }
    return out;
  };

  /** Checks the mailbox once: { fetched, alarms, reports, duplicates, ignored }. */
  async function checkOnce() {
    const s = read();
    if (!s.mailbox) throw fail(400, "Give the mailbox's address first.");
    const accessToken = await token();
    const base = `${graphBase()}/v1.0/users/${encodeURIComponent(s.mailbox)}/mailFolders/inbox/messages`;
    const since = s.since || new Date(now() - s.firstDays * DAY_MS).toISOString();
    const query = [
      ["$filter", `receivedDateTime ge ${since}`],
      ["$orderby", "receivedDateTime asc"],
      ["$top", String(PAGE)],
      ["$select", "id,internetMessageId,subject,from,receivedDateTime,hasAttachments,body"]
    ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const counts = { fetched: 0, alarms: 0, reports: 0, duplicates: 0, ignored: 0 };
    let url = `${base}?${query}`;
    let latest = s.since || null;
    while (url && counts.fetched < MAX_PER_CHECK) {
      const page = await graph(url, accessToken);
      for (const m of page.value || []) {
        counts.fetched += 1;
        const html = m.body?.contentType === "html" ? m.body.content || "" : "";
        const message = {
          messageId: m.internetMessageId || `graph:${m.id}`,
          subject: m.subject || "",
          from: m.from?.emailAddress?.address || "",
          receivedAt: Date.parse(m.receivedDateTime) || now(),
          html,
          text: html ? "" : m.body?.content || "",
          attachments: []
        };
        let result = reports.ingest(message, { source: "mailbox" });
        // Not an alarm notice: its attachments may hold a guard report.
        if (!result.kind && m.hasAttachments) {
          message.attachments = await attachmentsOf(base, m.id, accessToken);
          result = reports.ingest(message, { source: "mailbox" });
        }
        if (!result.kind) counts.ignored += 1;
        else if (result.duplicate) counts.duplicates += 1;
        else if (result.kind === "alarm") counts.alarms += 1;
        else counts.reports += 1;
        if (m.receivedDateTime && (!latest || m.receivedDateTime > latest)) latest = m.receivedDateTime;
      }
      // Where it got to, page by page, so a failure part-way doesn't start over.
      if (latest) write({ since: latest });
      url = page["@odata.nextLink"] || null;
    }
    return counts;
  }

  /** Checks now (one check at a time; a second caller waits for the one under way). */
  function check({ by = "schedule" } = {}) {
    if (running) return running;
    running = (async () => {
      const at = now();
      try {
        const counts = await checkOnce();
        const swept = reports.sweep(read().keepDays);
        const entry = { at, by, ok: true, ...counts, deleted: swept.alarms + swept.reports };
        write({ lastCheck: at, lastError: null, log: [entry, ...(read().log || [])].slice(0, LOG_SIZE) });
        return entry;
      } catch (error) {
        const entry = { at, by, ok: false, error: error.message };
        write({ lastCheck: at, lastError: error.message, log: [entry, ...(read().log || [])].slice(0, LOG_SIZE) });
        if (by === "schedule") log.warn(`Security mail: ${error.message}`);
        else throw error;
        return entry;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /**
   * Every minute: a check when one is due; and once a day, what is past keeping is deleted
   * (whether it came from the mailbox or a file).
   */
  let lastSweep = 0;
  function start() {
    const timer = setInterval(() => {
      const s = read();
      if (now() - lastSweep > DAY_MS) {
        lastSweep = now();
        try { reports.sweep(s.keepDays); } catch (error) { log.warn(`Security mail: ${error.message}`); }
      }
      if (!s.enabled || !s.mailbox || running) return;
      if (s.lastCheck && now() - s.lastCheck < s.pollMinutes * MINUTE) return;
      check().catch(() => {});
    }, MINUTE);
    timer.unref();
    return timer;
  }

  return { settings, save, check, start };
}

module.exports = { createSecurityMailbox, DEFAULTS };
