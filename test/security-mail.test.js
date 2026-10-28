/**
 * Security's mail: reading the monitoring center's alarm notices and the guard company's
 * daily activity report PDFs (made-up ones in the real shapes: test/helpers/mail-fixtures.js),
 * the .msg and .eml files they may be dropped in as, keeping each once, unread until opened,
 * by site; the mailbox check through Microsoft Graph (against a stand-in); and over HTTP, that
 * only Security reads them and administrators only set the mailbox up.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { openDatabase } = require("../db");
const { generateKey } = require("../db-key");
const { createSites } = require("../sites");
const { pdfText, pdfLines, parseCMap } = require("../pdf-text");
const { readMailFile } = require("../mail-files");
const { classify, parseAlarm, parseGuardReport } = require("../security-mail");
const { createSecurityReports } = require("../security-reports");
const { createSecurityMailbox } = require("../security-mailbox");
const fx = require("./helpers/mail-fixtures");

const { check, report } = createChecker("Security mail: alarms and guard reports");
const throwsStatus = (fn, status) => {
  try { fn(); return false; } catch (error) { return error.status === status; }
};

const ALARM_SUBJECT = "Account Z9990001 Example Co - Wing A - event #77 BURGLARY ALARM";
const alarmHtml = fx.alarmHtml({ log: fx.SAMPLE_LOG });
// Enough checkpoints that the report runs over pages, an entry's officer falling on the next.
const longDays = [{ ...fx.SAMPLE_DAYS[0], entries: [
  ...fx.SAMPLE_DAYS[0].entries.slice(0, 3),
  ...Array.from({ length: 30 }, (_, i) => ({ time: "5:12 PM EST", type: "Checkpoint", status: "Scanned", checkpoint: `Door ${i + 1}`, answers: i % 3 ? [] : ["Is this SCIF Armed? Yes/No: Y"], officer: "Jo Guard" })),
  ...fx.SAMPLE_DAYS[0].entries.slice(6)
] }, { date: "Jan 5th, 2027", entries: [
  { time: "12:00 AM EST", type: "Clock-in", title: "Max Watch clocked in at the Example Site - Night post", officer: "Max Watch" },
  { time: "6:59 AM EST", type: "Clock-out", officer: "Max Watch" }
] }];
const guardPdf = fx.guardPdf({ days: fx.SAMPLE_DAYS });
const longPdf = fx.guardPdf({ days: longDays });

// --- reading PDFs ----------------------------------------------------------------------------------

const pages = pdfText(guardPdf);
const lines = pdfLines(pages);
check("pdf: its text, through the font's ToUnicode map", pages.length === 1 && pages[0].items.some((i) => i.text === "Example Guard Co"));
check("pdf: where it sits, the page flipped as Chrome draws it", Math.round(pages[0].items.find((i) => i.text === "Example Guard Co").y) === 792 - 90);
check("pdf: a heading set one letter at a time reads as words", lines[0][0].items[0].text === "Daily Activity Report" && lines[0].some((l) => l.items[0].text === "Jan 4th, 2027"));
check("pdf: columns stay apart", lines[0].find((l) => l.items.some((i) => i.text === "Site name:")).items.map((i) => i.text).join("|") === "Site name:|Example Site");
check("pdf: and runs either side of a column edge aren't joined, however close", pdfLines(pages)[0].some((l) => /PM EST Clock-in/.test(l.items[0]?.text))
  && !pdfLines(pages, { columns: [110] })[0].some((l) => /PM EST Clock-in/.test(l.items[0]?.text)));
check("pdf: a ToUnicode range counts up", parseCMap(Buffer.from("1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <43> <0061> endbfrange")).map.get(0x43) === "c");
check("pdf: not a PDF is refused", throwsStatus(() => pdfText(Buffer.from("hello")), 400));
check("pdf: an encrypted one says so", throwsStatus(() => pdfText(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n")), 400));
check("pdf: several pages, in order", pdfText(longPdf).length >= 2);

// --- alarm notices -----------------------------------------------------------------------------------

const alarm = parseAlarm({ subject: ALARM_SUBJECT, html: alarmHtml });
check("alarm: the account, its name and address", alarm.account === "Z9990001" && alarm.accountName === "Example Co - Wing A" && alarm.address.join(" / ") === "1 Example Way / Springfield, ST 00000");
check("alarm: what, where and when", alarm.event === "BURGLARY ALARM" && alarm.zone === "120" && alarm.zoneName === "Lobby Door" && alarm.area === "1" && alarm.when === "Jan 3, 2027 09:15" && alarm.reference === "1000001" && alarm.eventNumber === "77");
check("alarm: the monitoring center and its link", alarm.center === "Example Monitoring" && alarm.centerPhone === "800-555-0100" && alarm.link === "https://monitoring.example/");
check("alarm: the log, oldest first, in its columns", alarm.log.length === 12 && alarm.log[0].action === "DMPBA - BURGLARY ALARM" && alarm.log[0].who === "120 Lobby Door"
  && alarm.log[alarm.log.length - 1].action === "EmailSent - Email Sent" && alarm.log.find((e) => e.action === "Call" && e.phone === "5550000002").disposition === "Answering Machine/Voicemail - Message Left");
check("alarm: dates with the year", alarm.log[0].date === "2027-01-03" && alarm.log[0].time === "09:12:10");
const s = alarm.summary;
check("alarm: when the panel signaled, and who disarmed it (their user number too)", s.signalAt === "09:12:10" && s.signal === "BURGLARY ALARM" && s.disarmedBy === "LEE EXAMPLE" && s.disarmUser === "42");
check("alarm: each call, with how its passcode check went", s.calls.length === 3 && s.calls[0].verified === false && s.calls[0].note === "SPOKE TO ALEX, UNSURE"
  && s.calls[1].verified === null && s.calls[2].verified === true && s.calls[2].who === "Pat Example");
check("alarm: the dispatch decision, and when it was cleared", s.dispatch === "No dispatch requested" && s.clearedAt === "09:15:40");
const newYear = parseAlarm({ html: fx.alarmHtml({ when: "Jan 1, 2027 00:02", log: [["01/01 00:02:00", "DMPBA - BURGLARY ALARM"], ["12/31 23:59:00", "DMPCL - CLOSING", "", "LEE"]] }) });
check("alarm: a log reaching back over the new year", newYear.log[0].date === "2026-12-31" && newYear.log[1].date === "2027-01-01");
check("alarm: other mail isn't one", parseAlarm({ html: "<p>Hello</p>" }) === null);

// --- guard reports -----------------------------------------------------------------------------------

const g = parseGuardReport(guardPdf);
check("guard: the summary at the top", g.company === "Example Guard Co" && g.site === "Example Site" && g.range === "Mon Jan 4 7:00 AM - Tue Jan 5 6:59 AM EST" && g.date === "2027-01-04"
  && g.counts["Activity Reports"] === 3 && g.counts["High Severity Incidents"] === 1, JSON.stringify(g.counts));
check("guard: every entry, with its time", g.entries.length === 9 && g.entries[0].time === "5:00 PM EST" && g.entries[0].at === Date.UTC(2027, 0, 4, 22, 0));
const duty = g.entries.find((e) => e.headline === "Report for Duty");
check("guard: a written report: title, text over several lines, location, status, officer", duty.type === "Activity Report" && duty.status === "Filed" && duty.officer === "Jo Guard"
  && duty.body === "On duty as patrol officer from 1700hrs to midnight. Spoke with the building manager about the loading dock." && duty.fields.Location === "Suite 100");
check("guard: a sentence wrapped over lines is one", g.entries[0].headline === "Jo Guard clocked in at the Example Site - Evening post");
const lab = g.entries.find((e) => e.checkpoint?.name === "Lab - Entrance");
check("guard: a checkpoint, scanned, with its question and answer", lab.checkpoint.completed && lab.status === "Scanned" && lab.answers[0].question === "Is this SCIF Armed? Yes/No" && lab.answers[0].answer === "N");
check("guard: a tour's summary over two lines", g.entries.find((e) => e.type === "Tour Ended").fields.Summary === "All secure, lab left open by a late worker.");
check("guard: an incident is flagged", g.entries.find((e) => e.type === "Incident Report").flagged === true);
check("guard: what it comes to", g.summary.shifts[0].officer === "Jo Guard" && g.summary.shifts[0].in === "5:00 PM EST" && g.summary.shifts[0].out === "11:58 PM EST"
  && g.summary.tours.length === 1 && g.summary.tours[0].scanned === 3 && g.summary.reports.length === 1 && g.summary.incidents.length === 1 && g.summary.answeredNo.length === 1);
const long = parseGuardReport(longPdf);
check("guard: over pages, an entry's officer on the next page stays with it", long.entries.filter((e) => e.type === "Checkpoint").length === 30 && long.entries.every((e) => e.officer)
  && long.summary.tours[0].scanned === 30, JSON.stringify(long.entries.filter((e) => !e.officer)));
check("guard: the next day's heading moves the date on", long.entries.find((e) => e.officer === "Max Watch").date === "2027-01-05" && long.summary.shifts.length === 2);
check("guard: another PDF isn't one", parseGuardReport(fx.makePdf([[{ x: 50, y: 50, text: "An invoice" }]])) === null);

// --- telling them apart, and files ----------------------------------------------------------------------

check("classify: an alarm notice", classify({ subject: ALARM_SUBJECT, html: alarmHtml }).kind === "alarm");
check("classify: a report by its PDF, whatever the PDF is called", classify({ html: "<p>Activity Report provided by Example</p>", attachments: [{ name: "x.bin", type: "", data: guardPdf }] }).kind === "guard");
check("classify: other mail, with why", classify({ html: "<p>Lunch?</p>", attachments: [{ name: "menu.pdf", type: "application/pdf", data: fx.makePdf([[{ x: 50, y: 50, text: "Menu" }]]) }] }).reason === "Its PDF isn't a daily activity report.");

const when = Date.UTC(2027, 0, 4, 12, 30);
const msg = readMailFile(fx.msgFile({ subject: "Activity Report for Example Site", html: "<p>Attached</p>", from: "reports@guards.example", messageId: "<r1@guards.example>", receivedAt: when, attachments: [{ name: "daily_activity_report.pdf", type: "application/pdf", data: guardPdf }] }));
check(".msg: subject, sender, Message-ID and when it came", msg.subject === "Activity Report for Example Site" && msg.from === "reports@guards.example" && msg.messageId === "<r1@guards.example>" && msg.receivedAt === when);
check(".msg: the attachment whole (a large stream in sectors of its own)", msg.attachments.length === 1 && msg.attachments[0].name === "daily_activity_report.pdf" && msg.attachments[0].data.equals(guardPdf));
check(".msg: the HTML body (a small stream in the mini stream)", msg.html === "<p>Attached</p>");
const eml = readMailFile(fx.emlFile({ subject: "Alarm – Wing A", html: alarmHtml, from: "notify@monitoring.example", messageId: "<a1@monitoring.example>" }));
check(".eml: the encoded subject, the quoted-printable HTML", eml.subject === "Alarm – Wing A" && eml.html === alarmHtml && eml.receivedAt === Date.UTC(2027, 0, 4, 12));
check(".eml: an attachment in base64", readMailFile(fx.emlFile({ subject: "r", html: "<p>r</p>", attachments: [{ name: "r.pdf", type: "application/pdf", data: guardPdf }] })).attachments[0].data.equals(guardPdf));
check("files: anything else is refused", throwsStatus(() => readMailFile(Buffer.from("just some text")), 400) && throwsStatus(() => readMailFile(Buffer.alloc(0)), 400));

// --- keeping them ----------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-secmail-"));
const db = openDatabase({ dataDir: tmp, key: generateKey() });
const sites = createSites({ db });
let clockNow = Date.UTC(2027, 0, 4, 13);
const reports = createSecurityReports({ db, now: () => clockNow });
const site1 = sites.list()[0] || sites.create({ name: "Main", timeZone: "UTC" });
const one = reports.ingest({ subject: ALARM_SUBJECT, html: alarmHtml, messageId: "<a1@x>", receivedAt: Date.UTC(2027, 0, 3, 14, 16) });
check("keep: an alarm", one.kind === "alarm" && !one.duplicate);
check("keep: the same email again is the same alarm", reports.ingest({ subject: ALARM_SUBJECT, html: alarmHtml, messageId: "<a1@x>" }).duplicate === true && reports.list("alarm").total === 1);
check("keep: without a Message-ID, by what it holds", reports.ingest({ subject: "x", html: alarmHtml }).duplicate === false && reports.ingest({ subject: "x", html: alarmHtml }).duplicate === true);
const rep = reports.ingest({ subject: "Report", messageId: "<g1@x>", attachments: [{ name: "r.pdf", type: "application/pdf", data: guardPdf }] });
check("keep: a guard report, with its PDF", rep.kind === "guard" && reports.pdf(rep.id).data.equals(guardPdf));
check("keep: other mail isn't", reports.ingest({ subject: "Lunch", html: "<p>Lunch?</p>" }).kind === null);
check("keep: with one site, what comes in is at it", reports.sources().every((x) => x.siteId === site1.id) && reports.sources().length === 2);

const listed = reports.list("alarm").items[0];
check("list: unread, newest first, what it came to", listed.read === false && listed.event === "BURGLARY ALARM" && listed.outcome.disarmedBy === "LEE EXAMPLE" && listed.outcome.dispatch === "No dispatch requested");
check("list: found by a word in it", reports.list("alarm", { q: "lobby" }).total === 2 && reports.list("alarm", { q: "nowhere" }).total === 0);
check("unread: counted", reports.unread().alarms === 2 && reports.unread().reports === 1);
clockNow += 1000;
reports.setRead("alarm", one.id, true, { by: "Sam" });
clockNow += 1000;
reports.setRead("alarm", one.id, true, { by: "Kim" });
const opened = reports.get("alarm", one.id);
check("read: who first opened it is kept", opened.read && opened.readBy === "Sam" && reports.unread().alarms === 1);
check("read: and it can be made unread again", reports.setRead("alarm", one.id, false).read === false && reports.unread().alarms === 2);
check("read: the whole alarm and report", opened.alarm.log.length === 12 && reports.get("guard", rep.id).report.entries.length === 9 && reports.get("guard", rep.id).hasPdf);

// Sites: a second site, and an account seen after it, not placed until Settings says.
const site2 = sites.create({ name: "Annex", timeZone: "UTC" });
const other = reports.ingest({ subject: "x", html: fx.alarmHtml({ account: "Z9990002", name: "Annex - Door", log: fx.SAMPLE_LOG }), messageId: "<a3@x>" });
const limited = new Set([site1.id]);
check("sites: limited staff see what is at their sites", reports.list("alarm", { sites: limited }).total === 2 && !reports.get("alarm", other.id, { sites: limited }));
check("sites: what isn't placed only staff who see every site", reports.list("alarm").total === 3 && reports.unread({ sites: new Set([site2.id]) }).alarms === 0);
reports.placeSource("alarm", "Z9990002", site2.id);
check("sites: placed, staff of that site see it", reports.get("alarm", other.id, { sites: new Set([site2.id]) })?.siteName === "Annex" && reports.list("alarm", { siteId: site2.id }).total === 1);
check("sites: an unknown account or site is refused", throwsStatus(() => reports.placeSource("alarm", "nope", null), 404) && throwsStatus(() => reports.placeSource("alarm", "Z9990002", 999), 400));

// Accounts added ahead of their first alarm; a site with several.
check("accounts: a number as the monitoring center writes it", throwsStatus(() => reports.addSource({ key: "K 12" }), 400) && throwsStatus(() => reports.addSource({ key: "" }), 400)
  && throwsStatus(() => reports.addSource({ key: "Z9990003", siteId: 999 }), 400));
const wingB = reports.addSource({ key: "Z9990003", label: "Annex - Wing B", siteId: site2.id });
reports.addSource({ key: "Z9990004", label: "Annex - Garage", siteId: site2.id });
check("accounts: added ahead, at their site", wingB.siteName === "Annex" && wingB.count === 0 && reports.sources().filter((x) => x.kind === "alarm" && x.siteId === site2.id).length === 3);
check("accounts: once only (whatever the case)", throwsStatus(() => reports.addSource({ key: "z9990003" }), 409));
const wingAlarm = reports.ingest({ subject: "x", html: fx.alarmHtml({ account: "Z9990003", name: "Wing B per the monitoring center", log: fx.SAMPLE_LOG }), messageId: "<a4@x>" });
const garageAlarm = reports.ingest({ subject: "x", html: fx.alarmHtml({ account: "z9990004", name: "Garage", log: fx.SAMPLE_LOG }), messageId: "<a5@x>" });
check("accounts: their first alarm is at the site already, from either account", reports.get("alarm", wingAlarm.id, { sites: new Set([site2.id]) })?.siteName === "Annex"
  && reports.get("alarm", garageAlarm.id, { sites: new Set([site2.id]) })?.siteName === "Annex" && reports.list("alarm", { siteId: site2.id }).total === 3);
check("accounts: the name given stays when alarms come in", reports.sources().find((x) => x.key === "Z9990003").label === "Annex - Wing B");
check("accounts: renamed", reports.updateSource("alarm", "Z9990003", { label: "  Wing   B " }).label === "Wing B" && reports.updateSource("alarm", "Z9990003", { label: "" }).label === null);
reports.removeSource("alarm", "z9990004");
check("accounts: taken off the list, its alarms stay but aren't at the site", reports.get("alarm", garageAlarm.id)?.siteName === null && !reports.get("alarm", garageAlarm.id, { sites: new Set([site2.id]) })
  && throwsStatus(() => reports.removeSource("alarm", "Z9990004"), 404));
reports.ingest({ subject: "x", html: fx.alarmHtml({ account: "Z9990004", name: "Garage", log: fx.SAMPLE_LOG }), messageId: "<a6@x>" });
check("accounts: listed again, not placed, when another alarm comes", reports.sources().find((x) => x.key === "Z9990004").siteId === null);
clockNow += 400 * 86400000;
const swept = reports.sweep(365);
check("sweep: deleted after the days they are kept", swept.alarms === 6 && swept.reports === 1 && reports.list("alarm").total === 0);

// --- the mailbox, against a stand-in for Microsoft Graph ------------------------------------------------

async function mailboxTests() {
  const docs = new Map();
  const store = { read: (k, d) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : d), write: (k, v) => docs.set(k, v) };
  const db2 = openDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ivm-secmail2-")), key: generateKey() });
  createSites({ db: db2 });
  const reports2 = createSecurityReports({ db: db2 });
  const calls = [];
  let refuse = 0;
  const messages = [
    { id: "m1", internetMessageId: "<a1@x>", subject: ALARM_SUBJECT, from: { emailAddress: { address: "notify@monitoring.example" } }, receivedDateTime: "2027-01-03T14:16:00Z", hasAttachments: false, body: { contentType: "html", content: alarmHtml } },
    { id: "m2", internetMessageId: "<l1@x>", subject: "Lunch", receivedDateTime: "2027-01-03T15:00:00Z", hasAttachments: false, body: { contentType: "html", content: "<p>Lunch?</p>" } },
    { id: "m3", internetMessageId: "<g1@x>", subject: "Activity Report", receivedDateTime: "2027-01-04T12:30:00Z", hasAttachments: true, body: { contentType: "html", content: "<p>Activity Report provided by Example</p>" } }
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (refuse) return { ok: false, status: refuse, json: async () => ({ error: { message: "Access is denied." } }) };
    const u = new URL(url);
    if (u.pathname.endsWith("/attachments")) {
      return { ok: true, status: 200, json: async () => ({ value: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "daily_activity_report.pdf", contentType: "application/pdf", size: guardPdf.length, contentBytes: guardPdf.toString("base64") }] }) };
    }
    const since = /receivedDateTime ge (\S+)/.exec(u.searchParams.get("$filter"))[1];
    const all = messages.filter((m) => m.receivedDateTime >= since);
    const skip = Number(u.searchParams.get("$skip") || 0);
    const page = all.slice(skip, skip + 2);
    return { ok: true, status: 200, json: async () => ({ value: page, ...(skip + 2 < all.length ? { "@odata.nextLink": `${u.origin}${u.pathname}?${u.searchParams}&$skip=${skip + 2}` } : {}) }) };
  };
  const mailbox = createSecurityMailbox({ store, reports: reports2, token: async () => "TOKEN", graphBase: () => "https://graph.example", fetchImpl, now: () => Date.UTC(2027, 0, 5), log: { warn: () => {} } });
  check("mailbox: an address to check is needed", throwsStatus(() => mailbox.save({ enabled: true }), 400) && throwsStatus(() => mailbox.save({ mailbox: "not an address" }), 400));
  check("mailbox: how often and how long, within reason", throwsStatus(() => mailbox.save({ pollMinutes: 0 }), 400) && throwsStatus(() => mailbox.save({ keepDays: 5 }), 400));
  mailbox.save({ enabled: true, mailbox: "Security@Example.com", pollMinutes: 5, firstDays: 7 });
  const first = await mailbox.check({ by: "Sam" });
  check("mailbox: checked, oldest first over pages, as the app (its token)", first.ok && first.fetched === 3 && first.alarms === 1 && first.reports === 1 && first.ignored === 1 && calls.every((c) => c.auth === "Bearer TOKEN"), JSON.stringify(first));
  check("mailbox: the first time, looking back the days set", decodeURIComponent(calls[0].url).includes("receivedDateTime ge 2026-12-29T00:00:00.000Z") && calls[0].url.includes("/users/security%40example.com/mailFolders/inbox/messages"));
  check("mailbox: attachments fetched only for mail that isn't an alarm", calls.filter((c) => c.url.includes("/attachments")).map((c) => /messages\/(\w+)\/attachments/.exec(c.url)[1]).join() === "m3");
  check("mailbox: where it got to is kept", mailbox.settings().since === "2027-01-04T12:30:00Z" && mailbox.settings().log[0].by === "Sam");
  calls.length = 0;
  const again = await mailbox.check();
  check("mailbox: next time from there, what it had already is skipped", again.fetched === 1 && again.duplicates === 1 && decodeURIComponent(calls[0].url).includes("ge 2027-01-04T12:30:00Z"));
  refuse = 403;
  let err = null;
  try { await mailbox.check({ by: "Sam" }); } catch (error) { err = error; }
  check("mailbox: refused by Microsoft, it says what to set up", /Mail\.Read application permission/.test(err?.message || "") && mailbox.settings().lastError === err.message && mailbox.settings().log[0].ok === false);
  const scheduled = await mailbox.check();
  check("mailbox: on schedule, a refusal is noted, not thrown", scheduled.ok === false && /Mail\.Read/.test(scheduled.error));
  refuse = 0;
  const [x, y] = await Promise.all([mailbox.check(), mailbox.check()]);
  check("mailbox: one check at a time", x === y);
  check("mailbox: another mailbox starts over", mailbox.save({ mailbox: "other@example.com" }).since === null);
  check("mailbox: its log never holds what came in", !JSON.stringify(mailbox.settings()).includes("BURGLARY") && !JSON.stringify(mailbox.settings()).includes("Lunch"));
}

// --- over HTTP ----------------------------------------------------------------------------------------

const PORT = Number(process.env.TEST_SECMAIL_PORT) || 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const password = () => crypto.randomBytes(12).toString("base64url");

function client() {
  const jar = {};
  let csrf = null;
  async function call(method, url, body, { raw = false } = {}) {
    const h = {};
    if (body !== undefined) h["content-type"] = raw ? "application/octet-stream" : "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const type = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    const data = type.includes("json") ? JSON.parse(buf.toString("utf8") || "{}") : {};
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, buf, headers: res.headers };
  }
  return {
    get: (u) => call("GET", u),
    post: (u, b = {}) => call("POST", u, b),
    put: (u, b = {}) => call("PUT", u, b),
    del: (u) => call("DELETE", u),
    upload: (u, buf) => call("POST", u, buf, { raw: true })
  };
}

async function waitFor(fn) {
  for (let i = 0; i < 80; i += 1) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let server;
async function httpTests() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivm-secmail-http-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), KIOSK_PORT: "", DATA_DIR: dataDir, DB_KEY: crypto.randomBytes(32).toString("hex"), DB_KEY_FILE: "", LOGIN_RATE_LIMIT: "0", ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  if (!(await waitFor(async () => (await fetch(`${BASE}/api/auth/me`)).ok))) {
    console.error(log);
    throw new Error("server did not start");
  }
  const admin = client();
  await admin.post("/api/auth/setup", { username: "admin", password: password(), siteName: "Main" });
  const annex = (await admin.post("/api/sites", { name: "Annex", timeZone: "UTC" })).data.site;
  const pw = { sec: password(), annexsec: password(), manny: password(), resp: password(), deskresp: password() };
  await admin.post("/api/users", { username: "sec", password: pw.sec, role: "security" });
  await admin.post("/api/users", { username: "annexsec", password: pw.annexsec, role: "security", sites: [annex.id] });
  await admin.post("/api/users", { username: "manny", password: pw.manny, role: "manager" });
  await admin.post("/api/users", { username: "resp", password: pw.resp, role: "responder" });
  await admin.post("/api/users", { username: "deskresp", password: pw.deskresp, roles: ["frontdesk", "responder"] });
  const as = async (u) => { const c = client(); await c.post("/api/auth/login", { username: u, password: pw[u] }); return c; };
  const security = await as("sec");
  const annexSecurity = await as("annexsec");
  const manager = await as("manny");
  const responder = await as("resp");
  const deskResponder = await as("deskresp");

  const alarmMsg = fx.msgFile({ subject: ALARM_SUBJECT, html: alarmHtml, from: "notify@monitoring.example", messageId: "<a1@monitoring.example>", receivedAt: Date.UTC(2027, 0, 3, 14, 16) });
  let r = await manager.upload("/api/security/mail/upload?name=alarm.msg", alarmMsg);
  check("http: only Security adds them", r.status === 403);
  r = await security.upload("/api/security/mail/upload?name=alarm.msg", alarmMsg);
  check("http: Security drops in an alarm's .msg", r.status === 200 && r.data.kind === "alarm" && !r.data.duplicate, JSON.stringify(r.data));
  const alarmId = r.data.id;
  check("http: the same again is the same alarm", (await security.upload("/api/security/mail/upload?name=alarm.msg", alarmMsg)).data.duplicate === true);
  r = await security.upload("/api/security/mail/upload?name=daily_activity_report.pdf", guardPdf);
  check("http: or a guard report's PDF on its own", r.status === 200 && r.data.kind === "guard");
  const reportId = r.data.id;
  r = await security.upload("/api/security/mail/upload?name=lunch.eml", fx.emlFile({ subject: "Lunch", html: "<p>Lunch?</p>" }));
  check("http: other mail is refused, saying why", r.status === 400 && /isn't an alarm notice or a daily activity report/.test(r.data.error));

  r = await security.get("/api/config");
  check("http: Security's config counts what is unread", r.data.securityMail?.alarms === 1 && r.data.securityMail.reports === 1 && r.data.securityMail.mailbox === false);
  check("http: no one else's does", (await manager.get("/api/config")).data.securityMail === null && (await admin.get("/api/config")).data.securityMail === null);
  r = await security.get("/api/security/alarms");
  check("http: the list, never cached", r.status === 200 && r.data.alarms[0].id === alarmId && r.data.alarms[0].read === false && r.headers.get("cache-control") === "no-store");
  check("http: managers and administrators don't read them", (await manager.get("/api/security/alarms")).status === 403 && (await admin.get("/api/security/alarms")).status === 403
    && (await admin.get(`/api/security/guard-reports/${reportId}/pdf`)).status === 403);
  r = await security.get(`/api/security/alarms/${alarmId}`);
  check("http: the whole alarm", r.data.alarm.alarm.summary.disarmedBy === "LEE EXAMPLE");
  r = await security.post(`/api/security/alarms/${alarmId}/read`, { read: true });
  check("http: opened, it is read, by whom", r.data.read && r.data.readBy === "sec" && (await security.get("/api/security/mail/unread")).data.alarms === 0);
  await security.post(`/api/security/alarms/${alarmId}/read`, { read: false });
  check("http: made unread again, in the audit log", (await security.get("/api/security/alarms?unread=1")).data.total === 1
    && (await admin.get("/api/audit?action=security.alarm_unread")).data.entries.length === 1);
  r = await security.get(`/api/security/guard-reports/${reportId}`);
  check("http: the guard report, read", r.data.report.report.summary.shifts[0].officer === "Jo Guard" && r.data.report.hasPdf);
  r = await security.get(`/api/security/guard-reports/${reportId}/pdf`);
  check("http: and its PDF", r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.buf.equals(guardPdf));

  // An alarm responder reads them, and nothing else.
  r = await responder.get("/api/config");
  check("http: a responder's config: alarms, and no other area", r.data.access.alarms === true && r.data.securityMail?.alarms === 1
    && r.data.access.directory === "none" && r.data.access.visitors === "none" && r.data.access.badges === "none" && r.data.access.clearances === false && r.data.clearance.security === false && r.data.visits === null);
  check("http: a responder reads the alarms, the guard reports and the PDF", (await responder.get("/api/security/alarms")).data.total === 1
    && (await responder.get(`/api/security/alarms/${alarmId}`)).data.alarm.id === alarmId
    && (await responder.get(`/api/security/guard-reports/${reportId}`)).status === 200
    && (await responder.get(`/api/security/guard-reports/${reportId}/pdf`)).status === 200);
  check("http: a responder doesn't add them or check the mailbox", (await responder.upload("/api/security/mail/upload?name=alarm.msg", alarmMsg)).status === 403
    && (await responder.post("/api/security/mail/check")).status === 403 && (await responder.get("/api/settings/security-mail")).status === 403);
  check("http: nor reach the directory, visitors, badges or clearances", (await responder.get("/api/people")).status === 403 && (await responder.get("/api/visits")).status === 403
    && (await responder.get("/api/badges")).status === 403 && (await responder.get("/api/clearance/requests")).status === 403);
  r = await responder.get("/api/me/prefs");
  check("http: a responder's Home starts with what's unread", r.data.dashboard.join() === "alarms,guardReports" && !r.data.available.includes("here"));
  check("http: Security's Home gains the alarms; a manager's doesn't", (await security.get("/api/me/prefs")).data.dashboard.includes("alarms") && !(await manager.get("/api/me/prefs")).data.available.includes("alarms"));
  r = await deskResponder.get("/api/config");
  check("http: front desk and responder together: both", r.data.access.alarms === true && r.data.access.visitors === "edit" && (await deskResponder.get("/api/security/guard-reports")).status === 200);
  r = await responder.post(`/api/security/alarms/${alarmId}/read`, { read: true });
  check("http: a responder opening it marks it read, by them", r.data.read && (await security.get("/api/security/mail/unread")).data.alarms === 0);
  await security.post(`/api/security/alarms/${alarmId}/read`, { read: false });

  // Any staff role can be given it; Security can't lose it.
  check("http: Security always reads them", (await admin.put("/api/roles/security", { alarms: false })).status === 400);
  r = await admin.put("/api/roles/manager", { alarms: true });
  check("http: a role given it reads them", r.data.role.alarms === true && (await manager.get("/api/security/alarms")).status === 200 && (await manager.post("/api/security/mail/check")).status === 403);
  await admin.put("/api/roles/manager", { alarms: false });
  check("http: and taken away, doesn't", (await manager.get("/api/security/alarms")).status === 403
    && (await admin.get("/api/audit?action=role.update")).data.entries.some((e) => /reads alarms and guard reports/.test(e.detail || "")));
  r = await admin.post("/api/roles", { name: "Night patrol", directory: "none", alarms: true });
  check("http: a new role made with it", r.status === 200 && r.data.role.alarms === true && (await admin.get("/api/roles")).data.roles.find((x) => x.id === "responder")?.builtIn === true);

  // Sites: two sites, so nothing is placed until an administrator does it.
  check("http: limited Security doesn't see what isn't placed", (await annexSecurity.get("/api/security/alarms")).data.total === 0 && (await annexSecurity.get(`/api/security/alarms/${alarmId}`)).status === 404);
  r = await admin.get("/api/settings/security-mail");
  check("http: Settings lists the accounts and sites seen", r.status === 200 && r.data.sources.length === 2 && r.data.sources.every((x) => x.siteId === null) && r.data.settings.enabled === false);
  check("http: only administrators set it up", (await security.get("/api/settings/security-mail")).status === 403 && (await security.put("/api/settings/security-mail", { enabled: false })).status === 403);
  r = await admin.put("/api/settings/security-mail/sources", { kind: "alarm", key: "Z9990001", siteId: annex.id });
  check("http: placed at a site, its Security sees it", r.status === 200 && (await annexSecurity.get("/api/security/alarms")).data.total === 1 && (await annexSecurity.get("/api/security/guard-reports")).data.total === 0);
  r = await admin.post("/api/settings/security-mail/sources", { kind: "alarm", key: "Z9990009", label: "Annex - Roof", siteId: annex.id });
  check("http: an administrator adds an account ahead of its first alarm", r.status === 200 && r.data.source.siteName === "Annex" && (await security.post("/api/settings/security-mail/sources", { kind: "alarm", key: "Z9990010" })).status === 403);
  check("http: renamed", (await admin.put("/api/settings/security-mail/sources", { kind: "alarm", key: "Z9990009", label: "Roof hatch" })).data.source.label === "Roof hatch");
  r = await admin.del("/api/settings/security-mail/sources/alarm/Z9990009");
  check("http: and removed, each in the audit log", r.status === 200 && !(await admin.get("/api/settings/security-mail")).data.sources.some((x) => x.key === "Z9990009")
    && (await admin.get("/api/audit?action=security.source_add")).data.entries.length === 1 && (await admin.get("/api/audit?action=security.source_remove")).data.entries.length === 1);

  r = await admin.put("/api/settings/security-mail", { enabled: true, mailbox: "security@example.com", pollMinutes: 10 });
  check("http: the mailbox saved, in the audit log", r.status === 200 && r.data.settings.mailbox === "security@example.com" && (await admin.get("/api/audit?action=security.mail_settings")).data.entries.length === 1);
  r = await security.post("/api/security/mail/check");
  check("http: checking it without the app registration says what to set up", r.status === 409 && /Microsoft Entra ID/.test(r.data.error));
  check("http: managers can't ask for a check", (await manager.post("/api/security/mail/check")).status === 403);
  check("http: how it went is in Settings, never what came", (await admin.get("/api/settings/security-mail")).data.settings.lastError.includes("Microsoft Entra ID"));
}

(async () => {
  try {
    await mailboxTests();
    await httpTests();
  } catch (error) {
    check(`no unexpected error (${error.stack})`, false);
  } finally {
    if (server) server.kill();
    db.close?.();
    report();
  }
})();
